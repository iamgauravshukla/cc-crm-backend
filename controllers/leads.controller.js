'use strict';
const pool = require('../db/pool');

const VALID_TYPES = ['call', 'booking'];

/**
 * POST /api/leads?type=call&center=<CENTER_NAME>
 * POST /api/leads?type=booking&center=<CENTER_NAME>
 * Public endpoint — called from wellness center website
 */
async function submitLead(req, res) {
  try {
    const type = (req.query.type || '').trim().toLowerCase();
    const center = (req.query.center || '').trim();

    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({
        error: `Query param ?type= is required. Valid values: ${VALID_TYPES.join(', ')}`
      });
    }
    if (!center) {
      return res.status(400).json({ error: 'Query param ?center= is required' });
    }

    if (type === 'call') return submitCallLead(req, res, center);
    return submitBookingLead(req, res, center);
  } catch (err) {
    console.error('Submit lead error:', err);
    return res.status(500).json({ error: 'Failed to submit lead' });
  }
}

async function submitCallLead(req, res, center) {
  try {
    const { fullname, email, phone, treatment, message } = req.body;

    if (!fullname || !email || !phone || !treatment) {
      return res.status(400).json({ error: 'fullname, email, phone, and treatment are required' });
    }

    await pool.query(
      `INSERT INTO call_leads (center, full_name, email, phone, treatment, message, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'New')`,
      [center, fullname.trim(), email.trim().toLowerCase(), phone.trim(), treatment.trim(), (message || '').trim()]
    );

    console.log(`✅ Call lead submitted — Center: ${center}, Name: ${fullname}`);
    return res.status(201).json({ success: true, message: 'Lead submitted successfully' });
  } catch (err) {
    console.error('Submit call lead error:', err);
    return res.status(500).json({ error: 'Failed to submit lead' });
  }
}

async function submitBookingLead(req, res, center) {
  try {
    const { fullname, email, phone, treatment, age, schedule, payment_method } = req.body;

    if (!fullname || !email || !phone || !treatment || !schedule) {
      return res.status(400).json({ error: 'fullname, email, phone, treatment, and schedule are required' });
    }

    await pool.query(
      `INSERT INTO booking_leads (center, full_name, email, phone, treatment, age, schedule, payment_method, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'New')`,
      [
        center,
        fullname.trim(),
        email.trim().toLowerCase(),
        phone.trim(),
        treatment.trim(),
        (age || '').toString().trim() || null,
        schedule.trim(),
        (payment_method || '').trim() || null
      ]
    );

    console.log(`✅ Booking lead submitted — Center: ${center}, Name: ${fullname}`);
    return res.status(201).json({ success: true, message: 'Lead submitted successfully' });
  } catch (err) {
    console.error('Submit booking lead error:', err);
    return res.status(500).json({ error: 'Failed to submit lead' });
  }
}

/**
 * GET /api/leads/call?center=ALL&search=&sort=latest
 */
async function getCallLeads(req, res) {
  try {
    const { center = 'ALL', search = '', sort = 'latest' } = req.query;

    const conditions = [];
    const params = [];
    let idx = 1;

    if (center && center.toUpperCase() !== 'ALL') {
      conditions.push(`LOWER(center) = $${idx++}`);
      params.push(center.toLowerCase());
    }

    if (search.trim()) {
      const q = `%${search.trim().toLowerCase()}%`;
      conditions.push(
        `(LOWER(full_name) LIKE $${idx} OR LOWER(email) LIKE $${idx} OR phone LIKE $${idx} OR LOWER(treatment) LIKE $${idx} OR LOWER(COALESCE(message,'')) LIKE $${idx})`
      );
      params.push(q);
      idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const order = sort === 'oldest' ? 'ASC' : 'DESC';

    const { rows } = await pool.query(
      `SELECT id, created_at, center, full_name, email, phone, treatment, message, status, feedback
       FROM call_leads ${where} ORDER BY created_at ${order}`,
      params
    );

    const data = rows.map(r => ({
      rowIndex: r.id,
      timestamp: r.created_at,
      center: r.center,
      fullname: r.full_name,
      email: r.email,
      phone: r.phone,
      treatment: r.treatment,
      message: r.message || '',
      status: r.status || 'New',
      feedback: r.feedback || ''
    }));

    return res.json({ success: true, data });
  } catch (err) {
    console.error('Get call leads error:', err);
    return res.status(500).json({ error: 'Failed to fetch leads' });
  }
}

/**
 * GET /api/leads/booking?center=ALL&search=&sort=latest
 */
async function getBookingLeads(req, res) {
  try {
    const { center = 'ALL', search = '', sort = 'latest' } = req.query;

    const conditions = [];
    const params = [];
    let idx = 1;

    if (center && center.toUpperCase() !== 'ALL') {
      conditions.push(`LOWER(center) = $${idx++}`);
      params.push(center.toLowerCase());
    }

    if (search.trim()) {
      const q = `%${search.trim().toLowerCase()}%`;
      conditions.push(
        `(LOWER(full_name) LIKE $${idx} OR LOWER(email) LIKE $${idx} OR phone LIKE $${idx} OR LOWER(treatment) LIKE $${idx})`
      );
      params.push(q);
      idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const order = sort === 'oldest' ? 'ASC' : 'DESC';

    const { rows } = await pool.query(
      `SELECT id, created_at, center, full_name, email, phone, treatment, age, schedule, payment_method, status, feedback
       FROM booking_leads ${where} ORDER BY created_at ${order}`,
      params
    );

    const data = rows.map(r => ({
      rowIndex: r.id,
      timestamp: r.created_at,
      center: r.center,
      fullname: r.full_name,
      email: r.email,
      phone: r.phone,
      treatment: r.treatment,
      age: r.age || '',
      schedule: r.schedule,
      paymentMethod: r.payment_method || '',
      status: r.status || 'New',
      feedback: r.feedback || ''
    }));

    return res.json({ success: true, data });
  } catch (err) {
    console.error('Get booking leads error:', err);
    return res.status(500).json({ error: 'Failed to fetch leads' });
  }
}

/**
 * GET /api/leads/centers
 */
async function getCenters(req, res) {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT center FROM call_leads WHERE center IS NOT NULL AND center != ''
      UNION
      SELECT DISTINCT center FROM booking_leads WHERE center IS NOT NULL AND center != ''
      ORDER BY center
    `);

    const centers = ['ALL', ...rows.map(r => r.center)];
    return res.json({ success: true, data: centers });
  } catch (err) {
    console.error('Get centers error:', err);
    return res.status(500).json({ error: 'Failed to fetch centers' });
  }
}

/**
 * PATCH /api/leads/:type/:rowIndex
 * rowIndex is the id (primary key) of the lead row
 */
async function updateLead(req, res) {
  try {
    const { type, rowIndex } = req.params;
    const { status, feedback } = req.body;
    const id = parseInt(rowIndex, 10);

    if (!['call', 'booking'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type. Must be call or booking.' });
    }
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Invalid rowIndex.' });
    }

    const table = type === 'call' ? 'call_leads' : 'booking_leads';

    const setClauses = [];
    const params = [];
    let idx = 1;

    if (status !== undefined) { setClauses.push(`status = $${idx++}`); params.push(status); }
    if (feedback !== undefined) { setClauses.push(`feedback = $${idx++}`); params.push(feedback); }

    if (!setClauses.length) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    params.push(id);
    const { rowCount } = await pool.query(
      `UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = $${idx}`,
      params
    );

    if (!rowCount) return res.status(404).json({ error: 'Lead not found' });

    return res.json({ success: true, message: 'Lead updated successfully' });
  } catch (err) {
    console.error('Update lead error:', err);
    return res.status(500).json({ error: 'Failed to update lead' });
  }
}

module.exports = { submitLead, getCallLeads, getBookingLeads, getCenters, updateLead };
