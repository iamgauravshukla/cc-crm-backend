'use strict';
const pool = require('../db/pool');

const COMPLETED_IN = `LOWER(booking_status) IN ('arrived not potential','arrived & bought','comeback & bought')`;
// An "arrival" = arrived status AND both validations Approved (Pending/Rejected excluded).
const ARRIVAL_IN   = `(LOWER(booking_status) IN ('arrived not potential','arrived & bought') AND COALESCE(underage_status,'Approved') = 'Approved' AND COALESCE(db_status,'Approved') = 'Approved')`;
const SALE_STATUSES = new Set(['arrived & bought','comeback & bought','arrived not potential']);
const ARRIVAL_STATUSES = new Set(['arrived not potential','arrived & bought']);

// Normalize helper expressions for SQL GROUP BY — keeps data consistent regardless of import casing
const SQL_GENDER = `
  CASE WHEN LOWER(gender) = 'female' THEN 'Female'
       WHEN LOWER(gender) = 'male'   THEN 'Male'
       ELSE COALESCE(NULLIF(TRIM(gender),''), 'Unknown') END`;

const SQL_PAYMENT_MODE = `
  CASE WHEN LOWER(payment_mode) LIKE 'cash%'   THEN 'Cash'
       WHEN LOWER(payment_mode) LIKE 'debit%'  THEN 'Debit'
       WHEN LOWER(payment_mode) LIKE 'credit%' THEN 'Credit'
       ELSE COALESCE(NULLIF(TRIM(payment_mode),''), 'Unknown') END`;

const SQL_TREATMENT = `UPPER(TRIM(treatment))`;
const SQL_AGENT     = `UPPER(TRIM(agent))`;

// ── WHERE clause builder ─────────────────────────────────────────────────────
// Returns { conditions: string[], params: any[] } with record_status guard included.
function buildFilter(branch, range, startDate, endDate) {
  const c = ["record_status != 'DELETED'"];
  const p = [];
  let i   = 1;

  if (branch && branch !== 'All') {
    c.push(`branch = $${i++}`);
    p.push(branch);
  }

  if (startDate && endDate) {
    c.push(`appointment_date >= $${i++}::date AND appointment_date <= $${i++}::date`);
    p.push(startDate, endDate);
  } else if (range && range !== 'year') {
    const dMap = { today: 0, week: 7, month: 30, quarter: 90 };
    if (range === 'today') {
      c.push("appointment_date = (NOW() AT TIME ZONE 'Asia/Manila')::date");
    } else if (dMap[range]) {
      c.push(`appointment_date >= (NOW() AT TIME ZONE 'Asia/Manila')::date - INTERVAL '${dMap[range]} days'`);
    }
  }

  return { conds: c, params: p };
}

function w(conds) { return `WHERE ${conds.join(' AND ')}`; }

// Builds WHERE for the period immediately before the current filter window
function buildPrevFilter(branch, range, startDate, endDate) {
  const c = ["record_status != 'DELETED'"];
  const p = [];
  let i = 1;
  if (branch && branch !== 'All') { c.push(`branch = $${i++}`); p.push(branch); }
  if (startDate && endDate) {
    const ms   = new Date(endDate) - new Date(startDate) + 86400000;
    const pEnd = new Date(new Date(startDate) - 86400000);
    const pSt  = new Date(pEnd - ms + 86400000);
    c.push(`appointment_date >= $${i++}::date AND appointment_date <= $${i++}::date`);
    p.push(pSt.toISOString().split('T')[0], pEnd.toISOString().split('T')[0]);
  } else {
    const d = { today: 1, week: 7, month: 30, quarter: 90 }[range] || 0;
    if (!d) { c.push('1=0'); return { conds: c, params: p }; } // year: no meaningful prev
    if (d === 1) c.push("appointment_date = (NOW() AT TIME ZONE 'Asia/Manila')::date - 1");
    else c.push(`appointment_date >= (NOW() AT TIME ZONE 'Asia/Manila')::date - INTERVAL '${d * 2} days' AND appointment_date < (NOW() AT TIME ZONE 'Asia/Manila')::date - INTERVAL '${d} days'`);
  }
  return { conds: c, params: p };
}

function rangeDays(range, startDate, endDate) {
  if (startDate && endDate) return Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1);
  return { today: 1, week: 7, month: 30, quarter: 90, year: 365 }[range] || 365;
}

// ── getAnalytics ─────────────────────────────────────────────────────────────

async function getAnalytics(req, res) {
  try {
    const branch    = req.query.branch    || 'All';
    const range     = req.query.range     || 'year';
    const startDate = req.query.startDate;
    const endDate   = req.query.endDate;

    const { conds, params: P } = buildFilter(branch, range, startDate, endDate);
    const WHERE = w(conds);

    // Append extra condition to params, returns new params array
    const pWith = (...extra) => [...P, ...extra];

    // For branch perf we always query all branches
    const { conds: bConds, params: bP } = buildFilter('All', range, startDate, endDate);
    const bWHERE = w(bConds);

    // Previous period for delta comparison
    const { conds: pvConds, params: pvP } = buildPrevFilter(branch, range, startDate, endDate);
    const pvWHERE = w(pvConds);

    const [
      { rows: ovRows },
      { rows: brRows },
      { rows: trRows },
      { rows: pyRows },
      { rows: prRows },
      { rows: agRows },
      { rows: gnRows },
      { rows: agAgeRows },
      { rows: soRows },
      { rows: tmRows },
      { rows: pvRows },
      { rows: fnRows },
      { rows: dwRows }
    ] = await Promise.all([
      // 1. Overview: status breakdown + revenue (completed) + unique customers
      pool.query(`
        SELECT LOWER(booking_status) AS status, COUNT(*) AS total,
               SUM(CASE WHEN ${COMPLETED_IN} THEN total_price ELSE 0 END) AS rev
        FROM bookings ${WHERE}
        GROUP BY LOWER(booking_status)`, P),

      // 2. Branch performance (all branches, same date/filter)
      pool.query(`
        SELECT branch,
               COUNT(*) AS total_bookings,
               COUNT(*) FILTER (WHERE ${COMPLETED_IN}) AS completed,
               COUNT(*) FILTER (WHERE ${ARRIVAL_IN})   AS arrivals,
               SUM(CASE WHEN ${COMPLETED_IN} THEN total_price ELSE 0 END) AS revenue
        FROM bookings ${bWHERE}
        GROUP BY branch`, bP),

      // 3. Treatment analysis (completed bookings only) — normalized to UPPER so case variants merge
      pool.query(`
        SELECT ${SQL_TREATMENT} AS treatment, COUNT(*) AS cnt, SUM(total_price) AS revenue
        FROM bookings ${WHERE} AND ${COMPLETED_IN}
        GROUP BY 1 ORDER BY cnt DESC LIMIT 15`, P),

      // 4. Revenue by payment mode (completed only) — normalized so "Cash Payment" → "Cash" etc.
      pool.query(`
        SELECT ${SQL_PAYMENT_MODE} AS payment_mode, SUM(total_price) AS revenue
        FROM bookings ${WHERE} AND ${COMPLETED_IN}
        GROUP BY 1 ORDER BY revenue DESC`, P),

      // 5. Price range distribution (completed only)
      pool.query(`
        SELECT
          SUM(CASE WHEN total_price <= 1000                          THEN 1 ELSE 0 END) AS r0_1000,
          SUM(CASE WHEN total_price > 1000 AND total_price <= 2000   THEN 1 ELSE 0 END) AS r1001_2000,
          SUM(CASE WHEN total_price > 2000 AND total_price <= 3000   THEN 1 ELSE 0 END) AS r2001_3000,
          SUM(CASE WHEN total_price > 3000 AND total_price <= 5000   THEN 1 ELSE 0 END) AS r3001_5000,
          SUM(CASE WHEN total_price > 5000                           THEN 1 ELSE 0 END) AS r5000plus
        FROM bookings ${WHERE} AND ${COMPLETED_IN}`, P),

      // 6. Agent performance — normalized to UPPER so "Raiza" and "RAIZA" merge
      pool.query(`
        SELECT ${SQL_AGENT} AS agent,
               COUNT(*) AS total_bookings,
               COUNT(*) FILTER (WHERE ${COMPLETED_IN}) AS completed,
               COUNT(*) FILTER (WHERE ${ARRIVAL_IN})   AS arrivals,
               SUM(CASE WHEN ${COMPLETED_IN} THEN total_price ELSE 0 END) AS revenue
        FROM bookings ${WHERE}
        GROUP BY 1 ORDER BY revenue DESC`, P),

      // 7. Gender distribution — normalized so "FEMALE" and "Female" merge
      pool.query(`
        SELECT ${SQL_GENDER} AS gender, COUNT(*) AS cnt FROM bookings ${WHERE}
        GROUP BY 1`, P),

      // 8. Age groups
      pool.query(`
        SELECT
          SUM(CASE WHEN age BETWEEN 18 AND 25 THEN 1 ELSE 0 END) AS g18_25,
          SUM(CASE WHEN age BETWEEN 26 AND 35 THEN 1 ELSE 0 END) AS g26_35,
          SUM(CASE WHEN age BETWEEN 36 AND 45 THEN 1 ELSE 0 END) AS g36_45,
          SUM(CASE WHEN age BETWEEN 46 AND 55 THEN 1 ELSE 0 END) AS g46_55,
          SUM(CASE WHEN age >= 56             THEN 1 ELSE 0 END) AS g56plus
        FROM bookings ${WHERE}`, P),

      // 9. Social media / marketing channels
      pool.query(`
        SELECT social_media AS channel,
               COUNT(*) AS bookings,
               COUNT(*) FILTER (WHERE ${COMPLETED_IN}) AS completed,
               SUM(CASE WHEN ${COMPLETED_IN} THEN total_price ELSE 0 END) AS revenue
        FROM bookings ${WHERE}
        GROUP BY social_media ORDER BY bookings DESC`, P),

      // 10. Time series (monthly for year/quarter; daily otherwise)
      // appointment_date IS NOT NULL guard prevents null x-axis labels (ApexCharts crashes on null.toString())
      (!startDate && (range === 'year' || range === 'quarter'))
        ? pool.query(`
            SELECT TO_CHAR(appointment_date,'YYYY-MM') AS period,
                   TO_CHAR(MIN(appointment_date),'Mon YYYY') AS label,
                   COUNT(*) AS cnt, SUM(total_price) AS revenue
            FROM bookings ${WHERE} AND appointment_date IS NOT NULL
            GROUP BY TO_CHAR(appointment_date,'YYYY-MM') ORDER BY period`, P)
        : pool.query(`
            SELECT appointment_date::text AS period,
                   TO_CHAR(appointment_date,'DD Mon') AS label,
                   COUNT(*) AS cnt, SUM(total_price) AS revenue
            FROM bookings ${WHERE} AND appointment_date IS NOT NULL
            GROUP BY appointment_date ORDER BY appointment_date`, P),

      // 11. Previous period overview for delta comparison
      pool.query(`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE ${COMPLETED_IN}) AS completed,
               SUM(CASE WHEN ${COMPLETED_IN} THEN total_price ELSE 0 END) AS revenue
        FROM bookings ${pvWHERE}`, pvP),

      // 12. Conversion funnel counts
      pool.query(`
        SELECT COUNT(*) AS total_bookings,
               COUNT(*) FILTER (WHERE LOWER(booking_status) = 'scheduled') AS scheduled,
               COUNT(*) FILTER (WHERE ${ARRIVAL_IN}) AS arrived,
               COUNT(*) FILTER (WHERE LOWER(booking_status) IN ('arrived & bought','comeback & bought')) AS bought,
               COUNT(*) FILTER (WHERE LOWER(booking_status) LIKE '%cancel%') AS cancelled,
               COUNT(*) FILTER (WHERE is_promo_hunter) AS promo_hunters
        FROM bookings ${WHERE}`, P),

      // 13. Bookings by day of week
      pool.query(`
        SELECT EXTRACT(DOW FROM appointment_date) AS dow,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE ${ARRIVAL_IN}) AS arrived
        FROM bookings ${WHERE}
        GROUP BY EXTRACT(DOW FROM appointment_date)
        ORDER BY dow`, P)
    ]);

    // ── assemble overview ──
    let totalBookings = 0, completedBookings = 0, completedRevenue = 0;
    const statusBreakdown = {};
    for (const r of ovRows) {
      const n = parseInt(r.total);
      totalBookings += n;
      statusBreakdown[r.status] = n;
      if (SALE_STATUSES.has(r.status)) {
        completedRevenue += parseFloat(r.rev || 0);
        completedBookings += n;
      }
    }
    // Unique customers via separate lightweight query
    const { rows: uniqRows } = await pool.query(
      `SELECT COUNT(DISTINCT LOWER(email)) AS uniq FROM bookings ${WHERE} AND (email IS NOT NULL AND email != '')`, P
    );
    const uniqueCustomers = parseInt(uniqRows[0]?.uniq || 0);
    const repeatRate = totalBookings > 0
      ? parseFloat(((totalBookings - uniqueCustomers) / totalBookings * 100).toFixed(1)) : 0;

    // ── branch performance ──
    const rd = rangeDays(range, startDate, endDate);
    const rW = Math.max(1, rd / 7), rM = Math.max(1, rd / 30);
    const branchPerformance = brRows.map(r => {
      const tot = parseInt(r.total_bookings), comp = parseInt(r.completed);
      const arr = parseInt(r.arrivals),       rev  = parseFloat(r.revenue);
      return {
        name: r.branch || 'Unknown', bookings: comp, totalBookings: tot,
        revenue: +rev.toFixed(2), avgBookingValue: comp > 0 ? +(rev / comp).toFixed(2) : 0,
        arrivals: arr, arrivalRate: tot > 0 ? +(arr / tot * 100).toFixed(2) : 0,
        avgWeeklyArrivals: +(arr / rW).toFixed(2), avgMonthlyArrivals: +(arr / rM).toFixed(2)
      };
    }).sort((a, b) => b.revenue - a.revenue);

    // ── treatment ──
    const treatmentAnalysis = trRows.map(r => {
      const cnt = parseInt(r.cnt), rev = parseFloat(r.revenue);
      return { name: r.treatment || 'Unknown', count: cnt, revenue: +rev.toFixed(2), avgPrice: cnt > 0 ? +(rev / cnt).toFixed(2) : 0 };
    });

    // ── revenue analysis ──
    const byPaymentMode = pyRows.map(r => ({ mode: r.payment_mode || 'Unknown', revenue: +parseFloat(r.revenue).toFixed(2) }));
    const pr = prRows[0] || {};
    const byPriceRange = [
      { range: '0-1000',    count: parseInt(pr.r0_1000    || 0) },
      { range: '1001-2000', count: parseInt(pr.r1001_2000 || 0) },
      { range: '2001-3000', count: parseInt(pr.r2001_3000 || 0) },
      { range: '3001-5000', count: parseInt(pr.r3001_5000 || 0) },
      { range: '5000+',     count: parseInt(pr.r5000plus  || 0) }
    ];

    // ── agent performance ──
    const agentPerformance = agRows.map(r => {
      const tot = parseInt(r.total_bookings), comp = parseInt(r.completed);
      const arr = parseInt(r.arrivals),       rev  = parseFloat(r.revenue);
      return {
        name: r.agent || 'Unknown', bookings: tot, completedBookings: comp,
        revenue: +rev.toFixed(2), avgBookingValue: comp > 0 ? +(rev / comp).toFixed(2) : 0,
        arrivals: arr, arrivalRate: tot > 0 ? Math.round(arr / tot * 10000) / 100 : 0,
        avgWeeklyArrivals: +(arr / rW).toFixed(2), avgMonthlyArrivals: +(arr / rM).toFixed(2)
      };
    });

    // ── demographics ──
    const byGender = gnRows.map(r => ({ gender: r.gender || 'Unknown', count: parseInt(r.cnt) }));
    const aRow = agAgeRows[0] || {};
    const byAgeGroup = [
      { ageGroup: '18-25', count: parseInt(aRow.g18_25  || 0) },
      { ageGroup: '26-35', count: parseInt(aRow.g26_35  || 0) },
      { ageGroup: '36-45', count: parseInt(aRow.g36_45  || 0) },
      { ageGroup: '46-55', count: parseInt(aRow.g46_55  || 0) },
      { ageGroup: '56+',   count: parseInt(aRow.g56plus || 0) }
    ];

    // ── marketing channels ──
    const marketingChannels = soRows.map(r => {
      const b = parseInt(r.bookings), c = parseInt(r.completed), rev = parseFloat(r.revenue);
      return {
        channel: r.channel || 'Unknown', bookings: b, completedBookings: c,
        revenue: +rev.toFixed(2),
        conversionRate: b > 0 ? +(c / b * 100).toFixed(1) : 0,
        avgRevenuePerBooking: c > 0 ? +(rev / c).toFixed(2) : 0
      };
    });

    // ── time series ──
    const byMonth = tmRows
      .filter(r => r.label != null)
      .map(r => ({
        month: r.label, count: parseInt(r.cnt), revenue: +parseFloat(r.revenue || 0).toFixed(2)
      }));

    // ── previous period ──
    const pvRow = pvRows[0] || {};
    const previousOverview = {
      totalBookings:     parseInt(pvRow.total    || 0),
      completedBookings: parseInt(pvRow.completed|| 0),
      totalRevenue:      +parseFloat(pvRow.revenue || 0).toFixed(2)
    };

    // ── funnel ──
    const fnRow = fnRows[0] || {};
    const funnelData = {
      totalBookings: parseInt(fnRow.total_bookings || 0),
      scheduled:     parseInt(fnRow.scheduled      || 0),
      arrived:       parseInt(fnRow.arrived        || 0),
      bought:        parseInt(fnRow.bought         || 0),
      cancelled:     parseInt(fnRow.cancelled      || 0),
      promoHunters:  parseInt(fnRow.promo_hunters  || 0)
    };

    // ── day of week ──
    const DOW_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dayOfWeekData = DOW_LABELS.map((day, idx) => {
      const r = dwRows.find(r => parseInt(r.dow) === idx) || {};
      return { dow: idx, day, total: parseInt(r.total || 0), arrived: parseInt(r.arrived || 0) };
    });

    // ── auto insights ──
    const insights = [];
    const currentRevenue = +completedRevenue.toFixed(2);
    if (previousOverview.totalRevenue > 0) {
      const pct = (currentRevenue - previousOverview.totalRevenue) / previousOverview.totalRevenue * 100;
      insights.push({ type: pct >= 0 ? 'positive' : 'negative',
        text: `Revenue ${pct >= 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(1)}% vs previous period (₱${Math.round(previousOverview.totalRevenue).toLocaleString()} → ₱${Math.round(currentRevenue).toLocaleString()})` });
    }
    if (funnelData.totalBookings > 0) {
      const arrRate  = (funnelData.arrived / funnelData.totalBookings * 100).toFixed(1);
      const convRate = funnelData.arrived > 0 ? (funnelData.bought / funnelData.arrived * 100).toFixed(1) : '0';
      insights.push({ type: parseFloat(arrRate) >= 55 ? 'positive' : 'warning',
        text: `${arrRate}% arrival rate · ${convRate}% of arrivals converted to sales` });
    }
    if (branch === 'All' && branchPerformance.length > 0) {
      const best = branchPerformance[0];
      insights.push({ type: 'positive',
        text: `Top branch: ${best.name} — ₱${best.revenue.toLocaleString()} revenue, ${best.arrivalRate}% arrival rate` });
      const byArr = [...branchPerformance].filter(b => b.totalBookings >= 10).sort((a, b) => a.arrivalRate - b.arrivalRate);
      if (byArr.length > 0 && byArr[0].arrivalRate < 50)
        insights.push({ type: 'warning',
          text: `${byArr[0].name} has the lowest arrival rate at ${byArr[0].arrivalRate}% — may need follow-up attention` });
    }
    if (dayOfWeekData.some(d => d.total > 0)) {
      const peak = dayOfWeekData.reduce((a, b) => b.total > a.total ? b : a);
      insights.push({ type: 'info',
        text: `Busiest day: ${peak.day} with ${peak.total} bookings` });
    }
    if (marketingChannels.length > 0) {
      const top = [...marketingChannels].filter(c => c.bookings >= 5).sort((a, b) => b.conversionRate - a.conversionRate)[0];
      if (top) insights.push({ type: 'positive',
        text: `Best channel: "${top.channel}" at ${top.conversionRate}% conversion rate` });
    }

    res.json({
      success: true,
      data: {
        branch,
        range: startDate && endDate ? `${startDate} to ${endDate}` : range,
        overview: { totalBookings, completedBookings, totalRevenue: +completedRevenue.toFixed(2),
          avgBookingValue: completedBookings > 0 ? +(completedRevenue / completedBookings).toFixed(2) : 0,
          uniqueCustomers, repeatCustomerRate: repeatRate, statusBreakdown },
        branchPerformance: branch === 'All' ? branchPerformance : [],
        treatmentAnalysis,
        revenueAnalysis: { byPaymentMode, byPriceRange },
        agentPerformance,
        demographicAnalysis: { byGender, byAgeGroup },
        timeSeriesData: { byMonth },
        marketingChannels,
        previousOverview,
        funnelData,
        dayOfWeekData,
        insights
      }
    });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
}

// ── getAgentPerformance ──────────────────────────────────────────────────────

async function getAgentPerformance(req, res) {
  try {
    const days      = Math.max(1, Math.min(365, Math.floor(parseInt(req.query.days) || 30)));
    const startDate = req.query.startDate;
    const endDate   = req.query.endDate;

    const SKIP_AGENTS = `agent IS NOT NULL AND TRIM(LOWER(agent)) NOT IN ('unknown','no data','n/a','-','','none','unassigned')`;
    const VAL_FILTER  = `COALESCE(underage_status,'Approved') = 'Approved' AND COALESCE(db_status,'Approved') = 'Approved'`;

    let WHERE, params;
    if (startDate && endDate) {
      WHERE  = `WHERE record_status != 'DELETED' AND ${VAL_FILTER} AND appointment_date >= $1::date AND appointment_date <= $2::date AND ${SKIP_AGENTS}`;
      params = [startDate, endDate];
    } else {
      WHERE  = `WHERE record_status != 'DELETED' AND ${VAL_FILTER} AND appointment_date >= (NOW() AT TIME ZONE 'Asia/Manila')::date - INTERVAL '${days} days' AND ${SKIP_AGENTS}`;
      params = [];
    }

    const { rows } = await pool.query(`
      SELECT
        ${SQL_AGENT} AS agent,
        COUNT(*) AS bookings,
        COUNT(*) FILTER (WHERE ${COMPLETED_IN})    AS completed,
        COUNT(*) FILTER (WHERE ${ARRIVAL_IN})      AS arrivals,
        COUNT(*) FILTER (WHERE LOWER(booking_status) = 'scheduled')   AS scheduled,
        COUNT(*) FILTER (WHERE LOWER(booking_status) LIKE '%cancel%')  AS cancelled,
        COUNT(*) FILTER (WHERE is_promo_hunter) AS promo_hunters,
        SUM(CASE WHEN ${COMPLETED_IN} THEN total_price ELSE 0 END) AS revenue
      FROM bookings ${WHERE}
      GROUP BY 1 ORDER BY revenue DESC
    `, params);

    // Per-agent status breakdown — drives the per-agent modal chart (booking counts by
    // status: Arrived & Bought / Arrived Not Potential / Cancelled / Scheduled / …).
    const { rows: sbRows } = await pool.query(`
      SELECT ${SQL_AGENT} AS agent, LOWER(TRIM(booking_status)) AS status, COUNT(*)::int AS n
      FROM bookings ${WHERE} AND NULLIF(TRIM(booking_status), '') IS NOT NULL
      GROUP BY 1, 2
    `, params);
    const titleCase = (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase());
    const statusByAgent = {};
    for (const r of sbRows) {
      (statusByAgent[r.agent] = statusByAgent[r.agent] || {})[titleCase(r.status)] = r.n;
    }

    // Per-agent treatment distribution — drives the "Treatment Distribution by Agent" section.
    const { rows: trRows } = await pool.query(`
      SELECT ${SQL_AGENT} AS agent, UPPER(TRIM(treatment)) AS treatment, COUNT(*)::int AS n
      FROM bookings ${WHERE} AND NULLIF(TRIM(treatment), '') IS NOT NULL
      GROUP BY 1, 2
    `, params);
    const treatmentsByAgent = {};
    for (const r of trRows) {
      (treatmentsByAgent[r.agent] = treatmentsByAgent[r.agent] || []).push({ name: r.treatment, count: r.n });
    }
    for (const a of Object.keys(treatmentsByAgent)) {
      treatmentsByAgent[a].sort((x, y) => y.count - x.count);
    }

    const rd = startDate && endDate
      ? Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1) : days;
    const rW = Math.max(1, rd / 7), rM = Math.max(1, rd / 30);

    const agents = rows.map(r => {
      const tot = parseInt(r.bookings), comp = parseInt(r.completed);
      const arr = parseInt(r.arrivals), rev  = parseFloat(r.revenue);
      return {
        name: r.agent, bookings: tot, completedBookings: comp,
        revenue: +rev.toFixed(2), avgBookingValue: comp > 0 ? +(rev / comp).toFixed(2) : 0,
        conversionRate: tot > 0 ? +(comp / tot * 100).toFixed(2) : 0,
        arrivalRate:    tot > 0 ? Math.round(arr / tot * 10000) / 100 : 0,
        arrivals: arr, avgWeeklyArrivals: +(arr / rW).toFixed(2), avgMonthlyArrivals: +(arr / rM).toFixed(2),
        converted: comp, scheduled: parseInt(r.scheduled), cancelled: parseInt(r.cancelled),
        promoHunters: parseInt(r.promo_hunters),
        statusBreakdown: statusByAgent[r.agent] || {},
        treatments: treatmentsByAgent[r.agent] || []
      };
    });

    const summary = {
      totalAgents:   agents.length,
      totalBookings: agents.reduce((s, a) => s + a.bookings, 0),
      totalRevenue:  +agents.reduce((s, a) => s + a.revenue, 0).toFixed(2),
      avgConversion: agents.length > 0 ? +(agents.reduce((s, a) => s + a.conversionRate, 0) / agents.length).toFixed(2) : 0
    };

    const now = new Date();
    const dateRange = startDate && endDate
      ? { from: new Date(startDate).toISOString(), to: new Date(endDate).toISOString(), custom: true }
      : { from: new Date(now.getTime() - days * 86400000).toISOString(), to: now.toISOString(), days };

    res.json({ success: true, data: { summary, agents, dateRange } });
  } catch (err) {
    console.error('Agent performance error:', err);
    res.status(500).json({ error: 'Failed to fetch agent performance data' });
  }
}

// ── getAdPerformance ─────────────────────────────────────────────────────────

async function getAdPerformance(req, res) {
  try {
    const days      = Math.max(1, Math.min(365, Math.floor(parseInt(req.query.days) || 30)));
    const startDate = req.query.startDate;
    const endDate   = req.query.endDate;
    const branch    = req.query.branch;

    const conds = ["record_status != 'DELETED'", "ad_interacted IS NOT NULL AND ad_interacted != ''"];
    const params = [];
    let i = 1;

    if (branch && branch !== 'All') { conds.push(`branch = $${i++}`); params.push(branch); }

    if (startDate && endDate) {
      conds.push(`appointment_date >= $${i++}::date AND appointment_date <= $${i++}::date`);
      params.push(startDate, endDate);
    } else {
      conds.push(`appointment_date >= (NOW() AT TIME ZONE 'Asia/Manila')::date - INTERVAL '${days} days'`);
    }

    const WHERE = `WHERE ${conds.join(' AND ')}`;

    const { rows } = await pool.query(`
      SELECT ad_interacted AS ad_name,
             branch, treatment,
             COUNT(*) AS total_bookings,
             COUNT(*) FILTER (WHERE LOWER(booking_status) LIKE '%bought%' OR LOWER(booking_status) LIKE '%arrived%') AS converted,
             SUM(CASE WHEN LOWER(booking_status) LIKE '%bought%' OR LOWER(booking_status) LIKE '%arrived%'
                 THEN total_price ELSE 0 END) AS revenue
      FROM bookings ${WHERE}
      GROUP BY ad_interacted, branch, treatment
    `, params);

    const adMap = {};
    for (const r of rows) {
      const key = r.ad_name;
      if (!adMap[key]) adMap[key] = { adName: key, totalBookings: 0, convertedBookings: 0, totalRevenue: 0, branches: {}, treatments: {} };
      const ad = adMap[key];
      ad.totalBookings     += parseInt(r.total_bookings);
      ad.convertedBookings += parseInt(r.converted);
      ad.totalRevenue      += parseFloat(r.revenue);
      if (r.branch)    ad.branches[r.branch]      = (ad.branches[r.branch]     || 0) + parseInt(r.total_bookings);
      if (r.treatment) ad.treatments[r.treatment]  = (ad.treatments[r.treatment]|| 0) + parseInt(r.total_bookings);
    }

    const ads = Object.values(adMap).map(ad => {
      const cr = ad.totalBookings > 0 ? ad.convertedBookings / ad.totalBookings * 100 : 0;
      return {
        adName: ad.adName, totalBookings: ad.totalBookings, convertedBookings: ad.convertedBookings,
        conversionRate:       +cr.toFixed(2),
        totalRevenue:         +ad.totalRevenue.toFixed(2),
        avgRevenuePerBooking: ad.convertedBookings > 0 ? +(ad.totalRevenue / ad.convertedBookings).toFixed(2) : 0,
        topBranch:    Object.entries(ad.branches).sort((a, b) => b[1] - a[1])[0]?.[0]    || null,
        topTreatment: Object.entries(ad.treatments).sort((a, b) => b[1] - a[1])[0]?.[0] || null
      };
    }).sort((a, b) => b.totalBookings - a.totalBookings);

    const summary = {
      totalAds: ads.length,
      totalBookings: ads.reduce((s, a) => s + a.totalBookings, 0),
      totalRevenue:  +ads.reduce((s, a) => s + a.totalRevenue, 0).toFixed(2),
      avgConversionRate: ads.length > 0 ? +(ads.reduce((s, a) => s + a.conversionRate, 0) / ads.length).toFixed(2) : 0
    };

    res.json({ success: true, data: { summary, ads } });
  } catch (err) {
    console.error('Ad performance error:', err);
    res.status(500).json({ error: 'Failed to fetch ad performance data' });
  }
}

// ── getSalesReport ───────────────────────────────────────────────────────────

async function getSalesReport(req, res) {
  try {
    let timeRange    = req.query.timeRange || '6months';
    const selBranch  = req.query.branch   || 'all';
    const startDateP = req.query.startDate;
    const endDateP   = req.query.endDate;

    const now   = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    let startDate, endDate = now;
    if (startDateP && endDateP) {
      startDate = new Date(startDateP); startDate.setHours(0,0,0,0);
      endDate   = new Date(endDateP);   endDate.setHours(23,59,59,999);
      timeRange = 'custom';
    } else {
      startDate = new Date(now);
      switch (timeRange) {
        case '30days':    startDate.setDate(startDate.getDate() - 30);        break;
        case '60days':    startDate.setDate(startDate.getDate() - 60);        break;
        case 'thisMonth': startDate = new Date(now.getFullYear(), now.getMonth(), 1); break;
        case '90days':    startDate.setDate(startDate.getDate() - 90);        break;
        case '1year':     startDate.setFullYear(startDate.getFullYear() - 1); break;
        default:          startDate.setMonth(startDate.getMonth() - 6);  // 6months
      }
      startDate.setHours(0,0,0,0);
    }

    const rdMs     = endDate.getTime() - startDate.getTime();
    const prevEnd  = new Date(startDate.getTime() - 1);
    const prevStart = new Date(prevEnd.getTime() - rdMs);
    const midpoint  = new Date(startDate.getTime() + Math.floor(rdMs / 2));

    const branchCond = selBranch !== 'all' ? 'AND branch = $3' : '';
    const params     = selBranch !== 'all'
      ? [prevStart.toISOString().split('T')[0], endDate.toISOString().split('T')[0], selBranch]
      : [prevStart.toISOString().split('T')[0], endDate.toISOString().split('T')[0]];

    const { rows } = await pool.query(`
      SELECT branch, booking_status, appointment_date, total_price,
             underage_status, db_status
      FROM bookings
      WHERE record_status != 'DELETED'
        AND appointment_date >= $1::date
        AND appointment_date <= $2::date
        ${branchCond}
    `, params);

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const curYear  = now.getFullYear();
    const curMonth = now.getMonth();
    const lastMonth     = curMonth === 0 ? 11 : curMonth - 1;
    const lastMonthYear = curMonth === 0 ? curYear - 1 : curYear;
    const todayStr = today.toISOString().split('T')[0];

    const rangeSales = {}, prevSales = {}, firstHalf = {}, secondHalf = {};
    const dailySalesData = {}, monthlySalesData = {}, yearlyMonths = {};
    let dailySalesOverall = 0;
    const dailyBranch = {}, curMonthSales = {}, lastMonthSales = {};
    let totalBookings = 0, totalArrivals = 0;
    const bookByBranch = {}, arrByBranch = {};

    for (const r of rows) {
      if (!r.appointment_date) continue;
      const bDate  = new Date(r.appointment_date);
      const bStr   = bDate.toISOString().split('T')[0];
      const bYear  = bDate.getFullYear();
      const bMonth = bDate.getMonth();
      const branch = r.branch || 'Unknown';
      const status = (r.booking_status || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const price  = parseFloat(r.total_price) || 0;
      const isArr  = ARRIVAL_STATUSES.has(status) && (r.underage_status || 'Approved') === 'Approved' && (r.db_status || 'Approved') === 'Approved';
      const isSale = SALE_STATUSES.has(status);

      if (bDate >= startDate && bDate <= endDate) {
        totalBookings++;
        bookByBranch[branch] = (bookByBranch[branch] || 0) + 1;
        if (isArr) { totalArrivals++; arrByBranch[branch] = (arrByBranch[branch] || 0) + 1; }

        if (isSale) {
          rangeSales[branch] = (rangeSales[branch] || 0) + price;
          if (bDate <= midpoint) firstHalf[branch]  = (firstHalf[branch]  || 0) + price;
          else                   secondHalf[branch]  = (secondHalf[branch] || 0) + price;

          if (bStr === todayStr) { dailySalesOverall += price; dailyBranch[branch] = (dailyBranch[branch] || 0) + price; }
          if (bYear === curYear  && bMonth === curMonth)   curMonthSales[branch]  = (curMonthSales[branch]  || 0) + price;
          if (bYear === lastMonthYear && bMonth === lastMonth) lastMonthSales[branch] = (lastMonthSales[branch] || 0) + price;

          if (bYear === curYear) {
            if (!yearlyMonths[bMonth]) yearlyMonths[bMonth] = { sales: 0, bookings: 0 };
            yearlyMonths[bMonth].sales   += price;
            yearlyMonths[bMonth].bookings++;
          }

          if (!dailySalesData[bStr]) dailySalesData[bStr] = { date: bStr, sales: 0, bookings: 0 };
          dailySalesData[bStr].sales   += price;
          dailySalesData[bStr].bookings++;
        }
      }

      if (isSale && bDate >= prevStart && bDate <= prevEnd) {
        prevSales[branch] = (prevSales[branch] || 0) + price;
      }
    }

    // Fix monthly sales data accumulation (redo cleanly)
    const monthlySalesClean = {};
    for (const r of rows) {
      if (!r.appointment_date) continue;
      const bDate = new Date(r.appointment_date);
      if (bDate < startDate || bDate > endDate) continue;
      const status = (r.booking_status || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!SALE_STATUSES.has(status)) continue;
      const mk = `${bDate.getFullYear()}-${bDate.getMonth()}`;
      if (!monthlySalesClean[mk]) monthlySalesClean[mk] = { year: bDate.getFullYear(), month: bDate.getMonth(), sales: 0, bookings: 0 };
      monthlySalesClean[mk].sales   += parseFloat(r.total_price) || 0;
      monthlySalesClean[mk].bookings++;
    }

    const fmtBr = obj => Object.entries(obj).map(([branch, sales]) => ({ branch, sales: Math.round(sales * 100) / 100 })).sort((a, b) => b.sales - a.sales);
    const sumBr = obj => Math.round(Object.values(obj).reduce((s, v) => s + v, 0) * 100) / 100;

    const monthlyBreakdownArray = Array.from({ length: 12 }, (_, idx) => ({
      month: MONTHS[idx], sales: Math.round((yearlyMonths[idx]?.sales || 0) * 100) / 100, bookings: yearlyMonths[idx]?.bookings || 0
    }));

    const monthlySalesArray = [];
    const cur = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    const mEnd = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
    while (cur <= mEnd) {
      const mk = `${cur.getFullYear()}-${cur.getMonth()}`;
      const d  = monthlySalesClean[mk] || { sales: 0, bookings: 0 };
      monthlySalesArray.push({ month: `${MONTHS[cur.getMonth()]} ${cur.getFullYear()}`, sales: Math.round(d.sales * 100) / 100, bookings: d.bookings });
      cur.setMonth(cur.getMonth() + 1);
    }

    const dailySalesArray = [];
    const dc = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const de = new Date(endDate.getFullYear(),   endDate.getMonth(),   endDate.getDate());
    while (dc <= de) {
      const key = dc.toISOString().split('T')[0];
      const d   = dailySalesData[key] || { date: key, sales: 0, bookings: 0 };
      dailySalesArray.push({ date: d.date, sales: Math.round(d.sales * 100) / 100, bookings: d.bookings });
      dc.setDate(dc.getDate() + 1);
    }

    const yearlySalesOverall = monthlyBreakdownArray.reduce((s, m) => s + m.sales, 0);

    res.json({
      success: true,
      data: {
        timeRange, branch: selBranch,
        arrivalRate:  totalBookings > 0 ? Math.round(totalArrivals / totalBookings * 10000) / 100 : 0,
        totalArrivals, totalBookings,
        arrivalRateByBranch: Object.keys(bookByBranch).map(br => ({
          branch: br, bookings: bookByBranch[br] || 0, arrivals: arrByBranch[br] || 0,
          arrivalRate: bookByBranch[br] > 0 ? Math.round((arrByBranch[br] || 0) / bookByBranch[br] * 10000) / 100 : 0
        })).sort((a, b) => b.arrivalRate - a.arrivalRate),
        rangeSales:           { overall: sumBr(rangeSales),  byBranch: fmtBr(rangeSales)  },
        previousRangeSales:   { overall: sumBr(prevSales),   byBranch: fmtBr(prevSales)   },
        rangeFirstHalfSales:  { overall: sumBr(firstHalf),   byBranch: fmtBr(firstHalf)   },
        rangeSecondHalfSales: { overall: sumBr(secondHalf),  byBranch: fmtBr(secondHalf)  },
        dailySalesAndBookings: dailySalesArray,
        dailySales:           { overall: Math.round(dailySalesOverall * 100) / 100, byBranch: fmtBr(dailyBranch) },
        firstHalfSales:       { overall: sumBr(firstHalf),   byBranch: fmtBr(firstHalf)   },
        secondHalfSales:      { overall: sumBr(secondHalf),  byBranch: fmtBr(secondHalf)  },
        currentMonthSales:    { overall: sumBr(curMonthSales),  byBranch: fmtBr(curMonthSales)  },
        lastMonthSales:       { overall: sumBr(lastMonthSales), byBranch: fmtBr(lastMonthSales) },
        yearlySales:          { overall: Math.round(yearlySalesOverall * 100) / 100, monthlyBreakdown: monthlyBreakdownArray },
        monthlySalesAndBookings: monthlySalesArray
      }
    });
  } catch (err) {
    console.error('Sales report error:', err);
    res.status(500).json({ error: 'Failed to fetch sales report data' });
  }
}

module.exports = { getAnalytics, getAgentPerformance, getAdPerformance, getSalesReport };
