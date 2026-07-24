// index.js — Cloudflare Worker entry point.
//   GET  /             → server-rendered dashboard (clean light theme)
//   GET  /api/data     → parsed + classified dataset (JSON)
//   POST/PUT/DELETE /api/manual  → add / edit / remove a dashboard entry
//   POST/DELETE     /api/roster  → add / remove a team member or client
//   POST/DELETE     /api/update  → post / remove a dated status update
//   POST            /api/person  → set an employee's join date / attendance day
//
// All dashboards live in the KV namespace bound as MANUAL — there is no
// external Google Sheet. If MANUAL isn't bound, the board works read-only and
// the editing controls are hidden.
import { buildDataset, manualToDashboard, normalizeSections, STATES } from './classify.js';

const CACHE_SECONDS = 180;
const KV_KEY = 'manual_entries';
const KV_ROSTER = 'roster';
const KV_UPDATES = 'dashboard_updates';
const KV_PEOPLE = 'people';
const KV_CONFIG = 'config';
const KV_PRIORITY = 'priority';
const KV_CLIENTS = 'clients';
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4MB cap per uploaded file

async function kvGet(env, key, fallback) {
  if (!env.MANUAL) return fallback;
  const raw = await env.MANUAL.get(key);
  return raw ? JSON.parse(raw) : fallback;
}
const readManual = (env) => kvGet(env, KV_KEY, []);
const writeManual = (env, list) => env.MANUAL.put(KV_KEY, JSON.stringify(list));
const readRoster = (env) => kvGet(env, KV_ROSTER, { owners: [], customers: [] });
const writeRoster = (env, r) => env.MANUAL.put(KV_ROSTER, JSON.stringify(r));
const readUpdates = (env) => kvGet(env, KV_UPDATES, {});
const writeUpdates = (env, u) => env.MANUAL.put(KV_UPDATES, JSON.stringify(u));
const readPeople = (env) => kvGet(env, KV_PEOPLE, {});
const writePeople = (env, p) => env.MANUAL.put(KV_PEOPLE, JSON.stringify(p));
const readConfig = (env) => kvGet(env, KV_CONFIG, {});
const writeConfig = (env, c) => env.MANUAL.put(KV_CONFIG, JSON.stringify(c));
const readPriority = (env) => kvGet(env, KV_PRIORITY, {});
const writePriority = (env, p) => env.MANUAL.put(KV_PRIORITY, JSON.stringify(p));
const readClients = (env) => kvGet(env, KV_CLIENTS, {});
const writeClients = (env, c) => env.MANUAL.put(KV_CLIENTS, JSON.stringify(c));
const KV_DIGEST = 'digest_queue';
const readDigest = (env) => kvGet(env, KV_DIGEST, []);
const writeDigest = (env, q) => env.MANUAL.put(KV_DIGEST, JSON.stringify(q));
const KV_ASSIGN = 'assignments';
const readAssign = (env) => kvGet(env, KV_ASSIGN, {});
const writeAssign = (env, a) => env.MANUAL.put(KV_ASSIGN, JSON.stringify(a));
const KV_TASKS = 'tasks';
const readTasks = (env) => kvGet(env, KV_TASKS, []);
const writeTasks = (env, t) => env.MANUAL.put(KV_TASKS, JSON.stringify(t));
const KV_MEETING = 'meeting';
const readMeeting = (env) => kvGet(env, KV_MEETING, {});
const writeMeeting = (env, m) => env.MANUAL.put(KV_MEETING, JSON.stringify(m));
const KV_TUTORIALS = 'tutorials';
const readTutorials = (env) => kvGet(env, KV_TUTORIALS, []);
const writeTutorials = (env, t) => env.MANUAL.put(KV_TUTORIALS, JSON.stringify(t));
const KV_NOTES = 'dash_notes';
const readNotes = (env) => kvGet(env, KV_NOTES, {});
const writeNotes = (env, n) => env.MANUAL.put(KV_NOTES, JSON.stringify(n));

async function getDataset(env) {
  const [manual, roster, updates, people, priority, clients, assignments, tasks, meeting, tutorials, notes] = await Promise.all([
    readManual(env), readRoster(env), readUpdates(env), readPeople(env), readPriority(env), readClients(env), readAssign(env), readTasks(env), readMeeting(env), readTutorials(env), readNotes(env),
  ]);
  // All dashboards live in the app (KV) — there is no external Google Sheet.
  const ds = buildDataset([], manual, { roster, updates, people, priority, clients, assignments, notes, standalone: true });
  ds.tasks = Array.isArray(tasks) ? tasks : [];
  ds.meeting = meeting && typeof meeting === 'object' ? meeting : {};
  ds.tutorials = Array.isArray(tutorials) ? tutorials : [];
  return ds;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });

// If EDIT_TOKEN is set, writes require a matching x-edit-token header.
function authorized(request, env) {
  if (!env.EDIT_TOKEN) return true;
  return request.headers.get('x-edit-token') === env.EDIT_TOKEN;
}

// Send via the Muns raw email API. The raw API wants EXACTLY ONE of text/html.
async function sendMuns(env, recipients, subject, html, text) {
  if (!env.MUNS_TOKEN) return { ok: false, sent: 0, error: 'MUNS_TOKEN not set' };
  const endpoint = env.MUNS_EMAIL_URL || 'https://devde.muns.io/email/send/raw';
  const list = (Array.isArray(recipients) ? recipients : String(recipients).split(','))
    .map((s) => String(s).trim()).filter(Boolean);
  const results = [];
  for (const email of list) {
    try {
      const payload = html ? { email, subject, html } : { email, subject, text: text || '' };
      const r = await fetch(endpoint, { method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.MUNS_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload) });
      const t = await r.text();
      results.push({ email, status: r.status, ok: r.ok, response: t.slice(0, 400) });
    } catch (e) { results.push({ email, ok: false, error: String((e && e.message) || e) }); }
  }
  return { ok: results.length > 0 && results.every((x) => x.ok), sent: results.filter((x) => x.ok).length, results };
}

// ── People directory from the Muns platform ─────────────────────────────
// Clients = every organization (the org name), including munshot itself.
// Team = the members of the munshot org (id 1) — the interns work is
// assigned to. The token comes from the Worker env and is never exposed to
// the browser. Responses are edge-cached briefly so we don't hammer the
// upstream on every page load.
async function fetchMunsDirectory(env) {
  if (!env.MUNS_TOKEN) return { ok: false, error: 'MUNS_TOKEN not set', clients: [], team: [] };
  const base = env.MUNS_USERS_URL || 'https://devde.muns.io/orgs/users';
  const headers = { 'accept': '*/*', 'Authorization': 'Bearer ' + env.MUNS_TOKEN };
  const dedupe = (arr) => {
    const seen = new Set(), out = [];
    for (const n of arr) { const k = n.toLowerCase(); if (n && !seen.has(k)) { seen.add(k); out.push(n); } }
    return out.sort((a, b) => a.localeCompare(b));
  };
  try {
    const [allR, teamR] = await Promise.all([
      fetch(base + '?limit=1000', { headers, cf: { cacheTtl: 300, cacheEverything: true } }),
      fetch(base + '?limit=1000&organizationId=1', { headers, cf: { cacheTtl: 300, cacheEverything: true } }),
    ]);
    if (!allR.ok) return { ok: false, error: 'orgs ' + allR.status, clients: [], team: [] };
    const allJson = await allR.json().catch(() => ({}));
    const teamJson = teamR.ok ? await teamR.json().catch(() => ({})) : {};
    const orgs = Array.isArray(allJson.data) ? allJson.data : [];
    // Clients = every organization, including munshot itself (id 1).
    const clients = dedupe(orgs
      .map((o) => String((o && o.name) || '').trim())
      .filter(Boolean));
    // Team = active, named members of the munshot org.
    const teamOrg = (Array.isArray(teamJson.data) ? teamJson.data : []).find((o) => o && o.organization_id === 1)
      || orgs.find((o) => o && o.organization_id === 1) || { users: [] };
    const team = dedupe((teamOrg.users || [])
      .filter((u) => u && u.isActive && u.name)
      .map((u) => String(u.name).trim())
      .filter(Boolean));
    return { ok: true, clients, team };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), clients: [], team: [] };
  }
}

// ── Publish a dashboard onto the Munshot admin page ─────────────────────────
// POSTs the dashboard (title + link + description + the section/subsection tree)
// to the Munshot create-dashboard endpoint so it goes live on the admin page,
// instead of re-entering it there by hand. The endpoint is configurable via
// MUNS_DASHBOARD_URL; the token comes from the Worker env (never the browser).
// NOTE: the payload keys below are a best-effort mapping — adjust them to the
// exact Munshot create-dashboard contract once known (see PUBLISH_PAYLOAD).
async function publishToMuns(env, entry) {
  if (!env.MUNS_TOKEN) return { ok: false, error: 'MUNS_TOKEN is not set in the Worker environment.' };
  const endpoint = env.MUNS_DASHBOARD_URL;
  if (!endpoint) return { ok: false, error: 'MUNS_DASHBOARD_URL is not set — add the Munshot create-dashboard endpoint as a Worker var/secret.' };
  const payload = {                                   // PUBLISH_PAYLOAD
    title: String(entry.name || '').trim(),
    type: entry.dashboardType || 'iframe',            // URL Embed (Iframe) by default
    link: String(entry.dashboardUrl || '').trim(),
    description: String(entry.note || '').trim(),
    sections: normalizeSections(entry.sections),      // [{ name, children:[…] }]
  };
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.MUNS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch (e) {}
    const ref = j && (j.id || j._id || j.dashboardId || (j.data && (j.data.id || j.data._id)));
    return { ok: r.ok, status: r.status, ref: ref ? String(ref) : '', response: (t || '').slice(0, 600) };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// Nightly digest recipient — override with the DIGEST_TO env var/secret.
const digestTo = (env) => env.DIGEST_TO || 'ceekay@muns.io';

function digestEmailHtml(items, dateStr) {
  const rows = items.map((it) => {
    const meta = [it.client, (it.count != null ? it.count + ' change' + (it.count === 1 ? '' : 's') : '')].filter(Boolean).join('  ·  ');
    const cta = it.url
      ? `<a href="${escapeHtml(it.url)}" style="display:inline-block;background:#16294a;color:#fff;text-decoration:none;font-size:12px;font-weight:600;padding:9px 15px;border-radius:8px">Open the Build Update PDF →</a>`
      : '<span style="color:#b4791e;font-size:12px">PDF link unavailable</span>';
    return `<tr><td style="padding:13px 15px;border:1px solid #e7e2d3;border-radius:11px;background:#fff">
      <div style="font-weight:700;color:#16294a;font-size:15px">${escapeHtml(it.name || 'Build Update')}</div>
      <div style="color:#7a8395;font-size:12px;margin:3px 0 9px">${escapeHtml(meta)}</div>${cta}
    </td></tr><tr><td style="height:10px"></td></tr>`;
  }).join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#faf6ec;padding:24px">
    <div style="max-width:620px;margin:0 auto">
      <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#c9a24a;font-weight:700">Daily Build Update · ${escapeHtml(dateStr)}</div>
      <h1 style="font-family:Georgia,'Times New Roman',serif;color:#16294a;font-size:25px;margin:6px 0 4px">Today's Build Updates</h1>
      <p style="color:#33405a;font-size:13px;margin:0 0 18px">${items.length} update${items.length === 1 ? '' : 's'} prepared today — each links to its full visual deck.</p>
      <table style="width:100%;border-collapse:separate;border-spacing:0">${rows}</table>
      <p style="color:#9aa3b2;font-size:11px;margin-top:16px">Sent automatically by the Munshot Dashboard Tracker.</p>
    </div></div>`;
}

// Build and send the nightly digest of the day's Build Updates. Clears the
// queue only on a successful send so nothing is silently dropped. Records the
// outcome (digest_last) so the UI can show "last sent …" as proof it ran.
async function runDigest(env, trigger) {
  const stamp = async (rec) => { try { await env.MANUAL.put('digest_last', JSON.stringify({ at: new Date().toISOString(), trigger: trigger || 'manual', ...rec })); } catch (e) {} };
  const queue = await readDigest(env);
  if (!queue.length) { const r = { ok: true, sent: 0, count: 0, skipped: 'empty', to: digestTo(env) }; await stamp(r); return r; }
  const dateStr = new Date().toISOString().slice(0, 10);
  const res = await sendMuns(env, digestTo(env), `Build Updates — ${dateStr} (${queue.length})`, digestEmailHtml(queue, dateStr), '');
  if (res.ok) await writeDigest(env, []);
  const out = { ...res, count: queue.length, to: digestTo(env), error: res.ok ? undefined : (res.error || 'send failed') };
  await stamp({ ok: res.ok, sent: res.sent || 0, count: queue.length, to: digestTo(env), error: out.error });
  return out;
}

// ── Daily status digest (per-dashboard & per-member progress) ──────────────
function dailyStatusHtml(dateStr, owners, dashRows) {
  const e = escapeHtml;
  const ownerRows = Object.entries(owners).sort((a, b) => b[1].doneToday - a[1].doneToday).map(([name, a]) => {
    const pct = a.total ? Math.round(a.done / a.total * 100) : 0;
    return `<tr><td style="padding:9px 12px;border-bottom:1px solid #eee2c9;font-weight:600;color:#16294a">${e(name)}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #eee2c9;text-align:center;color:#0e7a52;font-weight:700">+${a.doneToday}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #eee2c9;text-align:center;color:#b4791e">${a.pending}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #eee2c9;text-align:center;color:#33405a">${a.done}/${a.total} (${pct}%)</td></tr>`;
  }).join('');
  const dashList = dashRows.filter(r => r.total).sort((a, b) => b.doneToday - a.doneToday || b.pending - a.pending).map(r => {
    const bar = `<div style="height:6px;background:#eee2c9;border-radius:4px;overflow:hidden;margin-top:5px"><div style="height:100%;width:${r.pct}%;background:#0e7a52"></div></div>`;
    const extra = (r.doneToday ? ` · <b style="color:#0e7a52">+${r.doneToday} since last</b>` : '') + (r.newToday ? ` · <span style="color:#1d4ed8">${r.newToday} new</span>` : '');
    return `<tr><td style="padding:11px 12px;border-bottom:1px solid #eee2c9">
      <div style="font-weight:600;color:#16294a">${e(r.client || '—')} · ${e(r.name)}</div>
      <div style="font-size:12px;color:#7a8395;margin-top:2px">${r.done}/${r.total} changes done (${r.pct}%) · ${r.pending} pending${extra}</div>${bar}</td>
      <td style="padding:11px 12px;border-bottom:1px solid #eee2c9;text-align:right;color:#727a8a;font-size:12px;white-space:nowrap">${e(r.owner || 'No owner')}</td></tr>`;
  }).join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#faf6ec;padding:24px"><div style="max-width:660px;margin:0 auto">
    <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#c9a24a;font-weight:700">Daily Status · ${e(dateStr)}</div>
    <h1 style="font-family:Georgia,'Times New Roman',serif;color:#16294a;font-size:24px;margin:6px 0 16px">Dashboard progress</h1>
    <h3 style="color:#33405a;font-size:13px;margin:0 0 7px">By team member</h3>
    <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #eee2c9;border-radius:10px;overflow:hidden">
      <tr style="background:#f4eeda"><td style="padding:8px 12px;font-size:10px;letter-spacing:.05em;color:#7a8395">MEMBER</td><td style="padding:8px 12px;font-size:10px;color:#7a8395;text-align:center">DONE</td><td style="padding:8px 12px;font-size:10px;color:#7a8395;text-align:center">PENDING</td><td style="padding:8px 12px;font-size:10px;color:#7a8395;text-align:center">COMPLETION</td></tr>
      ${ownerRows || '<tr><td colspan="4" style="padding:12px;color:#999;font-size:13px">No tracked changes yet.</td></tr>'}
    </table>
    <h3 style="color:#33405a;font-size:13px;margin:18px 0 7px">By dashboard</h3>
    <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #eee2c9;border-radius:10px;overflow:hidden">${dashList || '<tr><td style="padding:12px;color:#999;font-size:13px">No dashboards with feedback yet.</td></tr>'}</table>
    <p style="color:#9aa3b2;font-size:11px;margin-top:16px">"Since last" compares with the previous daily report. Sent automatically by the Munshot Dashboard Tracker.</p>
  </div></div>`;
}

// Compute the day's per-dashboard / per-member progress and email it. The diff
// is vs the last snapshot (saved only on a successful send), so each report
// shows what got done since the previous one.
async function runDailyStatus(env, trigger) {
  const stamp = async (rec) => { try { await env.MANUAL.put('daily_last', JSON.stringify({ at: new Date().toISOString(), trigger: trigger || 'manual', ...rec })); } catch (e) {} };
  let data;
  try { data = await getDataset(env); } catch (e) { const r = { ok: false, error: 'dataset: ' + (e && e.message) }; await stamp(r); return r; }
  const dashes = (data.dashboards || []).filter(d => (d.feedbacks || []).length);
  if (!dashes.length) { const r = { ok: true, sent: 0, skipped: 'no-feedback', to: digestTo(env) }; await stamp(r); return r; }
  const prev = (await kvGet(env, 'status_snapshot', { dash: {} })).dash || {};
  const cur = {}, dashRows = [], owners = {};
  for (const d of dashes) {
    const fb = d.feedbacks, total = fb.length, done = fb.filter(f => f.implemented).length, p = prev[d.id] || { done: 0, total: 0 };
    cur[d.id] = { total, done };
    const doneToday = Math.max(0, done - (p.done || 0)), newToday = Math.max(0, total - (p.total || 0)), pct = total ? Math.round(done / total * 100) : 0;
    dashRows.push({ id: d.id, name: d.name, client: d.customer, owner: d.owner, total, done, pending: total - done, doneToday, newToday, pct });
    const o = d.owner || 'No owner', a = owners[o] || (owners[o] = { done: 0, doneToday: 0, pending: 0, total: 0 });
    a.done += done; a.doneToday += doneToday; a.pending += (total - done); a.total += total;
  }
  const dateStr = new Date().toISOString().slice(0, 10);
  const totalDoneToday = dashRows.reduce((s, r) => s + r.doneToday, 0), totalPending = dashRows.reduce((s, r) => s + r.pending, 0);
  const res = await sendMuns(env, digestTo(env), `Daily Status — ${dateStr} (+${totalDoneToday} done · ${totalPending} pending)`, dailyStatusHtml(dateStr, owners, dashRows), '');
  if (res.ok) await env.MANUAL.put('status_snapshot', JSON.stringify({ date: dateStr, dash: cur }));
  await stamp({ ok: res.ok, sent: res.sent || 0, to: digestTo(env), error: res.ok ? undefined : (res.error || 'send failed'), doneToday: totalDoneToday, pending: totalPending });
  return { ...res, to: digestTo(env), doneToday: totalDoneToday, pending: totalPending };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // ── Manual entry API ────────────────────────────────────────────────
      if (pathname === '/api/manual') {
        if (!env.MANUAL) return json({ error: 'Manual entries are not enabled: bind a KV namespace as MANUAL.' }, 503);
        if (!authorized(request, env)) return json({ error: 'Unauthorized: missing or wrong edit token.' }, 401);

        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          if (!body.name || !String(body.name).trim()) return json({ error: 'Name is required.' }, 400);
          const entry = {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            name: body.name,
            customer: body.customer || '',
            owner: body.owner || '',
            liveRaw: body.liveRaw || (body.isLive ? 'Live on Munshot' : 'Not Live'),
            stage: body.stage || '',
            status: body.status || '',
            requirements: body.requirements || '',
            improvement: body.improvement || '',
            feedback: body.feedback || '',
            meetingUrl: body.meetingUrl || '',
            dashboardUrl: body.dashboardUrl || '',
            links: Array.isArray(body.links) ? body.links : [],
            lastUpdated: body.lastUpdated || new Date().toLocaleDateString('en-GB'),
            note: body.note || '',
            dueDate: body.dueDate || '',
            manualStatus: body.manualStatus || '',
            requirementFiles: Array.isArray(body.requirementFiles) ? body.requirementFiles : [],
            feedbacks: Array.isArray(body.feedbacks) ? body.feedbacks : [],
            sections: Array.isArray(body.sections) ? body.sections : [],
            brief: body.brief || '',
            briefFiles: Array.isArray(body.briefFiles) ? body.briefFiles : [],
            briefLinks: Array.isArray(body.briefLinks) ? body.briefLinks : [],
          };
          const list = await readManual(env);
          list.push(entry);
          await writeManual(env, list);
          return json({ ok: true, dashboard: manualToDashboard(entry) }, 201);
        }

        // Edit an existing entry in place (only KV-backed entries are editable).
        if (request.method === 'PUT') {
          const body = await request.json().catch(() => ({}));
          const id = String(body.id || '').trim();
          if (!id) return json({ error: 'id is required.' }, 400);
          if (!body.name || !String(body.name).trim()) return json({ error: 'Name is required.' }, 400);
          const list = await readManual(env);
          const i = list.findIndex((e) => e.id === id);
          if (i === -1) return json({ error: 'Entry not found (only app-created cards are editable).' }, 404);
          const FIELDS = ['name', 'customer', 'owner', 'liveRaw', 'stage', 'status', 'requirements', 'improvement', 'feedback', 'meetingUrl', 'dashboardUrl', 'links', 'lastUpdated', 'note', 'dueDate', 'manualStatus', 'requirementFiles', 'feedbacks', 'sections', 'brief', 'briefFiles', 'briefLinks'];
          for (const f of FIELDS) if (f in body) list[i][f] = body[f];
          list[i].updatedAt = new Date().toISOString();
          await writeManual(env, list);
          return json({ ok: true, dashboard: manualToDashboard(list[i]) });
        }

        if (request.method === 'DELETE') {
          const id = url.searchParams.get('id');
          if (!id) return json({ error: 'id is required.' }, 400);
          const list = await readManual(env);
          const next = list.filter((e) => e.id !== id);
          await writeManual(env, next);
          return json({ ok: true, removed: list.length - next.length });
        }
        return json({ error: 'Method not allowed.' }, 405);
      }

      // ── Publish a dashboard onto the Munshot admin page ──────────────────
      if (pathname === '/api/publish') {
        if (!env.MANUAL) return json({ error: 'Storage not enabled.' }, 503);
        if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
        if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
        const body = await request.json().catch(() => ({}));
        const id = String(body.id || '').trim();
        if (!id) return json({ error: 'id is required.' }, 400);
        const list = await readManual(env);
        const i = list.findIndex((e) => e.id === id);
        if (i === -1) return json({ error: 'Dashboard not found (only app-created cards can be published).' }, 404);
        if (!String(list[i].name || '').trim()) return json({ error: 'A dashboard title is required before publishing.' }, 400);
        const res = await publishToMuns(env, list[i]);
        if (res.ok) {
          list[i].publishedAt = new Date().toISOString();
          if (res.ref) list[i].publishRef = res.ref;
          list[i].updatedAt = list[i].publishedAt;
          await writeManual(env, list);
        }
        return json({ ...res, id, publishedAt: res.ok ? list[i].publishedAt : undefined }, res.ok ? 200 : 502);
      }

      // ── Priority API — stores a level per dashboard (1 = highest) ────────
      if (pathname === '/api/priority') {
        if (!env.MANUAL) return json({ error: 'Storage not enabled.' }, 503);
        if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
        if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
        const body = await request.json().catch(() => ({}));
        const id = String(body.id || '').trim();
        if (!id) return json({ error: 'id is required.' }, 400);
        const priority = await readPriority(env);
        // Accept {level:n} (0 clears) or legacy {on:bool}.
        let level = 'level' in body ? Number.parseInt(body.level, 10) : (body.on ? 1 : 0);
        if (!Number.isFinite(level) || level < 0) level = 0;
        if (level > 0) priority[id] = level; else delete priority[id];
        await writePriority(env, priority);
        return json({ ok: true, id, level });
      }

      // ── Quick stage setter (advance a dashboard along the pipeline) ──────
      if (pathname === '/api/stage') {
        if (!env.MANUAL) return json({ error: 'Storage not enabled.' }, 503);
        if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
        if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
        const body = await request.json().catch(() => ({}));
        const id = String(body.id || '').trim();
        const stage = String(body.stage || '').trim();
        if (!id || !stage) return json({ error: 'id and stage are required.' }, 400);
        const list = await readManual(env);
        const i = list.findIndex((e) => e.id === id);
        if (i === -1) return json({ error: 'Dashboard not found.' }, 404);
        list[i].stage = stage;
        list[i].updatedAt = new Date().toISOString();
        await writeManual(env, list);
        return json({ ok: true, id, stage });
      }

      // ── Toggle a feedback's "implemented" flag (the yes/no slider) ───────
      if (pathname === '/api/feedback') {
        if (!env.MANUAL) return json({ error: 'Storage not enabled.' }, 503);
        if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
        if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
        const body = await request.json().catch(() => ({}));
        const id = String(body.id || '').trim(), fbId = String(body.fbId || '');
        if (!id || !fbId) return json({ error: 'id and fbId are required.' }, 400);
        const list = await readManual(env);
        const i = list.findIndex((e) => e.id === id);
        if (i === -1) return json({ error: 'Only app-stored dashboards can be changed here.' }, 404);
        const fbs = Array.isArray(list[i].feedbacks) ? list[i].feedbacks : [];
        const fb = fbs.find((f) => f.id === fbId);
        if (!fb) return json({ error: 'Feedback not found.' }, 404);
        if ('implemented' in body) fb.implemented = !!body.implemented;
        if (body.addFile && body.addFile.id) {           // attach a proof file
          fb.files = Array.isArray(fb.files) ? fb.files : [];
          fb.files.push({ id: String(body.addFile.id), name: String(body.addFile.name || 'proof'), type: String(body.addFile.type || ''), url: body.addFile.url || ('/api/file?id=' + body.addFile.id) });
        }
        if (body.removeFile) fb.files = (fb.files || []).filter((x) => x.id !== String(body.removeFile));
        await writeManual(env, list);
        return json({ ok: true, id, fbId, implemented: !!fb.implemented, files: fb.files || [] });
      }

      // ── Email via the Muns raw email API (token from Worker env) ─────────
      if (pathname === '/api/email') {
        if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
        if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
        if (!env.MUNS_TOKEN) return json({ error: 'MUNS_TOKEN is not set in the Worker environment. Add it as a secret (wrangler secret put MUNS_TOKEN).' }, 503);
        const body = await request.json().catch(() => ({}));
        const subject = String(body.subject || '').trim();
        const text = String(body.text || '');
        const htmlBody = String(body.html || '');
        // Accept { to: [...] | "a, b" } or the raw API's { email }.
        let recipients = [];
        if (Array.isArray(body.to)) recipients = body.to;
        else if (body.to) recipients = String(body.to).split(',');
        else if (body.email) recipients = [body.email];
        recipients = recipients.map((s) => String(s).trim()).filter(Boolean);
        if (!recipients.length) return json({ error: 'At least one recipient is required.' }, 400);
        if (!subject) return json({ error: 'Subject is required.' }, 400);
        const out = await sendMuns(env, recipients, subject, htmlBody, text);
        return json(out);
      }

      // ── Nightly digest queue (auto-collected PDFs, sent once at 8pm IST) ──
      if (pathname === '/api/digest') {
        if (!env.MANUAL) return json({ error: 'Storage not enabled.' }, 503);
        if (request.method === 'GET') {
          const q = await readDigest(env);
          const last = await kvGet(env, 'digest_last', null);
          const dailyLast = await kvGet(env, 'daily_last', null);
          return json({ ok: true, count: q.length, to: digestTo(env), items: q, last, dailyLast });
        }
        if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
        if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
        const body = await request.json().catch(() => ({}));
        const action = String(body.action || 'enqueue');
        if (action === 'enqueue') {
          const it = body.item || {};
          if (!it.url && !it.dashboardId) return json({ error: 'Nothing to enqueue.' }, 400);
          let q = await readDigest(env);
          q = q.filter((x) => !it.dashboardId || x.dashboardId !== it.dashboardId); // one entry per dashboard — newest wins
          q.push({ dashboardId: String(it.dashboardId || ''), name: String(it.name || 'Build Update'), client: String(it.client || ''),
            count: it.count != null ? +it.count : null, url: String(it.url || ''), at: new Date().toISOString() });
          if (q.length > 100) q = q.slice(q.length - 100);
          await writeDigest(env, q);
          return json({ ok: true, count: q.length });
        }
        if (action === 'send') { const r = await runDigest(env, 'manual'); return json(r, r.ok ? 200 : 502); }
        if (action === 'daily') { const r = await runDailyStatus(env, 'manual'); return json(r, r.ok ? 200 : 502); }
        if (action === 'clear') { await writeDigest(env, []); return json({ ok: true, count: 0 }); }
        return json({ error: 'Unknown action.' }, 400);
      }

      // ── Owner assignment overlay (auto-balanced workload) ────────────────
      if (pathname === '/api/assign') {
        if (!env.MANUAL) return json({ error: 'Storage not enabled.' }, 503);
        if (request.method === 'GET') return json({ ok: true, assignments: await readAssign(env) });
        if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
        if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
        const body = await request.json().catch(() => ({}));
        const map = await readAssign(env);
        const setOne = (id, owner) => { const o = String(owner || '').trim(); if (o) map[String(id)] = o; else delete map[String(id)]; };
        if (body.assignments && typeof body.assignments === 'object') { for (const [id, owner] of Object.entries(body.assignments)) setOne(id, owner); }
        else if (body.id) setOne(body.id, body.owner);
        else return json({ error: 'Provide {id, owner} or {assignments}.' }, 400);
        await writeAssign(env, map);
        return json({ ok: true, count: Object.keys(map).length, assignments: map });
      }

      // ── Standup tasks — per-member daily to-dos (EOD tracking) ───────────
      // The meeting-transcription bot POSTs generated to-dos here; the UI reads
      // and ticks them off. GET is open; writes use the same edit-token gate.
      if (pathname === '/api/tasks') {
        if (!env.MANUAL) return json({ error: 'Storage not enabled.' }, 503);
        if (request.method === 'GET') {
          let list = await readTasks(env);
          const date = url.searchParams.get('date'), member = url.searchParams.get('member');
          if (date) list = list.filter((t) => t.date === date);
          if (member) list = list.filter((t) => String(t.member || '').toLowerCase() === member.toLowerCase());
          return json({ ok: true, tasks: list });
        }
        if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
        if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
        const body = await request.json().catch(() => ({}));
        const action = String(body.action || 'add');
        let list = await readTasks(env);
        const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
        const today = new Date().toISOString().slice(0, 10);
        const mkTask = (o) => ({
          id: crypto.randomUUID(),
          member: String(o.member || '').trim() || 'Unassigned',
          date: isDate(o.date) ? o.date : (isDate(body.date) ? body.date : today),
          text: String(o.text || '').trim(),
          dashboardId: String(o.dashboardId || ''),
          dashboardName: String(o.dashboardName || ''),
          done: !!o.done,
          doneAt: o.done ? new Date().toISOString() : null,
          source: String(o.source || body.source || 'manual'),
          createdAt: new Date().toISOString(),
        });
        if (action === 'add') {
          const items = Array.isArray(body.tasks) ? body.tasks : ((body.text || body.member) ? [body] : []);
          const added = items.map(mkTask).filter((t) => t.text);
          if (!added.length) return json({ error: 'Nothing to add — each task needs member + text.' }, 400);
          list.push(...added);
          await writeTasks(env, list);
          return json({ ok: true, added: added.length, tasks: added }, 201);
        }
        if (action === 'toggle') {
          const t = list.find((x) => x.id === String(body.id));
          if (!t) return json({ error: 'Task not found.' }, 404);
          t.done = ('done' in body) ? !!body.done : !t.done;
          t.doneAt = t.done ? new Date().toISOString() : null;
          await writeTasks(env, list);
          return json({ ok: true, task: t });
        }
        if (action === 'delete') {
          const before = list.length;
          list = list.filter((x) => x.id !== String(body.id));
          if (list.length === before) return json({ error: 'Task not found.' }, 404);
          await writeTasks(env, list);
          return json({ ok: true });
        }
        return json({ error: 'Unknown action.' }, 400);
      }

      // ── Team meeting link (shown on the Standup tab) ─────────────────────
      if (pathname === '/api/meeting') {
        if (!env.MANUAL) return json({ error: 'Storage not enabled.' }, 503);
        if (request.method === 'GET') return json({ ok: true, meeting: await readMeeting(env) });
        if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
        if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
        const body = await request.json().catch(() => ({}));
        const m = await readMeeting(env);
        if ('link' in body) m.link = String(body.link || '').trim();
        if ('note' in body) m.note = String(body.note || '').trim();
        await writeMeeting(env, m);
        return json({ ok: true, meeting: m });
      }

      // ── Tutorials — company how-to guides shown on the Tutorial tab ───────
      // GET is open (any team member can read); add/edit/delete use the same
      // edit-token gate as the other write endpoints.
      if (pathname === '/api/tutorials') {
        if (!env.MANUAL) return json({ error: 'Storage not enabled.' }, 503);
        if (request.method === 'GET') return json({ ok: true, tutorials: await readTutorials(env) });
        if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
        if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
        const body = await request.json().catch(() => ({}));
        const action = String(body.action || 'add');
        let list = await readTutorials(env);
        const cl = (v) => String(v == null ? '' : v).trim();
        const normLinks = (a) => Array.isArray(a) ? a.map((l) => ({ label: cl(l && l.label), url: cl(l && l.url) })).filter((l) => /^https?:\/\//i.test(l.url)) : [];
        const normFiles = (a) => Array.isArray(a) ? a.filter((f) => f && f.id).map((f) => ({ id: String(f.id), name: cl(f.name), type: cl(f.type), url: cl(f.url) })) : [];
        if (action === 'add') {
          const t = { id: crypto.randomUUID(), title: cl(body.title), body: cl(body.body), links: normLinks(body.links), files: normFiles(body.files), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          if (!t.title && !t.body && !t.links.length && !t.files.length) return json({ error: 'Add a title or some content first.' }, 400);
          list.push(t);
          await writeTutorials(env, list);
          return json({ ok: true, tutorial: t }, 201);
        }
        if (action === 'edit') {
          const i = list.findIndex((x) => x.id === String(body.id));
          if (i === -1) return json({ error: 'Tutorial not found.' }, 404);
          if ('title' in body) list[i].title = cl(body.title);
          if ('body' in body) list[i].body = cl(body.body);
          if ('links' in body) list[i].links = normLinks(body.links);
          if ('files' in body) list[i].files = normFiles(body.files);
          list[i].updatedAt = new Date().toISOString();
          await writeTutorials(env, list);
          return json({ ok: true, tutorial: list[i] });
        }
        if (action === 'delete') {
          const before = list.length;
          list = list.filter((x) => x.id !== String(body.id));
          if (list.length === before) return json({ error: 'Tutorial not found.' }, 404);
          await writeTutorials(env, list);
          return json({ ok: true });
        }
        return json({ error: 'Unknown action.' }, 400);
      }

      // ── Tracking tasks from Munshot notetaker ────────────────────────────
      // Pulls the notetaker's per-member to-dos and folds them into the SAME KV
      // task store the profile To-do lists use, then returns the merged list.
      // Upsert-only + dedup by (member, text) so re-syncing never duplicates and
      // never clobbers a task's locally-toggled done status.
      if (pathname === '/api/tracking-tasks') {
        let tasks = await readTasks(env).catch(() => []);
        try {
          const trackingUrl = env.MUNS_TRACKING_URL || 'https://munshot-notetaker-frontend.amazon-review-radar-489675.workers.dev/api/public/tracking';
          const res = await fetch(trackingUrl, {
            headers: { 'Authorization': 'Bearer ' + (env.MUNSBOT_TOKEN || 'quackquackquackquack') }
          });
          if (!res.ok) return json({ ok: true, tasks, warning: 'notetaker returned ' + res.status });
          const data = await res.json();
          const people = Array.isArray(data && data.people) ? data.people : [];
          const norm = (s) => String(s || '').trim();
          const key = (m, t) => (norm(m) + '||' + norm(t)).toLowerCase();
          const seen = new Set(tasks.map((x) => key(x.member, x.text)));
          let added = 0;
          for (const p of people) {
            const member = norm(p && p.name);
            if (!member) continue;
            const items = [
              ...(Array.isArray(p.todo) ? p.todo : []).map((t) => ({ text: t, done: false })),
              ...(Array.isArray(p.accomplished) ? p.accomplished : []).map((t) => ({ text: t, done: true })),
            ];
            for (const it of items) {
              const text = norm(it.text);
              if (!text || seen.has(key(member, text))) continue;
              seen.add(key(member, text));
              // date '' → this is backlog, not a dated daily-standup task.
              tasks.push({ id: crypto.randomUUID(), member, date: '', text, dashboardId: '', dashboardName: '',
                done: it.done, doneAt: it.done ? new Date().toISOString() : null, source: 'notetaker', createdAt: new Date().toISOString() });
              added++;
            }
          }
          if (added && env.MANUAL) await writeTasks(env, tasks);
          return json({ ok: true, tasks, imported: added });
        } catch (e) {
          return json({ ok: true, tasks, warning: 'notetaker fetch failed: ' + e.message });
        }
      }

      // ── People directory (clients = orgs, team = munshot members) ────────
      // Read-only proxy to the Muns platform; keeps the token server-side.
      if (pathname === '/api/directory') {
        const dir = await fetchMunsDirectory(env);
        return json(dir, dir.ok ? 200 : 502);
      }

      // ── Deck fonts (Playfair Display) — proxied + edge-cached, same-origin ─
      if (pathname === '/api/font') {
        const f = url.searchParams.get('f');
        const src = f === 'italic'
          ? 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/playfairdisplay/PlayfairDisplay-Italic%5Bwght%5D.ttf'
          : 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf';
        try {
          const r = await fetch(src, { cf: { cacheTtl: 31536000, cacheEverything: true } });
          if (!r.ok) return new Response('font fetch failed', { status: 502 });
          return new Response(r.body, { headers: {
            'content-type': 'font/ttf',
            'cache-control': 'public, max-age=31536000, immutable',
            'access-control-allow-origin': '*',
          } });
        } catch (e) { return new Response('font error', { status: 502 }); }
      }

      // ── File store (PDF / image uploads) — base64 in KV, served raw ──────
      if (pathname === '/api/file') {
        if (!env.MANUAL) return json({ error: 'Storage not enabled.' }, 503);
        if (request.method === 'GET') {
          const id = url.searchParams.get('id');
          if (!id || !/^[\w-]+$/.test(id)) return new Response('Bad id', { status: 400 });
          const raw = await env.MANUAL.get('file:' + id);
          if (!raw) return new Response('Not found', { status: 404 });
          const f = JSON.parse(raw);
          const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
          return new Response(bytes, { headers: {
            'content-type': f.type || 'application/octet-stream',
            'content-disposition': `inline; filename="${(f.name || 'file').replace(/"/g, '')}"`,
            'cache-control': 'public, max-age=31536000, immutable',
          } });
        }
        if (request.method === 'POST') {
          if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
          const body = await request.json().catch(() => ({}));
          const data = String(body.data || ''); // base64 (no data: prefix)
          if (!data) return json({ error: 'No file data.' }, 400);
          if (data.length * 0.75 > MAX_FILE_BYTES) return json({ error: 'File too large (max 4 MB).' }, 413);
          const id = crypto.randomUUID();
          await env.MANUAL.put('file:' + id, JSON.stringify({ name: String(body.name || 'file'), type: String(body.type || ''), data }));
          return json({ ok: true, id, name: String(body.name || 'file'), type: String(body.type || ''), url: '/api/file?id=' + id }, 201);
        }
        return json({ error: 'Method not allowed.' }, 405);
      }

      // ── Client details API ──────────────────────────────────────────────
      if (pathname === '/api/client') {
        if (!env.MANUAL) return json({ error: 'Storage not enabled.' }, 503);
        if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
        const clients = await readClients(env);
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const name = String(body.name || '').trim();
          if (!name) return json({ error: 'Client name is required.' }, 400);
          const c = clients[name] || {};
          for (const f of ['poc', 'emails', 'meetingFreq', 'notes', 'website', 'logo']) if (f in body) c[f] = body[f];
          clients[name] = c;
          await writeClients(env, clients);
          return json({ ok: true, name, client: c }, 201);
        }
        if (request.method === 'DELETE') {
          const name = String(url.searchParams.get('name') || '');
          delete clients[name];
          await writeClients(env, clients);
          return json({ ok: true });
        }
        return json({ error: 'Method not allowed.' }, 405);
      }

      // ── Person / employee profile + attendance API ──────────────────────
      if (pathname === '/api/person') {
        if (!env.MANUAL) return json({ error: 'Storage not enabled.' }, 503);
        if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
        if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
        const body = await request.json().catch(() => ({}));
        const name = String(body.name || '').trim();
        if (!name) return json({ error: 'name is required.' }, 400);
        const people = await readPeople(env);
        const p = people[name] || { joinDate: '', days: {} };
        for (const f of ['joinDate', 'role', 'qualification', 'phone', 'email', 'photo', 'calendarUrl']) if (f in body) p[f] = String(body[f] || '');
        // Mark/clear a single day's attendance: status 'present' | 'leave' | '' (clear)
        if (body.date) {
          const date = String(body.date);
          if (body.status === 'present' || body.status === 'leave') {
            p.days[date] = body.reason ? { s: body.status, r: String(body.reason) } : body.status;
          } else {
            delete p.days[date];
          }
        }
        people[name] = p;
        await writePeople(env, people);
        return json({ ok: true, person: p });
      }

      // ── Roster API (extra team members / clients) ───────────────────────
      if (pathname === '/api/roster') {
        if (!env.MANUAL) return json({ error: 'Storage not enabled.' }, 503);
        if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
        const type = (request.method === 'DELETE' ? url.searchParams.get('type') : (await request.clone().json().catch(() => ({}))).type);
        const key = type === 'owner' ? 'owners' : type === 'customer' ? 'customers' : null;
        if (!key) return json({ error: "type must be 'owner' or 'customer'." }, 400);
        const roster = await readRoster(env);
        if (!Array.isArray(roster.owners)) roster.owners = [];
        if (!Array.isArray(roster.customers)) roster.customers = [];

        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const name = String(body.name || '').trim();
          if (!name) return json({ error: 'name is required.' }, 400);
          if (!roster[key].includes(name)) roster[key].push(name);
          await writeRoster(env, roster);
          return json({ ok: true, roster }, 201);
        }
        if (request.method === 'DELETE') {
          const name = String(url.searchParams.get('name') || '');
          roster[key] = roster[key].filter((n) => n !== name);
          await writeRoster(env, roster);
          // Detach the name from any app-stored dashboards so it disappears
          // everywhere (owners → blank/no owner; clients → removed from the list).
          const list = await readManual(env);
          let changed = 0;
          for (const e of list) {
            if (type === 'owner' && (e.owner || '') === name) { e.owner = ''; changed++; }
            if (type === 'customer') {
              const parts = String(e.customer || '').split(/\s*&\s*/).map((s) => s.trim()).filter(Boolean);
              if (parts.includes(name)) { e.customer = parts.filter((p) => p !== name).join(' & '); changed++; }
            }
          }
          if (changed) await writeManual(env, list);
          return json({ ok: true, roster, detached: changed });
        }
        return json({ error: 'Method not allowed.' }, 405);
      }

      // ── Daily status-update API ─────────────────────────────────────────
      if (pathname === '/api/update') {
        if (!env.MANUAL) return json({ error: 'Storage not enabled.' }, 503);
        if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
        const updates = await readUpdates(env);

        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const id = String(body.id || '').trim();
          if (!id) return json({ error: 'id is required.' }, 400);
          const files = Array.isArray(body.files) ? body.files : [];
          if (!body.state && !body.note && !files.length) return json({ error: 'Write a note, attach a screenshot, or set a stage.' }, 400);
          const entry = {
            ts: Date.now(),
            date: body.date || new Date().toLocaleDateString('en-GB'),
            state: body.state || '',
            note: body.note || '',
            files,
            by: body.by || '',
          };
          if (!Array.isArray(updates[id])) updates[id] = [];
          updates[id].push(entry);
          await writeUpdates(env, updates);
          // Keep the dashboard's canonical stage in sync when the update sets one.
          if (entry.state) {
            const list = await readManual(env);
            const i = list.findIndex((e) => e.id === id);
            if (i !== -1){ list[i].stage = entry.state; await writeManual(env, list); }
          }
          return json({ ok: true, entry }, 201);
        }
        if (request.method === 'DELETE') {
          const id = url.searchParams.get('id');
          const ts = Number(url.searchParams.get('ts'));
          if (Array.isArray(updates[id])) {
            updates[id] = updates[id].filter((e) => e.ts !== ts);
            if (!updates[id].length) delete updates[id];
            await writeUpdates(env, updates);
          }
          return json({ ok: true });
        }
        return json({ error: 'Method not allowed.' }, 405);
      }

      // ── Per-dashboard working notes — a teammate's scratchpad on a card ───
      // A quick list of jottings per dashboard ("what I want to do here"),
      // added and deleted as they work. Keyed by dashboard id in KV.
      if (pathname === '/api/notes') {
        if (!env.MANUAL) return json({ error: 'Storage not enabled.' }, 503);
        if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
        const notes = await readNotes(env);
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const id = String(body.id || '').trim();
          const text = String(body.text || '').trim();
          if (!id) return json({ error: 'id is required.' }, 400);
          if (!text) return json({ error: 'Write a note first.' }, 400);
          const entry = { ts: Date.now(), text, by: String(body.by || '').trim() };
          if (!Array.isArray(notes[id])) notes[id] = [];
          notes[id].push(entry);
          await writeNotes(env, notes);
          return json({ ok: true, entry }, 201);
        }
        if (request.method === 'DELETE') {
          const id = url.searchParams.get('id');
          const ts = Number(url.searchParams.get('ts'));
          if (Array.isArray(notes[id])) {
            notes[id] = notes[id].filter((e) => e.ts !== ts);
            if (!notes[id].length) delete notes[id];
            await writeNotes(env, notes);
          }
          return json({ ok: true });
        }
        return json({ error: 'Method not allowed.' }, 405);
      }

      // ── Read endpoints ──────────────────────────────────────────────────
      const data = await getDataset(env);

      if (pathname === '/api/data') {
        return new Response(JSON.stringify(data, null, 2), {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': `public, max-age=${CACHE_SECONDS}`,
            'access-control-allow-origin': '*',
          },
        });
      }

      return new Response(renderPage(data, { manualEnabled: !!env.MANUAL, editProtected: !!env.EDIT_TOKEN, standalone: true }), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    } catch (err) {
      return new Response(`<h1>Dashboard error</h1><pre>${escapeHtml(err.message)}</pre>`, {
        status: 500,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
  },
  // Crons (UTC; see wrangler.toml):
  //   "30 15 * * *"  → 9:00pm IST daily   → daily status email
  //   "30 15 * * 3"  → 9:00pm IST Wednesday → weekly Build-Update PDF digest
  async scheduled(event, env, ctx) {
    const cron = event && event.cron;
    if (cron === '30 15 * * 3') ctx.waitUntil(runDigest(env, 'cron').catch(() => {}));
    else ctx.waitUntil(runDailyStatus(env, 'cron').catch(() => {}));
  },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderPage(data, opts) {
  const fresh = new Date(data.generatedAt).toLocaleString('en-GB', { hour12: false });
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');
  const statesJson = JSON.stringify(STATES);
  const cfg = JSON.stringify(opts);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard Tracker</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:#f7f8fa; --surface:#ffffff; --surface2:#fbfcfd;
    --line:#eaecef; --line2:#f0f2f5;
    --txt:#141925; --txt2:#48505f; --muted:#727a8a;
    --accent:#4f46e5; --accent2:#9333ea; --accent-weak:#eef0ff;
    --good:#067647; --good-bg:#ecfdf3; --good-line:#abefc6;
    --warn-bg:#fffaeb; --warn-txt:#93620a; --warn-line:#fef0c7;
    --present-bg:#dcfce7; --present-line:#86efac; --present-txt:#166534;
    --leave-bg:#fee2e2; --leave-line:#fca5a5; --leave-txt:#991b1b;
    --accent-line:var(--accent-line); --danger:#b42318; --danger-bg:#fef3f2; --danger-line:#fda29b;
    --overlay:rgba(16,24,40,.45);
    --shadow:0 1px 2px rgba(16,24,40,.04);
    --shadow-md:0 2px 8px rgba(16,24,40,.06);
    --shadow-lg:0 12px 34px rgba(16,24,40,.12);
    --grad:linear-gradient(135deg,#4f46e5 0%,#9333ea 100%);
    --grad-soft:linear-gradient(135deg,#eef0ff 0%,#f6eefe 100%);
    --radius:14px;
  }
  [data-theme="dark"] {
    --bg:#0b0f1d; --surface:#151b2e; --surface2:#1a2138;
    --line:#28314c; --line2:#222a44;
    --txt:#e9edf7; --txt2:#aeb6c9; --muted:#7d879f;
    --accent:#8593ff; --accent2:#c084fc; --accent-weak:#1d2440;
    --good:#34d399; --good-bg:#0e2a22; --good-line:#1f6048;
    --warn-bg:#2a2410; --warn-txt:#e8c468; --warn-line:#4a3f15;
    --present-bg:#0f2c1e; --present-line:#1f6e46; --present-txt:#7ef0ac;
    --leave-bg:#2f1518; --leave-line:#7c2b30; --leave-txt:#fcafa5;
    --accent-line:#36406a; --danger:#f97066; --danger-bg:#2a1412; --danger-line:#7a2b27;
    --overlay:rgba(0,0,0,.6);
    --shadow:0 1px 2px rgba(0,0,0,.4),0 2px 8px rgba(0,0,0,.3);
    --shadow-md:0 6px 20px rgba(0,0,0,.4);
    --shadow-lg:0 18px 46px rgba(0,0,0,.55);
    --grad:linear-gradient(135deg,#6366f1 0%,#a855f7 100%);
    --grad-soft:linear-gradient(135deg,#1b2240 0%,#241c40 100%);
  }
  html { color-scheme:light dark; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.5 'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; -webkit-font-smoothing:antialiased; letter-spacing:-.005em; transition:background .25s,color .25s; }
  header { padding:16px 28px 14px; background:var(--surface); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:5; box-shadow:var(--shadow); }
  .row { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; }
  .brand { display:flex; align-items:center; gap:12px; }
  .logo { width:40px; height:40px; border-radius:11px; background:var(--grad); display:grid; place-items:center; color:#fff; font-size:20px; flex:none; box-shadow:0 4px 12px rgba(79,70,229,.35); }
  h1 { margin:0; font-size:20px; font-weight:720; letter-spacing:-.02em; background:var(--grad); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
  .sub { color:var(--muted); font-size:12.5px; margin-top:1px; }
  .theme-toggle { width:38px; height:38px; border-radius:10px; border:1px solid var(--line); background:var(--surface); color:var(--txt); cursor:pointer; font-size:16px; display:grid; place-items:center; }
  .theme-toggle:hover { background:var(--line2); }
  .legend { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px; }
  .pill { display:inline-flex; align-items:center; gap:7px; padding:5px 12px; border:1px solid var(--line); border-radius:999px; background:var(--surface); cursor:pointer; user-select:none; font-size:12.5px; transition:background .12s,border-color .12s,transform .1s; }
  .pill:hover { background:var(--line2); transform:translateY(-1px); }
  .pill.off { opacity:.4; }
  .dot { width:9px; height:9px; border-radius:50%; flex:none; }
  .pill .n { color:var(--muted); font-variant-numeric:tabular-nums; font-weight:600; }
  .btn { font:inherit; font-size:13px; font-weight:600; padding:9px 15px; border-radius:10px; border:0; background:var(--grad); color:#fff; cursor:pointer; box-shadow:0 2px 10px rgba(79,70,229,.28); transition:transform .12s,box-shadow .12s,filter .12s; }
  .btn:hover { transform:translateY(-1px); box-shadow:0 5px 16px rgba(79,70,229,.36); }
  .btn:active { transform:translateY(0); }
  .btn.ghost { background:var(--surface); color:var(--txt); border:1px solid var(--line); box-shadow:none; }
  .btn.ghost:hover { background:var(--line2); transform:translateY(-1px); }
  .header-actions { display:flex; gap:10px; align-items:center; }
  .dropdown { position:relative; }
  .menu { display:none; position:absolute; right:0; top:calc(100% + 6px); background:var(--surface); border:1px solid var(--line); border-radius:10px; box-shadow:0 8px 24px rgba(16,24,40,.12); min-width:300px; overflow:hidden; z-index:20; }
  .menu.open { display:block; }
  .menu button { display:block; width:100%; text-align:left; padding:10px 14px; border:0; background:none; font:inherit; font-size:13px; color:var(--txt); cursor:pointer; }
  .menu button:hover { background:var(--accent-weak); }
  .menu button + button { border-top:1px solid var(--line2); }
  .tag.owner-link { cursor:pointer; }
  .tag.owner-link:hover { background:var(--accent-weak); border-color:var(--accent-line); color:var(--accent); }
  /* Slide-over drawer (owner profile + team) */
  .overlay { position:fixed; inset:0; background:var(--overlay); backdrop-filter:blur(3px); -webkit-backdrop-filter:blur(3px); display:none; z-index:50; }
  .overlay.open { display:block; animation:bgFadeIn .15s ease; }
  .drawer { position:absolute; top:0; right:0; height:100%; width:min(560px,100%); background:var(--bg); box-shadow:-8px 0 30px rgba(16,24,40,.18); overflow-y:auto; }
  .drawer-head { position:sticky; top:0; background:var(--surface); border-bottom:1px solid var(--line); padding:18px 22px; display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
  .drawer-head h2 { margin:0; font-size:20px; font-weight:650; }
  .drawer-head .sub { color:var(--muted); font-size:12.5px; margin-top:3px; }
  .dh-right { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
  .subtab.back-sub { color:var(--accent); font-weight:600; }
  .x { border:1px solid var(--line); background:var(--surface); width:30px; height:30px; border-radius:8px; cursor:pointer; font-size:17px; color:var(--muted); flex:none; }
  .x:hover { background:var(--line2); }
  .drawer-body { padding:18px 22px 60px; }
  .stat-row { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:18px; }
  .stat { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:12px; text-align:center; }
  .stat .num { font-size:24px; font-weight:680; line-height:1; font-variant-numeric:tabular-nums; }
  .stat .lbl { font-size:11px; color:var(--muted); margin-top:5px; }
  .stat[data-states] { cursor:pointer; }
  .stat[data-states]:hover { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-weak); }
  .section-t.clk { cursor:pointer; }
  .section-t.clk:hover { color:var(--accent); }
  .bar { display:flex; height:8px; border-radius:5px; overflow:hidden; margin:4px 0 16px; background:var(--line2); }
  .bar i { display:block; height:100%; }
  .section-t { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:650; margin:18px 0 8px; display:flex; align-items:center; gap:7px; }
  .drow { display:flex; gap:10px; align-items:baseline; padding:9px 0; border-bottom:1px solid var(--line2); }
  .drow .sn { color:var(--muted); font-variant-numeric:tabular-nums; font-size:12px; min-width:26px; }
  .drow .dn { font-weight:550; font-size:13.5px; }
  .drow .dmeta { font-size:12px; color:var(--muted); }
  .drow .dlinks { margin-left:auto; display:flex; gap:6px; flex-wrap:wrap; align-items:center; align-self:center; }
  .drow .dlink { font-size:11px; font-weight:600; color:var(--accent); background:var(--accent-weak); border:1px solid var(--accent-line); border-radius:999px; padding:2px 9px; text-decoration:none; white-space:nowrap; max-width:160px; overflow:hidden; text-overflow:ellipsis; }
  .drow .dlink:hover { text-decoration:underline; filter:brightness(0.97); }
  .chips { display:flex; flex-wrap:wrap; gap:6px; margin:2px 0 6px; }
  /* Employee terminal */
  .emp { margin-top:16px; padding:14px; border:1px solid var(--line); border-radius:12px; background:var(--bg); }
  .emp .section-t { margin-top:0; }
  .emp-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:12px; }
  .emp-stat { background:var(--surface); border:1px solid var(--line); border-radius:9px; padding:10px; text-align:center; }
  .emp-stat .n { font-size:20px; font-weight:700; }
  .emp-stat .l { font-size:10.5px; color:var(--muted); margin-top:2px; }
  .emp-join { display:flex; align-items:center; gap:8px; margin-bottom:12px; font-size:12.5px; color:var(--muted); }
  .emp-join input { padding:6px 8px; border:1px solid var(--line); border-radius:7px; font:inherit; }
  .btn.sm { padding:6px 11px; font-size:12px; }
  .cal-head { display:flex; align-items:center; justify-content:space-between; font-weight:650; font-size:13px; margin-bottom:6px; }
  .cal-nav { border:1px solid var(--line); background:var(--surface); border-radius:6px; width:26px; height:26px; cursor:pointer; font-size:15px; line-height:1; }
  .cal-dow { display:grid; grid-template-columns:repeat(7,1fr); gap:4px; font-size:10px; color:var(--muted); text-align:center; margin-bottom:4px; }
  .cal-grid { display:grid; grid-template-columns:repeat(7,1fr); gap:4px; }
  .cal-cell { aspect-ratio:1; min-width:0; min-height:0; display:flex; align-items:center; justify-content:center; font-size:12px; border:1px solid var(--line); border-radius:7px; background:var(--surface); cursor:pointer; user-select:none; }
  .cal-cell.empty { border:0; background:transparent; cursor:default; }
  .cal-cell.today { outline:2px solid var(--accent); outline-offset:-2px; font-weight:700; }
  .cal-cell.present { background:var(--present-bg); border-color:var(--present-line); color:var(--present-txt); }
  .cal-cell.leave { background:var(--leave-bg); border-color:var(--leave-line); color:var(--leave-txt); }
  .cal-legend { margin-top:9px; font-size:11px; color:var(--txt2); display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .cal-legend .k { width:11px; height:11px; border-radius:3px; display:inline-block; }
  .cal-legend .k.present { background:var(--present-line); } .cal-legend .k.leave { background:var(--leave-line); }
  .cal-legend .muted { color:var(--muted); }
  .owner-grid { display:grid; grid-template-columns:1fr; gap:10px; }
  .owner-card { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:13px 15px; cursor:pointer; }
  .owner-card:hover { border-color:var(--accent); background:var(--accent-weak); }
  .owner-card .on { font-weight:620; font-size:14.5px; }
  .owner-card .os { font-size:12px; color:var(--muted); margin-top:3px; }
  .back { background:none; border:0; color:var(--accent); cursor:pointer; font:inherit; font-size:12.5px; padding:0; margin-bottom:10px; }
  .controls { display:flex; flex-wrap:wrap; gap:10px; padding:14px 28px; align-items:center; }
  select, input, textarea { font:inherit; background:var(--surface); color:var(--txt); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-size:13px; }
  input:focus, select:focus, textarea:focus { outline:2px solid var(--accent-weak); border-color:var(--accent); }
  input[type=search] { min-width:240px; flex:1; }
  /* Consistent chevron on every native <select> (no stock OS triangle) */
  select { -webkit-appearance:none; -moz-appearance:none; appearance:none; padding-right:30px;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238a94a6' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
    background-repeat:no-repeat; background-position:right 11px center; cursor:pointer; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:14px; padding:8px 28px 64px; }
  .card { position:relative; background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:15px 16px; box-shadow:var(--shadow); transition:transform .14s,box-shadow .14s,border-color .14s; overflow:hidden; }
  .card::before { content:""; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--cardc,var(--accent)); }
  .card:hover { transform:translateY(-3px); box-shadow:var(--shadow-md); }
  .card.manual { border-style:dashed; }
  .card h3 { margin:0 0 8px; font-size:14.5px; font-weight:660; padding-right:44px; letter-spacing:-.01em; }
  .meta { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0; }
  .tag { font-size:11px; padding:2px 8px; border-radius:6px; background:var(--line2); color:var(--txt2); border:1px solid var(--line); white-space:nowrap; }
  .tag.state { font-weight:600; }
  .tag.live { color:var(--good); background:var(--good-bg); border-color:var(--good-line); }
  .tag.src { color:var(--accent); background:var(--accent-weak); border-color:var(--accent-line); }
  .tag.unassigned-tag { color:#b45309; background:#fef3c7; border-color:#fcd9a5; font-weight:650; }
  [data-theme="dark"] .tag.unassigned-tag { color:#fcd34d; background:#2a2410; border-color:#5a4a15; }
  /* Light highlight for unassigned dashboards in the regular list */
  .card.unassigned { border-color:#fcd9a5; background:color-mix(in srgb, #f59e0b 5%, var(--surface)); }
  [data-theme="dark"] .card.unassigned { border-color:#5a4a15; background:color-mix(in srgb, #f59e0b 9%, var(--surface)); }
  .dtable .drow.unassigned { background:color-mix(in srgb, #f59e0b 6%, transparent); }
  .dtable .drow.unassigned:hover { background:color-mix(in srgb, #f59e0b 12%, transparent); }
  .status { font-size:13px; margin:9px 0 4px; color:var(--txt2); }
  .label { color:var(--muted); font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; font-weight:600; }
  .field { margin-top:7px; }
  .field .val { font-size:12.5px; color:var(--txt2); }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .foot { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:11px; padding-top:9px; border-top:1px solid var(--line2); font-size:11.5px; color:var(--muted); }
  .upd { margin-top:9px; padding:8px 10px; background:var(--accent-weak); border:1px solid var(--accent-line); border-radius:8px; }
  .upd .label { color:var(--accent); }
  .upd .val { font-size:12.5px; color:var(--txt2); margin-top:2px; }
  .upd-btn { font:inherit; font-size:11.5px; font-weight:600; color:var(--accent); background:var(--surface); border:1px solid var(--accent-line); border-radius:7px; padding:4px 9px; cursor:pointer; }
  .upd-btn:hover { background:var(--accent-weak); }
  /* Update modal */
  @keyframes bgFadeIn { from{ opacity:0; } to{ opacity:1; } }
  @keyframes modalPop { from{ opacity:0; transform:translateY(10px) scale(.97); } to{ opacity:1; transform:none; } }
  .modal-bg { position:fixed; inset:0; background:var(--overlay); backdrop-filter:blur(4px) saturate(1.1); -webkit-backdrop-filter:blur(4px) saturate(1.1); display:none; z-index:60; align-items:center; justify-content:center; }
  .modal-bg.open { display:flex; animation:bgFadeIn .15s ease; }
  .modal-bg.open .modal { animation:modalPop .18s cubic-bezier(.16,1,.3,1); }
  .modal { background:var(--surface); border-radius:14px; width:min(460px,94vw); max-height:88vh; overflow-y:auto; box-shadow:0 20px 50px rgba(16,24,40,.25); }
  .modal-head { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:flex-start; gap:10px; }
  .modal-head h3 { margin:0; font-size:16px; }
  .modal-head .sub { font-size:12px; color:var(--muted); margin-top:2px; }
  .modal-body { padding:16px 20px 20px; }
  .modal-body label { display:block; font-size:12px; color:var(--muted); margin-bottom:5px; }
  .modal-body select, .modal-body textarea, .modal-body input { width:100%; margin-bottom:13px; }
  .modal-body textarea { min-height:64px; resize:vertical; }
  .timeline { margin-top:6px; border-top:1px solid var(--line2); padding-top:10px; }
  .tl-item { display:flex; gap:9px; align-items:flex-start; padding:7px 0; border-bottom:1px solid var(--line2); }
  .tl-item .tl-dot { width:9px; height:9px; border-radius:50%; margin-top:4px; flex:none; }
  .tl-item .tl-main { flex:1; }
  .tl-item .tl-date { font-size:11px; color:var(--muted); }
  .tl-item .tl-note { font-size:13px; }
  .tl-item .tl-del { border:0; background:none; color:var(--muted); cursor:pointer; font-size:14px; }
  .tl-item .tl-del:hover { color:var(--danger); }
  .roster-add { display:flex; gap:8px; margin-bottom:14px; }
  .roster-add input { flex:1; margin:0; }
  .digest-bar { display:flex; flex-direction:column; gap:12px; margin-bottom:14px; padding:12px 14px; background:var(--accent-weak); border:1px solid var(--accent-line); border-radius:11px; }
  .digest-bar .dg-row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .digest-bar .dg-row + .dg-row { padding-top:11px; border-top:1px solid var(--accent-line); }
  .digest-bar .dg-main { display:flex; flex-direction:column; gap:3px; flex:1; min-width:240px; }
  .digest-bar .dgi { font-size:12.5px; color:var(--txt2); }
  .digest-bar #digestLast, .digest-bar #dailyLast { font-size:11.5px; color:var(--muted); }
  .digest-bar .sub { font-size:12px; white-space:nowrap; }
  .wl-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:12px; margin:10px 0 4px; }
  .wl-card { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:13px 14px; }
  .wl-head { display:flex; align-items:center; gap:9px; }
  .wl-name { font-weight:600; font-size:13.5px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .wl-meta { font-size:11.5px; color:var(--muted); margin:7px 0 6px; }
  .wl-bar { height:7px; border-radius:5px; background:var(--line2); overflow:hidden; }
  .wl-bar i { display:block; height:100%; border-radius:5px; }
  .wl-pill { font-size:10px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; padding:2px 8px; border-radius:999px; }
  .wl-pill.free, .wl-bar i.free { background:#e7f7ee; color:#0e7a52; } .wl-bar i.free { background:#22c55e; }
  .wl-pill.ok, .wl-bar i.ok { background:#e8f0fe; color:#1d4ed8; } .wl-bar i.ok { background:#3b82f6; }
  .wl-pill.busy, .wl-bar i.busy { background:#fef3dc; color:#b45309; } .wl-bar i.busy { background:#f59e0b; }
  .wl-pill.full, .wl-bar i.full { background:#fdeee3; color:#c2410c; } .wl-bar i.full { background:#ef4444; }
  /* Assign tab: pad the body to line up with the header, and keep it readable
     instead of stretching edge-to-edge on wide screens. */
  .asg-wrap { padding:6px 28px 60px; }
  .asg-queue { max-width:900px; display:flex; flex-direction:column; gap:8px; margin-top:4px; }
  .asg-row { display:flex; gap:12px; align-items:center; background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:11px 14px; box-shadow:var(--shadow); }
  .asg-row .dn { font-weight:600; font-size:13.5px; } .asg-row .dmeta { font-size:12px; color:var(--muted); margin-top:1px; }
  .asg-act { margin-left:auto; display:flex; gap:8px; align-items:center; flex:0 0 auto; }
  .asg-sel { font:inherit; font-size:12.5px; padding:5px 8px; border:1px solid var(--line); border-radius:8px; background:var(--surface); color:var(--txt); }
  /* Tutorials tab */
  .tut-wrap { padding:6px 28px 60px; max-width:920px; }
  .tut-card { background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:16px 18px; margin-bottom:16px; box-shadow:var(--shadow); }
  .tut-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
  .tut-head h3 { margin:0; font-size:16px; font-weight:680; }
  .tut-actions { display:flex; gap:6px; flex:0 0 auto; }
  .tut-body { font-size:13.5px; color:var(--txt2); white-space:pre-wrap; line-height:1.6; margin-top:8px; }
  .tut-videos { display:grid; gap:12px; margin-top:12px; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); }
  .tut-video { position:relative; padding-top:56.25%; border-radius:10px; overflow:hidden; background:#000; border:1px solid var(--line); }
  .tut-video iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
  .tut-card .thumbs, .tut-card .dlinks { margin-top:12px; }
  /* Unassigned tab — client-wise grouping */
  .un-groups { padding:8px 28px 64px; }
  .un-group { margin-bottom:22px; }
  .un-ghead { display:flex; align-items:center; gap:9px; font-size:14px; font-weight:700; color:var(--txt); margin:0 0 11px; padding-bottom:7px; border-bottom:2px solid var(--accent-line); }
  .un-gcount { font-size:11px; font-weight:700; color:var(--accent); background:var(--accent-weak); border:1px solid var(--accent-line); border-radius:999px; padding:1px 9px; }
  .un-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:14px; }
  .dtable .tgroup td { background:var(--surface2); font-weight:700; font-size:11.5px; text-transform:uppercase; letter-spacing:.03em; color:var(--txt2); padding:9px 12px; }
  .dtable .tgroup .tgcount { display:inline-block; margin-left:9px; color:var(--accent); }
  /* My Work tab */
  .mw-wrap { padding:6px 28px 60px; max-width:1000px; }
  .who-row { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:18px; }
  .who-lbl { font-size:12px; color:var(--muted); font-weight:600; }
  .who-chips { display:flex; gap:8px; flex-wrap:wrap; }
  .who-chip { display:inline-flex; align-items:center; gap:7px; font:inherit; font-size:13px; font-weight:600; color:var(--txt2); background:var(--surface); border:1px solid var(--line); border-radius:999px; padding:4px 13px 4px 4px; cursor:pointer; }
  .who-chip:hover { border-color:var(--accent-line); }
  .who-chip.on { background:var(--accent-weak); border-color:var(--accent); color:var(--accent); }
  .mw-kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:18px; }
  @media (max-width:640px){ .mw-kpis { grid-template-columns:repeat(2,1fr); } }
  .mw-kpi { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:12px 14px; box-shadow:var(--shadow); }
  .mw-kpi.warn { border-color:var(--warn-line); background:var(--warn-bg); }
  .mw-kpi.bad { border-color:var(--danger); background:color-mix(in srgb, var(--danger) 9%, transparent); }
  .mw-k-n { font-size:24px; font-weight:800; line-height:1; }
  .mw-k-l { font-size:11.5px; color:var(--muted); margin-top:4px; }
  .mw-alerts { display:flex; flex-direction:column; gap:8px; }
  .mw-alert { display:flex; align-items:center; gap:14px; background:var(--surface); border:1px solid var(--line); border-left:4px solid var(--warn-line); border-radius:10px; padding:11px 14px; cursor:pointer; box-shadow:var(--shadow); }
  .mw-alert.over { border-left-color:var(--danger); }
  .mw-alert:hover { border-color:var(--accent-line); }
  .mw-a-due { flex:0 0 auto; min-width:96px; }
  .mw-a-name { font-weight:650; font-size:13.5px; }
  .mw-a-meta { font-size:12px; color:var(--muted); margin-top:2px; }
  .mw-clear { font-size:13px; color:var(--good); background:var(--good-bg); border:1px solid var(--good-line); border-radius:10px; padding:12px 14px; }
  .mw-client { margin-top:12px; background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:4px 14px 8px; box-shadow:var(--shadow); }
  .mw-ch { display:flex; align-items:center; gap:9px; padding:10px 0 8px; border-bottom:1px solid var(--line2); margin-bottom:2px; }
  .mw-cn { font-weight:700; font-size:13.5px; }
  .mw-cc { font-size:11px; font-weight:700; color:var(--accent); background:var(--accent-weak); border:1px solid var(--accent-line); border-radius:999px; padding:1px 8px; }
  .mw-row { display:flex; align-items:center; gap:14px; padding:10px 0; border-bottom:1px solid var(--line2); cursor:pointer; }
  .mw-row:last-child { border-bottom:0; }
  .mw-row:hover .mw-r-name { color:var(--accent); }
  .mw-row.done { opacity:.55; }
  .mw-r-main { flex:1; min-width:0; }
  .mw-r-name { font-weight:600; font-size:13.5px; }
  .mw-r-stage { font-size:12px; color:var(--txt2); margin-top:3px; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .mw-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
  .mw-next { color:var(--muted); }
  .mw-r-track { height:5px; border-radius:4px; background:var(--line2); overflow:hidden; margin-top:6px; max-width:320px; }
  .mw-r-track i { display:block; height:100%; }
  .mw-r-due { flex:0 0 auto; }
  .due-chip { font-size:11.5px; font-weight:700; border-radius:999px; padding:3px 10px; white-space:nowrap; background:var(--surface2); border:1px solid var(--line); color:var(--txt2); }
  .due-chip.soon { color:var(--warn-txt); background:var(--warn-bg); border-color:var(--warn-line); }
  .due-chip.over { color:#fff; background:var(--danger); border-color:var(--danger); }
  .due-chip.none { color:var(--muted); font-weight:500; }
  /* Team card deadline badge */
  .dl-badge { font-size:10.5px; font-weight:700; border-radius:999px; padding:2px 8px; white-space:nowrap; }
  .dl-badge.over { color:#fff; background:var(--danger); }
  .dl-badge.soon { color:var(--warn-txt); background:var(--warn-bg); border:1px solid var(--warn-line); }
  /* Per-dashboard working notes (detail-modal scratchpad) */
  .dnotes-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
  .dnotes-hint { font-size:11px; color:var(--muted); font-weight:400; }
  .dnote-add { display:flex; gap:8px; margin:8px 0 10px; }
  .dnote-add input { flex:1; min-width:0; margin:0; }
  .dnotes { display:flex; flex-direction:column; gap:6px; }
  .dnote-item { display:flex; align-items:flex-start; gap:10px; background:var(--surface2); border:1px solid var(--line); border-radius:9px; padding:8px 11px; }
  .dnote-tx { flex:1; font-size:13px; color:var(--txt); white-space:pre-wrap; word-break:break-word; }
  .dnote-del { flex:0 0 auto; border:0; background:transparent; color:var(--muted); cursor:pointer; font-size:16px; line-height:1; padding:0 2px; }
  .dnote-del:hover { color:var(--danger); }
  /* Profile → Dashboards: tap-to-expand inline notes */
  .pnote-list { display:flex; flex-direction:column; gap:8px; margin-top:6px; }
  .pnote-dash { border:1px solid var(--line); border-radius:11px; background:var(--surface); overflow:hidden; }
  .pnote-dash.done { opacity:.62; }
  .pnote-row { display:flex; align-items:center; gap:11px; padding:11px 13px; cursor:pointer; user-select:none; }
  .pnote-row:hover { background:var(--accent-weak); }
  .pnote-chev { font-size:11px; color:var(--muted); transition:transform .15s; flex:0 0 auto; }
  .pnote-dash.open .pnote-chev { transform:rotate(90deg); }
  .pnote-main { flex:1; min-width:0; }
  .pnote-name { font-weight:600; font-size:13.5px; }
  .pnote-sub { font-size:12px; color:var(--muted); margin-top:3px; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .pnote-count { font-size:11.5px; font-weight:600; color:var(--muted); flex:0 0 auto; }
  .pnote-count.has { color:var(--accent); }
  .pnote-panel { padding:0 13px 13px; border-top:1px solid var(--line2); }
  .pnote-panel .dnote-add { margin:11px 0 10px; }
  .ck-card { background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:16px 18px; margin-bottom:14px; }
  .ck-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
  .ck-name { font-weight:650; font-size:15px; }
  .ck-sub { font-size:12px; color:var(--muted); margin-top:2px; }
  .ck-pct { font-size:13px; color:var(--txt2); white-space:nowrap; } .ck-pct b { color:#0e7a52; }
  .ck-bar { height:6px; border-radius:4px; background:var(--line2); overflow:hidden; margin:10px 0 6px; }
  .ck-bar i { display:block; height:100%; background:#22c55e; border-radius:4px; }
  .ck-row { display:flex; gap:11px; align-items:flex-start; padding:11px 0; border-bottom:1px solid var(--line2); }
  .ck-row:last-child { border-bottom:0; }
  .ck-box { position:relative; flex:0 0 auto; width:20px; height:20px; margin-top:1px; cursor:pointer; }
  .ck-box input { position:absolute; opacity:0; width:100%; height:100%; margin:0; cursor:pointer; }
  .ck-mark { display:block; width:20px; height:20px; border:2px solid var(--line); border-radius:6px; background:var(--card); transition:.15s; }
  .ck-box input:checked + .ck-mark { background:#22c55e; border-color:#22c55e; }
  .ck-box input:checked + .ck-mark::after { content:'✓'; color:#fff; font-size:13px; font-weight:800; position:absolute; left:4px; top:-1px; }
  .ck-main { flex:1; min-width:0; }
  .ck-title { font-weight:550; font-size:13.5px; }
  .ck-cat { font-size:9px; font-weight:800; letter-spacing:.05em; text-transform:uppercase; color:var(--accent); background:var(--accent-weak); border-radius:5px; padding:2px 6px; margin-right:7px; }
  .ck-done .ck-title { text-decoration:line-through; color:var(--muted); }
  .ck-text { font-size:12.5px; color:var(--txt2); margin:3px 0 6px; }
  .ck-proof { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .ck-noproof { font-size:11.5px; color:#b4791e; font-style:italic; }
  .ck-plabel { font-size:10px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); margin-right:2px; }
  .ck-pend { color:#b4791e; }
  .ck-toolbar { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:14px; padding:11px 16px; background:var(--surface); border:1px solid var(--line); border-radius:12px; }
  .ck-stats { display:flex; gap:18px; font-size:13px; color:var(--txt2); }
  .ck-stats b { font-size:16px; color:var(--txt); margin-right:3px; } .ck-stats .ck-ok b { color:#0e7a52; } .ck-stats .ck-warn b { color:#b4791e; }
  .ck-filter { display:inline-flex; align-items:center; gap:7px; font-size:13px; color:var(--txt2); cursor:pointer; }
  .ck-client { display:flex; align-items:center; gap:11px; }
  .ck-client .avatar, .ck-client .clogo { width:34px; height:34px; border-radius:9px; font-size:16px; flex:0 0 auto; }
  .ck-client .clogo { object-fit:cover; }
  .ck-meta { font-size:11.5px; color:var(--muted); margin:4px 0 6px; }
  .ck-badge { font-size:9px; font-weight:800; letter-spacing:.05em; text-transform:uppercase; color:#b4791e; background:#fef3dc; border-radius:5px; padding:2px 6px; margin-left:8px; vertical-align:middle; }
  .ck-done .ck-badge { display:none; }
  .pf-chip { display:inline-flex; align-items:center; gap:4px; font-size:11.5px; background:var(--accent-weak); border:1px solid var(--accent-line); border-radius:999px; padding:2px 4px 2px 9px; }
  .pf-chip a { color:var(--accent); text-decoration:none; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pf-x { border:0; background:none; color:var(--muted); cursor:pointer; font-size:14px; line-height:1; padding:0 3px; }
  .btn.xs { font-size:11px; padding:3px 8px; }
  /* ── Client Requests board ─────────────────────────────────────────── */
  .rq-hero { display:flex; gap:18px; align-items:center; justify-content:space-between; flex-wrap:wrap; background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:18px 22px; box-shadow:var(--shadow); margin-bottom:14px; }
  .rq-heroL { flex:1; min-width:220px; }
  .rq-pct { font-size:34px; font-weight:770; letter-spacing:-.02em; line-height:1; }
  .rq-pcap { font-size:12.5px; color:var(--muted); margin:4px 0 10px; }
  .rq-hbar { height:8px; border-radius:6px; background:var(--line2); overflow:hidden; max-width:440px; }
  .rq-hbar i { display:block; height:100%; background:linear-gradient(90deg,#7381e6,#21ba72); border-radius:6px; transition:width .6s; }
  .rq-kpis { display:flex; gap:24px; }
  .rq-k { text-align:center; } .rq-k b { display:block; font-size:22px; font-weight:750; } .rq-k b.ok { color:#0e9f6e; } .rq-k b.warn { color:#c2701c; }
  .rq-k span { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; }
  .rq-tools { display:flex; gap:10px; margin-bottom:14px; flex-wrap:wrap; }
  .rq-srch { flex:1; min-width:200px; font:inherit; font-size:13.5px; padding:9px 13px; border:1px solid var(--line); border-radius:10px; background:var(--surface); color:var(--txt); }
  .rq-sel { font:inherit; font-size:13.5px; padding:9px 11px; border:1px solid var(--line); border-radius:10px; background:var(--surface); color:var(--txt); }
  .rq-board { display:grid; grid-template-columns:1fr 1fr; gap:14px; align-items:start; }
  @media (max-width:820px){ .rq-board { grid-template-columns:1fr; } }
  .rq-col { background:var(--surface2); border:1px solid var(--line); border-radius:14px; padding:12px; }
  .rq-ch { display:flex; align-items:center; justify-content:space-between; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); padding:4px 6px 11px; }
  .rq-ch b { font-size:12px; color:var(--txt); background:var(--line2); border-radius:20px; padding:1px 9px; }
  .rq-ch.done { color:#0e9f6e; }
  .rq-list { display:flex; flex-direction:column; gap:10px; }
  .rq-card { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:13px 14px; box-shadow:var(--shadow); transition:box-shadow .12s,transform .12s; }
  .rq-card:hover { box-shadow:var(--shadow-md); transform:translateY(-1px); }
  .rq-done { opacity:.72; }
  .rq-ctop { display:flex; align-items:center; justify-content:space-between; margin-bottom:7px; }
  .rq-cl { display:inline-flex; align-items:center; gap:6px; font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; color:var(--txt2); }
  .rq-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
  .rq-av .avatar { width:22px; height:22px; font-size:10px; }
  .rq-ttl { font-size:14px; font-weight:600; }
  .rq-done .rq-ttl { color:var(--muted); }
  .rq-txt { font-size:12.5px; color:var(--txt2); margin:3px 0; }
  .rq-dash { font-size:11.5px; color:var(--muted); margin:5px 0 11px; }
  .rq-foot { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .rq-pfs { display:flex; align-items:center; gap:5px; flex-wrap:wrap; }
  .rq-pf { text-decoration:none; font-size:13px; width:26px; height:26px; display:grid; place-items:center; background:var(--accent-weak); border:1px solid var(--accent-line); border-radius:7px; }
  .rq-np { font-size:11px; color:#c2701c; font-style:italic; }
  .rq-add { width:26px; height:26px; border:1px dashed var(--line); border-radius:7px; background:none; color:var(--muted); cursor:pointer; font-size:15px; line-height:1; }
  .rq-add:hover { border-color:var(--accent); color:var(--accent); }
  .rq-btn { font:inherit; font-size:12px; font-weight:600; padding:6px 12px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; white-space:nowrap; }
  .rq-btn.undo { background:none; color:#0e9f6e; border-color:#bfe6cf; }
  .rq-tag { font-size:11px; font-weight:700; color:#c2701c; background:#fdf1e3; border-radius:20px; padding:3px 10px; }
  .rq-tag.ok { color:#0e9f6e; background:#e6f7ef; }
  .rq-empty { font-size:12.5px; color:var(--muted); text-align:center; padding:18px; }
  .owner-card .rm { float:right; border:1px solid var(--line); background:var(--surface); color:var(--muted); border-radius:6px; cursor:pointer; font-size:13px; width:22px; height:22px; }
  .owner-card .rm:hover { color:var(--danger); border-color:var(--danger-line); }
  .cardbtns { position:absolute; top:10px; right:10px; display:flex; gap:5px; }
  .del, .edit { width:22px; height:22px; border-radius:6px; border:1px solid var(--line); background:var(--surface); color:var(--muted); cursor:pointer; line-height:1; font-size:13px; }
  .del:hover { color:var(--danger); border-color:var(--danger-line); }
  .edit:hover { color:var(--accent); border-color:var(--accent-line); }
  .del:hover { color:var(--danger); border-color:var(--danger-line); background:var(--danger-bg); }
  .group-h { grid-column:1/-1; margin:16px 0 2px; font-size:12.5px; font-weight:600; color:var(--muted); }
  .warn { padding:9px 28px; background:var(--warn-bg); color:var(--warn-txt); font-size:12px; border-bottom:1px solid var(--warn-line); }
  .empty { padding:48px 28px; color:var(--muted); }
  /* Add-entry panel */
  .panel { display:none; padding:16px 28px; background:var(--surface); border-bottom:1px solid var(--line); }
  .panel-title { font-weight:650; font-size:14px; margin-bottom:12px; }
  .panel.open { display:block; }
  .form-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px; }
  .form-grid label, .form-grid .field { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--muted); }
  .panel-actions { margin-top:12px; display:flex; gap:10px; align-items:center; }
  .msg { font-size:12.5px; }
  .msg.err { color:var(--danger); } .msg.ok { color:var(--good); }
  /* KPI hero */
  /* Dashboards Cards ⇄ Table view toggle */
  .view-seg { display:inline-flex; background:var(--surface2); border:1px solid var(--line); border-radius:9px; padding:2px; gap:2px; margin-left:auto; }
  .vseg { font:inherit; font-size:12px; font-weight:600; color:var(--muted); background:transparent; border:0; border-radius:7px; padding:5px 12px; cursor:pointer; }
  .vseg.on { background:var(--surface); color:var(--accent); box-shadow:var(--shadow); }
  /* Dashboards table view */
  .grid.table-mode { display:block; }
  .table-wrap { overflow-x:auto; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); box-shadow:var(--shadow); }
  /* table-layout:fixed + an explicit colgroup keep header & body columns locked
     in step (auto layout let thead/tbody size columns independently). */
  .dtable { width:100%; min-width:1080px; table-layout:fixed; border-collapse:separate; border-spacing:0; font-size:13px; }
  .dtable thead th { text-align:left; font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; color:var(--muted); padding:11px 14px; border-bottom:1px solid var(--line); background:var(--surface2); position:sticky; top:0; z-index:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .dtable td { padding:10px 14px; border-bottom:1px solid var(--line2); vertical-align:middle; overflow:hidden; }
  .dtable tr:last-child td { border-bottom:0; }
  /* Scope to .dtable + force table-row: a same-named .drow rule elsewhere sets
     display:flex, which would otherwise turn table rows into flex containers. */
  .dtable .drow { display:table-row; cursor:pointer; transition:background .1s; }
  .dtable .drow:hover { background:var(--accent-weak); }
  .tnum { color:var(--muted); font-variant-numeric:tabular-nums; }
  .tname { font-weight:650; color:var(--txt); }
  .tname .tname-in { display:block; overflow:hidden; text-overflow:ellipsis; }
  .tchips { display:flex; flex-wrap:wrap; gap:4px; }
  .tchip { display:inline-block; max-width:100%; font-size:11.5px; background:var(--surface2); border:1px solid var(--line); border-radius:6px; padding:2px 8px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .tchip:hover { border-color:var(--accent); color:var(--accent); }
  .tstage { white-space:nowrap; color:var(--txt2); }
  .tstage-lbl { display:block; overflow:hidden; text-overflow:ellipsis; }
  .tdot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:middle; }
  .tlive { display:inline-flex; align-items:center; gap:4px; font-size:10.5px; font-weight:700; color:var(--good); background:var(--good-bg); border:1px solid var(--good-line); border-radius:999px; padding:1px 7px; margin-left:7px; vertical-align:middle; }
  .ttrack { height:5px; border-radius:4px; background:var(--line2); overflow:hidden; margin-top:5px; }
  .ttrack i { display:block; height:100%; border-radius:4px; transition:width .4s; }
  .tmut { color:var(--muted); }
  .tlink { display:inline-flex; align-items:center; gap:4px; font-size:11.5px; font-weight:600; color:var(--accent); background:var(--accent-weak); border:1px solid var(--accent-line); border-radius:999px; padding:3px 10px; text-decoration:none; white-space:nowrap; max-width:100%; overflow:hidden; text-overflow:ellipsis; }
  .tlink:hover { background:var(--accent); color:#fff; border-color:var(--accent); text-decoration:none; }
  .tacts { white-space:nowrap; text-align:right; }
  .tbtn { display:inline-grid; place-items:center; width:26px; height:26px; border:1px solid var(--line); background:var(--surface); border-radius:7px; cursor:pointer; color:var(--txt2); text-decoration:none; font-size:13px; margin-left:4px; }
  .tbtn:hover { border-color:var(--accent); color:var(--accent); background:var(--accent-weak); }
  .tbtn.del:hover { border-color:var(--danger-line); color:var(--danger); background:var(--danger-bg); }
  .tbtn.pubdone { color:var(--good); border-color:var(--good-line); background:var(--good-bg); }
  .dtable .grp td { background:var(--surface2); font-weight:700; font-size:12px; color:var(--txt2); }
  /* Insights / charts */
  .insights { padding:8px 28px 4px; }
  .ins-toggle { display:inline-flex; align-items:center; gap:7px; font:inherit; font-size:12.5px; font-weight:600; color:var(--muted); background:none; border:0; cursor:pointer; padding:6px 0; }
  .ins-toggle:hover { color:var(--accent); }
  .ins-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:8px; }
  @media (max-width:900px){ .ins-grid { grid-template-columns:1fr; } }
  .ins-card { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:16px; box-shadow:var(--shadow); }
  /* Overall progress + pipeline stepper */
  .ov-head { display:flex; align-items:baseline; gap:10px; margin-bottom:9px; }
  .ov-pct { font-size:30px; font-weight:760; letter-spacing:-.02em; line-height:1; }
  .ov-cap { font-size:12.5px; color:var(--muted); }
  .ov-bar { height:8px; border-radius:6px; background:var(--line2); overflow:hidden; margin-bottom:16px; }
  .ov-bar i { display:block; height:100%; background:linear-gradient(90deg,#7381e6,#21ba72); border-radius:6px; transition:width .6s; }
  .stepper { display:flex; gap:5px; }
  .step { flex:1; text-align:center; cursor:pointer; padding:6px 2px; border-radius:9px; transition:background .12s; }
  .step:hover { background:var(--accent-weak); }
  .step-n { font-size:17px; font-weight:720; letter-spacing:-.01em; font-variant-numeric:tabular-nums; }
  .step-bar { display:block; width:20px; height:3px; border-radius:2px; margin:5px auto; }
  .step-lbl { font-size:9px; color:var(--muted); text-transform:uppercase; letter-spacing:.02em; white-space:nowrap; }
  /* Needs attention cards */
  .att-list { display:flex; flex-direction:column; gap:9px; }
  .att-row { display:flex; align-items:center; gap:12px; padding:11px 13px; border-radius:11px; background:var(--surface2); border:1px solid var(--line2); font:inherit; text-align:left; width:100%; cursor:pointer; transition:background .12s,border-color .12s,box-shadow .12s; }
  .att-row[disabled] { cursor:default; }
  .att-row:not([disabled]):hover { background:var(--surface); border-color:var(--accent-line); box-shadow:var(--shadow); }
  .att-ic { flex:0 0 auto; width:34px; height:34px; border-radius:10px; display:grid; place-items:center; }
  .att-ic svg { width:17px; height:17px; }
  .att-warn .att-ic { background:#fdf1e3; color:#c2701c; } .att-accent .att-ic { background:var(--accent-weak); color:var(--accent); } .att-muted .att-ic { background:var(--line2); color:var(--muted); } .att-good .att-ic { background:#e6f7ef; color:#0e9f6e; }
  .att-big { font-size:22px; font-weight:760; min-width:26px; text-align:center; line-height:1; font-variant-numeric:tabular-nums; }
  .att-warn .att-big { color:#c2701c; } .att-accent .att-big { color:var(--accent); } .att-muted .att-big { color:var(--muted); } .att-good .att-big { color:#0e9f6e; }
  .att-txt { flex:1; min-width:0; }
  .att-main { font-size:13.5px; font-weight:600; }
  .att-sub { font-size:11.5px; color:var(--muted); margin-top:1px; }
  .att-arrow { width:17px; height:17px; color:var(--muted); flex:0 0 auto; transition:transform .12s,color .12s; }
  .att-row:hover .att-arrow { transform:translateX(3px); color:var(--accent); }
  .ins-card h4 { margin:0 0 12px; font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:700; }
  .donut-wrap { display:flex; align-items:center; gap:16px; }
  .donut { position:relative; width:132px; height:132px; flex:none; }
  .donut .center { position:absolute; inset:0; display:grid; place-items:center; text-align:center; }
  .donut .center .big { font-size:26px; font-weight:760; line-height:1; }
  .donut .center .small { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  .leg2 { display:flex; flex-direction:column; gap:6px; }
  .leg2 .li { display:flex; align-items:center; gap:8px; font-size:12px; cursor:pointer; }
  .leg2 .li:hover { color:var(--accent); }
  .leg2 .sw { width:10px; height:10px; border-radius:3px; flex:none; }
  .leg2 .li .v { margin-left:auto; font-weight:650; font-variant-numeric:tabular-nums; color:var(--txt2); }
  .bc { display:flex; flex-direction:column; gap:9px; }
  .bc-row { display:grid; grid-template-columns:1fr; gap:4px; cursor:pointer; }
  .bc-top { display:flex; align-items:center; gap:8px; font-size:12px; }
  .bc-top .nm { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bc-top .ct { margin-left:auto; color:var(--muted); font-variant-numeric:tabular-nums; }
  .bc-track { height:9px; border-radius:5px; background:var(--line2); overflow:hidden; display:flex; }
  .bc-track i { height:100%; display:block; }
  .bc-row:hover .bc-top .nm { color:var(--accent); }
  /* Avatars */
  .avatar { width:22px; height:22px; border-radius:50%; display:inline-grid; place-items:center; font-size:9.5px; font-weight:700; color:#fff; flex:none; letter-spacing:.02em; box-shadow:inset 0 0 0 1px rgba(255,255,255,.18); }
  .avatar.lg { width:44px; height:44px; font-size:16px; border-radius:13px; }
  .av-tag { display:inline-flex; align-items:center; gap:6px; padding:2px 9px 2px 3px; border-radius:999px; background:var(--line2); border:1px solid var(--line); font-size:11px; cursor:pointer; }
  .av-tag:hover { border-color:var(--accent-line); background:var(--accent-weak); color:var(--accent); }
  .av-head { display:flex; align-items:center; gap:12px; }
  .ctag { font-size:11px; padding:2px 9px; border-radius:999px; white-space:nowrap; cursor:pointer; border:1px solid transparent; font-weight:550; }
  .ctag:hover { filter:brightness(.97); border-color:rgba(0,0,0,.06); }
  /* Active legend pill + stage number */
  .pill.on { border-color:var(--accent); background:var(--accent-weak); color:var(--accent); font-weight:600; box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent); }
  .pill.off { opacity:.4; }
  .pill .stage-no, .tag.state b { display:inline-grid; place-items:center; min-width:15px; height:15px; padding:0 3px; border-radius:5px; background:color-mix(in srgb, var(--accent) 14%, transparent); color:var(--accent); font-size:10px; font-weight:700; }
  .tag.state b { background:color-mix(in srgb, currentColor 16%, transparent); color:inherit; }
  /* Priority star + highlighted card */
  .star { width:22px; height:22px; border-radius:6px; border:1px solid var(--line); background:var(--surface); color:#f59e0b; cursor:pointer; line-height:1; font-size:13px; }
  .star:hover { border-color:#fcd34d; background:#fffbeb; }
  .star.on { color:#f59e0b; border-color:#fcd34d; background:#fffbeb; }
  [data-theme="dark"] .star.on, [data-theme="dark"] .star:hover { background:#2a2410; border-color:#5a4a15; }
  .card.prio { border-color:#fcd34d; box-shadow:0 0 0 1px #fcd34d, var(--shadow); }
  .card.prio::after { content:"★ PRIORITY"; position:absolute; top:0; right:0; font-size:8.5px; font-weight:800; letter-spacing:.06em; color:#92670b; background:#fef3c7; padding:2px 7px; border-bottom-left-radius:8px; }
  [data-theme="dark"] .card.prio::after { color:#fcd34d; background:#2a2410; }
  /* Add/Edit modal form */
  .modal-form { position:relative; width:min(680px,95vw); max-height:88vh; overflow:hidden; display:flex; flex-direction:column; }
  .modal-form::before { content:""; position:absolute; top:0; left:0; right:0; height:4px; background:var(--grad); border-radius:14px 14px 0 0; z-index:1; }
  .modal-form .modal-head { flex:0 0 auto; background:var(--grad-soft); border-radius:14px 14px 0 0; }
  .modal-form .modal-body { flex:1 1 auto; min-height:0; overflow-y:auto; }
  .modal-form .form-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:14px; }
  .modal-form .form-grid label.wide, .modal-form .form-grid .field.wide { grid-column:1 / -1; }
  .modal-form .form-grid label, .modal-form .form-grid .field { margin:0; font-weight:600; }
  .modal-form .form-grid input, .modal-form .form-grid select { width:100%; margin:0; font-weight:400; }
  .mini-check { display:flex; flex-direction:row; align-items:center; gap:7px; margin-top:7px; font-size:12px; font-weight:500; color:var(--muted); cursor:pointer; }
  .modal-form .form-grid .mini-check input { width:15px; height:15px; margin:0; flex:0 0 auto; accent-color:var(--accent); cursor:pointer; }
  .rm-client { width:34px; border:1px solid var(--line); background:var(--surface); color:var(--muted); border-radius:8px; cursor:pointer; font-size:15px; }
  .rm-client:hover { color:var(--danger); border-color:var(--danger-line); }
  .modal-form .panel-actions { position:sticky; bottom:-20px; z-index:2; margin:18px -20px -20px; padding:14px 20px;
    background:var(--surface); border-top:1px solid var(--line); border-radius:0 0 14px 14px; }
  /* Priority filter button */
  .btn.prio-btn.on { background:linear-gradient(135deg,#f59e0b,#f97316); box-shadow:0 2px 10px rgba(245,158,11,.35); }
  /* Stage progress bar on cards */
  .prog { margin:2px 0 11px; }
  .prog-top { display:flex; justify-content:space-between; align-items:center; font-size:11px; margin-bottom:5px; }
  .prog-stage { font-weight:680; }
  .prog-pct { color:var(--muted); font-variant-numeric:tabular-nums; font-weight:700; }
  .prog-track { display:flex; gap:3px; }
  .prog-track .seg { flex:1; height:8px; border-radius:3px; background:var(--line2); transition:background .25s, outline .1s; }
  .prog-track .seg.set { cursor:pointer; }
  .prog-track .seg.set:hover { outline:2px solid var(--accent); outline-offset:1px; }
  /* Labeled links on cards */
  .links { margin-top:10px; }
  .links .label { display:block; margin-bottom:3px; }
  .links .lnk { display:inline-flex; align-items:center; gap:3px; font-size:11.5px; font-weight:550; margin:2px 9px 0 0; }
  /* Priority badge in the title */
  .pbadge { display:inline-block; font-size:10px; font-weight:800; letter-spacing:.02em; color:#92670b; background:#fef3c7; border-radius:6px; padding:1px 6px; margin-right:7px; vertical-align:middle; }
  [data-theme="dark"] .pbadge { color:#fcd34d; background:#2a2410; }
  /* Link rows in the form */
  .link-row { display:flex; gap:6px; margin-bottom:6px; }
  .link-row .f_llabel { flex:0 0 42%; min-width:0; }
  .link-row .f_lurl { flex:1; min-width:0; }
  /* Brief-for-the-assignee attach/link tools */
  #f_brief { font-weight:400; line-height:1.5; }
  .brief-links { margin-top:2px; }
  .brief-tools { display:flex; gap:8px; flex-wrap:wrap; margin-top:2px; }
  /* ── Custom attached dropdowns (Clients multi-select + Assigned-to combo) ── */
  .dd { position:relative; }
  .dd-menu { position:absolute; left:0; right:0; top:calc(100% + 5px); z-index:70;
    background:var(--surface); border:1px solid var(--line); border-radius:11px;
    box-shadow:var(--shadow-lg); max-height:240px; overflow-y:auto; overflow-x:hidden;
    padding:5px; display:none; }
  .dd.open > .dd-menu { display:block; }
  .dd-opt { display:flex; align-items:center; gap:9px; padding:8px 10px; border-radius:8px;
    font-size:13.5px; color:var(--txt); cursor:pointer; user-select:none; }
  .dd-opt:hover, .dd-opt.active { background:var(--accent-weak); }
  .modal-form .form-grid .dd-opt input { width:16px; height:16px; margin:0; flex:0 0 auto; accent-color:var(--accent); cursor:pointer; }
  .dd-opt.on { color:var(--accent); font-weight:600; }
  .dd-add { display:flex; align-items:center; gap:7px; padding:8px 10px; margin-top:2px;
    border-top:1px solid var(--line2); border-radius:0 0 8px 8px; font-size:12.5px;
    color:var(--accent); cursor:pointer; }
  .dd-add:hover { background:var(--accent-weak); }
  .dd-empty { padding:11px 10px; color:var(--muted); font-size:12.5px; text-align:center; }
  /* multi-select control: chips + inline search, styled like an input box */
  .ms-control { display:flex; flex-wrap:wrap; align-items:center; gap:6px; min-height:42px;
    padding:6px 34px 6px 8px; border:1px solid var(--line); border-radius:8px;
    background:var(--surface); cursor:text; }
  .dd.open .ms-control, .ms-control:focus-within { border-color:var(--accent);
    outline:2px solid var(--accent-weak); outline-offset:-1px; }
  .ms-chip { display:inline-flex; align-items:center; gap:5px; background:var(--accent-weak);
    border:1px solid var(--accent-line); color:var(--accent); border-radius:7px;
    padding:3px 5px 3px 9px; font-size:12.5px; font-weight:600; line-height:1.4; }
  .ms-chip button { border:0; background:transparent; color:inherit; cursor:pointer;
    font-size:15px; line-height:1; padding:0 1px; opacity:.65; }
  .ms-chip button:hover { opacity:1; }
  .modal-form .form-grid .ms-search { flex:1; min-width:70px; width:auto; border:0; outline:0;
    background:transparent; font-size:13.5px; padding:4px 2px; margin:0; color:var(--txt); }
  .modal-form .form-grid .ms-search:focus { outline:0; }
  .ms-caret { position:absolute; right:12px; top:14px; width:12px; height:12px;
    pointer-events:none; color:var(--muted); }
  .combo-input { padding-right:30px !important; }
  /* Custom due-date picker */
  .date-wrap { position:relative; }
  .date-trigger { display:flex; align-items:center; gap:9px; width:100%; text-align:left; cursor:pointer;
    background:var(--surface); border:1px solid var(--line); border-radius:8px; padding:9px 11px; font:inherit; font-size:13.5px; color:var(--txt); }
  .date-trigger:hover { border-color:var(--accent); }
  .datepick.open .date-trigger { border-color:var(--accent); outline:2px solid var(--accent-weak); outline-offset:-1px; }
  .date-trigger .df-ico { color:var(--accent); width:16px; height:16px; flex:0 0 auto; }
  .date-lbl { flex:1; font-variant-numeric:tabular-nums; }
  .date-lbl.muted { color:var(--muted); }
  .date-trigger .ms-caret { width:12px; height:12px; color:var(--muted); flex:0 0 auto; }
  .date-clear { border:0; background:var(--line2); color:var(--muted); width:19px; height:19px; border-radius:50%;
    display:grid; place-items:center; cursor:pointer; font-size:13px; line-height:1; flex:0 0 auto; padding:0; }
  .date-clear[hidden] { display:none; }
  .date-clear:hover { background:var(--danger-bg); color:var(--danger); }
  .cal-menu { left:0; right:auto; width:296px; max-height:none; overflow:visible; padding:0; }
  .datepick.open > .date-wrap > .cal-menu { display:block; }
  .cal { padding:12px 13px 13px; }
  .cal-head { display:flex; align-items:center; justify-content:space-between;
    margin:-12px -13px 11px; padding:12px 13px 10px; background:var(--grad-soft); border-radius:11px 11px 0 0; }
  .cal-title { font-size:14px; font-weight:800; color:var(--accent); letter-spacing:-.01em; }
  .cal-nav { display:inline-flex; gap:5px; }
  .cal-nav button { width:26px; height:26px; border-radius:8px; border:1px solid var(--accent-line); background:var(--surface); color:var(--accent); cursor:pointer; font-size:15px; line-height:1; display:grid; place-items:center; transition:background .12s,color .12s,transform .12s; }
  .cal-nav button:hover { background:var(--grad); color:#fff; border-color:transparent; transform:translateY(-1px); }
  .cal-grid { display:grid; grid-template-columns:repeat(7,1fr); gap:3px; }
  .cal-dow { font-size:10px; font-weight:800; color:var(--muted); text-align:center; padding:3px 0 7px; text-transform:uppercase; letter-spacing:.03em; }
  .cal-dow:nth-child(7n+1), .cal-dow:nth-child(7n) { color:var(--accent2); }
  .cal-day { aspect-ratio:1; border:0; margin:0; padding:0; min-width:0; width:100%; appearance:none; -webkit-appearance:none;
    background:transparent; border-radius:9px; font:inherit; font-size:12.5px; color:var(--txt); cursor:pointer;
    display:grid; place-items:center; transition:background .12s,transform .12s,color .12s; }
  .cal-day:nth-child(7n+1):not(.other), .cal-day:nth-child(7n):not(.other) { background:color-mix(in srgb, var(--accent2) 9%, transparent); }
  .cal-day:hover:not(.other):not(.sel) { background:var(--accent-weak); color:var(--accent); transform:scale(1.08); }
  .cal-day.other { color:transparent; pointer-events:none; }
  .cal-day.today { box-shadow:inset 0 0 0 2px var(--accent); color:var(--accent); font-weight:800; }
  .cal-day.sel { background:var(--grad); color:#fff; font-weight:800; box-shadow:0 3px 12px color-mix(in srgb, var(--accent) 45%, transparent); }
  .cal-day.sel:hover { background:var(--grad); color:#fff; transform:scale(1.08); }
  /* Visit button on dashboard cards */
  .visit-btn { display:inline-flex; align-items:center; gap:4px; font-size:11.5px; font-weight:650;
    color:var(--accent); background:var(--accent-weak); border:1px solid var(--accent-line);
    border-radius:999px; padding:4px 11px; text-decoration:none; white-space:nowrap; transition:background .12s,color .12s; }
  .visit-btn:hover { background:var(--accent); color:#fff; border-color:var(--accent); }
  .foot-actions { display:inline-flex; align-items:center; gap:8px; }
  /* ── Standup / EOD ─────────────────────────────────────────────────── */
  .eod { padding:6px 28px 4px; }
  .eod-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; }
  .eod-head h3 { margin:0; font-size:15px; }
  .eod-sub { font-size:12px; color:var(--muted); margin-top:2px; }
  .eod-total { font-size:12.5px; font-weight:700; color:var(--accent); background:var(--accent-weak); border:1px solid var(--accent-line); border-radius:999px; padding:5px 12px; white-space:nowrap; }
  .eod-empty { font-size:12.5px; color:var(--muted); background:var(--surface); border:1px dashed var(--line); border-radius:var(--radius); padding:16px; text-align:center; }
  .eod-list { display:flex; flex-direction:column; gap:8px; }
  .eod-row { display:grid; grid-template-columns:190px 160px 1fr; gap:14px; align-items:center; background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:11px 14px; box-shadow:var(--shadow); }
  @media (max-width:860px){ .eod-row { grid-template-columns:1fr; gap:9px; } }
  .eod-who { display:flex; align-items:center; gap:9px; min-width:0; }
  .eod-name { font-weight:650; font-size:13.5px; }
  .eod-mini { font-size:11px; color:var(--muted); }
  .eod-prog { display:flex; align-items:center; gap:8px; }
  .eod-bar { flex:1; height:8px; border-radius:5px; background:var(--line2); overflow:hidden; }
  .eod-bar i { display:block; height:100%; background:linear-gradient(90deg,#7381e6,#21ba72); border-radius:5px; transition:width .5s; }
  .eod-bar.full i { background:var(--good); }
  .eod-pct { font-size:12px; font-weight:700; font-variant-numeric:tabular-nums; color:var(--txt2); min-width:34px; text-align:right; }
  .eod-tasks { display:flex; flex-wrap:wrap; gap:5px; }
  .eod-chip { font-size:11px; color:var(--txt2); background:var(--surface2); border:1px solid var(--line); border-radius:6px; padding:2px 8px; }
  .eod-chip.done { color:var(--good); background:var(--good-bg); border-color:var(--good-line); }
  .mtg-card { display:flex; align-items:center; justify-content:space-between; gap:12px; background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:12px 15px; box-shadow:var(--shadow); margin-bottom:14px; }
  .mtg-l { display:flex; align-items:center; gap:11px; min-width:0; }
  .mtg-ico { width:38px; height:38px; border-radius:10px; background:var(--accent-weak); display:grid; place-items:center; font-size:18px; flex:0 0 auto; }
  .mtg-t { font-weight:650; font-size:13.5px; }
  .mtg-s { font-size:12px; color:var(--muted); max-width:520px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .mtg-r { display:flex; gap:8px; align-items:center; flex:0 0 auto; }
  .su-datenav { display:flex; align-items:center; gap:10px; margin-bottom:13px; flex-wrap:wrap; }
  .su-arrow { width:32px; height:32px; border-radius:9px; border:1px solid var(--line); background:var(--surface); color:var(--txt2); cursor:pointer; font-size:17px; }
  .su-arrow:hover:not(:disabled){ background:var(--accent-weak); color:var(--accent); border-color:var(--accent-line); }
  .su-arrow:disabled { opacity:.4; cursor:default; }
  .su-date { font-size:14px; display:flex; align-items:center; gap:8px; }
  .su-today { font-size:10.5px; font-weight:700; color:var(--accent); background:var(--accent-weak); border:1px solid var(--accent-line); border-radius:999px; padding:2px 8px; }
  .su-add { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
  .su-in { margin:0; }
  .su-grow { flex:1; min-width:180px; }
  .su-overall { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:12px 15px; margin-bottom:14px; box-shadow:var(--shadow); }
  .su-overall-top { display:flex; justify-content:space-between; font-size:12.5px; font-weight:600; margin-bottom:8px; }
  .su-bar { height:9px; border-radius:6px; background:var(--line2); overflow:hidden; }
  .su-bar i { display:block; height:100%; background:linear-gradient(90deg,#7381e6,#21ba72); border-radius:6px; transition:width .5s; }
  .su-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:14px; }
  .su-member { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:14px; box-shadow:var(--shadow); }
  .su-mhead { display:flex; align-items:center; gap:9px; margin-bottom:9px; }
  .su-mname { font-weight:650; font-size:14px; flex:1; }
  .su-mstat { font-size:11.5px; font-weight:700; color:var(--txt2); }
  .su-mstat.full { color:var(--good); }
  .su-mbar { height:6px; border-radius:4px; background:var(--line2); overflow:hidden; margin-bottom:11px; }
  .su-mbar i { display:block; height:100%; background:linear-gradient(90deg,#7381e6,#21ba72); }
  .su-tasks { display:flex; flex-direction:column; gap:7px; }
  .su-task { display:flex; align-items:flex-start; gap:9px; }
  .su-check { position:relative; flex:0 0 auto; cursor:pointer; width:18px; height:18px; }
  .su-check input { position:absolute; opacity:0; width:18px; height:18px; margin:0; cursor:pointer; }
  .su-box { display:block; width:18px; height:18px; border:1.5px solid var(--line); border-radius:6px; transition:all .12s; }
  .su-check input:checked + .su-box { background:var(--good) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E") center/12px no-repeat; border-color:var(--good); }
  .su-body { flex:1; min-width:0; }
  .su-txt { font-size:13px; }
  .su-task.done .su-txt { color:var(--muted); }
  .su-dash { display:inline-block; font-size:11px; color:var(--accent); background:var(--accent-weak); border:1px solid var(--accent-line); border-radius:6px; padding:1px 7px; margin-top:3px; }
  .su-del { border:0; background:transparent; color:var(--muted); cursor:pointer; font-size:16px; line-height:1; padding:0 2px; }
  .su-del:hover { color:var(--danger); }
  .su-madd { display:flex; gap:7px; margin-top:11px; }
  .su-madd .su-grow { min-width:0; }
  .su-empty-m { font-size:12px; color:var(--muted); padding:5px 0 2px; }
  .su-bot { margin-top:16px; background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:2px 15px; }
  .su-bot summary { cursor:pointer; font-size:12.5px; font-weight:600; padding:11px 0; color:var(--txt2); }
  .su-bot-body { font-size:12px; color:var(--muted); padding-bottom:13px; line-height:1.6; }
  .su-bot pre { background:var(--surface2); border:1px solid var(--line); border-radius:8px; padding:11px; overflow-x:auto; font-size:11.5px; color:var(--txt); margin:8px 0; }
  .su-bot code { background:var(--surface2); border:1px solid var(--line); border-radius:4px; padding:1px 5px; font-size:11px; }
  /* Tabs */
  .tabs { display:flex; gap:4px; margin-top:14px; }
  .tab { font:inherit; font-size:13px; font-weight:600; color:var(--muted); background:none; border:0; border-bottom:2.5px solid transparent; padding:8px 14px; cursor:pointer; }
  .tab:hover { color:var(--txt); }
  .tab.on { color:var(--accent); border-bottom-color:var(--accent); }
  .tabview[hidden] { display:none; }
  /* ── App shell: fixed sidebar + workspace ─────────────────────────── */
  .app { display:grid; grid-template-columns:230px minmax(0,1fr); min-height:100vh; }
  .sidebar { background:var(--surface); border-right:1px solid var(--line); padding:16px 12px; display:flex; flex-direction:column; gap:4px; position:sticky; top:0; height:100vh; }
  .side-brand { display:flex; align-items:center; gap:10px; font-weight:700; font-size:15px; letter-spacing:-.01em; padding:6px 10px 16px; }
  .side-brand .logo { width:30px; height:30px; border-radius:9px; background:var(--grad); color:#fff; display:grid; place-items:center; font-size:15px; box-shadow:var(--shadow); }
  .side-nav { display:flex; flex-direction:column; gap:2px; }
  .side-item { display:flex; align-items:center; gap:11px; font:inherit; font-size:13.5px; font-weight:500; color:var(--txt2); background:none; border:0; border-radius:9px; padding:9px 11px; cursor:pointer; text-align:left; width:100%; transition:background .12s,color .12s; }
  .side-item:hover { background:var(--accent-weak); color:var(--txt); }
  .side-item.on { background:var(--accent-weak); color:var(--accent); font-weight:600; }
  .side-item .ico { width:18px; height:18px; flex:0 0 auto; opacity:.9; }
  .side-foot { margin-top:auto; padding-top:12px; display:flex; }
  .workspace { min-width:0; display:flex; flex-direction:column; }
  .topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; padding:15px 30px; background:color-mix(in srgb, var(--surface) 85%, transparent); backdrop-filter:saturate(1.2) blur(8px); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:6; }
  .tb-title h1 { font-size:17px; font-weight:650; margin:0; letter-spacing:-.01em; }
  .tb-title .sub { font-size:12px; color:var(--muted); margin-top:2px; }
  .tb-actions { display:flex; gap:9px; align-items:center; flex-wrap:wrap; }
  .content { min-width:0; }
  @media (max-width:860px){ .app { grid-template-columns:1fr; } .sidebar { position:static; height:auto; flex-direction:row; align-items:center; flex-wrap:wrap; gap:6px; } .side-brand { padding:6px 10px; } .side-nav { flex-direction:row; flex-wrap:wrap; } .side-item span { display:none; } .side-foot { margin:0; } }
  .tabhead { padding:18px 28px 4px; }
  .tabhead h2 { margin:0; font-size:20px; font-weight:720; }
  .tabhead .sub { color:var(--muted); font-size:12.5px; margin-top:2px; }
  /* Profile / client cards */
  .profile-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:14px; padding:8px 28px 64px; }
  .profile-card { position:relative; background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:15px 16px; box-shadow:var(--shadow); cursor:pointer; transition:transform .14s,box-shadow .14s,border-color .14s; }
  .profile-card:hover { transform:translateY(-3px); box-shadow:var(--shadow-md); border-color:var(--accent); }
  .profile-card .pc-head { display:flex; align-items:center; gap:11px; padding-right:24px; }
  .profile-card .pc-head > div { min-width:0; flex:1; }
  .profile-card .pc-name { font-weight:680; font-size:15px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .profile-card .pc-role { font-size:12px; color:var(--muted); margin-top:1px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .profile-card .pc-stats { display:flex; flex-wrap:wrap; gap:10px; margin-top:11px; font-size:12px; color:var(--muted); }
  .profile-card .pc-stats b { color:var(--txt); }
  .profile-card .rm { position:absolute; top:10px; right:10px; }
  .warnpill { color:#b45309; background:#fef3c7; border-radius:999px; padding:1px 8px; font-weight:600; }
  [data-theme="dark"] .warnpill { color:#fcd34d; background:#2a2410; }
  .clogo { width:44px; height:44px; border-radius:11px; object-fit:contain; background:#fff; border:1px solid var(--line); flex:none; }
  .clogo.lg { width:48px; height:48px; }
  /* Sub-tabs in profile drawer */
  .subtabs { display:flex; gap:4px; padding:10px 22px 0; background:var(--surface); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:2; }
  .subtab { font:inherit; font-size:12.5px; font-weight:600; color:var(--muted); background:none; border:0; border-bottom:2.5px solid transparent; padding:8px 10px; cursor:pointer; }
  .subtab.on { color:var(--accent); border-bottom-color:var(--accent); }
  /* Profile fields */
  .pf-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin:4px 0 12px; }
  .pf { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--muted); }
  .pf.wide { grid-column:1 / -1; }
  .pf input { font:inherit; font-size:13px; }
  .pf-actions { display:flex; gap:8px; }
  /* Detail modal */
  .modal-detail { width:min(760px,96vw); max-height:92vh; }
  .dh { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; padding:18px 22px; border-bottom:1px solid var(--line); border-top:4px solid var(--cardc,var(--accent)); border-radius:14px 14px 0 0; }
  .dh-title { font-size:19px; font-weight:740; letter-spacing:-.01em; }
  .dh-sub { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:8px; }
  .dh-actions { display:flex; gap:7px; align-items:center; flex:none; }
  .dbody { max-height:calc(92vh - 90px); overflow-y:auto; }
  .dprog { margin-bottom:16px; }
  .dprog .prog-track { gap:3px; } .dprog .seg { height:10px; border-radius:3px; background:var(--line2); flex:1; }
  .dgrid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:6px; }
  @media (max-width:560px){ .dgrid { grid-template-columns:repeat(2,1fr); } }
  .fact { background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:9px 11px; }
  .fact .fl { font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); font-weight:700; }
  .fact .fv { font-size:13.5px; font-weight:600; margin-top:3px; }
  .dsec { margin-top:16px; }
  .dsec h4 { margin:0 0 7px; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:700; }
  /* The assignee brief is the headline instruction — give it an accent heading. */
  .dsec.brief-sec h4 { color:var(--accent); }
  .dsec.brief-sec .dlinks { margin-top:8px; }
  .dnote { font-size:13.5px; color:var(--txt2); white-space:pre-wrap; }
  .dnote.big { font-size:14.5px; color:var(--txt); background:var(--accent-weak); border:1px solid var(--accent-line); border-radius:10px; padding:11px 13px; }
  .dnote.muted { color:var(--muted); }
  .dlinks { display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; margin-top:4px; }
  .thumbs { display:flex; flex-wrap:wrap; gap:8px; margin-top:6px; }
  .thumb img { width:84px; height:84px; object-fit:cover; border-radius:9px; border:1px solid var(--line); }
  /* Feedback view (detail) */
  .fbv { border:1px solid var(--line); border-radius:11px; padding:11px 13px; margin-bottom:9px; background:var(--surface2); }
  .fbv-top { display:flex; align-items:center; gap:8px; margin-bottom:5px; }
  .fbv-top b { font-size:13.5px; }
  .fbcat { font-size:9px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; color:var(--accent); background:var(--accent-weak); border-radius:5px; padding:2px 7px; }
  .impl { font:inherit; font-size:11px; font-weight:700; border-radius:999px; padding:3px 10px; border:1px solid transparent; cursor:pointer; margin-left:auto; }
  .impl.yes { color:#15803d; background:#dcfce7; border-color:#86efac; }
  .impl.no { color:#b42318; background:#fef3f2; border-color:#fda29b; }
  [data-theme="dark"] .impl.yes { color:#7ef0ac; background:#0f2c1e; border-color:#1f6e46; }
  [data-theme="dark"] .impl.no { color:#fcafa5; background:#2f1518; border-color:#7c2b30; }
  .impl[disabled] { cursor:default; opacity:.85; }
  /* To-do rows */
  .todo { display:flex; gap:10px; align-items:flex-start; padding:10px 0; border-bottom:1px solid var(--line2); }
  .todo .impl { margin:0; flex:none; width:30px; text-align:center; }
  .todo-main { flex:1; }
  .todo-top { font-size:13px; }
  /* Personal task lists */
  .tasks-container { padding:10px 0; }
  .task-add-row { display:flex; gap:8px; margin-bottom:16px; }
  .task-add-row input { flex:1; }
  .task-list { display:flex; flex-direction:column; gap:8px; }
  .task-row { display:flex; align-items:flex-start; gap:10px; padding:10px 12px; background:var(--surface); border:1px solid var(--line); border-radius:9px; }
  .task-row:hover { background:var(--line2); }
  .task-check { width:20px; height:20px; border:2px solid var(--line); border-radius:5px; flex:none; margin-top:2px; cursor:pointer; display:grid; place-items:center; font-size:12px; color:#fff; transition:all .15s; background:none; padding:0; }
  .task-check:hover { border-color:var(--accent); }
  .task-check.done { background:var(--good); border-color:var(--good); }
  .task-text { flex:1; font-size:13px; line-height:1.5; word-break:break-word; }
  .task-del { border:0; background:none; color:var(--muted); cursor:pointer; font-size:16px; padding:0; width:20px; height:20px; flex:none; }
  .task-del:hover { color:var(--danger); }
  .empty-tasks { padding:16px; text-align:center; color:var(--muted); font-size:13px; }
  /* Feedback editor rows (form) */
  .fb-row { border:1px solid var(--line); border-radius:11px; padding:10px; margin-bottom:9px; background:var(--surface2); }
  .fb-top { display:flex; gap:8px; align-items:center; margin-bottom:7px; flex-wrap:wrap; }
  .fb-top .fb-cat { flex:0 0 30%; min-width:110px; }
  .fb-top .fb-label { flex:1; min-width:120px; }
  .fb-top .fb-date { width:138px; }
  .fb-bot { display:flex; gap:8px; margin-top:7px; }
  .fb-bot .fb-link { flex:1; }
  .fb-row textarea { width:100%; }
  .ssrow { display:flex; align-items:center; gap:8px; margin:5px 0; }
  .ssrow .fchip { flex:0 0 auto; max-width:30%; overflow:hidden; }
  .ssrow .ss-inputs { flex:1; display:flex; gap:6px; min-width:0; }
  .ssrow .sshdr { flex:0 0 38%; min-width:0; font-size:12px; font-weight:600; }
  .ssrow .sscap { flex:1; min-width:0; font-size:12px; }
  .fb-pp { display:inline-flex; align-items:center; gap:5px; font-size:12px; color:var(--muted); white-space:nowrap; }
  .fb-pp select { font:inherit; font-size:12px; padding:3px 6px; border:1px solid var(--line); border-radius:7px; background:var(--surface); color:var(--txt); }
  /* Toggle switch */
  .toggle { display:inline-flex; align-items:center; gap:6px; cursor:pointer; font-size:11.5px; color:var(--muted); }
  .toggle input { display:none; }
  .toggle .track { width:34px; height:19px; border-radius:999px; background:var(--line); position:relative; transition:background .15s; flex:none; }
  .toggle .track::after { content:""; position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%; background:#fff; transition:transform .15s; box-shadow:0 1px 2px rgba(0,0,0,.3); }
  .toggle input:checked + .track { background:#22c55e; }
  .toggle input:checked + .track::after { transform:translateX(15px); }
  /* File chips + thumbnails */
  .filebox { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0; }
  .fchip { display:inline-flex; align-items:center; gap:5px; font-size:11.5px; background:var(--line2); border:1px solid var(--line); border-radius:8px; padding:3px 8px; }
  .fchip .fx { border:0; background:none; color:var(--muted); cursor:pointer; font-size:13px; padding:0 0 0 2px; }
  .fchip .fx:hover { color:var(--danger); }
  .card.clickable { cursor:pointer; }
  /* ── Sections / subsections editor (admin-page structure, up to 4 levels) ── */
  .sec-editor { background:var(--surface2); border:1px solid var(--line); border-radius:12px; padding:12px; display:flex; flex-direction:column; gap:10px; }
  .sec-empty { font-size:12.5px; color:var(--muted); text-align:center; padding:6px 0 2px; }
  .sec-node { display:flex; flex-direction:column; gap:8px; }
  .sec-node.depth-1 { background:var(--surface); border:1px solid var(--line); border-radius:11px; padding:11px 12px; box-shadow:var(--shadow); }
  .sec-children { display:flex; flex-direction:column; gap:8px; padding-left:16px; border-left:2px solid var(--line2); margin-left:4px; }
  .sec-node.depth-1 > .sec-children { border-left-color:var(--accent-line); }
  .sec-row { display:flex; align-items:center; gap:9px; }
  .sec-pill { flex:0 0 auto; font-size:11.5px; font-weight:700; color:var(--accent); background:var(--accent-weak); border:1px solid var(--accent-line); border-radius:7px; padding:5px 10px; white-space:nowrap; }
  .modal-form .form-grid .sec-name { flex:1; min-width:0; width:auto; }
  .sec-x { flex:0 0 auto; width:38px; align-self:stretch; border:1px solid var(--danger-line); background:var(--danger-bg); color:var(--danger); border-radius:8px; cursor:pointer; font-size:15px; line-height:1; }
  .sec-x:hover { background:var(--danger); color:#fff; border-color:var(--danger); }
  .sec-add { align-self:flex-start; font:inherit; font-size:12.5px; font-weight:700; cursor:pointer; border-radius:9px; padding:7px 13px; transition:background .12s,border-color .12s,color .12s; }
  .sec-add.sub { color:var(--accent); background:transparent; border:1.5px dashed var(--accent-line); }
  .sec-add.sub:hover { background:var(--accent-weak); border-color:var(--accent); }
  .sec-add.section { color:var(--accent); background:var(--surface); border:1.5px solid var(--accent-line); }
  .sec-add.section:hover { background:var(--accent-weak); border-color:var(--accent); }
  /* Publish button (card + detail modal) */
  .pub-btn { font:inherit; font-size:11.5px; font-weight:650; color:#fff; background:var(--grad); border:0; border-radius:999px; padding:5px 12px; cursor:pointer; white-space:nowrap; box-shadow:0 2px 8px rgba(79,70,229,.28); display:inline-flex; align-items:center; gap:4px; }
  .pub-btn:hover { filter:brightness(1.05); }
  .pub-btn[disabled] { opacity:.6; cursor:default; box-shadow:none; }
  .pub-btn.done { background:var(--good-bg); color:var(--good); border:1px solid var(--good-line); box-shadow:none; }
  .pub-btn.done:hover { filter:none; background:var(--good); color:#fff; }
  /* Read-only sections tree (detail modal) */
  .secview { list-style:none; margin:0; padding:0; }
  .secview .secview { margin:4px 0 0 14px; padding-left:11px; border-left:2px solid var(--line2); }
  .secview li { font-size:13.5px; color:var(--txt2); padding:3px 0; }
  .secview-num { display:inline-block; min-width:36px; font-weight:700; color:var(--accent); font-variant-numeric:tabular-nums; }
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="side-brand"><div class="logo">◆</div><span>Tracker</span></div>
    <nav class="side-nav" id="tabs">
      <button class="side-item on" data-tab="overview"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg><span>Overview</span></button>
      <button class="side-item" data-tab="mywork"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg><span>My Work</span></button>
      <button class="side-item" data-tab="team"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg><span>Team</span></button>
      <button class="side-item" data-tab="clients"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M9 6h.01M15 6h.01M9 10h.01M15 10h.01M9 14h.01M15 14h.01"/></svg><span>Clients</span></button>
      <button class="side-item" data-tab="assign"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M6 8l-3 6a3 3 0 0 0 6 0zM18 8l-3 6a3 3 0 0 0 6 0zM7 8h10"/></svg><span>Assign</span></button>
      <button class="side-item" data-tab="unassigned"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" y1="8" x2="22" y2="13"/><line x1="22" y1="8" x2="17" y2="13"/></svg><span>Unassigned</span></button>
      <button class="side-item" data-tab="standup"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6M12 8a4 4 0 0 0-4 4v2a4 4 0 0 0 8 0v-2a4 4 0 0 0-4-4z"/><path d="M5 12a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/></svg><span>Standup</span></button>
      <button class="side-item" data-tab="tutorial"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg><span>Tutorial</span></button>
    </nav>
    <div class="side-foot"><button class="theme-toggle" id="themeToggle" title="Toggle light / dark">🌙</button></div>
  </aside>
  <main class="workspace">
    <div class="topbar">
      <div class="tb-title"><h1>Dashboard Tracker</h1><div class="sub">${data.total} dashboard${data.total===1?'':'s'} · updated ${escapeHtml(fresh)}</div></div>
      <div class="tb-actions">
        <button class="btn ghost prio-btn" id="prioToggle" title="Show only priority dashboards">⭐ Priority</button>
        <div class="dropdown">
          <button class="btn ghost" id="exportToggle">⬇ Export ▾</button>
          <div class="menu" id="exportMenu">
            <button data-export="all">All — full workbook (cover + per-client + per-owner sheets)</button>
            <button data-export="client">Client-wise — one sheet per client</button>
            <button data-export="owner">Owner-wise — one sheet per owner</button>
          </div>
        </div>
        ${opts.manualEnabled ? `<button class="btn" id="addToggle">+ Add dashboard</button>` : ''}
      </div>
    </div>
    <div class="content">

<section class="tabview" id="tab-overview">
<div class="legend" id="legend"></div>

${opts.manualEnabled ? `
<div class="modal-bg" id="formModalBg"><div class="modal modal-form" id="formModal">
  <div class="modal-head"><div><h3 id="panelTitle">Add dashboard</h3></div><button class="x" id="formX">×</button></div>
  <div class="modal-body">
    <input type="hidden" id="f_id">
    <div class="form-grid">
      <label class="wide">Dashboard name *<input id="f_name" placeholder="e.g. Revenue Tracker"></label>
      <label class="wide">Clients
        <div class="dd" id="clientDD">
          <div class="ms-control" id="clientCtl">
            <span id="clientChips"></span>
            <input class="ms-search" id="clientSearch" placeholder="Search clients…" autocomplete="off">
            <svg class="ms-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div class="dd-menu" id="clientMenu"></div>
        </div>
      </label>
      <label>Assigned to
        <div class="dd" id="ownerDD">
          <input class="combo-input" id="f_owner" placeholder="e.g. Vipul" autocomplete="off">
          <svg class="ms-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          <div class="dd-menu" id="ownerMenu"></div>
        </div>
        <label class="mini-check"><input type="checkbox" id="f_unassigned"> Leave unassigned (no owner)</label>
      </label>
      <label>Stage<select id="f_stage">${STATES.map((s,i)=>`<option value="${s.id}">${i+1}. ${escapeHtml(s.label)}</option>`).join('')}</select></label>
      <label>Live on Munshot?<select id="f_live"><option value="Not Live">Not live</option><option value="Live on Munshot">Live on Munshot</option></select></label>
      <label>Priority<select id="f_prio"><option value="0">None</option><option value="1">1st priority</option><option value="2">2nd priority</option><option value="3">3rd priority</option><option value="4">4th priority</option><option value="5">5th priority</option></select></label>
      <label class="wide">Dashboard link<input id="f_url" placeholder="https://app.munshot.com/…" autocomplete="off"></label>
      <div class="field wide">Brief for the assignee <span style="color:var(--muted);font-weight:400;font-size:11px">(what needs to be done — the teammate sees this)</span>
        <textarea id="f_brief" rows="4" placeholder="Explain the task: the goal, the data to use, what to build, and any gotchas…"></textarea>
        <div class="filebox" id="briefFiles"></div>
        <div class="brief-links" id="briefLinkRows"></div>
        <div class="brief-tools">
          <button class="btn ghost sm" id="briefUpload" type="button">📎 Attach images / files</button>
          <button class="btn ghost sm" id="addBriefLink" type="button">+ reference link</button>
        </div>
      </div>
      <label class="wide">YouTube Links
        <div id="linkRows"></div>
        <button class="btn ghost sm" id="addLinkRow" type="button">+ another link</button>
      </label>
      <div class="field wide" id="dueField">Due date
        <div class="datepick" id="dueDD">
          <div class="date-wrap">
            <div class="date-trigger" id="dueTrigger" role="button" tabindex="0">
              <svg class="df-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              <span id="dueLabel" class="date-lbl muted">Select a date</span>
              <span class="date-clear" id="dueClear" role="button" tabindex="-1" title="Clear date" hidden>×</span>
              <svg class="ms-caret" style="position:static" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
            <input type="hidden" id="f_due">
            <div class="dd-menu cal-menu" id="dueCal"></div>
          </div>
        </div>
      </div>
      <label class="wide" id="fbLabel" hidden>Feedbacks
        <div id="fbRows"></div>
        <button class="btn ghost sm" id="addFb" type="button" title="Add feedback">+ Feedback</button>
      </label>
      <div class="field wide">Sections <span style="color:var(--muted);font-weight:400;font-size:11px">(up to 4 levels — publishes to the admin page)</span>
        <div class="sec-editor" id="sectionRows"></div>
      </div>
      <input type="hidden" id="f_meeting">
    </div>
    <div class="panel-actions">
      <button class="btn" id="saveBtn">Save dashboard</button>
      <button class="btn ghost" id="cancelBtn">Cancel</button>
      <span class="msg" id="formMsg"></span>
    </div>
  </div>
</div></div>
` : ''}


<div class="controls">
  <input type="search" id="q" placeholder="Search name, status, requirements…">
  <select id="customer"><option value="">All customers</option>${data.customers.map((c) => `<option>${escapeHtml(c)}</option>`).join('')}</select>
  <select id="owner"><option value="">All owners</option>${data.owners.map((o) => `<option>${escapeHtml(o)}</option>`).join('')}</select>
  <select id="groupby">
    <option value="">No grouping</option>
    <option value="state">Group by state</option>
    <option value="customer">Group by customer</option>
    <option value="owner">Group by owner</option>
  </select>
  <label style="font-size:12.5px;color:var(--muted);display:flex;align-items:center;gap:5px"><input type="checkbox" id="liveonly"> Live only</label>
  <div class="view-seg" id="viewSeg"><button class="vseg" data-dview="table">▤ Table</button><button class="vseg" data-dview="cards">▦ Cards</button></div>
</div>
<div class="grid" id="grid"></div>
</section>

<section class="tabview" id="tab-team" hidden></section>
<section class="tabview" id="tab-clients" hidden></section>
<section class="tabview" id="tab-assign" hidden></section>
<section class="tabview" id="tab-unassigned" hidden></section>
<section class="tabview" id="tab-mywork" hidden></section>
<section class="tabview" id="tab-standup" hidden></section>
<section class="tabview" id="tab-tutorial" hidden></section>

</div></main></div>
<div class="overlay" id="overlay"><div class="drawer" id="drawer"></div></div>
<div class="modal-bg" id="updModalBg"><div class="modal" id="updModal"></div></div>
<div class="modal-bg" id="tutModalBg"><div class="modal" id="tutModal"></div></div>
<div class="modal-bg" id="detailBg"><div class="modal modal-detail" id="detailModal"></div></div>
<input type="file" id="filePick" hidden>

<script>
const DATA = ${payload};
const STATES = ${statesJson};
const CFG = ${cfg};
const SMAP = Object.fromEntries(STATES.map(s => [s.id, s]));
let stateFilter = new Set();   // active stage filter — empty = show all
let prioOnly = false;          // show only priority dashboards
function isolateState(id){
  if (stateFilter.size === 1 && stateFilter.has(id)) stateFilter.clear();
  else stateFilter = new Set([id]);
  prioOnly = false;
  render();
}
function liveOnlyEl(){ return document.getElementById('liveonly'); }

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ── Theme (light / dark) ───────────────────────────────────────────────────
function applyTheme(t){
  document.documentElement.setAttribute('data-theme', t);
  const b = document.getElementById('themeToggle');
  if (b) b.textContent = t === 'dark' ? '☀️' : '🌙';
}
(function initTheme(){
  const saved = localStorage.getItem('theme');
  const t = saved || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(t);
})();

// ── Avatars & deterministic colours ────────────────────────────────────────
const AV_COLORS = ['#6366f1','#8b5cf6','#ec4899','#f43f5e','#f97316','#f59e0b','#10b981','#14b8a6','#06b6d4','#3b82f6','#a855f7','#ef4444','#22c55e','#0ea5e9'];
function hashIndex(str, n){ let h = 0; for (let i=0;i<str.length;i++){ h = (h*31 + str.charCodeAt(i)) >>> 0; } return h % n; }
function nameColor(name){ return AV_COLORS[hashIndex(String(name||'?'), AV_COLORS.length)]; }
function initials(name){
  const parts = String(name||'?').trim().split(/\\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length>1 ? parts[parts.length-1][0] : '')).toUpperCase();
}
function avatar(name, cls){ return \`<span class="avatar \${cls||''}" style="background:\${nameColor(name)}">\${esc(initials(name))}</span>\`; }
function ownerTag(name){ return name ? \`<span class="av-tag owner-link" data-owner="\${esc(name)}" title="View \${esc(name)}'s profile">\${avatar(name)}\${esc(name)}</span>\` : ''; }
function clientTag(name){
  const c = nameColor('c·'+name);
  return \`<span class="ctag owner-link" data-customer="\${esc(name)}" title="View \${esc(name)}" style="background:color-mix(in srgb, \${c} 16%, transparent); color:\${c}">\${esc(name)}</span>\`;
}

function renderLegend(){
  const el = document.getElementById('legend');
  const active = stateFilter.size > 0;
  el.innerHTML = STATES.map((s,i) =>
    \`<span class="pill \${stateFilter.has(s.id)?'on':(active?'off':'')}" data-id="\${s.id}"><span class="dot" style="background:\${s.color}"></span><span class="stage-no">\${i+1}</span> \${s.label} <span class="n">\${DATA.counts[s.id]||0}</span></span>\`
  ).join('');
  el.querySelectorAll('.pill').forEach(p => p.onclick = () => isolateState(p.dataset.id));
}

// Stage progress bar. Segments are clickable (for editable cards) to set the
// stage directly — the quick way to "bring a dashboard to its current level".
function progressBar(d){
  const cur = STATES.findIndex(x => x.id === d.state);
  const pct = Math.round((cur<=0?0:cur/(STATES.length-1))*100);
  const setty = d.source==='manual' && CFG.manualEnabled;
  const segs = STATES.map((x,i) => \`<i class="seg \${i<=cur?'on':''} \${setty?'set':''}" style="\${i<=cur?'background:'+SMAP[d.state].color:''}" \${setty?\`data-setstage="\${esc(d.id)}" data-stage="\${x.id}"\`:''} title="\${i+1}. \${x.label}"></i>\`).join('');
  return \`<div class="prog">
    <div class="prog-top"><span class="prog-stage" style="color:\${SMAP[d.state].color}">Stage \${cur+1}/\${STATES.length} · \${SMAP[d.state].label}</span><span class="prog-pct">\${pct}%</span></div>
    <div class="prog-track">\${segs}</div>
  </div>\`;
}
// Publish button (goes live on the Munshot admin page). Shows a "Published" state
// once pushed; clicking again re-publishes the latest version.
function publishBtnHtml(d){
  const done = !!d.publishedAt, when = done ? String(d.publishedAt).slice(0,10) : '';
  return \`<button class="pub-btn \${done?'done':''}" data-publish="\${esc(d.id)}" data-name="\${esc(d.name)}" onclick="event.stopPropagation()" title="\${done?'Published '+esc(when)+' — click to re-publish':'Publish to the admin page'}">\${done?'✓ Published':'⬆ Publish'}</button>\`;
}
async function publishDash(id, btn){
  const d = DATA.dashboards.find(x => x.id === id); if (!d) return;
  const again = !!d.publishedAt;
  if (!confirm('Publish "'+d.name+'" to the admin page now?'+(again?'\\n\\nAlready published — this pushes the latest version again.':''))) return;
  const old = btn ? btn.innerHTML : '';
  if (btn){ btn.disabled = true; btn.textContent = 'Publishing…'; }
  const res = await api('POST', '/api/publish', { id });
  const j = await res.json().catch(() => ({}));
  if (res.ok){
    d.publishedAt = j.publishedAt || new Date().toISOString(); if (j.ref) d.publishRef = j.ref;
    render();
    const dbg = G('detailBg'); if (dbg && dbg.classList.contains('open')) openDetail(id);
  } else {
    alert('Publish failed: ' + (j.error || j.response || ('HTTP '+res.status)));
    if (btn){ btn.disabled = false; btn.innerHTML = old; }
  }
}
function card(d, n){
  const s = SMAP[d.state];
  const fields = [['Requirements',d.requirements],['Improvements',d.improvement],['Feedback',d.feedback]].filter(([,v]) => v && v !== '-');
  const links = (d.links && d.links.length) ? d.links : (d.meetingUrl ? [{label:'Recording / link', url:d.meetingUrl}] : []);
  const title = (n ? '#'+n+' · ' : '') + esc(d.name);
  const editable = d.source==='manual' && CFG.manualEnabled;
  const showManualTag = d.source==='manual' && !CFG.standalone;
  const prioBadge = d.priorityLevel ? \`<span class="pbadge" title="Priority \${d.priorityLevel}">★ P\${d.priorityLevel}</span>\` : '';
  const star = CFG.manualEnabled
    ? \`<button class="star \${d.priorityLevel?'on':''}" title="\${d.priorityLevel?'Priority '+d.priorityLevel+' — click to clear':'Mark priority 1'}" data-prio="\${esc(d.id)}">\${d.priorityLevel?'★':'☆'}</button>\`
    : '';
  const cardBtns = (star || editable) ? \`<div class="cardbtns">\${star}\${editable?\`<button class="edit" title="Edit" data-edit="\${esc(d.id)}">✎</button><button class="del" title="Delete" data-del="\${esc(d.id)}">×</button>\`:''}</div>\` : '';
  return \`<div class="card clickable \${showManualTag?'manual':''} \${d.priorityLevel?'prio':''} \${!d.owner?'unassigned':''}" data-card="\${esc(d.id)}" style="--cardc:\${s.color}">
    \${cardBtns}
    <h3>\${prioBadge}\${title}</h3>
    \${progressBar(d)}
    <div class="meta">
      \${d.isLive ? '<span class="tag live">● Live on Munshot</span>' : ''}
      \${d.customers.map(c => clientTag(c)).join('')}
      \${d.owner ? ownerTag(d.owner) : '<span class="tag unassigned-tag">Unassigned</span>'}
      \${showManualTag ? '<span class="tag src">Manual</span>' : ''}
    </div>
    \${d.status && d.status!=='-' ? \`<div class="status"><span class="label">Current status</span><br>\${esc(d.status)}</div>\` : ''}
    \${fields.map(([k,v]) => \`<div class="field"><span class="label">\${k}</span><div class="val">\${esc(v)}</div></div>\`).join('')}
    \${links.length ? \`<div class="links"><span class="label">YouTube Links</span>\${links.map(l => \`<a href="\${esc(l.url)}" target="_blank" rel="noopener" class="lnk">▶ \${esc(l.label)}</a>\`).join('')}</div>\` : ''}
    \${d.updates && d.updates.length ? \`<div class="upd"><span class="label">Latest work update · \${esc(d.updates[d.updates.length-1].date||'')}</span><div class="val">\${esc(d.updates[d.updates.length-1].note || SMAP[d.updates[d.updates.length-1].state]?.label || '')}</div>\${d.updates[d.updates.length-1].files&&d.updates[d.updates.length-1].files.length?\`<div class="thumbs">\${fileGrid(d.updates[d.updates.length-1].files)}</div>\`:''}</div>\` : ''}
    <div class="foot">
      <span>\${d.lastUpdated ? 'Updated '+esc(d.lastUpdated) : ''}</span>
      <div class="foot-actions">
        \${d.dashboardUrl ? \`<a class="visit-btn" href="\${esc(d.dashboardUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="Open on Munshot">↗ Visit</a>\` : ''}
        \${(editable && d.owner) ? publishBtnHtml(d) : ''}
        \${CFG.manualEnabled ? \`<button class="upd-btn" data-update="\${esc(d.id)}" data-name="\${esc(d.name)}">＋ Work update\${d.updates&&d.updates.length?' ('+d.updates.length+')':''}</button>\` : ''}
      </div>
    </div>
  </div>\`;
}

// ── KPI hero ───────────────────────────────────────────────────────────────
const KPI_ICONS = { not_started:'⏳', ui_ux:'🎨', data_integration:'🔌', final_check:'🔎', feedback_open:'💬', feedback_incorp:'🔧', completed:'✅' };
let kpiAnimated = false;
function animateCounts(el){
  el.querySelectorAll('[data-count]').forEach(n => {
    const target = +n.dataset.count;
    if (kpiAnimated){ n.textContent = target; return; }
    const dur = 700, t0 = performance.now();
    (function step(t){ const p = Math.min(1,(t-t0)/dur); n.textContent = Math.round(target*(1-Math.pow(1-p,3))); if (p<1) requestAnimationFrame(step); })(t0);
  });
  kpiAnimated = true;
}
function clearAllFilters(){
  stateFilter.clear(); prioOnly = false;
  ['q','customer','owner'].forEach(id => document.getElementById(id).value = '');
  liveOnlyEl().checked = false;
}

let dashView = (localStorage.getItem('dashView') === 'cards') ? 'cards' : 'table';
let unView = (localStorage.getItem('unView') === 'table') ? 'table' : 'cards';
// Format a stored due date (ISO "YYYY-MM-DD" → "29 Jun 2026"; other formats shown as-is).
function fmtDueCell(v){ return v ? (/^\\d{4}-\\d{2}-\\d{2}$/.test(v) ? esc(fmtDue(v)) : esc(v)) : '<span class="tmut">—</span>'; }
// One row of the dashboards table (mirrors card() but tabular).
function rowHtml(d, n){
  const s = SMAP[d.state] || { color:'var(--muted)', label:d.state };
  const pct = Math.round((d.progress||0)*100);
  const editable = d.source==='manual' && CFG.manualEnabled;
  const links = (d.links && d.links.length) ? d.links : (d.meetingUrl ? [{label:'Recording / link', url:d.meetingUrl}] : []);
  const meet = links[0];
  const clients = d.customers.length ? d.customers.map(c=>\`<span class="tchip" data-customer="\${esc(c)}">\${esc(c)}</span>\`).join('') : '<span class="tmut">—</span>';
  const dash = d.dashboardUrl ? \`<a class="tlink" href="\${esc(d.dashboardUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="Open on Munshot">↗ Visit</a>\` : '<span class="tmut">—</span>';
  const meetCell = meet ? \`<a class="tlink" href="\${esc(meet.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="\${esc(meet.label||'Open link')}">▶ \${esc(meet.label||'Link')}</a>\` : '<span class="tmut">—</span>';
  const upd = CFG.manualEnabled ? \`<button class="tbtn" data-update="\${esc(d.id)}" data-name="\${esc(d.name)}" title="Add work update">＋</button>\` : '';
  const pub = (editable && d.owner) ? \`<button class="tbtn \${d.publishedAt?'pubdone':''}" data-publish="\${esc(d.id)}" data-name="\${esc(d.name)}" title="\${d.publishedAt?'Published — click to re-publish':'Publish to the admin page'}">⬆</button>\` : '';
  const editDel = editable ? \`<button class="tbtn" data-edit="\${esc(d.id)}" title="Edit">✎</button><button class="tbtn del" data-del="\${esc(d.id)}" title="Delete">×</button>\` : '';
  return \`<tr class="drow \${!d.owner?'unassigned':''}" data-card="\${esc(d.id)}">
    <td class="tnum">\${n}</td>
    <td class="tname"><span class="tname-in">\${d.priorityLevel?'★ ':''}\${esc(d.name)}\${d.isLive?'<span class="tlive">● Live</span>':''}</span></td>
    <td><div class="tchips">\${clients}</div></td>
    <td>\${d.owner?\`<span class="tchip" data-owner="\${esc(d.owner)}">\${esc(d.owner)}</span>\`:'<span class="tag unassigned-tag">Unassigned</span>'}</td>
    <td class="tmut">\${fmtDueCell(d.dueDate)}</td>
    <td class="tstage"><span class="tstage-lbl"><span class="tdot" style="background:\${s.color}"></span>\${esc(s.label)}</span><div class="ttrack"><i style="width:\${pct}%;background:\${s.color}"></i></div></td>
    <td>\${dash}</td>
    <td>\${meetCell}</td>
    <td class="tacts">\${pub}\${upd}\${editDel}</td>
  </tr>\`;
}
function dashTable(bodyRows){
  return \`<div class="table-wrap"><table class="dtable">
    <colgroup><col style="width:44px"><col style="width:210px"><col style="width:150px"><col style="width:128px"><col style="width:104px"><col style="width:188px"><col style="width:98px"><col style="width:150px"><col style="width:104px"></colgroup>
    <thead><tr><th>#</th><th>Name</th><th>Client</th><th>Assigned to</th><th>Due date</th><th>Stage</th><th>Dashboard</th><th>Meeting</th><th></th></tr></thead><tbody>\${bodyRows}</tbody></table></div>\`;
}
function render(){
  renderLegend();
  { const b = document.getElementById('prioToggle'); if (b) b.classList.toggle('on', prioOnly); }
  const q = document.getElementById('q').value.trim().toLowerCase();
  const cust = document.getElementById('customer').value;
  const own = document.getElementById('owner').value;
  const groupby = document.getElementById('groupby').value;
  const liveonly = document.getElementById('liveonly').checked;

  let list = DATA.dashboards.filter(d => {
    if (stateFilter.size && !stateFilter.has(d.state)) return false;
    if (prioOnly && !d.priority) return false;
    if (cust && !d.customers.includes(cust)) return false;
    if (own && d.owner !== own) return false;
    if (liveonly && !d.isLive) return false;
    if (q){
      const hay = (d.name+' '+d.status+' '+d.requirements+' '+d.improvement+' '+d.feedback+' '+d.customer+' '+d.owner).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  // Priority dashboards float to the top, ordered by level (P1, P2, …).
  list = list.slice().sort((a,b) => {
    const ap = a.priorityLevel||Infinity, bp = b.priorityLevel||Infinity;
    return ap - bp;
  });

  const grid = document.getElementById('grid');
  if (!list.length){
    grid.classList.remove('table-mode');
    const noneAtAll = !DATA.dashboards.length;
    grid.innerHTML = noneAtAll
      ? '<div class="empty">No dashboards yet.' + (CFG.manualEnabled ? ' Click <b>+ Add dashboard</b> to create your first one.' : '') + '</div>'
      : '<div class="empty">No dashboards match these filters.</div>';
    bindCards(); return;
  }

  // Grouping (used by both card and table views). Numbering is positional
  // within the CURRENT view (1..n), not the dashboard's own id.
  let groups = null;
  if (groupby === 'state'){
    groups = STATES.map(s => [s.label, list.filter(d => d.state === s.id)]).filter(([,a]) => a.length);
  } else if (groupby === 'customer'){
    const keys = [...new Set(list.flatMap(d => d.customers))].sort();
    groups = keys.map(k => [k, list.filter(d => d.customers.includes(k))]); // a 2-client dash appears under both
  } else if (groupby === 'owner'){
    const keys = [...new Set(list.map(d => d.owner))].sort();
    groups = keys.map(k => [k || 'No owner', list.filter(d => d.owner === k)]);
  }

  if (dashView === 'table'){
    grid.classList.add('table-mode');
    const body = groups
      ? groups.map(([t,items]) => \`<tr class="grp"><td colspan="9">\${esc(t)} · \${items.length}</td></tr>\` + items.map((d,i) => rowHtml(d, i+1)).join('')).join('')
      : list.map((d,i) => rowHtml(d, i+1)).join('');
    grid.innerHTML = dashTable(body);
    bindCards();
    return;
  }
  grid.classList.remove('table-mode');
  if (!groups){ grid.innerHTML = list.map((d,i) => card(d, i+1)).join(''); bindCards(); return; }
  grid.innerHTML = groups.map(([t,items]) => \`<div class="group-h">\${esc(t)} · \${items.length}</div>\` + items.map((d,i) => card(d, i+1)).join('')).join('');
  bindCards();
}

// ── Manual entry: add + delete ────────────────────────────────────────────
function editToken(){
  if (!CFG.editProtected) return '';
  let t = localStorage.getItem('editToken');
  if (!t){ t = prompt('Enter edit password:') || ''; if (t) localStorage.setItem('editToken', t); }
  return t;
}
async function api(method, path, body){
  const headers = { 'content-type':'application/json' };
  if (CFG.editProtected) headers['x-edit-token'] = editToken();
  const res = await fetch(path, { method, headers, body: body?JSON.stringify(body):undefined });
  if (res.status === 401){ localStorage.removeItem('editToken'); }
  return res;
}
function bindCards(){
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this dashboard?')) return;
    const res = await api('DELETE', '/api/manual?id='+encodeURIComponent(b.dataset.del));
    if (res.ok) location.reload(); else alert('Delete failed: '+(await res.json()).error);
  });
  // (edit is handled by the grid click delegation)
  // Click a progress segment → set that stage on the dashboard.
  document.querySelectorAll('[data-setstage]').forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    const id = b.dataset.setstage, stage = b.dataset.stage;
    const d = DATA.dashboards.find(x => x.id === id); if (!d || d.state === stage) return;
    const res = await api('POST', '/api/stage', { id, stage });
    if (res.ok){ d.state = stage; d.progress = STATES.findIndex(x=>x.id===stage)/(STATES.length-1); DATA.counts = recount(); render(); }
    else alert('Could not set stage: '+((await res.json()).error||res.status));
  });
}
const bindDelete = bindCards; // back-compat
function recount(){ const c = Object.fromEntries(STATES.map(s => [s.id,0])); DATA.dashboards.forEach(d => c[d.state]!==undefined && c[d.state]++); return c; }

const G = (id) => document.getElementById(id);

// ── Directory-backed dropdowns: Clients (multi-select) + Assigned-to (combo) ──
let DIR = { clients: [], team: [] };   // filled from /api/directory (Muns platform)
let clientSel = [];                    // currently selected client names
const uniqSort = (a) => { const s=new Set(), o=[]; a.forEach(n=>{ n=String(n||'').trim(); const k=n.toLowerCase(); if(n && !s.has(k)){ s.add(k); o.push(n); } }); return o.sort((x,y)=>x.localeCompare(y)); };
function clientOptions(){ return uniqSort([...(DATA.customers||[]), ...DIR.clients]); }
function ownerOptions(){ return uniqSort([...(DATA.owners||[]), ...DIR.team]); }

function renderClientChips(){
  const box = G('clientChips'); if (!box) return;
  box.innerHTML = '';
  clientSel.forEach(name => {
    const chip = document.createElement('span'); chip.className = 'ms-chip';
    chip.appendChild(document.createTextNode(name));
    const x = document.createElement('button'); x.type='button'; x.textContent='×'; x.title='Remove';
    x.onclick = (e) => { e.stopPropagation(); clientSel = clientSel.filter(c => c !== name); renderClientChips(); if (G('clientDD').classList.contains('open')) renderClientMenu(); };
    chip.appendChild(x); box.appendChild(chip);
  });
}
function renderClientMenu(){
  const menu = G('clientMenu'); if (!menu) return;
  const typed = (G('clientSearch').value || '').trim();
  const q = typed.toLowerCase();
  const opts = clientOptions().filter(n => !q || n.toLowerCase().includes(q));
  menu.innerHTML = '';
  opts.forEach(name => {
    const on = clientSel.some(c => c.toLowerCase() === name.toLowerCase());
    const row = document.createElement('div'); row.className = 'dd-opt' + (on ? ' on' : ''); row.style.cursor = 'pointer';
    const cb = document.createElement('input'); cb.type='checkbox'; cb.checked = on; cb.tabIndex=-1; cb.style.pointerEvents = 'none';
    row.appendChild(cb);
    const lbl = document.createElement('label'); lbl.style.flex = '1'; lbl.style.cursor = 'pointer'; lbl.style.margin = '0'; lbl.appendChild(document.createTextNode(name));
    row.appendChild(lbl);
    row.onclick = (e) => {
      e.stopPropagation();
      if (clientSel.some(c => c.toLowerCase() === name.toLowerCase())) clientSel = clientSel.filter(c => c.toLowerCase() !== name.toLowerCase());
      else clientSel.push(name);
      const nowOn = clientSel.includes(name);
      cb.checked = nowOn; row.classList.toggle('on', nowOn); renderClientChips(); closeClientDD();
    };
    menu.appendChild(row);
  });
  if (typed && !clientOptions().some(n => n.toLowerCase() === q)){
    const add = document.createElement('div'); add.className = 'dd-add';
    add.textContent = '+ Add "' + typed + '"';
    add.onclick = () => { if (!clientSel.some(c => c.toLowerCase() === q)) clientSel.push(typed); G('clientSearch').value=''; renderClientChips(); renderClientMenu(); };
    menu.appendChild(add);
  } else if (!opts.length){
    const em = document.createElement('div'); em.className='dd-empty'; em.textContent='No matching clients'; menu.appendChild(em);
  }
}
function setClients(arr){ clientSel = (arr||[]).map(s => String(s).trim()).filter(Boolean); const s=G('clientSearch'); if (s) s.value=''; renderClientChips(); }
function getClients(){ return clientSel.slice(); }

function renderOwnerMenu(){
  const menu = G('ownerMenu'); if (!menu) return;
  const cur = (G('f_owner').value || '').trim();
  const q = cur.toLowerCase();
  const opts = ownerOptions().filter(n => !q || n.toLowerCase().includes(q));
  menu.innerHTML = '';
  if (!opts.length){ const em=document.createElement('div'); em.className='dd-empty'; em.textContent='No matching people'; menu.appendChild(em); return; }
  opts.forEach(name => {
    const row = document.createElement('div'); row.className = 'dd-opt' + (cur === name ? ' on' : '');
    row.textContent = name;
    row.onmousedown = (e) => { e.preventDefault(); G('f_owner').value = name; closeOwnerDD(); };
    menu.appendChild(row);
  });
}
function openClientDD(){ const dd=G('clientDD'); if (!dd) return; renderClientMenu(); dd.classList.add('open'); }
function closeClientDD(){ const dd=G('clientDD'); if (dd) dd.classList.remove('open'); }
function openOwnerDD(){ const dd=G('ownerDD'); if (!dd) return; renderOwnerMenu(); dd.classList.add('open'); }
function closeOwnerDD(){ const dd=G('ownerDD'); if (dd) dd.classList.remove('open'); }

// ── Custom due-date calendar ──────────────────────────────────────────────
let calView = null;   // { y, m } of the month currently displayed
const CAL_MN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const CAL_MS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function isoOf(y,m,d){ return y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0'); }
function parseISO(s){ const p=String(s).split('-').map(Number); return new Date(p[0], p[1]-1, p[2]); }
function fmtDue(iso){ if(!iso) return ''; const [y,m,d]=iso.split('-'); return String(+d)+' '+CAL_MS[+m-1]+' '+y; }
function setDue(iso){
  const f=G('f_due'); if(!f) return; f.value = iso || '';
  const lbl=G('dueLabel'); if(!lbl) return;
  if(iso){ lbl.textContent=fmtDue(iso); lbl.classList.remove('muted'); }
  else { lbl.textContent='Select a date'; lbl.classList.add('muted'); }
  const clr=G('dueClear'); if(clr) clr.hidden = !iso;
}
function renderCal(){
  const cal=G('dueCal'); if(!cal||!calView) return;
  const {y,m}=calView;
  const start=new Date(y,m,1).getDay(), days=new Date(y,m+1,0).getDate();
  const t=new Date(), todayIso=isoOf(t.getFullYear(),t.getMonth(),t.getDate()), sel=G('f_due').value;
  const DOW=['Su','Mo','Tu','We','Th','Fr','Sa'];
  let g='<div class="cal-grid">'+DOW.map(d=>'<span class="cal-dow">'+d+'</span>').join('');
  for(let i=0;i<start;i++) g+='<span class="cal-day other"></span>';
  for(let d=1;d<=days;d++){ const iso=isoOf(y,m,d); const c=['cal-day']; if(iso===todayIso)c.push('today'); if(iso===sel)c.push('sel'); g+='<button type="button" class="'+c.join(' ')+'" data-iso="'+iso+'">'+d+'</button>'; }
  g+='</div>';
  cal.innerHTML='<div class="cal"><div class="cal-head"><span class="cal-title">'+CAL_MN[m]+' '+y+'</span><span class="cal-nav"><button type="button" data-cal="prev" aria-label="Previous month">‹</button><button type="button" data-cal="next" aria-label="Next month">›</button></span></div>'+g+'</div>';
  cal.querySelector('[data-cal=prev]').onclick=(e)=>{ e.stopPropagation(); if(--calView.m<0){calView.m=11;calView.y--;} renderCal(); };
  cal.querySelector('[data-cal=next]').onclick=(e)=>{ e.stopPropagation(); if(++calView.m>11){calView.m=0;calView.y++;} renderCal(); };
  cal.querySelectorAll('[data-iso]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); setDue(b.dataset.iso); closeCal(); });
}
function openCal(){ const dd=G('dueDD'); if(!dd) return; const iso=G('f_due').value; const base=iso?parseISO(iso):new Date(); calView={y:base.getFullYear(), m:base.getMonth()}; renderCal(); dd.classList.add('open'); }
function closeCal(){ const dd=G('dueDD'); if(dd) dd.classList.remove('open'); }

const DEFAULT_LINK_LABELS = ['First client meeting','First feedback meeting','Second feedback meeting','Third feedback meeting'];
function linkRowHtml(label, url){
  return \`<div class="link-row"><input class="f_llabel" placeholder="label, e.g. First client meeting" value="\${esc(label||'')}"><input class="f_lurl" placeholder="https://… (YouTube etc.)" value="\${esc(url||'')}"><button type="button" class="rm-client" title="Remove">×</button></div>\`;
}
function setLinks(arr){
  const box = G('linkRows');
  const list = (arr && arr.length) ? arr : [{ label: DEFAULT_LINK_LABELS[0], url:'' }];
  box.innerHTML = list.map(l => linkRowHtml(l.label, l.url)).join('');
  box.querySelectorAll('.rm-client').forEach(b => b.onclick = () => { if (box.children.length > 1) b.parentElement.remove(); else { b.parentElement.querySelectorAll('input').forEach(i=>i.value=''); } });
}
function getLinks(){
  return [...G('linkRows').querySelectorAll('.link-row')].map(r => ({
    label: r.querySelector('.f_llabel').value.trim(),
    url: r.querySelector('.f_lurl').value.trim(),
  })).filter(l => l.url);
}
// ── Brief for the assignee: attached images/files + reference links ─────────
let briefFiles = [];
function renderBriefFiles(){
  const box = G('briefFiles'); if (!box) return;
  box.innerHTML = briefFiles.map(f => fileChip(f, true)).join('');
  box.querySelectorAll('[data-fx]').forEach(b => b.onclick = () => { briefFiles = briefFiles.filter(x => x.id !== b.dataset.fx); renderBriefFiles(); });
}
function briefLinkRowHtml(label, url){
  return \`<div class="link-row"><input class="f_llabel" placeholder="label, e.g. Reference sheet" value="\${esc(label||'')}"><input class="f_lurl" placeholder="https://… reference link" value="\${esc(url||'')}"><button type="button" class="rm-client" title="Remove">×</button></div>\`;
}
function setBriefLinks(arr){
  const box = G('briefLinkRows'); if (!box) return;
  box.innerHTML = (arr || []).map(l => briefLinkRowHtml(l.label, l.url)).join('');
  box.querySelectorAll('.rm-client').forEach(b => b.onclick = () => b.parentElement.remove());
}
function getBriefLinks(){
  const box = G('briefLinkRows'); if (!box) return [];
  return [...box.querySelectorAll('.link-row')].map(r => ({
    label: r.querySelector('.f_llabel').value.trim(),
    url: r.querySelector('.f_lurl').value.trim(),
  })).filter(l => l.url);
}
// ── File upload (PDF / image) → base64 in KV ───────────────────────────────
function pickFiles(){
  return new Promise((resolve) => { const inp = G('filePick'); inp.value=''; inp.multiple = true; inp.onchange = () => resolve([...inp.files]); inp.click(); });
}
function fileToB64(file){ return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); }); }
// Upload one or more files at once → returns array of {id,name,type,url}.
async function uploadFiles(){
  const files = await pickFiles(); const out = [];
  for (const file of files){
    if (file.size > 4*1024*1024){ alert(file.name + ' is over 4 MB — skipped.'); continue; }
    const data = await fileToB64(file);
    const res = await api('POST', '/api/file', { name:file.name, type:file.type, data });
    if (res.ok){ const j = await res.json(); out.push({ id:j.id, name:j.name, type:j.type, url:j.url }); }
    else alert('Upload failed for ' + file.name);
  }
  return out;
}
async function uploadFile(){ const a = await uploadFiles(); return a[0] || null; }
function fileChip(f, removable){
  const img = (f.type||'').startsWith('image/');
  return \`<span class="fchip"><a href="\${esc(f.url||('/api/file?id='+f.id))}" target="_blank" rel="noopener">\${img?'🖼':'📄'} \${esc(f.name||'file')}</a>\${removable?\`<button type="button" class="fx" data-fx="\${esc(f.id)}">×</button>\`:''}</span>\`;
}

// Feedbacks: edited via in-memory state, saved on submit.
let fbState = [];
function fbRowHtml(f, i){
  return \`<div class="fb-row">
    <div class="fb-top"><input class="fb-cat" placeholder="area, e.g. Data Audit" value="\${esc(f.category||'')}"><input class="fb-label" placeholder="headline / change \${i+1}" value="\${esc(f.label||'')}"><input type="date" class="fb-date" value="\${esc(f.date||'')}">
      <label class="toggle"><input type="checkbox" class="fb-done" \${f.implemented?'checked':''}><span class="track"></span><span class="tlabel">implemented</span></label>
      <button type="button" class="rm-client fb-rm" title="Remove">×</button></div>
    <textarea class="fb-text" rows="2" placeholder="what the client asked / what you changed">\${esc(f.text||'')}</textarea>
    <div class="fb-bot"><input class="fb-link" placeholder="https://… recording / message link" value="\${esc(f.link||'')}"><button type="button" class="btn ghost sm fb-file">📎 add screenshots (pick many)</button><label class="fb-pp" title="How many screenshots to place on each PDF page">per page <select class="fb-perpage"><option value="1"\${(f.perPage||1)==1?' selected':''}>1</option><option value="2"\${(f.perPage||1)==2?' selected':''}>2</option><option value="3"\${(f.perPage||1)==3?' selected':''}>3</option></select></label></div>
    <div class="filebox fb-files"></div>
  </div>\`;
}
function syncFbFromDom(){
  [...G('fbRows').children].forEach((row,i) => { const f = fbState[i]; if(!f) return;
    f.category = row.querySelector('.fb-cat').value;
    f.label = row.querySelector('.fb-label').value; f.date = row.querySelector('.fb-date').value;
    f.text = row.querySelector('.fb-text').value; f.link = row.querySelector('.fb-link').value;
    f.implemented = row.querySelector('.fb-done').checked;
    const pp = row.querySelector('.fb-perpage'); if (pp) f.perPage = +pp.value || 1;
  });
}
function renderFbRows(){
  const box = G('fbRows'); box.innerHTML = fbState.map((f,i) => fbRowHtml(f,i)).join('');
  [...box.children].forEach((row,i) => {
    const f = fbState[i];
    const fb = row.querySelector('.fb-files');
    fb.innerHTML = (f.files||[]).map((x,k) => '<div class="ssrow">'+fileChip(x,true)+'<div class="ss-inputs"><input class="sshdr" data-k="'+k+'" placeholder="page header (optional)" value="'+esc(x.header||'')+'"><input class="sscap" data-k="'+k+'" placeholder="description / caption (optional)" value="'+esc(x.caption||'')+'"></div></div>').join('');
    fb.querySelectorAll('[data-fx]').forEach(b => b.onclick = () => { f.files = f.files.filter(x => x.id !== b.dataset.fx); renderFbRows(); });
    fb.querySelectorAll('.sscap').forEach(inp => inp.oninput = () => { const fl=f.files[+inp.dataset.k]; if(fl) fl.caption = inp.value; });
    fb.querySelectorAll('.sshdr').forEach(inp => inp.oninput = () => { const fl=f.files[+inp.dataset.k]; if(fl) fl.header = inp.value; });
    row.querySelector('.fb-rm').onclick = () => { syncFbFromDom(); fbState.splice(i,1); renderFbRows(); };
    row.querySelector('.fb-file').onclick = async () => { syncFbFromDom(); const ups = await uploadFiles(); if (ups.length){ fbState[i].files = (fbState[i].files||[]).concat(ups); renderFbRows(); } };
  });
}
function getFeedbacks(){ syncFbFromDom(); return fbState.filter(f => f.label || f.text || f.link || (f.files && f.files.length)); }

function updateDueFieldVisibility(){
  const stageSelect = G('f_stage');
  const dueField = G('dueField');
  if (stageSelect && dueField) dueField.hidden = stageSelect.value === 'completed';
}
// ── Sections / subsections editor (nested, up to 4 levels; mirrors the admin) ──
const MAX_SEC_DEPTH = 4;
let sectionsState = [];
let secSeq = 0;
function newSecNode(){ return { id: 'sec'+(secSeq++), name:'', children:[] }; }
function cloneSecNodes(nodes){ return (Array.isArray(nodes)?nodes:[]).map(n => ({ id:'sec'+(secSeq++), name:(n&&n.name)||'', children:cloneSecNodes(n&&n.children) })); }
function findSecNode(nodes, id){ for (const n of nodes){ if (n.id===id) return n; const f=findSecNode(n.children, id); if (f) return f; } return null; }
function removeSecNode(nodes, id){ const i=nodes.findIndex(n=>n.id===id); if (i>=0){ nodes.splice(i,1); return true; } for (const n of nodes){ if (removeSecNode(n.children, id)) return true; } return false; }
function pruneSecNodes(nodes){ return nodes.map(n=>({ name:(n.name||'').trim(), children:pruneSecNodes(n.children) })).filter(n=>n.name || n.children.length); }
function getSections(){ return pruneSecNodes(sectionsState); }
function secNodeHtml(node, num, depth){
  const isSection = depth === 1;
  const label = (isSection ? 'Section ' : 'Sub ') + num;
  let kids = node.children.map((c,j) => secNodeHtml(c, num+'.'+(j+1), depth+1)).join('');
  const addChild = depth < MAX_SEC_DEPTH
    ? \`<button type="button" class="sec-add sub" data-secadd="\${node.id}">+ Sub \${num}.\${node.children.length+1}</button>\` : '';
  return \`<div class="sec-node depth-\${depth}">
    <div class="sec-row"><span class="sec-pill">\${label}</span><input class="sec-name" data-node="\${node.id}" placeholder="\${isSection?'Section name':'Subsection name'}" value="\${esc(node.name)}"><button type="button" class="sec-x" data-secdel="\${node.id}" title="Remove">×</button></div>
    <div class="sec-children">\${kids}\${addChild}</div>
  </div>\`;
}
function renderSections(focusId){
  const box = G('sectionRows'); if (!box) return;
  const empty = sectionsState.length ? '' : '<div class="sec-empty">No sections yet — add one to structure this dashboard on the admin page.</div>';
  box.innerHTML = empty + sectionsState.map((n,i) => secNodeHtml(n, String(i+1), 1)).join('')
    + \`<button type="button" class="sec-add section" id="addSection">+ Section \${sectionsState.length+1}</button>\`;
  box.querySelectorAll('.sec-name').forEach(inp => inp.oninput = () => { const n=findSecNode(sectionsState, inp.dataset.node); if (n) n.name = inp.value; });
  box.querySelectorAll('[data-secadd]').forEach(b => b.onclick = () => { const n=findSecNode(sectionsState, b.dataset.secadd); if (n){ const c=newSecNode(); n.children.push(c); renderSections(c.id); } });
  box.querySelectorAll('[data-secdel]').forEach(b => b.onclick = () => { removeSecNode(sectionsState, b.dataset.secdel); renderSections(); });
  const addS = G('addSection'); if (addS) addS.onclick = () => { const c=newSecNode(); sectionsState.push(c); renderSections(c.id); };
  if (focusId){ const inp = box.querySelector('[data-node="'+focusId+'"]'); if (inp) inp.focus(); }
}

// Reflect the "Leave unassigned" checkbox on the owner field (disabled + dimmed).
function applyUnassigned(){
  const uc = G('f_unassigned'), ow = G('f_owner'); if (!uc || !ow) return;
  ow.disabled = uc.checked;
  ow.placeholder = uc.checked ? 'Unassigned' : 'e.g. Vipul';
  const dd = G('ownerDD'); if (dd) dd.style.opacity = uc.checked ? '.5' : '';
  if (uc.checked) closeOwnerDD();
}
function setForm(d){
  G('f_id').value = d ? d.id : '';
  G('f_name').value = d ? d.name : '';
  setClients(d ? (d.customers || []) : []);
  setLinks(d ? (d.links || []) : []);
  G('f_owner').value = d ? d.owner : '';
  { const uc = G('f_unassigned'); if (uc){ uc.checked = !!(d && !d.owner); applyUnassigned(); } }
  G('f_stage').value = d ? d.state : 'not_started';
  G('f_live').value = d && d.isLive ? 'Live on Munshot' : 'Not Live';
  G('f_prio').value = d ? String(d.priorityLevel || 0) : '0';
  G('f_url').value = d ? (d.dashboardUrl || '') : '';
  setDue(d ? (d.dueDate || '') : '');
  fbState = d && Array.isArray(d.feedbacks) ? JSON.parse(JSON.stringify(d.feedbacks)) : [];
  renderFbRows();
  sectionsState = d && Array.isArray(d.sections) ? cloneSecNodes(d.sections) : [];
  renderSections();
  if (G('f_brief')) G('f_brief').value = d ? (d.brief || '') : '';
  briefFiles = d && Array.isArray(d.briefFiles) ? d.briefFiles.slice() : [];
  renderBriefFiles();
  setBriefLinks(d ? (d.briefLinks || []) : []);
  G('formMsg').textContent = '';
  updateDueFieldVisibility();
}
function openForm(){ const b = G('formModalBg'); if (b) b.classList.add('open'); }
function closeForm(){ const b = G('formModalBg'); if (b) b.classList.remove('open'); }
function openAdd(){ setForm(null); G('panelTitle').textContent = 'Add dashboard'; G('saveBtn').textContent = 'Save dashboard'; G('fbLabel').hidden = true; openForm(); G('f_name').focus(); }
function openEdit(id){
  const d = DATA.dashboards.find(x => x.id === id);
  if (!d) return;
  closeDrawer();
  setForm(d);
  G('panelTitle').textContent = 'Edit · ' + (d.serial ? '#'+d.serial+' ' : '') + d.name;
  G('saveBtn').textContent = 'Save changes';
  G('fbLabel').hidden = false;
  openForm();
}

if (CFG.manualEnabled){
  // Move the add/edit modal out of the Overview section to <body> so it isn't
  // hidden when another tab is active (it's position:fixed — DOM spot is moot).
  { const fm = G('formModalBg'); if (fm && fm.parentElement !== document.body) document.body.appendChild(fm); }
  G('addToggle').onclick = openAdd;
  G('cancelBtn').onclick = closeForm;
  G('formX').onclick = closeForm;
  // Clients multi-select + Assigned-to combobox (attached, scrollable dropdowns)
  const cs = G('clientSearch'), cctl = G('clientCtl'), cdd = G('clientDD');
  if (cctl && cs){
    cctl.onclick = (e) => { if (e.target !== cs) cs.focus(); openClientDD(); };
    cs.onfocus = openClientDD;
    cs.oninput = () => { openClientDD(); };
    cs.onkeydown = (e) => {
      if (e.key === 'Enter'){ e.preventDefault(); const t=cs.value.trim(); if (t && !clientOptions().some(n=>n.toLowerCase()===t.toLowerCase()) && !clientSel.some(c=>c.toLowerCase()===t.toLowerCase())){ clientSel.push(t); cs.value=''; renderClientChips(); renderClientMenu(); } }
      else if (e.key === 'Backspace' && !cs.value && clientSel.length){ clientSel.pop(); renderClientChips(); renderClientMenu(); }
      else if (e.key === 'Escape'){ closeClientDD(); }
    };
  }
  const ow = G('f_owner');
  if (ow){ ow.onfocus = openOwnerDD; ow.oninput = () => { openOwnerDD(); }; ow.onkeydown = (e) => { if (e.key === 'Escape') closeOwnerDD(); }; }
  { const uc = G('f_unassigned'); if (uc) uc.onchange = () => { if (uc.checked) G('f_owner').value = ''; applyUnassigned(); }; }
  document.addEventListener('mousedown', (e) => {
    if (cdd && !cdd.contains(e.target)) closeClientDD();
    const odd = G('ownerDD'); if (odd && !odd.contains(e.target)) closeOwnerDD();
    const ddd = G('dueDD'); if (ddd && !ddd.contains(e.target)) closeCal();
  });
  G('addLinkRow').onclick = () => {
    const cur = getLinks();
    const nextLabel = DEFAULT_LINK_LABELS[cur.length] || '';
    setLinks(cur.concat({ label: nextLabel, url:'' }));
    G('linkRows').lastElementChild.querySelector('.f_lurl').focus();
  };
  if (G('briefUpload')) G('briefUpload').onclick = async () => { const ups = await uploadFiles(); if (ups.length){ briefFiles = briefFiles.concat(ups); renderBriefFiles(); } };
  if (G('addBriefLink')) G('addBriefLink').onclick = () => {
    setBriefLinks(getBriefLinks().concat({ label:'', url:'' }));
    G('briefLinkRows').lastElementChild.querySelector('.f_lurl').focus();
  };
  if (G('dueTrigger')){
    const toggleCal = () => { G('dueDD').classList.contains('open') ? closeCal() : openCal(); };
    G('dueTrigger').onclick = toggleCal;
    G('dueTrigger').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); toggleCal(); } };
  }
  if (G('dueClear')) G('dueClear').onclick = (e) => { e.stopPropagation(); setDue(''); closeCal(); };
  const stageSelect = G('f_stage');
  if (stageSelect) {
    stageSelect.addEventListener('change', updateDueFieldVisibility);
  }
  G('addFb').onclick = () => { syncFbFromDom(); fbState.push({ id:'fb'+Date.now(), category:'', label:'Feedback '+(fbState.length+1), date:'', text:'', link:'', files:[], implemented:false }); renderFbRows(); };
  G('formModalBg').addEventListener('click', (e) => { if (e.target === G('formModalBg')) closeForm(); });
  G('saveBtn').onclick = async () => {
    const msg = G('formMsg');
    const id = G('f_id').value;
    const links = getLinks();
    const unassigned = !!(G('f_unassigned') && G('f_unassigned').checked);
    const body = {
      name: G('f_name').value,
      customer: getClients().join(' & '),
      owner: unassigned ? '' : G('f_owner').value,
      stage: G('f_stage').value,
      liveRaw: G('f_live').value,
      links,
      meetingUrl: links[0] ? links[0].url : '',
      dashboardUrl: G('f_url').value.trim(),
      dueDate: G('f_due').value,
      feedbacks: getFeedbacks(),
      sections: getSections(),
      brief: (G('f_brief') ? G('f_brief').value : '').trim(),
      briefFiles,
      briefLinks: getBriefLinks(),
    };
    if (!body.name.trim()){ msg.className='msg err'; msg.textContent='Name is required.'; return; }
    // New dashboard with no owner → auto-assign to the lightest-loaded teammate,
    // UNLESS the user ticked "Leave unassigned".
    let autoOwner = '';
    if (!id && !unassigned && !body.owner.trim()){ const a = (typeof recommendOwner==='function') ? recommendOwner({}) : ''; if (a){ body.owner = a; autoOwner = a; } }
    msg.className='msg'; msg.textContent='Saving…';
    const res = id ? await api('PUT', '/api/manual', { id, ...body }) : await api('POST', '/api/manual', body);
    if (!res.ok){ const e = await res.json().catch(()=>({})); msg.className='msg err'; msg.textContent='Error: '+(e.error||res.status); return; }
    const saved = await res.json().catch(() => ({}));
    const savedId = id || (saved.dashboard && saved.dashboard.id);
    const level = parseInt(G('f_prio').value, 10) || 0;
    if (savedId) await api('POST', '/api/priority', { id: savedId, level });
    msg.className='msg ok'; msg.textContent='Saved.';
    if (autoOwner) alert('Auto-assigned to ' + autoOwner + ' — they had the lightest workload.');
    location.reload();
  };
}

// ── Owner / client profile drawer + overviews ──────────────────────────────
const overlay = document.getElementById('overlay');
const drawer = document.getElementById('drawer');
function closeDrawer(){ overlay.classList.remove('open'); }
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDrawer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// Roll up a list of dashboards into the headline buckets used everywhere.
const MID_STAGES = ['ui_ux','data_integration','final_check','feedback_open','feedback_incorp'];
function rollup(list){
  const byState = Object.fromEntries(STATES.map(s => [s.id, list.filter(d => d.state === s.id)]));
  const c = Object.fromEntries(STATES.map(s => [s.id, byState[s.id].length]));
  return {
    list, byState, c, total: list.length,
    completed: c.completed,                                  // finished
    inprogress: MID_STAGES.reduce((n,k) => n + c[k], 0),     // stages 2–6
    notstarted: c.not_started,                               // not started yet
    live: list.filter(d => d.isLive).length,                 // live flag
    priority: list.filter(d => d.priority).length,
  };
}
function ownerStats(name){ const s = rollup(DATA.dashboards.filter(d => d.owner === name)); s.clients = [...new Set(s.list.flatMap(d => d.customers))].sort(); return s; }
function clientStats(name){ const s = rollup(DATA.dashboards.filter(d => d.customers.includes(name))); s.people = [...new Set(s.list.map(d => d.owner))].sort(); return s; }

function stateBar(c, total){ return STATES.filter(x => c[x.id]).map(x => \`<i style="width:\${(c[x.id]/total*100)}%;background:\${x.color}" title="\${x.label}: \${c[x.id]}"></i>\`).join(''); }
function statCard(num, lbl, color, states){
  return \`<div class="stat" \${num?\`data-states="\${states}"\`:''}><div class="num" style="color:\${num?color:'var(--muted)'}">\${num}</div><div class="lbl">\${lbl}</div></div>\`;
}
function statRow(s){
  return \`<div class="stat-row">\${statCard(s.completed,'Completed','#22c55e','completed')}\${statCard(s.inprogress,'In progress','#f97316',MID_STAGES.join(' '))}\${statCard(s.notstarted,'Not started','#9ca3af','not_started')}\${statCard(s.live,'Live','#16a34a','__live')}</div>\`;
}
function sectionsHtml(s, metaFn){
  return STATES.filter(x => s.byState[x.id].length).map(x => {
    const rows = s.byState[x.id].map(d => {
      const lks = (d.links||[]).filter(l => l && l.url);
      const live = d.isLive ? \`<span class="dlink" style="background:#e7f7ee;border-color:#bfe6cf;color:#0e7a52">● Live</span>\` : '';
      const linkHtml = (lks.length||live) ? \`<div class="dlinks">\${live}\${lks.map(l => \`<a class="dlink" href="\${esc(l.url)}" target="_blank" rel="noopener" title="\${esc(l.url)}">\${esc(l.label||'Open')} ↗</a>\`).join('')}</div>\` : '';
      return \`<div class="drow clickable" data-open="\${esc(d.id)}"><span class="sn">\${d.priorityLevel?'★':'•'}</span><div><div class="dn">\${esc(d.name)}</div><div class="dmeta">\${metaFn(d)}</div></div>\${linkHtml}</div>\`;
    }).join('');
    return \`<div class="section-t clk" data-states="\${x.id}"><span class="dot" style="background:\${x.color}"></span>\${x.label} · \${s.c[x.id]}</div>\${rows}\`;
  }).join('');
}
let ownerSub = 'work';
function val(id){ const e = document.getElementById(id); return e ? e.value : ''; }
function employeeProfileHtml(name){
  const p = personData(name), ed = CFG.manualEnabled;
  const f = (id,label,v,type) => \`<label class="pf"><span>\${label}</span><input id="\${id}" type="\${type||'text'}" value="\${esc(v||'')}" \${ed?'':'disabled'}></label>\`;
  return \`<div class="emp"><div class="section-t">Profile</div>
    <div class="pf-grid">
      \${f('pf_role','Role at Munshot', p.role)}
      \${f('pf_qual','Qualification', p.qualification)}
      \${f('pf_phone','Phone', p.phone, 'tel')}
      \${f('pf_email','Email', p.email, 'email')}
      \${f('pf_cal','Google Calendar link', p.calendarUrl)}
    </div>
    \${ed?'<button class="btn sm" id="pfSave">Save profile</button>':''}
    \${p.calendarUrl?\`<a class="lnk" style="margin-top:8px;display:inline-block" href="\${esc(p.calendarUrl)}" target="_blank">🗓 Open calendar</a>\`:''}
  </div>\`;
}
function wireEmployeeProfile(name){
  const btn = document.getElementById('pfSave'); if (!btn) return;
  btn.onclick = async () => {
    const res = await api('POST', '/api/person', { name, role:val('pf_role'), qualification:val('pf_qual'), phone:val('pf_phone'), email:val('pf_email'), calendarUrl:val('pf_cal') });
    if (res.ok){ DATA.people[name] = (await res.json()).person; btn.textContent = 'Saved ✓'; setTimeout(()=>btn.textContent='Save profile',1500); } else alert('Save failed.');
  };
}
function ownerTasksHtml(name){
  const memberTasks = TASKS.filter(t => t.member === name);
  const todo = memberTasks.filter(t => !t.done);
  const accomplished = memberTasks.filter(t => t.done);
  const ed = CFG.manualEnabled;

  const taskRow = (t) => \`<div class="task-row">
    <button class="task-check \${t.done?'done':''}" data-task-id="\${t.id}">\${t.done?'✓':'○'}</button>
    <div class="task-text \${t.done?'done':''}">\${esc(t.text)}</div>
    \${ed?\`<button class="task-del" data-task-id="\${t.id}">×</button>\`:''}
  </div>\`;

  const todoList = todo.length ? todo.map(taskRow).join('') : '<div class="empty-tasks">No tasks yet</div>';
  const doneList = accomplished.length ? accomplished.map(taskRow).join('') : '<div class="empty-tasks">No accomplished tasks yet</div>';

  return \`<div class="tasks-container">
    <div class="section-t">📝 To-Do · \${todo.length}</div>
    \${ed?\`<div class="task-add-row">
      <input type="text" id="taskInput" placeholder="Add a new task..." />
      <button class="btn sm" id="taskAddBtn">+ Add</button>
    </div>\`:''}
    <div class="task-list">\${todoList}</div>
    <div class="section-t" style="margin-top:20px">✅ Accomplished · \${accomplished.length}</div>
    <div class="task-list">\${doneList}</div>
  </div>\`;
}
// A teammate's dashboards as a simple tap-to-expand list; expanding reveals an
// inline working-notes scratchpad (add + delete) — no heavy modal to open.
function pnoteItemHtml(nt){
  return \`<div class="dnote-item" data-nid="\${nt.ts}"><span class="dnote-tx">\${esc(nt.text)}</span>\${CFG.manualEnabled?\`<button class="dnote-del pnote-del" data-ts="\${nt.ts}" title="Delete note">×</button>\`:''}</div>\`;
}
function ownerDashNotesHtml(name){
  const mine = DATA.dashboards.filter(d => d.owner === name);
  const active = mine.filter(d => d.state !== 'completed');
  const done = mine.filter(d => d.state === 'completed');
  const ordered = active.concat(done);
  if (!ordered.length) return '<div class="empty">No dashboards assigned yet.</div>';
  const ed = CFG.manualEnabled;
  const row = (d) => {
    const st = SMAP[d.state] || {};
    const n = (d.notes||[]).length;
    const notesHtml = (d.notes||[]).length ? d.notes.slice().reverse().map(pnoteItemHtml).join('') : '<div class="dnote muted">No notes yet — jot what you want to do here.</div>';
    return \`<div class="pnote-dash \${d.state==='completed'?'done':''}" data-pd="\${esc(d.id)}">
      <div class="pnote-row" data-pdtoggle="\${esc(d.id)}">
        <span class="pnote-chev">▸</span>
        <div class="pnote-main"><div class="pnote-name">\${d.priorityLevel?'★ ':''}\${esc(d.name)}\${d.isLive?'<span class="tlive">● Live</span>':''}</div>
          <div class="pnote-sub"><span class="mw-dot" style="background:\${st.color||'#ccc'}"></span>\${esc(st.label||d.state)} · \${esc(d.customer||'—')} \${dueChip(d)}</div></div>
        <span class="pnote-count \${n?'has':''}">📝 \${n}</span>
      </div>
      <div class="pnote-panel" hidden>
        \${ed?\`<div class="dnote-add"><input class="pnote-input" placeholder="Add a note — what to do here…" autocomplete="off"><button class="btn sm pnote-add">Add</button></div>\`:''}
        <div class="dnotes">\${notesHtml}</div>
        <a class="lnk pnote-open" data-open="\${esc(d.id)}" style="margin-top:9px;display:inline-block">Open full dashboard ↗</a>
      </div>
    </div>\`;
  };
  return \`<div class="section-t">Your dashboards — tap one to add notes</div><div class="pnote-list">\${ordered.map(row).join('')}</div>\`;
}
function ownerBodyHtml(name, s){
  if (ownerSub === 'work'){
    return statRow(s) + \`<div class="bar">\${stateBar(s.c,s.total)}</div>\`
      + (s.clients.length?\`<div class="section-t">Clients</div><div class="chips">\${s.clients.map(c=>clientTag(c).replace('data-customer','data-jump-customer')).join('')}</div>\`:'')
      + ownerDashNotesHtml(name);
  }
  if (ownerSub === 'todo' || ownerSub === 'tasks') return ownerTasksHtml(name);
  if (ownerSub === 'profile') return employeeProfileHtml(name);
  return employeeTerminalHtml(name); // attendance
}
function wireOwnerTasks(name){
  if (!CFG.manualEnabled) return;

  const addBtn = document.getElementById('taskAddBtn');
  const taskInput = document.getElementById('taskInput');

  if (addBtn && taskInput) {
    const addTask = async () => {
      const text = taskInput.value.trim();
      if (!text) return;

      const res = await taskAdd({ member: name, text });
      if (res.ok) {
        taskInput.value = '';
        renderOwner(name);
      } else {
        alert('Failed to add task');
      }
    };

    addBtn.onclick = addTask;
    taskInput.onkeypress = (e) => { if (e.key === 'Enter') addTask(); };
  }

  drawer.querySelectorAll('.task-check').forEach(check => {
    check.onclick = async () => {
      const taskId = check.dataset.taskId;
      const task = TASKS.find(t => t.id === taskId);
      if (!task) return;

      const res = await taskToggle(task, !task.done);
      if (res.ok) {
        renderOwner(name);
      } else {
        alert('Failed to update task');
      }
    };
  });

  drawer.querySelectorAll('.task-del').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Delete this task?')) return;

      const taskId = btn.dataset.taskId;
      const res = await taskDelete(taskId);
      if (res.ok) {
        renderOwner(name);
      } else {
        alert('Failed to delete task');
      }
    };
  });
}
function openOwner(name){ ownerSub = 'work'; renderOwner(name); overlay.classList.add('open'); }
function renderOwner(name){
  const s = ownerStats(name), p = personData(name);
  const pending = TASKS.filter(t => t.member === name && !t.done).length;
  const hr = ownerSub==='profile';
  const nav = hr
    ? \`<nav class="subtabs"><button class="subtab back-sub" data-sub="work">‹ Back to work</button><button class="subtab \${ownerSub==='profile'?'on':''}" data-sub="profile">👤 Profile</button></nav>\`
    : \`<nav class="subtabs"><button class="subtab \${ownerSub==='work'?'on':''}" data-sub="work">📋 Dashboards (\${s.total})</button><button class="subtab \${(ownerSub==='todo'||ownerSub==='tasks')?'on':''}" data-sub="todo">✅ To-do\${pending?' ('+pending+')':''}</button></nav>\`;
  drawer.innerHTML = \`
    <div class="drawer-head">
      <div><button class="back" id="drawerBack">‹ Team</button>
      <div class="av-head">\${avatar(name,'lg')}<div><h2>\${esc(name)}</h2>
      <div class="sub">\${esc(p.role||'Team member')} · \${s.total} dashboard\${s.total!==1?'s':''}</div></div></div></div>
      <div class="dh-right">\${hr?'':'<button class="btn ghost sm" id="hrBtn">👤 Profile</button>'}<button class="x" id="drawerX">×</button></div>
    </div>
    \${nav}
    <div class="drawer-body">\${ownerBodyHtml(name, s)}</div>\`;
  document.getElementById('drawerX').onclick = closeDrawer;
  document.getElementById('drawerBack').onclick = () => { closeDrawer(); switchTab('team'); };
  { const hb = document.getElementById('hrBtn'); if (hb) hb.onclick = () => { ownerSub = 'profile'; renderOwner(name); }; }
  drawer.querySelectorAll('.subtab').forEach(b => b.onclick = () => { ownerSub = b.dataset.sub; renderOwner(name); });
  drawer.querySelectorAll('[data-jump-customer]').forEach(b => b.onclick = () => openClient(b.dataset.jumpCustomer));
  drawer.querySelectorAll('[data-states]').forEach(b => b.onclick = () => applyFilter({ owner:name, states:b.dataset.states.split(' ') }));
  drawer.querySelectorAll('[data-open]').forEach(b => b.onclick = (e) => { if (e.target.closest('a.dlink')) return; closeDrawer(); openDetail(b.dataset.open); });
  drawer.querySelectorAll('[data-fbtoggle]').forEach(el => el.onclick = async () => {
    const d = DATA.dashboards.find(x=>x.id===el.dataset.fbtoggle), f = (d.feedbacks||[]).find(x=>x.id===el.dataset.fbid); if(!f) return;
    const res = await api('POST','/api/feedback',{ id:el.dataset.fbtoggle, fbId:el.dataset.fbid, implemented:!f.implemented });
    if (res.ok){ f.implemented=!f.implemented; renderOwner(name); } else alert('Failed.');
  });
  if (ownerSub === 'profile') wireEmployeeProfile(name);
  if (ownerSub === 'todo' || ownerSub === 'tasks') wireOwnerTasks(name);
  if (ownerSub === 'work') wireOwnerNotes(name);
}
// Tap-to-expand dashboard rows + inline working-notes (add / delete) in-place.
function updateNoteCount(card){
  const d = DATA.dashboards.find(x => x.id === card.dataset.pd);
  const n = d ? (d.notes||[]).length : 0;
  const c = card.querySelector('.pnote-count'); if (c){ c.textContent = '📝 ' + n; c.classList.toggle('has', n>0); }
}
function wireOwnerNoteDeletes(card){
  const id = card.dataset.pd;
  card.querySelectorAll('.pnote-del').forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    const ts = b.dataset.ts;
    const res = await api('DELETE', \`/api/notes?id=\${encodeURIComponent(id)}&ts=\${ts}\`);
    if (!res.ok){ alert('Could not delete the note.'); return; }
    const d = DATA.dashboards.find(x => x.id === id); if (d) d.notes = (d.notes||[]).filter(n => String(n.ts) !== String(ts));
    b.closest('.dnote-item').remove();
    const box = card.querySelector('.dnotes'); if (!box.querySelector('.dnote-item')) box.innerHTML = '<div class="dnote muted">No notes yet — jot what you want to do here.</div>';
    updateNoteCount(card);
  });
}
function wireOwnerNotes(name){
  drawer.querySelectorAll('.pnote-dash').forEach(card => {
    const id = card.dataset.pd;
    const row = card.querySelector('.pnote-row');
    const panel = card.querySelector('.pnote-panel');
    row.onclick = () => {
      const open = panel.hasAttribute('hidden');
      if (open){ panel.removeAttribute('hidden'); card.classList.add('open'); const inp = card.querySelector('.pnote-input'); if (inp) inp.focus(); }
      else { panel.setAttribute('hidden', ''); card.classList.remove('open'); }
    };
    const inp = card.querySelector('.pnote-input'), addBtn = card.querySelector('.pnote-add');
    if (addBtn && inp){
      const add = async () => {
        const text = inp.value.trim(); if (!text){ inp.focus(); return; }
        const res = await api('POST', '/api/notes', { id, text });
        if (!res.ok){ const e = await res.json().catch(()=>({})); alert('Could not add: ' + (e.error||res.status)); return; }
        const j = await res.json().catch(()=>({}));
        const d = DATA.dashboards.find(x => x.id === id); if (d){ if (!Array.isArray(d.notes)) d.notes = []; if (j.entry) d.notes.push(j.entry); }
        const box = card.querySelector('.dnotes'); const muted = box.querySelector('.dnote.muted'); if (muted) muted.remove();
        if (j.entry) box.insertAdjacentHTML('afterbegin', pnoteItemHtml(j.entry));
        wireOwnerNoteDeletes(card);
        inp.value = ''; inp.focus();
        updateNoteCount(card);
      };
      addBtn.onclick = add;
      inp.onkeydown = (e) => { if (e.key === 'Enter'){ e.preventDefault(); add(); } };
    }
    wireOwnerNoteDeletes(card);
  });
}

// ── Employee terminal: join date + attendance calendar (manual day log) ─────
let empView = { name:'', y:0, m:0 };
function personData(name){ return (DATA.people && DATA.people[name]) || { joinDate:'', days:{} }; }
function dayStatus(rec, key){ const v = rec.days ? rec.days[key] : undefined; return v && typeof v === 'object' ? v.s : v; }
function employeeStats(name){
  const rec = personData(name);
  let present = 0, leave = 0;
  for (const k in (rec.days||{})){ const st = dayStatus(rec, k); if (st==='present') present++; else if (st==='leave') leave++; }
  let tenure = '';
  if (rec.joinDate){ const j = new Date(rec.joinDate); if (!isNaN(j)) tenure = Math.max(0, Math.floor((Date.now()-j.getTime())/86400000)); }
  return { rec, present, leave, tenure };
}
function calendarHtml(name){
  const rec = personData(name);
  const today = new Date();
  if (empView.name !== name){ empView = { name, y: today.getFullYear(), m: today.getMonth() }; }
  const y = empView.y, m = empView.m;
  const startDow = (new Date(y, m, 1).getDay() + 6) % 7; // Mon=0
  const dim = new Date(y, m+1, 0).getDate();
  const monthName = new Date(y, m, 1).toLocaleString('en-GB', { month:'long', year:'numeric' });
  let cells = '';
  for (let i=0;i<startDow;i++) cells += '<div class="cal-cell empty"></div>';
  for (let d=1; d<=dim; d++){
    const key = y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const st = dayStatus(rec, key) || '';
    const isToday = (y===today.getFullYear() && m===today.getMonth() && d===today.getDate());
    cells += \`<div class="cal-cell \${st} \${isToday?'today':''}" data-day="\${key}">\${d}</div>\`;
  }
  return \`<div class="cal-head"><button class="cal-nav" data-cal="-1">‹</button><span>\${monthName}</span><button class="cal-nav" data-cal="1">›</button></div>
    <div class="cal-dow">\${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(x=>\`<span>\${x}</span>\`).join('')}</div>
    <div class="cal-grid">\${cells}</div>
    <div class="cal-legend"><span class="k present"></span> Present <span class="k leave"></span> Leave <span class="muted">· click a day: present → leave → clear</span></div>\`;
}
function employeeTerminalHtml(name){
  const es = employeeStats(name);
  const editable = CFG.manualEnabled;
  return \`<div class="emp emp-term">
    <div class="section-t">Attendance</div>
    <div class="emp-stats">
      <div class="emp-stat"><div class="n">\${es.tenure!==''?es.tenure:'—'}</div><div class="l">days since joining</div></div>
      <div class="emp-stat"><div class="n">\${es.present}</div><div class="l">working days logged</div></div>
      <div class="emp-stat"><div class="n">\${es.leave}</div><div class="l">leave days</div></div>
    </div>
    <div class="emp-join"><label>Joined</label><input type="date" id="empJoin" value="\${esc(es.rec.joinDate||'')}" \${editable?'':'disabled'}>\${editable?'<button class="btn sm" id="empJoinSave">Save</button>':''}</div>
    <div class="cal" id="empCal">\${calendarHtml(name)}</div>
  </div>\`;
}
function renderEmp(name){ const el = drawer.querySelector('.emp-term'); if (el){ el.outerHTML = employeeTerminalHtml(name); wireEmployee(name); } }
function wireEmployee(name){
  if (!CFG.manualEnabled) return;
  const save = document.getElementById('empJoinSave');
  if (save) save.onclick = async () => {
    const res = await api('POST', '/api/person', { name, joinDate: document.getElementById('empJoin').value });
    if (res.ok){ DATA.people[name] = (await res.json()).person; renderEmp(name); } else alert('Save failed.');
  };
  const cal = document.getElementById('empCal');
  if (!cal) return;
  cal.querySelectorAll('[data-cal]').forEach(b => b.onclick = () => {
    empView.m += Number(b.dataset.cal);
    if (empView.m < 0){ empView.m = 11; empView.y--; }
    if (empView.m > 11){ empView.m = 0; empView.y++; }
    renderEmp(name);
  });
  cal.querySelectorAll('[data-day]').forEach(c => c.onclick = async () => {
    const key = c.dataset.day;
    const cur = dayStatus(personData(name), key);
    const next = cur === undefined || cur === '' ? 'present' : cur === 'present' ? 'leave' : '';
    const res = await api('POST', '/api/person', { name, date: key, status: next });
    if (res.ok){ if (!DATA.people) DATA.people = {}; DATA.people[name] = (await res.json()).person; renderEmp(name); }
    else alert('Could not save (need edit access?).');
  });
}

function openClient(name){
  const s = clientStats(name);
  const det = (DATA.clientDetails && DATA.clientDetails[name]) || {};
  const logo = det.logo ? \`<img class="clogo lg" src="/api/file?id=\${esc(det.logo)}" alt="">\` : \`<span class="avatar lg" style="background:\${nameColor('c·'+name)}">🏢</span>\`;
  drawer.innerHTML = \`
    <div class="drawer-head">
      <div><button class="back" id="drawerBack">‹ Clients</button>
      <div class="av-head">\${logo}<div><h2>\${esc(name)}</h2>
      <div class="sub">\${s.total} dashboard\${s.total!==1?'s':''} · \${s.people.length} on the team</div></div></div></div>
      <button class="x" id="drawerX">×</button>
    </div>
    <div class="drawer-body">
      \${statRow(s)}
      <div class="bar">\${stateBar(s.c,s.total)}</div>
      \${s.people.length?\`<div class="section-t">Team on this client</div><div class="chips">\${s.people.map(o=>\`<span class="av-tag owner-link" data-jump-owner="\${esc(o)}">\${avatar(o)}\${esc(o)}</span>\`).join('')}</div>\`:''}
      \${sectionsHtml(s, d => esc(d.owner)+(d.status&&d.status!=='-'?' — '+esc(d.status):''))}
    </div>\`;
  overlay.classList.add('open');
  document.getElementById('drawerX').onclick = closeDrawer;
  document.getElementById('drawerBack').onclick = () => { closeDrawer(); switchTab('clients'); };
  drawer.querySelectorAll('[data-jump-owner]').forEach(b => b.onclick = () => openOwner(b.dataset.jumpOwner));
  drawer.querySelectorAll('[data-states]').forEach(b => b.onclick = () => applyFilter({ customer:name, states:b.dataset.states.split(' ') }));
  drawer.querySelectorAll('[data-open]').forEach(b => b.onclick = (e) => { if (e.target.closest('a.dlink')) return; closeDrawer(); openDetail(b.dataset.open); });
}

// ── Team & Clients tabs ────────────────────────────────────────────────────
function rosterDelete(type, name, total){
  return async (e) => {
    e.stopPropagation();
    const what = type === 'owner' ? 'team member' : 'client';
    const warn = total > 0
      ? \`Delete \${what} "\${name}"?\\n\\nOn \${total} dashboard\${total!==1?'s':''}. \${type==='owner'?'Those lose their owner.':'Removed from those dashboards.'}\`
      : \`Delete \${what} "\${name}"?\`;
    if (!confirm(warn)) return;
    const res = await api('DELETE', \`/api/roster?type=\${type}&name=\${encodeURIComponent(name)}\`);
    if (res.ok) location.reload(); else alert('Failed: '+((await res.json()).error||res.status));
  };
}
async function exportTeamTasksPdf(){
  try {
    await syncTrackingTasks(); // fold the latest notetaker to-dos into the shared KV store first
    const members = [...new Set([...(DATA.owners||[]), ...TASKS.map(t => t.member)])].filter(Boolean).sort();
    if (!members.length){ alert('No tasks yet.'); return; }

    const content = members.map(name => {
      const mine = TASKS.filter(t => t.member === name);
      const todo = mine.filter(t => !t.done);
      const accomplished = mine.filter(t => t.done);

      return \`
        <div class="pdf-member">
          <h2>\${esc(name)}</h2>
          <div class="pdf-section">
            <h3>📝 To-Do (\${todo.length})</h3>
            \${todo.length ? \`<ul>\${todo.map(t => \`<li>\${esc(t.text)}</li>\`).join('')}</ul>\` : '<p class="empty">No pending tasks</p>'}
          </div>
          <div class="pdf-section">
            <h3>✅ Accomplished (\${accomplished.length})</h3>
            \${accomplished.length ? \`<ul>\${accomplished.map(t => \`<li>\${esc(t.text)}</li>\`).join('')}</ul>\` : '<p class="empty">No accomplished tasks</p>'}
          </div>
        </div>
      \`;
    }).join('');

    const printWindow = window.open('', '_blank');
    printWindow.document.write(\`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Team Tasks - \${new Date().toLocaleDateString()}</title>
        <style>
          @media print { @page { margin: 1.5cm; } }
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 20px; max-width: 800px; margin: 0 auto; }
          h1 { text-align: center; margin-bottom: 30px; color: #333; }
          .pdf-member { page-break-inside: avoid; margin-bottom: 40px; border-bottom: 2px solid #eee; padding-bottom: 20px; }
          .pdf-member:last-child { border-bottom: none; }
          h2 { color: #4f46e5; margin-bottom: 10px; font-size: 24px; }
          .overview { color: #666; font-size: 14px; margin-bottom: 20px; line-height: 1.6; font-style: italic; }
          .pdf-section { margin-bottom: 25px; }
          h3 { color: #666; font-size: 16px; margin-bottom: 10px; }
          ul { list-style-type: disc; padding-left: 25px; }
          li { margin-bottom: 8px; line-height: 1.5; }
          .empty { color: #999; font-style: italic; }
          .date { text-align: center; color: #666; margin-bottom: 20px; }
        </style>
      </head>
      <body>
        <h1>Team Tasks Report</h1>
        <div class="date">Generated on \${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
        \${content}
      </body>
      </html>
    \`);
    printWindow.document.close();

    setTimeout(() => {
      printWindow.print();
    }, 250);
  } catch (e) {
    alert('Failed to generate PDF: ' + e.message);
  }
}
function renderTeamTab(){
  const el = G('tab-team');
  const add = CFG.manualEnabled ? \`<div class="roster-add"><input id="memInput" placeholder="New team member name…"><button class="btn" id="memAdd">+ Add member</button></div>\` : '';
  const cards = DATA.owners.map(name => {
    const s = ownerStats(name), p = (DATA.people&&DATA.people[name])||{};
    const pend = TASKS.filter(t => t.member === name && !t.done).length;
    const dl = DATA.dashboards.filter(d => d.owner === name && d.state !== 'completed');
    const odue = dl.filter(d => { const n = daysUntil(d.dueDate); return n !== null && n < 0; }).length;
    const dsoon = dl.filter(d => { const n = daysUntil(d.dueDate); return n !== null && n >= 0 && n <= 7; }).length;
    const dlBadge = odue ? \`<span class="dl-badge over" title="Overdue dashboards">🔴 \${odue} overdue</span>\` : dsoon ? \`<span class="dl-badge soon" title="Due within 7 days">🟠 \${dsoon} due soon</span>\` : '';
    return \`<div class="profile-card" data-member="\${esc(name)}">
      \${CFG.manualEnabled?\`<button class="rm" data-rmown="\${esc(name)}" data-total="\${s.total}" title="Delete">×</button>\`:''}
      <div class="pc-head">\${avatar(name,'lg')}<div><div class="pc-name">\${esc(name)}</div><div class="pc-role">\${esc(p.role||'Team member')}</div></div></div>
      <div class="pc-stats"><span><b>\${s.total}</b> dashboard\${s.total!==1?'s':''}</span><span><b>\${s.completed}</b> done</span>\${pend?\`<span class="warnpill">\${pend} to-do</span>\`:''}\${dlBadge}</div>
      <div class="bar" style="margin-top:8px">\${stateBar(s.c,s.total)}</div>
    </div>\`;
  }).join('');
  el.innerHTML = \`<div class="tabhead"><h2>👤 Team</h2><div class="sub">\${DATA.owners.length} members · open anyone for profile, attendance & to-dos</div><button class="btn ghost" id="exportTasksPdf">📄 Export Tasks PDF</button></div>\${add}<div class="profile-grid">\${cards||'<div class="empty">No team members yet.</div>'}</div>\`;
  G('exportTasksPdf').onclick = () => exportTeamTasksPdf();
  if (CFG.manualEnabled){
    G('memAdd').onclick = async () => { const n = G('memInput').value.trim(); if(!n) return; const r = await api('POST','/api/roster',{type:'owner',name:n}); if(r.ok) location.reload(); else alert('Failed.'); };
    el.querySelectorAll('[data-rmown]').forEach(b => b.onclick = rosterDelete('owner', b.dataset.rmown, +b.dataset.total));
  }
  el.querySelectorAll('[data-member]').forEach(c => c.onclick = (e) => { if (!e.target.closest('.rm')) openOwner(c.dataset.member); });
}
function renderClientsTab(){
  const el = G('tab-clients');
  const add = CFG.manualEnabled ? \`<div class="roster-add"><input id="cliInput" placeholder="New client name…"><button class="btn" id="cliAdd">+ Add client</button></div>\` : '';
  const cards = DATA.customers.map(name => {
    const s = clientStats(name), det = (DATA.clientDetails&&DATA.clientDetails[name])||{};
    const logo = det.logo ? \`<img class="clogo" src="/api/file?id=\${esc(det.logo)}" alt="">\` : \`<span class="avatar lg" style="background:\${nameColor('c·'+name)}">🏢</span>\`;
    return \`<div class="profile-card" data-client="\${esc(name)}">
      \${CFG.manualEnabled?\`<button class="rm" data-rmcli="\${esc(name)}" data-total="\${s.total}" title="Delete">×</button>\`:''}
      <div class="pc-head">\${logo}<div><div class="pc-name">\${esc(name)}</div><div class="pc-role">\${det.poc?('POC: '+esc(det.poc)):(s.people.length+' on team')}</div></div></div>
      <div class="pc-stats"><span><b>\${s.total}</b> dashboard\${s.total!==1?'s':''}</span><span><b>\${s.completed}</b> done</span>\${det.meetingFreq?\`<span>🗓 \${esc(det.meetingFreq)}</span>\`:''}</div>
      <div class="bar" style="margin-top:8px">\${stateBar(s.c,s.total)}</div>
    </div>\`;
  }).join('');
  const digest = CFG.manualEnabled ? \`<div class="digest-bar">
    <div class="dg-row"><div class="dg-main"><span class="dgi">🗓 <b>Weekly PDF digest</b> — every Build Update PDF this week → founder, <b>Wednesday 9pm IST</b> (one email, each tagged with its client).</span><span class="dgi" id="digestLast">…</span></div><span class="sub" id="digestCount">…</span><button class="btn ghost sm" id="digestNow">Send now</button></div>
    <div class="dg-row"><div class="dg-main"><span class="dgi">📊 <b>Daily status</b> — per-member & per-dashboard progress (done / pending / %) → founder, <b>every day 9pm IST</b>.</span><span class="dgi" id="dailyLast">…</span></div><span class="sub"></span><button class="btn ghost sm" id="dailyNow">Send now</button></div>
  </div>\` : '';
  el.innerHTML = \`<div class="tabhead"><h2>🏢 Clients</h2><div class="sub">\${DATA.customers.length} clients · open any for details, team & dashboards</div></div>\${digest}\${add}<div class="profile-grid">\${cards||'<div class="empty">No clients yet.</div>'}</div>\`;
  if (CFG.manualEnabled){
    G('cliAdd').onclick = async () => { const n = G('cliInput').value.trim(); if(!n) return; const r = await api('POST','/api/roster',{type:'customer',name:n}); if(r.ok) location.reload(); else alert('Failed.'); };
    el.querySelectorAll('[data-rmcli]').forEach(b => b.onclick = rosterDelete('customer', b.dataset.rmcli, +b.dataset.total));
    const dn = document.getElementById('digestNow'); if (dn) dn.onclick = () => sendDigestNow(dn);
    const dl = document.getElementById('dailyNow'); if (dl) dl.onclick = () => sendDailyNow(dl);
    const lastTxt = (l, emptyMsg) => { if (!l) return '⏳ Has not run yet — set MUNS_TOKEN, then test with “Send now”.';
      const when = new Date(l.at).toLocaleString();
      if (l.skipped) return '🕗 Last ran '+when+' ('+(l.trigger||'')+') — '+emptyMsg;
      return l.ok ? ('✅ Last sent '+when+' ('+(l.trigger||'')+') → '+(l.to||'')) : ('⚠️ Last run '+when+' FAILED: '+String(l.error||'').slice(0,70)); };
    api('GET','/api/digest').then(async r => { if(!r.ok) return; const j = await r.json();
      const c = document.getElementById('digestCount'); if (c) c.textContent = j.count ? (j.count+' queued → '+j.to) : ('nothing queued yet → '+j.to);
      const L = document.getElementById('digestLast'); if (L) L.textContent = lastTxt(j.last, 'nothing was queued');
      const D2 = document.getElementById('dailyLast'); if (D2) D2.textContent = lastTxt(j.dailyLast, 'no dashboards had feedback');
    }).catch(()=>{});
  }
  el.querySelectorAll('[data-client]').forEach(c => c.onclick = (e) => { if (!e.target.closest('.rm')) openClient(c.dataset.client); });
}

// ── Dashboard detail modal (the rich, click-to-open view) ──────────────────
const detailBg = G('detailBg'), detailModal = G('detailModal');
function closeDetail(){ detailBg.classList.remove('open'); }
detailBg.addEventListener('click', (e) => { if (e.target === detailBg) closeDetail(); });
function fileGrid(files){
  return (files||[]).map(f => {
    const u = f.url || ('/api/file?id='+f.id);
    return (f.type||'').startsWith('image/')
      ? \`<a href="\${esc(u)}" target="_blank" rel="noopener" class="thumb"><img src="\${esc(u)}" alt="\${esc(f.name||'')}"></a>\`
      : \`<a href="\${esc(u)}" target="_blank" rel="noopener" class="fchip">📄 \${esc(f.name||'file')}</a>\`;
  }).join('');
}
function factCell(label, val){ return \`<div class="fact"><div class="fl">\${label}</div><div class="fv">\${val}</div></div>\`; }
// Read-only render of the section/subsection tree with 1 / 1.1 / 1.1.1 numbering.
function secViewHtml(nodes, prefix){
  if (!Array.isArray(nodes) || !nodes.length) return '';
  return '<ul class="secview">' + nodes.map((n,i) => {
    const num = (prefix ? prefix+'.' : '') + (i+1);
    return '<li><span class="secview-num">'+esc(num)+'</span> '+esc(n.name||'—')+secViewHtml(n.children, num)+'</li>';
  }).join('') + '</ul>';
}
function fbView(did, f, editable){
  const u = f.link;
  return \`<div class="fbv">
    <div class="fbv-top">\${f.category?\`<span class="fbcat">\${esc(f.category)}</span>\`:''}<b>\${esc(f.label||'Feedback')}</b>\${f.date?\`<span class="muted"> · \${esc(f.date)}</span>\`:''}
      <button class="impl \${f.implemented?'yes':'no'}" \${editable?\`data-fbtoggle="\${esc(did)}" data-fbid="\${esc(f.id)}"\`:'disabled'}>\${f.implemented?'✓ implemented':'✗ pending'}</button></div>
    \${f.text?\`<div class="dnote">\${esc(f.text)}</div>\`:''}
    \${(u||(f.files&&f.files.length))?\`<div class="dlinks">\${u?\`<a href="\${esc(u)}" target="_blank" rel="noopener" class="lnk">▶ recording / message</a>\`:''}\${fileGrid(f.files)}</div>\`:''}
  </div>\`;
}
function openDetail(id){
  const d = DATA.dashboards.find(x => x.id === id); if (!d) return;
  const s = SMAP[d.state], cur = STATES.findIndex(x => x.id === d.state);
  const pct = Math.round((cur<=0?0:cur/(STATES.length-1))*100);
  const editable = d.source==='manual' && CFG.manualEnabled;
  const links = d.links || [], fbs = d.feedbacks || [];
  detailModal.innerHTML = \`
    <div class="dh" style="--cardc:\${s.color}">
      <div class="dh-main">
        <div class="dh-title">\${d.priorityLevel?\`<span class="pbadge">★ P\${d.priorityLevel}</span>\`:''}\${esc(d.name)}</div>
        <div class="dh-sub">\${ownerTag(d.owner)} \${d.customers.map(c=>clientTag(c)).join('')} \${d.isLive?'<span class="tag live">● Live on Munshot</span>':''}</div>
      </div>
      <div class="dh-actions">\${fbs.length?'<button class="btn ghost sm" id="dPdf" title="Generate the client-ready Build Update PDF from the feedbacks below">📑 Build update PDF</button>':''}\${(fbs.length&&CFG.manualEnabled)?'<button class="btn ghost sm" id="dMail" title="Email the Build Update summary via the Muns API">📧 Email update</button>':''}\${(editable && d.owner)?publishBtnHtml(d):''}\${editable?'<button class="btn sm" id="dEdit">✎ Edit</button>':''}\${CFG.manualEnabled?'<button class="btn ghost sm" id="dUpd">＋ Work update</button>':''}<button class="x" id="dX">×</button></div>
    </div>
    <div class="modal-body dbody">
      <div class="dprog"><div class="prog-top"><span class="prog-stage" style="color:\${s.color}">Stage \${cur+1}/\${STATES.length} · \${s.label}</span><span class="prog-pct">\${pct}%</span></div><div class="prog-track">\${STATES.map((x,i)=>\`<i class="seg \${i<=cur?'on':''}" style="\${i<=cur?'background:'+s.color:''}" title="\${i+1}. \${x.label}"></i>\`).join('')}</div></div>
      <div class="dgrid">
        \${factCell('Owner', d.owner ? esc(d.owner) : '—')}
        \${factCell('Client(s)', esc(d.customer))}
        \${factCell('Due date', d.dueDate?(/^\\d{4}-\\d{2}-\\d{2}$/.test(d.dueDate)?esc(fmtDue(d.dueDate)):esc(d.dueDate)):'—')}
        \${factCell('Priority', d.priorityLevel?('P'+d.priorityLevel):'—')}
        \${factCell('Live on Munshot', d.isLive?'Yes':'No')}
        \${factCell('Last updated', d.lastUpdated?esc(d.lastUpdated):'—')}
      </div>
      \${(d.brief||(d.briefFiles&&d.briefFiles.length)||(d.briefLinks&&d.briefLinks.length))?\`<div class="dsec brief-sec"><h4>📋 Brief — what to do</h4>\${d.brief?\`<div class="dnote big">\${esc(d.brief)}</div>\`:''}\${d.briefFiles&&d.briefFiles.length?\`<div class="thumbs">\${fileGrid(d.briefFiles)}</div>\`:''}\${d.briefLinks&&d.briefLinks.length?\`<div class="dlinks">\${d.briefLinks.map(l=>\`<a href="\${esc(l.url)}" target="_blank" rel="noopener" class="lnk">🔗 \${esc(l.label||'link')}</a>\`).join('')}</div>\`:''}</div>\`:''}
      <div class="dsec dnotes-sec"><div class="dnotes-head"><h4>📝 Working notes</h4>\${editable?'<span class="dnotes-hint">jot what to do here · delete when done</span>':''}</div>\${editable?\`<div class="dnote-add"><input id="dnoteInput" placeholder="Add a note — e.g. redo the P&amp;L chart colours…" autocomplete="off"><button class="btn sm" id="dnoteAdd">Add</button></div>\`:''}<div class="dnotes">\${(d.notes&&d.notes.length)?d.notes.slice().reverse().map(nt=>\`<div class="dnote-item"><span class="dnote-tx">\${esc(nt.text)}</span>\${editable?\`<button class="dnote-del" data-notedel="\${nt.ts}" title="Delete note">×</button>\`:''}</div>\`).join(''):'<div class="dnote muted">No notes yet — add what you want to do on this dashboard.</div>'}</div></div>
      \${d.manualStatus?\`<div class="dsec"><h4>Manual status</h4><div class="dnote big">\${esc(d.manualStatus)}</div></div>\`:''}
      \${d.status&&d.status!=='-'?\`<div class="dsec"><h4>Current status note</h4><div class="dnote">\${esc(d.status)}</div></div>\`:''}
      \${(d.requirements||(d.requirementFiles&&d.requirementFiles.length))?\`<div class="dsec"><h4>Original client requirement</h4>\${d.requirements?\`<div class="dnote">\${esc(d.requirements)}</div>\`:''}<div class="thumbs">\${fileGrid(d.requirementFiles)}</div></div>\`:''}
      \${links.length?\`<div class="dsec"><h4>YouTube Links</h4><div class="dlinks">\${links.map(l=>\`<a href="\${esc(l.url)}" target="_blank" rel="noopener" class="lnk">▶ \${esc(l.label)}</a>\`).join('')}</div></div>\`:''}
      \${(d.sections&&d.sections.length)?\`<div class="dsec"><h4>Sections\${d.publishedAt?' · <span style="color:var(--good)">published '+esc(String(d.publishedAt).slice(0,10))+'</span>':''}</h4>\${secViewHtml(d.sections,'')}</div>\`:''}
      \${(d.updates&&d.updates.length)?\`<div class="dsec"><h4>Work updates (\${d.updates.length})</h4>\${d.updates.slice().reverse().map(e=>{const st=SMAP[e.state];return \`<div class="fbv"><div class="fbv-top"><b>\${esc(e.date||'')}</b>\${st?\`<span class="fbcat" style="color:\${st.color};background:color-mix(in srgb, \${st.color} 14%, transparent)">\${esc(st.label)}</span>\`:''}</div>\${e.note?\`<div class="dnote">\${esc(e.note)}</div>\`:''}\${e.files&&e.files.length?\`<div class="thumbs">\${fileGrid(e.files)}</div>\`:''}</div>\`;}).join('')}</div>\`:''}
      <div class="dsec"><h4>Feedbacks (\${fbs.length})</h4>\${fbs.length?fbs.map(f=>fbView(d.id,f,editable)).join(''):'<div class="dnote muted">No feedback logged yet.</div>'}</div>
      \${d.improvement&&d.improvement!=='-'?\`<div class="dsec"><h4>Improvements</h4><div class="dnote">\${esc(d.improvement)}</div></div>\`:''}
      \${d.note?\`<div class="dsec"><h4>Notes</h4><div class="dnote">\${esc(d.note)}</div></div>\`:''}
    </div>\`;
  detailBg.classList.add('open');
  G('dX').onclick = closeDetail;
  if (editable) G('dEdit').onclick = () => { closeDetail(); openEdit(id); };
  const up = document.getElementById('dUpd'); if (up) up.onclick = () => { closeDetail(); openUpdate(id, d.name); };
  const pubBtn = detailModal.querySelector('[data-publish]'); if (pubBtn) pubBtn.onclick = () => publishDash(id, pubBtn);
  const pdfBtn = document.getElementById('dPdf'); if (pdfBtn) pdfBtn.onclick = () => genBuildUpdate(id, pdfBtn);
  const mailBtn = document.getElementById('dMail'); if (mailBtn) mailBtn.onclick = () => emailBuildUpdate(id, mailBtn);
  detailModal.querySelectorAll('[data-owner]').forEach(b => b.onclick = () => { closeDetail(); openOwner(b.dataset.owner); });
  detailModal.querySelectorAll('[data-customer]').forEach(b => b.onclick = () => { closeDetail(); openClient(b.dataset.customer); });
  detailModal.querySelectorAll('[data-fbtoggle]').forEach(el => el.onclick = async () => {
    const f = (d.feedbacks||[]).find(x => x.id === el.dataset.fbid); if (!f) return;
    const res = await api('POST','/api/feedback',{ id, fbId:el.dataset.fbid, implemented:!f.implemented });
    if (res.ok){ f.implemented = !f.implemented; openDetail(id); } else alert('Failed.');
  });
  // Working notes: add (input + Enter/button) and delete each.
  const dnAdd = document.getElementById('dnoteAdd');
  if (dnAdd){
    const addNote = async () => {
      const inp = document.getElementById('dnoteInput'); const text = (inp ? inp.value : '').trim();
      if (!text){ if (inp) inp.focus(); return; }
      const res = await api('POST', '/api/notes', { id, text });
      if (res.ok){ const j = await res.json().catch(()=>({})); if (!Array.isArray(d.notes)) d.notes = []; if (j.entry) d.notes.push(j.entry); openDetail(id); const ni = document.getElementById('dnoteInput'); if (ni) ni.focus(); }
      else { const e = await res.json().catch(()=>({})); alert('Could not add the note: ' + (e.error || res.status)); }
    };
    dnAdd.onclick = addNote;
    const inp = document.getElementById('dnoteInput'); if (inp) inp.onkeydown = (e) => { if (e.key === 'Enter'){ e.preventDefault(); addNote(); } };
  }
  detailModal.querySelectorAll('[data-notedel]').forEach(b => b.onclick = async () => {
    const ts = b.dataset.notedel;
    const res = await api('DELETE', \`/api/notes?id=\${encodeURIComponent(id)}&ts=\${ts}\`);
    if (res.ok){ d.notes = (d.notes||[]).filter(n => String(n.ts) !== String(ts)); openDetail(id); }
    else alert('Could not delete the note.');
  });
}

// ── Daily status update modal ──────────────────────────────────────────────
const updModalBg = document.getElementById('updModalBg');
const updModal = document.getElementById('updModal');
function closeUpd(){ updModalBg.classList.remove('open'); }
updModalBg.addEventListener('click', (e) => { if (e.target === updModalBg) closeUpd(); });
let updFiles = [];
function renderUpdFiles(){
  const box = G('u_files'); if (!box) return;
  box.innerHTML = updFiles.map(f => fileChip(f, true)).join('');
  box.querySelectorAll('[data-fx]').forEach(b => b.onclick = () => { updFiles = updFiles.filter(x => x.id !== b.dataset.fx); renderUpdFiles(); });
}
function openUpdate(id, name){
  const d = DATA.dashboards.find(x => x.id === id) || { updates: [], state: 'not_started', name };
  updFiles = [];
  const log = d.updates || [];
  const opts = STATES.map(x => \`<option value="\${x.id}">\${x.label}</option>\`).join('');
  const tl = log.slice().reverse().map(e => {
    const st = SMAP[e.state];
    return \`<div class="tl-item"><span class="tl-dot" style="background:\${st?st.color:'#ccc'}"></span><div class="tl-main"><div class="tl-date">\${esc(e.date||'')}\${st?' · '+st.label:''}</div>\${e.note?\`<div class="tl-note">\${esc(e.note)}</div>\`:''}\${e.files&&e.files.length?\`<div class="thumbs">\${fileGrid(e.files)}</div>\`:''}</div><button class="tl-del" data-ts="\${e.ts}" title="Remove">×</button></div>\`;
  }).join('') || '<div class="tl-date">No work updates yet — add your first below.</div>';
  updModal.innerHTML = \`
    <div class="modal-head"><div><h3>Work update</h3><div class="sub">\${esc(name||d.name||'')}</div></div><button class="x" id="updX">×</button></div>
    <div class="modal-body">
      <label>What work did you do? (note)</label>
      <textarea id="u_note" placeholder="e.g. Wired live data into the P&amp;L tab; refreshed the holdings table"></textarea>
      <label>Screenshots of the work (optional)</label>
      <div class="filebox" id="u_files"></div>
      <button class="btn ghost sm" id="u_upload" type="button">📎 Add screenshots</button>
      <label style="margin-top:14px">Stage (optional — updates the card)</label>
      <select id="u_state">\${opts}</select>
      <button class="btn" id="u_save" style="margin-top:14px">Post work update</button>
      <div class="timeline"><div class="label" style="margin-bottom:6px">History (\${log.length})</div>\${tl}</div>
    </div>\`;
  document.getElementById('u_state').value = d.state || 'not_started';
  renderUpdFiles();
  updModalBg.classList.add('open');
  document.getElementById('updX').onclick = closeUpd;
  document.getElementById('u_upload').onclick = async () => { const ups = await uploadFiles(); if (ups.length){ updFiles = updFiles.concat(ups); renderUpdFiles(); } };
  document.getElementById('u_save').onclick = async () => {
    const state = document.getElementById('u_state').value;
    const note = document.getElementById('u_note').value.trim();
    if (!note && !updFiles.length){ alert('Write what you did, or attach a screenshot.'); return; }
    const res = await api('POST', '/api/update', { id, state, note, files: updFiles });
    if (res.ok) location.reload(); else alert('Failed: '+((await res.json()).error||res.status));
  };
  updModal.querySelectorAll('.tl-del').forEach(b => b.onclick = async () => {
    if (!confirm('Remove this work update?')) return;
    const res = await api('DELETE', \`/api/update?id=\${encodeURIComponent(id)}&ts=\${b.dataset.ts}\`);
    if (res.ok) location.reload();
  });
}

// ── Tutorials: company how-to guides (everyone can read; admins add/edit) ────
let TUTORIALS = Array.isArray(DATA.tutorials) ? DATA.tutorials : [];
const tutModalBg = document.getElementById('tutModalBg');
const tutModal = document.getElementById('tutModal');
function closeTut(){ tutModalBg.classList.remove('open'); }
if (tutModalBg) tutModalBg.addEventListener('click', (e) => { if (e.target === tutModalBg) closeTut(); });
// Pull a YouTube video id out of common URL shapes → embed URL, else null.
function ytEmbed(url){
  const m = String(url||'').match(/(?:youtube\\.com\\/(?:watch\\?(?:.*&)?v=|embed\\/|shorts\\/|v\\/)|youtu\\.be\\/)([\\w-]{11})/);
  return m ? 'https://www.youtube.com/embed/' + m[1] : null;
}
function tutorialCard(t){
  const ed = CFG.manualEnabled;
  const embeds = (t.links||[]).map(l => ytEmbed(l.url)).filter(Boolean);
  const otherLinks = (t.links||[]).filter(l => !ytEmbed(l.url));
  const videoHtml = embeds.length ? \`<div class="tut-videos">\${embeds.map(u => \`<div class="tut-video"><iframe src="\${esc(u)}" title="tutorial video" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>\`).join('')}</div>\` : '';
  const linksHtml = otherLinks.length ? \`<div class="dlinks">\${otherLinks.map(l => \`<a href="\${esc(l.url)}" target="_blank" rel="noopener" class="lnk">🔗 \${esc(l.label||'link')}</a>\`).join('')}</div>\` : '';
  const filesHtml = (t.files&&t.files.length) ? \`<div class="thumbs">\${fileGrid(t.files)}</div>\` : '';
  const bodyHtml = t.body ? \`<div class="tut-body">\${esc(t.body)}</div>\` : '';
  const admin = ed ? \`<div class="tut-actions"><button class="btn ghost sm" data-tut-edit="\${esc(t.id)}">✎ Edit</button><button class="btn ghost sm" data-tut-del="\${esc(t.id)}">🗑 Delete</button></div>\` : '';
  return \`<div class="tut-card"><div class="tut-head"><h3>\${esc(t.title||'Untitled tutorial')}</h3>\${admin}</div>\${bodyHtml}\${videoHtml}\${filesHtml}\${linksHtml}</div>\`;
}
function renderTutorialTab(){
  const el = G('tab-tutorial'); if(!el) return;
  const ed = CFG.manualEnabled;
  const add = ed ? \`<button class="btn" id="tutAdd">＋ Add tutorial</button>\` : '';
  const cards = TUTORIALS.length ? TUTORIALS.map(tutorialCard).join('')
    : \`<div class="empty">No tutorials yet.\${ed?' Click “Add tutorial” to create the first guide for your team.':' Check back soon — your team will add guides here.'}</div>\`;
  el.innerHTML = \`<div class="tabhead"><h2>📚 Tutorials</h2><div class="sub">How we work — guides & walkthroughs for the team</div>\${add}</div><div class="tut-wrap">\${cards}</div>\`;
  if (ed){ const a=G('tutAdd'); if(a) a.onclick = () => openTutorial(null); }
  el.querySelectorAll('[data-tut-edit]').forEach(b => b.onclick = () => openTutorial(b.dataset.tutEdit));
  el.querySelectorAll('[data-tut-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this tutorial?')) return;
    const r = await api('POST','/api/tutorials',{ action:'delete', id:b.dataset.tutDel });
    if (r.ok){ TUTORIALS = TUTORIALS.filter(x=>x.id!==b.dataset.tutDel); renderTutorialTab(); } else alert('Could not delete.');
  });
}
let tutFiles = [];
function renderTutFiles(){
  const box = G('tut_files'); if(!box) return;
  box.innerHTML = tutFiles.map(f => fileChip(f, true)).join('');
  box.querySelectorAll('[data-fx]').forEach(b => b.onclick = () => { tutFiles = tutFiles.filter(x=>x.id!==b.dataset.fx); renderTutFiles(); });
}
function tutLinkRowHtml(label, url){
  return \`<div class="link-row"><input class="f_llabel" placeholder="label, e.g. Intro video" value="\${esc(label||'')}"><input class="f_lurl" placeholder="https://youtu.be/… or any link" value="\${esc(url||'')}"><button type="button" class="rm-client" title="Remove">×</button></div>\`;
}
function setTutLinks(arr){
  const box = G('tut_links'); if(!box) return;
  box.innerHTML = (arr||[]).map(l => tutLinkRowHtml(l.label, l.url)).join('');
  box.querySelectorAll('.rm-client').forEach(b => b.onclick = () => b.parentElement.remove());
}
function getTutLinks(){
  const box = G('tut_links'); if(!box) return [];
  return [...box.querySelectorAll('.link-row')].map(r => ({ label:r.querySelector('.f_llabel').value.trim(), url:r.querySelector('.f_lurl').value.trim() })).filter(l=>l.url);
}
function openTutorial(id){
  const t = id ? TUTORIALS.find(x=>x.id===id) : null;
  tutFiles = t && Array.isArray(t.files) ? t.files.slice() : [];
  tutModal.innerHTML = \`
    <div class="modal-head"><div><h3>\${t?'Edit tutorial':'Add tutorial'}</h3><div class="sub">Shown to everyone on the Tutorial tab</div></div><button class="x" id="tutX">×</button></div>
    <div class="modal-body">
      <label>Title</label>
      <input id="tut_title" placeholder="e.g. How we build a client dashboard" value="\${t?esc(t.title||''):''}">
      <label>Details / steps</label>
      <textarea id="tut_body" rows="6" placeholder="Explain the process, step by step…">\${t?esc(t.body||''):''}</textarea>
      <label>Video / reference links <span class="tmut" style="font-weight:400">(YouTube links play inline)</span></label>
      <div id="tut_links"></div>
      <button class="btn ghost sm" id="tut_addlink" type="button">+ add link</button>
      <label style="margin-top:14px">Attachments (images / PDFs)</label>
      <div class="filebox" id="tut_files"></div>
      <button class="btn ghost sm" id="tut_upload" type="button">📎 Add images / files</button>
      <button class="btn" id="tut_save" style="margin-top:16px">\${t?'Save changes':'Add tutorial'}</button>
      <span class="msg" id="tut_msg"></span>
    </div>\`;
  setTutLinks(t ? (t.links||[]) : [{label:'',url:''}]);
  renderTutFiles();
  tutModalBg.classList.add('open');
  G('tutX').onclick = closeTut;
  G('tut_addlink').onclick = () => { setTutLinks(getTutLinks().concat({label:'',url:''})); G('tut_links').lastElementChild.querySelector('.f_lurl').focus(); };
  G('tut_upload').onclick = async () => { const ups = await uploadFiles(); if (ups.length){ tutFiles = tutFiles.concat(ups); renderTutFiles(); } };
  G('tut_save').onclick = async () => {
    const msg = G('tut_msg');
    const payload = { title:G('tut_title').value.trim(), body:G('tut_body').value.trim(), links:getTutLinks(), files:tutFiles };
    if (!payload.title && !payload.body && !payload.links.length && !payload.files.length){ msg.className='msg err'; msg.textContent='Add a title or some content.'; return; }
    msg.className='msg'; msg.textContent='Saving…';
    const r = id ? await api('POST','/api/tutorials',{ action:'edit', id, ...payload }) : await api('POST','/api/tutorials',{ action:'add', ...payload });
    if (!r.ok){ const e=await r.json().catch(()=>({})); msg.className='msg err'; msg.textContent='Error: '+(e.error||r.status); return; }
    const j = await r.json().catch(()=>({}));
    if (id){ const i=TUTORIALS.findIndex(x=>x.id===id); if(i!==-1&&j.tutorial) TUTORIALS[i]=j.tutorial; }
    else if (j.tutorial){ TUTORIALS.push(j.tutorial); }
    closeTut(); renderTutorialTab();
  };
}

// Apply a profile click as a filter on the main board.
function applyFilter({ owner='', customer='', states=null }){
  closeDrawer();
  document.getElementById('owner').value = owner;
  document.getElementById('customer').value = customer;
  document.getElementById('q').value = '';
  prioOnly = false;
  stateFilter = new Set();
  let live = false;
  if (states){
    live = states.includes('__live');
    stateFilter = new Set(states.filter(x => x !== '__live'));
  }
  document.getElementById('liveonly').checked = live;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Tabs (Overview / Team / Clients) ───────────────────────────────────────
let activeTab = 'overview';
function switchTab(tab){
  activeTab = tab;
  // Remember the tab so an in-app reload (edit/assign/delete → location.reload)
  // returns here instead of snapping back to Overview. sessionStorage keeps it
  // for the tab's lifetime but resets to Overview on a fresh browser session.
  try { sessionStorage.setItem('trk_tab', tab); } catch(e){}
  document.querySelectorAll('#tabs .side-item').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  ['overview','mywork','team','clients','assign','unassigned','standup','tutorial'].forEach(t => { G('tab-'+t).hidden = (t !== tab); });
  if (tab === 'mywork') renderMyWorkTab();
  if (tab === 'team') renderTeamTab();
  if (tab === 'clients') renderClientsTab();
  if (tab === 'assign') renderAssignTab();
  if (tab === 'unassigned') renderUnassignedTab();
  if (tab === 'standup') renderStandupTab();
  if (tab === 'tutorial') renderTutorialTab();
}
// ── Unassigned tab: every dashboard with no owner, as cards ─────────────────
function renderUnassignedTab(){
  const el = G('tab-unassigned');
  const list = DATA.dashboards.filter(d => !d.owner).sort((a,b)=>(b.priorityLevel-a.priorityLevel)||((a.serial||1e9)-(b.serial||1e9)));
  const seg = list.length ? \`<div class="view-seg" id="unSeg"><button class="vseg \${unView==='table'?'on':''}" data-dview="table">▤ Table</button><button class="vseg \${unView==='cards'?'on':''}" data-dview="cards">▦ Cards</button></div>\` : '';
  const head = \`<div class="tabhead" style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap"><div><h2>🚩 Unassigned</h2><div class="sub">\${list.length} dashboard\${list.length!==1?'s':''} with no owner yet\${list.length&&CFG.manualEnabled?' · assign them in the Assign tab':''}</div></div>\${seg}</div>\`;
  let body;
  if (!list.length) body = '<div class="empty">Everything has an owner. 🎉<br>Tick “Leave unassigned” when adding a dashboard to keep one here.</div>';
  else {
    // Segregate by client — client name as a heading, its dashboards below.
    // Biggest client first, then alphabetical; "No client" last.
    const map = new Map();
    list.forEach(d => { const k = d.customer || 'No client'; if (!map.has(k)) map.set(k, []); map.get(k).push(d); });
    const groups = [...map.entries()].sort((a,b) => ((a[0]==='No client')-(b[0]==='No client')) || (b[1].length-a[1].length) || a[0].localeCompare(b[0]));
    let n = 0;
    if (unView === 'table'){
      const rows = groups.map(([client, ds]) => \`<tr class="tgroup"><td colspan="9">\${esc(client)}<span class="tgcount">\${ds.length}</span></td></tr>\` + ds.map(d => rowHtml(d, ++n)).join('')).join('');
      body = \`<div class="grid table-mode un-grid" id="unGrid">\${dashTable(rows)}</div>\`;
    } else {
      body = \`<div class="un-groups" id="unGrid">\${groups.map(([client, ds]) => \`<div class="un-group"><div class="un-ghead">\${esc(client)}<span class="un-gcount">\${ds.length}</span></div><div class="un-cards">\${ds.map(d => card(d, ++n)).join('')}</div></div>\`).join('')}</div>\`;
    }
  }
  el.innerHTML = head + body;
  bindCards();
  const ug = G('unGrid'); if (ug) ug.addEventListener('click', onCardGridClick);
  el.querySelectorAll('#unSeg .vseg').forEach(b => b.onclick = () => { unView = b.dataset.dview; localStorage.setItem('unView', unView); renderUnassignedTab(); });
}

// ── My Work: a teammate's deadline-first, customer-grouped personal view ─────
let myWho = '';
try { myWho = localStorage.getItem('myWho') || ''; } catch(e){}
// Whole days from today to an ISO due date (negative = overdue). null if not a date.
function daysUntil(iso){
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(iso || '')) return null;
  const t = new Date(); t.setHours(0,0,0,0);
  return Math.round((parseISO(iso) - t) / 86400000);
}
function dueChip(d){
  const n = daysUntil(d.dueDate);
  if (n === null) return d.dueDate ? \`<span class="due-chip">\${esc(d.dueDate)}</span>\` : '<span class="due-chip none">no deadline</span>';
  const lbl = n < 0 ? ('Overdue '+(-n)+'d') : n===0 ? 'Due today' : n===1 ? 'Due tomorrow' : ('Due in '+n+'d');
  const cls = n < 0 ? 'over' : n <= 7 ? 'soon' : 'ok';
  return \`<span class="due-chip \${cls}" title="Due \${esc(fmtDue(d.dueDate))}">\${lbl}</span>\`;
}
function renderMyWorkTab(){
  const el = G('tab-mywork'); if(!el) return;
  const people = DATA.owners.filter(Boolean);
  if (myWho && !people.includes(myWho)) myWho = '';
  const chips = people.length ? people.map(p => \`<button class="who-chip \${p===myWho?'on':''}" data-who="\${esc(p)}">\${avatar(p)}<span>\${esc(p)}</span></button>\`).join('') : '<span class="tmut">No team members yet — add them in the Team tab.</span>';
  const picker = \`<div class="who-row"><span class="who-lbl">Show work for</span><div class="who-chips">\${chips}</div></div>\`;
  let body = '';
  if (!myWho){
    body = '<div class="empty">Pick your name above to see your customers, what stage each dashboard is at, and what\\'s due.</div>';
  } else {
    const mine = DATA.dashboards.filter(d => d.owner === myWho);
    const active = mine.filter(d => d.state !== 'completed');
    const dated = active.filter(d => daysUntil(d.dueDate) !== null);
    const overdueN = dated.filter(d => daysUntil(d.dueDate) < 0).length;
    const soonN = dated.filter(d => { const n = daysUntil(d.dueDate); return n >= 0 && n <= 7; }).length;
    const urgent = dated.filter(d => daysUntil(d.dueDate) <= 7).sort((a,b) => daysUntil(a.dueDate) - daysUntil(b.dueDate));
    const clients = [...new Set(mine.flatMap(d => d.customers))];
    const kpi = \`<div class="mw-kpis">
      <div class="mw-kpi"><div class="mw-k-n">\${clients.length}</div><div class="mw-k-l">customer\${clients.length!==1?'s':''}</div></div>
      <div class="mw-kpi"><div class="mw-k-n">\${active.length}</div><div class="mw-k-l">active dashboard\${active.length!==1?'s':''}</div></div>
      <div class="mw-kpi \${soonN?'warn':''}"><div class="mw-k-n">\${soonN}</div><div class="mw-k-l">due this week</div></div>
      <div class="mw-kpi \${overdueN?'bad':''}"><div class="mw-k-n">\${overdueN}</div><div class="mw-k-l">overdue</div></div>
    </div>\`;
    const alertRows = urgent.map(d => { const s = SMAP[d.state] || {};
      return \`<div class="mw-alert \${daysUntil(d.dueDate)<0?'over':'soon'}" data-card="\${esc(d.id)}"><div class="mw-a-due">\${dueChip(d)}</div><div class="mw-a-main"><div class="mw-a-name">\${d.priorityLevel?'★ ':''}\${esc(d.name)}</div><div class="mw-a-meta">\${esc(d.customer||'—')} · <span style="color:\${s.color||'inherit'}">\${esc(s.label||d.state)}</span></div></div></div>\`;
    }).join('');
    const alerts = urgent.length ? \`<div class="section-t">⏰ Needs attention — due this week or overdue</div><div class="mw-alerts">\${alertRows}</div>\`
      : \`<div class="mw-clear">✅ Nothing overdue or due this week.\${dated.length?'':' Add a due date to a dashboard and it\\'ll show up here.'}</div>\`;
    // group all their dashboards by customer; customer with the nearest deadline first
    const map = new Map();
    mine.forEach(d => { (d.customers.length ? d.customers : ['No client']).forEach(c => { if (!map.has(c)) map.set(c, []); map.get(c).push(d); }); });
    const soonestOf = (ds) => Math.min(...ds.map(d => { const n = daysUntil(d.dueDate); return n === null ? 99999 : n; }));
    const groups = [...map.entries()].sort((a,b) => soonestOf(a[1]) - soonestOf(b[1]) || b[1].length - a[1].length || a[0].localeCompare(b[0]));
    const byClient = groups.map(([client, ds]) => {
      const rows = ds.slice().sort((a,b) => { const na = daysUntil(a.dueDate), nb = daysUntil(b.dueDate); return (na===null?99999:na) - (nb===null?99999:nb); }).map(d => {
        const s = SMAP[d.state] || {}; const cur = STATES.findIndex(x => x.id === d.state); const pct = Math.round((d.progress||0)*100);
        const nextStage = (cur >= 0 && cur < STATES.length-1) ? STATES[cur+1].label : null;
        return \`<div class="mw-row \${d.state==='completed'?'done':''}" data-card="\${esc(d.id)}"><div class="mw-r-main"><div class="mw-r-name">\${d.priorityLevel?'★ ':''}\${esc(d.name)}\${d.isLive?'<span class="tlive">● Live</span>':''}</div><div class="mw-r-stage"><span class="mw-dot" style="background:\${s.color||'#ccc'}"></span>\${esc(s.label||d.state)}\${nextStage?\` <span class="mw-next">→ next: \${esc(nextStage)}</span>\`:''}</div><div class="mw-r-track"><i style="width:\${pct}%;background:\${s.color||'#ccc'}"></i></div></div><div class="mw-r-due">\${dueChip(d)}</div></div>\`;
      }).join('');
      return \`<div class="mw-client"><div class="mw-ch"><span class="mw-cn">\${esc(client)}</span><span class="mw-cc">\${ds.length}</span></div>\${rows}</div>\`;
    }).join('') || '<div class="empty">No dashboards are assigned to you yet.</div>';
    body = kpi + alerts + '<div class="section-t" style="margin-top:22px">Your work by customer</div>' + byClient;
  }
  el.innerHTML = \`<div class="tabhead"><h2>🎯 My Work</h2><div class="sub">Your customers, what stage each dashboard is at, and what's due — so nothing slips</div></div><div class="mw-wrap">\${picker}\${body}</div>\`;
  el.querySelectorAll('[data-who]').forEach(b => b.onclick = () => { myWho = b.dataset.who; try{ localStorage.setItem('myWho', myWho); }catch(e){} renderMyWorkTab(); });
  el.querySelectorAll('[data-card]').forEach(c => c.onclick = () => openDetail(c.dataset.card));
}

// ── Workload-balanced auto-assignment ──────────────────────────────────────
// How much a dashboard weighs on its owner, by stage. A finished/late-stage
// dashboard barely counts, so whoever wrapped one up is "free" for a new one.
const LOAD_W = { not_started:1, ui_ux:1, data_integration:0.85, final_check:0.4, feedback_open:0.7, feedback_incorp:0.6, completed:0 };
const CAP = 3; // ~2-3 active dashboards is a full plate
function dashLoad(d){ if (d.isLive && d.state==='completed') return 0; return LOAD_W[d.state]!=null ? LOAD_W[d.state] : 1; }
function ownerLoad(name, overrides){
  let load=0, active=0;
  DATA.dashboards.forEach(d => { const own = (overrides && overrides[d.id]) || d.owner; if (own!==name) return; const w=dashLoad(d); if (w>0){ load+=w; active++; } });
  return { load, active };
}
function loadStatus(load, active){ if (active===0) return ['free','Free']; if (load>=CAP||active>=3) return ['full','Full']; if (load>=1.6) return ['busy','Busy']; return ['ok','Open']; }
function assignOwners(){ return DATA.owners.filter(Boolean); }
function unassignedDashboards(){ return DATA.dashboards.filter(d => !d.owner); }
function recommendOwner(overrides){
  const owners = assignOwners(); if (!owners.length) return null;
  let best=null, bestLoad=Infinity;
  owners.forEach(o => { const { load } = ownerLoad(o, overrides); if (load<bestLoad){ bestLoad=load; best=o; } });
  return best;
}
// Greedy least-loaded distribution of every unassigned dashboard.
function planAutoAssign(){
  const un = unassignedDashboards().slice().sort((a,b)=>(b.priorityLevel-a.priorityLevel) || ((a.serial||1e9)-(b.serial||1e9)));
  const overrides = {};
  un.forEach(d => { const o = recommendOwner(overrides); if (o) overrides[d.id]=o; });
  return overrides;
}
async function autoAssignAll(btn){
  if (!assignOwners().length){ alert('Add at least one team member first (Team tab).'); return; }
  const plan = planAutoAssign();
  if (!Object.keys(plan).length){ alert('No unassigned dashboards. 🎉'); return; }
  if (btn){ btn.disabled=true; btn.textContent='Assigning…'; }
  const r = await api('POST','/api/assign',{ assignments: plan });
  if (r.ok) location.reload(); else { alert('Assign failed.'); if(btn){ btn.disabled=false; btn.textContent='⚡ Auto-assign all'; } }
}
async function assignOne(id, owner){ const r = await api('POST','/api/assign',{ id, owner }); if (r.ok) location.reload(); else alert('Assign failed.'); }
function renderAssignTab(){
  const el = G('tab-assign'), owners = assignOwners(), un = unassignedDashboards();
  const board = owners.length ? owners.map(o => { const { load, active } = ownerLoad(o); const [cls,lab] = loadStatus(load,active); const pct = Math.min(100, load/CAP*100);
    return \`<div class="wl-card"><div class="wl-head">\${avatar(o)}<div class="wl-name">\${esc(o)}</div><span class="wl-pill \${cls}">\${lab}</span></div>
      <div class="wl-meta">\${active} active dashboard\${active!==1?'s':''}</div><div class="wl-bar"><i class="\${cls}" style="width:\${pct}%"></i></div></div>\`;
    }).join('') : '<div class="empty">No team members yet — add them in the Team tab.</div>';
  const rec = planAutoAssign();
  const queue = un.length ? un.slice().sort((a,b)=>(b.priorityLevel-a.priorityLevel)||((a.serial||1e9)-(b.serial||1e9))).map(d => {
    const opts = owners.map(o => \`<option \${o===rec[d.id]?'selected':''}>\${esc(o)}</option>\`).join('');
    const sel = CFG.manualEnabled ? \`<select class="asg-sel">\${opts}</select><button class="btn sm" data-assign="\${esc(d.id)}">Assign</button>\` : \`<span class="wl-pill ok">→ \${esc(rec[d.id]||'—')}</span>\`;
    return \`<div class="asg-row"><div><div class="dn">\${d.priorityLevel?'★ ':''}\${esc(d.name)}</div><div class="dmeta">\${esc(d.customer||'—')} · \${SMAP[d.state]?SMAP[d.state].label:esc(d.state)}</div></div><div class="asg-act">\${sel}</div></div>\`;
  }).join('') : '<div class="empty">Everything is assigned. 🎉</div>';
  el.innerHTML = \`<div class="tabhead"><h2>⚖️ Assign</h2><div class="sub">Workload-balanced · \${un.length} unassigned · least-loaded teammate gets the next one</div></div>
    <div class="asg-wrap">
    \${CFG.manualEnabled && un.length ? \`<div class="roster-add"><button class="btn" id="autoAll">⚡ Auto-assign all \${un.length}</button><span class="sub" style="align-self:center">picks the lightest plate for each dashboard</span></div>\` : ''}
    <div class="section-t">Team workload</div><div class="wl-grid">\${board}</div>
    <div class="section-t" style="margin-top:18px">Needs an owner</div>
    \${un.length ? \`<div class="asg-queue">\${queue}</div>\` : queue}
    </div>\`;
  if (CFG.manualEnabled){
    const aa = G('autoAll'); if (aa) aa.onclick = () => autoAssignAll(aa);
    el.querySelectorAll('[data-assign]').forEach(b => b.onclick = () => { const row=b.closest('.asg-row'), sel=row.querySelector('.asg-sel'); assignOne(b.dataset.assign, sel?sel.value:''); });
  }
}
// ── Standup / EOD: per-member daily to-dos ────────────────────────────────
let TASKS = Array.isArray(DATA.tasks) ? DATA.tasks : [];
let MEETING = (DATA.meeting && typeof DATA.meeting==='object') ? DATA.meeting : {};
function todayISO(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function shiftISO(iso, days){ const p=String(iso).split('-').map(Number); const d=new Date(p[0],p[1]-1,p[2]); d.setDate(d.getDate()+days); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function prettyDay(iso){ const p=String(iso).split('-').map(Number); const d=new Date(p[0],p[1]-1,p[2]); return d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}); }
function dashName(id){ const d=DATA.dashboards.find(x=>x.id===id); return d?d.name:''; }
let standupDate = todayISO();
// The daily views (Overview EOD + Standup) show only that day's standup tasks.
// Notetaker-imported items are a per-person backlog (they live in the To-do tab
// + the Tasks PDF), so they're excluded here to keep the daily views compact.
function tasksFor(date){ return TASKS.filter(t => t.date===date && t.source!=='notetaker'); }
function memberStats(list){ const done=list.filter(t=>t.done).length, total=list.length; return { done, total, pct: total?Math.round(done/total*100):0 }; }
function groupByMember(list){ const g={}; list.forEach(t=>{ (g[t.member]=g[t.member]||[]).push(t); }); return g; }

async function taskAdd(o){ const r=await api('POST','/api/tasks',{action:'add',...o}); if(r.ok){ const j=await r.json().catch(()=>({})); if(Array.isArray(j.tasks)) TASKS.push(...j.tasks); } return r; }
async function taskToggle(t, done){ const r=await api('POST','/api/tasks',{action:'toggle',id:t.id,done}); if(r.ok){ t.done=done; t.doneAt=done?new Date().toISOString():null; } return r; }
async function taskDelete(id){ const r=await api('POST','/api/tasks',{action:'delete',id}); if(r.ok){ TASKS=TASKS.filter(x=>x.id!==id); } return r; }
// Pull the Munshot-notetaker to-dos into the shared KV task store, then refresh
// the in-memory TASKS so the profile To-do lists + the Tasks PDF stay in sync.
async function syncTrackingTasks(){
  try {
    const r = await fetch('/api/tracking-tasks');
    if (!r.ok) return false;
    const j = await r.json().catch(()=>({}));
    if (j && Array.isArray(j.tasks)){ TASKS = j.tasks; return true; }
  } catch(e){}
  return false;
}
async function meetingSave(link){ const r=await api('POST','/api/meeting',{link}); if(r.ok){ MEETING.link=link; } return r; }

function renderEod(){
  const el = G('eod'); if(!el) return;
  const today = todayISO(), list = tasksFor(today), st = memberStats(list);
  const g = groupByMember(list);
  const members = Object.keys(g).sort((a,b)=>{ const sb=memberStats(g[b]), sa=memberStats(g[a]); return (sb.total-sa.total)||(sb.pct-sa.pct)||a.localeCompare(b); });
  const head = \`<div class="eod-head"><div><h3>📊 Today's work · EOD</h3><div class="eod-sub">\${prettyDay(today)} · what each member did today</div></div>\${list.length?\`<div class="eod-total">\${st.done}/\${st.total} done · \${st.pct}%</div>\`:''}</div>\`;
  if(!list.length){ el.innerHTML = head + \`<div class="eod-empty">No standup tasks logged today yet — open the <b>Standup</b> tab to add them, or let the meeting bot push them in.</div>\`; return; }
  const rows = members.map(m => { const items=g[m], ms=memberStats(items);
    const chips = items.filter(t=>t.done).map(t=>\`<span class="eod-chip done">✓ \${esc(t.text)}</span>\`).join('')
                + items.filter(t=>!t.done).map(t=>\`<span class="eod-chip">\${esc(t.text)}</span>\`).join('');
    return \`<div class="eod-row">
      <div class="eod-who">\${avatar(m)}<div class="eod-wn"><div class="eod-name">\${esc(m)}</div><div class="eod-mini">\${ms.done} of \${ms.total} done</div></div></div>
      <div class="eod-prog"><div class="eod-bar \${ms.pct===100?'full':''}"><i style="width:\${ms.pct}%"></i></div><span class="eod-pct">\${ms.pct}%</span></div>
      <div class="eod-tasks">\${chips}</div>
    </div>\`;
  }).join('');
  el.innerHTML = head + \`<div class="eod-list">\${rows}</div>\`;
}

function renderStandupTab(){
  const el = G('tab-standup'); if(!el) return;
  const ed = CFG.manualEnabled;
  // Roll-up of EVERY team member's to-do list (the same list shown on their
  // profile) — one section per person: full roster plus anyone who has tasks.
  const roster = (DATA.owners || []).slice();
  // Include anyone who has tasks but isn't on the roster (e.g. bot-imported), so
  // no one's to-dos are hidden; append those extras in alphabetical order.
  [...new Set(TASKS.map(t=>t.member).filter(m => m && !roster.includes(m)))].sort((a,b)=>a.localeCompare(b)).forEach(m => roster.push(m));
  const allTotal = TASKS.length, allDone = TASKS.filter(t=>t.done).length;
  const allPct = allTotal ? Math.round(allDone/allTotal*100) : 0;
  const meetingCard = \`<div class="mtg-card"><div class="mtg-l"><div class="mtg-ico">🎥</div><div><div class="mtg-t">Team meeting</div><div class="mtg-s">\${MEETING.link?esc(MEETING.link):'No meeting link set yet'}</div></div></div>
    <div class="mtg-r">\${MEETING.link?\`<a class="btn sm" href="\${esc(MEETING.link)}" target="_blank" rel="noopener">Join ↗</a>\`:''}\${CFG.manualEnabled?\`<button class="btn ghost sm" id="mtgEdit">\${MEETING.link?'Edit link':'+ Add link'}</button>\`:''}</div></div>\`;
  const overall = allTotal ? \`<div class="su-overall"><div class="su-overall-top"><span>Whole team · to-dos</span><span>\${allDone}/\${allTotal} done · \${allPct}%</span></div><div class="su-bar"><i style="width:\${allPct}%"></i></div></div>\` : '';
  const taskHtml = (t) => \`<div class="su-task \${t.done?'done':''}"><label class="su-check"><input type="checkbox" \${t.done?'checked':''} data-task="\${esc(t.id)}"><span class="su-box"></span></label>
      <div class="su-body"><div class="su-txt">\${esc(t.text)}</div>\${(t.dashboardName||t.dashboardId)?\`<span class="su-dash">\${esc(t.dashboardName||dashName(t.dashboardId))}</span>\`:''}</div>
      \${ed?\`<button class="su-del" data-taskdel="\${esc(t.id)}" title="Remove">×</button>\`:''}</div>\`;
  const cards = roster.map(name => {
    const mine = TASKS.filter(t => t.member === name);
    const pend = mine.filter(t=>!t.done), done = mine.filter(t=>t.done);
    const ms = memberStats(mine);
    const listHtml = mine.length ? pend.concat(done).map(taskHtml).join('') : '<div class="su-empty-m">No to-dos yet.</div>';
    const composer = ed ? \`<div class="su-madd"><input class="su-in su-grow su-addin" data-add="\${esc(name)}" placeholder="Add a to-do for \${esc(name)}…" autocomplete="off"><button class="btn sm" data-addbtn="\${esc(name)}">+ Add</button></div>\` : '';
    const stat = pend.length ? (pend.length+' to-do'+(pend.length!==1?'s':'')) : (ms.total?'all done ✓':'no to-dos');
    return \`<div class="su-member"><div class="su-mhead">\${avatar(name)}<div class="su-mname">\${esc(name)}</div><div class="su-mstat \${pend.length===0&&ms.total?'full':''}">\${stat}</div></div>
      \${ms.total?\`<div class="su-mbar"><i style="width:\${ms.pct}%"></i></div>\`:''}
      <div class="su-tasks">\${listHtml}</div>\${composer}</div>\`;
  }).join('');
  const board = roster.length ? \`<div class="su-grid">\${cards}</div>\` : '<div class="empty">No team members yet — add them on the Team tab.</div>';
  const botHelp = ed ? \`<details class="su-bot"><summary>🤖 Connect your meeting-transcription bot</summary><div class="su-bot-body">After the bot transcribes the meeting, have it POST each person's generated to-dos to <code>/api/tasks</code>:<pre>POST /api/tasks
{
  "action": "add",
  "tasks": [
    { "member": "Naval",   "text": "Fix the P&L tab on the Beas dashboard" },
    { "member": "Aashita", "text": "Implement client change #3" }
  ]
}</pre>\${CFG.editProtected?'Include the header <code>x-edit-token: YOUR_TOKEN</code>.':'No auth header is needed (no edit token is configured).'}</div></details>\` : '';
  el.innerHTML = \`<div class="tabhead"><h2>🎙️ Daily Standup</h2><div class="sub">Every team member's to-do list in one place</div></div>
    \${meetingCard}\${overall}\${board}\${botHelp}\`;
  // wire
  const me=G('mtgEdit'); if(me) me.onclick = async () => { const v=prompt('Team meeting link (Google Meet / Zoom):', MEETING.link||''); if(v===null) return; const r=await meetingSave(v.trim()); if(r.ok) renderStandupTab(); else alert('Could not save the link.'); };
  el.querySelectorAll('[data-task]').forEach(cb => cb.onchange = async () => { const t=TASKS.find(x=>x.id===cb.dataset.task); if(!t) return; const want=cb.checked; const r=await taskToggle(t, want); if(!r.ok){ cb.checked=!want; alert('Could not update.'); return; } renderStandupTab(); renderEod(); });
  el.querySelectorAll('[data-taskdel]').forEach(b => b.onclick = async () => { if(!confirm('Remove this to-do?')) return; const r=await taskDelete(b.dataset.taskdel); if(!r.ok){ alert('Could not remove.'); return; } renderStandupTab(); renderEod(); });
  el.querySelectorAll('[data-addbtn]').forEach(btn => { const name=btn.dataset.addbtn; const box=btn.closest('.su-madd'); const inp=box?box.querySelector('.su-addin'):null; const doAdd=async () => { const text=(inp?inp.value:'').trim(); if(!text){ if(inp) inp.focus(); return; } const r=await taskAdd({ member:name, text, source:'manual' }); if(r.ok){ renderStandupTab(); renderEod(); } else alert('Could not add the to-do.'); }; btn.onclick=doAdd; if(inp) inp.onkeydown=(e)=>{ if(e.key==='Enter'){ e.preventDefault(); doAdd(); } }; });
}

document.querySelectorAll('#tabs .side-item').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
// Restore the last-open tab after an in-app reload (see switchTab).
try { const _t = sessionStorage.getItem('trk_tab'); if (_t && _t !== 'overview' && G('tab-'+_t)) switchTab(_t); } catch(e){}

// Click a card → open its detail modal (buttons/chips handled first).
function onCardGridClick(e){
  const p = e.target.closest('[data-prio]'); if (p){ togglePriority(p.dataset.prio); return; }
  const pub = e.target.closest('[data-publish]'); if (pub){ publishDash(pub.dataset.publish, pub); return; }
  const u = e.target.closest('[data-update]'); if (u){ openUpdate(u.dataset.update, u.dataset.name); return; }
  const ed = e.target.closest('[data-edit]'); if (ed){ openEdit(ed.dataset.edit); return; }
  if (e.target.closest('[data-setstage]') || e.target.closest('[data-del]')) return;
  const o = e.target.closest('[data-owner]'); if (o){ openOwner(o.dataset.owner); return; }
  const c = e.target.closest('[data-customer]'); if (c){ openClient(c.dataset.customer); return; }
  const a = e.target.closest('a'); if (a) return; // let links work
  const card = e.target.closest('[data-card]'); if (card){ openDetail(card.dataset.card); }
}
document.getElementById('grid').addEventListener('click', onCardGridClick);
async function setPriority(id, level){
  const d = DATA.dashboards.find(x => x.id === id); if (!d) return;
  const res = await api('POST', '/api/priority', { id, level });
  if (res.ok){ d.priorityLevel = level||0; d.priority = d.priorityLevel>0; DATA.priorityCount = DATA.dashboards.filter(x => x.priority).length; render(); }
  else alert('Could not update priority (need edit access?).');
}
// Star quick-toggle: off → P1, any level → cleared. Exact rank is set in Edit.
function togglePriority(id){
  const d = DATA.dashboards.find(x => x.id === id); if (!d) return;
  setPriority(id, d.priorityLevel ? 0 : 1);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape'){ closeUpd(); closeDetail(); if (typeof closeForm==='function') closeForm(); } });

// ── Export to Excel (styled, multi-sheet .xlsx via ExcelJS) ────────────────
function loadScript(src){
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('load failed: '+src));
    document.head.appendChild(s);
  });
}
async function loadExcelJS(){
  if (window.ExcelJS) return;
  const cdns = [
    'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js',
    'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js',
  ];
  for (const url of cdns){ try { await loadScript(url); if (window.ExcelJS) return; } catch(e){} }
  throw new Error('Could not load the Excel library (network blocked?).');
}

// ── Build-Update PDF deck (client report for the next meeting) ──────────────
async function loadPdfLib(){
  if (!window.PDFLib){
    const cdns = [
      'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
      'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
    ];
    for (const url of cdns){ try { await loadScript(url); if (window.PDFLib) break; } catch(e){} }
    if (!window.PDFLib) throw new Error('Could not load the PDF library (network blocked?).');
  }
  // fontkit lets us embed the Didone fonts — optional (deck falls back to Times).
  if (!window.fontkit){
    const fk = [
      'https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js',
      'https://unpkg.com/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js',
    ];
    for (const url of fk){ try { await loadScript(url); if (window.fontkit) break; } catch(e){} }
  }
}
function downloadBytes(bytes, filename, type){
  const blob = new Blob([bytes], { type }); const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function fetchImg(f){
  try {
    const r = await fetch(f.url || ('/api/file?id='+f.id)); const buf = new Uint8Array(await r.arrayBuffer());
    const isPng = (f.type||'').includes('png') || (buf[0]===0x89 && buf[1]===0x50);
    const isJpg = (f.type||'').includes('jpeg') || (f.type||'').includes('jpg') || (buf[0]===0xFF && buf[1]===0xD8);
    if (!isPng && !isJpg) return null;
    return { bytes: buf, png: isPng };
  } catch(e){ return null; }
}
// Elegant "Weekly Update" deck (cream / Didone serif / dark screenshot panel) —
// matches the Tybourne reference format exactly. Embeds Playfair Display via
// fontkit; falls back to Times if the fonts can't be fetched.
async function buildDeck(PDFLib, report){
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.create();
  let SER, ITA;
  try {
    if (!window.fontkit) throw new Error('no fontkit');
    doc.registerFontkit(window.fontkit);
    const fonts = await loadFonts();
    SER = await doc.embedFont(fonts.serif, { subset:true });
    ITA = await doc.embedFont(fonts.serifItalic, { subset:true });
  } catch(e){ SER = await doc.embedFont(StandardFonts.TimesRomanBold); ITA = await doc.embedFont(StandardFonts.TimesRomanItalic); }
  const SAN = await doc.embedFont(StandardFonts.Helvetica);
  const SANB = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 960, H = 540, M = 64;
  const C = (h) => rgb(parseInt(h.slice(1,3),16)/255, parseInt(h.slice(3,5),16)/255, parseInt(h.slice(5,7),16)/255);
  const CREAM='#f0e9d8', INK='#1a1712', GOLD='#a87f2e', DARK='#1c1813', MUTE='#8c8472', LINE='#d8cfb4';
  const san = (s) => String(s==null?'':s).replace(/[‘’′]/g,"'").replace(/[“”″]/g,'"').replace(/[–—]/g,'-').replace(/…/g,'...').replace(/[^\\x20-\\x7E]/g,'');
  const sp  = (s) => san(s).toUpperCase().split('').join(' ');
  const D = (pg,t,x,y,f,s,c) => pg.drawText(san(t), { x, y, size:s, font:f, color:C(c) });
  const tw = (t,f,s) => f.widthOfTextAtSize(san(t), s);
  const wrap = (t,f,s,mw) => { const w = san(t).split(/\\s+/).filter(Boolean), L=[]; let c=''; for (const x of w){ const nn = c?c+' '+x:x; if (f.widthOfTextAtSize(nn,s) > mw && c){ L.push(c); c = x; } else c = nn; } if (c) L.push(c); return L; };
  function badges(pg, client){
    const by = H-94, bs = 44;
    pg.drawRectangle({ x:M, y:by, width:bs, height:bs, borderColor:C(LINE), borderWidth:1.2, color:C(CREAM) });
    const ini = (client||'C').split(/\\s+/).map(w => w[0]||'').join('').slice(0,2).toUpperCase();
    D(pg, ini, M+bs/2-tw(ini,SER,17)/2, by+bs/2-6, SER, 17, INK);
    D(pg, 'x', W/2-3, by+bs/2-5, SAN, 12, MUTE);
    pg.drawRectangle({ x:W-M-bs, y:by, width:bs, height:bs, color:C(DARK) });
    D(pg, 'm', W-M-bs/2-tw('m',ITA,22)/2, by+bs/2-7, ITA, 22, '#c3851a');
  }
  function splitHead(lead, emph){
    lead = san(lead||''); emph = san(emph||'');
    if (!emph && /\\s-\\s/.test(lead)){ const i = lead.indexOf(' - '); emph = lead.slice(i+3); lead = lead.slice(0,i); }
    return { lead: lead.trim(), emph: emph.trim() };
  }
  function drawHead(pg, lead, emph, size, x, yTop){
    const maxW = W - M - x, lh = size*1.06, words = [];
    san(lead).split(/\\s+/).filter(Boolean).forEach(w => words.push({ w, f:SER, c:INK }));
    san(emph).split(/\\s+/).filter(Boolean).forEach(w => words.push({ w, f:ITA, c:GOLD }));
    const lines = [[]]; let cw = 0;
    for (const t of words){ const ww = t.f.widthOfTextAtSize(t.w+' ', size);
      if (cw+ww > maxW && lines[lines.length-1].length){ lines.push([]); cw = 0; }
      lines[lines.length-1].push(t); cw += ww; }
    lines.slice(0,2).forEach((ln, li) => { let cx = x; const y = yTop - li*lh;
      ln.forEach(t => { D(pg, t.w, cx, y, t.f, size, t.c); cx += t.f.widthOfTextAtSize(t.w+' ', size); }); });
  }
  function footer(pg, leftTxt, rightTxt){
    D(pg, sp(leftTxt), M, 36, SAN, 7, MUTE);
    pg.drawCircle({ x:M+tw(sp(leftTxt),SAN,7)+10, y:39, size:1.5, color:C(GOLD) });
    D(pg, sp(rightTxt), W-M-tw(sp(rightTxt),SAN,7), 36, SAN, 7, MUTE);
  }
  // COVER
  let pg = doc.addPage([W,H]); pg.drawRectangle({ x:0, y:0, width:W, height:H, color:C(CREAM) });
  badges(pg, report.client);
  D(pg, sp('The Weekly'), M, H-152, SANB, 8, GOLD);
  D(pg, report.titleTop||'Weekly', M-4, H-250, SER, 92, INK);
  D(pg, report.titleBot||'Update', M-2, H-330, ITA, 92, GOLD);
  pg.drawRectangle({ x:M, y:H-372, width:70, height:2, color:C(GOLD) });
  D(pg, 'Week of '+(report.dateLong||report.date||''), M, H-405, ITA, 17, INK);
  D(pg, sp('Prepared for '+(report.client||'the client')), M, 50, SAN, 7.5, MUTE);
  D(pg, sp('By Munshot AI'), W-M-tw(sp('By Munshot AI'),SAN,7.5), 50, SAN, 7.5, MUTE);
  // CONTENT — one page per screenshot
  const items = report.items || [], total = String(items.length+2).padStart(2,'0');
  for (let idx=0; idx<items.length; idx++){
    const it = items[idx];
    pg = doc.addPage([W,H]); pg.drawRectangle({ x:0, y:0, width:W, height:H, color:C(CREAM) });
    const nn = String(idx+1).padStart(2,'0');
    D(pg, sp('Highlights'), M, H-42, SAN, 7, MUTE);
    pg.drawCircle({ x:M+tw(sp('Highlights'),SAN,7)+9, y:H-39, size:1.5, color:C(GOLD) });
    D(pg, nn, M+tw(sp('Highlights'),SAN,7)+18, H-42, SAN, 7, GOLD);
    const dts = sp(report.dateShort||report.date||'');
    D(pg, dts, W-M-tw(dts,SAN,7), H-42, SAN, 7, MUTE);
    const ey = H-84;
    if (it.category) D(pg, sp(it.category), M, ey, SANB, 7.5, GOLD);
    const sh = splitHead(it.headline, it.emph);
    // HEADER — the change title, big serif (up to 2 lines).
    const headY = it.category ? ey-38 : H-104;
    const headLines = wrap(sh.lead || 'Change', SER, 28, W-2*M).slice(0,2);
    headLines.forEach((ln,i) => D(pg, ln, M, headY - i*30, SER, 28, INK));
    let ty = headY - (headLines.length-1)*30 - 26;   // just under the header
    const imgs = (it.imgs||[]).filter(g => g && g.bytes).slice(0,3), n = imgs.length;
    // DESCRIPTION — full text under the header on single/no-screenshot pages
    // (multi-screenshot pages carry their own per-shot captions instead).
    if (n<=1 && sh.emph.trim()){
      const dl = wrap(sh.emph, ITA, 13, W-2*M).slice(0,5);
      dl.forEach((ln,i) => D(pg, ln, M, ty - i*17, ITA, 13, GOLD));
      ty -= dl.length*17 + 4;
    }
    const panelBot = 70, panelX = M-24, panelW = W - panelX - 18;
    const panelTop = Math.max(panelBot+150, Math.min(H-176, ty - 10));
    const panelH = panelTop - panelBot;
    pg.drawRectangle({ x:panelX, y:panelBot, width:panelW, height:panelH, color:C(DARK) });
    if (n){
      const pad = n>1 ? 28 : 40, botMargin = 14, capSize = n>2 ? 8 : 9, lineH = capSize + 3;
      const slotW = (panelW - pad*(n+1)) / n;
      // Wrap each caption to its slot (no truncation) so the full text shows.
      const wrapC = (t, mw) => { const w = san(t).split(/\\s+/), L = []; let c=''; for (const x of w){ const nn = c?c+' '+x:x; if (SAN.widthOfTextAtSize(nn, capSize) > mw && c){ L.push(c); c = x; } else c = nn; } if (c) L.push(c); return L; };
      const capLines = imgs.map(g => (n>1 && (g.caption||'').trim()) ? wrapC(g.caption, slotW-4).slice(0,4) : []);
      const maxCap = Math.max(0, ...capLines.map(l => l.length));
      const capH = maxCap ? maxCap*lineH + 6 : 0;
      const imgBot = panelBot + botMargin + capH + (capH?10:0), availH = (panelTop - pad) - imgBot;
      for (let k=0;k<n;k++){ try {
        const g = imgs[k], slotX = panelX + pad + k*(slotW+pad);
        const im = g.png===false ? await doc.embedJpg(g.bytes) : await doc.embedPng(g.bytes);
        let dw = im.width, dh = im.height; const r = Math.min(slotW/dw, availH/dh); dw*=r; dh*=r;
        const cx = slotX + (slotW-dw)/2, cy = imgBot + (availH-dh)/2;
        pg.drawRectangle({ x:cx-5, y:cy-5, width:dw+10, height:dh+10, color:rgb(1,1,1) });
        pg.drawImage(im, { x:cx, y:cy, width:dw, height:dh });
        const first = panelBot + botMargin + capH - lineH + 1;
        capLines[k].forEach((ln, li) => { const cw = Math.min(SAN.widthOfTextAtSize(ln, capSize), slotW); D(pg, ln, slotX + (slotW-cw)/2, first - li*lineH, SAN, capSize, '#e7dec8'); });
      } catch(e){} }
    }
    footer(pg, report.client||'Client', nn+' / '+total);
  }
  // CLOSING
  pg = doc.addPage([W,H]); pg.drawRectangle({ x:0, y:0, width:W, height:H, color:C(CREAM) });
  badges(pg, report.client);
  D(pg, sp('- Thank you -'), M, H-256, SANB, 8, GOLD);
  D(pg, report.closeTop||'Until ', M-4, H-340, SER, 84, INK);
  D(pg, report.closeEmph||'next', M-4+tw(report.closeTop||'Until ',SER,84), H-340, ITA, 84, GOLD);
  D(pg, report.closeBot||'week.', M-4, H-420, SER, 84, INK);
  D(pg, sp('Prepared by Munshot AI for '+(report.client||'the client')), M, 50, SAN, 7.5, MUTE);
  const nu = 'Next update - '+(report.nextUpdate||'next week');
  D(pg, nu, W-M-tw(nu,ITA,14), 50, ITA, 14, INK);
  return await doc.save();
}
// Fetch + cache the Didone fonts (served same-origin by /api/font, edge-cached).
let _deckFonts = null;
async function loadFonts(){
  if (_deckFonts) return _deckFonts;
  const get = async (f) => new Uint8Array(await (await fetch('/api/font?f='+f)).arrayBuffer());
  _deckFonts = { serif: await get('serif'), serifItalic: await get('italic') };
  return _deckFonts;
}
// Map a dashboard's feedbacks → deck items. Screenshots are grouped
// f.perPage-at-a-time (1/2/3 per page). One image → its caption is the gold
// emphasis; multiple → each screenshot shows its own caption under it.
async function buildItems(fbs){
  const items = [];
  for (const f of (fbs||[])){
    const firstSent = String(f.text||'').split(/(?<=[.!?])\\s/)[0] || String(f.text||'');
    const files = (f.files||[]);
    if (!files.length){ items.push({ category:f.category||'', headline:f.label||'Change', emph:firstSent, imgs:[] }); continue; }
    const per = Math.min(3, Math.max(1, f.perPage||1));
    for (let i=0;i<files.length;i+=per){
      const group = files.slice(i, i+per), imgs = [];
      for (const file of group){ const im = await fetchImg(file); imgs.push({ bytes: im?im.bytes:null, png: im?im.png:true, caption: file.caption||'' }); }
      items.push({ category:f.category||'',
        headline: (per===1 ? (group[0].header||f.label) : (group[0].header||f.label)) || 'Change',
        emph: per===1 ? (group[0].caption||firstSent||'') : firstSent, imgs });
    }
  }
  return items;
}
function makeReport(d, items){
  const t = new Date(), nx = new Date(t.getTime()+7*864e5);
  const longD = (dt) => dt.toLocaleDateString('en-US',{ month:'long', day:'numeric', year:'numeric' });
  return { client: d.customer||'Client', date: t.toISOString().slice(0,10),
    dateLong: longD(t), dateShort: t.toLocaleDateString('en-GB',{ day:'numeric', month:'long', year:'numeric' }),
    titleTop:'Weekly', titleBot:'Update', closeTop:'Until ', closeEmph:'next', closeBot:'week.', nextUpdate: longD(nx), items };
}
async function genBuildUpdate(id, btn){
  const d = DATA.dashboards.find(x => x.id === id); if (!d) return;
  const fbs = d.feedbacks || [];
  if (!fbs.length){ alert('Add at least one feedback/change (with screenshots) first.'); return; }
  if (btn){ btn.disabled = true; btn.textContent = 'Generating…'; }
  try {
    await loadPdfLib();
    const report = makeReport(d, await buildItems(fbs));
    const bytes = await buildDeck(window.PDFLib, report);
    const fname = (d.name||'dashboard').replace(/[^a-z0-9]+/gi,'-').toLowerCase() + '-build-update.pdf';
    downloadBytes(bytes, fname, 'application/pdf');
    // Auto-queue this PDF for tonight's single 8pm digest to the founder.
    let queued = false;
    try {
      const up = await api('POST','/api/file',{ name:fname, type:'application/pdf', data: bytesToB64(new Uint8Array(bytes)) });
      if (up.ok){ const j = await up.json(); const url = location.origin + (j.url || ('/api/file?id='+j.id));
        const q = await api('POST','/api/digest',{ action:'enqueue', item:{ dashboardId:d.id, name:(d.name||'Build Update'), client:(d.customer||''), count:fbs.length, url } });
        queued = q.ok; }
    } catch(e){}
    if (btn && queued){ btn.textContent = 'Saved · queued for Wed digest ✓'; setTimeout(()=>{ if(btn) btn.textContent='📑 Build update PDF'; }, 2200); }
  } catch (e){ alert(e.message || 'Could not build the PDF.'); }
  finally { if (btn){ btn.disabled = false; if (btn.textContent==='Generating…') btn.textContent = '📑 Build update PDF'; } }
}
// Manually fire tonight's digest now — used to test the 8pm flow without waiting.
async function sendDigestNow(btn){
  if (btn){ btn.disabled = true; const o=btn.textContent; btn.dataset.o=o; btn.textContent='Sending…'; }
  try {
    const r = await api('POST','/api/digest',{ action:'send' });
    const j = await r.json().catch(()=>({}));
    if (j.skipped==='empty') alert('Nothing queued.\\n\\nGenerate a Build Update PDF first — every PDF auto-queues for the weekly founder email.');
    else if (j.ok) alert('✅ Sent the PDF digest ('+j.count+' update'+(j.count===1?'':'s')+') to '+j.to+'.');
    else alert('Digest send failed:\\n'+String(j.error||JSON.stringify(j.results||j)).slice(0,300));
  } catch(e){ alert('Digest error: '+e.message); }
  finally { if (btn){ btn.disabled=false; btn.textContent=btn.dataset.o||'Send now'; } }
}
// Manually fire the daily status email now — to test it without waiting for 9pm.
async function sendDailyNow(btn){
  if (btn){ btn.disabled = true; const o=btn.textContent; btn.dataset.o=o; btn.textContent='Sending…'; }
  try {
    const r = await api('POST','/api/digest',{ action:'daily' });
    const j = await r.json().catch(()=>({}));
    if (j.skipped==='no-feedback') alert('No dashboards have feedback yet — add some client changes (feedbacks) first, then the daily status will have something to report.');
    else if (j.ok) alert('✅ Sent the daily status to '+j.to+'.\\n\\n+'+(j.doneToday||0)+' done since last · '+(j.pending||0)+' pending.');
    else alert('Daily status failed:\\n'+String(j.error||JSON.stringify(j.results||j)).slice(0,300));
  } catch(e){ alert('Daily status error: '+e.message); }
  finally { if (btn){ btn.disabled=false; btn.textContent=btn.dataset.o||'Send now'; } }
}
// Plain-text summary of a dashboard's changes (the raw email API sends text only).
function buildUpdateText(d){
  const fbs = d.feedbacks || [], impl = fbs.filter(f => f.implemented).length;
  const L = [];
  L.push(d.name + ' — Build Update');
  L.push('Client: ' + (d.customer || '-') + '   ·   Owner: ' + d.owner);
  L.push(fbs.length + ' changes  ·  ' + impl + ' implemented  ·  ' + (fbs.length - impl) + ' pending');
  L.push('');
  fbs.forEach((f, i) => {
    L.push((i+1) + '. [' + (f.implemented ? 'IMPLEMENTED' : 'PENDING') + '] ' + (f.category ? '['+f.category+'] ' : '') + (f.label || 'Change'));
    if (f.text) L.push('    ' + f.text);
    if (f.link) L.push('    link: ' + f.link);
    (f.files||[]).forEach(fl => L.push('    file: ' + location.origin + (fl.url || ('/api/file?id='+fl.id))));
    L.push('');
  });
  L.push('— Munshot Tracker');
  return L.join('\\n');
}
// Rich HTML email — header, each change as a card with badge + inline screenshots.
function buildUpdateHtml(d, pdfUrl){
  const fbs = d.feedbacks || [], impl = fbs.filter(f => f.implemented).length, O = location.origin;
  const badge = ok => '<span style="font:700 11px Arial;color:'+(ok?'#15803d':'#b91c1c')+';background:'+(ok?'#dcfce7':'#fee2e2')+';border-radius:999px;padding:3px 10px;white-space:nowrap">'+(ok?'IMPLEMENTED':'PENDING')+'</span>';
  const cta = pdfUrl ? '<div style="text-align:center;margin:2px 0 18px"><a href="'+esc(pdfUrl)+'" style="display:inline-block;background:#4f46e5;color:#fff;font:700 14px Arial;text-decoration:none;padding:13px 26px;border-radius:10px">📑 Open the full Build Update (PDF)</a></div>' : '';
  const cards = fbs.map((f,i) => {
    const imgs = (f.files||[]).filter(x => (x.type||'').startsWith('image/'))
      .map(x => '<img src="'+O+esc(x.url||('/api/file?id='+x.id))+'" alt="" style="max-width:100%;border:1px solid #e5e8ef;border-radius:8px;margin:8px 0 0;display:block">').join('');
    return '<div style="border:1px solid #e5e8ef;border-radius:12px;padding:16px;margin:0 0 14px">'
      + (f.category?'<div style="font:800 10px Arial;letter-spacing:.06em;text-transform:uppercase;color:#4f46e5">'+esc(f.category)+'</div>':'')
      + '<div style="font:700 16px Arial;color:#141925;margin:4px 0 8px">'+esc(f.label||('Change '+(i+1)))+' &nbsp; '+badge(f.implemented)+'</div>'
      + (f.text?'<div style="font:14px/1.55 Arial;color:#48505f">'+esc(f.text)+'</div>':'')
      + (f.link?'<div style="margin-top:8px"><a href="'+esc(f.link)+'" style="color:#4f46e5;font:13px Arial;text-decoration:none">▶ recording / message</a></div>':'')
      + imgs + '</div>';
  }).join('');
  return '<div style="max-width:640px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;color:#141925">'
    + '<div style="background:#4f46e5;background:linear-gradient(135deg,#4f46e5,#9333ea);color:#fff;padding:22px;border-radius:14px 14px 0 0">'
      + '<div style="font:800 17px Arial">◆ Munshot</div>'
      + '<div style="font:800 21px Arial;margin-top:8px">'+esc(d.name)+' — Build Update</div>'
      + '<div style="font:13px Arial;opacity:.92;margin-top:4px">For '+esc(d.customer||'the client')+' &nbsp;·&nbsp; '+fbs.length+' changes &nbsp;·&nbsp; '+impl+' implemented &nbsp;·&nbsp; '+(fbs.length-impl)+' pending</div>'
    + '</div>'
    + '<div style="padding:18px 2px">'+cta+cards+'</div>'
    + '<div style="color:#727a8a;font:12px Arial;text-align:center;padding:8px 0 18px">Auto-generated by Munshot Tracker</div>'
  + '</div>';
}
function bytesToB64(bytes){ let bin=''; const ch=0x8000; for (let i=0;i<bytes.length;i+=ch) bin += String.fromCharCode.apply(null, bytes.subarray(i, i+ch)); return btoa(bin); }
async function emailBuildUpdate(id, btn){
  const d = DATA.dashboards.find(x => x.id === id); if (!d) return;
  if (!(d.feedbacks||[]).length){ alert('Add at least one feedback/change first.'); return; }
  const def = 'aashita1619@gmail.com'; // test recipient — change to ceekay@muns.io + team once verified
  const to = prompt('Email this Build Update to (comma-separated):', def);
  if (to === null || !to.trim()) return;
  if (btn){ btn.disabled = true; btn.textContent = 'Building PDF…'; }
  try {
    // 1) generate the polished PDF deck
    await loadPdfLib();
    const report = makeReport(d, await buildItems(d.feedbacks||[]));
    const bytes = await buildDeck(window.PDFLib, report);
    // 2) host it so the email can link to the real deck
    let pdfUrl = '';
    try {
      const up = await api('POST', '/api/file', { name: (d.name||'build-update').replace(/[^a-z0-9]+/gi,'-').toLowerCase()+'.pdf', type:'application/pdf', data: bytesToB64(new Uint8Array(bytes)) });
      if (up.ok){ const j = await up.json(); pdfUrl = location.origin + (j.url || ('/api/file?id='+j.id)); }
    } catch(e){}
    // 3) send: branded preview + a button to the full PDF
    if (btn) btn.textContent = 'Sending…';
    const res = await api('POST', '/api/email', { to, subject: 'Build Update — ' + d.name, html: buildUpdateHtml(d, pdfUrl), text: buildUpdateText(d) });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok) alert('✅ Email sent to ' + j.sent + ' recipient(s):\\n' + to + (pdfUrl?'\\n\\nWith a link to the full PDF.':'\\n\\n(PDF link unavailable — sent preview only.)'));
    else alert('Email failed:\\n' + (j.error || JSON.stringify(j.results || j)).slice(0, 400));
  } catch (e){ alert('Email error: ' + e.message); }
  finally { if (btn){ btn.disabled = false; btn.textContent = '📧 Email update'; } }
}
const ARGB = { not_started:'FF9CA3AF', ui_ux:'FF8B5CF6', data_integration:'FF3B82F6', final_check:'FF06B6D4', feedback_open:'FFF59E0B', feedback_incorp:'FFF97316', completed:'FF22C55E' };
const ARGB_SOFT = { not_started:'FFF0F1F4', ui_ux:'FFF1ECFE', data_integration:'FFE8F0FE', final_check:'FFE3F8FB', feedback_open:'FFFEF3DC', feedback_incorp:'FFFDEEE3', completed:'FFE7F8EE' };
const ARGB_TEXT = { not_started:'FF4B5563', ui_ux:'FF6D28D9', data_integration:'FF1D4ED8', final_check:'FF0E7490', feedback_open:'FFB45309', feedback_incorp:'FFC2410C', completed:'FF15803D' };
const THIN = { style:'thin', color:{ argb:'FFE2E6EE' } };
const BORDER = { top:THIN, left:THIN, bottom:THIN, right:THIN };
function applyDataBar(ws, col, n, argb){
  if (n < 1) return;
  ws.addConditionalFormatting({ ref: \`\${col}2:\${col}\${n+1}\`, rules:[{ type:'dataBar', cfvo:[{ type:'min' },{ type:'max' }], color:{ argb }, gradient:true, border:false }] });
}

function uniqueName(wb, base){
  let name = String(base || 'Sheet');
  ['\\\\', '/', '?', '*', '[', ']', ':'].forEach(ch => { name = name.split(ch).join(' '); });
  name = name.replace(/\\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
  let n = name, i = 2;
  while (wb.worksheets.some(w => w.name === n)){ const suf = ' ('+i+')'; n = name.slice(0, 31 - suf.length) + suf; i++; }
  return n;
}
// Add a styled worksheet. cols: [{header,key,width,wrap}]; stateKey marks the
// column whose cell should be tinted with the dashboard's state colour.
function styledSheet(wb, base, cols, rows, stateKey){
  const ws = wb.addWorksheet(uniqueName(wb, base), { views:[{ state:'frozen', ySplit:1, showGridLines:false }] });
  ws.columns = cols.map(c => ({ header:c.header, key:c.key, width:c.width || 16 }));
  rows.forEach(r => ws.addRow(r));
  const head = ws.getRow(1);
  head.height = 22;
  head.eachCell((cell) => {
    cell.font = { bold:true, color:{ argb:'FFFFFFFF' }, size:11 };
    cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1D4ED8' } };
    cell.alignment = { vertical:'middle', horizontal:'center', wrapText:true };
    cell.border = BORDER;
  });
  ws.eachRow((row, rn) => {
    if (rn === 1) return;
    row.eachCell((cell, cn) => {
      cell.border = BORDER;
      const col = cols[cn-1];
      cell.alignment = { vertical:'top', horizontal: col && col.num ? 'center' : 'left', wrapText: !!(col && col.wrap) };
      if (rn % 2 === 0) cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF7F8FA' } };
    });
    if (stateKey){
      const idx = cols.findIndex(c => c.key === stateKey) + 1;
      const argb = ARGB[row.getCell(idx)._stateId];
      if (idx && argb) { const c = row.getCell(idx); c.font = { bold:true, color:{ argb } }; }
    }
  });
  ws.autoFilter = { from:{ row:1, column:1 }, to:{ row:1, column:cols.length } };
  return ws;
}

const DETAIL_COLS = [
  { header:'#', key:'n', width:5, num:true },
  { header:'Sheet #', key:'serial', width:8, num:true },
  { header:'Dashboard', key:'name', width:30, wrap:true },
  { header:'Customer', key:'customer', width:22, wrap:true },
  { header:'Assigned To', key:'owner', width:14 },
  { header:'Stage', key:'state', width:18 },
  { header:'Live', key:'live', width:14 },
  { header:'Priority', key:'prio', width:9 },
  { header:'Status', key:'status', width:34, wrap:true },
  { header:'Client Requirements', key:'req', width:26, wrap:true },
  { header:'Improvements', key:'imp', width:26, wrap:true },
  { header:'Feedback', key:'fb', width:26, wrap:true },
  { header:'Latest Update', key:'update', width:30, wrap:true },
  { header:'Meeting Link', key:'link', width:24, wrap:true },
  { header:'Last Updated', key:'lastUpdated', width:14 },
  { header:'Source', key:'source', width:9 },
];
function detailRows(ws, list){
  list.forEach((d, i) => {
    const u = d.updates && d.updates.length ? d.updates[d.updates.length-1] : null;
    const row = ws.addRow({
      n: i+1,
      serial: d.serial ?? '',
      name: d.name,
      customer: d.customer,
      owner: d.owner,
      state: (STATES.findIndex(x => x.id === d.state)+1) + '. ' + SMAP[d.state].label,
      live: d.isLive ? 'Live on Munshot' : 'No',
      prio: d.priorityLevel ? 'P'+d.priorityLevel : '',
      status: d.status,
      req: d.requirements,
      imp: d.improvement,
      fb: d.feedback,
      update: u ? ((u.date?u.date+': ':'') + (u.note || (SMAP[u.state]?SMAP[u.state].label:''))) : '',
      link: (d.links && d.links.length) ? d.links.map(l => l.label+': '+l.url).join('\\n') : (d.meetingUrl || d.meetingNote || ''),
      lastUpdated: d.lastUpdated,
      source: d.source,
    });
    row.getCell(6)._stateId = d.state; // tag State cell for colouring
  });
}
// Build a detail sheet with per-sheet sequential numbering (1,2,3…).
function detailSheet(wb, base, list){
  const ws = wb.addWorksheet(uniqueName(wb, base), { views:[{ state:'frozen', ySplit:1, showGridLines:false }] });
  ws.columns = DETAIL_COLS.map(c => ({ header:c.header, key:c.key, width:c.width }));
  detailRows(ws, list);
  styleExisting(ws, DETAIL_COLS, 'state');
  return ws;
}
function styleExisting(ws, cols, stateKey){
  const head = ws.getRow(1); head.height = 22;
  head.eachCell((cell) => {
    cell.font = { bold:true, color:{ argb:'FFFFFFFF' }, size:11 };
    cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1D4ED8' } };
    cell.alignment = { vertical:'middle', horizontal:'center', wrapText:true };
    cell.border = BORDER;
  });
  const stateIdx = stateKey ? cols.findIndex(c => c.key === stateKey) + 1 : 0;
  ws.eachRow((row, rn) => {
    if (rn === 1) return;
    row.eachCell((cell, cn) => {
      cell.border = BORDER;
      const col = cols[cn-1];
      cell.alignment = { vertical:'top', horizontal: col && col.num ? 'center' : 'left', wrapText: !!(col && col.wrap) };
      if (rn % 2 === 0) cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF7F8FA' } };
    });
    if (stateIdx){
      const c = row.getCell(stateIdx), id = c._stateId;
      if (ARGB_SOFT[id]){
        c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: ARGB_SOFT[id] } };
        c.font = { bold:true, color:{ argb: ARGB_TEXT[id] } };
        c.alignment = { vertical:'top', horizontal:'center' };
      }
    }
  });
  ws.autoFilter = { from:{ row:1, column:1 }, to:{ row:1, column:cols.length } };
}

const SUMMARY_COLS = (firstHeader, firstKey, lastHeader, lastKey) => [
  { header:firstHeader, key:firstKey, width:22, wrap:true },
  { header:'Total', key:'total', width:8, num:true },
  { header:'Completed', key:'completed', width:11, num:true },
  { header:'In Progress', key:'inprogress', width:11, num:true },
  { header:'Not Started', key:'notstarted', width:11, num:true },
  { header:'Live', key:'live', width:7, num:true },
  ...STATES.map(s => ({ header:s.label, key:'st_'+s.id, width:13, num:true, wrap:true })),
  { header:lastHeader, key:lastKey, width:9, num:true },
];
function summaryRow(name, s, lastVal){
  const row = { name, total:s.total, completed:s.completed, inprogress:s.inprogress, notstarted:s.notstarted, live:s.live, last:lastVal };
  STATES.forEach(x => { row['st_'+x.id] = s.c[x.id]; });
  return row;
}
// Data bars: B Total, C Completed, D In Progress, F Live.
function summaryDataBars(ws, n){
  applyDataBar(ws, 'B', n, 'FF4F46E5');
  applyDataBar(ws, 'C', n, 'FF22C55E');
  applyDataBar(ws, 'D', n, 'FFF97316');
  applyDataBar(ws, 'F', n, 'FF06B6D4');
}
function ownerSummary(wb){
  const rows = DATA.owners.map(o => { const s = ownerStats(o); return summaryRow(o, s, s.clients.length); });
  const ws = styledSheet(wb, 'Owner Summary', SUMMARY_COLS('Owner','name','Clients','last'), rows);
  summaryDataBars(ws, rows.length);
}
function clientSummary(wb){
  const rows = DATA.customers.map(c => { const s = clientStats(c); return summaryRow(c, s, s.people.length); });
  const ws = styledSheet(wb, 'Client Summary', SUMMARY_COLS('Client','name','People','last'), rows);
  summaryDataBars(ws, rows.length);
}

// ── Cover / summary sheet ──────────────────────────────────────────────────
function coverSheet(wb){
  const ws = wb.addWorksheet('Overview', { properties:{ tabColor:{ argb:'FF4F46E5' } }, views:[{ showGridLines:false }] });
  ws.columns = [{ width:3 },{ width:20 },{ width:12 },{ width:12 },{ width:12 },{ width:12 }];
  const set = (addr, val, font, align, fill) => {
    const c = ws.getCell(addr); c.value = val;
    if (font) c.font = font; if (align) c.alignment = align; if (fill) c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:fill } };
    return c;
  };
  ws.mergeCells('B2:F2'); set('B2', 'Dashboard Tracker', { bold:true, size:22, color:{ argb:'FF111827' } });
  ws.mergeCells('B3:F3'); set('B3', 'Status report · generated ' + new Date().toLocaleString('en-GB', { hour12:false }), { size:11, color:{ argb:'FF6B7280' } });

  // KPI band (B5:F6) — big number + label, each a coloured tile.
  const inProgress = MID_STAGES.reduce((n,k) => n + (DATA.counts[k]||0), 0);
  const kpis = [
    ['Total', DATA.total, 'FF4F46E5'],
    ['Live', DATA.liveCount||0, 'FF16A34A'],
    ['Completed', DATA.counts.completed||0, 'FF22C55E'],
    ['In Progress', inProgress, 'FFF97316'],
    ['Not Started', DATA.counts.not_started||0, 'FF9CA3AF'],
  ];
  ws.getRow(5).height = 30;
  kpis.forEach(([label, val, argb], i) => {
    const col = String.fromCharCode(66 + i); // B,C,D,E,F
    set(col+'5', val, { bold:true, size:18, color:{ argb:'FFFFFFFF' } }, { vertical:'middle', horizontal:'center' }, argb).border = BORDER;
    set(col+'6', label, { size:10, bold:true, color:{ argb:'FF6B7280' } }, { horizontal:'center' });
  });

  // Status breakdown table.
  let r = 8;
  set('B'+r, 'STATUS BREAKDOWN', { bold:true, size:11, color:{ argb:'FF6B7280' } }); r++;
  ['State','Count','Share'].forEach((h, i) => {
    const c = set(String.fromCharCode(66+i)+r, h, { bold:true, color:{ argb:'FFFFFFFF' } }, { horizontal: i?'center':'left' }, 'FF1D4ED8'); c.border = BORDER;
  });
  const headRow = r; r++;
  const total = DATA.total || 1;
  STATES.forEach(s => {
    const n = DATA.counts[s.id]||0, id = s.id;
    const a = set('B'+r, s.label, { bold:true, color:{ argb:ARGB_TEXT[id] } }, { horizontal:'left' }, ARGB_SOFT[id]);
    const b = set('C'+r, n, { color:{ argb:'FF374151' } }, { horizontal:'center' });
    const c = set('D'+r, (n/total), { color:{ argb:'FF374151' } }, { horizontal:'center' });
    c.numFmt = '0%';
    [a,b,c].forEach(x => x.border = BORDER);
    r++;
  });
  ws.addConditionalFormatting({ ref:'C'+(headRow+1)+':C'+(r-1), rules:[{ type:'dataBar', cfvo:[{ type:'min' },{ type:'max' }], color:{ argb:'FF4F46E5' }, gradient:true, border:false }] });

  // Top clients & owners (by total), side by side.
  r += 1;
  const topStart = r;
  const top = (arr, statsFn) => arr.map(n => ({ n, t: statsFn(n).total })).filter(x => x.t).sort((a,b) => b.t-a.t).slice(0,8);
  const tc = top(DATA.customers, clientStats), to = top(DATA.owners, ownerStats);
  set('B'+r, 'TOP CLIENTS', { bold:true, size:11, color:{ argb:'FF6B7280' } });
  set('E'+r, 'TOP TEAM', { bold:true, size:11, color:{ argb:'FF6B7280' } }); r++;
  const rowsN = Math.max(tc.length, to.length);
  for (let i=0;i<rowsN;i++){
    if (tc[i]){ set('B'+r, tc[i].n, null, { horizontal:'left' }).border = BORDER; set('C'+r, tc[i].t, null, { horizontal:'center' }).border = BORDER; }
    if (to[i]){ set('E'+r, to[i].n, null, { horizontal:'left' }).border = BORDER; set('F'+r, to[i].t, null, { horizontal:'center' }).border = BORDER; }
    r++;
  }
  if (tc.length) ws.addConditionalFormatting({ ref:'C'+topStart+':C'+(r-1), rules:[{ type:'dataBar', cfvo:[{ type:'min' },{ type:'max' }], color:{ argb:'FF3B82F6' }, gradient:true, border:false }] });
  if (to.length) ws.addConditionalFormatting({ ref:'F'+topStart+':F'+(r-1), rules:[{ type:'dataBar', cfvo:[{ type:'min' },{ type:'max' }], color:{ argb:'FF8B5CF6' }, gradient:true, border:false }] });
  return ws;
}

async function saveWb(wb, filename){
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// All feedbacks across dashboards — with the implemented status.
function feedbacksSheet(wb){
  const cols = [
    { header:'Dashboard', key:'dash', width:28, wrap:true },
    { header:'Owner', key:'owner', width:14 },
    { header:'Client', key:'client', width:20, wrap:true },
    { header:'Feedback', key:'label', width:18, wrap:true },
    { header:'Date', key:'date', width:12 },
    { header:'What the client said', key:'text', width:46, wrap:true },
    { header:'Link', key:'link', width:26, wrap:true },
    { header:'Implemented', key:'impl', width:13 },
  ];
  const rows = [];
  DATA.dashboards.forEach(d => (d.feedbacks||[]).forEach(f => rows.push({
    dash:d.name, owner:d.owner, client:d.customer, label:f.label, date:f.date, text:f.text, link:f.link, impl: f.implemented ? 'Yes' : 'No',
  })));
  if (!rows.length) return;
  const ws = styledSheet(wb, 'Feedbacks', cols, rows);
  // Colour the Implemented cell (col 8) green/red.
  ws.eachRow((row, rn) => { if (rn===1) return; const c = row.getCell(8);
    const yes = String(c.value).toLowerCase()==='yes';
    c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: yes ? 'FFE7F8EE' : 'FFFDE8E8' } };
    c.font = { bold:true, color:{ argb: yes ? 'FF15803D' : 'FFB91C1C' } };
    c.alignment = { horizontal:'center', vertical:'top' };
  });
}
function teamSheet(wb){
  const cols = [
    { header:'Team Member', key:'name', width:18, wrap:true },
    { header:'Role', key:'role', width:18, wrap:true },
    { header:'Qualification', key:'qual', width:16, wrap:true },
    { header:'Email', key:'email', width:24 },
    { header:'Phone', key:'phone', width:14 },
    { header:'Joined', key:'joined', width:13 },
    { header:'Dashboards', key:'total', width:12, num:true },
    { header:'Completed', key:'done', width:11, num:true },
    { header:'Live', key:'live', width:8, num:true },
    { header:'Open feedbacks', key:'todo', width:14, num:true },
  ];
  const rows = DATA.owners.map(name => {
    const s = ownerStats(name), p = (DATA.people&&DATA.people[name])||{};
    const todo = DATA.dashboards.filter(d=>d.owner===name).reduce((n,d)=>n+(d.feedbacks||[]).filter(f=>!f.implemented).length,0);
    return { name, role:p.role||'', qual:p.qualification||'', email:p.email||'', phone:p.phone||'', joined:p.joinDate||'', total:s.total, done:s.completed, live:s.live, todo };
  });
  if (rows.length) styledSheet(wb, 'Team', cols, rows);
}
function clientsSheet(wb){
  const cols = [
    { header:'Client', key:'name', width:22, wrap:true },
    { header:'Point of contact', key:'poc', width:18, wrap:true },
    { header:'Emails', key:'emails', width:28, wrap:true },
    { header:'Meeting frequency', key:'freq', width:20, wrap:true },
    { header:'Website', key:'web', width:22, wrap:true },
    { header:'Dashboards', key:'total', width:12, num:true },
    { header:'Completed', key:'done', width:11, num:true },
    { header:'Live', key:'live', width:8, num:true },
    { header:'Team', key:'people', width:9, num:true },
  ];
  const rows = DATA.customers.map(name => {
    const s = clientStats(name), det = (DATA.clientDetails&&DATA.clientDetails[name])||{};
    return { name, poc:det.poc||'', emails:Array.isArray(det.emails)?det.emails.join(', '):(det.emails||''), freq:det.meetingFreq||'', web:det.website||'', total:s.total, done:s.completed, live:s.live, people:s.people.length };
  });
  if (rows.length) styledSheet(wb, 'Clients', cols, rows);
}

async function doExport(kind){
  try {
    await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    const all = DATA.dashboards;
    if (kind === 'all'){
      coverSheet(wb);
      detailSheet(wb, 'All Dashboards', all);
      ownerSummary(wb);
      clientSummary(wb);
      feedbacksSheet(wb);
      teamSheet(wb);
      clientsSheet(wb);
      DATA.customers.forEach(c => detailSheet(wb, 'Client - '+c, all.filter(d => d.customers.includes(c))));
      DATA.owners.forEach(o => detailSheet(wb, 'Owner - '+o, all.filter(d => d.owner === o)));
      await saveWb(wb, 'dashboard-tracker-all.xlsx');
    } else if (kind === 'client'){
      DATA.customers.forEach(c => detailSheet(wb, c, all.filter(d => d.customers.includes(c))));
      await saveWb(wb, 'dashboard-tracker-by-client.xlsx');
    } else {
      DATA.owners.forEach(o => detailSheet(wb, o, all.filter(d => d.owner === o)));
      await saveWb(wb, 'dashboard-tracker-by-owner.xlsx');
    }
  } catch (e){ alert(e.message || 'Export failed.'); }
}
const exportMenu = document.getElementById('exportMenu');
document.getElementById('exportToggle').onclick = (e) => { e.stopPropagation(); exportMenu.classList.toggle('open'); };
document.addEventListener('click', () => exportMenu.classList.remove('open'));
exportMenu.querySelectorAll('[data-export]').forEach(b => b.onclick = () => { exportMenu.classList.remove('open'); doExport(b.dataset.export); });

['q','customer','owner','groupby','liveonly'].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener(el.type==='checkbox'?'change':'input', render);
});
// Dashboards Cards ⇄ Table view toggle
function syncViewSeg(){ document.querySelectorAll('#viewSeg .vseg').forEach(b => b.classList.toggle('on', b.dataset.dview===dashView)); }
document.querySelectorAll('#viewSeg [data-dview]').forEach(b => b.onclick = () => { dashView = b.dataset.dview; try{ localStorage.setItem('dashView', dashView); }catch(e){} syncViewSeg(); render(); });
syncViewSeg();
document.getElementById('themeToggle').onclick = () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next); applyTheme(next);
};
document.getElementById('prioToggle').onclick = () => {
  prioOnly = !prioOnly;
  if (prioOnly){ stateFilter.clear(); liveOnlyEl().checked = false; }
  render();
};
render();
renderEod();

// Load the live Muns directory into the Clients + Assigned-to dropdowns.
// Clients come from the list of organizations; the team comes from the munshot org.
async function loadDirectory(){
  try {
    const r = await fetch('/api/directory');
    if (!r.ok) return;
    const d = await r.json();
    if (!d || !d.ok) return;
    DIR.clients = Array.isArray(d.clients) ? d.clients : [];
    DIR.team = Array.isArray(d.team) ? d.team : [];
    const cdd = document.getElementById('clientDD'), odd = document.getElementById('ownerDD');
    if (cdd && cdd.classList.contains('open')) renderClientMenu();
    if (odd && odd.classList.contains('open')) renderOwnerMenu();
  } catch(e){}
}
loadDirectory();
// Fold the latest notetaker to-dos into the shared KV store, then refresh views.
syncTrackingTasks().then((changed) => {
  if (!changed) return;
  renderEod();
  if (activeTab === 'team') renderTeamTab();
  if (activeTab === 'standup') renderStandupTab();
  if (overlay.classList.contains('open') && drawer.querySelector('.subtab')) { /* owner drawer open — leave as-is until next open */ }
});
</script>
</body>
</html>`;
}
