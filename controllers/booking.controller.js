'use strict';
const { v4: uuidv4 } = require('uuid');
const Joi = require('joi');
const pool = require('../db/pool');

// Validation schema for booking creation
const bookingSchema = Joi.object({
  branch:              Joi.string().required(),
  status:              Joi.string().default('Scheduled'),
  firstName:           Joi.string().trim().required(),
  lastName:            Joi.string().trim().required(),
  age:                 Joi.number().integer().min(1).max(150).required(),
  phone:               Joi.string().trim().required(),
  socialMedia:         Joi.string().allow('', null).optional(),
  email:               Joi.string().allow('', null).optional(),   // freeform — agents may write "N/A" or leave blank
  treatment:           Joi.string().required(),
  area:                Joi.string().allow('', null).optional(),
  freebie:             Joi.string().allow('', null).optional(),
  date:                Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),  // YYYY-MM-DD
  time:                Joi.string().pattern(/^\d{2}:\d{2}$/).required(),        // HH:MM (24h)
  paymentMode:         Joi.string().required(),
  totalPrice:          Joi.number().min(0).required(),
  gender:              Joi.string().valid('Male', 'Female').required(),
  companionFirstName:  Joi.string().allow('', null).optional(),
  companionLastName:   Joi.string().allow('', null).optional(),
  companionAge:        Joi.alternatives().try(Joi.number().integer().min(1), Joi.string().allow('')).optional(),
  companionFreebie:    Joi.string().allow('', null).optional(),
  companionTreatment:  Joi.string().allow('', null).optional(),
  companionGender:     Joi.string().valid('Male', 'Female', '').allow('', null).optional(),
  companionArea:       Joi.string().allow('', null).optional(),
  bookingDetails:      Joi.string().allow('', null).optional(),
  adInteracted:        Joi.string().allow('', null).optional(),
  remarks:             Joi.string().allow('', null).optional(),
  followUpDate:        Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('', null).optional(),
  agent:               Joi.string().required(),
  isOts:               Joi.boolean().default(false),
  isCompanion:         Joi.boolean().default(false)
});

// ── Activity log helper ───────────────────────────────────────────────────────
async function logActivity(bookingId, user, action, changes = {}) {
  try {
    await pool.query(
      `INSERT INTO booking_activity_log (booking_id, user_id, user_name, action, changes)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        bookingId,
        user?.userId || null,
        user?.name   || user?.email || 'System',
        action,
        JSON.stringify(changes)
      ]
    );
  } catch (err) {
    console.error('Activity log write failed:', err.message);
  }
}

const normDate = v => {
  if (v == null) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return '';
  // Use UTC methods — PostgreSQL DATE columns come back as midnight UTC, so UTC parts = stored date
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
};

// Appends the "Booked On" (booking_date) and Appointment-date filters shared by
// the Master Bookings table (getOldBookings) and its CSV export (exportBookings),
// so the two never drift. Mutates conds/params; returns the next param index.
const pushBookingDateFilters = (conds, params, idx, q) => {
  const TODAY = "(NOW() AT TIME ZONE 'Asia/Manila')::date";

  // Booked On — filters by booking_date (the date agents enter, shown in the table)
  if (q.createdStartDate && q.createdEndDate) {
    conds.push(`booking_date >= $${idx++}::date AND booking_date <= $${idx++}::date`);
    params.push(q.createdStartDate, q.createdEndDate);
  } else if (q.createdDateRange && q.createdDateRange !== 'all') {
    if (q.createdDateRange === 'today') {
      conds.push(`booking_date = ${TODAY}`);
    } else {
      const d = { last7: 7, last30: 30, last90: 90 }[q.createdDateRange];
      if (d) conds.push(`booking_date >= ${TODAY} - INTERVAL '${d} days'`);
    }
  }

  // Appointment date
  if (q.appointmentStartDate && q.appointmentEndDate) {
    conds.push(`appointment_date >= $${idx++}::date AND appointment_date <= $${idx++}::date`);
    params.push(q.appointmentStartDate, q.appointmentEndDate);
  } else if (q.appointmentDateRange && q.appointmentDateRange !== 'all') {
    const r = q.appointmentDateRange;
    if      (r === 'today')     conds.push(`appointment_date = ${TODAY}`);
    else if (r === 'yesterday') conds.push(`appointment_date = ${TODAY} - 1`);
    else if (r === 'tomorrow')  conds.push(`appointment_date = ${TODAY} + 1`);
    else if (r === 'thisWeek')  conds.push(`appointment_date >= ${TODAY} AND appointment_date <= ${TODAY} + (6 - EXTRACT(DOW FROM ${TODAY})::int)`);
    else if (r === 'next7')     conds.push(`appointment_date >= ${TODAY} AND appointment_date <= ${TODAY} + 7`);
    else if (r === 'next30')    conds.push(`appointment_date >= ${TODAY} AND appointment_date <= ${TODAY} + 30`);
    else if (r === 'last7')     conds.push(`appointment_date >= ${TODAY} - 7 AND appointment_date < ${TODAY}`);
    else if (r === 'last30')    conds.push(`appointment_date >= ${TODAY} - 30 AND appointment_date < ${TODAY}`);
    else if (r === 'last90')    conds.push(`appointment_date >= ${TODAY} - 90 AND appointment_date < ${TODAY}`);
    else if (r === 'thisMonth') conds.push(`DATE_TRUNC('month', appointment_date) = DATE_TRUNC('month', ${TODAY})`);
    else if (r === 'lastMonth') conds.push(`DATE_TRUNC('month', appointment_date) = DATE_TRUNC('month', ${TODAY} - INTERVAL '1 month')`);
  }

  return idx;
};

// Placeholder emails entered when a client has no real address (e.g. n/a@gmail.com,
// na@gmail.com). Many unrelated clients share these, so they must NOT drive Promo
// Hunter matching — normalize them to '' ("no email") for both storage and matching.
const PLACEHOLDER_EMAIL_LOCALS = new Set(['n/a', 'na', 'none', 'noemail', 'nil', 'n.a', 'n-a']);
const normalizeEmail = (email) => {
  const e = (email || '').toLowerCase().trim();
  if (!e) return '';
  const local = e.split('@')[0];
  return PLACEHOLDER_EMAIL_LOCALS.has(local) ? '' : e;
};

const normalizeGender = v => {
  const l = (v || '').toLowerCase();
  if (l === 'female') return 'Female';
  if (l === 'male')   return 'Male';
  return v || '';
};

const normalizePaymentMode = v => {
  const l = (v || '').toLowerCase();
  if (l.startsWith('cash'))   return 'Cash';
  if (l.startsWith('debit'))  return 'Debit';
  if (l.startsWith('credit')) return 'Credit';
  return v || '';
};

class BookingController {

  // ── createBooking ──────────────────────────────────────────────────────────
  async createBooking(req, res) {
    try {
      const { error, value } = bookingSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const d = value;
      // Guard against any client-side float drift on the price (e.g. 599.98 for 600) — store clean 2-decimal pesos.
      if (typeof d.totalPrice === 'number') d.totalPrice = Math.round(d.totalPrice * 100) / 100;
      const recordId = `BK-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${uuidv4().slice(0,8).toUpperCase()}`;
      const now      = new Date();

      // Parse appointment date + time into separate DB columns
      const appointmentDate = d.date;  // YYYY-MM-DD
      const appointmentTime = formatTime12h(d.time); // "HH:MM" → "H:MM AM/PM"

      // booking_date/time = when this booking was created, in Philippine time (UTC+8)
      const phFmt       = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' });
      const phTimeFmt   = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hour12: false });
      const bookingDate = phFmt.format(now);                  // "YYYY-MM-DD"
      const bookingTime = formatTime12h(phTimeFmt.format(now)); // "HH:MM" → "H:MM AM/PM"

      // Promo hunter check
      const promoResult = await checkPromoHunter(
        d.firstName, d.lastName, d.email, d.phone, d.socialMedia,
        d.companionFirstName, d.companionLastName
      );

      const finalStatus = promoResult.status === 'Promo hunter' ? 'Promo hunter' : (d.status || 'Scheduled');

      // Normalized fields
      const emailNorm   = normalizeEmail(d.email);
      const phoneNorm   = (d.phone        || '').replace(/\D/g, '');
      const socialNorm  = (d.socialMedia  || '').toLowerCase().trim();
      const fullName    = `${d.firstName} ${d.lastName}`.toLowerCase().trim();
      const companionFN = (d.companionFirstName || '').trim() && (d.companionLastName || '').trim()
        ? `${d.companionFirstName} ${d.companionLastName}`.toLowerCase().trim()
        : '';

      await pool.query(`
        INSERT INTO bookings (
          record_id, record_status, created_at,
          branch, booking_status,
          booking_date, booking_time, appointment_date, appointment_time,
          first_name, last_name, age, gender,
          phone, email, social_media,
          treatment, area, freebie, total_price, payment_mode,
          companion_treatment, companion_first_name, companion_last_name,
          companion_age, companion_gender, companion_freebie, companion_area,
          agent, booking_details, remarks, ad_interacted,
          email_norm, phone_norm, social_norm, full_name_norm, companion_full_name_norm,
          promo_hunter_status, match_reason, matched_source, matched_row, last_checked_at,
          is_ots, is_ad_id, is_companion, is_high_priority, is_meta_conversion,
          follow_up_date
        ) VALUES (
          $1,'ACTIVE',$2,
          $3,$4,
          $5,$6,$7,$8,
          $9,$10,$11,$12,
          $13,$14,$15,
          $16,$17,$18,$19,$20,
          $21,$22,$23,
          $24,$25,$26,$27,
          $28,$29,$30,$31,
          $32,$33,$34,$35,$36,
          $37,$38,$39,$40,$2,
          $42,false,$43,false,false,
          $41
        )`,
        [
          recordId, now,
          d.branch, finalStatus,
          bookingDate, bookingTime, appointmentDate, appointmentTime,
          d.firstName, d.lastName, d.age, d.gender,
          d.phone, d.email || null, d.socialMedia || null,
          d.treatment, d.area || null, d.freebie || null, d.totalPrice, d.paymentMode,
          d.companionTreatment || null, d.companionFirstName || null, d.companionLastName || null,
          d.companionAge || null, d.companionGender || null, d.companionFreebie || null, d.companionArea || null,
          d.agent, d.bookingDetails || null, d.remarks || null, d.adInteracted || null,
          emailNorm, phoneNorm, socialNorm, fullName, companionFN,
          promoResult.status, promoResult.matchReason || null, promoResult.matchedSource || null, promoResult.matchedRow || null,
          d.followUpDate || null,
          d.isOts === true,        // $42 is_ots
          d.isCompanion === true   // $43 is_companion
        ]
      );

      await logActivity(recordId, req.user, 'CREATED', {
        branch: { to: d.branch }, booking_status: { to: finalStatus },
        treatment: { to: d.treatment }, total_price: { to: d.totalPrice }
      });

      res.status(201).json({
        message: 'Booking created successfully',
        booking: {
          recordId,
          ...d,
          promoHunterStatus: promoResult.status,
          finalStatus
        }
      });
    } catch (err) {
      console.error('Create booking error:', err);
      res.status(500).json({ error: 'Failed to create booking' });
    }
  }

  // ── getOldBookings ─────────────────────────────────────────────────────────
  async getOldBookings(req, res) {
    try {
      const page      = Math.max(1, parseInt(req.query.page)  || 1);
      const limit     = Math.min(200, parseInt(req.query.limit) || 50);
      const search    = (req.query.search    || '').trim();
      const branch    = (req.query.branch    || '').trim();
      const status    = (req.query.status    || '').trim();
      const agent     = (req.query.agent     || '').trim();
      const gender    = (req.query.gender    || '').trim();
      const sortOrder = req.query.sortOrder  || 'newest';
      const sortField = req.query.sortField  || 'appointment_date';

      const createdDateRange    = req.query.createdDateRange;
      const createdStartDate    = req.query.createdStartDate;
      const createdEndDate      = req.query.createdEndDate;
      const appointmentDateRange = req.query.appointmentDateRange;
      const appointmentStartDate = req.query.appointmentStartDate;
      const appointmentEndDate   = req.query.appointmentEndDate;

      const conds  = ["record_status != 'DELETED'"];
      const params = [];
      let   idx    = 1;

      // Branch filter (supports NOT: prefix and comma-separated values)
      if (branch && branch !== 'All') {
        const isNot = branch.startsWith('NOT:');
        const vals  = (isNot ? branch.slice(4) : branch).split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
        if (vals.length) {
          conds.push(isNot
            ? `NOT (LOWER(branch) = ANY($${idx++}::text[]))`
            : `LOWER(branch) = ANY($${idx++}::text[])`);
          params.push(vals);
        }
      }

      // Status filter
      if (status && status !== 'All') {
        const isNot = status.startsWith('NOT:');
        const vals  = (isNot ? status.slice(4) : status).split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
        if (vals.length) {
          conds.push(isNot
            ? `NOT (LOWER(booking_status) = ANY($${idx++}::text[]))`
            : `LOWER(booking_status) = ANY($${idx++}::text[])`);
          params.push(vals);
        }
      }

      // Agent filter
      if (agent && agent !== 'All') {
        const vals = agent.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
        conds.push(`LOWER(COALESCE(agent,'')) = ANY($${idx++}::text[])`);
        params.push(vals);
      }

      // Gender filter
      if (gender && gender !== 'All') {
        conds.push(`LOWER(COALESCE(gender,'')) = $${idx++}`);
        params.push(gender.toLowerCase());
      }

      // Booked On (booking_date) + Appointment-date filters — shared with exportBookings
      idx = pushBookingDateFilters(conds, params, idx, {
        createdStartDate, createdEndDate, createdDateRange,
        appointmentStartDate, appointmentEndDate, appointmentDateRange,
      });

      // Search filter
      if (search) {
        const q = `%${search.toLowerCase()}%`;
        conds.push(`(LOWER(COALESCE(first_name,'')) LIKE $${idx} OR LOWER(COALESCE(last_name,'')) LIKE $${idx} OR (LOWER(COALESCE(first_name,'')) || ' ' || LOWER(COALESCE(last_name,''))) LIKE $${idx} OR LOWER(COALESCE(full_name_norm,'')) LIKE $${idx} OR LOWER(COALESCE(email,'')) LIKE $${idx} OR phone LIKE $${idx} OR LOWER(COALESCE(social_media,'')) LIKE $${idx} OR LOWER(COALESCE(agent,'')) LIKE $${idx} OR LOWER(COALESCE(treatment,'')) LIKE $${idx} OR LOWER(COALESCE(branch,'')) LIKE $${idx})`);
        params.push(q);
        idx++;
      }

      const WHERE  = `WHERE ${conds.join(' AND ')}`;
      const ORDER  = sortOrder === 'oldest' ? 'ASC' : 'DESC';
      const OFFSET = (page - 1) * limit;
      const ALLOWED_SORT = { appointment_date: 'appointment_date', booking_date: 'booking_date', age: 'age' };
      const SORT_COL = ALLOWED_SORT[sortField] || 'appointment_date';
      // Secondary sort by the matching time column, parsed from "10:00 AM" text into a
      // real time so it orders chronologically (not lexically). Malformed times sort last.
      const TIME_COL = { appointment_date: 'appointment_time', booking_date: 'booking_time' }[SORT_COL];
      const TIME_SORT = TIME_COL
        ? `, CASE WHEN ${TIME_COL} ~* '^[0-9]{1,2}:[0-9]{2} *(AM|PM)$' THEN to_timestamp(${TIME_COL}, 'HH12:MI AM')::time END ${ORDER} NULLS LAST`
        : '';

      const [{ rows: countRows }, { rows }] = await Promise.all([
        pool.query(`SELECT COUNT(*) AS total FROM bookings ${WHERE}`, params),
        pool.query(`
          SELECT
            record_id, created_at, branch, booking_status AS status,
            appointment_date, appointment_time,
            first_name, last_name, age, gender,
            treatment, area, freebie, companion_treatment,
            total_price, payment_mode,
            phone, social_media, email, agent,
            booking_details, ad_interacted,
            companion_first_name, companion_last_name, companion_age, companion_gender,
            companion_freebie, companion_area,
            promo_hunter_status,
            cancel_validation, underage_cancellation, underage_status, db_status,
            remarks, purchase_details,
            is_ots, is_ad_id, is_companion, is_high_priority, is_meta_conversion,
            do_not_call, is_rescheduled,
            follow_up_date, booking_date, booking_time
          FROM bookings ${WHERE}
          ORDER BY ${SORT_COL} ${ORDER} NULLS LAST${TIME_SORT}, created_at ${ORDER}
          LIMIT ${limit} OFFSET ${OFFSET}
        `, params)
      ]);

      const total      = parseInt(countRows[0].total);
      const totalPages = Math.ceil(total / limit);

      const bookings = rows.map(r => ({
        recordId:           r.record_id,
        rowNumber:          r.record_id,   // backward-compat alias
        timestamp:          r.created_at,
        branch:             r.branch             || '',
        status:             r.status             || '',
        date:               normDate(r.appointment_date),
        time:               r.appointment_time   || '',
        firstName:          r.first_name         || '',
        lastName:           r.last_name          || '',
        age:                r.age                ?? '',
        gender:             normalizeGender(r.gender),
        treatment:          r.treatment          || '',
        area:               r.area               || '',
        freebie:            r.freebie            || '',
        companionTreatment: r.companion_treatment || '',
        totalPrice:         parseFloat(r.total_price) ?? 0,
        paymentMode:        normalizePaymentMode(r.payment_mode),
        phone:              r.phone              || '',
        socialMedia:        r.social_media        || '',
        email:              r.email              || '',
        agent:              r.agent              || '',
        bookingDetails:     r.booking_details     || '',
        adInteracted:       r.ad_interacted       || '',
        companionFirstName: r.companion_first_name  || '',
        companionLastName:  r.companion_last_name   || '',
        companionAge:       r.companion_age         ?? '',
        companionGender:    normalizeGender(r.companion_gender),
        companionFreebie:   r.companion_freebie     || '',
        companionArea:      r.companion_area        || '',
        promoHunterStatus:  r.promo_hunter_status   || '',
        cancelValidation:   r.cancel_validation     || false,
        underageValidation: r.underage_cancellation || false,
        underageStatus:     r.underage_status      || 'Approved',
        dbStatus:           r.db_status            || 'Approved',
        remarks:            r.remarks              || '',
        purchaseDetails:    r.purchase_details      || '',
        isOts:             r.is_ots              || false,
        isAdId:            r.is_ad_id            || false,
        isCompanion:       r.is_companion        || false,
        isHighPriority:    r.is_high_priority    || false,
        isMetaConversion:  r.is_meta_conversion  || false,
        doNotCall:         r.do_not_call         || false,
        isRescheduled:     r.is_rescheduled      || false,
        followUpDate:       normDate(r.follow_up_date) || null,
        bookingDate:        normDate(r.booking_date)   || null,
        bookingTime:        r.booking_time             || '',
      }));

      res.json({
        bookings,
        pagination: { page, limit, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 }
      });
    } catch (err) {
      console.error('Get old bookings error:', err);
      res.status(500).json({ error: 'Failed to fetch bookings' });
    }
  }

  // ── getBookingById ─────────────────────────────────────────────────────────
  async getBookingById(req, res) {
    try {
      const { id } = req.params;

      const { rows } = await pool.query(
        `SELECT * FROM bookings WHERE record_id = $1 AND record_status != 'DELETED'`,
        [id]
      );

      if (!rows.length) return res.status(404).json({ error: 'Booking not found' });

      const r = rows[0];
      res.json({
        booking: {
          recordId:           r.record_id,
          rowNumber:          r.record_id,
          timestamp:          r.created_at,
          branch:             r.branch             || '',
          status:             r.booking_status     || '',
          date:               normDate(r.appointment_date),
          time:               r.appointment_time   || '',
          firstName:          r.first_name         || '',
          lastName:           r.last_name          || '',
          age:                r.age                ?? '',
          gender:             normalizeGender(r.gender),
          treatment:          r.treatment          || '',
          area:               r.area               || '',
          freebie:            r.freebie            || '',
          companionTreatment: r.companion_treatment || '',
          totalPrice:         parseFloat(r.total_price) ?? 0,
          paymentMode:        normalizePaymentMode(r.payment_mode),
          phone:              r.phone              || '',
          socialMedia:        r.social_media        || '',
          email:              r.email              || '',
          agent:              r.agent              || '',
          bookingDetails:     r.booking_details     || '',
          adInteracted:       r.ad_interacted       || '',
          companionFirstName: r.companion_first_name  || '',
          companionLastName:  r.companion_last_name   || '',
          companionAge:       r.companion_age         ?? '',
          companionGender:    normalizeGender(r.companion_gender),
          companionFreebie:   r.companion_freebie     || '',
          companionArea:      r.companion_area        || '',
          remarks:            r.remarks              || '',
          purchaseDetails:    r.purchase_details      || '',
          promoHunterStatus:  r.promo_hunter_status   || '',
          cancelValidation:   r.cancel_validation     || false,
          underageValidation: r.underage_cancellation || false,
          underageStatus:     r.underage_status      || 'Approved',
          dbStatus:           r.db_status            || 'Approved',
          isOts:             r.is_ots             || false,
          isAdId:            r.is_ad_id           || false,
          isCompanion:       r.is_companion       || false,
          isHighPriority:    r.is_high_priority   || false,
          isMetaConversion:  r.is_meta_conversion || false,
          doNotCall:         r.do_not_call        || false,
          isRescheduled:     r.is_rescheduled     || false,
          followUpDate:      normDate(r.follow_up_date) || null,
          bookingDate:       normDate(r.booking_date)   || null,
          bookingTime:       r.booking_time             || '',
        }
      });
    } catch (err) {
      console.error('Get booking by id error:', err);
      res.status(500).json({ error: 'Failed to fetch booking' });
    }
  }

  // ── updateBooking ──────────────────────────────────────────────────────────
  // :id is the record_id
  async updateBooking(req, res) {
    try {
      const recordId = req.params.id;
      const d        = req.body;
      const user     = req.user;

      // Guard against client-side float drift on the price — store clean 2-decimal pesos.
      if (d.totalPrice !== undefined && d.totalPrice !== null && d.totalPrice !== '') {
        d.totalPrice = Math.round(Number(d.totalPrice) * 100) / 100;
      }

      const { rows: existing } = await pool.query(
        `SELECT * FROM bookings WHERE record_id = $1 AND record_status != 'DELETED'`,
        [recordId]
      );
      if (!existing.length) return res.status(404).json({ error: 'Booking not found' });

      const cur = existing[0];

      // RBAC: agents cannot change status or agent assignment
      if (user?.role !== 'Admin') {
        if (d.status !== undefined && (d.status || '').toLowerCase() !== (cur.booking_status || '').toLowerCase()) {
          return res.status(403).json({ error: 'Agents cannot modify booking status', code: 'RESTRICTED_FIELDS' });
        }
        if (d.agent !== undefined && (d.agent || '').toLowerCase() !== (cur.agent || '').toLowerCase()) {
          return res.status(403).json({ error: 'Agents cannot modify agent assignment', code: 'RESTRICTED_FIELDS' });
        }
      }

      // Parse appointment date/time (accept YYYY-MM-DD + HH:MM, or keep existing)
      const newApptDate = d.date  || (cur.appointment_date ? new Date(cur.appointment_date).toISOString().split('T')[0] : null);
      const newApptTime = d.time  ? formatTime12h(d.time) : (cur.appointment_time || null);

      // Cancellation timestamp
      let cancellationTime = cur.cancellation_time;
      if (d.status && d.status.toLowerCase() === 'cancelled' && !cancellationTime) {
        cancellationTime = new Date();
      }

      // Normalized fields
      const emailNorm   = normalizeEmail(d.email || cur.email);
      const phoneNorm   = (d.phone       || cur.phone        || '').replace(/\D/g, '');
      const socialNorm  = (d.socialMedia || cur.social_media || '').toLowerCase().trim();
      const fullName    = `${d.firstName || cur.first_name || ''} ${d.lastName || cur.last_name || ''}`.toLowerCase().trim();
      const companionFN = (d.companionFirstName || cur.companion_first_name || '').trim() &&
                          (d.companionLastName  || cur.companion_last_name  || '').trim()
        ? `${d.companionFirstName || cur.companion_first_name || ''} ${d.companionLastName || cur.companion_last_name || ''}`.toLowerCase().trim()
        : (cur.companion_full_name_norm || '');

      await pool.query(`
        UPDATE bookings SET
          branch             = $1,
          booking_status     = $2,
          appointment_date   = $3,
          appointment_time   = $4,
          cancellation_time  = $5,
          first_name         = $6,
          last_name          = $7,
          age                = $8,
          gender             = $9,
          treatment          = $10,
          area               = $11,
          freebie            = $12,
          companion_treatment= $13,
          total_price        = $14,
          payment_mode       = $15,
          phone              = $16,
          social_media       = $17,
          email              = $18,
          agent              = $19,
          booking_details    = $20,
          ad_interacted      = $21,
          companion_first_name  = $22,
          companion_last_name   = $23,
          companion_age         = $24,
          companion_gender      = $25,
          companion_freebie     = $26,
          companion_area        = $27,
          remarks            = $28,
          purchase_details   = $29,
          is_ots             = $30,
          is_ad_id           = $31,
          is_companion       = $32,
          is_high_priority   = $33,
          is_meta_conversion = $34,
          email_norm         = $35,
          phone_norm         = $36,
          social_norm        = $37,
          full_name_norm     = $38,
          companion_full_name_norm = $39,
          follow_up_date   = $40,
          booking_date     = $41,
          booking_time     = $42,
          do_not_call      = $43,
          is_rescheduled   = $44
        WHERE record_id = $45
      `, [
        d.branch           || cur.branch,
        d.status           || cur.booking_status,
        newApptDate,
        newApptTime,
        cancellationTime,
        d.firstName        || cur.first_name,
        d.lastName         || cur.last_name,
        d.age              ?? cur.age,
        d.gender           || cur.gender,
        d.treatment        || cur.treatment,
        d.area             !== undefined ? (d.area || null) : cur.area,
        d.freebie          !== undefined ? (d.freebie || null) : cur.freebie,
        d.companionTreatment !== undefined ? (d.companionTreatment || null) : cur.companion_treatment,
        d.totalPrice       !== undefined ? d.totalPrice : cur.total_price,
        d.paymentMode      || cur.payment_mode,
        d.phone            || cur.phone,
        d.socialMedia      !== undefined ? (d.socialMedia || null) : cur.social_media,
        d.email            || cur.email,
        d.agent            || cur.agent,
        d.bookingDetails   !== undefined ? (d.bookingDetails || null) : cur.booking_details,
        d.adInteracted     !== undefined ? (d.adInteracted || null) : cur.ad_interacted,
        d.companionFirstName !== undefined ? (d.companionFirstName || null) : cur.companion_first_name,
        d.companionLastName  !== undefined ? (d.companionLastName  || null) : cur.companion_last_name,
        d.companionAge       !== undefined ? (d.companionAge       || null) : cur.companion_age,
        d.companionGender    !== undefined ? (d.companionGender    || null) : cur.companion_gender,
        d.companionFreebie   !== undefined ? (d.companionFreebie   || null) : cur.companion_freebie,
        d.companionArea      !== undefined ? (d.companionArea      || null) : cur.companion_area,
        d.remarks            !== undefined ? (d.remarks            || null) : cur.remarks,
        d.purchaseDetails    !== undefined ? (d.purchaseDetails    || null) : cur.purchase_details,
        d.isOts              !== undefined ? d.isOts              : cur.is_ots,
        d.isAdId             !== undefined ? d.isAdId             : cur.is_ad_id,
        d.isCompanion        !== undefined ? d.isCompanion        : cur.is_companion,
        d.isHighPriority     !== undefined ? d.isHighPriority     : cur.is_high_priority,
        d.isMetaConversion   !== undefined ? d.isMetaConversion   : cur.is_meta_conversion,
        emailNorm, phoneNorm, socialNorm, fullName, companionFN,
        d.followUpDate !== undefined ? (d.followUpDate || null) : cur.follow_up_date,
        d.bookingDate  !== undefined ? (d.bookingDate  || null) : cur.booking_date,
        d.bookingTime  !== undefined ? (d.bookingTime  || null) : cur.booking_time,
        d.doNotCall      !== undefined ? d.doNotCall      : cur.do_not_call,
        d.isRescheduled  !== undefined ? d.isRescheduled  : cur.is_rescheduled,
        recordId
      ]);

      // Compute diff and log activity
      const nv = (incoming, current) => incoming !== undefined ? (incoming ?? '') : (current ?? '');
      const diffPairs = [
        ['booking_status',        d.status        || cur.booking_status,    cur.booking_status],
        ['branch',                d.branch        || cur.branch,            cur.branch],
        ['appointment_date',      newApptDate,                              normDate(cur.appointment_date)],
        ['appointment_time',      newApptTime,                              cur.appointment_time],
        ['first_name',            d.firstName     || cur.first_name,        cur.first_name],
        ['last_name',             d.lastName      || cur.last_name,         cur.last_name],
        ['age',                   String(d.age          !== undefined ? (d.age    ?? '') : (cur.age          ?? '')), String(cur.age          ?? '')],
        ['gender',                nv(d.gender,          cur.gender),                   cur.gender          ?? ''],
        ['email',                 nv(d.email,           cur.email),                    cur.email           ?? ''],
        ['phone',                 d.phone         || cur.phone,             cur.phone],
        ['social_media',          nv(d.socialMedia,     cur.social_media),             cur.social_media    ?? ''],
        ['treatment',             d.treatment     || cur.treatment,         cur.treatment],
        ['area',                  nv(d.area,            cur.area),                     cur.area            ?? ''],
        ['freebie',               nv(d.freebie,         cur.freebie),                  cur.freebie         ?? ''],
        ['total_price',           String(d.totalPrice   !== undefined ? d.totalPrice   : cur.total_price),  String(cur.total_price)],
        ['payment_mode',          d.paymentMode   || cur.payment_mode,      cur.payment_mode],
        ['agent',                 d.agent         || cur.agent,             cur.agent],
        ['booking_details',       nv(d.bookingDetails,  cur.booking_details),          cur.booking_details ?? ''],
        ['ad_interacted',         nv(d.adInteracted,    cur.ad_interacted),            cur.ad_interacted   ?? ''],
        ['companion_treatment',   nv(d.companionTreatment, cur.companion_treatment),   cur.companion_treatment ?? ''],
        ['companion_first_name',  nv(d.companionFirstName, cur.companion_first_name),  cur.companion_first_name ?? ''],
        ['companion_last_name',   nv(d.companionLastName,  cur.companion_last_name),   cur.companion_last_name  ?? ''],
        ['companion_age',         String(d.companionAge !== undefined ? (d.companionAge ?? '') : (cur.companion_age ?? '')), String(cur.companion_age ?? '')],
        ['companion_gender',      nv(d.companionGender, cur.companion_gender),         cur.companion_gender ?? ''],
        ['companion_freebie',     nv(d.companionFreebie,cur.companion_freebie),        cur.companion_freebie ?? ''],
        ['remarks',               nv(d.remarks,         cur.remarks),                  cur.remarks         ?? ''],
        ['purchase_details',      nv(d.purchaseDetails, cur.purchase_details),         cur.purchase_details ?? ''],
        ['follow_up_date',        normDate(d.followUpDate !== undefined ? d.followUpDate : cur.follow_up_date), normDate(cur.follow_up_date)],
        ['booking_date',          normDate(d.bookingDate !== undefined ? d.bookingDate : cur.booking_date),    normDate(cur.booking_date)],
        ['booking_time',          nv(d.bookingTime,     cur.booking_time),             cur.booking_time    ?? ''],
        ['is_ots',                String(d.isOts            !== undefined ? d.isOts            : cur.is_ots),            String(cur.is_ots)],
        ['is_high_priority',      String(d.isHighPriority   !== undefined ? d.isHighPriority   : cur.is_high_priority),  String(cur.is_high_priority)],
        ['is_meta_conversion',    String(d.isMetaConversion !== undefined ? d.isMetaConversion : cur.is_meta_conversion), String(cur.is_meta_conversion)],
        ['do_not_call',           String(d.doNotCall     !== undefined ? d.doNotCall     : cur.do_not_call),     String(cur.do_not_call)],
        ['is_rescheduled',        String(d.isRescheduled !== undefined ? d.isRescheduled : cur.is_rescheduled),  String(cur.is_rescheduled)],
      ];
      const changes = {};
      for (const [field, nv, ov] of diffPairs) {
        if (String(nv ?? '') !== String(ov ?? '')) changes[field] = { from: ov, to: nv };
      }
      const logAction = changes.booking_status ? 'STATUS_CHANGED'
                      : Object.keys(changes).length > 0 ? 'UPDATED'
                      : null;
      if (logAction) await logActivity(recordId, user, logAction, changes);

      res.json({ success: true, message: 'Booking updated successfully', recordId, cancellationTime });
    } catch (err) {
      console.error('Update booking error:', err);
      res.status(500).json({ error: 'Failed to update booking', details: err.message });
    }
  }

  // ── updateValidation ───────────────────────────────────────────────────────
  // PATCH /bookings/:rowNumber/validation  (rowNumber is record_id)
  // Sets the tri-state Underage Status / Double Booking Status columns.
  async updateValidation(req, res) {
    try {
      if (req.user?.role !== 'Admin') {
        return res.status(403).json({ error: 'Only admins can set validation status' });
      }

      const recordId = req.params.rowNumber;
      const { underageStatus, dbStatus } = req.body;
      const ALLOWED = ['Approved', 'Pending', 'Rejected'];

      // Build a partial update from whichever field(s) were supplied
      const sets = [], vals = [];
      if (underageStatus !== undefined) {
        if (!ALLOWED.includes(underageStatus)) return res.status(400).json({ error: `underageStatus must be one of ${ALLOWED.join(', ')}` });
        vals.push(underageStatus); sets.push(`underage_status = $${vals.length}`);
      }
      if (dbStatus !== undefined) {
        if (!ALLOWED.includes(dbStatus)) return res.status(400).json({ error: `dbStatus must be one of ${ALLOWED.join(', ')}` });
        vals.push(dbStatus); sets.push(`db_status = $${vals.length}`);
      }
      if (!sets.length) return res.status(400).json({ error: 'Nothing to update: provide underageStatus and/or dbStatus' });

      vals.push(recordId);
      const { rowCount } = await pool.query(
        `UPDATE bookings SET ${sets.join(', ')} WHERE record_id = $${vals.length}`,
        vals
      );

      if (!rowCount) return res.status(404).json({ error: 'Booking not found' });

      res.json({ success: true, recordId, underageStatus, dbStatus });
    } catch (err) {
      console.error('updateValidation error:', err);
      res.status(500).json({ error: 'Failed to update validation status' });
    }
  }

  // ── updateFlags ────────────────────────────────────────────────────────────
  // PATCH /bookings/:id/flags — toggle the OTS / With-Companion identifier columns
  async updateFlags(req, res) {
    try {
      const recordId = req.params.id;
      const { isOts, isCompanion } = req.body;
      const sets = [], vals = [];
      if (isOts !== undefined)      { vals.push(isOts === true);      sets.push(`is_ots = $${vals.length}`); }
      if (isCompanion !== undefined) { vals.push(isCompanion === true); sets.push(`is_companion = $${vals.length}`); }
      if (!sets.length) return res.status(400).json({ error: 'Nothing to update: provide isOts and/or isCompanion' });

      vals.push(recordId);
      const { rowCount } = await pool.query(
        `UPDATE bookings SET ${sets.join(', ')} WHERE record_id = $${vals.length}`, vals
      );
      if (!rowCount) return res.status(404).json({ error: 'Booking not found' });

      res.json({ success: true, recordId, isOts, isCompanion });
    } catch (err) {
      console.error('updateFlags error:', err);
      res.status(500).json({ error: 'Failed to update flags' });
    }
  }

  // ── deleteBooking ──────────────────────────────────────────────────────────
  // DELETE /bookings/:rowNumber  (rowNumber is record_id)
  async deleteBooking(req, res) {
    try {
      if (req.user?.role !== 'Admin') {
        return res.status(403).json({ error: 'Only admins can delete bookings' });
      }

      const recordId = req.params.rowNumber;

      const { rowCount } = await pool.query(
        `UPDATE bookings SET record_status = 'DELETED' WHERE record_id = $1 AND record_status != 'DELETED'`,
        [recordId]
      );

      if (!rowCount) return res.status(404).json({ error: 'Booking not found' });

      res.json({ success: true, message: 'Booking deleted successfully', recordId });
    } catch (err) {
      console.error('deleteBooking error:', err);
      res.status(500).json({ error: 'Failed to delete booking', details: err.message });
    }
  }

  // ── getDailyReports ────────────────────────────────────────────────────────
  async getDailyReports(req, res) {
    try {
      // Fetch all rows needed for the 7 report sections in one query
      const { rows } = await pool.query(`
        SELECT branch, booking_status, appointment_date, created_at, booking_date, total_price,
               cancellation_time, underage_cancellation, underage_status, db_status, follow_up_date
        FROM bookings
        WHERE record_status != 'DELETED'
          AND (
            booking_date = (NOW() AT TIME ZONE 'Asia/Manila')::date
            OR (created_at AT TIME ZONE 'Asia/Manila')::date = (NOW() AT TIME ZONE 'Asia/Manila')::date
            OR appointment_date = (NOW() AT TIME ZONE 'Asia/Manila')::date + 1
            OR (appointment_date > (NOW() AT TIME ZONE 'Asia/Manila')::date + 1 AND appointment_date <= (NOW() AT TIME ZONE 'Asia/Manila')::date + 7)
            OR (LOWER(booking_status) LIKE '%cancel%')
            OR (appointment_date = (NOW() AT TIME ZONE 'Asia/Manila')::date AND LOWER(booking_status) IN (
                'arrived & bought','arrived not potential','comeback & bought','promo hunter','scheduled','no show'
            ))
            OR (follow_up_date = (NOW() AT TIME ZONE 'Asia/Manila')::date)
          )
      `);

      const phFmt      = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' });
      const now        = Date.now();
      const todayStr      = phFmt.format(now);
      const tomorrowStr   = phFmt.format(now + 86400000);
      const next7EndStr   = phFmt.format(now + 7 * 86400000); // day+7 — end of "next 7 days" (e.g. next Mon when today is Mon)
      const next7StartStr = phFmt.format(now + 2 * 86400000); // day+2 — first day after tomorrow
      const rpts = {
        otsBookings:             { total: 0, revenue: 0, count: 0, byBranch: {} },
        overallBookings:         { total: 0, revenue: 0, count: 0, byBranch: {} },
        bookedTomorrow:          { byBranch: {} },
        bookedNext7Days:         { byBranch: {} },
        cancellations:           { total: 0, revenue: 0, count: 0, byBranch: {} },
        overallBookingsTomorrow: { total: 0, revenue: 0, count: 0, byBranch: {} },
        arrivalsToday:           { count: 0, byBranch: {}, byStatus: { 'Arrived & bought': 0, 'Arrived not potential': 0 } },
        boughtToday:             { count: 0, revenue: 0, comebackCount: 0 },
        noShowsToday:            0,
        promoHuntersToday:       0,
        followUpsDueToday:       0
      };

      const inc = (map, branch, revenue = 0) => {
        if (!map[branch]) map[branch] = { count: 0, revenue: 0 };
        map[branch].count++;
        map[branch].revenue += revenue;
      };

      for (const r of rows) {
        const branch  = r.branch || 'Unknown';
        const status  = (r.booking_status || '').toLowerCase();
        const apptStr    = r.appointment_date ? new Date(r.appointment_date).toISOString().split('T')[0] : null;
        const bookingStr = r.booking_date    ? new Date(r.booking_date).toISOString().split('T')[0]     : null;
        const price      = parseFloat(r.total_price) || 0;
        const created    = r.created_at ? new Date(r.created_at) : null;

        const createdToday = created && phFmt.format(created) === todayStr; // used only for cancellation fallback
        const bookedToday  = bookingStr === todayStr;                       // "OTS" = booked today (booking_date)
        // "Valid" = both tri-state validations Approved (Pending/Rejected are excluded from reports)
        const valid = (r.underage_status || 'Approved') === 'Approved' && (r.db_status || 'Approved') === 'Approved';
        const isToday    = apptStr === todayStr;
        const isTomorrow = apptStr === tomorrowStr;
        const isNext7    = apptStr != null && apptStr > todayStr    && apptStr <= next7EndStr; // day+1 .. day+7
        const isD7After  = apptStr != null && apptStr >= next7StartStr && apptStr <= next7EndStr; // day+2 .. day+7

        // Section 1: OTS
        if (bookedToday && isToday) {
          rpts.otsBookings.count++; rpts.otsBookings.revenue += price; rpts.otsBookings.total++;
          inc(rpts.otsBookings.byBranch, branch, price);
        }

        // Section 2: Overall
        if (bookedToday && (isToday || isNext7)) {
          rpts.overallBookings.count++; rpts.overallBookings.revenue += price; rpts.overallBookings.total++;
          inc(rpts.overallBookings.byBranch, branch, price);
        }

        // Section 3: Booked Tomorrow
        if (bookedToday && isTomorrow && status === 'scheduled') {
          inc(rpts.bookedTomorrow.byBranch, branch, price);
        }

        // Section 4: Booked Next 7 Days
        if (bookedToday && isD7After && status === 'scheduled') {
          inc(rpts.bookedNext7Days.byBranch, branch, price);
        }

        // Section 5: Cancellations
        if (status.includes('cancel')) {
          const cancelDay = r.cancellation_time ? new Date(r.cancellation_time) : null;
          const cancelledToday = cancelDay && phFmt.format(cancelDay) === todayStr;
          if (cancelledToday || (!r.cancellation_time && createdToday)) {
            rpts.cancellations.count++; rpts.cancellations.revenue += price; rpts.cancellations.total++;
            inc(rpts.cancellations.byBranch, branch, price);
          }
        }

        // Section 6: Tomorrow Summary (any creation date) — drives both the
        // "Overall Bookings Tomorrow" big number AND its per-branch chart, so they match.
        // Per formula #1: appt=Tomorrow, Scheduled, and both validations Approved.
        if (isTomorrow && status === 'scheduled' && valid) {
          rpts.overallBookingsTomorrow.count++;
          rpts.overallBookingsTomorrow.revenue += price;
          rpts.overallBookingsTomorrow.total++;
          inc(rpts.overallBookingsTomorrow.byBranch, branch, price);
        }

        // Section 7: Arrivals Today (exclude non-Approved underage status)
        if (isToday && r.underage_status === 'Approved' &&
            (status === 'arrived & bought' || status === 'arrived not potential')) {
          rpts.arrivalsToday.count++;
          inc(rpts.arrivalsToday.byBranch, branch);
          const label = r.booking_status || '';
          rpts.arrivalsToday.byStatus[label] = (rpts.arrivalsToday.byStatus[label] || 0) + 1;
        }

        // Section 8: Bought Today — "Comeback & Bought" is excluded from the Daily Report (#20)
        if (isToday && r.underage_status === 'Approved' && status === 'arrived & bought') {
          rpts.boughtToday.count++;
          rpts.boughtToday.revenue += price;
        }

        // Section 9: No-shows today
        if (isToday && status === 'no show') rpts.noShowsToday++;

        // Section 10: Promo hunters today
        if (isToday && status === 'promo hunter') rpts.promoHuntersToday++;

        // Section 11: Follow-ups due today
        const fuDate = r.follow_up_date ? String(r.follow_up_date).split('T')[0] : null;
        if (fuDate && fuDate === todayStr) rpts.followUpsDueToday++;
      }

      // Compute derived rates
      const schedulesToday = Object.values(rpts.arrivalsToday.byBranch).reduce((s, v) => s + v.count, 0) +
        Object.values(rpts.otsBookings.byBranch).reduce((s, v) => s + v.count, 0);
      const arrivalRateToday   = schedulesToday   > 0 ? +(rpts.arrivalsToday.count / schedulesToday   * 100).toFixed(1) : null;
      const conversionRateToday = rpts.arrivalsToday.count > 0 ? +(rpts.boughtToday.count / rpts.arrivalsToday.count * 100).toFixed(1) : null;

      res.json({ success: true, date: todayStr, reports: { ...rpts, arrivalRateToday, conversionRateToday } });
    } catch (err) {
      console.error('getDailyReports error:', err);
      res.status(500).json({ error: 'Failed to fetch daily reports' });
    }
  }

  // ── Detailed drill-down endpoints ─────────────────────────────────────────

  async getOTSBookings(req, res) {
    try {
      const { rows } = await pool.query(`
        SELECT first_name, last_name, branch, appointment_date, appointment_time,
               treatment, total_price, booking_status, phone, email, agent
        FROM bookings
        WHERE record_status != 'DELETED'
          AND booking_date = (NOW() AT TIME ZONE 'Asia/Manila')::date
          AND appointment_date = (NOW() AT TIME ZONE 'Asia/Manila')::date
      `);
      res.json({ success: true, bookings: rows.map(mapDrilldown) });
    } catch (err) {
      console.error('getOTSBookings error:', err);
      res.status(500).json({ error: 'Failed to fetch OTS bookings' });
    }
  }

  async getOverallBookings(req, res) {
    try {
      const { rows } = await pool.query(`
        SELECT first_name, last_name, branch, appointment_date, appointment_time,
               treatment, total_price, booking_status, phone, email, agent
        FROM bookings
        WHERE record_status != 'DELETED'
          AND booking_date = (NOW() AT TIME ZONE 'Asia/Manila')::date
          AND appointment_date >= (NOW() AT TIME ZONE 'Asia/Manila')::date
          AND appointment_date <= (NOW() AT TIME ZONE 'Asia/Manila')::date + 7
      `);
      res.json({ success: true, bookings: rows.map(mapDrilldown) });
    } catch (err) {
      console.error('getOverallBookings error:', err);
      res.status(500).json({ error: 'Failed to fetch overall bookings' });
    }
  }

  async getTomorrowBookings(req, res) {
    try {
      const { rows } = await pool.query(`
        SELECT first_name, last_name, branch, appointment_date, appointment_time,
               treatment, total_price, booking_status, phone, email, agent
        FROM bookings
        WHERE record_status != 'DELETED'
          AND booking_date = (NOW() AT TIME ZONE 'Asia/Manila')::date
          AND appointment_date = (NOW() AT TIME ZONE 'Asia/Manila')::date + 1
          AND LOWER(booking_status) = 'scheduled'
      `);
      res.json({ success: true, bookings: rows.map(mapDrilldown) });
    } catch (err) {
      console.error('getTomorrowBookings error:', err);
      res.status(500).json({ error: 'Failed to fetch tomorrow bookings' });
    }
  }

  async getNext7DaysBookings(req, res) {
    try {
      const { rows } = await pool.query(`
        SELECT first_name, last_name, branch, appointment_date, appointment_time,
               treatment, total_price, booking_status, phone, email, agent
        FROM bookings
        WHERE record_status != 'DELETED'
          AND booking_date = (NOW() AT TIME ZONE 'Asia/Manila')::date
          AND appointment_date > (NOW() AT TIME ZONE 'Asia/Manila')::date + 1
          AND appointment_date <= (NOW() AT TIME ZONE 'Asia/Manila')::date + 7
          AND LOWER(booking_status) = 'scheduled'
      `);
      res.json({ success: true, bookings: rows.map(mapDrilldown) });
    } catch (err) {
      console.error('getNext7DaysBookings error:', err);
      res.status(500).json({ error: 'Failed to fetch next 7 days bookings' });
    }
  }

  async getCancellations(req, res) {
    try {
      const { rows } = await pool.query(`
        SELECT first_name, last_name, branch, appointment_date, appointment_time,
               treatment, total_price, booking_status, phone, email, agent,
               cancellation_time, created_at
        FROM bookings
        WHERE record_status != 'DELETED'
          AND LOWER(booking_status) LIKE '%cancel%'
          AND (
            (cancellation_time AT TIME ZONE 'Asia/Manila')::date = (NOW() AT TIME ZONE 'Asia/Manila')::date
            OR (cancellation_time IS NULL AND (created_at AT TIME ZONE 'Asia/Manila')::date = (NOW() AT TIME ZONE 'Asia/Manila')::date)
          )
      `);
      res.json({ success: true, bookings: rows.map(mapDrilldown) });
    } catch (err) {
      console.error('getCancellations error:', err);
      res.status(500).json({ error: 'Failed to fetch cancellations' });
    }
  }

  async getArrivalsToday(req, res) {
    try {
      const { rows } = await pool.query(`
        SELECT first_name, last_name, branch, appointment_date, appointment_time,
               treatment, total_price, booking_status, phone, email, agent
        FROM bookings
        WHERE record_status != 'DELETED'
          AND appointment_date = (NOW() AT TIME ZONE 'Asia/Manila')::date
          AND LOWER(booking_status) IN ('arrived & bought','arrived not potential')
          AND underage_status = 'Approved'
      `);
      res.json({ success: true, bookings: rows.map(mapDrilldown) });
    } catch (err) {
      console.error('getArrivalsToday error:', err);
      res.status(500).json({ error: 'Failed to fetch arrivals today' });
    }
  }

  async getTomorrowSummary(req, res) {
    try {
      const { rows } = await pool.query(`
        SELECT first_name, last_name, branch, appointment_date, appointment_time,
               treatment, total_price, booking_status, phone, email, agent
        FROM bookings
        WHERE record_status != 'DELETED'
          AND appointment_date = (NOW() AT TIME ZONE 'Asia/Manila')::date + 1
          AND LOWER(booking_status) = 'scheduled'
          AND underage_status = 'Approved' AND db_status = 'Approved'
      `);
      res.json({ success: true, bookings: rows.map(mapDrilldown) });
    } catch (err) {
      console.error('getTomorrowSummary error:', err);
      res.status(500).json({ error: 'Failed to fetch tomorrow summary' });
    }
  }

  // ── getCCReport ────────────────────────────────────────────────────────────
  async getCCReport(req, res) {
    try {
      const [{ rows }, { rows: cancelRows }] = await Promise.all([
        pool.query(`
          SELECT branch, booking_status, appointment_date, created_at, booking_date, total_price,
                 payment_mode, underage_status, db_status
          FROM bookings
          WHERE record_status != 'DELETED'
            AND underage_status = 'Approved' AND db_status = 'Approved'
            AND appointment_date >= (NOW() AT TIME ZONE 'Asia/Manila')::date
            AND appointment_date <= (NOW() AT TIME ZONE 'Asia/Manila')::date + 7
        `),
        // Cancellation per Branch — Status = Cancelled, Booked on = Today.
        // Independent of the appointment window and of validation status (per formula).
        pool.query(`
          SELECT branch, COUNT(*)::int AS cnt, COALESCE(SUM(total_price),0) AS revenue
          FROM bookings
          WHERE record_status != 'DELETED'
            AND LOWER(booking_status) = 'cancelled'
            AND booking_date = (NOW() AT TIME ZONE 'Asia/Manila')::date
          GROUP BY branch
        `),
      ]);

      const cancellations = {};
      for (const c of cancelRows) cancellations[c.branch || 'Unknown'] = { count: c.cnt, revenue: parseFloat(c.revenue) || 0 };

      const phFmt      = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' });
      const now        = Date.now();
      const todayStr    = phFmt.format(now);
      const tomorrowStr = phFmt.format(now + 86400000);
      // "Next 7 days" = day+2 .. day+7 (excludes today & tomorrow). E.g. if today is
      // Monday, this counts Wednesday through next Monday.
      const next7EndStr = phFmt.format(now + 7 * 86400000);

      const schedToday = {}, arrToday = {}, schedTomorrow = {}, next7 = {}, otsMap = {};
      const payModesTomorrow = { Cash: 0, Debit: 0, Credit: 0 };
      const payModeRevTomorrow = { Cash: 0, Debit: 0, Credit: 0 };
      const arrStatusMap = {};
      let otsT = 0, otsAddit = 0, otsRev = 0, additRev = 0;
      let arrOTS = 0, arrAddit = 0;
      let schedTomOTS = 0, schedTomAddit = 0;
      let otsNext7 = 0, additNext7 = 0;
      let boughtTodayCount = 0, boughtTodayRevenue = 0, promoHuntersToday = 0;
      let schedTodayRoster = 0; // everyone expected today (excl. cancelled) — arrival-rate denominator

      const inc = (map, branch, rev = 0) => {
        if (!map[branch]) map[branch] = { count: 0, revenue: 0 };
        map[branch].count++;
        map[branch].revenue += rev;
      };

      for (const r of rows) {
        const branch  = r.branch || 'Unknown';
        const status  = (r.booking_status || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const apptStr    = r.appointment_date ? new Date(r.appointment_date).toISOString().split('T')[0] : null;
        const bookingStr = r.booking_date    ? new Date(r.booking_date).toISOString().split('T')[0]     : null;
        const price      = parseFloat(r.total_price) || 0;
        const pm         = (r.payment_mode || '').trim();

        // "OTS" = booked today (booking_date column), regardless of the DB insertion time.
        const bookedToday = bookingStr === todayStr;
        const cancelled   = status.includes('cancel');
        const isArrived   = status === 'arrived & bought' || status === 'arrived not potential';

        if (!apptStr) continue;
        const isToday    = apptStr === todayStr;
        const isTomorrow = apptStr === tomorrowStr;
        const inNext7    = apptStr > tomorrowStr && apptStr <= next7EndStr; // day+2 .. day+7

        // Roster for the arrival-rate denominator (everyone still expected today, excl. cancelled)
        if (!cancelled && isToday) schedTodayRoster++;

        // Schedules today (Status = Scheduled only, per report formula)
        if (isToday && status === 'scheduled') {
          inc(schedToday, branch, price);
          if (bookedToday) { otsT++; otsRev += price; inc(otsMap, branch); }
          else             { otsAddit++; additRev += price; }
        }

        // Arrivals today (base query already excludes non-Approved underage/DB status)
        if (isArrived && isToday) {
          inc(arrToday, branch);
          const label = r.booking_status || '';
          arrStatusMap[label] = (arrStatusMap[label] || 0) + 1;
          if (bookedToday) arrOTS++; else arrAddit++;
        }

        // Bought today (arrived & bought + comeback & bought)
        if (isToday &&
            (status === 'arrived & bought' || status === 'comeback & bought')) {
          boughtTodayCount++;
          boughtTodayRevenue += price;
        }

        // Promo hunters today
        if (isToday && status === 'promo hunter') promoHuntersToday++;

        // Schedules tomorrow (Status = Scheduled only, per report formula)
        if (isTomorrow && status === 'scheduled') {
          inc(schedTomorrow, branch, price);
          const mk = pm.toLowerCase().includes('cash') ? 'Cash'
                   : pm.toLowerCase().includes('debit') ? 'Debit'
                   : pm.toLowerCase().includes('credit') ? 'Credit' : null;
          if (mk) { payModesTomorrow[mk]++; payModeRevTomorrow[mk] += price; }
          if (bookedToday) { schedTomOTS++; inc(otsMap, branch); }
          else              schedTomAddit++;
        }

        // Next 7 days (day+2 .. day+7, Status = Scheduled only — already excludes today & tomorrow via inNext7)
        if (inNext7 && status === 'scheduled') {
          inc(next7, branch, price);
          if (bookedToday) { otsNext7++; inc(otsMap, branch); }
          else              additNext7++;
        }
      }

      const sumCount = map => Object.values(map).reduce((s, b) => s + b.count, 0);
      const sumRev   = map => +Object.values(map).reduce((s, b) => s + b.revenue, 0).toFixed(2);

      const schedTodayTotal   = sumCount(schedToday);
      const arrTodayTotal     = sumCount(arrToday);
      // Arrival rate = arrived / everyone expected today (roster), not / still-scheduled
      const arrivalRateToday   = schedTodayRoster  > 0 ? +(arrTodayTotal     / schedTodayRoster  * 100).toFixed(1) : 0;
      const conversionRateToday = arrTodayTotal    > 0 ? +(boughtTodayCount  / arrTodayTotal     * 100).toFixed(1) : 0;

      return res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        data: {
          totalSchedulesToday:    { ots: otsT, additional: otsAddit, otsRevenue: otsRev, additionalRevenue: additRev, byBranch: schedToday, total: schedTodayTotal },
          totalArrivalsToday:     { otsArrivals: arrOTS, additionalArrivals: arrAddit, byBranch: arrToday, total: arrTodayTotal, byStatus: arrStatusMap },
          totalSchedulesTomorrow: { otsTomorrow: schedTomOTS, additionalTomorrow: schedTomAddit, byBranch: schedTomorrow, total: sumCount(schedTomorrow), potentialRevenue: sumRev(schedTomorrow) },
          paymentModesTomorrow: payModesTomorrow,
          paymentModeRevenueTomorrow: payModeRevTomorrow,
          totalSchedulesNext7:    { otsNext7, additionalNext7: additNext7, byBranch: next7, total: sumCount(next7) },
          totalOTS:               { byBranch: otsMap, total: sumCount(otsMap) },
          cancellationsToday:     { byBranch: cancellations, total: sumCount(cancellations) },
          performance: {
            boughtToday:          { count: boughtTodayCount, revenue: +boughtTodayRevenue.toFixed(2) },
            arrivalRateToday,
            conversionRateToday,
            promoHuntersToday
          }
        }
      });
    } catch (err) {
      console.error('getCCReport error:', err);
      res.status(500).json({ error: 'Failed to generate CC report' });
    }
  }

  // ── getCCReportDrilldown ───────────────────────────────────────────────────
  async getCCReportDrilldown(req, res) {
    try {
      const { section } = req.query;
      const validSections = ['schedules-today','arrivals','schedules-tomorrow','payment-tomorrow','next7days','ots','cancellations'];
      if (!validSections.includes(section)) {
        return res.status(400).json({ error: 'Invalid section. Must be one of: ' + validSections.join(', ') });
      }

      const SELECT = `
        SELECT first_name, last_name, branch, appointment_date, appointment_time,
               treatment, total_price, booking_status, phone, email, agent, payment_mode,
               created_at
        FROM bookings`;
      const phToday = `(NOW() AT TIME ZONE 'Asia/Manila')::date`;

      // Cancellations are independent of the appointment window and of validation status.
      if (section === 'cancellations') {
        const { rows } = await pool.query(
          `${SELECT} WHERE record_status != 'DELETED' AND LOWER(booking_status) = 'cancelled' AND booking_date = ${phToday}`
        );
        return res.json({ success: true, bookings: rows.map(r => ({ ...mapDrilldown(r), paymentMode: normalizePaymentMode(r.payment_mode) })) });
      }

      let SQL = `${SELECT} WHERE record_status != 'DELETED' AND underage_status = 'Approved' AND db_status = 'Approved'`;

      if (section === 'schedules-today') {
        SQL += ` AND appointment_date = ${phToday} AND LOWER(booking_status) = 'scheduled'`;
      } else if (section === 'arrivals') {
        SQL += ` AND appointment_date = ${phToday} AND LOWER(booking_status) IN ('arrived & bought','arrived not potential')`;
      } else if (section === 'schedules-tomorrow' || section === 'payment-tomorrow') {
        SQL += ` AND appointment_date = ${phToday} + 1 AND LOWER(booking_status) = 'scheduled'`;
      } else if (section === 'next7days') {
        // day+2 .. day+7 (excludes today & tomorrow), Scheduled only — matches totalSchedulesNext7
        SQL += ` AND appointment_date > ${phToday} + 1 AND appointment_date <= ${phToday} + 7 AND LOWER(booking_status) = 'scheduled'`;
      } else if (section === 'ots') {
        // OTS = booked today (booking_date), Scheduled, appt within today .. day+7
        // (matches the three Scheduled-only buckets it aggregates).
        SQL += ` AND booking_date = ${phToday} AND appointment_date >= ${phToday} AND appointment_date <= ${phToday} + 7 AND LOWER(booking_status) = 'scheduled'`;
      }

      const { rows } = await pool.query(SQL);
      res.json({ success: true, bookings: rows.map(r => ({ ...mapDrilldown(r), paymentMode: normalizePaymentMode(r.payment_mode) })) });
    } catch (err) {
      console.error('getCCReportDrilldown error:', err);
      res.status(500).json({ error: 'Failed to fetch drill-down bookings' });
    }
  }

  // ── exportBookings ─────────────────────────────────────────────────────────
  // GET /api/bookings/export  — same filters as getOldBookings, returns CSV
  async exportBookings(req, res) {
    try {
      const search    = (req.query.search    || '').trim();
      const branch    = (req.query.branch    || '').trim();
      const status    = (req.query.status    || '').trim();
      const agent     = (req.query.agent     || '').trim();
      const gender    = (req.query.gender    || '').trim();

      const createdDateRange    = req.query.createdDateRange;
      const createdStartDate    = req.query.createdStartDate;
      const createdEndDate      = req.query.createdEndDate;
      const appointmentDateRange = req.query.appointmentDateRange;
      const appointmentStartDate = req.query.appointmentStartDate;
      const appointmentEndDate   = req.query.appointmentEndDate;

      const conds  = ["record_status != 'DELETED'"];
      const params = [];
      let   idx    = 1;

      if (branch && branch !== 'All') {
        const isNot = branch.startsWith('NOT:');
        const vals  = (isNot ? branch.slice(4) : branch).split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
        if (vals.length) { conds.push(isNot ? `NOT (LOWER(branch) = ANY($${idx++}::text[]))` : `LOWER(branch) = ANY($${idx++}::text[])`); params.push(vals); }
      }
      if (status && status !== 'All') {
        const isNot = status.startsWith('NOT:');
        const vals  = (isNot ? status.slice(4) : status).split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
        if (vals.length) { conds.push(isNot ? `NOT (LOWER(booking_status) = ANY($${idx++}::text[]))` : `LOWER(booking_status) = ANY($${idx++}::text[])`); params.push(vals); }
      }
      if (agent && agent !== 'All') {
        const vals = agent.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
        conds.push(`LOWER(COALESCE(agent,'')) = ANY($${idx++}::text[])`); params.push(vals);
      }
      if (gender && gender !== 'All') {
        conds.push(`LOWER(COALESCE(gender,'')) = $${idx++}`); params.push(gender.toLowerCase());
      }
      // Booked On (booking_date) + Appointment-date filters — shared with getOldBookings
      idx = pushBookingDateFilters(conds, params, idx, {
        createdStartDate, createdEndDate, createdDateRange,
        appointmentStartDate, appointmentEndDate, appointmentDateRange,
      });
      if (search) {
        const q = `%${search.toLowerCase()}%`;
        conds.push(`(LOWER(COALESCE(first_name,'')) LIKE $${idx} OR LOWER(COALESCE(last_name,'')) LIKE $${idx} OR (LOWER(COALESCE(first_name,'')) || ' ' || LOWER(COALESCE(last_name,''))) LIKE $${idx} OR LOWER(COALESCE(full_name_norm,'')) LIKE $${idx} OR LOWER(COALESCE(email,'')) LIKE $${idx} OR phone LIKE $${idx} OR LOWER(COALESCE(social_media,'')) LIKE $${idx} OR LOWER(COALESCE(agent,'')) LIKE $${idx} OR LOWER(COALESCE(treatment,'')) LIKE $${idx} OR LOWER(COALESCE(branch,'')) LIKE $${idx})`);
        params.push(q); idx++;
      }

      const WHERE = `WHERE ${conds.join(' AND ')}`;

      const { rows } = await pool.query(`
        SELECT record_id, created_at, branch, booking_status, booking_date, booking_time,
               appointment_date, appointment_time,
               first_name, last_name, age, gender, phone, email, social_media, treatment, area, freebie,
               total_price, payment_mode, agent, ad_interacted, booking_details, remarks, purchase_details,
               companion_first_name, companion_last_name, companion_age, companion_gender,
               companion_freebie, companion_treatment, is_ots, is_ad_id, is_companion, is_high_priority, is_meta_conversion,
               promo_hunter_status, follow_up_date
        FROM bookings ${WHERE}
        ORDER BY appointment_date DESC NULLS LAST, created_at DESC
      `, params);

      const CSV_COLS = [
        ['Record ID','record_id'], ['Created At','created_at'], ['Branch','branch'],
        ['Status','booking_status'], ['Booking Date','booking_date'], ['Booking Time','booking_time'],
        ['Appointment Date','appointment_date'],
        ['Appointment Time','appointment_time'], ['First Name','first_name'],
        ['Last Name','last_name'], ['Age','age'], ['Gender','gender'],
        ['Phone','phone'], ['Email','email'], ['Social Media','social_media'],
        ['Treatment','treatment'], ['Area','area'], ['Freebie','freebie'],
        ['Total Price','total_price'], ['Payment Mode','payment_mode'],
        ['Agent','agent'], ['Ad Interacted','ad_interacted'],
        ['Booking Details','booking_details'], ['Remarks','remarks'],
        ['Purchase Details','purchase_details'],
        ['Companion First Name','companion_first_name'],
        ['Companion Last Name','companion_last_name'],
        ['Companion Age','companion_age'], ['Companion Gender','companion_gender'],
        ['Companion Freebie','companion_freebie'], ['Companion Treatment','companion_treatment'],
        ['OTS','is_ots'], ['Ad ID','is_ad_id'], ['Companion Flag','is_companion'],
        ['High Priority','is_high_priority'], ['Promo Hunter Status','promo_hunter_status'],
        ['Follow-up Date','follow_up_date'],
      ];

      const escCsv = v => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
      };

      const header = CSV_COLS.map(([h]) => h).join(',');
      const lines  = rows.map(r => CSV_COLS.map(([, k]) => escCsv(r[k])).join(','));
      const csv    = [header, ...lines].join('\r\n');

      const dateStr = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="bookings-${dateStr}.csv"`);
      res.send('﻿' + csv); // BOM for Excel UTF-8 compatibility
    } catch (err) {
      console.error('Export bookings error:', err);
      res.status(500).json({ error: 'Failed to export bookings' });
    }
  }

  // ── bulkUpdateStatus ───────────────────────────────────────────────────────
  // POST /api/bookings/bulk-status
  // Body: { recordIds: ['BK-...'], status: 'Arrived & Bought' }
  async bulkUpdateStatus(req, res) {
    try {
      const { recordIds, status, followUpDate } = req.body;

      if (!Array.isArray(recordIds) || recordIds.length === 0) {
        return res.status(400).json({ error: 'recordIds must be a non-empty array' });
      }
      if (recordIds.length > 200) {
        return res.status(400).json({ error: 'Cannot bulk-update more than 200 bookings at once' });
      }

      // Agents can only set their own bookings to limited statuses
      const agentAllowedStatuses = new Set([
        'arrived & bought', 'arrived not potential', 'scheduled', 'cancelled', 'comeback'
      ]);
      if (req.user?.role !== 'Admin') {
        if (status && !agentAllowedStatuses.has(status.toLowerCase())) {
          return res.status(403).json({ error: 'Agents cannot set this status in bulk' });
        }
      }

      const setClauses = [];
      const params     = [];
      let   idx        = 1;

      if (status) {
        let cancellationClause = '';
        if (status.toLowerCase() === 'cancelled') {
          cancellationClause = `, cancellation_time = CASE WHEN cancellation_time IS NULL THEN NOW() ELSE cancellation_time END`;
        }
        setClauses.push(`booking_status = $${idx++}${cancellationClause}`);
        params.push(status);
      }
      if (followUpDate !== undefined) {
        setClauses.push(`follow_up_date = $${idx++}`);
        params.push(followUpDate || null);
      }
      if (setClauses.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      setClauses.push(`updated_at = NOW()`);
      params.push(recordIds);
      const { rowCount } = await pool.query(
        `UPDATE bookings SET ${setClauses.join(', ')}
         WHERE record_id = ANY($${idx}::text[]) AND record_status != 'DELETED'`,
        params
      );

      if (rowCount > 0 && recordIds.length <= 200) {
        const logChanges = {};
        if (status)        logChanges.booking_status = { to: status };
        if (followUpDate !== undefined) logChanges.follow_up_date = { to: followUpDate || null };
        const logRows  = recordIds.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}, $${i * 4 + 5})`);
        const logParams = recordIds.flatMap(rid => [
          rid,
          req.user?.userId || null,
          req.user?.name   || req.user?.email || 'System',
          'BULK_STATUS',
          JSON.stringify(logChanges)
        ]);
        await pool.query(
          `INSERT INTO booking_activity_log (booking_id, user_id, user_name, action, changes) VALUES ${recordIds.map((_, i) => `($${i*5+1},$${i*5+2},$${i*5+3},$${i*5+4},$${i*5+5})`).join(',')}`,
          logParams
        ).catch(e => console.error('Bulk activity log failed:', e.message));
      }

      res.json({ success: true, updated: rowCount, message: `${rowCount} booking(s) updated` });
    } catch (err) {
      console.error('Bulk update error:', err);
      res.status(500).json({ error: 'Failed to bulk update bookings' });
    }
  }

  // ── getCustomerHistory ─────────────────────────────────────────────────────
  // GET /api/bookings/customer?query=<phone|email|name>
  async getCustomerHistory(req, res) {
    try {
      const query = (req.query.query || '').trim();
      if (!query || query.length < 3) {
        return res.status(400).json({ error: 'Query must be at least 3 characters' });
      }

      const norm   = query.toLowerCase().replace(/\s+/g, ' ').trim();
      const likePat = `%${norm}%`;

      const { rows } = await pool.query(`
        SELECT record_id, created_at, branch, booking_status, appointment_date, appointment_time,
               first_name, last_name, age, gender, phone, email, social_media, treatment, area, freebie,
               total_price, payment_mode, agent, booking_details, remarks, purchase_details,
               companion_first_name, companion_last_name,
               promo_hunter_status, match_reason, is_ots, is_high_priority, is_meta_conversion,
               do_not_call, is_rescheduled, follow_up_date
        FROM bookings
        WHERE record_status != 'DELETED'
          AND (
            phone = $1
            OR LOWER(COALESCE(email,'')) = $2
            OR LOWER(COALESCE(social_media,'')) = $2
            OR (LOWER(COALESCE(first_name,'')) || ' ' || LOWER(COALESCE(last_name,''))) LIKE $3
            OR full_name_norm LIKE $3
          )
        ORDER BY appointment_date DESC NULLS LAST, created_at DESC
        LIMIT 500
      `, [query, norm, likePat]);

      if (!rows.length) {
        return res.json({ success: true, customer: null, bookings: [] });
      }

      const latest    = rows[0];
      const allPrices = rows.map(r => parseFloat(r.total_price) || 0);
      const SOLD      = new Set(['arrived & bought', 'comeback & bought', 'arrived not potential']);
      const soldRows  = rows.filter(r => SOLD.has((r.booking_status || '').toLowerCase()));

      const summary = {
        name:          `${latest.first_name || ''} ${latest.last_name || ''}`.trim(),
        phone:         latest.phone         || '',
        email:         latest.email         || '',
        socialMedia:   latest.social_media  || '',
        gender:        latest.gender        || '',
        totalBookings: rows.length,
        totalSpend:    +soldRows.reduce((s, r) => s + (parseFloat(r.total_price) || 0), 0).toFixed(2),
        avgSpend:      soldRows.length > 0 ? +(soldRows.reduce((s, r) => s + (parseFloat(r.total_price) || 0), 0) / soldRows.length).toFixed(2) : 0,
        completedBookings: soldRows.length,
        firstVisit:    rows[rows.length - 1]?.appointment_date || null,
        lastVisit:     rows[0]?.appointment_date || null,
        isRepeat:      rows.length > 1,
        branches:      [...new Set(rows.map(r => r.branch).filter(Boolean))],
      };

      const bookingList = rows.map(r => ({
        recordId:       r.record_id,
        date:           normDate(r.appointment_date),
        time:           r.appointment_time || '',
        branch:         r.branch           || '',
        status:         r.booking_status   || '',
        treatment:      r.treatment        || '',
        area:           r.area             || '',
        totalPrice:     parseFloat(r.total_price) ?? 0,
        paymentMode:    normalizePaymentMode(r.payment_mode),
        agent:          r.agent            || '',
        remarks:        r.remarks          || '',
        purchaseDetails: r.purchase_details || '',
        followUpDate:   normDate(r.follow_up_date) || null,
        isOts:             r.is_ots             || false,
        isHighPriority:    r.is_high_priority   || false,
        isMetaConversion:  r.is_meta_conversion || false,
        doNotCall:         r.do_not_call        || false,
        isRescheduled:     r.is_rescheduled     || false,
        promoHunterStatus: r.promo_hunter_status || '',
        createdAt:      r.created_at,
      }));

      res.json({ success: true, customer: summary, bookings: bookingList });
    } catch (err) {
      console.error('Customer history error:', err);
      res.status(500).json({ error: 'Failed to fetch customer history' });
    }
  }

  // ── getActivityLog ─────────────────────────────────────────────────────────
  async getActivityLog(req, res) {
    try {
      const { id } = req.params;
      const { rows } = await pool.query(
        `SELECT id, user_name, action, changes, created_at
         FROM booking_activity_log
         WHERE booking_id = $1
         ORDER BY created_at DESC
         LIMIT 200`,
        [id]
      );
      res.json({ success: true, log: rows });
    } catch (err) {
      console.error('Activity log error:', err);
      res.status(500).json({ error: 'Failed to load activity log' });
    }
  }

  // ── getKanbanBookings ──────────────────────────────────────────────────────
  async getKanbanBookings(req, res) {
    try {
      const date   = req.query.date   || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
      const branch = (req.query.branch || '').trim();

      const conds  = ["record_status != 'DELETED'", `appointment_date = $1::date`];
      const params = [date];
      if (branch && branch !== 'All') {
        conds.push(`branch = $2`);
        params.push(branch);
      }

      const { rows } = await pool.query(`
        SELECT
          record_id, booking_status, branch, appointment_time,
          first_name, last_name, treatment, total_price, payment_mode,
          agent, phone, is_ots, is_high_priority, is_meta_conversion,
          do_not_call, is_rescheduled, follow_up_date, remarks
        FROM bookings
        WHERE ${conds.join(' AND ')}
        ORDER BY appointment_time ASC NULLS LAST, created_at ASC
      `, params);

      const bookings = rows.map(r => ({
        recordId:      r.record_id,
        status:        r.booking_status   || '',
        branch:        r.branch           || '',
        time:          r.appointment_time || '',
        firstName:     r.first_name       || '',
        lastName:      r.last_name        || '',
        treatment:     r.treatment        || '',
        totalPrice:    parseFloat(r.total_price) ?? 0,
        paymentMode:   normalizePaymentMode(r.payment_mode),
        agent:         r.agent            || '',
        phone:         r.phone            || '',
        isOts:            r.is_ots             || false,
        isHighPriority:   r.is_high_priority   || false,
        isMetaConversion: r.is_meta_conversion || false,
        doNotCall:        r.do_not_call        || false,
        isRescheduled:    r.is_rescheduled     || false,
        followUpDate:     normDate(r.follow_up_date) || null,
        remarks:          r.remarks            || '',
      }));

      res.json({ success: true, date, bookings });
    } catch (err) {
      console.error('Kanban error:', err);
      res.status(500).json({ error: 'Failed to load kanban data' });
    }
  }
}

// ── Promo hunter check ───────────────────────────────────────────────────────

async function checkPromoHunter(firstName, lastName, email, phone, socialMedia, companionFirstName, companionLastName) {
  try {
    const fullName        = `${firstName} ${lastName}`.toLowerCase().trim();
    const companionFull   = companionFirstName && companionLastName
      ? `${companionFirstName} ${companionLastName}`.toLowerCase().trim() : '';
    const emailNorm       = normalizeEmail(email);
    const phoneNorm       = (phone       || '').replace(/\D/g, '');
    const socialNorm      = (socialMedia || '').toLowerCase().trim();

    if (!fullName && !emailNorm && !phoneNorm && !socialNorm && !companionFull) {
      return { status: 'Scheduled', matchReason: '', matchedSource: '', matchedRow: '', matchCount: 0 };
    }

    const { rows } = await pool.query(`
      SELECT record_id, first_name, last_name, branch,
             full_name_norm, email_norm, phone_norm, social_norm, companion_full_name_norm
      FROM bookings
      WHERE record_status != 'DELETED'
        AND (
          ($1 != '' AND full_name_norm = $1)
          OR ($2 != '' AND email_norm = $2)
          OR ($3 != '' AND phone_norm = $3)
          OR ($4 != '' AND social_norm = $4)
          OR ($1 != '' AND companion_full_name_norm = $1)
          OR ($5 != '' AND full_name_norm = $5)
        )
      LIMIT 5
    `, [fullName, emailNorm, phoneNorm, socialNorm, companionFull]);

    if (!rows.length) {
      return { status: 'Scheduled', matchReason: '', matchedSource: '', matchedRow: '', matchCount: 0 };
    }

    const first = rows[0];
    let matchReason = '', matchedAs = 'customer';

    if (fullName && first.full_name_norm === fullName)                 { matchReason = 'Customer Name Match'; }
    else if (emailNorm && first.email_norm === emailNorm)               { matchReason = 'Email Match'; }
    else if (phoneNorm && first.phone_norm === phoneNorm)               { matchReason = 'Phone Match'; }
    else if (socialNorm && first.social_norm === socialNorm)            { matchReason = 'Social Media Match'; }
    else if (companionFull && first.companion_full_name_norm === companionFull) { matchReason = 'Previously Companion'; matchedAs = 'companion'; }
    else if (companionFull && first.full_name_norm === companionFull)   { matchReason = 'Companion Match (was customer)'; matchedAs = 'companion'; }
    else                                                                { matchReason = 'Name Match'; }

    return {
      status: 'Promo hunter',
      matchReason,
      matchedSource: `${matchedAs} (${first.branch || ''})`,
      matchedRow:    first.record_id,
      matchCount:    rows.length
    };
  } catch (err) {
    console.error('[Promo Hunter Check] Error:', err);
    return { status: 'Scheduled', matchReason: '', matchedSource: '', matchedRow: '', matchCount: 0 };
  }
}

// ── Excel Import helpers (mirrors migrate-from-excel.js) ─────────────────────

function _str(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return null;
  const s = String(v).trim();
  return (s === '' || s === 'NaN' || s === 'undefined' || s === 'null') ? null : s;
}
function _bool(v) {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return false;
  return ['TRUE', '1', 'YES'].includes(String(v).toUpperCase().trim());
}
function _price(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number' && !isNaN(v)) return v;
  const n = parseFloat(String(v).replace(/[₱,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}
function _int(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}
function _isoTs(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function _dateOnly(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}
function _timeOnly(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (isNaN(d.getTime())) return null;
  const h = d.getHours(), m = d.getMinutes();
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

let _importIdCounter = 0;
function _genRecordId(createdAt) {
  const d = (createdAt instanceof Date && !isNaN(createdAt)) ? createdAt : new Date();
  const p = n => String(n).padStart(2, '0');
  const rand = (++_importIdCounter).toString(36).toUpperCase().padStart(3, '0')
             + Math.random().toString(36).toUpperCase().slice(2, 4);
  return `BK-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}`
       + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
       + `-${rand.slice(0, 5)}`;
}

const IMPORT_COLS = [
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
const IMPORT_N = IMPORT_COLS.length;

const IMPORT_SINGLE_SQL = `
  INSERT INTO bookings (${IMPORT_COLS.join(', ')})
  VALUES (${Array.from({ length: IMPORT_N }, (_, i) => `$${i + 1}`).join(', ')})
  ON CONFLICT (record_id) DO NOTHING
`;

function _rowToValues(row) {
  const createdAt = row[0] instanceof Date ? row[0] : null;
  const apptDt    = row[3] instanceof Date ? row[3] : null;
  const rawId     = _str(row[38]);
  return [
    rawId || _genRecordId(createdAt),
    _str(row[39]) || 'ACTIVE',
    _isoTs(createdAt),
    _str(row[1])  || '',
    _str(row[2])  || 'Scheduled',
    _dateOnly(createdAt),
    _timeOnly(createdAt),
    _dateOnly(apptDt),
    _timeOnly(apptDt),
    null,
    _str(row[4])  || '',
    _str(row[5])  || '',
    _int(row[6]),
    _str(row[7]),
    _str(row[14]),
    _str(row[16]),
    _str(row[15]),
    _str(row[8]),
    _str(row[9]),
    _str(row[10]),
    _price(row[12]),
    _str(row[13]),
    _str(row[11]),
    _str(row[20]),
    _str(row[21]),
    _int(row[22]),
    _str(row[23]),
    _str(row[24]),
    null,
    _str(row[17]),
    _str(row[18]),
    null,
    _str(row[43]),
    _str(row[19]),
    _str(row[29]),
    _str(row[30]),
    _str(row[31]),
    _str(row[32]),
    _str(row[33]),
    _str(row[34]),
    _str(row[35]),
    _str(row[36]),
    _str(row[37]),
    _isoTs(row[40] instanceof Date ? row[40] : null),
    _bool(row[25]),
    _str(row[26]),
    _bool(row[27]),
    _str(row[28]),
    _str(row[41]),
    _bool(row[42]),
    false, false, false, false, false, false,
  ];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime12h(timeStr) {
  if (!timeStr) return null;
  const [hStr, mStr] = timeStr.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr || '0', 10);
  if (isNaN(h) || isNaN(m)) return timeStr;
  const ampm    = h >= 12 ? 'PM' : 'AM';
  const display = h % 12 || 12;
  return `${display}:${String(m).padStart(2, '0')} ${ampm}`;
}

function mapDrilldown(r) {
  return {
    firstName:  r.first_name || '',
    lastName:   r.last_name  || '',
    branch:     r.branch     || '',
    date:       r.appointment_date ? new Date(r.appointment_date).toISOString().split('T')[0] : '',
    treatment:  r.treatment  || '',
    totalPrice: parseFloat(r.total_price) || 0,
    status:     r.booking_status || '',
    phone:      r.phone      || '',
    email:      r.email      || '',
    agent:      r.agent      || ''
  };
}

// ── Import (attached outside class so it can be used as standalone middleware) ─
BookingController.prototype.importBookings = async function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const XLSX = require('xlsx');
    const wb = XLSX.read(req.file.buffer, { cellDates: true });
    const ws = wb.Sheets['MASTER_RECORDS'];
    if (!ws) {
      return res.status(400).json({
        error: `Sheet "MASTER_RECORDS" not found. Available sheets: ${wb.SheetNames.join(', ')}`
      });
    }

    const allRows  = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const dataRows = allRows
      .slice(1)
      .filter(r => r && r.some(v => v !== null && v !== undefined && v !== ''));

    const total     = dataRows.length;
    const BATCH     = 200;
    let inserted    = 0;
    let skipped     = 0;
    let errCount    = 0;
    const errDetails = [];

    for (let b = 0; b < total; b += BATCH) {
      const batch   = dataRows.slice(b, b + BATCH);
      const rowVals = batch.map(_rowToValues);

      const groups = rowVals.map((_, i) => {
        const start = i * IMPORT_N + 1;
        return `(${Array.from({ length: IMPORT_N }, (_, j) => `$${start + j}`).join(', ')})`;
      });

      const batchSql = `
        INSERT INTO bookings (${IMPORT_COLS.join(', ')})
        VALUES ${groups.join(',\n')}
        ON CONFLICT (record_id) DO NOTHING
      `;

      try {
        const result = await pool.query(batchSql, rowVals.flat());
        inserted += result.rowCount || 0;
        skipped  += batch.length - (result.rowCount || 0);
      } catch {
        for (let r = 0; r < rowVals.length; r++) {
          try {
            const res2 = await pool.query(IMPORT_SINGLE_SQL, rowVals[r]);
            inserted += res2.rowCount || 0;
          } catch (rowErr) {
            errCount++;
            if (errDetails.length < 20) {
              errDetails.push(`Row ${b + r + 2} (${rowVals[r][0]}): ${rowErr.message}`);
            }
            skipped++;
          }
        }
      }
    }

    return res.json({ total, inserted, skipped, errors: errCount, errDetails });
  } catch (err) {
    console.error('[importBookings] Fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// Re-export the singleton with the patched method
module.exports = new BookingController();
