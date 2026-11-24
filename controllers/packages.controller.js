'use strict';
const Joi  = require('joi');
const pool = require('../db/pool');

// ── Helpers ───────────────────────────────────────────────────────────────────
const phFmt   = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' });
const phToday = () => phFmt.format(Date.now());
const addDays = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
};
const normPhone = (p) => String(p || '').replace(/\D/g, '');

const packageSchema = Joi.object({
  firstName:     Joi.string().trim().min(1).max(120).required(),
  lastName:      Joi.string().trim().allow('').max(120).default(''),
  phone:         Joi.string().trim().allow('').max(40).default(''),
  email:         Joi.string().trim().allow('').max(200).default(''),
  branch:        Joi.string().trim().min(1).max(80).required(),
  treatment:     Joi.string().trim().min(1).max(120).required(),
  totalSessions: Joi.number().integer().min(1).max(100).required(),
  gapDays:       Joi.number().integer().min(1).max(365).default(14),
  priceTotal:    Joi.number().min(0).allow(null).default(null),
  startDate:     Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  startTime:     Joi.string().trim().allow('').max(20).default(''),
  expiryDate:    Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow('', null).default(null),
  notes:         Joi.string().trim().allow('').max(2000).default(''),
  sourceBookingId: Joi.string().trim().allow('', null).default(null),
});

// Create/refresh the T-3 and T-1 reminders for a session (plus the call task).
// Past dates are skipped; the unique index makes this idempotent.
async function scheduleReminders(client, session, pkg) {
  if (!session.scheduled_date) return;
  const dateStr = typeof session.scheduled_date === 'string'
    ? session.scheduled_date
    : session.scheduled_date.toISOString().split('T')[0];
  const today = phToday();
  const targets = [
    { date: addDays(dateStr, -3), template: 'T-3' },
    { date: addDays(dateStr, -1), template: 'T-1' },
  ].filter(t => t.date >= today);

  for (const t of targets) {
    const rows = [{ channel: 'call', dest: pkg.phone || '' }];
    if (!pkg.opt_out) {
      if (pkg.phone) rows.push({ channel: 'sms',   dest: pkg.phone });
      if (pkg.email) rows.push({ channel: 'email', dest: pkg.email });
    }
    for (const r of rows) {
      await client.query(
        `INSERT INTO package_reminders (session_id, channel, scheduled_for, to_dest, template_key)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (session_id, channel, scheduled_for) DO NOTHING`,
        [session.id, r.channel, t.date, r.dest, t.template]
      );
    }
  }
}

async function cancelPendingReminders(client, sessionId) {
  await client.query(
    `UPDATE package_reminders SET status = 'Cancelled' WHERE session_id = $1 AND status = 'Pending'`,
    [sessionId]
  );
}

const mapPackage = (r) => ({
  id: r.id,
  packageCode: r.package_code,
  firstName: r.first_name,
  lastName: r.last_name,
  phone: r.phone || '',
  email: r.email || '',
  branch: r.branch,
  treatment: r.treatment,
  totalSessions: r.total_sessions,
  gapDays: r.gap_days,
  priceTotal: r.price_total != null ? parseFloat(r.price_total) : null,
  status: r.status,
  startDate: r.start_date,
  expiryDate: r.expiry_date,
  notes: r.notes || '',
  optOut: r.opt_out,
  sourceBookingId: r.source_booking_id,
  createdByName: r.created_by_name || '',
  createdAt: r.created_at,
});

const mapSession = (r) => ({
  id: r.id,
  sessionNo: r.session_no,
  scheduledDate: r.scheduled_date,
  scheduledTime: r.scheduled_time || '',
  status: r.status,
  doneAt: r.done_at,
  bookingId: r.booking_id,
  notes: r.notes || '',
});

// ── Create ────────────────────────────────────────────────────────────────────
// POST /api/packages
async function createPackage(req, res) {
  const client = await pool.connect();
  try {
    const { error, value: d } = packageSchema.validate(req.body || {});
    if (error) return res.status(400).json({ error: error.details[0].message });

    const code = `PKG-${phToday().replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    await client.query('BEGIN');
    const { rows: pkgRows } = await client.query(
      `INSERT INTO treatment_packages
        (package_code, first_name, last_name, phone, phone_norm, email, branch, treatment,
         total_sessions, gap_days, price_total, start_date, expiry_date, notes,
         source_booking_id, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [code, d.firstName, d.lastName, d.phone || null, normPhone(d.phone) || null,
       d.email || null, d.branch, d.treatment, d.totalSessions, d.gapDays,
       d.priceTotal, d.startDate, d.expiryDate || null, d.notes || null,
       d.sourceBookingId || null, req.user?.userId || null, req.user?.name || req.user?.email || null]
    );
    const pkg = pkgRows[0];

    // Session 1 starts the course (a known date → Scheduled); the rest are planned.
    const sessions = [];
    for (let n = 1; n <= d.totalSessions; n++) {
      const date = addDays(d.startDate, (n - 1) * d.gapDays);
      const { rows } = await client.query(
        `INSERT INTO package_sessions (package_id, session_no, scheduled_date, scheduled_time, status)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [pkg.id, n, date, n === 1 ? (d.startTime || null) : null, n === 1 ? 'Scheduled' : 'Upcoming']
      );
      sessions.push(rows[0]);
    }
    await scheduleReminders(client, sessions[0], pkg);
    await client.query('COMMIT');

    res.status(201).json({ success: true, package: mapPackage(pkg), sessions: sessions.map(mapSession) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('createPackage error:', err);
    res.status(500).json({ error: 'Failed to create package' });
  } finally {
    client.release();
  }
}

// ── List ──────────────────────────────────────────────────────────────────────
// GET /api/packages?status=&branch=&treatment=&search=&due=&from=&to=
async function listPackages(req, res) {
  try {
    const { status = '', branch = '', treatment = '', search = '', due = '', from = '', to = '' } = req.query;
    const today = phToday();

    const conds = [];
    const params = [];
    let i = 1;
    if (status && status !== 'All')    { conds.push(`p.status = $${i++}`); params.push(status); }
    if (branch && branch !== 'All')    { conds.push(`LOWER(p.branch) = $${i++}`); params.push(branch.toLowerCase()); }
    if (treatment && treatment !== 'All') { conds.push(`LOWER(p.treatment) = $${i++}`); params.push(treatment.toLowerCase()); }
    if (search.trim()) {
      const q = `%${search.trim().toLowerCase()}%`;
      conds.push(`(LOWER(p.first_name || ' ' || p.last_name) LIKE $${i} OR p.phone_norm LIKE $${i} OR LOWER(COALESCE(p.email,'')) LIKE $${i} OR LOWER(p.package_code) LIKE $${i})`);
      params.push(q); i++;
    }
    const WHERE = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT p.*,
              (SELECT COUNT(*)::int FROM package_sessions s WHERE s.package_id = p.id AND s.status = 'Done') AS done_count,
              ns.id AS next_session_id, ns.session_no AS next_session_no,
              ns.scheduled_date AS next_date, ns.scheduled_time AS next_time, ns.status AS next_status,
              (SELECT MAX(cl.created_at) FROM package_contact_logs cl WHERE cl.package_id = p.id) AS last_contact,
              EXISTS (SELECT 1 FROM package_reminders r JOIN package_sessions s2 ON s2.id = r.session_id
                      WHERE s2.package_id = p.id AND r.channel = 'call' AND r.status = 'Pending'
                        AND r.scheduled_for <= $${i}) AS needs_call
       FROM treatment_packages p
       LEFT JOIN LATERAL (
         SELECT * FROM package_sessions s
         WHERE s.package_id = p.id AND s.status IN ('Upcoming', 'Scheduled', 'No Show')
         ORDER BY s.session_no LIMIT 1
       ) ns ON TRUE
       ${WHERE}
       ORDER BY ns.scheduled_date ASC NULLS LAST, p.created_at DESC
       LIMIT 500`,
      [...params, today]
    );

    let data = rows.map(r => ({
      ...mapPackage(r),
      doneCount: r.done_count,
      nextSessionId: r.next_session_id,
      nextSessionNo: r.next_session_no,
      nextDate: r.next_date,
      nextTime: r.next_time || '',
      nextStatus: r.next_status,
      lastContact: r.last_contact,
      needsCall: r.needs_call,
    }));

    // Due filters run on the computed next-session date
    if (due === 'today')        data = data.filter(p => p.nextDate === today);
    else if (due === 'overdue') data = data.filter(p => p.nextDate && p.nextDate < today && p.status === 'Active');
    else if (due === 'week')    data = data.filter(p => p.nextDate && p.nextDate >= today && p.nextDate <= addDays(today, 7));
    else if (due === 'needs-call') data = data.filter(p => p.needsCall || p.nextStatus === 'No Show');
    if (from) data = data.filter(p => p.nextDate && p.nextDate >= from);
    if (to)   data = data.filter(p => p.nextDate && p.nextDate <= to);

    res.json({ success: true, today, packages: data });
  } catch (err) {
    console.error('listPackages error:', err);
    res.status(500).json({ error: 'Failed to fetch packages' });
  }
}

// ── Stats (KPI strip) ─────────────────────────────────────────────────────────
// GET /api/packages/stats
async function getStats(req, res) {
  try {
    const today = phToday();
    const { rows } = await pool.query(
      `SELECT
        (SELECT COUNT(*)::int FROM package_sessions s JOIN treatment_packages p ON p.id = s.package_id
          WHERE p.status = 'Active' AND s.status IN ('Upcoming','Scheduled') AND s.scheduled_date = $1) AS due_today,
        (SELECT COUNT(*)::int FROM package_sessions s JOIN treatment_packages p ON p.id = s.package_id
          WHERE p.status = 'Active' AND s.status IN ('Upcoming','Scheduled','No Show') AND s.scheduled_date < $1) AS overdue,
        (SELECT COUNT(DISTINCT s.package_id)::int FROM package_reminders r
          JOIN package_sessions s ON s.id = r.session_id JOIN treatment_packages p ON p.id = s.package_id
          WHERE p.status = 'Active' AND r.channel = 'call' AND r.status = 'Pending' AND r.scheduled_for <= $1) AS needs_call,
        (SELECT COUNT(*)::int FROM treatment_packages WHERE status = 'Active') AS active,
        (SELECT COUNT(*)::int FROM treatment_packages
          WHERE status = 'Completed' AND date_trunc('month', updated_at AT TIME ZONE 'Asia/Manila') = date_trunc('month', ($1::date)::timestamp)) AS completed_month`,
      [today]
    );
    const s = rows[0];
    res.json({ success: true, stats: {
      dueToday: s.due_today, overdue: s.overdue, needsCall: s.needs_call,
      active: s.active, completedThisMonth: s.completed_month,
    }});
  } catch (err) {
    console.error('getStats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
}

// ── Detail ────────────────────────────────────────────────────────────────────
// GET /api/packages/:id
async function getPackage(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows: pkgRows } = await pool.query(`SELECT * FROM treatment_packages WHERE id = $1`, [id]);
    if (!pkgRows.length) return res.status(404).json({ error: 'Package not found' });

    const pkg = pkgRows[0];
    const [{ rows: sessions }, { rows: reminders }, { rows: logs }, { rows: others }] = await Promise.all([
      pool.query(`SELECT * FROM package_sessions WHERE package_id = $1 ORDER BY session_no`, [id]),
      pool.query(`SELECT r.* FROM package_reminders r JOIN package_sessions s ON s.id = r.session_id
                  WHERE s.package_id = $1 ORDER BY r.scheduled_for, r.channel`, [id]),
      pool.query(`SELECT * FROM package_contact_logs WHERE package_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
      // Every other package this customer owns (matched by normalized phone) —
      // a customer can hold several packages, each with its own session count.
      pkg.phone_norm
        ? pool.query(
            `SELECT p.id, p.package_code, p.treatment, p.branch, p.status, p.total_sessions,
                    (SELECT COUNT(*)::int FROM package_sessions s WHERE s.package_id = p.id AND s.status = 'Done') AS done_count
             FROM treatment_packages p
             WHERE p.phone_norm = $1 AND p.id <> $2
             ORDER BY p.created_at DESC`, [pkg.phone_norm, id])
        : Promise.resolve({ rows: [] }),
    ]);

    res.json({
      success: true,
      package: mapPackage(pkg),
      otherPackages: others.map(o => ({
        id: o.id, packageCode: o.package_code, treatment: o.treatment, branch: o.branch,
        status: o.status, totalSessions: o.total_sessions, doneCount: o.done_count,
      })),
      sessions: sessions.map(mapSession),
      reminders: reminders.map(r => ({
        id: r.id, sessionId: r.session_id, channel: r.channel, scheduledFor: r.scheduled_for,
        status: r.status, toDest: r.to_dest || '', templateKey: r.template_key || '', sentAt: r.sent_at, error: r.error || '',
      })),
      contactLogs: logs.map(l => ({
        id: l.id, sessionId: l.session_id, channel: l.channel, outcome: l.outcome,
        notes: l.notes || '', loggedByName: l.logged_by_name || '', createdAt: l.created_at,
      })),
    });
  } catch (err) {
    console.error('getPackage error:', err);
    res.status(500).json({ error: 'Failed to fetch package' });
  }
}

// ── Update package ────────────────────────────────────────────────────────────
// PATCH /api/packages/:id  { status?, gapDays?, notes?, optOut?, expiryDate? }
async function updatePackage(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const { status, gapDays, notes, optOut, expiryDate } = req.body || {};
    const ALLOWED_STATUS = ['Active', 'Completed', 'Paused', 'Cancelled', 'Expired'];

    const sets = [], vals = [];
    if (status !== undefined) {
      if (!ALLOWED_STATUS.includes(status)) return res.status(400).json({ error: `status must be one of ${ALLOWED_STATUS.join(', ')}` });
      if (['Cancelled', 'Paused', 'Expired'].includes(status) && req.user?.role !== 'Admin') {
        return res.status(403).json({ error: 'Only admins can pause or cancel a package' });
      }
      vals.push(status); sets.push(`status = $${vals.length}`);
    }
    if (gapDays !== undefined) {
      const g = parseInt(gapDays, 10);
      if (!(g >= 1 && g <= 365)) return res.status(400).json({ error: 'gapDays must be 1–365' });
      vals.push(g); sets.push(`gap_days = $${vals.length}`);
    }
    if (notes !== undefined)   { vals.push(notes || null); sets.push(`notes = $${vals.length}`); }
    if (optOut !== undefined)  { vals.push(optOut === true); sets.push(`opt_out = $${vals.length}`); }
    if (expiryDate !== undefined) { vals.push(expiryDate || null); sets.push(`expiry_date = $${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    sets.push(`updated_at = NOW()`);
    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE treatment_packages SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Package not found' });

    // Pausing/cancelling silences every pending reminder
    if (['Paused', 'Cancelled', 'Expired'].includes(status)) {
      await pool.query(
        `UPDATE package_reminders SET status = 'Cancelled'
         WHERE status = 'Pending' AND session_id IN (SELECT id FROM package_sessions WHERE package_id = $1)`,
        [id]
      );
    }
    res.json({ success: true, package: mapPackage(rows[0]) });
  } catch (err) {
    console.error('updatePackage error:', err);
    res.status(500).json({ error: 'Failed to update package' });
  }
}

// ── Session actions ───────────────────────────────────────────────────────────
async function loadSession(client, packageId, sessionId) {
  const { rows } = await client.query(
    `SELECT s.*, p.gap_days, p.phone, p.email, p.opt_out, p.total_sessions, p.treatment, p.status AS pkg_status
     FROM package_sessions s JOIN treatment_packages p ON p.id = s.package_id
     WHERE s.id = $1 AND s.package_id = $2`,
    [sessionId, packageId]
  );
  return rows[0] || null;
}

// POST /api/packages/:id/sessions/:sid/done
// Marks the visit done and re-anchors every later planned session on the real
// visit date + gap, so the schedule follows reality instead of the original plan.
async function markSessionDone(req, res) {
  const client = await pool.connect();
  try {
    const packageId = parseInt(req.params.id, 10);
    const sessionId = parseInt(req.params.sid, 10);
    await client.query('BEGIN');
    const s = await loadSession(client, packageId, sessionId);
    if (!s) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Session not found' }); }
    if (s.status === 'Done') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Session is already done' }); }

    const doneDate = phToday();
    await client.query(
      `UPDATE package_sessions SET status = 'Done', done_at = NOW() WHERE id = $1`, [sessionId]
    );
    await cancelPendingReminders(client, sessionId);

    // Re-anchor later sessions that are still in the planned state
    const { rows: later } = await client.query(
      `SELECT id, session_no FROM package_sessions
       WHERE package_id = $1 AND session_no > $2 AND status = 'Upcoming' ORDER BY session_no`,
      [packageId, s.session_no]
    );
    let offset = 1;
    for (const l of later) {
      await client.query(
        `UPDATE package_sessions SET scheduled_date = $1 WHERE id = $2`,
        [addDays(doneDate, s.gap_days * offset), l.id]
      );
      offset++;
    }

    // Next session (any state) gets its reminders refreshed
    const { rows: nextRows } = await client.query(
      `SELECT * FROM package_sessions WHERE package_id = $1 AND status IN ('Upcoming','Scheduled')
       ORDER BY session_no LIMIT 1`, [packageId]
    );
    if (nextRows.length) {
      await scheduleReminders(client, nextRows[0], { phone: s.phone, email: s.email, opt_out: s.opt_out });
    } else {
      // No sessions left → package completed
      await client.query(
        `UPDATE treatment_packages SET status = 'Completed', updated_at = NOW()
         WHERE id = $1 AND NOT EXISTS (
           SELECT 1 FROM package_sessions WHERE package_id = $1 AND status IN ('Upcoming','Scheduled','No Show'))`,
        [packageId]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, doneDate, completed: !nextRows.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('markSessionDone error:', err);
    res.status(500).json({ error: 'Failed to mark session done' });
  } finally {
    client.release();
  }
}

// POST /api/packages/:id/sessions/:sid/schedule  { date, time }
// Sets or moves the appointment (confirm a planned date, or reschedule).
async function scheduleSession(req, res) {
  const client = await pool.connect();
  try {
    const packageId = parseInt(req.params.id, 10);
    const sessionId = parseInt(req.params.sid, 10);
    const { date, time } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });

    await client.query('BEGIN');
    const s = await loadSession(client, packageId, sessionId);
    if (!s) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Session not found' }); }
    if (s.status === 'Done') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Session is already done' }); }

    const { rows } = await client.query(
      `UPDATE package_sessions SET status = 'Scheduled', scheduled_date = $1, scheduled_time = $2
       WHERE id = $3 RETURNING *`,
      [date, time || null, sessionId]
    );
    await cancelPendingReminders(client, sessionId);
    await scheduleReminders(client, rows[0], { phone: s.phone, email: s.email, opt_out: s.opt_out });
    await client.query('COMMIT');
    res.json({ success: true, session: mapSession(rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('scheduleSession error:', err);
    res.status(500).json({ error: 'Failed to schedule session' });
  } finally {
    client.release();
  }
}

// POST /api/packages/:id/sessions/:sid/no-show
// Flags the miss and opens a call task for today.
async function markNoShow(req, res) {
  const client = await pool.connect();
  try {
    const packageId = parseInt(req.params.id, 10);
    const sessionId = parseInt(req.params.sid, 10);
    await client.query('BEGIN');
    const s = await loadSession(client, packageId, sessionId);
    if (!s) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Session not found' }); }
    if (s.status === 'Done') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Session is already done' }); }

    await client.query(`UPDATE package_sessions SET status = 'No Show' WHERE id = $1`, [sessionId]);
    await client.query(
      `UPDATE package_reminders SET status = 'Cancelled'
       WHERE session_id = $1 AND status = 'Pending' AND channel IN ('sms','email')`, [sessionId]
    );
    await client.query(
      `INSERT INTO package_reminders (session_id, channel, scheduled_for, to_dest, template_key)
       VALUES ($1, 'call', $2, $3, 'no-show')
       ON CONFLICT (session_id, channel, scheduled_for) DO NOTHING`,
      [sessionId, phToday(), s.phone || '']
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('markNoShow error:', err);
    res.status(500).json({ error: 'Failed to mark no-show' });
  } finally {
    client.release();
  }
}

// ── Contact logs (“mark call”) ───────────────────────────────────────────────
// POST /api/packages/:id/contact-logs  { sessionId?, channel, outcome, notes }
async function addContactLog(req, res) {
  try {
    const packageId = parseInt(req.params.id, 10);
    const { sessionId = null, channel = 'call', outcome, notes = '' } = req.body || {};
    const OUTCOMES = ['Answered', 'No answer', 'Confirmed', 'Rescheduled', 'Not interested', 'Other'];
    if (!OUTCOMES.includes(outcome)) return res.status(400).json({ error: `outcome must be one of ${OUTCOMES.join(', ')}` });
    if (!['call', 'sms', 'email'].includes(channel)) return res.status(400).json({ error: 'Invalid channel' });

    const { rows } = await pool.query(
      `INSERT INTO package_contact_logs (package_id, session_id, channel, outcome, notes, logged_by, logged_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [packageId, sessionId, channel, outcome, notes || null,
       req.user?.userId || null, req.user?.name || req.user?.email || null]
    );

    // Logging a call settles that session's open call tasks
    if (channel === 'call') {
      if (sessionId) {
        await pool.query(
          `UPDATE package_reminders SET status = 'Done' WHERE session_id = $1 AND channel = 'call' AND status = 'Pending'`,
          [sessionId]
        );
      } else {
        await pool.query(
          `UPDATE package_reminders SET status = 'Done'
           WHERE channel = 'call' AND status = 'Pending'
             AND session_id IN (SELECT id FROM package_sessions WHERE package_id = $1)`,
          [packageId]
        );
      }
    }

    const l = rows[0];
    res.status(201).json({ success: true, log: {
      id: l.id, sessionId: l.session_id, channel: l.channel, outcome: l.outcome,
      notes: l.notes || '', loggedByName: l.logged_by_name || '', createdAt: l.created_at,
    }});
  } catch (err) {
    console.error('addContactLog error:', err);
    res.status(500).json({ error: 'Failed to log contact' });
  }
}

// ── Remind now ────────────────────────────────────────────────────────────────
// POST /api/packages/:id/sessions/:sid/remind  { channel: 'sms' | 'email' }
async function remindNow(req, res) {
  try {
    const packageId = parseInt(req.params.id, 10);
    const sessionId = parseInt(req.params.sid, 10);
    const { channel } = req.body || {};
    if (!['sms', 'email'].includes(channel)) return res.status(400).json({ error: 'channel must be sms or email' });

    const s = await loadSession(pool, packageId, sessionId);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    const dest = channel === 'sms' ? s.phone : s.email;
    if (!dest) return res.status(400).json({ error: `This customer has no ${channel === 'sms' ? 'phone number' : 'email address'} on the package` });
    if (s.opt_out) return res.status(400).json({ error: 'This customer is opted out of reminders' });

    const { sendReminder, providerConfigured } = require('../services/reminder.service');
    if (!providerConfigured(channel)) {
      return res.status(503).json({ error: channel === 'sms'
        ? 'SMS provider not connected yet (Semaphore pending) — reminder not sent'
        : 'Email provider not configured yet — reminder not sent' });
    }
    const result = await sendReminder({ channel, dest, session: s });
    await pool.query(
      `INSERT INTO package_reminders (session_id, channel, scheduled_for, to_dest, template_key, status, sent_at, error)
       VALUES ($1,$2,$3,$4,'manual',$5,$6,$7)
       ON CONFLICT (session_id, channel, scheduled_for)
       DO UPDATE SET status = EXCLUDED.status, sent_at = EXCLUDED.sent_at, error = EXCLUDED.error`,
      [sessionId, channel, phToday(), dest,
       result.ok ? 'Sent' : 'Failed', result.ok ? new Date() : null, result.ok ? null : result.error]
    );
    if (!result.ok) return res.status(502).json({ error: `Send failed: ${result.error}` });
    res.json({ success: true, message: `${channel.toUpperCase()} sent to ${dest}` });
  } catch (err) {
    console.error('remindNow error:', err);
    res.status(500).json({ error: 'Failed to send reminder' });
  }
}

module.exports = {
  createPackage, listPackages, getStats, getPackage, updatePackage,
  markSessionDone, scheduleSession, markNoShow, addContactLog, remindNow,
};
