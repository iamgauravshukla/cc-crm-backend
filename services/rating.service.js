// Agent Capability Index (ACI) — one 0–100 rating per agent per period,
// blending GPT chat quality with real booking outcomes from the CRM.
// Identities: Pancake chat names resolve to CRM booking agents through
// qa_agent_map (confirmed by an admin) or, failing that, the same word-match
// used by the scorecard. Unmatched chat agents are rated on chat data alone.
const pool = require('../db/pool');

const DEFAULT_WEIGHTS = {
  chatQa: 25,         // GPT quality score of sampled chats
  conversion: 20,     // chats that produced a CRM booking within 7 days (by phone)
  showRate: 15,       // arrivals / appointments for the matched CRM agent
  revenue: 15,        // revenue per arrival vs company benchmark
  responsiveness: 15, // first-response speed + customers never left unanswered
  discipline: 10,     // 100 − (no-show rate + cancel rate)
};
const COMPONENT_KEYS = Object.keys(DEFAULT_WEIGHTS);

async function getWeights() {
  try {
    const { rows } = await pool.query(`SELECT value FROM qa_settings WHERE key = 'aci_weights'`);
    if (rows.length) {
      const v = rows[0].value || {};
      const w = {};
      for (const k of COMPONENT_KEYS) w[k] = Number(v[k]) >= 0 ? Number(v[k]) : DEFAULT_WEIGHTS[k];
      if (COMPONENT_KEYS.some(k => w[k] > 0)) return w;
    }
  } catch { /* fall through to defaults */ }
  return { ...DEFAULT_WEIGHTS };
}

async function saveWeights(weights, updatedBy) {
  const w = {};
  for (const k of COMPONENT_KEYS) {
    const n = Number(weights?.[k]);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`Invalid weight for ${k}`);
    w[k] = n;
  }
  if (!COMPONENT_KEYS.some(k => w[k] > 0)) throw new Error('At least one weight must be above zero');
  await pool.query(`
    INSERT INTO qa_settings (key, value, updated_at) VALUES ('aci_weights', $1, NOW())
    ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
  `, [JSON.stringify({ ...w, updatedBy: updatedBy || null })]);
  return w;
}

// Same whole-word containment match the scorecard uses: "HERA RAP" → CRM "RAP".
function autoMatch(pancakeName, crmAgents) {
  const words = String(pancakeName).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  let best = '';
  for (const a of crmAgents) {
    const aWords = a.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    if (aWords.length > 0 && aWords.every(w => words.includes(w)) && a.length > best.length) best = a;
  }
  return best || null;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pct = (n, d) => d > 0 ? Math.round((n / d) * 1000) / 10 : null;

// Median first response (seconds) → 0–100 speed score
function speedScore(sec) {
  if (sec == null) return null;
  if (sec <= 120) return 100;
  if (sec <= 300) return 90;
  if (sec <= 900) return 75;
  if (sec <= 1800) return 60;
  if (sec <= 3600) return 45;
  if (sec <= 7200) return 30;
  return 15;
}

function tierOf(aci) {
  if (aci == null) return null;
  return aci >= 85 ? 'A' : aci >= 70 ? 'B' : aci >= 55 ? 'C' : 'D';
}

async function periodData(from, to) {
  const [qa, conv, booked, map] = await Promise.all([
    // GPT-scored chat aggregates per Pancake agent
    pool.query(`
      SELECT agent_name,
             COUNT(*)::int AS convs,
             ROUND(AVG(overall))::int AS avg_score,
             PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_response_sec) AS med_first,
             COUNT(*) FILTER (WHERE followthrough)::int AS followed,
             COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(red_flags,'[]'::jsonb)) > 0)::int AS flagged,
             COUNT(*) FILTER (WHERE customer_phone IS NOT NULL)::int AS with_phone
      FROM qa_conversations
      WHERE overall IS NOT NULL AND NULLIF(TRIM(agent_name),'') IS NOT NULL
        AND last_msg_at >= $1::timestamptz AND last_msg_at <= $2::timestamptz
      GROUP BY agent_name
    `, [`${from}T00:00:00+08:00`, `${to}T23:59:59+08:00`]),
    // Booking outcomes per CRM agent, one grouped pass (scorecard definitions).
    // Grouped case-insensitively: "Mary" and "MARY" are the same person.
    pool.query(`
      SELECT UPPER(TRIM(agent)) AS agent_u,
             MODE() WITHIN GROUP (ORDER BY TRIM(agent)) AS display,
             COUNT(*) FILTER (WHERE booking_date BETWEEN $1::date AND $2::date)::int AS bookings_created,
             COUNT(*) FILTER (WHERE appointment_date BETWEEN $1::date AND $2::date)::int AS appts,
             COUNT(*) FILTER (WHERE appointment_date BETWEEN $1::date AND $2::date
               AND LOWER(booking_status) IN ('arrived & bought','arrived not potential')
               AND COALESCE(underage_status,'Approved') = 'Approved' AND COALESCE(db_status,'Approved') = 'Approved'
               AND NOT COALESCE(cancel_validation, false))::int AS arrived,
             COUNT(*) FILTER (WHERE appointment_date BETWEEN $1::date AND $2::date
               AND LOWER(booking_status) = 'no show')::int AS no_shows,
             COUNT(*) FILTER (WHERE appointment_date BETWEEN $1::date AND $2::date
               AND LOWER(booking_status) LIKE '%cancel%')::int AS cancelled,
             COALESCE(SUM(total_price) FILTER (WHERE appointment_date BETWEEN $1::date AND $2::date
               AND LOWER(booking_status) IN ('arrived & bought','comeback & bought','arrived not potential')), 0) AS revenue
      FROM bookings
      WHERE record_status <> 'DELETED' AND NULLIF(TRIM(agent),'') IS NOT NULL
      GROUP BY UPPER(TRIM(agent))
    `, [from, to]),
    // Chat → booking attribution: scored chats whose customer phone matches a
    // CRM booking created within −1…+7 days of the chat
    pool.query(`
      SELECT qc.agent_name, COUNT(*)::int AS booked
      FROM qa_conversations qc
      WHERE qc.overall IS NOT NULL AND qc.customer_phone IS NOT NULL
        AND NULLIF(TRIM(qc.agent_name),'') IS NOT NULL
        AND qc.last_msg_at >= $1::timestamptz AND qc.last_msg_at <= $2::timestamptz
        AND EXISTS (
          SELECT 1 FROM bookings b
          WHERE b.record_status <> 'DELETED' AND COALESCE(b.phone_norm,'') <> ''
            AND RIGHT(b.phone_norm, 10) = RIGHT(qc.customer_phone, 10)
            AND b.booking_date BETWEEN (qc.last_msg_at::date - 1) AND (qc.last_msg_at::date + 7)
        )
      GROUP BY qc.agent_name
    `, [`${from}T00:00:00+08:00`, `${to}T23:59:59+08:00`]),
    pool.query(`SELECT pancake_name, crm_agent, confirmed FROM qa_agent_map`),
  ]);
  return {
    qaByPancake: Object.fromEntries(qa.rows.map(r => [r.agent_name, r])),
    bookingByCrm: Object.fromEntries(conv.rows.map(r => [r.agent_u, r])), // keyed UPPER
    bookedByPancake: Object.fromEntries(booked.rows.map(r => [r.agent_name, r.booked])),
    mapRows: map.rows,
  };
}

// Build ratings for one period. Returns rows keyed by canonical agent.
async function ratePeriod(from, to, weights) {
  const { qaByPancake, bookingByCrm, bookedByPancake, mapRows } = await periodData(from, to);
  const crmAgents = Object.values(bookingByCrm).map(b => b.display);
  const confirmed = Object.fromEntries(mapRows.filter(m => m.confirmed).map(m => [m.pancake_name, m.crm_agent]));

  // Canonical grouping (case-insensitive): every Pancake agent with chats +
  // every CRM agent with bookings
  const groups = {}; // UPPER key → { crmAgent (display), pancake: [names], qa agg, booked, withPhone }
  for (const [pName, q] of Object.entries(qaByPancake)) {
    const crm = Object.prototype.hasOwnProperty.call(confirmed, pName)
      ? confirmed[pName]                       // may be null = "no CRM counterpart"
      : autoMatch(pName, crmAgents);
    const key = (crm || pName).toUpperCase();
    const g = groups[key] || (groups[key] = { crmAgent: crm || null, pancake: [], convs: 0, scoreSum: 0, followed: 0, flagged: 0, withPhone: 0, booked: 0, medFirsts: [] });
    g.pancake.push({ name: pName, convs: q.convs, confirmed: Object.prototype.hasOwnProperty.call(confirmed, pName) });
    g.convs += q.convs;
    g.scoreSum += (q.avg_score || 0) * q.convs;
    g.followed += q.followed;
    g.flagged += q.flagged;
    g.withPhone += q.with_phone;
    g.booked += bookedByPancake[pName] || 0;
    if (q.med_first != null) g.medFirsts.push(Number(q.med_first));
  }
  for (const crm of crmAgents) {
    const key = crm.toUpperCase();
    if (!groups[key]) groups[key] = { crmAgent: crm, pancake: [], convs: 0, scoreSum: 0, followed: 0, flagged: 0, withPhone: 0, booked: 0, medFirsts: [] };
  }

  // Company benchmark for revenue-per-arrival (agents with real arrivals)
  const rpas = Object.values(bookingByCrm)
    .filter(b => b.arrived > 0)
    .map(b => (parseFloat(b.revenue) || 0) / b.arrived)
    .filter(v => v > 0);
  const benchRpa = rpas.length ? rpas.reduce((s, v) => s + v, 0) / rpas.length : null;

  const rows = [];
  for (const [key, g] of Object.entries(groups)) {
    const b = g.crmAgent ? bookingByCrm[g.crmAgent.toUpperCase()] : null;
    const chatAvg = g.convs > 0 ? Math.round(g.scoreSum / g.convs) : null;
    const medFirst = g.medFirsts.length ? g.medFirsts.sort((x, y) => x - y)[Math.floor(g.medFirsts.length / 2)] : null;
    const followRate = g.convs > 0 ? (g.followed / g.convs) * 100 : null;
    const convPct = g.withPhone >= 3 ? pct(g.booked, g.withPhone) : null;
    const showRate = b && b.appts >= 3 ? pct(b.arrived, b.appts) : null;
    const noShowRate = b && b.appts >= 3 ? pct(b.no_shows, b.appts) : null;
    const cancelRate = b && b.appts >= 3 ? pct(b.cancelled, b.appts) : null;
    const rpa = b && b.arrived > 0 ? (parseFloat(b.revenue) || 0) / b.arrived : null;

    const comp = {
      chatQa:        { value: chatAvg, score: chatAvg },
      conversion:    { value: convPct, score: convPct != null ? clamp(convPct * 2.5, 0, 100) : null },
      showRate:      { value: showRate, score: showRate != null ? clamp(showRate, 0, 100) : null },
      revenue:       { value: rpa != null ? Math.round(rpa) : null,
                       score: rpa != null && benchRpa ? clamp((rpa / benchRpa) * 75, 0, 100) : null },
      responsiveness:{ value: medFirst != null ? Math.round(medFirst) : null,
                       score: g.convs > 0 && (medFirst != null || followRate != null)
                         ? clamp(0.6 * (speedScore(medFirst) ?? 60) + 0.4 * (followRate ?? 100), 0, 100) : null },
      discipline:    { value: noShowRate != null ? Math.round((noShowRate + cancelRate) * 10) / 10 : null,
                       score: noShowRate != null ? clamp(100 - (noShowRate + cancelRate), 0, 100) : null },
    };
    // Weighted average over the components that have data — missing data
    // re-weights instead of counting as zero.
    let wSum = 0, sSum = 0;
    for (const k of COMPONENT_KEYS) {
      comp[k].weight = weights[k];
      comp[k].available = comp[k].score != null && weights[k] > 0;
      if (comp[k].available) { wSum += weights[k]; sSum += comp[k].score * weights[k]; }
      if (comp[k].score != null) comp[k].score = Math.round(comp[k].score * 10) / 10;
    }
    const aci = wSum > 0 ? Math.round((sSum / wSum) * 10) / 10 : null;

    const mainPancake = g.pancake.sort((a, z) => z.convs - a.convs)[0]?.name || null;
    rows.push({
      agentKey: g.crmAgent || mainPancake || key,
      crmAgent: g.crmAgent,
      pancakeNames: g.pancake.map(p => p.name),
      profileName: mainPancake,
      mappingConfirmed: g.pancake.length > 0 && g.pancake.every(p => p.confirmed),
      convs: g.convs,
      flagged: g.flagged,
      withPhone: g.withPhone,
      booked: g.booked,
      bookings: b ? { created: b.bookings_created, appts: b.appts, arrived: b.arrived, revenue: parseFloat(b.revenue) || 0 } : null,
      components: comp,
      aci,
      tier: tierOf(aci),
    });
  }
  rows.sort((a, z) => (z.aci ?? -1) - (a.aci ?? -1));
  return rows;
}

// Public entry: current period + delta vs the previous period of equal length,
// with the current period persisted to agent_ratings for history.
async function computeRatings(from, to) {
  const weights = await getWeights();
  const dayMs = 86400000;
  const span = Math.max(1, Math.round((new Date(to) - new Date(from)) / dayMs) + 1);
  const prevTo = new Date(new Date(from).getTime() - dayMs).toISOString().slice(0, 10);
  const prevFrom = new Date(new Date(from).getTime() - span * dayMs).toISOString().slice(0, 10);

  const [current, previous] = await Promise.all([
    ratePeriod(from, to, weights),
    ratePeriod(prevFrom, prevTo, weights),
  ]);
  const prevByKey = Object.fromEntries(previous.map(r => [r.agentKey.toUpperCase(), r.aci]));
  for (const r of current) {
    r.prevAci = prevByKey[r.agentKey.toUpperCase()] ?? null;
    r.delta = r.aci != null && r.prevAci != null ? Math.round((r.aci - r.prevAci) * 10) / 10 : null;
  }

  // Persist history (fire-and-forget semantics; a failure must not break the response)
  try {
    for (const r of current.filter(x => x.aci != null)) {
      await pool.query(`
        INSERT INTO agent_ratings (agent_key, period_from, period_to, components, aci, tier, computed_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (agent_key, period_from, period_to)
        DO UPDATE SET components = $4, aci = $5, tier = $6, computed_at = NOW()
      `, [r.agentKey, from, to, JSON.stringify(r.components), r.aci, r.tier]);
    }
  } catch (err) { console.error('agent_ratings persist error:', err.message); }

  return { from, to, prevFrom, prevTo, weights, agents: current };
}

// Mapping manager: every Pancake agent ever scored + its current/suggested CRM match
async function listAgentMap() {
  const [{ rows: seen }, { rows: mapRows }, { rows: crmRows }] = await Promise.all([
    pool.query(`
      SELECT agent_name, COUNT(*)::int AS convs, MAX(last_msg_at) AS last_seen
      FROM qa_conversations
      WHERE overall IS NOT NULL AND NULLIF(TRIM(agent_name),'') IS NOT NULL
      GROUP BY agent_name ORDER BY convs DESC
    `),
    pool.query(`SELECT pancake_name, crm_agent, confirmed, updated_by, updated_at FROM qa_agent_map`),
    pool.query(`
      SELECT DISTINCT TRIM(agent) AS agent FROM bookings
      WHERE record_status <> 'DELETED' AND NULLIF(TRIM(agent),'') IS NOT NULL
    `),
  ]);
  // Case-insensitive dedupe: keep one display spelling per CRM agent
  const seenU = new Set();
  const crmAgents = crmRows.map(r => r.agent).sort((a, b) => a.localeCompare(b))
    .filter(a => { const u = a.toUpperCase(); if (seenU.has(u)) return false; seenU.add(u); return true; });
  const byName = Object.fromEntries(mapRows.map(m => [m.pancake_name, m]));
  const rows = seen.map(s => {
    const m = byName[s.agent_name];
    return {
      pancakeName: s.agent_name,
      convs: s.convs,
      lastSeen: s.last_seen,
      crmAgent: m ? m.crm_agent : autoMatch(s.agent_name, crmAgents),
      confirmed: !!m?.confirmed,
      updatedBy: m?.updated_by || null,
    };
  });
  return { agents: rows, crmAgents };
}

async function saveAgentMap(pancakeName, crmAgent, updatedBy) {
  await pool.query(`
    INSERT INTO qa_agent_map (pancake_name, crm_agent, confirmed, updated_by, updated_at)
    VALUES ($1, $2, true, $3, NOW())
    ON CONFLICT (pancake_name)
    DO UPDATE SET crm_agent = $2, confirmed = true, updated_by = $3, updated_at = NOW()
  `, [pancakeName, crmAgent || null, updatedBy || null]);
}

module.exports = { computeRatings, listAgentMap, saveAgentMap, getWeights, saveWeights, DEFAULT_WEIGHTS };
