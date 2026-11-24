'use strict';
// Chat QA engine: builds sanitized transcripts from Pancake messages, scores
// them with GPT against the clinic rubric, and persists results.
const axios = require('axios');
const pool = require('../db/pool');
const pancake = require('./pancake.service');

// ── Rubric (weights sum to 100) ──────────────────────────────────────────────
const RUBRIC = [
  ['greeting',       10, 'Proper opening: brand greeting, polite, uses the customer name when known.'],
  ['responsiveness', 15, 'Judge reply speed from the timestamps: first response to the customer and the worst gap mid-conversation. Long unexplained gaps score low.'],
  ['accuracy',       20, 'Prices, treatments, branches and schedule information are stated confidently and consistently; no invented promos or contradictions within the chat.'],
  ['tone_empathy',   15, 'Warm, respectful, empathetic; handles irritation or hesitation well. Chats mix Tagalog and English (Taglish) — judge the tone in whichever language is used.'],
  ['clarity',        10, 'Clear, complete, well-structured answers; not walls of text; answers the actual question.'],
  ['compliance',     10, 'No over-promising of medical results, no unprofessional language. Sharing the CLINIC\'s official phone number or branch contact details is normal and allowed — only penalize if the agent clearly shares a PERSONAL/private number (e.g. "my personal cp", "text me on my own number").'],
  ['closing',        20, 'Drove toward a booking: asked for preferred date/branch, confirmed an appointment, or set a concrete follow-up. A chat that fizzles with no attempt scores low.'],
];

function overallFromScores(scores) {
  let total = 0;
  for (const [key, weight] of RUBRIC) {
    const s = Number(scores?.[key]?.score);
    total += (Number.isFinite(s) ? Math.max(0, Math.min(10, s)) : 0) * weight;
  }
  return Math.round(total / 10); // 0–100
}

// ── Transcript building ──────────────────────────────────────────────────────
const maskPII = (text) =>
  String(text || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/(\+?\d[\d\s\-().]{6,}\d)/g, '[phone]');

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// Customer phone from a Pancake conversation, digits only (for booking attribution).
// Shapes vary across pages: customers[].phone_numbers may hold strings or objects,
// and recent_phone_numbers may hold strings or { phone_number } objects.
function extractPhone(conv) {
  const candidates = [];
  for (const cust of conv.customers || []) {
    for (const p of cust.phone_numbers || []) candidates.push(p);
  }
  for (const p of conv.recent_phone_numbers || []) candidates.push(p);
  for (const raw of candidates) {
    const s = typeof raw === 'string' ? raw : (raw?.phone_number || raw?.number || raw?.phone || '');
    const digits = String(s).replace(/\D/g, '');
    if (digits.length >= 7) return digits.slice(0, 40);
  }
  return null;
}

// window: { sinceMs, untilMs } — only messages inside the window are scored.
// Facebook threads live for years (the conversation is the customer), so without
// this the analysis would read history far older than the selected date range.
// Up to 4 pre-window lines are kept, flagged `context: true`, so GPT can judge
// the greeting/continuity without scoring old behavior.
function buildTranscript(messages, window = null) {
  const ts = (s) => new Date(`${s}Z`).getTime();
  let all = [];
  for (const m of messages) {
    const from = m.from || {};
    const isStaff = !!(from.admin_id || from.uid || from.admin_name);
    const automated = from.is_automated === true || from.ai_generated === true;
    const text = maskPII(stripHtml(m.original_message || m.message));
    if (!text && !automated) continue; // media-only message with no caption
    all.push({
      // Auto-replies come from the page itself with no admin attached — they are
      // 'auto' regardless of staff detection, and never affect agent scores.
      role: automated ? 'auto' : (isStaff ? 'agent' : 'customer'),
      name: isStaff || automated ? (from.admin_name || from.name || 'Staff') : (from.name || 'Customer'),
      text: text || '[attachment]',
      at: m.inserted_at,
      automated,
    });
  }

  let lines = all;
  if (window) {
    const inWindow = all.filter(l => { const t = ts(l.at); return t >= window.sinceMs && t <= window.untilMs; });
    const before   = all.filter(l => ts(l.at) < window.sinceMs);
    const context  = before.slice(-4).map(l => ({ ...l, context: true }));
    lines = [...context, ...inWindow];
  }
  const scored = lines.filter(l => !l.context);

  // Metrics from timestamps — review-period messages only
  let firstResponseSec = null, maxGapSec = 0, pendingCustomerAt = null;
  for (const l of scored) {
    if (l.role === 'customer') {
      if (pendingCustomerAt == null) pendingCustomerAt = ts(l.at);
    } else if (l.role === 'agent' && pendingCustomerAt != null) {
      const gap = Math.max(0, Math.round((ts(l.at) - pendingCustomerAt) / 1000));
      if (firstResponseSec == null) firstResponseSec = gap;
      if (gap > maxGapSec) maxGapSec = gap;
      pendingCustomerAt = null;
    }
  }

  const agentCounts = {};
  for (const l of scored) if (l.role === 'agent') agentCounts[l.name] = (agentCounts[l.name] || 0) + 1;
  const agentNames = Object.keys(agentCounts).sort((a, b) => agentCounts[b] - agentCounts[a]);

  return {
    lines, // context lines (flagged) + review-period lines
    agentNames,
    primaryAgent: agentNames[0] || null,
    agentMsgCount: scored.filter(l => l.role === 'agent').length,
    customerMsgCount: scored.filter(l => l.role === 'customer').length,
    firstResponseSec,
    maxGapSec,
    startedAt: scored[0]?.at || null,
    lastMsgAt: scored[scored.length - 1]?.at || null,
    endedByCustomer: scored.length > 0 && scored[scored.length - 1].role === 'customer',
  };
}

// ── Learning context ─────────────────────────────────────────────────────────
// What the reviewer "knows" about an agent before scoring: their QA history
// (from qa_agent_insights) plus their real booking performance for the period
// (from Master Bookings). Passed to GPT as calibration, never as the verdict.

const CRIT_LABELS = Object.fromEntries(RUBRIC.map(([k]) => [k, k.replace('_', ' ')]));

async function matchCrmAgent(pancakeName) {
  const { rows } = await pool.query(`
    SELECT DISTINCT TRIM(agent) AS agent FROM bookings
    WHERE record_status <> 'DELETED' AND NULLIF(TRIM(agent), '') IS NOT NULL`);
  const words = String(pancakeName).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  let best = '';
  for (const r of rows) {
    const aWords = r.agent.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    if (aWords.length && aWords.every(w => words.includes(w)) && r.agent.length > best.length) best = r.agent;
  }
  return best || null;
}

async function bookingStatsFor(crmAgent, fromDate, toDate) {
  if (!crmAgent) return null;
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS appts,
           COUNT(*) FILTER (WHERE LOWER(booking_status) IN ('arrived & bought','arrived not potential'))::int AS arrived,
           COUNT(*) FILTER (WHERE LOWER(booking_status) LIKE '%cancel%')::int AS cancelled,
           COUNT(*) FILTER (WHERE LOWER(booking_status) IN ('arrived & bought','comeback & bought'))::int AS bought
    FROM bookings
    WHERE record_status <> 'DELETED' AND LOWER(TRIM(agent)) = LOWER($1)
      AND appointment_date >= $2::date AND appointment_date <= $3::date
  `, [crmAgent, fromDate, toDate]);
  const b = rows[0];
  if (!b.appts) return { appts: 0 };
  return {
    appts: b.appts, arrived: b.arrived, cancelled: b.cancelled, bought: b.bought,
    showRate: Math.round((b.arrived / b.appts) * 100),
    cancelRate: Math.round((b.cancelled / b.appts) * 100),
  };
}

async function getAgentLearning(agentName) {
  const { rows } = await pool.query('SELECT * FROM qa_agent_insights WHERE agent_name = $1', [agentName]);
  return rows[0] || null;
}

function contextBlock(agentName, insight, booking) {
  const parts = [];
  if (insight && insight.convs_scored > 0) {
    parts.push(`QA history: ${insight.convs_scored} chats scored, average ${insight.avg_score}/100.`);
    if (insight.weaknesses?.length) parts.push(`Recurring weak areas: ${insight.weaknesses.join(', ')}.`);
    if (insight.strengths?.length) parts.push(`Consistent strengths: ${insight.strengths.join(', ')}.`);
    const flags = (insight.top_flags || []).slice(0, 3).map(f => `${f.flag} ×${f.count}`).join('; ');
    if (flags) parts.push(`Past red flags: ${flags}.`);
  }
  if (booking) {
    parts.push(booking.appts === 0
      ? 'CRM bookings this period: none recorded.'
      : `CRM bookings this period: ${booking.appts} appointments, ${booking.showRate}% show rate, ${booking.cancelRate}% cancellations, ${booking.bought} purchases.`);
  }
  if (!parts.length) return '';
  return `\n\nREVIEWER CONTEXT about agent ${agentName} (calibration only — judge THIS chat on its own merits, but weigh known patterns when deciding borderline scores and the coaching tip):\n- ${parts.join('\n- ')}`;
}

// Refresh the learning store for the agents a run touched (pure SQL, no GPT cost)
async function refreshAgentInsights(agentNames, bookingByAgent = {}) {
  for (const name of agentNames) {
    try {
      const { rows } = await pool.query(`
        SELECT COUNT(*)::int AS convs, ROUND(AVG(overall))::int AS avg_score,
               ${RUBRIC.map(([k]) => `ROUND(AVG((scores->'${k}'->>'score')::numeric),1) AS ${k}`).join(', ')}
        FROM qa_conversations WHERE agent_name = $1 AND overall IS NOT NULL`, [name]);
      const r = rows[0];
      if (!r.convs) continue;
      const crits = Object.fromEntries(RUBRIC.map(([k]) => [k, r[k] != null ? Number(r[k]) : null]));
      const ranked = RUBRIC.map(([k]) => [k, crits[k]]).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]);
      const strengths  = ranked.slice(0, 2).filter(([, v]) => v >= 7).map(([k]) => CRIT_LABELS[k]);
      const weaknesses = ranked.slice(-2).filter(([, v]) => v < 6).map(([k]) => CRIT_LABELS[k]);

      const [{ rows: flagRows }, { rows: tipRows }, { rows: runCount }] = await Promise.all([
        pool.query(`SELECT LOWER(f.value #>> '{}') AS flag, COUNT(*)::int AS n
                    FROM qa_conversations, LATERAL jsonb_array_elements(COALESCE(red_flags,'[]'::jsonb)) f
                    WHERE agent_name = $1 GROUP BY 1 ORDER BY n DESC LIMIT 5`, [name]),
        pool.query(`SELECT coaching_tip FROM qa_conversations
                    WHERE agent_name = $1 AND NULLIF(coaching_tip,'') IS NOT NULL
                    ORDER BY analyzed_at DESC LIMIT 5`, [name]),
        pool.query(`SELECT COUNT(DISTINCT run_id)::int AS n FROM qa_conversations WHERE agent_name = $1`, [name]),
      ]);

      await pool.query(`
        INSERT INTO qa_agent_insights
          (agent_name, crm_agent, runs_count, convs_scored, avg_score, criteria_avgs,
           strengths, weaknesses, top_flags, recent_tips, booking_context, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
        ON CONFLICT (agent_name) DO UPDATE SET
          crm_agent = COALESCE(EXCLUDED.crm_agent, qa_agent_insights.crm_agent),
          runs_count = EXCLUDED.runs_count, convs_scored = EXCLUDED.convs_scored,
          avg_score = EXCLUDED.avg_score, criteria_avgs = EXCLUDED.criteria_avgs,
          strengths = EXCLUDED.strengths, weaknesses = EXCLUDED.weaknesses,
          top_flags = EXCLUDED.top_flags, recent_tips = EXCLUDED.recent_tips,
          booking_context = COALESCE(EXCLUDED.booking_context, qa_agent_insights.booking_context),
          updated_at = NOW()
      `, [name, bookingByAgent[name]?.crmAgent || null, runCount[0].n, r.convs, r.avg_score,
          JSON.stringify(crits), strengths, weaknesses,
          JSON.stringify(flagRows.map(f => ({ flag: f.flag, count: f.n }))),
          JSON.stringify(tipRows.map(t => t.coaching_tip)),
          bookingByAgent[name]?.stats ? JSON.stringify(bookingByAgent[name].stats) : null]);
    } catch (err) {
      console.error(`insight refresh failed for ${name}:`, err.message);
    }
  }
}

// ── GPT scoring ──────────────────────────────────────────────────────────────
function qaModel() { return process.env.OPENAI_QA_MODEL || 'gpt-4o-mini'; }

async function analyzeTranscript(t, agentContext = '') {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set in the server environment');

  const rubricText = RUBRIC.map(([k, w, d]) => `- ${k} (weight ${w}): ${d}`).join('\n');
  const convoText = t.lines
    .map(l => {
      const who = l.role === 'agent' ? `AGENT ${l.name}` : l.role === 'auto' ? 'AUTO-REPLY (bot — do not score)' : 'CUSTOMER';
      const prefix = l.context ? 'CONTEXT (older history — do not score) · ' : '';
      return `[${String(l.at).replace('T', ' ').slice(0, 16)}] ${prefix}${who}: ${l.text}`;
    })
    .join('\n');

  const system = `You are a strict but fair quality-assurance reviewer for a Philippine beauty-clinic's customer chat team. Chats are in English, Tagalog, or Taglish. Score ONLY the human agent's performance WITHIN THE REVIEW PERIOD; lines marked CONTEXT are older history shown only so you understand the thread — never score or penalize anything in them. Lines marked AUTO-REPLY are bot messages and must not affect scores. Timestamps are UTC.

Score each criterion 0-10 (10 = excellent):
${rubricText}

Respond with STRICT JSON only, exactly this shape:
{
  "scores": { "<criterion>": { "score": 0-10, "reason": "one short sentence" }, ... all 7 criteria ... },
  "red_flags": ["short flag", ...],          // empty array if none; e.g. "rude reply", "wrong price quoted", "ignored question", "shared personal number"
  "sentiment_start": "positive|neutral|negative",
  "sentiment_end": "positive|neutral|negative",
  "followthrough": true|false,                // see FOLLOWTHROUGH RULES below
  "summary": "two sentences: what the customer wanted and how it ended",
  "coaching_tip": "two sentences of concrete, kind advice for this agent"
}

FOLLOWTHROUGH RULES — be precise, false accusations here damage trust:
- followthrough = false ONLY when the customer's last substantive question or actionable request got no reply at all in the review period.
- If the agent answered the question and the chat simply ends with the customer saying thanks / ok / "sige" / an emoji / a reaction, or ends after the agent's answer, followthrough = true.
- A question answered ANYWHERE in the thread counts as answered — do not flag "ignored question" if it was addressed, even briefly or in a later message.

PHONE NUMBER RULES — numbers are masked as [phone] in the transcript:
- The clinic routinely shares its own branch/official numbers so customers can call or be called. That is ALLOWED: never flag "shared personal number" or penalize compliance just because a [phone] appears in an agent message.
- Only flag number sharing when the wording clearly shows a personal/private number ("my personal number", "my own cp", "text me privately").`;

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: qaModel(),
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Review this conversation:\n\n${convoText}${agentContext}` },
    ],
  }, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    timeout: 60000,
  });

  const usage = res.data.usage || {};
  let parsed;
  try {
    parsed = JSON.parse(res.data.choices[0].message.content);
  } catch {
    throw new Error('GPT returned non-JSON output');
  }
  return {
    scores: parsed.scores || {},
    overall: overallFromScores(parsed.scores),
    redFlags: Array.isArray(parsed.red_flags) ? parsed.red_flags.slice(0, 10) : [],
    sentimentStart: parsed.sentiment_start || null,
    sentimentEnd: parsed.sentiment_end || null,
    followthrough: parsed.followthrough !== false,
    summary: parsed.summary || '',
    coachingTip: parsed.coaching_tip || '',
    tokensIn: usage.prompt_tokens || 0,
    tokensOut: usage.completion_tokens || 0,
    model: qaModel(),
  };
}

// ── Run orchestration (fires in-process; the API returns immediately) ────────
async function executeRun(runId, { page, sinceUnix, untilUnix, agentFilter, sampleSize, force = false }) {
  const bump = (sets, vals = []) =>
    pool.query(`UPDATE qa_runs SET ${sets} WHERE id = $${vals.length + 1}`, [...vals, runId]).catch(() => {});

  try {
    let convs = await pancake.listConversations(page, { sinceUnix, untilUnix });
    convs = convs.filter(c => (c.type || 'INBOX').toUpperCase() === 'INBOX' && (c.message_count || 0) >= 3);

    if (agentFilter) {
      const want = agentFilter.toLowerCase();
      convs = convs.filter(c => (c.current_assign_users || []).some(u => (u.name || '').toLowerCase().includes(want)));
    }
    await bump('convs_found = $1', [convs.length]);

    // Cost reuse: chats already scored in a previous run join this run's report
    // for free — no message fetch from Pancake, no GPT call. The sample is then
    // spent only on chats we have never scored.
    let reused = 0;
    if (!force && convs.length) {
      const ids = convs.map(c => String(c.id));
      const { rows: existRows } = await pool.query(
        `SELECT id, conversation_id FROM qa_conversations
         WHERE page_id = $1 AND overall IS NOT NULL AND conversation_id = ANY($2)`,
        [page.pageId, ids]
      );
      if (existRows.length) {
        const values = existRows.map((_, i) => `($1, $${i + 2}, true)`).join(', ');
        await pool.query(
          `INSERT INTO qa_run_items (run_id, conv_id, reused) VALUES ${values}
           ON CONFLICT (run_id, conv_id) DO NOTHING`,
          [runId, ...existRows.map(r => r.id)]
        );
        reused = existRows.length;
        await bump('convs_reused = $1', [reused]);
        const known = new Set(existRows.map(r => r.conversation_id));
        convs = convs.filter(c => !known.has(String(c.id)));
      }
    }

    // Random sample so agents can't predict which chats get reviewed
    if (sampleSize && convs.length > sampleSize) {
      for (let i = convs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [convs[i], convs[j]] = [convs[j], convs[i]];
      }
      convs = convs.slice(0, sampleSize);
    }

    let analyzed = 0, skipped = 0, failed = 0, tin = 0, tout = 0;
    const window = { sinceMs: sinceUnix * 1000, untilMs: untilUnix * 1000 };
    const phFmtRun = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' });
    const fromDate = phFmtRun.format(sinceUnix * 1000), toDate = phFmtRun.format(untilUnix * 1000);
    const agentCtxCache = {};   // pancake agent name → context string
    const bookingByAgent = {};  // pancake agent name → { crmAgent, stats }
    const touchedAgents = new Set();

    const contextFor = async (agentName) => {
      if (!agentName) return '';
      if (agentCtxCache[agentName] !== undefined) return agentCtxCache[agentName];
      const [insight, crmAgent] = await Promise.all([getAgentLearning(agentName), matchCrmAgent(agentName)]);
      const stats = crmAgent ? await bookingStatsFor(crmAgent, fromDate, toDate) : null;
      bookingByAgent[agentName] = { crmAgent, stats };
      const ctx = contextBlock(agentName, insight, stats);
      agentCtxCache[agentName] = ctx;
      return ctx;
    };

    for (const c of convs) {
      try {
        if (!force) {
          const { rows: existing } = await pool.query(
            'SELECT id FROM qa_conversations WHERE page_id = $1 AND conversation_id = $2 AND overall IS NOT NULL',
            [page.pageId, c.id]
          );
          if (existing.length) { skipped++; await bump('convs_skipped = $1', [skipped]); continue; }
        }

        const messages = await pancake.listMessages(page, c.id, { stopBeforeUnix: sinceUnix });
        const t = buildTranscript(messages, window);
        // Requires a real exchange INSIDE the review period — threads that were
        // only bumped (tag/assign/seen) without new messages get skipped here.
        if (t.customerMsgCount < 2 || t.agentMsgCount < 1) { skipped++; await bump('convs_skipped = $1', [skipped]); continue; }
        if (agentFilter && !(t.agentNames.some(n => n.toLowerCase().includes(agentFilter.toLowerCase())))) { skipped++; await bump('convs_skipped = $1', [skipped]); continue; }

        const a = await analyzeTranscript(t, await contextFor(t.primaryAgent));
        if (t.primaryAgent) touchedAgents.add(t.primaryAgent);
        tin += a.tokensIn; tout += a.tokensOut;

        const customerName = (c.customers && c.customers[0]?.name) || c.from?.name || t.lines.find(l => l.role === 'customer')?.name || '';
        const customerPhone = extractPhone(c);
        await pool.query(`
          INSERT INTO qa_conversations
            (run_id, page_id, page_name, conversation_id, customer_name, customer_phone, agent_name, agent_names,
             msg_count, agent_msg_count, customer_msg_count, first_response_sec, max_gap_sec,
             started_at, last_msg_at, transcript, overall, scores, red_flags,
             sentiment_start, sentiment_end, followthrough, summary, coaching_tip, model, analyzed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,NOW())
          ON CONFLICT (page_id, conversation_id) DO UPDATE SET
            run_id = EXCLUDED.run_id, transcript = EXCLUDED.transcript, overall = EXCLUDED.overall,
            customer_phone = COALESCE(EXCLUDED.customer_phone, qa_conversations.customer_phone),
            scores = EXCLUDED.scores, red_flags = EXCLUDED.red_flags,
            sentiment_start = EXCLUDED.sentiment_start, sentiment_end = EXCLUDED.sentiment_end,
            followthrough = EXCLUDED.followthrough, summary = EXCLUDED.summary,
            coaching_tip = EXCLUDED.coaching_tip, model = EXCLUDED.model, analyzed_at = NOW()
          RETURNING id
        `, [
          runId, page.pageId, page.label, c.id, customerName, customerPhone, t.primaryAgent, t.agentNames,
          t.lines.length, t.agentMsgCount, t.customerMsgCount, t.firstResponseSec, t.maxGapSec,
          t.startedAt ? new Date(`${t.startedAt}Z`) : null, t.lastMsgAt ? new Date(`${t.lastMsgAt}Z`) : null,
          JSON.stringify(t.lines), a.overall, JSON.stringify(a.scores), JSON.stringify(a.redFlags),
          a.sentimentStart, a.sentimentEnd, a.followthrough, a.summary, a.coachingTip, a.model,
        ]).then(r =>
          pool.query(`INSERT INTO qa_run_items (run_id, conv_id, reused) VALUES ($1, $2, false)
                      ON CONFLICT (run_id, conv_id) DO UPDATE SET reused = false`, [runId, r.rows[0].id])
        );
        analyzed++;
        await bump('convs_analyzed = $1, tokens_in = $2, tokens_out = $3', [analyzed, tin, tout]);
      } catch (err) {
        console.error(`QA run ${runId}: conversation ${c.id} failed:`, err.message);
        failed++;
        await bump('convs_failed = $1', [failed]);
      }
    }
    // Learning pass: refresh the per-agent insight store with everything known so far
    await refreshAgentInsights([...touchedAgents], bookingByAgent);
    await bump(`status = 'Done', finished_at = NOW()`);
  } catch (err) {
    console.error(`QA run ${runId} failed:`, err.message);
    await bump(`status = 'Failed', error = $1, finished_at = NOW()`, [String(err.message).slice(0, 500)]);
  }
}

module.exports = { RUBRIC, buildTranscript, analyzeTranscript, overallFromScores, executeRun, maskPII };
