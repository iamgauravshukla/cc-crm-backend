'use strict';
const pool = require('../db/pool');
const pancake = require('../services/pancake.service');
const qa = require('../services/qa.service');
const rating = require('../services/rating.service');

const phFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' });

// GET /qa/pages — configured/discovered Pancake pages
async function getPagesList(req, res) {
  try {
    const fresh = req.query.fresh === '1';
    const pages = await pancake.getPages({ fresh });
    res.json({
      success: true,
      openaiConfigured: !!process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_QA_MODEL || 'gpt-4o-mini',
      pages: pages.map(p => ({ pageId: p.pageId, label: p.label, platform: p.platform, hasToken: !!p.token })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Failed to load Pancake pages' });
  }
}

// GET /qa/pages/:pageId/agents — staff list of one page (for the agent filter)
async function getPageAgents(req, res) {
  try {
    const page = await pancake.getPage(req.params.pageId);
    if (!page) return res.status(404).json({ error: 'Page not configured or has no API token' });
    const users = await pancake.listUsers(page);
    res.json({ success: true, agents: users });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Failed to load page agents' });
  }
}

// POST /qa/runs — start an analysis run; returns immediately, processing continues in-process
async function startRun(req, res) {
  try {
    const { pageId, from, to, agentName = '', sampleSize = 20, force = false, name = '' } = req.body || {};
    if (!pageId) return res.status(400).json({ error: 'pageId is required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
      return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required' });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ error: 'OPENAI_API_KEY is not set in the server environment yet' });
    }
    const page = await pancake.getPage(pageId);
    if (!page) return res.status(404).json({ error: 'Page not configured or has no API token' });

    // Future dates make no sense for chat history — clamp to today (Manila)
    const todayStr = phFmt.format(Date.now());
    const clampedTo = to > todayStr ? todayStr : to;
    const clampedFrom = from > clampedTo ? clampedTo : from;

    // Manila-local day bounds → unix seconds
    const sinceUnix = Math.floor(new Date(`${clampedFrom}T00:00:00+08:00`).getTime() / 1000);
    const untilUnix = Math.floor(new Date(`${clampedTo}T23:59:59+08:00`).getTime() / 1000);
    const size = Math.max(1, Math.min(200, parseInt(sampleSize, 10) || 20));

    const runName = String(name || '').trim().slice(0, 140)
      || `${page.label} · ${clampedFrom} → ${clampedTo}${agentName ? ` · ${agentName}` : ''}`;
    const { rows } = await pool.query(`
      INSERT INTO qa_runs (name, page_id, page_name, run_type, since, until, agent_filter, sample_size, model, created_by_name)
      VALUES ($1, $2, $3, 'manual', to_timestamp($4), to_timestamp($5), $6, $7, $8, $9)
      RETURNING id
    `, [runName, page.pageId, page.label, sinceUnix, untilUnix, agentName || null, size,
        process.env.OPENAI_QA_MODEL || 'gpt-4o-mini', req.user?.name || req.user?.email || null]);
    const runId = rows[0].id;

    // Fire and forget — the dashboard polls GET /qa/runs/:id
    qa.executeRun(runId, { page, sinceUnix, untilUnix, agentFilter: agentName || null, sampleSize: size, force: force === true })
      .catch(e => console.error('QA run crashed:', e.message));

    res.status(202).json({ success: true, runId });
  } catch (err) {
    console.error('startRun error:', err);
    res.status(500).json({ error: 'Failed to start QA run' });
  }
}

const mapRun = (r) => ({
  id: r.id, name: r.name || '', pageId: r.page_id, pageName: r.page_name, runType: r.run_type,
  since: r.since, until: r.until, agentFilter: r.agent_filter, sampleSize: r.sample_size,
  status: r.status, convsFound: r.convs_found, convsAnalyzed: r.convs_analyzed,
  convsSkipped: r.convs_skipped, convsFailed: r.convs_failed, convsReused: r.convs_reused || 0,
  tokensIn: Number(r.tokens_in), tokensOut: Number(r.tokens_out), model: r.model,
  error: r.error, createdByName: r.created_by_name, createdAt: r.created_at, finishedAt: r.finished_at,
});

// GET /qa/runs  +  GET /qa/runs/:id
async function listRuns(req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM qa_runs ORDER BY id DESC LIMIT 25');
    res.json({ success: true, runs: rows.map(mapRun) });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch runs' }); }
}
async function getRun(req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM qa_runs WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (!rows.length) return res.status(404).json({ error: 'Run not found' });
    res.json({ success: true, run: mapRun(rows[0]) });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch run' }); }
}

function convFilters(q) {
  const conds = ['overall IS NOT NULL'];
  const params = [];
  let i = 1;
  // A run's report = its scored chats + chats reused from earlier runs
  if (q.runId)    { conds.push(`id IN (SELECT conv_id FROM qa_run_items WHERE run_id = $${i++})`); params.push(parseInt(q.runId, 10)); }
  if (q.pageId)   { conds.push(`page_id = $${i++}`); params.push(q.pageId); }
  if (q.agent)    { conds.push(`LOWER(COALESCE(agent_name,'')) LIKE $${i++}`); params.push(`%${q.agent.toLowerCase()}%`); }
  if (q.from)     { conds.push(`last_msg_at >= $${i++}::timestamptz`); params.push(`${q.from}T00:00:00+08:00`); }
  if (q.to)       { conds.push(`last_msg_at <= $${i++}::timestamptz`); params.push(`${q.to}T23:59:59+08:00`); }
  if (q.minScore) { conds.push(`overall >= $${i++}`); params.push(parseInt(q.minScore, 10)); }
  if (q.maxScore) { conds.push(`overall <= $${i++}`); params.push(parseInt(q.maxScore, 10)); }
  if (q.flagsOnly === '1') conds.push(`jsonb_array_length(COALESCE(red_flags, '[]'::jsonb)) > 0`);
  return { where: `WHERE ${conds.join(' AND ')}`, params, i };
}

// DELETE /qa/runs/:id — remove a report: the run row and every chat it scored
async function deleteRun(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query('SELECT id, status FROM qa_runs WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Run not found' });
    if (rows[0].status === 'Running') return res.status(400).json({ error: 'This run is still in progress — wait for it to finish first' });

    // Remove this run's membership first; then delete only the chat scores this
    // run produced that no other run still references (reused elsewhere = kept).
    await pool.query('DELETE FROM qa_run_items WHERE run_id = $1', [id]);
    const { rowCount: convsDeleted } = await pool.query(`
      DELETE FROM qa_conversations c
      WHERE c.run_id = $1
        AND NOT EXISTS (SELECT 1 FROM qa_run_items ri WHERE ri.conv_id = c.id)
    `, [id]);
    await pool.query('DELETE FROM qa_runs WHERE id = $1', [id]);
    res.json({ success: true, deleted: { run: id, conversations: convsDeleted } });
  } catch (err) {
    console.error('deleteRun error:', err);
    res.status(500).json({ error: 'Failed to delete run' });
  }
}

// GET /qa/conversations — scored chats (list view, no transcript), paginated
async function listConversations(req, res) {
  try {
    const { where, params } = convFilters(req.query);
    const pageSize = Math.max(1, Math.min(50, parseInt(req.query.pageSize, 10) || 10));
    const pageNum  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset   = (pageNum - 1) * pageSize;

    const [{ rows: cnt }, { rows }] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM qa_conversations ${where}`, params),
      pool.query(`
        SELECT id, page_id, page_name, conversation_id, customer_name, agent_name,
               msg_count, first_response_sec, max_gap_sec, last_msg_at,
               overall, red_flags, sentiment_end, followthrough, summary, analyzed_at
        FROM qa_conversations ${where}
        ORDER BY last_msg_at DESC NULLS LAST
        LIMIT ${pageSize} OFFSET ${offset}
      `, params),
    ]);
    res.json({ success: true, total: cnt[0].total, page: pageNum, pageSize, conversations: rows.map(r => ({
      id: r.id, pageId: r.page_id, pageName: r.page_name, conversationId: r.conversation_id,
      customerName: r.customer_name, agentName: r.agent_name, msgCount: r.msg_count,
      firstResponseSec: r.first_response_sec, maxGapSec: r.max_gap_sec, lastMsgAt: r.last_msg_at,
      overall: r.overall, redFlags: r.red_flags || [], sentimentEnd: r.sentiment_end,
      followthrough: r.followthrough, summary: r.summary, analyzedAt: r.analyzed_at,
    })) });
  } catch (err) {
    console.error('listConversations error:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
}

// GET /qa/conversations/:id — full detail with transcript + scores
async function getConversation(req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM qa_conversations WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (!rows.length) return res.status(404).json({ error: 'Conversation not found' });
    const r = rows[0];
    // Booking outcome: CRM bookings created −1…+7 days around the chat, matched by phone
    let linkedBookings = [];
    if (r.customer_phone && r.last_msg_at) {
      try {
        const { rows: lb } = await pool.query(`
          SELECT booking_date, appointment_date, booking_status, total_price, agent, branch, treatment
          FROM bookings
          WHERE record_status <> 'DELETED' AND COALESCE(phone_norm,'') <> ''
            AND RIGHT(phone_norm, 10) = RIGHT($1, 10)
            AND booking_date BETWEEN ($2::date - 1) AND ($2::date + 7)
          ORDER BY booking_date LIMIT 3
        `, [r.customer_phone, r.last_msg_at]);
        linkedBookings = lb.map(b => ({
          bookingDate: b.booking_date, appointmentDate: b.appointment_date,
          status: b.booking_status, totalPrice: parseFloat(b.total_price) || 0,
          agent: b.agent, branch: b.branch, treatment: b.treatment,
        }));
      } catch { /* attribution is best-effort */ }
    }
    res.json({ success: true, conversation: {
      linkedBookings, hasPhone: !!r.customer_phone,
      id: r.id, pageId: r.page_id, pageName: r.page_name, conversationId: r.conversation_id,
      customerName: r.customer_name, agentName: r.agent_name, agentNames: r.agent_names || [],
      msgCount: r.msg_count, agentMsgCount: r.agent_msg_count, customerMsgCount: r.customer_msg_count,
      firstResponseSec: r.first_response_sec, maxGapSec: r.max_gap_sec,
      startedAt: r.started_at, lastMsgAt: r.last_msg_at,
      transcript: r.transcript || [], overall: r.overall, scores: r.scores || {},
      redFlags: r.red_flags || [], sentimentStart: r.sentiment_start, sentimentEnd: r.sentiment_end,
      followthrough: r.followthrough, summary: r.summary, coachingTip: r.coaching_tip,
      model: r.model, analyzedAt: r.analyzed_at,
    } });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch conversation' }); }
}

// GET /qa/stats — KPI strip + agent leaderboard for the current filters
async function getStats(req, res) {
  try {
    const { where, params } = convFilters(req.query);
    const [{ rows: kpi }, { rows: agents }] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int AS analyzed,
               ROUND(AVG(overall))::int AS avg_score,
               COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(red_flags,'[]'::jsonb)) > 0)::int AS flagged,
               PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_response_sec) AS median_first_response,
               COUNT(*) FILTER (WHERE (scores->'closing'->>'score')::numeric >= 7)::int AS strong_closing
        FROM qa_conversations ${where}
      `, params),
      pool.query(`
        SELECT agent_name,
               COUNT(*)::int AS convs,
               ROUND(AVG(overall))::int AS avg_score,
               COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(red_flags,'[]'::jsonb)) > 0)::int AS flagged,
               ROUND(AVG((scores->'greeting'->>'score')::numeric), 1)       AS greeting,
               ROUND(AVG((scores->'responsiveness'->>'score')::numeric), 1) AS responsiveness,
               ROUND(AVG((scores->'accuracy'->>'score')::numeric), 1)       AS accuracy,
               ROUND(AVG((scores->'tone_empathy'->>'score')::numeric), 1)   AS tone_empathy,
               ROUND(AVG((scores->'clarity'->>'score')::numeric), 1)        AS clarity,
               ROUND(AVG((scores->'compliance'->>'score')::numeric), 1)     AS compliance,
               ROUND(AVG((scores->'closing'->>'score')::numeric), 1)        AS closing,
               ROUND(AVG(first_response_sec))::int AS avg_first_response
        FROM qa_conversations ${where} AND agent_name IS NOT NULL
        GROUP BY agent_name ORDER BY avg_score DESC NULLS LAST
      `, params),
    ]);
    // Score distribution + daily trend for the overview charts
    const [{ rows: dist }, { rows: trend }] = await Promise.all([
      pool.query(`
        SELECT COUNT(*) FILTER (WHERE overall >= 80)::int AS great,
               COUNT(*) FILTER (WHERE overall BETWEEN 60 AND 79)::int AS ok,
               COUNT(*) FILTER (WHERE overall BETWEEN 40 AND 59)::int AS weak,
               COUNT(*) FILTER (WHERE overall < 40)::int AS bad
        FROM qa_conversations ${where}
      `, params),
      pool.query(`
        SELECT to_char(last_msg_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS day,
               ROUND(AVG(overall))::int AS avg_score, COUNT(*)::int AS convs
        FROM qa_conversations ${where} AND last_msg_at IS NOT NULL
        GROUP BY 1 ORDER BY 1
      `, params),
    ]);

    const k = kpi[0] || {};
    res.json({ success: true, today: phFmt.format(Date.now()),
      distribution: dist[0] || { great: 0, ok: 0, weak: 0, bad: 0 },
      trend: trend.map(t => ({ day: t.day, avgScore: t.avg_score, convs: t.convs })),
      stats: {
      analyzed: k.analyzed || 0,
      avgScore: k.avg_score,
      flagged: k.flagged || 0,
      medianFirstResponseSec: k.median_first_response != null ? Math.round(k.median_first_response) : null,
      bookingPushRate: k.analyzed ? Math.round((k.strong_closing / k.analyzed) * 100) : null,
    }, agents: agents.map(a => ({
      agentName: a.agent_name, convs: a.convs, avgScore: a.avg_score, flagged: a.flagged,
      criteria: {
        greeting: a.greeting, responsiveness: a.responsiveness, accuracy: a.accuracy,
        tone_empathy: a.tone_empathy, clarity: a.clarity, compliance: a.compliance, closing: a.closing,
      },
      avgFirstResponseSec: a.avg_first_response,
    })) });
  } catch (err) {
    console.error('getStats error:', err);
    res.status(500).json({ error: 'Failed to compute stats' });
  }
}

// GET /qa/pages/:pageId/workload?from&to — per-agent assigned chats + response
// rate across ALL conversations of the page (not just the GPT-sampled ones).
// Assigned = conversations where the agent is in current_assign_users;
// responded/messages/response-time come from Pancake's own staff statistics.
const workloadCache = new Map(); // key → { at, data }
async function getWorkload(req, res) {
  try {
    const pageId = req.params.pageId;
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')   ? req.query.to   : phFmt.format(Date.now());
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : phFmt.format(Date.now() - 6 * 86400000);
    const key = `${pageId}|${from}|${to}`;
    const hit = workloadCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return res.json(hit.data);

    const page = await pancake.getPage(pageId);
    if (!page) return res.status(404).json({ error: 'Page not configured or has no API token' });

    const sinceUnix = Math.floor(new Date(`${from}T00:00:00+08:00`).getTime() / 1000);
    const untilUnix = Math.floor(new Date(`${to}T23:59:59+08:00`).getTime() / 1000);
    const days = Math.max(1, Math.round((untilUnix - sinceUnix) / 86400));

    const [convs, stats] = await Promise.all([
      // Busy pages run past 1,500 chats in a week — scan deeper for workload counts
      pancake.listConversations(page, { sinceUnix, untilUnix, maxPages: 60 }),
      pancake.getUserStatistics(page, from, to).catch(() => ({})),
    ]);

    // Assigned conversations per agent (a chat with 2 assignees counts for both)
    const assigned = {};
    for (const c of convs) {
      for (const u of (c.current_assign_users || [])) {
        const name = (u.name || '').trim();
        if (name) assigned[name] = (assigned[name] || 0) + 1;
      }
    }
    // Pancake per-staff totals, keyed back by display name
    const pstats = {};
    for (const [, u] of Object.entries(stats.users || {})) {
      const name = (u.user_name || '').trim();
      if (!name) continue;
      pstats[name] = {
        messagesSent: (u.inbox_count || 0) + (u.comment_count || 0),
        respondedUnique: u.unique_inbox_count || 0,
        avgResponseSec: u.average_response_time ? Math.round(u.average_response_time / 1000) : null,
      };
    }

    const names = [...new Set([...Object.keys(assigned), ...Object.keys(pstats)])];
    const agents = names.map(name => {
      const a = assigned[name] || 0;
      const s = pstats[name] || {};
      return {
        agentName: name,
        assigned: a,
        assignedPerDay: a ? Math.round((a / days) * 10) / 10 : 0,
        respondedUnique: s.respondedUnique ?? null,
        responseRate: a > 0 && s.respondedUnique != null ? Math.min(100, Math.round((s.respondedUnique / a) * 100)) : null,
        messagesSent: s.messagesSent ?? null,
        avgResponseSec: s.avgResponseSec ?? null,
      };
    }).filter(x => x.assigned > 0 || x.messagesSent > 0)
      .sort((x, y) => (y.assigned - x.assigned));

    const payload = { success: true, from, to, days, totalConversations: convs.length, agents };
    workloadCache.set(key, { at: Date.now(), data: payload });
    res.json(payload);
  } catch (err) {
    console.error('getWorkload error:', err);
    res.status(502).json({ error: err.message || 'Failed to load workload stats' });
  }
}

// GET /qa/agents/:name/profile — everything needed for one agent's quality profile
async function getAgentProfile(req, res) {
  try {
    const name = String(req.params.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Agent name required' });
    const q = { ...req.query, agent: name };
    const { where, params } = convFilters(q);

    const [{ rows: head }, { rows: trend }, { rows: convs }, { rows: flagRows }, { rows: tips }] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int AS convs,
               ROUND(AVG(overall))::int AS avg_score,
               MIN(overall)::int AS min_score, MAX(overall)::int AS max_score,
               COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(red_flags,'[]'::jsonb)) > 0)::int AS flagged,
               ROUND(AVG(first_response_sec))::int AS avg_first_response,
               COUNT(*) FILTER (WHERE followthrough = false)::int AS left_unanswered,
               COUNT(*) FILTER (WHERE (scores->'closing'->>'score')::numeric >= 7)::int AS strong_closing,
               ROUND(AVG((scores->'greeting'->>'score')::numeric), 1)       AS greeting,
               ROUND(AVG((scores->'responsiveness'->>'score')::numeric), 1) AS responsiveness,
               ROUND(AVG((scores->'accuracy'->>'score')::numeric), 1)       AS accuracy,
               ROUND(AVG((scores->'tone_empathy'->>'score')::numeric), 1)   AS tone_empathy,
               ROUND(AVG((scores->'clarity'->>'score')::numeric), 1)        AS clarity,
               ROUND(AVG((scores->'compliance'->>'score')::numeric), 1)     AS compliance,
               ROUND(AVG((scores->'closing'->>'score')::numeric), 1)        AS closing
        FROM qa_conversations ${where}
      `, params),
      pool.query(`
        SELECT to_char(last_msg_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS day,
               ROUND(AVG(overall))::int AS avg_score, COUNT(*)::int AS convs
        FROM qa_conversations ${where} AND last_msg_at IS NOT NULL
        GROUP BY 1 ORDER BY 1
      `, params),
      pool.query(`
        SELECT id, page_name, customer_name, msg_count, first_response_sec, last_msg_at,
               overall, red_flags, summary
        FROM qa_conversations ${where}
        ORDER BY last_msg_at DESC NULLS LAST LIMIT 50
      `, params),
      pool.query(`
        SELECT LOWER(f.value #>> '{}') AS flag, COUNT(*)::int AS n
        FROM qa_conversations, LATERAL jsonb_array_elements(COALESCE(red_flags,'[]'::jsonb)) f
        ${where}
        GROUP BY 1 ORDER BY n DESC LIMIT 10
      `, params),
      pool.query(`
        SELECT coaching_tip FROM qa_conversations ${where}
        AND coaching_tip IS NOT NULL AND coaching_tip <> ''
        ORDER BY analyzed_at DESC LIMIT 6
      `, params),
    ]);

    const { rows: insRows } = await pool.query('SELECT * FROM qa_agent_insights WHERE agent_name = $1', [name]);
    const ins = insRows[0];

    const h = head[0] || {};
    res.json({ success: true, profile: {
      insight: ins ? {
        crmAgent: ins.crm_agent, strengths: ins.strengths || [], weaknesses: ins.weaknesses || [],
        allTimeConvs: ins.convs_scored, allTimeAvg: ins.avg_score,
        bookingContext: ins.booking_context, updatedAt: ins.updated_at,
      } : null,
      agentName: name,
      convs: h.convs || 0,
      avgScore: h.avg_score, minScore: h.min_score, maxScore: h.max_score,
      flagged: h.flagged || 0, leftUnanswered: h.left_unanswered || 0,
      avgFirstResponseSec: h.avg_first_response,
      bookingPushRate: h.convs ? Math.round((h.strong_closing / h.convs) * 100) : null,
      criteria: {
        greeting: h.greeting, responsiveness: h.responsiveness, accuracy: h.accuracy,
        tone_empathy: h.tone_empathy, clarity: h.clarity, compliance: h.compliance, closing: h.closing,
      },
      trend: trend.map(t => ({ day: t.day, avgScore: t.avg_score, convs: t.convs })),
      flags: flagRows.map(f => ({ flag: f.flag, count: f.n })),
      coachingTips: tips.map(t => t.coaching_tip),
      conversations: convs.map(r => ({
        id: r.id, pageName: r.page_name, customerName: r.customer_name, msgCount: r.msg_count,
        firstResponseSec: r.first_response_sec, lastMsgAt: r.last_msg_at,
        overall: r.overall, redFlags: r.red_flags || [], summary: r.summary,
      })),
    } });
  } catch (err) {
    console.error('getAgentProfile error:', err);
    res.status(500).json({ error: 'Failed to load agent profile' });
  }
}

// GET /qa/agents/:name/scorecard?from&to&crmAgent=
// Booking-performance scorecard for one agent (mirrors the team's Google-Sheet
// coaching card). The Pancake chat name rarely equals the CRM booking agent
// name, so we auto-match and let the caller override via crmAgent.
async function getAgentScorecard(req, res) {
  try {
    const pancakeName = String(req.params.name || '').trim();
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')   ? req.query.to   : phFmt.format(Date.now());
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : phFmt.format(Date.now() - 6 * 86400000);

    // Distinct CRM booking agents (for the match + the override dropdown)
    const { rows: agentRows } = await pool.query(`
      SELECT DISTINCT TRIM(agent) AS agent FROM bookings
      WHERE record_status <> 'DELETED' AND NULLIF(TRIM(agent), '') IS NOT NULL
    `);
    const crmAgents = [...new Set(agentRows.map(r => r.agent))].sort((a, b) => a.localeCompare(b));

    // Auto-match: a CRM agent whose name appears as a whole word inside the
    // Pancake name (e.g. "HERA RAP" → "RAP"), longest match wins.
    let matched = (req.query.crmAgent || '').trim();
    if (!matched) {
      const words = pancakeName.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
      let best = '';
      for (const a of crmAgents) {
        const au = a.toUpperCase();
        const aWords = au.split(/[^A-Z0-9]+/).filter(Boolean);
        const hit = aWords.length > 0 && aWords.every(w => words.includes(w));
        if (hit && au.length > best.length) best = a;
      }
      matched = best;
    }

    let metrics = null;
    if (matched) {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE booking_date >= $2::date AND booking_date <= $3::date)::int AS bookings_created,
          COUNT(*) FILTER (WHERE appointment_date >= $2::date AND appointment_date <= $3::date)::int AS appts,
          COUNT(*) FILTER (WHERE appointment_date >= $2::date AND appointment_date <= $3::date
            AND LOWER(booking_status) IN ('arrived & bought','arrived not potential')
            AND COALESCE(underage_status,'Approved') = 'Approved' AND COALESCE(db_status,'Approved') = 'Approved'
            AND NOT COALESCE(cancel_validation, false))::int AS arrived,
          COUNT(*) FILTER (WHERE appointment_date >= $2::date AND appointment_date <= $3::date
            AND LOWER(booking_status) = 'no show')::int AS no_shows,
          COUNT(*) FILTER (WHERE appointment_date >= $2::date AND appointment_date <= $3::date
            AND LOWER(booking_status) LIKE '%cancel%')::int AS cancelled,
          COUNT(*) FILTER (WHERE appointment_date >= $2::date AND appointment_date <= $3::date
            AND LOWER(booking_status) IN ('arrived & bought','comeback & bought'))::int AS bought,
          COALESCE(SUM(total_price) FILTER (WHERE appointment_date >= $2::date AND appointment_date <= $3::date
            AND LOWER(booking_status) IN ('arrived & bought','comeback & bought','arrived not potential')), 0) AS revenue
        FROM bookings
        WHERE record_status <> 'DELETED' AND LOWER(TRIM(agent)) = LOWER($1)
      `, [matched, from, to]);
      const m = rows[0];
      const pct = (n, d) => d > 0 ? Math.round((n / d) * 1000) / 10 : null;
      metrics = {
        bookingsCreated: m.bookings_created,
        appointments: m.appts,
        arrived: m.arrived,
        showRate: pct(m.arrived, m.appts),
        noShowRate: pct(m.no_shows, m.appts),
        cancelRate: pct(m.cancelled, m.appts),
        conversionRate: pct(m.bought, m.arrived),
        revenue: parseFloat(m.revenue) || 0,
        revenuePerArrival: m.arrived > 0 ? Math.round((parseFloat(m.revenue) || 0) / m.arrived) : null,
      };
    }

    // Chat QA % over the same window (by the Pancake name)
    const { rows: qaRows } = await pool.query(`
      SELECT ROUND(AVG(overall))::int AS avg_score, COUNT(*)::int AS convs,
             COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(red_flags,'[]'::jsonb)) > 0)::int AS flagged
      FROM qa_conversations
      WHERE overall IS NOT NULL AND LOWER(COALESCE(agent_name,'')) LIKE $1
        AND last_msg_at >= $2::timestamptz AND last_msg_at <= $3::timestamptz
    `, [`%${pancakeName.toLowerCase()}%`, `${from}T00:00:00+08:00`, `${to}T23:59:59+08:00`]);

    res.json({ success: true, from, to,
      pancakeName, matchedCrmAgent: matched || null, crmAgents,
      metrics,
      chatQa: { avgScore: qaRows[0].avg_score, convs: qaRows[0].convs, flagged: qaRows[0].flagged },
    });
  } catch (err) {
    console.error('getAgentScorecard error:', err);
    res.status(500).json({ error: 'Failed to build scorecard' });
  }
}

// GET /qa/ratings?from&to — Agent Capability Index leaderboard (defaults: last 30 days)
async function getRatings(req, res) {
  try {
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')   ? req.query.to   : phFmt.format(Date.now());
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : phFmt.format(Date.now() - 29 * 86400000);
    res.json({ success: true, ...(await rating.computeRatings(from, to)) });
  } catch (err) {
    console.error('getRatings error:', err);
    res.status(500).json({ error: 'Failed to compute agent ratings' });
  }
}

// GET /qa/agent-map — Pancake agents with their confirmed/suggested CRM match
async function getAgentMap(req, res) {
  try { res.json({ success: true, ...(await rating.listAgentMap()) }); }
  catch (err) { res.status(500).json({ error: 'Failed to load agent mapping' }); }
}

// PUT /qa/agent-map — confirm one mapping ({ pancakeName, crmAgent|null })
async function putAgentMap(req, res) {
  try {
    const pancakeName = String(req.body.pancakeName || '').trim();
    if (!pancakeName) return res.status(400).json({ error: 'pancakeName is required' });
    const crmAgent = req.body.crmAgent ? String(req.body.crmAgent).trim() : null;
    await rating.saveAgentMap(pancakeName, crmAgent, req.user?.name || req.user?.email);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to save mapping' }); }
}

// GET/PUT /qa/settings/aci-weights — tunable ACI component weights
async function getAciWeights(req, res) {
  try { res.json({ success: true, weights: await rating.getWeights(), defaults: rating.DEFAULT_WEIGHTS }); }
  catch (err) { res.status(500).json({ error: 'Failed to load weights' }); }
}
async function putAciWeights(req, res) {
  try {
    const weights = await rating.saveWeights(req.body.weights, req.user?.name || req.user?.email);
    res.json({ success: true, weights });
  } catch (err) { res.status(400).json({ error: err.message || 'Failed to save weights' }); }
}

module.exports = { getPagesList, getPageAgents, startRun, listRuns, getRun, deleteRun, listConversations, getConversation, getStats, getAgentProfile, getWorkload, getAgentScorecard, getRatings, getAgentMap, putAgentMap, getAciWeights, putAciWeights };
