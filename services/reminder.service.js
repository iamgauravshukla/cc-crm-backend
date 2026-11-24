'use strict';
// Reminder sending + the daily scheduler for the Session Tracker.
// Providers are optional: with no env keys set, sms/email reminders stay
// Pending (shown as "waiting for provider" in the UI) and only call tasks run.
const pool = require('../db/pool');

const phFmt   = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' });
const phToday = () => phFmt.format(Date.now());
const phHour  = () => parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', hour12: false }).format(Date.now()), 10);

function providerConfigured(channel) {
  if (channel === 'sms')   return !!process.env.SEMAPHORE_API_KEY;
  if (channel === 'email') return !!(process.env.SMTP_HOST || process.env.RESEND_API_KEY);
  return false;
}

// Single send. Wire Semaphore / SMTP here when the accounts exist — the queue,
// statuses and UI are already built around this interface.
async function sendReminder({ channel, dest, session }) {
  if (!providerConfigured(channel)) return { ok: false, error: 'provider not configured' };
  try {
    if (channel === 'sms') {
      const axios = require('axios');
      const msg = `Hi! Reminder: your ${session.treatment || 'treatment'} session is on ${session.scheduled_date}${session.scheduled_time ? ' at ' + session.scheduled_time : ''}. See you! — Ageless Beauty`;
      const r = await axios.post('https://api.semaphore.co/api/v4/messages', {
        apikey: process.env.SEMAPHORE_API_KEY,
        number: dest,
        message: msg,
        sendername: process.env.SEMAPHORE_SENDER || 'SEMAPHORE',
      }, { timeout: 15000 });
      return r.status < 300 ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
    }
    // Email transport to be wired when the sender address is decided.
    return { ok: false, error: 'email transport not implemented yet' };
  } catch (err) {
    return { ok: false, error: err.response?.data?.message || err.message };
  }
}

// Daily pass: (1) make sure every active session due in 3 or 1 days has its
// reminder rows (catch-up for rows created before the dates were in range),
// (2) send due Pending sms/email reminders when a provider is connected.
async function processDailyReminders() {
  const today = phToday();
  try {
    // 1. Catch-up generation (call always; sms/email when contact exists and not opted out)
    await pool.query(`
      INSERT INTO package_reminders (session_id, channel, scheduled_for, to_dest, template_key)
      SELECT s.id, ch.channel,
             s.scheduled_date - ch.lead,
             CASE ch.channel WHEN 'email' THEN p.email ELSE p.phone END,
             'T-' || ch.lead
      FROM package_sessions s
      JOIN treatment_packages p ON p.id = s.package_id
      CROSS JOIN (VALUES ('call', 1), ('sms', 3), ('sms', 1), ('email', 3), ('email', 1)) AS ch(channel, lead)
      WHERE p.status = 'Active'
        AND s.status IN ('Upcoming', 'Scheduled')
        AND s.scheduled_date - ch.lead >= $1::date
        AND s.scheduled_date - ch.lead <= $1::date + 3
        AND (ch.channel = 'call'
             OR (NOT p.opt_out AND
                 ((ch.channel = 'sms' AND NULLIF(p.phone, '') IS NOT NULL) OR
                  (ch.channel = 'email' AND NULLIF(p.email, '') IS NOT NULL))))
      ON CONFLICT (session_id, channel, scheduled_for) DO NOTHING
    `, [today]);

    // 2. Send what is due, where a provider exists
    for (const channel of ['sms', 'email']) {
      if (!providerConfigured(channel)) continue;
      const { rows } = await pool.query(`
        SELECT r.id, r.to_dest, s.scheduled_date, s.scheduled_time, p.treatment
        FROM package_reminders r
        JOIN package_sessions s ON s.id = r.session_id
        JOIN treatment_packages p ON p.id = s.package_id
        WHERE r.channel = $1 AND r.status = 'Pending' AND r.scheduled_for <= $2 AND p.status = 'Active'
        LIMIT 200
      `, [channel, today]);
      for (const r of rows) {
        const result = await sendReminder({ channel, dest: r.to_dest, session: r });
        await pool.query(
          `UPDATE package_reminders SET status = $1, sent_at = $2, error = $3 WHERE id = $4`,
          [result.ok ? 'Sent' : 'Failed', result.ok ? new Date() : null, result.ok ? null : result.error, r.id]
        );
      }
    }
    console.log(`[reminders] daily pass done for ${today}`);
  } catch (err) {
    console.error('[reminders] daily pass failed:', err.message);
  }
}

// Lightweight scheduler — no cron dependency. Checks every 30 minutes; runs the
// daily pass once per Manila day at/after 09:00, and catches up on boot.
let lastRunDate = null;
function startScheduler() {
  const tick = async () => {
    const today = phToday();
    if (lastRunDate !== today && phHour() >= 9) {
      lastRunDate = today;
      await processDailyReminders();
    }
  };
  setTimeout(tick, 30 * 1000);               // catch-up shortly after boot
  setInterval(tick, 30 * 60 * 1000);          // then every 30 minutes
  console.log('[reminders] scheduler armed (daily at 09:00 Asia/Manila)');
}

module.exports = { providerConfigured, sendReminder, processDailyReminders, startScheduler };
