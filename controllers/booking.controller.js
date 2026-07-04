'use strict';
const { v4: uuidv4 } = require('uuid');
const Joi = require('joi');
const pool = require('../db/pool');

// Validation schema for booking creation
const bookingSchema = Joi.object({
  branch:              Joi.string().required(),
  status:              Joi.string().default('Scheduled'),
  firstName:           Joi.string().required(),
  lastName:            Joi.string().required(),
  age:                 Joi.number().integer().min(1).max(150).required(),
  phone:               Joi.string().required(),
  socialMedia:         Joi.string().allow('').optional(),
  email:               Joi.string().email().required(),
  treatment:           Joi.string().required(),
  area:                Joi.string().allow('').optional(),
  freebie:             Joi.string().allow('').optional(),
  date:                Joi.string().required(),         // YYYY-MM-DD
  time:                Joi.string().required(),         // HH:MM (24h)
  paymentMode:         Joi.string().valid('Cash', 'Debit', 'Credit').required(),
  totalPrice:          Joi.number().min(0).required(),
  gender:              Joi.string().valid('Male', 'Female').required(),
  companionFirstName:  Joi.string().allow('').optional(),
  companionLastName:   Joi.string().allow('').optional(),
  companionAge:        Joi.alternatives().try(Joi.number(), Joi.string().allow('')).optional(),
  companionFreebie:    Joi.string().allow('').optional(),
  companionTreatment:  Joi.string().allow('').optional(),
  companionGender:     Joi.string().valid('Male', 'Female', '').allow('').optional(),
  companionArea:       Joi.string().allow('').optional(),
  bookingDetails:      Joi.string().allow('').optional(),
  adInteracted:        Joi.string().allow('').optional(),
  remarks:             Joi.string().allow('').optional(),
  agent:               Joi.string().required()
});

class BookingController {

  // ── createBooking ──────────────────────────────────────────────────────────
  async createBooking(req, res) {
    try {
      const { error, value } = bookingSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const d = value;
      const recordId = `BK-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${uuidv4().slice(0,8).toUpperCase()}`;
      const now      = new Date();

      // Parse appointment date + time into separate DB columns
      const appointmentDate = d.date;  // YYYY-MM-DD
      const appointmentTime = formatTime12h(d.time); // "HH:MM" → "H:MM AM/PM"
      const bookingDate     = now.toISOString().split('T')[0];
      const bookingTime     = formatTime12h(
        `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`
      );

      // Promo hunter check
      const promoResult = await checkPromoHunter(
        d.firstName, d.lastName, d.email, d.phone, d.socialMedia,
        d.companionFirstName, d.companionLastName
      );

      const finalStatus = promoResult.status === 'Promo hunter' ? 'Promo hunter' : (d.status || 'Scheduled');

      // Normalized fields
      const emailNorm   = (d.email        || '').toLowerCase().trim();
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
          is_ots, is_ad_id, is_companion, is_high_priority
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
          false,false,false,false
        )`,
        [
          recordId, now,
          d.branch, finalStatus,
          bookingDate, bookingTime, appointmentDate, appointmentTime,
          d.firstName, d.lastName, d.age, d.gender,
          d.phone, d.email, d.socialMedia || null,
          d.treatment, d.area || null, d.freebie || null, d.totalPrice, d.paymentMode,
          d.companionTreatment || null, d.companionFirstName || null, d.companionLastName || null,
          d.companionAge || null, d.companionGender || null, d.companionFreebie || null, d.companionArea || null,
          d.agent, d.bookingDetails || null, d.remarks || null, d.adInteracted || null,
          emailNorm, phoneNorm, socialNorm, fullName, companionFN,
          promoResult.status, promoResult.matchReason || null, promoResult.matchedSource || null, promoResult.matchedRow || null
        ]
      );

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

      // Created date filter
      if (createdStartDate && createdEndDate) {
        conds.push(`DATE(created_at) >= $${idx++}::date AND DATE(created_at) <= $${idx++}::date`);
        params.push(createdStartDate, createdEndDate);
      } else if (createdDateRange && createdDateRange !== 'all') {
        if (createdDateRange === 'today') {
          conds.push('DATE(created_at) = CURRENT_DATE');
        } else {
          const daysMap = { last7: 7, last30: 30, last90: 90 };
          const d = daysMap[createdDateRange];
          if (d) conds.push(`DATE(created_at) >= CURRENT_DATE - INTERVAL '${d} days'`);
        }
      }

      // Appointment date filter
      if (appointmentStartDate && appointmentEndDate) {
        conds.push(`appointment_date >= $${idx++}::date AND appointment_date <= $${idx++}::date`);
        params.push(appointmentStartDate, appointmentEndDate);
      } else if (appointmentDateRange && appointmentDateRange !== 'all') {
        if (appointmentDateRange === 'today')    conds.push('appointment_date = CURRENT_DATE');
        else if (appointmentDateRange === 'tomorrow')  conds.push('appointment_date = CURRENT_DATE + 1');
        else if (appointmentDateRange === 'thisWeek')  conds.push('appointment_date >= CURRENT_DATE AND appointment_date <= CURRENT_DATE + (6 - EXTRACT(DOW FROM CURRENT_DATE)::int)');
      }

      // Search filter
      if (search) {
        const q = `%${search.toLowerCase()}%`;
        conds.push(`(LOWER(COALESCE(first_name,'')) LIKE $${idx} OR LOWER(COALESCE(last_name,'')) LIKE $${idx} OR LOWER(COALESCE(email,'')) LIKE $${idx} OR phone LIKE $${idx} OR LOWER(COALESCE(social_media,'')) LIKE $${idx} OR LOWER(COALESCE(agent,'')) LIKE $${idx} OR LOWER(COALESCE(treatment,'')) LIKE $${idx} OR LOWER(COALESCE(branch,'')) LIKE $${idx})`);
        params.push(q);
        idx++;
      }

      const WHERE  = `WHERE ${conds.join(' AND ')}`;
      const ORDER  = sortOrder === 'oldest' ? 'ASC' : 'DESC';
      const OFFSET = (page - 1) * limit;

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
            cancel_validation, underage_cancellation,
            remarks, purchase_details,
            is_ots, is_ad_id, is_companion, is_high_priority
          FROM bookings ${WHERE}
          ORDER BY appointment_date ${ORDER} NULLS LAST, created_at ${ORDER}
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
        date:               r.appointment_date ? new Date(r.appointment_date).toISOString().split('T')[0] : '',
        time:               r.appointment_time   || '',
        firstName:          r.first_name         || '',
        lastName:           r.last_name          || '',
        age:                r.age                || '',
        gender:             r.gender             || '',
        treatment:          r.treatment          || '',
        area:               r.area               || '',
        freebie:            r.freebie            || '',
        companionTreatment: r.companion_treatment || '',
        totalPrice:         parseFloat(r.total_price) || 0,
        paymentMode:        r.payment_mode        || '',
        phone:              r.phone              || '',
        socialMedia:        r.social_media        || '',
        email:              r.email              || '',
        agent:              r.agent              || '',
        bookingDetails:     r.booking_details     || '',
        adInteracted:       r.ad_interacted       || '',
        companionFirstName: r.companion_first_name  || '',
        companionLastName:  r.companion_last_name   || '',
        companionAge:       r.companion_age         || '',
        companionGender:    r.companion_gender      || '',
        companionFreebie:   r.companion_freebie     || '',
        companionArea:      r.companion_area        || '',
        promoHunterStatus:  r.promo_hunter_status   || '',
        cancelValidation:   r.cancel_validation     || false,
        underageValidation: r.underage_cancellation || false,
        remarks:            r.remarks              || '',
        purchaseDetails:    r.purchase_details      || '',
        isOts:              r.is_ots               || false,
        isAdId:             r.is_ad_id             || false,
        isCompanion:        r.is_companion         || false,
        isHighPriority:     r.is_high_priority     || false
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
          timestamp:          r.created_at,
          branch:             r.branch             || '',
          status:             r.booking_status     || '',
          date:               r.appointment_date ? new Date(r.appointment_date).toISOString().split('T')[0] : '',
          time:               r.appointment_time   || '',
          firstName:          r.first_name         || '',
          lastName:           r.last_name          || '',
          age:                r.age,
          gender:             r.gender             || '',
          treatment:          r.treatment          || '',
          area:               r.area               || '',
          freebie:            r.freebie            || '',
          companionTreatment: r.companion_treatment || '',
          totalPrice:         parseFloat(r.total_price) || 0,
          paymentMode:        r.payment_mode        || '',
          phone:              r.phone              || '',
          socialMedia:        r.social_media        || '',
          email:              r.email              || '',
          agent:              r.agent              || '',
          bookingDetails:     r.booking_details     || '',
          adInteracted:       r.ad_interacted       || '',
          companionFirstName: r.companion_first_name  || '',
          companionLastName:  r.companion_last_name   || '',
          companionAge:       r.companion_age         || '',
          companionGender:    r.companion_gender      || '',
          companionFreebie:   r.companion_freebie     || '',
          companionArea:      r.companion_area        || '',
          remarks:            r.remarks              || '',
          purchaseDetails:    r.purchase_details      || '',
          promoHunterStatus:  r.promo_hunter_status   || '',
          cancelValidation:   r.cancel_validation     || false,
          underageValidation: r.underage_cancellation || false,
          isOts:              r.is_ots               || false,
          isAdId:             r.is_ad_id             || false,
          isCompanion:        r.is_companion         || false,
          isHighPriority:     r.is_high_priority     || false
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

      const { rows: existing } = await pool.query(
        `SELECT * FROM bookings WHERE record_id = $1 AND record_status != 'DELETED'`,
        [recordId]
      );
      if (!existing.length) return res.status(404).json({ error: 'Booking not found' });

      const cur = existing[0];

      // RBAC: agents cannot change status or agent assignment
      if (user?.role !== 'Admin') {
        if (d.status !== undefined && d.status !== cur.booking_status) {
          return res.status(403).json({ error: 'Agents cannot modify booking status', code: 'RESTRICTED_FIELDS' });
        }
        if (d.agent !== undefined && d.agent !== cur.agent) {
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
      const emailNorm   = (d.email       || cur.email        || '').toLowerCase().trim();
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
          email_norm         = $34,
          phone_norm         = $35,
          social_norm        = $36,
          full_name_norm     = $37,
          companion_full_name_norm = $38
        WHERE record_id = $39
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
        d.isOts         !== undefined ? d.isOts         : cur.is_ots,
        d.isAdId        !== undefined ? d.isAdId        : cur.is_ad_id,
        d.isCompanion   !== undefined ? d.isCompanion   : cur.is_companion,
        d.isHighPriority !== undefined ? d.isHighPriority : cur.is_high_priority,
        emailNorm, phoneNorm, socialNorm, fullName, companionFN,
        recordId
      ]);

      res.json({ success: true, message: 'Booking updated successfully', recordId, cancellationTime });
    } catch (err) {
      console.error('Update booking error:', err);
      res.status(500).json({ error: 'Failed to update booking', details: err.message });
    }
  }

  // ── updateValidation ───────────────────────────────────────────────────────
  // PATCH /bookings/:rowNumber/validation  (rowNumber is record_id)
  async updateValidation(req, res) {
    try {
      if (req.user?.role !== 'Admin') {
        return res.status(403).json({ error: 'Only admins can set validation flags' });
      }

      const recordId         = req.params.rowNumber;
      const { cancelValidation, underageValidation } = req.body;

      const { rowCount } = await pool.query(
        `UPDATE bookings SET cancel_validation = $1, underage_cancellation = $2 WHERE record_id = $3`,
        [cancelValidation ? true : false, underageValidation ? true : false, recordId]
      );

      if (!rowCount) return res.status(404).json({ error: 'Booking not found' });

      res.json({ success: true, recordId, cancelValidation, underageValidation });
    } catch (err) {
      console.error('updateValidation error:', err);
      res.status(500).json({ error: 'Failed to update validation flags' });
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
        SELECT branch, booking_status, appointment_date, created_at, total_price,
               cancellation_time, underage_cancellation
        FROM bookings
        WHERE record_status != 'DELETED'
          AND (
            DATE(created_at) = CURRENT_DATE
            OR appointment_date = CURRENT_DATE + 1
            OR (appointment_date > CURRENT_DATE + 1 AND appointment_date <= CURRENT_DATE + 7)
            OR (LOWER(booking_status) LIKE '%cancel%')
            OR (appointment_date = CURRENT_DATE AND LOWER(booking_status) IN ('arrived & bought','arrived not potential'))
          )
      `);

      const today    = new Date(); today.setHours(0,0,0,0);
      const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
      const d7End    = new Date(today); d7End.setDate(today.getDate() + 7);
      const d7After  = new Date(tomorrow); d7After.setDate(tomorrow.getDate() + 1);

      const rpts = {
        otsBookings:           { total: 0, revenue: 0, count: 0, byBranch: {} },
        overallBookings:       { total: 0, revenue: 0, count: 0, byBranch: {} },
        bookedTomorrow:        { byBranch: {} },
        bookedNext7Days:       { byBranch: {} },
        cancellations:         { total: 0, revenue: 0, count: 0, byBranch: {} },
        overallBookingsTomorrow: { total: 0, revenue: 0, count: 0 },
        arrivalsToday:         { count: 0, byBranch: {}, byStatus: { 'Arrived & bought': 0, 'Arrived not potential': 0 } }
      };

      const inc = (map, branch, revenue = 0) => {
        if (!map[branch]) map[branch] = { count: 0, revenue: 0 };
        map[branch].count++;
        map[branch].revenue += revenue;
      };

      for (const r of rows) {
        const branch  = r.branch || 'Unknown';
        const status  = (r.booking_status || '').toLowerCase();
        const appt    = r.appointment_date ? new Date(r.appointment_date) : null;
        const price   = parseFloat(r.total_price) || 0;
        const created = r.created_at ? new Date(r.created_at) : null;

        if (appt) appt.setHours(0,0,0,0);
        const createdToday = created && new Date(created.getFullYear(), created.getMonth(), created.getDate()).getTime() === today.getTime();

        const isToday    = appt && appt.getTime() === today.getTime();
        const isTomorrow = appt && appt.getTime() === tomorrow.getTime();
        const isNext7    = appt && appt > today && appt <= d7End;
        const isD7After  = appt && appt >= d7After && appt <= d7End;

        // Section 1: OTS
        if (createdToday && isToday) {
          rpts.otsBookings.count++; rpts.otsBookings.revenue += price; rpts.otsBookings.total++;
          inc(rpts.otsBookings.byBranch, branch, price);
        }

        // Section 2: Overall
        if (createdToday && (isToday || isNext7)) {
          rpts.overallBookings.count++; rpts.overallBookings.revenue += price; rpts.overallBookings.total++;
          inc(rpts.overallBookings.byBranch, branch, price);
        }

        // Section 3: Booked Tomorrow
        if (createdToday && isTomorrow && status === 'scheduled') {
          inc(rpts.bookedTomorrow.byBranch, branch, price);
        }

        // Section 4: Booked Next 7 Days
        if (createdToday && isD7After && status === 'scheduled') {
          inc(rpts.bookedNext7Days.byBranch, branch, price);
        }

        // Section 5: Cancellations
        if (status.includes('cancel')) {
          const cancelDay = r.cancellation_time ? new Date(r.cancellation_time) : null;
          if (cancelDay) cancelDay.setHours(0,0,0,0);
          const cancelledToday = cancelDay && cancelDay.getTime() === today.getTime();
          if (cancelledToday || (!r.cancellation_time && createdToday)) {
            rpts.cancellations.count++; rpts.cancellations.revenue += price; rpts.cancellations.total++;
            inc(rpts.cancellations.byBranch, branch, price);
          }
        }

        // Section 6: Tomorrow Summary (any creation date)
        if (isTomorrow && status === 'scheduled') {
          rpts.overallBookingsTomorrow.count++;
          rpts.overallBookingsTomorrow.revenue += price;
          rpts.overallBookingsTomorrow.total++;
        }

        // Section 7: Arrivals Today
        if (isToday && !r.underage_cancellation &&
            (status === 'arrived & bought' || status === 'arrived not potential')) {
          rpts.arrivalsToday.count++;
          inc(rpts.arrivalsToday.byBranch, branch);
          const label = r.booking_status || '';
          rpts.arrivalsToday.byStatus[label] = (rpts.arrivalsToday.byStatus[label] || 0) + 1;
        }
      }

      res.json({ success: true, date: today.toISOString().split('T')[0], reports: rpts });
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
          AND DATE(created_at) = CURRENT_DATE
          AND appointment_date = CURRENT_DATE
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
          AND DATE(created_at) = CURRENT_DATE
          AND appointment_date >= CURRENT_DATE
          AND appointment_date <= CURRENT_DATE + 7
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
          AND DATE(created_at) = CURRENT_DATE
          AND appointment_date = CURRENT_DATE + 1
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
          AND DATE(created_at) = CURRENT_DATE
          AND appointment_date > CURRENT_DATE + 1
          AND appointment_date <= CURRENT_DATE + 7
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
            DATE(cancellation_time) = CURRENT_DATE
            OR (cancellation_time IS NULL AND DATE(created_at) = CURRENT_DATE)
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
          AND appointment_date = CURRENT_DATE
          AND LOWER(booking_status) IN ('arrived & bought','arrived not potential')
          AND underage_cancellation = FALSE
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
          AND appointment_date = CURRENT_DATE + 1
          AND LOWER(booking_status) = 'scheduled'
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
      const { rows } = await pool.query(`
        SELECT branch, booking_status, appointment_date, created_at, total_price,
               payment_mode, underage_cancellation, cancel_validation
        FROM bookings
        WHERE record_status != 'DELETED'
          AND cancel_validation = FALSE
          AND appointment_date >= CURRENT_DATE
          AND appointment_date <= CURRENT_DATE + 7
      `);

      const today    = new Date(); today.setHours(0,0,0,0);
      const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
      const d7End    = new Date(today); d7End.setDate(today.getDate() + 7);

      const schedToday = {}, arrToday = {}, schedTomorrow = {}, next7 = {}, otsMap = {};
      const payModesTomorrow = { Cash: 0, Debit: 0, Credit: 0 };
      const arrStatusMap = {};
      let otsT = 0, otsAddit = 0, otsRev = 0, additRev = 0;
      let arrOTS = 0, arrAddit = 0;
      let schedTomOTS = 0, schedTomAddit = 0;
      let otsNext7 = 0, additNext7 = 0;

      const inc = (map, branch, rev = 0) => {
        if (!map[branch]) map[branch] = { count: 0, revenue: 0 };
        map[branch].count++;
        map[branch].revenue += rev;
      };

      for (const r of rows) {
        const branch  = r.branch || 'Unknown';
        const status  = (r.booking_status || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const appt    = r.appointment_date ? new Date(r.appointment_date) : null;
        const created = r.created_at      ? new Date(r.created_at)       : null;
        const price   = parseFloat(r.total_price) || 0;
        const pm      = (r.payment_mode || '').trim();

        if (appt) appt.setHours(0,0,0,0);
        const createdToday = created && new Date(created.getFullYear(), created.getMonth(), created.getDate()).getTime() === today.getTime();
        const cancelled    = status.includes('cancel');
        const isArrived    = status === 'arrived & bought' || status === 'arrived not potential';

        if (!appt) continue;
        const isToday    = appt.getTime() === today.getTime();
        const isTomorrow = appt.getTime() === tomorrow.getTime();
        const inNext7    = appt > today && appt <= d7End;

        // Schedules today
        if (!cancelled && isToday) {
          inc(schedToday, branch, price);
          if (createdToday) { otsT++; otsRev += price; inc(otsMap, branch); }
          else              { otsAddit++; additRev += price; }
        }

        // Arrivals today
        if (!r.underage_cancellation && isArrived && isToday) {
          inc(arrToday, branch);
          const label = r.booking_status || '';
          arrStatusMap[label] = (arrStatusMap[label] || 0) + 1;
          if (createdToday) arrOTS++; else arrAddit++;
        }

        // Schedules tomorrow
        if (!cancelled && isTomorrow) {
          inc(schedTomorrow, branch, price);
          const mk = pm.toLowerCase().includes('cash') ? 'Cash'
                   : pm.toLowerCase().includes('debit') ? 'Debit'
                   : pm.toLowerCase().includes('credit') ? 'Credit' : null;
          if (mk) payModesTomorrow[mk]++;
          if (createdToday) { schedTomOTS++; inc(otsMap, branch); }
          else               schedTomAddit++;
        }

        // Next 7 days
        if (!cancelled && inNext7) {
          inc(next7, branch, price);
          if (createdToday) { otsNext7++; inc(otsMap, branch); }
          else               additNext7++;
        }
      }

      const sumCount = map => Object.values(map).reduce((s, b) => s + b.count, 0);

      return res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        data: {
          totalSchedulesToday:    { ots: otsT, additional: otsAddit, otsRevenue: otsRev, additionalRevenue: additRev, byBranch: schedToday, total: sumCount(schedToday) },
          totalArrivalsToday:     { otsArrivals: arrOTS, additionalArrivals: arrAddit, byBranch: arrToday, total: sumCount(arrToday), byStatus: arrStatusMap },
          totalSchedulesTomorrow: { otsTomorrow: schedTomOTS, additionalTomorrow: schedTomAddit, byBranch: schedTomorrow, total: sumCount(schedTomorrow) },
          paymentModesTomorrow,
          totalSchedulesNext7:    { otsNext7, additionalNext7, byBranch: next7, total: sumCount(next7) },
          totalOTS:               { byBranch: otsMap, total: sumCount(otsMap) }
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
      const validSections = ['schedules-today','arrivals','schedules-tomorrow','payment-tomorrow','next7days','ots'];
      if (!validSections.includes(section)) {
        return res.status(400).json({ error: 'Invalid section. Must be one of: ' + validSections.join(', ') });
      }

      let SQL = `
        SELECT first_name, last_name, branch, appointment_date, appointment_time,
               treatment, total_price, booking_status, phone, email, agent, payment_mode,
               created_at
        FROM bookings
        WHERE record_status != 'DELETED' AND cancel_validation = FALSE
      `;

      if (section === 'schedules-today') {
        SQL += ` AND appointment_date = CURRENT_DATE AND LOWER(booking_status) NOT LIKE '%cancel%'`;
      } else if (section === 'arrivals') {
        SQL += ` AND appointment_date = CURRENT_DATE AND LOWER(booking_status) IN ('arrived & bought','arrived not potential') AND underage_cancellation = FALSE`;
      } else if (section === 'schedules-tomorrow' || section === 'payment-tomorrow') {
        SQL += ` AND appointment_date = CURRENT_DATE + 1 AND LOWER(booking_status) NOT LIKE '%cancel%'`;
      } else if (section === 'next7days') {
        SQL += ` AND appointment_date > CURRENT_DATE AND appointment_date <= CURRENT_DATE + 7 AND LOWER(booking_status) NOT LIKE '%cancel%'`;
      } else if (section === 'ots') {
        SQL += ` AND DATE(created_at) = CURRENT_DATE AND appointment_date >= CURRENT_DATE AND appointment_date <= CURRENT_DATE + 7 AND LOWER(booking_status) NOT LIKE '%cancel%'`;
      }

      const { rows } = await pool.query(SQL);
      res.json({ success: true, bookings: rows.map(r => ({ ...mapDrilldown(r), paymentMode: r.payment_mode || '' })) });
    } catch (err) {
      console.error('getCCReportDrilldown error:', err);
      res.status(500).json({ error: 'Failed to fetch drill-down bookings' });
    }
  }
}

// ── Promo hunter check ───────────────────────────────────────────────────────

async function checkPromoHunter(firstName, lastName, email, phone, socialMedia, companionFirstName, companionLastName) {
  try {
    const fullName        = `${firstName} ${lastName}`.toLowerCase().trim();
    const companionFull   = companionFirstName && companionLastName
      ? `${companionFirstName} ${companionLastName}`.toLowerCase().trim() : '';
    const emailNorm       = (email       || '').toLowerCase().trim();
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

module.exports = new BookingController();
