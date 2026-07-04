'use strict';
const pool = require('../db/pool');

const COMPLETED_IN = `LOWER(booking_status) IN ('arrived not potential','arrived & bought','comeback & bought')`;
const ARRIVAL_IN   = `LOWER(booking_status) IN ('arrived not potential','arrived & bought')`;
const SALE_STATUSES = new Set(['arrived & bought','comeback & bought','arrived not potential']);
const ARRIVAL_STATUSES = new Set(['arrived not potential','arrived & bought']);

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
      c.push('appointment_date = CURRENT_DATE');
    } else if (dMap[range]) {
      c.push(`appointment_date >= CURRENT_DATE - INTERVAL '${dMap[range]} days'`);
    }
  }

  return { conds: c, params: p };
}

function w(conds) { return `WHERE ${conds.join(' AND ')}`; }

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
      { rows: tmRows }
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

      // 3. Treatment analysis (completed bookings only)
      pool.query(`
        SELECT treatment, COUNT(*) AS cnt, SUM(total_price) AS revenue
        FROM bookings ${WHERE} AND ${COMPLETED_IN}
        GROUP BY treatment ORDER BY cnt DESC LIMIT 15`, P),

      // 4. Revenue by payment mode (completed only)
      pool.query(`
        SELECT payment_mode, SUM(total_price) AS revenue
        FROM bookings ${WHERE} AND ${COMPLETED_IN}
        GROUP BY payment_mode ORDER BY revenue DESC`, P),

      // 5. Price range distribution (completed only)
      pool.query(`
        SELECT
          SUM(CASE WHEN total_price <= 1000                          THEN 1 ELSE 0 END) AS r0_1000,
          SUM(CASE WHEN total_price > 1000 AND total_price <= 2000   THEN 1 ELSE 0 END) AS r1001_2000,
          SUM(CASE WHEN total_price > 2000 AND total_price <= 3000   THEN 1 ELSE 0 END) AS r2001_3000,
          SUM(CASE WHEN total_price > 3000 AND total_price <= 5000   THEN 1 ELSE 0 END) AS r3001_5000,
          SUM(CASE WHEN total_price > 5000                           THEN 1 ELSE 0 END) AS r5000plus
        FROM bookings ${WHERE} AND ${COMPLETED_IN}`, P),

      // 6. Agent performance
      pool.query(`
        SELECT agent,
               COUNT(*) AS total_bookings,
               COUNT(*) FILTER (WHERE ${COMPLETED_IN}) AS completed,
               COUNT(*) FILTER (WHERE ${ARRIVAL_IN})   AS arrivals,
               SUM(CASE WHEN ${COMPLETED_IN} THEN total_price ELSE 0 END) AS revenue
        FROM bookings ${WHERE}
        GROUP BY agent ORDER BY revenue DESC`, P),

      // 7. Gender distribution
      pool.query(`
        SELECT gender, COUNT(*) AS cnt FROM bookings ${WHERE}
        GROUP BY gender`, P),

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
      (!startDate && (range === 'year' || range === 'quarter'))
        ? pool.query(`
            SELECT TO_CHAR(appointment_date,'YYYY-MM') AS period,
                   TO_CHAR(MIN(appointment_date),'Mon YYYY') AS label,
                   COUNT(*) AS cnt, SUM(total_price) AS revenue
            FROM bookings ${WHERE}
            GROUP BY TO_CHAR(appointment_date,'YYYY-MM') ORDER BY period`, P)
        : pool.query(`
            SELECT appointment_date::text AS period,
                   TO_CHAR(appointment_date,'DD Mon') AS label,
                   COUNT(*) AS cnt, SUM(total_price) AS revenue
            FROM bookings ${WHERE}
            GROUP BY appointment_date ORDER BY appointment_date`, P)
    ]);

    // ── assemble overview ──
    let totalBookings = 0, completedBookings = 0, completedRevenue = 0;
    const statusBreakdown = {};
    for (const r of ovRows) {
      const n = parseInt(r.total);
      totalBookings += n;
      statusBreakdown[r.status] = n;
      if (parseFloat(r.rev) > 0) { completedRevenue += parseFloat(r.rev); completedBookings += n; }
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
    const byMonth = tmRows.map(r => ({
      month: r.label, count: parseInt(r.cnt), revenue: +parseFloat(r.revenue).toFixed(2)
    }));

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
        marketingChannels
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
    const days      = parseInt(req.query.days) || 30;
    const startDate = req.query.startDate;
    const endDate   = req.query.endDate;

    const SKIP_AGENTS = `agent IS NOT NULL AND TRIM(LOWER(agent)) NOT IN ('unknown','no data','n/a','-','','none','unassigned')`;
    const VAL_FILTER  = `cancel_validation = FALSE AND underage_cancellation = FALSE`;

    let WHERE, params;
    if (startDate && endDate) {
      WHERE  = `WHERE record_status != 'DELETED' AND ${VAL_FILTER} AND appointment_date >= $1::date AND appointment_date <= $2::date AND ${SKIP_AGENTS}`;
      params = [startDate, endDate];
    } else {
      WHERE  = `WHERE record_status != 'DELETED' AND ${VAL_FILTER} AND appointment_date >= CURRENT_DATE - INTERVAL '${days} days' AND ${SKIP_AGENTS}`;
      params = [];
    }

    const { rows } = await pool.query(`
      SELECT
        agent,
        COUNT(*) AS bookings,
        COUNT(*) FILTER (WHERE ${COMPLETED_IN})    AS completed,
        COUNT(*) FILTER (WHERE ${ARRIVAL_IN})      AS arrivals,
        COUNT(*) FILTER (WHERE LOWER(booking_status) = 'scheduled')   AS scheduled,
        COUNT(*) FILTER (WHERE LOWER(booking_status) LIKE '%cancel%')  AS cancelled,
        COUNT(*) FILTER (WHERE LOWER(booking_status) = 'promo hunter' OR (promo_hunter_status IS NOT NULL AND promo_hunter_status != '')) AS promo_hunters,
        SUM(CASE WHEN ${COMPLETED_IN} THEN total_price ELSE 0 END) AS revenue
      FROM bookings ${WHERE}
      GROUP BY agent ORDER BY revenue DESC
    `, params);

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
        promoHunters: parseInt(r.promo_hunters)
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
    const days      = parseInt(req.query.days) || 30;
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
      conds.push(`appointment_date >= CURRENT_DATE - INTERVAL '${days} days'`);
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
      SELECT branch, booking_status, appointment_date, total_price
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
      const isArr  = ARRIVAL_STATUSES.has(status);
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
