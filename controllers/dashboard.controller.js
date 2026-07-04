'use strict';
const pool = require('../db/pool');

const COMPLETED_STATUSES = ["'arrived not potential'", "'arrived & bought'", "'comeback & bought'"];
const COMPLETED_SQL = `LOWER(booking_status) IN (${COMPLETED_STATUSES.join(',')})`;
const ARRIVAL_SQL   = `LOWER(booking_status) IN ('arrived not potential', 'arrived & bought')`;

/**
 * GET /api/dashboard/overview
 * Today's bookings + yesterday comparison + KPIs
 */
async function getDashboardOverview(req, res) {
  try {
    // Today's and yesterday's bookings (by creation timestamp)
    const { rows } = await pool.query(`
      SELECT
        record_id,
        created_at,
        branch,
        booking_status   AS status,
        appointment_date AS date,
        appointment_time AS time,
        first_name,
        last_name,
        age,
        gender,
        phone,
        email,
        social_media,
        treatment,
        area,
        freebie,
        total_price,
        payment_mode,
        agent,
        booking_details,
        ad_interacted,
        companion_first_name,
        companion_last_name,
        companion_age,
        companion_gender,
        companion_freebie,
        companion_treatment,
        promo_hunter_status,
        match_reason,
        matched_source,
        matched_row
      FROM bookings
      WHERE DATE(created_at) >= CURRENT_DATE - INTERVAL '1 day'
        AND record_status != 'DELETED'
      ORDER BY created_at DESC
    `);

    const todayBookings = [];
    const yesterdayBookings = [];

    const todayStr = new Date().toISOString().split('T')[0];
    const yestStr  = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    for (const r of rows) {
      const day = r.created_at ? new Date(r.created_at).toISOString().split('T')[0] : null;
      const mapped = mapBooking(r);
      if (day === todayStr)     todayBookings.push(mapped);
      else if (day === yestStr) yesterdayBookings.push(mapped);
    }

    const todayRevenue = sumRevenue(todayBookings);
    const yestRevenue  = sumRevenue(yesterdayBookings);

    const completedToday = todayBookings.filter(b =>
      COMPLETED_STATUSES_JS.has((b.status || '').toLowerCase().replace(/\s+/g, ' ').trim())
    ).length;

    const conversionRate = todayBookings.length > 0
      ? (completedToday / todayBookings.length * 100)
      : 0;

    const bookingsChange = yesterdayBookings.length > 0
      ? ((todayBookings.length - yesterdayBookings.length) / yesterdayBookings.length * 100)
      : (todayBookings.length > 0 ? 100 : 0);

    const revenueChange = yestRevenue > 0
      ? ((todayRevenue - yestRevenue) / yestRevenue * 100)
      : (todayRevenue > 0 ? 100 : 0);

    // Top performers
    const branchMap = {}, agentMap = {}, treatMap = {};
    for (const b of todayBookings) {
      if (b.branch) {
        if (!branchMap[b.branch]) branchMap[b.branch] = { name: b.branch, bookings: 0, revenue: 0 };
        branchMap[b.branch].bookings++;
        branchMap[b.branch].revenue += b.totalPrice;
      }
      if (b.agent) {
        if (!agentMap[b.agent]) agentMap[b.agent] = { name: b.agent, bookings: 0, revenue: 0 };
        agentMap[b.agent].bookings++;
        agentMap[b.agent].revenue += b.totalPrice;
      }
      if (b.treatment) {
        if (!treatMap[b.treatment]) treatMap[b.treatment] = { name: b.treatment, count: 0 };
        treatMap[b.treatment].count++;
      }
    }

    const topBranches   = Object.values(branchMap).sort((a, b) => b.bookings - a.bookings).slice(0, 3);
    const topAgents     = Object.values(agentMap).sort((a, b) => b.bookings - a.bookings).slice(0, 3);
    const topTreatments = Object.values(treatMap).sort((a, b) => b.count - a.count).slice(0, 5);

    // Alerts
    const highValueBookings = todayBookings.filter(b => b.totalPrice >= 50000);
    const cancelledBookings = todayBookings.filter(b =>
      (b.status || '').toLowerCase().includes('cancel') || (b.status || '').toLowerCase().includes('refund')
    );

    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    res.json({
      success: true,
      data: {
        todayBookings: todayBookings.map(b => ({
          timestamp:        b.createdAt,
          branch:           b.branch,
          customer:         `${b.firstName} ${b.lastName}`,
          age:              b.age,
          gender:           b.gender,
          phone:            b.phone,
          email:            b.email,
          socialMedia:      b.socialMedia,
          treatment:        b.treatment,
          area:             b.area,
          freebie:          b.freebie,
          date:             b.date,
          paymentMode:      b.paymentMode,
          price:            b.totalPrice,
          agent:            b.agent,
          bookingDetails:   b.bookingDetails,
          companionName:    b.companionFirstName && b.companionLastName
                              ? `${b.companionFirstName} ${b.companionLastName}` : '',
          companionAge:     b.companionAge || '',
          companionGender:  b.companionGender || '',
          companionFreebie: b.companionFreebie || '',
          companionTreatment: b.companionTreatment || '',
          status:           b.status,
          promoHunterStatus: b.promoHunterStatus,
          matchReason:      b.matchReason,
          matchedSource:    b.matchedSource,
          matchedRow:       b.matchedRow
        })),
        kpis: {
          bookings: {
            today:     todayBookings.length,
            yesterday: yesterdayBookings.length,
            change:    parseFloat(bookingsChange.toFixed(1)),
            trend:     bookingsChange >= 0 ? 'up' : 'down'
          },
          revenue: {
            today:     parseFloat(todayRevenue.toFixed(2)),
            yesterday: parseFloat(yestRevenue.toFixed(2)),
            change:    parseFloat(revenueChange.toFixed(1)),
            trend:     revenueChange >= 0 ? 'up' : 'down'
          },
          avgBookingValue: {
            today:     todayBookings.length > 0 ? parseFloat((todayRevenue / todayBookings.length).toFixed(2)) : 0,
            yesterday: yesterdayBookings.length > 0 ? parseFloat((yestRevenue / yesterdayBookings.length).toFixed(2)) : 0
          },
          conversionRate: parseFloat(conversionRate.toFixed(1))
        },
        topPerformers: { branches: topBranches, agents: topAgents, treatments: topTreatments },
        alerts: {
          highValue: highValueBookings.map(b => ({
            customer:  `${b.firstName} ${b.lastName}`,
            amount:    b.totalPrice,
            treatment: b.treatment,
            branch:    b.branch
          })),
          cancelled: cancelledBookings.map(b => ({
            customer:  `${b.firstName} ${b.lastName}`,
            treatment: b.treatment,
            branch:    b.branch,
            reason:    b.bookingDetails
          })),
          promoHunters: todayBookings.filter(b => (b.status || '').toLowerCase().includes('promo hunter')).length,
          newCustomers:  todayBookings.filter(b => (b.status || '').toLowerCase().includes('new')).length
        },
        comparison: {
          today:     { bookings: todayBookings.length, revenue: parseFloat(todayRevenue.toFixed(2)) },
          yesterday: { bookings: yesterdayBookings.length, revenue: parseFloat(yestRevenue.toFixed(2)) }
        }
      }
    });
  } catch (err) {
    console.error('Error fetching dashboard data:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
}

/**
 * GET /api/dashboard/trend?days=20
 */
async function getBookingTrend(req, res) {
  try {
    const days = Math.min(parseInt(req.query.days) || 20, 365);

    const { rows } = await pool.query(`
      SELECT
        TO_CHAR(appointment_date, 'YYYY-MM-DD') AS date_key,
        TO_CHAR(appointment_date, 'DD Mon')     AS label,
        COUNT(*)                                AS cnt
      FROM bookings
      WHERE appointment_date >= CURRENT_DATE - ($1 - 1) * INTERVAL '1 day'
        AND appointment_date <= CURRENT_DATE
        AND record_status != 'DELETED'
      GROUP BY appointment_date
      ORDER BY appointment_date
    `, [days]);

    // Build full date range including zeros
    const buckets = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key   = d.toISOString().split('T')[0];
      const label = `${d.getDate()} ${d.toLocaleString('default', { month: 'short' })}`;
      buckets[key] = { label, count: 0 };
    }

    for (const r of rows) {
      if (buckets[r.date_key]) buckets[r.date_key].count = parseInt(r.cnt);
    }

    const sorted = Object.values(buckets);

    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    res.json({
      success: true,
      data: {
        dates:    sorted.map(b => b.label),
        bookings: sorted.map(b => b.count)
      }
    });
  } catch (err) {
    console.error('Error fetching booking trend:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch booking trend' });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const COMPLETED_STATUSES_JS = new Set(['arrived not potential', 'arrived & bought', 'comeback & bought']);

function mapBooking(r) {
  return {
    recordId:           r.record_id,
    createdAt:          r.created_at,
    branch:             r.branch || '',
    status:             r.status || '',
    date:               r.date   ? r.date.toISOString().split('T')[0] : '',
    time:               r.time   || '',
    firstName:          r.first_name    || '',
    lastName:           r.last_name     || '',
    age:                r.age           || 0,
    gender:             r.gender        || '',
    phone:              r.phone         || '',
    email:              r.email         || '',
    socialMedia:        r.social_media  || '',
    treatment:          r.treatment     || '',
    area:               r.area          || '',
    freebie:            r.freebie       || '',
    totalPrice:         parseFloat(r.total_price) || 0,
    paymentMode:        r.payment_mode  || '',
    agent:              r.agent         || '',
    bookingDetails:     r.booking_details || '',
    adInteracted:       r.ad_interacted  || '',
    companionFirstName: r.companion_first_name  || '',
    companionLastName:  r.companion_last_name   || '',
    companionAge:       r.companion_age         || '',
    companionGender:    r.companion_gender       || '',
    companionFreebie:   r.companion_freebie      || '',
    companionTreatment: r.companion_treatment    || '',
    promoHunterStatus:  r.promo_hunter_status    || '',
    matchReason:        r.match_reason           || '',
    matchedSource:      r.matched_source         || '',
    matchedRow:         r.matched_row            || ''
  };
}

function sumRevenue(bookings) {
  return bookings.reduce((s, b) => s + b.totalPrice, 0);
}

module.exports = { getDashboardOverview, getBookingTrend };
