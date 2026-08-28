'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const path = require('path');
const XLSX = require('xlsx');
const { Pool } = require('pg');

// ── Config ────────────────────────────────────────────────────
const EXCEL_PATH = process.env.EXCEL_PATH
  || path.join(__dirname, '../../sheetFileCleaned/Master Bookings Cleaned.xlsx');
const SHEET_NAME  = 'MASTER_RECORDS';
const BATCH_SIZE  = 200;  // rows per INSERT — keeps param count well under pg's 65535 limit

// ── Helpers ───────────────────────────────────────────────────

/** Null-safe string: trims, returns null for empty/NaN/undefined */
function str(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return null;
  const s = String(v).trim();
  return (s === '' || s === 'NaN' || s === 'undefined' || s === 'null') ? null : s;
}

/** Boolean from Excel cell (handles JS boolean, TRUE/FALSE strings, 0/1) */
function bool(v) {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return false;
  const s = String(v).toUpperCase().trim();
  return s === 'TRUE' || s === '1' || s === 'YES';
}

/** Numeric price — strips ₱, commas, whitespace */
function price(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number' && !isNaN(v)) return v;
  const s = String(v).replace(/[₱,\s]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/** Integer or null */
function int(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

/** JS Date → ISO string, or null */
function isoTs(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** JS Date → 'YYYY-MM-DD' string, or null */
function dateOnly(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

/** JS Date → '12:30 PM' string, or null */
function timeOnly(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (isNaN(d.getTime())) return null;
  const h = d.getHours(), m = d.getMinutes();
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

let _idCounter = 0;
/** Generate a record_id matching the existing BK-YYYYMMDD-HHMMSS-XXXXX format */
function genRecordId(createdAt) {
  const d = (createdAt instanceof Date && !isNaN(createdAt)) ? createdAt : new Date();
  const p = n => String(n).padStart(2, '0');
  const rand = (++_idCounter).toString(36).toUpperCase().padStart(3, '0')
             + Math.random().toString(36).toUpperCase().slice(2, 4);
  return `BK-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}`
       + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
       + `-${rand.slice(0, 5)}`;
}

// ── Excel column positions (MASTER_RECORDS sheet) ─────────────
// 0  = Timestamp (created_at)       19 = Ad Interacted
// 1  = Branch                       20 = Companion First Name
// 2  = Booking Status               21 = Companion Last Name
// 3  = Date (appointment datetime)  22 = Companion Age
// 4  = First Name                   23 = Companion Gender
// 5  = Last Name                    24 = Companion Freebie
// 6  = Age                          25 = cancel_validation
// 7  = Gender                       26 = underage_status
// 8  = Promo/Treatment              27 = underage_cancellation
// 9  = Area                         28 = db_status
// 10 = Freebie                      29 = email_norm
// 11 = Companion Promo/Treatment    30 = phone_norm
// 12 = Total Price                  31 = social_norm
// 13 = Mode of payment              32 = full_name_norm
// 14 = Phone                        33 = companion_full_name_norm
// 15 = Facebook/Instagram           34 = promo_hunter_status
// 16 = Email                        35 = match_reason
// 17 = Agent                        36 = matched_source
// 18 = Booking Details              37 = matched_row
//                                   38 = record_id
//                                   39 = record_status
//                                   40 = last_checked_at
//                                   41 = legacy_full_name
//                                   42 = exclude_from_dashboards
//                                   43 = Purchase Details

const INSERT_COLS = [
  'record_id', 'record_status', 'created_at', 'branch', 'booking_status',
  'booking_date', 'booking_time', 'appointment_date', 'appointment_time',
  'cancellation_time',
  'first_name', 'last_name', 'age', 'gender', 'phone', 'email', 'social_media',
  'treatment', 'area', 'freebie', 'total_price', 'payment_mode',
  'companion_treatment', 'companion_first_name', 'companion_last_name',
  'companion_age', 'companion_gender', 'companion_freebie', 'companion_area',
  'agent', 'booking_details', 'remarks', 'purchase_details', 'ad_interacted',
  'email_norm', 'phone_norm', 'social_norm', 'full_name_norm',
  'companion_full_name_norm',
  'promo_hunter_status', 'match_reason', 'matched_source', 'matched_row',
  'last_checked_at',
  'cancel_validation', 'underage_status', 'underage_cancellation', 'db_status',
  'legacy_full_name', 'exclude_from_dashboards',
  'is_ots', 'is_ad_id', 'is_companion', 'is_high_priority',
  'do_not_call', 'is_rescheduled',
];
const N = INSERT_COLS.length; // 56

/** Map one raw Excel row → 54-element values array */
function rowToValues(row) {
  const createdAt = row[0] instanceof Date ? row[0] : null;
  const apptDt    = row[3] instanceof Date ? row[3] : null;

  const rawRecordId = str(row[38]);
  const recordId = rawRecordId || genRecordId(createdAt);

  return [
    /* 1  */ recordId,
    /* 2  */ str(row[39]) || 'ACTIVE',
    /* 3  */ isoTs(createdAt),
    /* 4  */ str(row[1])  || '',
    /* 5  */ str(row[2])  || 'Scheduled',
    /* 6  */ dateOnly(createdAt),
    /* 7  */ timeOnly(createdAt),
    /* 8  */ dateOnly(apptDt),
    /* 9  */ timeOnly(apptDt),
    /* 10 */ null,                        // cancellation_time — not in Excel
    /* 11 */ str(row[4])  || '',
    /* 12 */ str(row[5])  || '',
    /* 13 */ int(row[6]),
    /* 14 */ str(row[7]),
    /* 15 */ str(row[14]),
    /* 16 */ str(row[16]),
    /* 17 */ str(row[15]),
    /* 18 */ str(row[8]),
    /* 19 */ str(row[9]),
    /* 20 */ str(row[10]),
    /* 21 */ price(row[12]),
    /* 22 */ str(row[13]),
    /* 23 */ str(row[11]),
    /* 24 */ str(row[20]),
    /* 25 */ str(row[21]),
    /* 26 */ int(row[22]),
    /* 27 */ str(row[23]),
    /* 28 */ str(row[24]),
    /* 29 */ null,                        // companion_area — not in Excel
    /* 30 */ str(row[17]),
    /* 31 */ str(row[18]),
    /* 32 */ null,                        // remarks — new field
    /* 33 */ str(row[43]),                // Purchase Details (col 43)
    /* 34 */ str(row[19]),
    /* 35 */ str(row[29]),
    /* 36 */ str(row[30]),
    /* 37 */ str(row[31]),
    /* 38 */ str(row[32]),
    /* 39 */ str(row[33]),
    /* 40 */ str(row[34]),
    /* 41 */ str(row[35]),
    /* 42 */ str(row[36]),
    /* 43 */ str(row[37]),
    /* 44 */ isoTs(row[40] instanceof Date ? row[40] : null),
    /* 45 */ bool(row[25]),
    /* 46 */ str(row[26]),
    /* 47 */ bool(row[27]),
    /* 48 */ str(row[28]),
    /* 49 */ str(row[41]),
    /* 50 */ bool(row[42]),
    /* 51 */ false,   // is_ots — all FALSE for historical records
    /* 52 */ false,   // is_ad_id
    /* 53 */ false,   // is_companion
    /* 54 */ false,   // is_high_priority
    /* 55 */ false,   // do_not_call
    /* 56 */ false,   // is_rescheduled
  ];
}

// ── Single-row INSERT (fallback when batch fails) ─────────────
const SINGLE_SQL = `
  INSERT INTO bookings (${INSERT_COLS.join(', ')})
  VALUES (${Array.from({ length: N }, (_, i) => `$${i + 1}`).join(', ')})
  ON CONFLICT (record_id) DO NOTHING
`;

// ── Main ──────────────────────────────────────────────────────
async function migrate() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set in .env');
    process.exit(1);
  }

  const replaceMode = process.argv.includes('--replace');

  console.log('📖 Reading Excel file…');
  console.log('   Path:', EXCEL_PATH);

  const wb = XLSX.readFile(EXCEL_PATH, { cellDates: true });
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) throw new Error(`Sheet "${SHEET_NAME}" not found. Available: ${wb.SheetNames.join(', ')}`);

  const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const dataRows = allRows
    .slice(1)
    .filter(r => r && r.some(v => v !== null && v !== undefined && v !== ''));

  console.log(`✅ ${dataRows.length} data rows loaded from "${SHEET_NAME}"`);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });

  if (replaceMode) {
    console.log('\n⚠️  --replace mode: wiping bookings table before import…');
    await pool.query('TRUNCATE TABLE bookings RESTART IDENTITY CASCADE');
    console.log('✅ Table cleared.\n');
  }

  let inserted = 0;
  let skipped  = 0;
  let errCount = 0;
  const total = dataRows.length;
  const startTime = Date.now();

  for (let b = 0; b < total; b += BATCH_SIZE) {
    const batch   = dataRows.slice(b, b + BATCH_SIZE);
    const rowVals = batch.map(rowToValues);

    // Build multi-row placeholders: ($1,$2,...), ($55,$56,...), ...
    const groups = rowVals.map((_, i) => {
      const start = i * N + 1;
      return `(${Array.from({ length: N }, (_, j) => `$${start + j}`).join(', ')})`;
    });

    const batchSql = `
      INSERT INTO bookings (${INSERT_COLS.join(', ')})
      VALUES ${groups.join(',\n')}
      ON CONFLICT (record_id) DO NOTHING
    `;

    try {
      const result = await pool.query(batchSql, rowVals.flat());
      inserted += result.rowCount || 0;
      skipped  += batch.length - (result.rowCount || 0);
    } catch (batchErr) {
      // Batch failed — fall back to row-by-row so one bad row doesn't drop the whole batch
      for (let r = 0; r < rowVals.length; r++) {
        try {
          const res = await pool.query(SINGLE_SQL, rowVals[r]);
          inserted += res.rowCount || 0;
        } catch (rowErr) {
          errCount++;
          if (errCount <= 20) {
            // Show first 20 errors only to avoid log spam
            console.error(`  ⚠ Row ${b + r + 2} skipped (${rowVals[r][0]}): ${rowErr.message}`);
          }
          skipped++;
        }
      }
    }

    const done = Math.min(b + BATCH_SIZE, total);
    const pct  = ((done / total) * 100).toFixed(1);
    const secs = ((Date.now() - startTime) / 1000).toFixed(1);
    if (done % 5000 === 0 || done === total) {
      console.log(`  → ${done.toLocaleString()} / ${total.toLocaleString()} (${pct}%) — ${secs}s elapsed`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${elapsed}s`);
  console.log(`   Inserted : ${inserted.toLocaleString()}`);
  console.log(`   Skipped  : ${skipped.toLocaleString()} (already existed or empty)`);
  if (errCount > 0) console.log(`   Errors   : ${errCount.toLocaleString()} rows could not be parsed`);

  await pool.end();
}

migrate().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
