'use strict';
// Thin Pancake (pages.fm) API client for the Chat QA module.
//
// Preferred config — ONE env var, pages discovered dynamically:
//   PANCAKE_USER_TOKEN=<user access token from pages.fm → Account → Personal Settings>
//   (lists every page the account manages; for pages where the user is admin the
//    page_access_token comes back in settings, so nothing else to paste)
//
// Optional manual additions/overrides (e.g. pages where the user is not admin):
//   PANCAKE_PAGES=Label|page_id|page_access_token,Label2|page_id2|token2
const axios = require('axios');

const USER_API = 'https://pages.fm/api/v1';
const V1 = 'https://pages.fm/api/public_api/v1';
const V2 = 'https://pages.fm/api/public_api/v2';

function manualPages() {
  return String(process.env.PANCAKE_PAGES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      const [label, pageId, token] = entry.split('|').map(p => (p || '').trim());
      return { label: label || pageId, pageId, token, platform: 'manual' };
    })
    .filter(p => p.pageId && p.token);
}

// ── Dynamic page discovery via the user token (cached 10 min) ───────────────
let pageCache = { at: 0, pages: [] };

async function fetchPagesViaUserToken() {
  const userToken = (process.env.PANCAKE_USER_TOKEN || process.env.PANCAKE_ACCESS_TOKEN || '').trim();
  if (!userToken) return [];
  const res = await axios.get(`${USER_API}/pages`, {
    params: { access_token: userToken, fields: 'activated{id,name,platform,settings{page_access_token}}' },
    timeout: 30000,
    validateStatus: () => true,
  });
  if (res.status === 401) throw new Error('PANCAKE_USER_TOKEN is invalid or expired (it lasts up to 90 days) — copy a fresh one from pages.fm → Account → Personal Settings');
  if (res.status >= 400 || res.data?.success === false) {
    throw new Error(`Pancake /pages → HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  const activated = res.data?.categorized?.activated || res.data?.pages?.categorized?.activated || res.data?.pages || [];
  const list = Array.isArray(activated) ? activated : [];
  const pages = [];
  for (const p of list) {
    let token = p.settings?.page_access_token || '';
    let tokenError = '';
    // No token yet (and none to invalidate) → generate one, once; it then
    // persists in the page's settings on Pancake's side.
    if (!token) {
      try {
        const gen = await axios.post(`${USER_API}/pages/${p.id}/generate_page_access_token`, null, {
          params: { access_token: userToken, page_id: p.id },
          timeout: 30000,
          validateStatus: () => true,
        });
        token = gen.data?.page_access_token || gen.data?.data?.page_access_token || '';
        if (!token) {
          // e.g. "No subscriptions found" (page has no Pancake plan) or
          // "Missing administer permission" (our account isn't admin there)
          tokenError = gen.data?.message || gen.data?.errors?.[0]?.message || 'Could not generate a page token';
        }
      } catch (err) { tokenError = err.message; }
    }
    pages.push({ label: p.name || p.id, pageId: String(p.id), token, tokenError, platform: p.platform || 'facebook' });
  }
  return pages;
}

async function getPages({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && pageCache.pages.length && now - pageCache.at < 10 * 60 * 1000) return pageCache.pages;

  let dynamic = [];
  try {
    dynamic = await fetchPagesViaUserToken();
  } catch (err) {
    console.error('[pancake] page discovery failed:', err.message);
    if (!manualPages().length) throw err; // nothing to fall back to
  }
  // Manual entries override/extend discovered ones (by page_id)
  const byId = new Map(dynamic.map(p => [p.pageId, p]));
  for (const m of manualPages()) byId.set(m.pageId, { ...byId.get(m.pageId), ...m });

  const pages = [...byId.values()];
  pageCache = { at: now, pages };
  return pages;
}

async function getPage(pageId) {
  const pages = await getPages();
  return pages.find(p => p.pageId === String(pageId) && p.token) || null;
}

// Rate limit: Pancake allows 5 req/s per page — we space calls ≥250ms per page.
const lastCallAt = {};
async function throttled(pageId) {
  const since = Date.now() - (lastCallAt[pageId] || 0);
  if (since < 250) await new Promise(r => setTimeout(r, 250 - since));
  lastCallAt[pageId] = Date.now();
}

async function pancakeGet(page, base, path, params = {}) {
  await throttled(page.pageId);
  const res = await axios.get(`${base}${path}`, {
    params: { ...params, page_access_token: page.token },
    timeout: 30000,
    validateStatus: () => true,
  });
  if (res.status === 429) { // back off once and retry
    await new Promise(r => setTimeout(r, 1200));
    return pancakeGet(page, base, path, params);
  }
  if (res.status >= 400) {
    throw new Error(`Pancake ${path} → HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  if (res.data && res.data.success === false) {
    throw new Error(`Pancake ${path} → ${JSON.stringify(res.data).slice(0, 200)}`);
  }
  return res.data;
}

// Staff list — maps Pancake user UUIDs to display names.
async function listUsers(page) {
  const data = await pancakeGet(page, V1, `/pages/${page.pageId}/users`);
  return (data.users || []).map(u => ({ id: u.id, name: u.name }));
}

// Conversations in [sinceUnix, untilUnix], newest first.
// Paginates via last_conversation_id up to maxPages requests.
async function listConversations(page, { sinceUnix, untilUnix, maxPages = 25 }) {
  const fields = 'id,type,snippet,message_count,inserted_at,updated_at,last_sent_by,assignee_ids,current_assign_users,customers,recent_phone_numbers';
  // The API's since/until proved unreliable in practice, so the window is also
  // enforced here on updated_at, and pagination stops once a batch falls
  // entirely before `since` (results come newest-first by updated_at).
  const toUnix = (s) => Math.floor(new Date(`${s}Z`).getTime() / 1000);
  const all = [];
  let lastId;
  for (let i = 0; i < maxPages; i++) {
    const params = { since: sinceUnix, until: untilUnix, order_by: 'updated_at', fields };
    if (lastId) params.last_conversation_id = lastId;
    const data = await pancakeGet(page, V2, `/pages/${page.pageId}/conversations`, params);
    const convs = data.conversations || [];
    if (!convs.length) break;
    for (const c of convs) {
      const u = c.updated_at ? toUnix(c.updated_at) : null;
      if (u != null && u >= sinceUnix && u <= untilUnix) all.push(c);
    }
    const oldest = convs[convs.length - 1];
    if (oldest.updated_at && toUnix(oldest.updated_at) < sinceUnix) break;
    if (convs.length < 60) break;
    lastId = oldest.id;
  }
  return all;
}

// Message history of one conversation, oldest → newest.
// The API serves 30 newest per call; `current_count` pages further back.
// stopBeforeUnix: stop paginating into older history once a batch dips below
// that time — the QA window never needs messages from months ago.
async function listMessages(page, conversationId, { maxMessages = 300, stopBeforeUnix = null } = {}) {
  const collected = [];
  let currentCount;
  while (collected.length < maxMessages) {
    const params = {};
    if (currentCount !== undefined) params.current_count = currentCount;
    const data = await pancakeGet(page, V1, `/pages/${page.pageId}/conversations/${encodeURIComponent(conversationId)}/messages`, params);
    const msgs = data.messages || [];
    if (!msgs.length) break;
    collected.push(...msgs);
    if (msgs.length < 30) break;
    if (stopBeforeUnix) {
      const oldest = msgs[msgs.length - 1]; // batches arrive newest → oldest
      if (oldest.inserted_at && new Date(`${oldest.inserted_at}Z`).getTime() / 1000 < stopBeforeUnix) break;
    }
    currentCount = collected.length;
  }
  // API returns newest → oldest; flip to reading order and de-dup by id.
  const seen = new Set();
  return collected
    .filter(m => { const k = m.id || `${m.inserted_at}|${m.message}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => String(a.inserted_at).localeCompare(String(b.inserted_at)));
}

// Staff interaction statistics for a date range (page-local timezone — PH pages are UTC+8).
// Returns Pancake's own per-staff totals: inbox_count (messages sent),
// unique_inbox_count (conversations responded to), average_response_time (ms).
async function getUserStatistics(page, fromDate, toDate) {
  const fmt = (d, hms) => { const [y, m, day] = d.split('-'); return `${day}/${m}/${y} ${hms}`; };
  const date_range = `${fmt(fromDate, '00:00:00')} - ${fmt(toDate, '23:59:59')}`;
  const data = await pancakeGet(page, V1, `/pages/${page.pageId}/statistics/users`, { date_range });
  return data.data || {};
}

module.exports = { getPages, getPage, listUsers, listConversations, listMessages, getUserStatistics };
