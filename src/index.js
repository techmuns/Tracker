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

async function getDataset(env) {
  const [manual, roster, updates, people, config] = await Promise.all([
    readManual(env), readRoster(env), readUpdates(env), readPeople(env), readConfig(env),
  ]);
  // Standalone mode: serve purely from KV, never touch the Google Sheet.
  let rows = [];
  if (!config.standalone) {
    if (!env.CSV_URL) throw new Error('CSV_URL is not configured');
    const res = await fetch(env.CSV_URL, { cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true } });
    if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
    rows = parseCsv(await res.text());
  }
  return buildDataset(rows, manual, { roster, updates, people, standalone: !!config.standalone });
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
            status: body.status || '',
            requirements: body.requirements || '',
            improvement: body.improvement || '',
            feedback: body.feedback || '',
            meetingUrl: body.meetingUrl || '',
            lastUpdated: body.lastUpdated || new Date().toLocaleDateString('en-GB'),
            note: body.note || '',
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
          const FIELDS = ['name', 'customer', 'owner', 'liveRaw', 'status', 'requirements', 'improvement', 'feedback', 'meetingUrl', 'lastUpdated', 'note'];
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

      // ── Person / employee terminal API ──────────────────────────────────
      if (pathname === '/api/person') {
        if (!env.MANUAL) return json({ error: 'Storage not enabled.' }, 503);
        if (!authorized(request, env)) return json({ error: 'Unauthorized.' }, 401);
        if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
        const body = await request.json().catch(() => ({}));
        const name = String(body.name || '').trim();
        if (!name) return json({ error: 'name is required.' }, 400);
        const people = await readPeople(env);
        const p = people[name] || { joinDate: '', days: {} };
        if ('joinDate' in body) p.joinDate = String(body.joinDate || '');
        if ('role' in body) p.role = String(body.role || '');
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
          const name = url.searchParams.get('name');
          roster[key] = roster[key].filter((n) => n !== name);
          await writeRoster(env, roster);
          return json({ ok: true, roster });
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
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; padding:18px 28px 4px; }
  .kpi { position:relative; background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); padding:14px 16px; box-shadow:var(--shadow); overflow:hidden; cursor:pointer; transition:transform .14s,box-shadow .14s,border-color .14s; }
  .kpi:hover { transform:translateY(-2px); box-shadow:var(--shadow-md); border-color:var(--kc,var(--accent)); }
  .kpi.off { opacity:.5; }
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
      <button class="btn ghost" id="teamToggle">👤 Team</button>
      <button class="btn ghost" id="clientsToggle">🏢 Clients</button>
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
  <div class="legend" id="legend"></div>
</header>
<div class="kpis" id="kpis"></div>
<div class="insights" id="insights"></div>

${opts.manualEnabled ? `
<div class="panel" id="panel">
  <div class="panel-title" id="panelTitle">Add dashboard</div>
  <input type="hidden" id="f_id">
  <div class="form-grid">
    <label>Dashboard name *<input id="f_name" placeholder="e.g. Revenue Tracker"></label>
    <label>Customer<input id="f_customer" list="customers" placeholder="e.g. Beas Capital"></label>
    <label>Assigned to<input id="f_owner" list="owners" placeholder="e.g. Vipul"></label>
    <label>Live status<select id="f_live"><option value="Not Live">Not Live</option><option value="Live on Munshot">Live on Munshot</option></select></label>
    <label>Status (drives the colour)<input id="f_status" placeholder="e.g. Almost completed, needs QA"></label>
    <label>Meeting link (URL)<input id="f_meeting" placeholder="https://…"></label>
    <label>Client requirements<input id="f_req" placeholder="optional"></label>
    <label>Improvements<input id="f_imp" placeholder="optional"></label>
    <label>Feedback<input id="f_feedback" placeholder="optional"></label>
    <label>Notes<input id="f_note" placeholder="optional"></label>
  </div>
  <div class="panel-actions">
    <button class="btn" id="saveBtn">Save dashboard</button>
    <button class="btn ghost" id="cancelBtn">Cancel</button>
    <span class="msg" id="formMsg"></span>
  </div>
</div>
<datalist id="customers">${data.customers.map((c) => `<option value="${escapeHtml(c)}">`).join('')}</datalist>
<datalist id="owners">${data.owners.map((o) => `<option value="${escapeHtml(o)}">`).join('')}</datalist>
` : ''}

${data.gaps.length && !opts.standalone ? `<div class="warn">Note: sheet serial numbers ${data.gaps.join(', ')} are missing (likely deleted rows). ${data.sheetCount} sheet entries counted.</div>` : ''}

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

<div class="overlay" id="overlay"><div class="drawer" id="drawer"></div></div>
<div class="modal-bg" id="updModalBg"><div class="modal" id="updModal"></div></div>

<script>
const DATA = ${payload};
const STATES = ${statesJson};
const CFG = ${cfg};
const SMAP = Object.fromEntries(STATES.map(s => [s.id, s]));
const hidden = new Set();

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
  el.innerHTML = STATES.map(s =>
    \`<span class="pill \${hidden.has(s.id)?'off':''}" data-id="\${s.id}"><span class="dot" style="background:\${s.color}"></span>\${s.label} <span class="n">\${DATA.counts[s.id]||0}</span></span>\`
  ).join('');
  el.querySelectorAll('.pill').forEach(p => p.onclick = () => {
    const id = p.dataset.id; hidden.has(id) ? hidden.delete(id) : hidden.add(id); render();
  });
}

function card(d){
  const s = SMAP[d.state];
  const fields = [['Requirements',d.requirements],['Improvements',d.improvement],['Feedback',d.feedback]].filter(([,v]) => v && v !== '-');
  const meeting = d.meetingUrl ? \`<a href="\${esc(d.meetingUrl)}" target="_blank" rel="noopener">▶ Recording / link</a>\`
                : d.meetingNote ? \`<span>\${esc(d.meetingNote)}</span>\` : '';
  const title = d.serial ? '#'+d.serial+' · '+esc(d.name) : esc(d.name);
  const editable = d.source==='manual' && CFG.manualEnabled;
  const showManualTag = d.source==='manual' && !CFG.standalone; // once standalone, every card is "manual" — no point flagging it
  const cardBtns = editable ? \`<div class="cardbtns"><button class="edit" title="Edit" data-edit="\${esc(d.id)}">✎</button><button class="del" title="Delete" data-del="\${esc(d.id)}">×</button></div>\` : '';
  return \`<div class="card \${showManualTag?'manual':''}" style="--cardc:\${s.color}">
    \${cardBtns}
    <h3>\${title}</h3>
    <div class="meta">
      <span class="tag state" style="color:\${s.color};background:color-mix(in srgb, \${s.color} 13%, transparent);border-color:color-mix(in srgb, \${s.color} 28%, transparent)">\${s.label}</span>
      \${d.isLive ? '<span class="tag live">● Live on Munshot</span>' : ''}
      \${d.customers.map(c => clientTag(c)).join('')}
      \${ownerTag(d.owner)}
      \${showManualTag ? '<span class="tag src">Manual</span>' : ''}
    </div>
    \${d.status && d.status!=='-' ? \`<div class="status"><span class="label">Status</span><br>\${esc(d.status)}</div>\` : ''}
    \${fields.map(([k,v]) => \`<div class="field"><span class="label">\${k}</span><div class="val">\${esc(v)}</div></div>\`).join('')}
    \${d.updates && d.updates.length ? \`<div class="upd"><span class="label">Latest update · \${esc(d.updates[d.updates.length-1].date||'')}</span><div class="val">\${esc(d.updates[d.updates.length-1].note || SMAP[d.updates[d.updates.length-1].state]?.label || '')}</div></div>\` : ''}
    <div class="foot">
      <span>\${meeting}</span>
      \${CFG.manualEnabled ? \`<button class="upd-btn" data-update="\${esc(d.id)}" data-name="\${esc(d.name)}">＋ Update\${d.updates&&d.updates.length?' ('+d.updates.length+')':''}</button>\` : \`<span>\${d.lastUpdated ? 'Updated '+esc(d.lastUpdated) : ''}</span>\`}
    </div>
  </div>\`;
}

// ── KPI hero ───────────────────────────────────────────────────────────────
const KPI_ICONS = { live:'🚀', done:'✅', review:'🔍', in_progress:'⚙️', blocked:'⛔', not_started:'⏳' };
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
function renderKpis(){
  const el = document.getElementById('kpis'); if (!el) return;
  const tiles = [{ id:'__all', label:'Total dashboards', n:DATA.total, color:'var(--accent)', icon:'📊' }]
    .concat(STATES.map(s => ({ id:s.id, label:s.label, n:DATA.counts[s.id]||0, color:s.color, icon:KPI_ICONS[s.id]||'•' })));
  el.innerHTML = tiles.map(t => \`<div class="kpi \${t.id!=='__all'&&hidden.has(t.id)?'off':''}" data-kpi="\${t.id}" style="--kc:\${t.color}">
      <div class="ic">\${t.icon}</div><div class="n" data-count="\${t.n}">0</div><div class="l">\${esc(t.label)}</div><div class="spark"></div>
    </div>\`).join('');
  el.querySelectorAll('[data-kpi]').forEach(k => k.onclick = () => {
    const id = k.dataset.kpi;
    if (id === '__all'){ hidden.clear(); document.getElementById('q').value=''; document.getElementById('customer').value=''; document.getElementById('owner').value=''; document.getElementById('liveonly').checked=false; }
    else { hidden.has(id) ? hidden.delete(id) : hidden.add(id); }
    renderLegend(); render();
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
    el.querySelectorAll('[data-leg]').forEach(li => li.onclick = () => { const id = li.dataset.leg; hidden.has(id)?hidden.delete(id):hidden.add(id); renderLegend(); render(); });
    el.querySelectorAll('[data-bc-owner]').forEach(b => b.onclick = () => openOwner(b.getAttribute('data-bc-owner')));
    el.querySelectorAll('[data-bc-customer]').forEach(b => b.onclick = () => openClient(b.getAttribute('data-bc-customer')));
  }
}

function render(){
  renderKpis();
  const q = document.getElementById('q').value.trim().toLowerCase();
  const cust = document.getElementById('customer').value;
  const own = document.getElementById('owner').value;
  const groupby = document.getElementById('groupby').value;
  const liveonly = document.getElementById('liveonly').checked;

  let list = DATA.dashboards.filter(d => {
    if (hidden.has(d.state)) return false;
    if (cust && !d.customers.includes(cust)) return false;
    if (own && d.owner !== own) return false;
    if (liveonly && !d.isLive) return false;
    if (q){
      const hay = (d.name+' '+d.status+' '+d.requirements+' '+d.improvement+' '+d.feedback+' '+d.customer+' '+d.owner).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const grid = document.getElementById('grid');
  if (!list.length){ grid.innerHTML = '<div class="empty">No dashboards match these filters.</div>'; bindDelete(); return; }

  if (!groupby){ grid.innerHTML = list.map(card).join(''); bindDelete(); return; }
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
  grid.innerHTML = groups.map(([t,items]) => \`<div class="group-h">\${esc(t)} · \${items.length}</div>\` + items.map(card).join('')).join('');
  bindDelete();
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
function bindCardButtons(){
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this dashboard?')) return;
    const res = await api('DELETE', '/api/manual?id='+encodeURIComponent(b.dataset.del));
    if (res.ok) location.reload(); else alert('Delete failed: '+(await res.json()).error);
  });
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openEdit(b.dataset.edit));
}
const bindDelete = bindCardButtons; // back-compat for render()

const G = (id) => document.getElementById(id);
function setForm(d){
  G('f_id').value = d ? d.id : '';
  G('f_name').value = d ? d.name : '';
  G('f_customer').value = d ? d.customer : '';
  G('f_owner').value = d ? d.owner : '';
  G('f_live').value = d && d.isLive ? 'Live on Munshot' : 'Not Live';
  G('f_status').value = d ? d.status : '';
  G('f_meeting').value = d ? (d.meetingUrl || '') : '';
  G('f_req').value = d ? d.requirements : '';
  G('f_imp').value = d ? d.improvement : '';
  G('f_feedback').value = d ? d.feedback : '';
  G('f_note').value = d ? (d.note || '') : '';
  G('formMsg').textContent = '';
}
function openAdd(){ setForm(null); G('panelTitle').textContent = 'Add dashboard'; G('saveBtn').textContent = 'Save dashboard'; G('panel').classList.add('open'); window.scrollTo({top:0,behavior:'smooth'}); }
function openEdit(id){
  const d = DATA.dashboards.find(x => x.id === id);
  if (!d) return;
  closeDrawer();
  setForm(d);
  G('panelTitle').textContent = 'Edit · ' + (d.serial ? '#'+d.serial+' ' : '') + d.name;
  G('saveBtn').textContent = 'Save changes';
  G('panel').classList.add('open');
  window.scrollTo({top:0,behavior:'smooth'});
}

if (CFG.manualEnabled){
  const panel = G('panel');
  G('addToggle').onclick = () => { if (panel.classList.contains('open')) panel.classList.remove('open'); else openAdd(); };
  G('cancelBtn').onclick = () => panel.classList.remove('open');
  G('saveBtn').onclick = async () => {
    const msg = G('formMsg');
    const id = G('f_id').value;
    const body = {
      name: G('f_name').value,
      customer: G('f_customer').value,
      owner: G('f_owner').value,
      liveRaw: G('f_live').value,
      status: G('f_status').value,
      meetingUrl: G('f_meeting').value,
      requirements: G('f_req').value,
      improvement: G('f_imp').value,
      feedback: G('f_feedback').value,
      note: G('f_note').value,
    };
    if (!body.name.trim()){ msg.className='msg err'; msg.textContent='Name is required.'; return; }
    msg.className='msg'; msg.textContent='Saving…';
    const res = id ? await api('PUT', '/api/manual', { id, ...body }) : await api('POST', '/api/manual', body);
    if (res.ok){ msg.className='msg ok'; msg.textContent='Saved.'; location.reload(); }
    else { const e = await res.json().catch(()=>({})); msg.className='msg err'; msg.textContent='Error: '+(e.error||res.status); }
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
function rollup(list){
  const byState = Object.fromEntries(STATES.map(s => [s.id, list.filter(d => d.state === s.id)]));
  const c = Object.fromEntries(STATES.map(s => [s.id, byState[s.id].length]));
  return {
    list, byState, c, total: list.length,
    completed: c.live + c.done,        // shipped or finished our side
    active: c.review + c.in_progress,  // in flight
    pending: c.not_started,            // not started yet
    blocked: c.blocked,                // stuck / on hold
  };
}
function ownerStats(name){ const s = rollup(DATA.dashboards.filter(d => d.owner === name)); s.clients = [...new Set(s.list.flatMap(d => d.customers))].sort(); return s; }
function clientStats(name){ const s = rollup(DATA.dashboards.filter(d => d.customers.includes(name))); s.people = [...new Set(s.list.map(d => d.owner))].sort(); return s; }

function stateBar(c, total){ return STATES.filter(x => c[x.id]).map(x => \`<i style="width:\${(c[x.id]/total*100)}%;background:\${x.color}" title="\${x.label}: \${c[x.id]}"></i>\`).join(''); }
function statCard(num, lbl, color, states){
  return \`<div class="stat" \${num?\`data-states="\${states}"\`:''}><div class="num" style="color:\${num?color:'var(--muted)'}">\${num}</div><div class="lbl">\${lbl}</div></div>\`;
}
function statRow(s){
  return \`<div class="stat-row">\${statCard(s.completed,'Completed','#16a34a','live done')}\${statCard(s.active,'Active','#f97316','review in_progress')}\${statCard(s.pending,'Pending','#9ca3af','not_started')}\${statCard(s.blocked,'Blocked','#ef4444','blocked')}</div>\`;
}
function sectionsHtml(s, metaFn){
  return STATES.filter(x => s.byState[x.id].length).map(x => {
    const rows = s.byState[x.id].map(d => \`<div class="drow"><span class="sn">\${d.serial?('#'+d.serial):'•'}</span><div><div class="dn">\${esc(d.name)}</div><div class="dmeta">\${metaFn(d)}</div></div></div>\`).join('');
    return \`<div class="section-t clk" data-states="\${x.id}"><span class="dot" style="background:\${x.color}"></span>\${x.label} · \${s.c[x.id]}</div>\${rows}\`;
  }).join('');
}
// Wire up clickable stats / section headers (filter the board) and jump-chips.
function wireDrawer(ctxKey, ctxName){
  document.getElementById('drawerX').onclick = closeDrawer;
  const back = document.getElementById('drawerBack'); if (back) back.onclick = () => (ctxKey==='owner'?openTeam():openClients());
  drawer.querySelectorAll('[data-states]').forEach(b => b.onclick = () => applyFilter({ [ctxKey]: ctxName, states: b.dataset.states.split(' ') }));
  drawer.querySelectorAll('[data-jump-owner]').forEach(b => b.onclick = () => openOwner(b.dataset.jumpOwner));
  drawer.querySelectorAll('[data-jump-customer]').forEach(b => b.onclick = () => openClient(b.dataset.jumpCustomer));
}

function openOwner(name){
  const s = ownerStats(name);
  drawer.innerHTML = \`
    <div class="drawer-head">
      <div><button class="back" id="drawerBack">‹ Team view</button>
      <div class="av-head">\${avatar(name,'lg')}<div><h2>\${esc(name)}</h2>
      <div class="sub">\${s.total} dashboard\${s.total!==1?'s':''} · \${s.clients.length} client\${s.clients.length!==1?'s':''}</div></div></div></div>
      <button class="x" id="drawerX">×</button>
    </div>
    <div class="drawer-body">
      \${statRow(s)}
      <div class="bar">\${stateBar(s.c,s.total)}</div>
      \${employeeTerminalHtml(name)}
      \${s.clients.length?\`<div class="section-t">Clients</div><div class="chips">\${s.clients.map(c=>clientTag(c).replace('data-customer','data-jump-customer')).join('')}</div>\`:''}
      \${sectionsHtml(s, d => esc(d.customers.join(', '))+(d.status&&d.status!=='-'?' — '+esc(d.status):''))}
    </div>\`;
  overlay.classList.add('open');
  wireDrawer('owner', name);
  wireEmployee(name);
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
  return \`<div class="emp">
    <div class="section-t">Employee terminal</div>
    <div class="emp-stats">
      <div class="emp-stat"><div class="n">\${es.tenure!==''?es.tenure:'—'}</div><div class="l">days since joining</div></div>
      <div class="emp-stat"><div class="n">\${es.present}</div><div class="l">working days logged</div></div>
      <div class="emp-stat"><div class="n">\${es.leave}</div><div class="l">leave days</div></div>
    </div>
    <div class="emp-join"><label>Joined</label><input type="date" id="empJoin" value="\${esc(es.rec.joinDate||'')}" \${editable?'':'disabled'}>\${editable?'<button class="btn sm" id="empJoinSave">Save</button>':''}</div>
    <div class="cal" id="empCal">\${calendarHtml(name)}</div>
  </div>\`;
}
function renderEmp(name){ const el = drawer.querySelector('.emp'); if (el){ el.outerHTML = employeeTerminalHtml(name); wireEmployee(name); } }
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
  drawer.innerHTML = \`
    <div class="drawer-head">
      <div><button class="back" id="drawerBack">‹ Clients view</button>
      <div class="av-head"><span class="avatar lg" style="background:\${nameColor('c·'+name)}">🏢</span><div><h2>\${esc(name)}</h2>
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
  wireDrawer('customer', name);
}

function overview(title, sub, items, jumpAttr, statsFn, rosterType){
  const isOwner = rosterType === 'owner';
  const cards = items.map(name => {
    const s = statsFn(name);
    const rm = (CFG.manualEnabled && s.total===0) ? \`<button class="rm" data-rm="\${esc(name)}" title="Remove">×</button>\` : '';
    const mark = isOwner ? avatar(name,'lg') : \`<span class="avatar lg" style="background:\${nameColor('c·'+name)};border-radius:13px">🏢</span>\`;
    return \`<div class="owner-card" \${jumpAttr}="\${esc(name)}">
      \${rm}<div class="av-head" style="margin-bottom:4px">\${mark}<div class="on">\${esc(name)}</div></div>
      <div class="os">\${s.total} dashboards · \${s.completed} completed · \${s.active} active · \${s.pending} pending\${s.blocked?' · '+s.blocked+' blocked':''}</div>
      <div class="bar" style="margin:8px 0 0">\${stateBar(s.c,s.total)}</div>
    </div>\`;
  }).join('');
  const addRow = (CFG.manualEnabled && rosterType) ? \`<div class="roster-add"><input id="rosterInput" placeholder="Add \${rosterType==='owner'?'team member':'client'} name…"><button class="btn" id="rosterAdd">Add</button></div>\` : '';
  drawer.innerHTML = \`
    <div class="drawer-head"><div><h2>\${title}</h2><div class="sub">\${sub}</div></div><button class="x" id="drawerX">×</button></div>
    <div class="drawer-body">\${addRow}<div class="owner-grid">\${cards}</div></div>\`;
  overlay.classList.add('open');
  document.getElementById('drawerX').onclick = closeDrawer;
  drawer.querySelectorAll('[data-jump-owner]').forEach(el => el.onclick = () => openOwner(el.dataset.jumpOwner));
  drawer.querySelectorAll('[data-jump-customer]').forEach(el => el.onclick = () => openClient(el.dataset.jumpCustomer));
  if (CFG.manualEnabled && rosterType){
    document.getElementById('rosterAdd').onclick = async () => {
      const name = document.getElementById('rosterInput').value.trim();
      if (!name) return;
      const res = await api('POST', '/api/roster', { type: rosterType, name });
      if (res.ok) location.reload(); else alert('Failed: '+((await res.json()).error||res.status));
    };
    drawer.querySelectorAll('[data-rm]').forEach(b => b.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('Remove '+b.dataset.rm+'?')) return;
      const res = await api('DELETE', \`/api/roster?type=\${rosterType}&name=\${encodeURIComponent(b.dataset.rm)}\`);
      if (res.ok) location.reload();
    });
  }
}
function openTeam(){ overview('Team', DATA.owners.length+' people · click anyone for their full track', DATA.owners, 'data-jump-owner', ownerStats, 'owner'); }
function openClients(){ overview('Clients', DATA.customers.length+' clients · click any to see their dashboards & team', DATA.customers, 'data-jump-customer', clientStats, 'customer'); }

// ── Daily status update modal ──────────────────────────────────────────────
const updModalBg = document.getElementById('updModalBg');
const updModal = document.getElementById('updModal');
function closeUpd(){ updModalBg.classList.remove('open'); }
updModalBg.addEventListener('click', (e) => { if (e.target === updModalBg) closeUpd(); });
function openUpdate(id, name){
  const d = DATA.dashboards.find(x => x.id === id) || { updates: [], state: 'in_progress', name };
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
  document.getElementById('u_state').value = d.state || 'in_progress';
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
  document.getElementById('liveonly').checked = false;
  hidden.clear();
  if (states) STATES.forEach(s => { if (!states.includes(s.id)) hidden.add(s.id); });
  renderLegend(); render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.getElementById('teamToggle').onclick = openTeam;
document.getElementById('clientsToggle').onclick = openClients;
// Click an owner/client chip, or the Update button, on any card
document.getElementById('grid').addEventListener('click', (e) => {
  const u = e.target.closest('[data-update]'); if (u){ openUpdate(u.dataset.update, u.dataset.name); return; }
  const o = e.target.closest('[data-owner]'); if (o){ openOwner(o.dataset.owner); return; }
  const c = e.target.closest('[data-customer]'); if (c) openClient(c.dataset.customer);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeUpd(); });

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
const ARGB = { live:'FF22C55E', done:'FF3B82F6', review:'FFEAB308', in_progress:'FFF97316', blocked:'FFEF4444', not_started:'FF9CA3AF' };
const ARGB_SOFT = { live:'FFE7F8EE', done:'FFE8F0FE', review:'FFFEF7E0', in_progress:'FFFDEEE3', blocked:'FFFDE8E8', not_started:'FFF0F1F4' };
const ARGB_TEXT = { live:'FF15803D', done:'FF1D4ED8', review:'FF92670B', in_progress:'FFC2410C', blocked:'FFB91C1C', not_started:'FF4B5563' };
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
  const ws = wb.addWorksheet(uniqueName(wb, base), { views:[{ state:'frozen', ySplit:1 }] });
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
  { header:'State', key:'state', width:15 },
  { header:'Live', key:'live', width:14 },
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
      state: SMAP[d.state].label,
      live: d.isLive ? 'Live on Munshot' : 'No',
      status: d.status,
      req: d.requirements,
      imp: d.improvement,
      fb: d.feedback,
      update: u ? ((u.date?u.date+': ':'') + (u.note || (SMAP[u.state]?SMAP[u.state].label:''))) : '',
      link: d.meetingUrl || d.meetingNote || '',
      lastUpdated: d.lastUpdated,
      source: d.source,
    });
    row.getCell(6)._stateId = d.state; // tag State cell for colouring
  });
}
// Build a detail sheet with per-sheet sequential numbering (1,2,3…).
function detailSheet(wb, base, list){
  const ws = wb.addWorksheet(uniqueName(wb, base), { views:[{ state:'frozen', ySplit:1 }] });
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
  { header:'Active', key:'active', width:9, num:true },
  { header:'Pending', key:'pending', width:9, num:true },
  { header:'Blocked', key:'blocked', width:9, num:true },
  { header:'Live', key:'live', width:7, num:true },
  { header:'Done', key:'done', width:7, num:true },
  { header:'In Review', key:'review', width:10, num:true },
  { header:'In Progress', key:'inprog', width:11, num:true },
  { header:'Not Started', key:'notstarted', width:11, num:true },
  { header:lastHeader, key:lastKey, width:9, num:true },
];
// Data bars on the count columns: B Total, C Completed, D Active, F Blocked.
function summaryDataBars(ws, n){
  applyDataBar(ws, 'B', n, 'FF4F46E5');
  applyDataBar(ws, 'C', n, 'FF22C55E');
  applyDataBar(ws, 'D', n, 'FFF97316');
  applyDataBar(ws, 'F', n, 'FFEF4444');
}
function ownerSummary(wb){
  const rows = DATA.owners.map(o => { const s = ownerStats(o); return {
    name:o, total:s.total, completed:s.completed, active:s.active, pending:s.pending, blocked:s.blocked,
    live:s.c.live, done:s.c.done, review:s.c.review, inprog:s.c.in_progress, notstarted:s.c.not_started, last:s.clients.length };
  });
  const ws = styledSheet(wb, 'Owner Summary', SUMMARY_COLS('Owner','name','Clients','last'), rows);
  summaryDataBars(ws, rows.length);
}
function clientSummary(wb){
  const rows = DATA.customers.map(c => { const s = clientStats(c); return {
    name:c, total:s.total, completed:s.completed, active:s.active, pending:s.pending, blocked:s.blocked,
    live:s.c.live, done:s.c.done, review:s.c.review, inprog:s.c.in_progress, notstarted:s.c.not_started, last:s.people.length };
  });
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
  const kpis = [
    ['Total', DATA.total, 'FF4F46E5'],
    ['Live', DATA.counts.live||0, 'FF22C55E'],
    ['Completed', (DATA.counts.live||0)+(DATA.counts.done||0), 'FF3B82F6'],
    ['In Progress', DATA.counts.in_progress||0, 'FFF97316'],
    ['Blocked', DATA.counts.blocked||0, 'FFEF4444'],
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
renderLegend();
renderInsights();
render();
</script>
</body>
</html>`;
}
