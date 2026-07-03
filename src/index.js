// index.js — Cloudflare Worker entry point.
//   GET  /             → server-rendered dashboard (clean light theme)
//   GET  /api/data     → parsed + classified dataset (sheet + manual) as JSON
//   POST/PUT/DELETE /api/manual  → add / edit / remove a dashboard entry
//   POST/DELETE     /api/roster  → add / remove a team member or client
//   POST/DELETE     /api/update  → post / remove a dated status update
//   POST            /api/person  → set an employee's join date / attendance day
//   POST            /api/import  → one-time: import the sheet into KV, then run
//                                  standalone (the Google Sheet is no longer read)
//
// Sheet data comes from the published CSV (CSV_URL) until you "go standalone",
// after which everything lives in the KV namespace bound as MANUAL. If MANUAL
// isn't bound, the board works read-only and editing controls are hidden.
import { parseCsv } from './csv.js';
import { buildDataset, manualToDashboard, rowsToEntries, STATES } from './classify.js';

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

async function getDataset(env) {
  const [manual, roster, updates, people, config, priority, clients, assignments] = await Promise.all([
    readManual(env), readRoster(env), readUpdates(env), readPeople(env), readConfig(env), readPriority(env), readClients(env), readAssign(env),
  ]);
  // Standalone mode: serve purely from KV, never touch the Google Sheet.
  let rows = [];
  if (!config.standalone) {
    if (!env.CSV_URL) throw new Error('CSV_URL is not configured');
    const res = await fetch(env.CSV_URL, { cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true } });
    if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
    rows = parseCsv(await res.text());
  }
  return buildDataset(rows, manual, { roster, updates, people, priority, clients, assignments, standalone: !!config.standalone });
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
      <td style="padding:11px 12px;border-bottom:1px solid #eee2c9;text-align:right;color:#727a8a;font-size:12px;white-space:nowrap">${e(r.owner || 'Unassigned')}</td></tr>`;
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
    const o = d.owner || 'Unassigned', a = owners[o] || (owners[o] = { done: 0, doneToday: 0, pending: 0, total: 0 });
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
            links: Array.isArray(body.links) ? body.links : [],
            lastUpdated: body.lastUpdated || new Date().toLocaleDateString('en-GB'),
            note: body.note || '',
            dueDate: body.dueDate || '',
            manualStatus: body.manualStatus || '',
            requirementFiles: Array.isArray(body.requirementFiles) ? body.requirementFiles : [],
            feedbacks: Array.isArray(body.feedbacks) ? body.feedbacks : [],
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
          const FIELDS = ['name', 'customer', 'owner', 'liveRaw', 'stage', 'status', 'requirements', 'improvement', 'feedback', 'meetingUrl', 'links', 'lastUpdated', 'note', 'dueDate', 'manualStatus', 'requirementFiles', 'feedbacks'];
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

      // ── Import sheet → standalone (one-time migration) ───────────────────
      if (pathname === '/api/import') {
        if (!env.MANUAL) return json({ error: 'Storage not enabled.' }, 503);
        if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
        if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
        const config = await readConfig(env);
        if (config.standalone) return json({ error: 'Already standalone — the sheet has already been imported.' }, 409);
        if (!env.CSV_URL) return json({ error: 'CSV_URL is not configured, nothing to import.' }, 400);
        const res = await fetch(env.CSV_URL, { cf: { cacheTtl: 0 } });
        if (!res.ok) return json({ error: `Sheet fetch failed: ${res.status}` }, 502);
        const imported = rowsToEntries(parseCsv(await res.text()));
        const list = await readManual(env);
        const existing = new Set(list.map((e) => e.id));
        const added = imported.filter((e) => !existing.has(e.id));
        await writeManual(env, [...list, ...added]);
        await writeConfig(env, { ...config, standalone: true, importedAt: new Date().toISOString() });
        return json({ ok: true, imported: added.length, standalone: true }, 201);
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
        if (i === -1) return json({ error: 'Only app-stored dashboards can be changed here. Go standalone first to edit sheet rows.' }, 404);
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
          // everywhere (owners → Unassigned; clients → removed from the list).
          const list = await readManual(env);
          let changed = 0;
          for (const e of list) {
            if (type === 'owner' && (e.owner || '') === name) { e.owner = 'Unassigned'; changed++; }
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
          if (!body.state && !body.note) return json({ error: 'Pick a status or write a note.' }, 400);
          const entry = {
            ts: Date.now(),
            date: body.date || new Date().toLocaleDateString('en-GB'),
            state: body.state || '',
            note: body.note || '',
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

      return new Response(renderPage(data, { manualEnabled: !!env.MANUAL, editProtected: !!env.EDIT_TOKEN, standalone: !!data.standalone, hasSheet: !!env.CSV_URL }), {
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
<style>
  :root {
    --bg:#f3f5fb; --surface:#ffffff; --surface2:#fafbff;
    --line:#e5e8ef; --line2:#eef1f6;
    --txt:#141925; --txt2:#48505f; --muted:#727a8a;
    --accent:#4f46e5; --accent2:#9333ea; --accent-weak:#eef0ff;
    --good:#067647; --good-bg:#ecfdf3; --good-line:#abefc6;
    --warn-bg:#fffaeb; --warn-txt:#93620a; --warn-line:#fef0c7;
    --present-bg:#dcfce7; --present-line:#86efac; --present-txt:#166534;
    --leave-bg:#fee2e2; --leave-line:#fca5a5; --leave-txt:#991b1b;
    --accent-line:var(--accent-line); --danger:#b42318; --danger-bg:#fef3f2; --danger-line:#fda29b;
    --overlay:rgba(16,24,40,.45);
    --shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.04);
    --shadow-md:0 4px 14px rgba(16,24,40,.08);
    --shadow-lg:0 14px 40px rgba(16,24,40,.14);
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
  body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; -webkit-font-smoothing:antialiased; transition:background .25s,color .25s; }
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
  .overlay { position:fixed; inset:0; background:var(--overlay); display:none; z-index:50; }
  .overlay.open { display:block; }
  .drawer { position:absolute; top:0; right:0; height:100%; width:min(560px,100%); background:var(--bg); box-shadow:-8px 0 30px rgba(16,24,40,.18); overflow-y:auto; }
  .drawer-head { position:sticky; top:0; background:var(--surface); border-bottom:1px solid var(--line); padding:18px 22px; display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
  .drawer-head h2 { margin:0; font-size:20px; font-weight:650; }
  .drawer-head .sub { color:var(--muted); font-size:12.5px; margin-top:3px; }
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
  .cal-cell { aspect-ratio:1; display:flex; align-items:center; justify-content:center; font-size:12px; border:1px solid var(--line); border-radius:7px; background:var(--surface); cursor:pointer; user-select:none; }
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
  .modal-bg { position:fixed; inset:0; background:var(--overlay); display:none; z-index:60; align-items:center; justify-content:center; }
  .modal-bg.open { display:flex; }
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
  .asg-row { display:flex; gap:12px; align-items:center; padding:10px 0; border-bottom:1px solid var(--line2); }
  .asg-row .dn { font-weight:550; font-size:13.5px; } .asg-row .dmeta { font-size:12px; color:var(--muted); }
  .asg-act { margin-left:auto; display:flex; gap:8px; align-items:center; }
  .asg-sel { font:inherit; font-size:12.5px; padding:5px 8px; border:1px solid var(--line); border-radius:8px; background:var(--surface); color:var(--txt); }
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
  .form-grid label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--muted); }
  .panel-actions { margin-top:12px; display:flex; gap:10px; align-items:center; }
  .msg { font-size:12.5px; }
  .msg.err { color:var(--danger); } .msg.ok { color:var(--good); }
  /* KPI hero */
  .kpis { display:grid; grid-template-columns:repeat(6,1fr); gap:12px; padding:18px 28px 4px; }
  @media (max-width:1100px){ .kpis { grid-template-columns:repeat(3,1fr); } }
  @media (max-width:680px){ .kpis { grid-template-columns:repeat(2,1fr); } }
  .kpi { position:relative; background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:14px 16px; box-shadow:var(--shadow); overflow:hidden; cursor:pointer; transition:transform .14s,box-shadow .14s,border-color .14s; }
  .kpi:hover { transform:translateY(-2px); box-shadow:var(--shadow-md); border-color:var(--kc,var(--accent)); }
  .kpi.off { opacity:.45; }
  .kpi.on { border-color:var(--kc,var(--accent)); box-shadow:0 0 0 2px color-mix(in srgb, var(--kc,var(--accent)) 35%, transparent), var(--shadow-md); }
  .kpi .ic { position:absolute; right:12px; top:12px; width:34px; height:34px; border-radius:10px; display:grid; place-items:center; font-size:17px; background:color-mix(in srgb, var(--kc,var(--accent)) 16%, transparent); }
  .kpi .n { font-size:30px; font-weight:760; line-height:1; font-variant-numeric:tabular-nums; letter-spacing:-.02em; }
  .kpi .l { font-size:12px; color:var(--muted); margin-top:5px; font-weight:550; }
  .kpi .spark { height:4px; border-radius:3px; margin-top:10px; background:var(--kc,var(--accent)); opacity:.85; }
  /* Insights / charts */
  .insights { padding:8px 28px 4px; }
  .ins-toggle { display:inline-flex; align-items:center; gap:7px; font:inherit; font-size:12.5px; font-weight:600; color:var(--muted); background:none; border:0; cursor:pointer; padding:6px 0; }
  .ins-toggle:hover { color:var(--accent); }
  .ins-grid { display:grid; grid-template-columns:auto 1fr 1fr; gap:14px; margin-top:8px; }
  @media (max-width:900px){ .ins-grid { grid-template-columns:1fr; } }
  .ins-card { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:16px; box-shadow:var(--shadow); }
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
  .modal-form { width:min(680px,95vw); }
  .modal-form .form-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:12px; }
  .modal-form .form-grid label.wide { grid-column:1 / -1; }
  .modal-form .form-grid label { margin:0; }
  .modal-form .form-grid input, .modal-form .form-grid select { width:100%; margin:0; }
  .form-grid .hint { color:var(--muted); font-weight:400; font-size:10.5px; }
  .client-row { display:flex; gap:6px; margin-bottom:6px; }
  .client-row input { flex:1; }
  .rm-client { width:34px; border:1px solid var(--line); background:var(--surface); color:var(--muted); border-radius:8px; cursor:pointer; font-size:15px; }
  .rm-client:hover { color:var(--danger); border-color:var(--danger-line); }
  #addClientRow { padding:5px 10px; font-size:11.5px; }
  .modal-form .panel-actions { margin-top:16px; }
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
  /* Tabs */
  .tabs { display:flex; gap:4px; margin-top:14px; }
  .tab { font:inherit; font-size:13px; font-weight:600; color:var(--muted); background:none; border:0; border-bottom:2.5px solid transparent; padding:8px 14px; cursor:pointer; }
  .tab:hover { color:var(--txt); }
  .tab.on { color:var(--accent); border-bottom-color:var(--accent); }
  .tabview[hidden] { display:none; }
  .tabhead { padding:18px 28px 4px; }
  .tabhead h2 { margin:0; font-size:20px; font-weight:720; }
  .tabhead .sub { color:var(--muted); font-size:12.5px; margin-top:2px; }
  /* Profile / client cards */
  .profile-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:14px; padding:8px 28px 64px; }
  .profile-card { position:relative; background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:15px 16px; box-shadow:var(--shadow); cursor:pointer; transition:transform .14s,box-shadow .14s,border-color .14s; }
  .profile-card:hover { transform:translateY(-3px); box-shadow:var(--shadow-md); border-color:var(--accent); }
  .profile-card .pc-head { display:flex; align-items:center; gap:11px; }
  .profile-card .pc-name { font-weight:680; font-size:15px; }
  .profile-card .pc-role { font-size:12px; color:var(--muted); margin-top:1px; }
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
</style>
</head>
<body>
<header>
  <div class="row">
    <div class="brand">
      <div class="logo">◆</div>
      <div>
        <h1>Dashboard Tracker</h1>
        <div class="sub">${data.total} dashboards${opts.standalone ? ` · standalone (sheet disconnected)` : ` · ${data.sheetCount} from sheet${data.manualCount ? ` · ${data.manualCount} added manually` : ''}`} · updated ${escapeHtml(fresh)}</div>
      </div>
    </div>
    <div class="header-actions">
      <button class="theme-toggle" id="themeToggle" title="Toggle light / dark">🌙</button>
      <button class="btn ghost prio-btn" id="prioToggle" title="Show only priority dashboards">⭐ Priority</button>
      <div class="dropdown">
        <button class="btn ghost" id="exportToggle">⬇ Export ▾</button>
        <div class="menu" id="exportMenu">
          <button data-export="all">All — full workbook (cover + per-client + per-owner sheets)</button>
          <button data-export="client">Client-wise — one sheet per client</button>
          <button data-export="owner">Owner-wise — one sheet per owner</button>
        </div>
      </div>
      ${opts.manualEnabled && opts.hasSheet && !opts.standalone ? `<button class="btn ghost" id="standaloneBtn" title="Import the sheet's dashboards into the app and stop reading the Google Sheet">⤓ Go standalone</button>` : ''}
      ${opts.manualEnabled ? `<button class="btn" id="addToggle">+ Add dashboard</button>` : ''}
    </div>
  </div>
  <nav class="tabs" id="tabs">
    <button class="tab on" data-tab="overview">📊 Overview</button>
    <button class="tab" data-tab="team">👤 Team</button>
    <button class="tab" data-tab="clients">🏢 Clients</button>
    <button class="tab" data-tab="assign">⚖️ Assign</button>
    <button class="tab" data-tab="checklist">📋 Requests</button>
  </nav>
</header>

<section class="tabview" id="tab-overview">
<div class="legend" id="legend"></div>
<div class="kpis" id="kpis"></div>
<div class="insights" id="insights"></div>

${opts.manualEnabled ? `
<div class="modal-bg" id="formModalBg"><div class="modal modal-form" id="formModal">
  <div class="modal-head"><div><h3 id="panelTitle">Add dashboard</h3></div><button class="x" id="formX">×</button></div>
  <div class="modal-body">
    <input type="hidden" id="f_id">
    <div class="form-grid">
      <label class="wide">Dashboard name *<input id="f_name" placeholder="e.g. Revenue Tracker"></label>
      <label class="wide">Clients <span class="hint">(add one or more)</span>
        <div id="clientRows"></div>
        <button class="btn ghost sm" id="addClientRow" type="button">+ another client</button>
      </label>
      <label>Assigned to<input id="f_owner" list="owners" placeholder="e.g. Vipul"></label>
      <label>Stage <span class="hint">(drives progress)</span><select id="f_stage">${STATES.map((s,i)=>`<option value="${s.id}">${i+1}. ${escapeHtml(s.label)}</option>`).join('')}</select></label>
      <label>Live on Munshot?<select id="f_live"><option value="Not Live">Not live</option><option value="Live on Munshot">Live on Munshot</option></select></label>
      <label>Priority<select id="f_prio"><option value="0">None</option><option value="1">1st priority</option><option value="2">2nd priority</option><option value="3">3rd priority</option><option value="4">4th priority</option><option value="5">5th priority</option></select></label>
      <label class="wide">Links <span class="hint">(meetings, feedback recordings — add as many as you like)</span>
        <div id="linkRows"></div>
        <button class="btn ghost sm" id="addLinkRow" type="button">+ another link</button>
      </label>
      <label>Due date<input type="date" id="f_due"></label>
      <label class="wide">Manual status <span class="hint">(handwritten — where it really stands)</span><textarea id="f_manual" rows="2" placeholder="e.g. UI 80% done, waiting on Chiraag's data file"></textarea></label>
      <label class="wide">Original client requirement <span class="hint">(summary + upload PDF / photo)</span>
        <input id="f_req" placeholder="short requirement summary">
        <div class="filebox" id="reqFiles"></div>
        <button class="btn ghost sm" id="addReqFile" type="button">📎 Upload requirement file</button>
      </label>
      <label class="wide">Feedbacks <span class="hint">(upload many screenshots; give each its OWN description → each becomes its own PDF page)</span>
        <div id="fbRows"></div>
        <button class="btn ghost sm" id="addFb" type="button">+ add feedback</button>
      </label>
      <label>Improvements<input id="f_imp" placeholder="optional"></label>
      <label>Current status note<input id="f_status" placeholder="optional, e.g. needs QA"></label>
      <label class="wide">Notes<input id="f_note" placeholder="optional"></label>
      <input type="hidden" id="f_meeting">
    </div>
    <div class="panel-actions">
      <button class="btn" id="saveBtn">Save dashboard</button>
      <button class="btn ghost" id="cancelBtn">Cancel</button>
      <span class="msg" id="formMsg"></span>
    </div>
  </div>
</div></div>
<datalist id="customers">${data.customers.map((c) => `<option value="${escapeHtml(c)}">`).join('')}</datalist>
<datalist id="owners">${data.owners.map((o) => `<option value="${escapeHtml(o)}">`).join('')}</datalist>
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
</div>
<div class="grid" id="grid"></div>
</section>

<section class="tabview" id="tab-team" hidden></section>
<section class="tabview" id="tab-clients" hidden></section>
<section class="tabview" id="tab-assign" hidden></section>
<section class="tabview" id="tab-checklist" hidden></section>

<div class="overlay" id="overlay"><div class="drawer" id="drawer"></div></div>
<div class="modal-bg" id="updModalBg"><div class="modal" id="updModal"></div></div>
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
function ownerTag(name){ return \`<span class="av-tag owner-link" data-owner="\${esc(name)}" title="View \${esc(name)}'s profile">\${avatar(name)}\${esc(name)}</span>\`; }
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
  return \`<div class="card clickable \${showManualTag?'manual':''} \${d.priorityLevel?'prio':''}" data-card="\${esc(d.id)}" style="--cardc:\${s.color}">
    \${cardBtns}
    <h3>\${prioBadge}\${title}</h3>
    \${progressBar(d)}
    <div class="meta">
      \${d.isLive ? '<span class="tag live">● Live on Munshot</span>' : ''}
      \${d.customers.map(c => clientTag(c)).join('')}
      \${ownerTag(d.owner)}
      \${showManualTag ? '<span class="tag src">Manual</span>' : ''}
    </div>
    \${d.status && d.status!=='-' ? \`<div class="status"><span class="label">Current status</span><br>\${esc(d.status)}</div>\` : ''}
    \${fields.map(([k,v]) => \`<div class="field"><span class="label">\${k}</span><div class="val">\${esc(v)}</div></div>\`).join('')}
    \${links.length ? \`<div class="links"><span class="label">Links</span>\${links.map(l => \`<a href="\${esc(l.url)}" target="_blank" rel="noopener" class="lnk">▶ \${esc(l.label)}</a>\`).join('')}</div>\` : ''}
    \${d.updates && d.updates.length ? \`<div class="upd"><span class="label">Latest update · \${esc(d.updates[d.updates.length-1].date||'')}</span><div class="val">\${esc(d.updates[d.updates.length-1].note || SMAP[d.updates[d.updates.length-1].state]?.label || '')}</div></div>\` : ''}
    <div class="foot">
      <span>\${d.lastUpdated ? 'Updated '+esc(d.lastUpdated) : ''}</span>
      \${CFG.manualEnabled ? \`<button class="upd-btn" data-update="\${esc(d.id)}" data-name="\${esc(d.name)}">＋ Update\${d.updates&&d.updates.length?' ('+d.updates.length+')':''}</button>\` : ''}
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
function renderKpis(){
  const el = document.getElementById('kpis'); if (!el) return;
  const liveOn = liveOnlyEl() ? liveOnlyEl().checked : false;
  const anyFilter = stateFilter.size > 0 || prioOnly || liveOn;
  // A tight, meaningful KPI row — the per-stage breakdown lives on the pill row
  // and the Status Mix donut, so we don't repeat all 7 stages as tiles here.
  const inprog = MID_STAGES.reduce((n,k) => n + (DATA.counts[k]||0), 0);
  const tiles = [
    { id:'__all', label:'Total dashboards', n:DATA.total, color:'var(--accent)', icon:'📊', on:!anyFilter },
    { id:'not_started', label:'Not started', n:DATA.counts['not_started']||0, color:'#9ca3af', icon:'⏳', on:stateFilter.has('not_started') },
    { id:'__inprog', label:'In progress', n:inprog, color:'#f59e0b', icon:'🔧', on:stateFilter.size===MID_STAGES.length && MID_STAGES.every(k => stateFilter.has(k)) },
    { id:'completed', label:'Completed', n:DATA.counts['completed']||0, color:'#22c55e', icon:'✅', on:stateFilter.has('completed') },
    { id:'__live', label:'Live on Munshot', n:DATA.liveCount||0, color:'#16a34a', icon:'🚀', on:liveOn },
    { id:'__prio', label:'Priority', n:DATA.priorityCount||0, color:'#f59e0b', icon:'⭐', on:prioOnly },
  ];
  el.innerHTML = tiles.map(t => \`<div class="kpi \${t.on?'on':(anyFilter?'off':'')}" data-kpi="\${t.id}" style="--kc:\${t.color}">
      <div class="ic">\${t.icon}</div><div class="n" data-count="\${t.n}">0</div><div class="l">\${esc(t.label)}</div><div class="spark"></div>
    </div>\`).join('');
  el.querySelectorAll('[data-kpi]').forEach(k => k.onclick = () => {
    const id = k.dataset.kpi;
    if (id === '__all'){ clearAllFilters(); }
    else if (id === '__inprog'){ const on = MID_STAGES.some(s => stateFilter.has(s)); clearAllFilters(); if (!on) MID_STAGES.forEach(s => stateFilter.add(s)); }
    else if (id === '__live'){ const on = !liveOnlyEl().checked; clearAllFilters(); liveOnlyEl().checked = on; }
    else if (id === '__prio'){ const on = !prioOnly; clearAllFilters(); prioOnly = on; }
    else { isolateState(id); return; }
    render();
  });
  animateCounts(el);
}

// ── Insights (SVG donut + bar charts, no external libs) ────────────────────
function donutSvg(){
  const total = DATA.total || 1, r = 54, c = 2*Math.PI*r; let off = 0, segs = '';
  STATES.forEach(s => {
    const v = DATA.counts[s.id]||0; if (!v) return;
    const len = v/total*c;
    segs += \`<circle cx="66" cy="66" r="\${r}" fill="none" stroke="\${s.color}" stroke-width="15" stroke-dasharray="\${len} \${c-len}" stroke-dashoffset="\${-off}" transform="rotate(-90 66 66)" style="transition:stroke-dasharray .5s"></circle>\`;
    off += len;
  });
  return \`<svg width="132" height="132" viewBox="0 0 132 132">\${segs}</svg>\`;
}
function barChart(items, statsFn, attr, useAvatar){
  const rows = items.map(name => ({ name, s: statsFn(name) })).filter(r => r.s.total).sort((a,b) => b.s.total - a.s.total).slice(0,6);
  if (!rows.length) return '<div class="sub">No data yet.</div>';
  const max = Math.max(1, ...rows.map(r => r.s.total));
  return \`<div class="bc">\${rows.map(r => \`<div class="bc-row" \${attr}="\${esc(r.name)}">
    <div class="bc-top">\${useAvatar?avatar(r.name):''}<span class="nm">\${esc(r.name)}</span><span class="ct">\${r.s.total}</span></div>
    <div class="bc-track" style="width:\${Math.max(8,r.s.total/max*100)}%">\${STATES.filter(x => r.s.c[x.id]).map(x => \`<i style="width:\${r.s.c[x.id]/r.s.total*100}%;background:\${x.color}" title="\${x.label}: \${r.s.c[x.id]}"></i>\`).join('')}</div>
  </div>\`).join('')}</div>\`;
}
let insightsOpen = true;
function renderInsights(){
  const el = document.getElementById('insights'); if (!el) return;
  const body = insightsOpen ? \`<div class="ins-grid">
    <div class="ins-card"><h4>Status mix</h4><div class="donut-wrap">
      <div class="donut">\${donutSvg()}<div class="center"><div class="big">\${DATA.total}</div><div class="small">total</div></div></div>
      <div class="leg2">\${STATES.map(s => \`<div class="li" data-leg="\${s.id}"><span class="sw" style="background:\${s.color}"></span>\${s.label}<span class="v">\${DATA.counts[s.id]||0}</span></div>\`).join('')}</div>
    </div></div>
    <div class="ins-card"><h4>Top team members</h4>\${barChart(DATA.owners, ownerStats, 'data-bc-owner', true)}</div>
    <div class="ins-card"><h4>Top clients</h4>\${barChart(DATA.customers, clientStats, 'data-bc-customer', false)}</div>
  </div>\` : '';
  el.innerHTML = \`<button class="ins-toggle" id="insToggle">📊 Insights \${insightsOpen?'▾':'▸'}</button>\${body}\`;
  document.getElementById('insToggle').onclick = () => { insightsOpen = !insightsOpen; renderInsights(); };
  if (insightsOpen){
    el.querySelectorAll('[data-leg]').forEach(li => li.onclick = () => { isolateState(li.dataset.leg); window.scrollTo({top:0,behavior:'smooth'}); });
    el.querySelectorAll('[data-bc-owner]').forEach(b => b.onclick = () => openOwner(b.getAttribute('data-bc-owner')));
    el.querySelectorAll('[data-bc-customer]').forEach(b => b.onclick = () => openClient(b.getAttribute('data-bc-customer')));
  }
}

function render(){
  renderKpis(); renderLegend();
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
  if (!list.length){ grid.innerHTML = '<div class="empty">No dashboards match these filters.</div>'; bindCards(); return; }

  // Numbering is positional within the CURRENT view (1..n), not the dashboard's
  // own id — so picking an owner shows their dashboards as 1,2,3…
  if (!groupby){ grid.innerHTML = list.map((d,i) => card(d, i+1)).join(''); bindCards(); return; }
  let groups;
  if (groupby === 'state'){
    groups = STATES.map(s => [s.label, list.filter(d => d.state === s.id)]).filter(([,a]) => a.length);
  } else if (groupby === 'customer'){
    const keys = [...new Set(list.flatMap(d => d.customers))].sort();
    groups = keys.map(k => [k, list.filter(d => d.customers.includes(k))]); // a 2-client dash appears under both
  } else {
    const keys = [...new Set(list.map(d => d.owner))].sort();
    groups = keys.map(k => [k, list.filter(d => d.owner === k)]);
  }
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
function clientRowHtml(val){ return \`<div class="client-row"><input class="f_client" list="customers" placeholder="e.g. Beas Capital" value="\${esc(val||'')}"><button type="button" class="rm-client" title="Remove">×</button></div>\`; }
function setClients(arr){
  const box = G('clientRows');
  const list = (arr && arr.length) ? arr : [''];
  box.innerHTML = list.map(clientRowHtml).join('');
  box.querySelectorAll('.rm-client').forEach(b => b.onclick = () => { if (box.children.length > 1) b.parentElement.remove(); else b.previousElementSibling.value=''; });
}
function getClients(){ return [...G('clientRows').querySelectorAll('.f_client')].map(i => i.value.trim()).filter(Boolean); }

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

// Requirement files + feedbacks: edited via in-memory state, saved on submit.
let reqFilesState = [], fbState = [];
function renderReqFiles(){
  const box = G('reqFiles'); box.innerHTML = reqFilesState.map(f => fileChip(f,true)).join('');
  box.querySelectorAll('[data-fx]').forEach(b => b.onclick = () => { reqFilesState = reqFilesState.filter(x => x.id !== b.dataset.fx); renderReqFiles(); });
}
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

function setForm(d){
  G('f_id').value = d ? d.id : '';
  G('f_name').value = d ? d.name : '';
  setClients(d ? (d.customers || []) : []);
  setLinks(d ? (d.links || []) : []);
  G('f_owner').value = d ? d.owner : '';
  G('f_stage').value = d ? d.state : 'not_started';
  G('f_live').value = d && d.isLive ? 'Live on Munshot' : 'Not Live';
  G('f_prio').value = d ? String(d.priorityLevel || 0) : '0';
  G('f_due').value = d ? (d.dueDate || '') : '';
  G('f_manual').value = d ? (d.manualStatus || '') : '';
  G('f_status').value = d ? d.status : '';
  G('f_req').value = d ? d.requirements : '';
  G('f_imp').value = d ? d.improvement : '';
  G('f_note').value = d ? (d.note || '') : '';
  reqFilesState = d && Array.isArray(d.requirementFiles) ? d.requirementFiles.slice() : [];
  fbState = d && Array.isArray(d.feedbacks) ? JSON.parse(JSON.stringify(d.feedbacks)) : [];
  renderReqFiles(); renderFbRows();
  G('formMsg').textContent = '';
}
function openForm(){ const b = G('formModalBg'); if (b) b.classList.add('open'); }
function closeForm(){ const b = G('formModalBg'); if (b) b.classList.remove('open'); }
function openAdd(){ setForm(null); G('panelTitle').textContent = 'Add dashboard'; G('saveBtn').textContent = 'Save dashboard'; openForm(); G('f_name').focus(); }
function openEdit(id){
  const d = DATA.dashboards.find(x => x.id === id);
  if (!d) return;
  closeDrawer();
  setForm(d);
  G('panelTitle').textContent = 'Edit · ' + (d.serial ? '#'+d.serial+' ' : '') + d.name;
  G('saveBtn').textContent = 'Save changes';
  openForm();
}

if (CFG.manualEnabled){
  G('addToggle').onclick = openAdd;
  G('cancelBtn').onclick = closeForm;
  G('formX').onclick = closeForm;
  G('addClientRow').onclick = () => { setClients(getClients().concat('')); G('clientRows').lastElementChild.querySelector('.f_client').focus(); };
  G('addLinkRow').onclick = () => {
    const cur = getLinks();
    const nextLabel = DEFAULT_LINK_LABELS[cur.length] || '';
    setLinks(cur.concat({ label: nextLabel, url:'' }));
    G('linkRows').lastElementChild.querySelector('.f_lurl').focus();
  };
  G('addReqFile').onclick = async () => { const ups = await uploadFiles(); if (ups.length){ reqFilesState.push(...ups); renderReqFiles(); } };
  G('addFb').onclick = () => { syncFbFromDom(); fbState.push({ id:'fb'+Date.now(), category:'', label:'Feedback '+(fbState.length+1), date:'', text:'', link:'', files:[], implemented:false }); renderFbRows(); };
  G('formModalBg').addEventListener('click', (e) => { if (e.target === G('formModalBg')) closeForm(); });
  G('saveBtn').onclick = async () => {
    const msg = G('formMsg');
    const id = G('f_id').value;
    const links = getLinks();
    const body = {
      name: G('f_name').value,
      customer: getClients().join(' & '),
      owner: G('f_owner').value,
      stage: G('f_stage').value,
      liveRaw: G('f_live').value,
      links,
      meetingUrl: links[0] ? links[0].url : '',
      status: G('f_status').value,
      requirements: G('f_req').value,
      improvement: G('f_imp').value,
      note: G('f_note').value,
      dueDate: G('f_due').value,
      manualStatus: G('f_manual').value,
      requirementFiles: reqFilesState,
      feedbacks: getFeedbacks(),
    };
    if (!body.name.trim()){ msg.className='msg err'; msg.textContent='Name is required.'; return; }
    // New dashboard with no owner → auto-assign to the lightest-loaded teammate.
    let autoOwner = '';
    if (!id && !body.owner.trim()){ const a = (typeof recommendOwner==='function') ? recommendOwner({}) : ''; if (a){ body.owner = a; autoOwner = a; } }
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
  const sa = G('standaloneBtn');
  if (sa) sa.onclick = async () => {
    if (!confirm('Import all dashboards from the Google Sheet into the app and stop reading the sheet?\\n\\nAfter this, every card is editable here and the sheet is no longer used. (You can still keep the sheet as a backup.)')) return;
    sa.disabled = true; sa.textContent = 'Importing…';
    const res = await api('POST', '/api/import');
    const e = await res.json().catch(()=>({}));
    if (res.ok){ alert('Imported '+e.imported+' dashboards. You are now standalone — the Google Sheet is no longer read.'); location.reload(); }
    else { sa.disabled = false; sa.textContent = '⤓ Go standalone'; alert('Import failed: '+(e.error||res.status)); }
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
function ownerTodos(name){
  const out = [];
  DATA.dashboards.filter(d => d.owner === name).forEach(d => (d.feedbacks||[]).forEach(f => out.push({ d, f })));
  return out;
}
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
function ownerBodyHtml(name, s){
  if (ownerSub === 'work'){
    return statRow(s) + \`<div class="bar">\${stateBar(s.c,s.total)}</div>\`
      + (s.clients.length?\`<div class="section-t">Clients</div><div class="chips">\${s.clients.map(c=>clientTag(c).replace('data-customer','data-jump-customer')).join('')}</div>\`:'')
      + sectionsHtml(s, d => esc(d.customers.join(', '))+(d.status&&d.status!=='-'?' — '+esc(d.status):''));
  }
  if (ownerSub === 'todo'){
    const todos = ownerTodos(name);
    if (!todos.length) return '<div class="empty">No feedbacks on this person\\'s dashboards yet.</div>';
    const pending = todos.filter(t=>!t.f.implemented), done = todos.filter(t=>t.f.implemented);
    const row = t => \`<div class="todo">\${CFG.manualEnabled?\`<button class="impl \${t.f.implemented?'yes':'no'}" data-fbtoggle="\${esc(t.d.id)}" data-fbid="\${esc(t.f.id)}">\${t.f.implemented?'✓':'✗'}</button>\`:\`<span class="impl \${t.f.implemented?'yes':'no'}">\${t.f.implemented?'✓':'✗'}</span>\`}<div class="todo-main"><div class="todo-top"><b>\${esc(t.f.label||'Feedback')}</b> <span class="muted">· \${esc(t.d.name)}</span>\${t.f.date?\`<span class="muted"> · \${esc(t.f.date)}</span>\`:''}</div>\${t.f.text?\`<div class="dnote">\${esc(t.f.text)}</div>\`:''}\${t.f.link?\`<a href="\${esc(t.f.link)}" target="_blank" class="lnk">▶ link</a>\`:''}</div><button class="btn ghost sm" data-open="\${esc(t.d.id)}">open</button></div>\`;
    return \`<div class="section-t">Pending (\${pending.length})</div>\${pending.map(row).join('')||'<div class="dnote muted">All caught up 🎉</div>'}\${done.length?\`<div class="section-t">Implemented (\${done.length})</div>\${done.map(row).join('')}\`:''}\`;
  }
  return employeeProfileHtml(name) + employeeTerminalHtml(name);
}
function openOwner(name){ ownerSub = 'work'; renderOwner(name); overlay.classList.add('open'); }
function renderOwner(name){
  const s = ownerStats(name), p = personData(name);
  const pending = ownerTodos(name).filter(t=>!t.f.implemented).length;
  drawer.innerHTML = \`
    <div class="drawer-head">
      <div><button class="back" id="drawerBack">‹ Team</button>
      <div class="av-head">\${avatar(name,'lg')}<div><h2>\${esc(name)}</h2>
      <div class="sub">\${esc(p.role||'Team member')} · \${s.total} dashboard\${s.total!==1?'s':''}</div></div></div></div>
      <button class="x" id="drawerX">×</button>
    </div>
    <nav class="subtabs">
      <button class="subtab \${ownerSub==='work'?'on':''}" data-sub="work">📋 Dashboards (\${s.total})</button>
      <button class="subtab \${ownerSub==='todo'?'on':''}" data-sub="todo">✅ To-do\${pending?' ('+pending+')':''}</button>
      <button class="subtab \${ownerSub==='attendance'?'on':''}" data-sub="attendance">🗓 Attendance & profile</button>
    </nav>
    <div class="drawer-body">\${ownerBodyHtml(name, s)}</div>\`;
  document.getElementById('drawerX').onclick = closeDrawer;
  document.getElementById('drawerBack').onclick = () => { closeDrawer(); switchTab('team'); };
  drawer.querySelectorAll('.subtab').forEach(b => b.onclick = () => { ownerSub = b.dataset.sub; renderOwner(name); });
  drawer.querySelectorAll('[data-jump-customer]').forEach(b => b.onclick = () => openClient(b.dataset.jumpCustomer));
  drawer.querySelectorAll('[data-states]').forEach(b => b.onclick = () => applyFilter({ owner:name, states:b.dataset.states.split(' ') }));
  drawer.querySelectorAll('[data-open]').forEach(b => b.onclick = (e) => { if (e.target.closest('a.dlink')) return; closeDrawer(); openDetail(b.dataset.open); });
  drawer.querySelectorAll('[data-fbtoggle]').forEach(el => el.onclick = async () => {
    const d = DATA.dashboards.find(x=>x.id===el.dataset.fbtoggle), f = (d.feedbacks||[]).find(x=>x.id===el.dataset.fbid); if(!f) return;
    const res = await api('POST','/api/feedback',{ id:el.dataset.fbtoggle, fbId:el.dataset.fbid, implemented:!f.implemented });
    if (res.ok){ f.implemented=!f.implemented; renderOwner(name); } else alert('Failed.');
  });
  if (ownerSub === 'attendance'){ wireEmployee(name); wireEmployeeProfile(name); }
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
  const ed = CFG.manualEnabled;
  const logo = det.logo ? \`<img class="clogo lg" src="/api/file?id=\${esc(det.logo)}" alt="">\` : \`<span class="avatar lg" style="background:\${nameColor('c·'+name)}">🏢</span>\`;
  const pf = (id,label,v,ph) => \`<label class="pf"><span>\${label}</span><input id="\${id}" value="\${esc(v||'')}" placeholder="\${ph||''}" \${ed?'':'disabled'}></label>\`;
  drawer.innerHTML = \`
    <div class="drawer-head">
      <div><button class="back" id="drawerBack">‹ Clients</button>
      <div class="av-head">\${logo}<div><h2>\${esc(name)}</h2>
      <div class="sub">\${s.total} dashboard\${s.total!==1?'s':''} · \${s.people.length} on the team</div></div></div></div>
      <button class="x" id="drawerX">×</button>
    </div>
    <div class="drawer-body">
      <div class="emp"><div class="section-t">Client details</div>
        <div class="pf-grid">
          \${pf('cl_poc','Point of contact', det.poc)}
          \${pf('cl_emails','Emails', Array.isArray(det.emails)?det.emails.join(', '):det.emails, 'comma separated')}
          \${pf('cl_freq','Meeting frequency', det.meetingFreq, 'e.g. Every Thursday 4pm')}
          \${pf('cl_web','Website', det.website)}
          <label class="pf wide"><span>Notes</span><input id="cl_notes" value="\${esc(det.notes||'')}" \${ed?'':'disabled'}></label>
        </div>
        \${ed?'<div class="pf-actions"><button class="btn ghost sm" id="clLogo" type="button">🖼 Upload logo</button><button class="btn sm" id="clSave">Save details</button></div>':''}
      </div>
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
  if (ed){
    document.getElementById('clSave').onclick = async () => {
      const emails = val('cl_emails').split(',').map(x=>x.trim()).filter(Boolean);
      const res = await api('POST','/api/client',{ name, poc:val('cl_poc'), emails, meetingFreq:val('cl_freq'), website:val('cl_web'), notes:val('cl_notes') });
      if (res.ok){ DATA.clientDetails[name] = (await res.json()).client; const b=document.getElementById('clSave'); b.textContent='Saved ✓'; setTimeout(()=>b.textContent='Save details',1500); } else alert('Save failed.');
    };
    document.getElementById('clLogo').onclick = async () => {
      const up = await uploadFile(); if (!up) return;
      const res = await api('POST','/api/client',{ name, logo:up.id });
      if (res.ok){ DATA.clientDetails[name] = (await res.json()).client; openClient(name); }
    };
  }
}

// ── Team & Clients tabs ────────────────────────────────────────────────────
function rosterDelete(type, name, total){
  return async (e) => {
    e.stopPropagation();
    const what = type === 'owner' ? 'team member' : 'client';
    const warn = total > 0
      ? \`Delete \${what} "\${name}"?\\n\\nOn \${total} dashboard\${total!==1?'s':''}. \${type==='owner'?'Those become Unassigned.':'Removed from those dashboards.'}\`
      : \`Delete \${what} "\${name}"?\`;
    if (!confirm(warn)) return;
    const res = await api('DELETE', \`/api/roster?type=\${type}&name=\${encodeURIComponent(name)}\`);
    if (res.ok) location.reload(); else alert('Failed: '+((await res.json()).error||res.status));
  };
}
function renderTeamTab(){
  const el = G('tab-team');
  const add = CFG.manualEnabled ? \`<div class="roster-add"><input id="memInput" placeholder="New team member name…"><button class="btn" id="memAdd">+ Add member</button></div>\` : '';
  const cards = DATA.owners.map(name => {
    const s = ownerStats(name), p = (DATA.people&&DATA.people[name])||{};
    const pend = ownerTodos(name).filter(t=>!t.f.implemented).length;
    return \`<div class="profile-card" data-member="\${esc(name)}">
      \${CFG.manualEnabled?\`<button class="rm" data-rmown="\${esc(name)}" data-total="\${s.total}" title="Delete">×</button>\`:''}
      <div class="pc-head">\${avatar(name,'lg')}<div><div class="pc-name">\${esc(name)}</div><div class="pc-role">\${esc(p.role||'Team member')}</div></div></div>
      <div class="pc-stats"><span><b>\${s.total}</b> dashboards</span><span><b>\${s.completed}</b> done</span>\${pend?\`<span class="warnpill">\${pend} to-do</span>\`:''}</div>
      <div class="bar" style="margin-top:8px">\${stateBar(s.c,s.total)}</div>
    </div>\`;
  }).join('');
  el.innerHTML = \`<div class="tabhead"><h2>👤 Team</h2><div class="sub">\${DATA.owners.length} members · open anyone for profile, attendance & to-dos</div></div>\${add}<div class="profile-grid">\${cards||'<div class="empty">No team members yet.</div>'}</div>\`;
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
      <div class="pc-stats"><span><b>\${s.total}</b> dashboards</span><span><b>\${s.completed}</b> done</span>\${det.meetingFreq?\`<span>🗓 \${esc(det.meetingFreq)}</span>\`:''}</div>
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
      <div class="dh-actions">\${fbs.length?'<button class="btn ghost sm" id="dPdf" title="Generate the client-ready Build Update PDF from the feedbacks below">📑 Build update PDF</button>':''}\${(fbs.length&&CFG.manualEnabled)?'<button class="btn ghost sm" id="dMail" title="Email the Build Update summary via the Muns API">📧 Email update</button>':''}\${editable?'<button class="btn sm" id="dEdit">✎ Edit</button>':''}\${CFG.manualEnabled?'<button class="btn ghost sm" id="dUpd">＋ Update</button>':''}<button class="x" id="dX">×</button></div>
    </div>
    <div class="modal-body dbody">
      <div class="dprog"><div class="prog-top"><span class="prog-stage" style="color:\${s.color}">Stage \${cur+1}/\${STATES.length} · \${s.label}</span><span class="prog-pct">\${pct}%</span></div><div class="prog-track">\${STATES.map((x,i)=>\`<i class="seg \${i<=cur?'on':''}" style="\${i<=cur?'background:'+s.color:''}" title="\${i+1}. \${x.label}"></i>\`).join('')}</div></div>
      <div class="dgrid">
        \${factCell('Owner', esc(d.owner))}
        \${factCell('Client(s)', esc(d.customer))}
        \${factCell('Due date', d.dueDate?esc(d.dueDate):'—')}
        \${factCell('Priority', d.priorityLevel?('P'+d.priorityLevel):'—')}
        \${factCell('Live on Munshot', d.isLive?'Yes':'No')}
        \${factCell('Last updated', d.lastUpdated?esc(d.lastUpdated):'—')}
      </div>
      \${d.manualStatus?\`<div class="dsec"><h4>Manual status</h4><div class="dnote big">\${esc(d.manualStatus)}</div></div>\`:''}
      \${d.status&&d.status!=='-'?\`<div class="dsec"><h4>Current status note</h4><div class="dnote">\${esc(d.status)}</div></div>\`:''}
      \${(d.requirements||(d.requirementFiles&&d.requirementFiles.length))?\`<div class="dsec"><h4>Original client requirement</h4>\${d.requirements?\`<div class="dnote">\${esc(d.requirements)}</div>\`:''}<div class="thumbs">\${fileGrid(d.requirementFiles)}</div></div>\`:''}
      \${links.length?\`<div class="dsec"><h4>Meetings & links</h4><div class="dlinks">\${links.map(l=>\`<a href="\${esc(l.url)}" target="_blank" rel="noopener" class="lnk">▶ \${esc(l.label)}</a>\`).join('')}</div></div>\`:''}
      <div class="dsec"><h4>Feedbacks (\${fbs.length})</h4>\${fbs.length?fbs.map(f=>fbView(d.id,f,editable)).join(''):'<div class="dnote muted">No feedback logged yet.</div>'}</div>
      \${d.improvement&&d.improvement!=='-'?\`<div class="dsec"><h4>Improvements</h4><div class="dnote">\${esc(d.improvement)}</div></div>\`:''}
      \${d.note?\`<div class="dsec"><h4>Notes</h4><div class="dnote">\${esc(d.note)}</div></div>\`:''}
    </div>\`;
  detailBg.classList.add('open');
  G('dX').onclick = closeDetail;
  if (editable) G('dEdit').onclick = () => { closeDetail(); openEdit(id); };
  const up = document.getElementById('dUpd'); if (up) up.onclick = () => { closeDetail(); openUpdate(id, d.name); };
  const pdfBtn = document.getElementById('dPdf'); if (pdfBtn) pdfBtn.onclick = () => genBuildUpdate(id, pdfBtn);
  const mailBtn = document.getElementById('dMail'); if (mailBtn) mailBtn.onclick = () => emailBuildUpdate(id, mailBtn);
  detailModal.querySelectorAll('[data-owner]').forEach(b => b.onclick = () => { closeDetail(); openOwner(b.dataset.owner); });
  detailModal.querySelectorAll('[data-customer]').forEach(b => b.onclick = () => { closeDetail(); openClient(b.dataset.customer); });
  detailModal.querySelectorAll('[data-fbtoggle]').forEach(el => el.onclick = async () => {
    const f = (d.feedbacks||[]).find(x => x.id === el.dataset.fbid); if (!f) return;
    const res = await api('POST','/api/feedback',{ id, fbId:el.dataset.fbid, implemented:!f.implemented });
    if (res.ok){ f.implemented = !f.implemented; openDetail(id); } else alert('Failed.');
  });
}

// ── Daily status update modal ──────────────────────────────────────────────
const updModalBg = document.getElementById('updModalBg');
const updModal = document.getElementById('updModal');
function closeUpd(){ updModalBg.classList.remove('open'); }
updModalBg.addEventListener('click', (e) => { if (e.target === updModalBg) closeUpd(); });
function openUpdate(id, name){
  const d = DATA.dashboards.find(x => x.id === id) || { updates: [], state: 'not_started', name };
  const log = d.updates || [];
  const opts = STATES.map(x => \`<option value="\${x.id}">\${x.label}</option>\`).join('');
  const tl = log.slice().reverse().map(e => {
    const st = SMAP[e.state];
    return \`<div class="tl-item"><span class="tl-dot" style="background:\${st?st.color:'#ccc'}"></span><div class="tl-main"><div class="tl-date">\${esc(e.date||'')}\${st?' · '+st.label:''}</div>\${e.note?\`<div class="tl-note">\${esc(e.note)}</div>\`:''}</div><button class="tl-del" data-ts="\${e.ts}" title="Remove">×</button></div>\`;
  }).join('') || '<div class="tl-date">No updates yet — add your first below.</div>';
  updModal.innerHTML = \`
    <div class="modal-head"><div><h3>Daily update</h3><div class="sub">\${esc(name||d.name||'')}</div></div><button class="x" id="updX">×</button></div>
    <div class="modal-body">
      <label>Status (sets the card colour)</label>
      <select id="u_state">\${opts}</select>
      <label>What did you do today? (note)</label>
      <textarea id="u_note" placeholder="e.g. Wired live data into the P&amp;L tab; pending QA"></textarea>
      <button class="btn" id="u_save">Post update</button>
      <div class="timeline"><div class="label" style="margin-bottom:6px">History (\${log.length})</div>\${tl}</div>
    </div>\`;
  document.getElementById('u_state').value = d.state || 'not_started';
  updModalBg.classList.add('open');
  document.getElementById('updX').onclick = closeUpd;
  document.getElementById('u_save').onclick = async () => {
    const state = document.getElementById('u_state').value;
    const note = document.getElementById('u_note').value.trim();
    const res = await api('POST', '/api/update', { id, state, note });
    if (res.ok) location.reload(); else alert('Failed: '+((await res.json()).error||res.status));
  };
  updModal.querySelectorAll('.tl-del').forEach(b => b.onclick = async () => {
    if (!confirm('Remove this update?')) return;
    const res = await api('DELETE', \`/api/update?id=\${encodeURIComponent(id)}&ts=\${b.dataset.ts}\`);
    if (res.ok) location.reload();
  });
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
  document.querySelectorAll('#tabs .tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  ['overview','team','clients','assign','checklist'].forEach(t => { G('tab-'+t).hidden = (t !== tab); });
  if (tab === 'team') renderTeamTab();
  if (tab === 'clients') renderClientsTab();
  if (tab === 'assign') renderAssignTab();
  if (tab === 'checklist') renderChecklistTab();
}
// ── Checklist / proof tab: every client feedback as a tick-off item with proof ──
async function toggleFbDone(id, fbId, checked, el){
  const r = await api('POST','/api/feedback',{ id, fbId, implemented: checked });
  if (!r.ok){ alert('Could not update.'); if(el) el.checked = !checked; return; }
  const d = DATA.dashboards.find(x=>x.id===id); if(d){ const f=(d.feedbacks||[]).find(f=>f.id===fbId); if(f) f.implemented=checked; }
  renderChecklistTab();
}
async function addProof(id, fbId){
  const up = await uploadFile(); if (!up) return;
  const r = await api('POST','/api/feedback',{ id, fbId, addFile: up });
  if (!r.ok){ alert('Upload failed.'); return; }
  const j = await r.json().catch(()=>({})); const d = DATA.dashboards.find(x=>x.id===id);
  if (d){ const f=(d.feedbacks||[]).find(f=>f.id===fbId); if(f) f.files = j.files||f.files; }
  renderChecklistTab();
}
async function removeProof(id, fbId, fileId){
  const r = await api('POST','/api/feedback',{ id, fbId, removeFile: fileId });
  if (!r.ok){ alert('Could not remove.'); return; }
  const j = await r.json().catch(()=>({})); const d = DATA.dashboards.find(x=>x.id===id);
  if (d){ const f=(d.feedbacks||[]).find(f=>f.id===fbId); if(f) f.files = j.files||[]; }
  renderChecklistTab();
}
let ckPending = false;
function renderChecklistTab(){
  const el = G('tab-checklist');
  const ed = CFG.manualEnabled;
  // Group every client-requested change (feedback) under its client.
  const groups = {};
  DATA.dashboards.forEach(d => (d.feedbacks||[]).forEach(f => {
    (d.customers && d.customers.length ? d.customers : ['Unassigned']).forEach(cl => { (groups[cl] = groups[cl]||[]).push({ d, f }); });
  }));
  let total = 0, doneAll = 0;
  Object.values(groups).forEach(arr => arr.forEach(x => { total++; if (x.f.implemented) doneAll++; }));
  const pendingAll = total - doneAll;
  const clients = Object.keys(groups).sort((a,b) => (groups[b].filter(x=>!x.f.implemented).length - groups[a].filter(x=>!x.f.implemented).length) || a.localeCompare(b));

  const cards = clients.map(cl => {
    const items = groups[cl], cdone = items.filter(x=>x.f.implemented).length, cpct = items.length?Math.round(cdone/items.length*100):0, cpend = items.length-cdone;
    const shown = ckPending ? items.filter(x=>!x.f.implemented) : items;
    if (!shown.length) return '';
    const rows = shown.map(({d,f}) => {
      const editable = ed && d.source === 'manual';
      const proof = (f.files||[]).map(x => '<span class="pf-chip"><a href="'+esc(x.url||('/api/file?id='+x.id))+'" target="_blank" rel="noopener">'+((x.type||'').startsWith('image/')?'🖼':'📄')+' '+esc((x.name||'proof').slice(0,18))+'</a>'+(editable?'<button class="pf-x" data-rmproof="'+esc(f.id)+'" data-file="'+esc(x.id)+'" data-dash="'+esc(d.id)+'">×</button>':'')+'</span>').join('');
      return '<div class="ck-row'+(f.implemented?' ck-done':'')+'" data-dash="'+esc(d.id)+'">'
        + '<label class="ck-box"><input type="checkbox" '+(f.implemented?'checked':'')+' '+(editable?'':'disabled')+' data-ck="'+esc(f.id)+'"><span class="ck-mark"></span></label>'
        + '<div class="ck-main"><div class="ck-title">'+esc(f.label||'Change')+(f.implemented?'':'<span class="ck-badge">pending</span>')+'</div>'
        + (f.text?'<div class="ck-text">'+esc(f.text)+'</div>':'')
        + '<div class="ck-meta">📊 '+esc(d.name)+' · '+esc(d.owner||'Unassigned')+'</div>'
        + '<div class="ck-proof"><span class="ck-plabel">Proof</span>'+(proof||'<span class="ck-noproof">⚠ not attached</span>')+(editable?'<button class="btn ghost xs" data-addproof="'+esc(f.id)+'" data-dash="'+esc(d.id)+'">📎 attach</button>':'')+'</div></div></div>';
    }).join('');
    const det = (DATA.clientDetails&&DATA.clientDetails[cl])||{};
    const logo = det.logo ? '<img class="clogo" src="/api/file?id='+esc(det.logo)+'" alt="">' : '<span class="avatar" style="background:'+nameColor('c·'+cl)+'">🏢</span>';
    return '<div class="ck-card"><div class="ck-head"><div class="ck-client">'+logo+'<div><div class="ck-name">'+esc(cl)+'</div><div class="ck-sub">'+items.length+' request'+(items.length!==1?'s':'')+'</div></div></div>'
      + '<div class="ck-pct">'+cdone+' of '+items.length+' done'+(cpend?' · <span class="ck-pend">'+cpend+' pending</span>':'')+' <b>'+cpct+'%</b></div></div>'
      + '<div class="ck-bar"><i style="width:'+cpct+'%"></i></div>'+rows+'</div>';
  }).filter(Boolean).join('');

  el.innerHTML = '<div class="tabhead"><h2>📋 Client Requests</h2><div class="sub">Every change each client asked for — who\\'s on it, done or pending, with proof</div></div>'
    + (total ? '<div class="ck-toolbar"><div class="ck-stats"><span><b>'+total+'</b> requests</span><span class="ck-ok"><b>'+doneAll+'</b> done</span><span class="ck-warn"><b>'+pendingAll+'</b> pending</span></div><label class="ck-filter"><input type="checkbox" id="ckPendingOnly" '+(ckPending?'checked':'')+'> show pending only</label></div>' : '')
    + (cards || (total ? '<div class="empty">🎉 Nothing pending — every client request is done.</div>' : '<div class="empty">No client requests yet.<br>Open a dashboard → add a feedback (the client\\'s requested change) → it appears here grouped by client, with proof.</div>'));

  const po = document.getElementById('ckPendingOnly'); if (po) po.onchange = () => { ckPending = po.checked; renderChecklistTab(); };
  if (ed){
    el.querySelectorAll('[data-ck]').forEach(c => c.onchange = () => toggleFbDone(c.closest('.ck-row').dataset.dash, c.dataset.ck, c.checked, c));
    el.querySelectorAll('[data-addproof]').forEach(b => b.onclick = () => addProof(b.dataset.dash, b.dataset.addproof));
    el.querySelectorAll('[data-rmproof]').forEach(b => b.onclick = () => removeProof(b.dataset.dash, b.dataset.rmproof, b.dataset.file));
  }
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
function assignOwners(){ return DATA.owners.filter(o => o && o!=='Unassigned'); }
function unassignedDashboards(){ return DATA.dashboards.filter(d => !d.owner || d.owner==='Unassigned'); }
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
      <div class="wl-meta">\${active} active · load \${load.toFixed(1)} / \${CAP}</div><div class="wl-bar"><i class="\${cls}" style="width:\${pct}%"></i></div></div>\`;
    }).join('') : '<div class="empty">No team members yet — add them in the Team tab.</div>';
  const rec = planAutoAssign();
  const queue = un.length ? un.slice().sort((a,b)=>(b.priorityLevel-a.priorityLevel)||((a.serial||1e9)-(b.serial||1e9))).map(d => {
    const opts = owners.map(o => \`<option \${o===rec[d.id]?'selected':''}>\${esc(o)}</option>\`).join('');
    const sel = CFG.manualEnabled ? \`<select class="asg-sel">\${opts}</select><button class="btn sm" data-assign="\${esc(d.id)}">Assign</button>\` : \`<span class="wl-pill ok">→ \${esc(rec[d.id]||'—')}</span>\`;
    return \`<div class="asg-row"><div><div class="dn">\${d.priorityLevel?'★ ':''}\${esc(d.name)}</div><div class="dmeta">\${esc(d.customer||'—')} · \${SMAP[d.state]?SMAP[d.state].label:esc(d.state)}</div></div><div class="asg-act">\${sel}</div></div>\`;
  }).join('') : '<div class="empty">Everything is assigned. 🎉</div>';
  el.innerHTML = \`<div class="tabhead"><h2>⚖️ Assign</h2><div class="sub">Workload-balanced · \${un.length} unassigned · least-loaded teammate gets the next one</div></div>
    \${CFG.manualEnabled && un.length ? \`<div class="roster-add"><button class="btn" id="autoAll">⚡ Auto-assign all \${un.length}</button><span class="sub" style="align-self:center">picks the lightest plate for each dashboard</span></div>\` : ''}
    <div class="section-t">Team workload</div><div class="wl-grid">\${board}</div>
    <div class="section-t" style="margin-top:18px">Unassigned dashboards</div>\${queue}\`;
  if (CFG.manualEnabled){
    const aa = G('autoAll'); if (aa) aa.onclick = () => autoAssignAll(aa);
    el.querySelectorAll('[data-assign]').forEach(b => b.onclick = () => { const row=b.closest('.asg-row'), sel=row.querySelector('.asg-sel'); assignOne(b.dataset.assign, sel?sel.value:''); });
  }
}
document.querySelectorAll('#tabs .tab').forEach(b => b.onclick = () => switchTab(b.dataset.tab));

// Click a card → open its detail modal (buttons/chips handled first).
document.getElementById('grid').addEventListener('click', (e) => {
  const p = e.target.closest('[data-prio]'); if (p){ togglePriority(p.dataset.prio); return; }
  const u = e.target.closest('[data-update]'); if (u){ openUpdate(u.dataset.update, u.dataset.name); return; }
  const ed = e.target.closest('[data-edit]'); if (ed){ openEdit(ed.dataset.edit); return; }
  if (e.target.closest('[data-setstage]') || e.target.closest('[data-del]')) return;
  const o = e.target.closest('[data-owner]'); if (o){ openOwner(o.dataset.owner); return; }
  const c = e.target.closest('[data-customer]'); if (c){ openClient(c.dataset.customer); return; }
  const a = e.target.closest('a'); if (a) return; // let links work
  const card = e.target.closest('[data-card]'); if (card){ openDetail(card.dataset.card); }
});
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
  ws.mergeCells('B3:F3'); set('B3', 'Status report · generated ' + new Date().toLocaleString('en-GB', { hour12:false }) + (CFG.standalone ? '  ·  standalone' : ''), { size:11, color:{ argb:'FF6B7280' } });

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
document.getElementById('themeToggle').onclick = () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next); applyTheme(next);
};
document.getElementById('prioToggle').onclick = () => {
  prioOnly = !prioOnly;
  if (prioOnly){ stateFilter.clear(); liveOnlyEl().checked = false; }
  render();
};
renderInsights();
render();
</script>
</body>
</html>`;
}
