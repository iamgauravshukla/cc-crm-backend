'use strict';
/**
 * Wipes the bookings table and re-imports from sheetFileCleaned/cleaned_updated.xlsx
 * Run from the server/ directory: node scripts/import_clean_excel.js
 */

const path  = require('path');
const XLSX  = require('xlsx');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();
const { Pool } = require('pg');

const EXCEL_PATH = path.resolve(__dirname, '../../sheetFileCleaned/cleaned_updated.xlsx');
const BATCH_SIZE = 300;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── date helpers ─────────────────────────────────────────────────────────────

const MONTHS = {
  january:0,february:1,march:2,april:3,may:4,june:5,
  july:6,august:7,september:8,october:9,november:10,december:11,
};


function excelSerialToDateStr(serial) {
  if (serial == null || typeof serial !== 'number') return null;
  const d = new Date((serial - 25569) * 86400 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function excelSerialToTs(serial) {
  if (serial == null || typeof serial !== 'number') return null;
  return new Date((serial - 25569) * 86400 * 1000).toISOString();
}

function excelSerialToTimeStr(serial) {
  if (serial == null || typeof serial !== 'number') return null;
  const frac = serial % 1;
  if (frac === 0) return null;
  const totalMins = Math.round(frac * 24 * 60);
  const h = Math.floor(totalMins / 60) % 24;
  const m = totalMins % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const display = h % 12 || 12;
  return `${display}:${String(m).padStart(2, '0')} ${ampm}`;
}

function toDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return excelSerialToDateStr(v);
  if (typeof v === 'string') {
    const s = v.trim();
    // "Month DD, YYYY" or "Month DD YYYY"
    const longMonth = s.match(/^(\w+)\s+(\d+),?\s*(\d{4})$/);
    if (longMonth) {
      const month = MONTHS[longMonth[1].toLowerCase()];
      if (month !== undefined) {
        return `${longMonth[3]}-${String(month + 1).padStart(2, '0')}-${String(parseInt(longMonth[2])).padStart(2, '0')}`;
      }
    }
    // "YYYY-MM-DD" ISO
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // "MM/DD/YYYY" or "M/D/YYYY"
    const slashUS = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashUS) {
      const [, mm, dd, yyyy] = slashUS;
      if (parseInt(mm) <= 12) return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }
  }
  return null;
}

// ── value helpers ─────────────────────────────────────────────────────────────

function toStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' || s === '❌' || s === 'N/A' ? null : s;
}

function toBool(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string' && v.toLowerCase() === 'true') return true;
  return false;
}

function toInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

function toNum(v) {
  if (v == null || v === '') return 0;
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

// ── row mapper ────────────────────────────────────────────────────────────────
// Column indices map exactly to the header row in the Excel sheet.

function mapRow(r) {
  const recordId = toStr(r[38]) || `BK-IMPORT-${uuidv4().slice(0,8).toUpperCase()}`;

  // created_at: col0 is a full Excel serial with time fraction (the row timestamp in Sheets)
  const createdAt = excelSerialToTs(r[0]);

  // appointment_date: prefer the string version (col50), fall back to Excel serial (col3)
  const apptDate = toDate(r[50]) || toDate(r[3]);

  // appointment_time: prefer col51 string; when col50 is absent, extract from col3 serial fraction
  const apptTime = toStr(r[51]) || (r[50] == null && typeof r[3] === 'number' ? excelSerialToTimeStr(r[3]) : null);

  // booking_date: col48 string; booking_time: col49 string
  const bookingDate = toDate(r[48]);
  const bookingTime = toStr(r[49]);

  return [
    recordId,                           //  1  record_id
    toStr(r[39]) || 'ACTIVE',           //  2  record_status
    createdAt,                          //  3  created_at
    toStr(r[1])  || '',                 //  4  branch
    toStr(r[2])  || 'Scheduled',        //  5  booking_status
    bookingDate,                        //  6  booking_date
    bookingTime,                        //  7  booking_time
    apptDate,                           //  8  appointment_date
    apptTime,                           //  9  appointment_time
    toStr(r[4])  || '',                 // 10  first_name
    toStr(r[5])  || '',                 // 11  last_name
    toInt(r[6]),                        // 12  age
    toStr(r[7]),                        // 13  gender
    toStr(r[14]),                       // 14  phone
    toStr(r[16]),                       // 15  email
    toStr(r[15]),                       // 16  social_media
    toStr(r[8]),                        // 17  treatment
    toStr(r[9]),                        // 18  area
    toStr(r[10]),                       // 19  freebie
    toNum(r[12]),                       // 20  total_price
    toStr(r[13]),                       // 21  payment_mode
    toStr(r[11]),                       // 22  companion_treatment
    toStr(r[20]),                       // 23  companion_first_name
    toStr(r[21]),                       // 24  companion_last_name
    toInt(r[22]),                       // 25  companion_age
    toStr(r[23]),                       // 26  companion_gender
    toStr(r[24]),                       // 27  companion_freebie
    toStr(r[17]),                       // 28  agent
    toStr(r[18]),                       // 29  booking_details
    toStr(r[43]),                       // 30  purchase_details
    toStr(r[19]),                       // 31  ad_interacted
    toStr(r[29]),                       // 32  email_norm
    toStr(r[30]),                       // 33  phone_norm
    toStr(r[31]),                       // 34  social_norm
    toStr(r[32]),                       // 35  full_name_norm
    toStr(r[33]),                       // 36  companion_full_name_norm
    toStr(r[34]),                       // 37  promo_hunter_status
    toStr(r[35]),                       // 38  match_reason
    toStr(r[36]),                       // 39  matched_source
    toStr(r[37]),                       // 40  matched_row
    toBool(r[25]),                      // 41  cancel_validation
    toStr(r[26]),                       // 42  underage_status
    toBool(r[27]),                      // 43  underage_cancellation
    toStr(r[28]),                       // 44  db_status
    toStr(r[41]),                       // 45  legacy_full_name
    toBool(r[42]),                      // 46  exclude_from_dashboards
  ];
}

const INSERT_SQL = `
INSERT INTO bookings (
  record_id, record_status, created_at,
  branch, booking_status,
  booking_date, booking_time, appointment_date, appointment_time,
  first_name, last_name, age, gender, phone, email, social_media,
  treatment, area, freebie, total_price, payment_mode,
  companion_treatment, companion_first_name, companion_last_name,
  companion_age, companion_gender, companion_freebie,
  agent, booking_details, purchase_details, ad_interacted,
  email_norm, phone_norm, social_norm, full_name_norm, companion_full_name_norm,
  promo_hunter_status, match_reason, matched_source, matched_row,
  cancel_validation, underage_status, underage_cancellation,
  db_status, legacy_full_name, exclude_from_dashboards
) VALUES `;

// Build $1,$2,... placeholders for N rows × 46 cols
function buildPlaceholders(rowCount) {
  const cols = 46;
  return Array.from({ length: rowCount }, (_, i) =>
    '(' + Array.from({ length: cols }, (_, j) => `$${i * cols + j + 1}`).join(',') + ')'
  ).join(',');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Reading Excel file…');
  const wb   = XLSX.readFile(EXCEL_PATH);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const raw  = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const allRows = raw.slice(1).filter(r => r.length > 1);
  console.log(`Found ${allRows.length} raw data rows.`);

  // Deduplicate by record_id — keep the last occurrence (most recently updated)
  const seen = new Map();
  for (const r of allRows) {
    const id = (r[38] && String(r[38]).trim()) || null;
    const key = id || `__noid_${seen.size}`;
    seen.set(key, r);
  }
  const rows = [...seen.values()];
  const dupes = allRows.length - rows.length;
  if (dupes > 0) console.log(`Deduplicated: ${dupes} duplicate record_ids removed, ${rows.length} unique rows to insert.`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('Truncating bookings (CASCADE)…');
    await client.query('TRUNCATE TABLE bookings RESTART IDENTITY CASCADE');

    let inserted = 0;
    let errors   = 0;

    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const batch   = rows.slice(offset, offset + BATCH_SIZE);
      const mapped  = [];
      const flat    = [];

      for (const r of batch) {
        try {
          const vals = mapRow(r);
          mapped.push(vals);
          flat.push(...vals);
        } catch (e) {
          errors++;
          console.error(`  Row ${offset + mapped.length + 1} map error: ${e.message}`);
        }
      }

      if (mapped.length === 0) continue;

      await client.query('SAVEPOINT batch_start');
      const sql = INSERT_SQL + buildPlaceholders(mapped.length);
      try {
        await client.query(sql, flat);
        inserted += mapped.length;
      } catch (e) {
        // Log the real root-cause error from the failed batch
        console.error(`\n  Batch rows ${offset + 1}–${offset + mapped.length} failed: ${e.message.split('\n')[0]}`);
        // The transaction is now aborted — ROLLBACK TO a savepoint to revive it,
        // then retry each row individually so only the bad one is skipped.
        await client.query('ROLLBACK TO SAVEPOINT batch_start');
        for (let i = 0; i < mapped.length; i++) {
          try {
            await client.query('SAVEPOINT row_sp');
            await client.query(INSERT_SQL + buildPlaceholders(1), mapped[i]);
            inserted++;
          } catch (e2) {
            await client.query('ROLLBACK TO SAVEPOINT row_sp');
            errors++;
            console.error(`    Row ${offset + i + 1} skipped: ${e2.message.split('\n')[0]}`);
          }
        }
      }

      if ((offset / BATCH_SIZE) % 10 === 0) {
        process.stdout.write(`  ${inserted.toLocaleString()} / ${rows.length.toLocaleString()} rows…\r`);
      }
    }

    await client.query('COMMIT');
    console.log(`\nDone. Inserted: ${inserted.toLocaleString()}, Skipped: ${errors}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Fatal error — rolled back:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
