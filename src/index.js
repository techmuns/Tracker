// index.js — Cloudflare Worker entry point.
//   GET  /             → server-rendered dashboard (clean light theme)
//   GET  /api/data     → parsed + classified dataset (sheet + manual) as JSON
//   POST /api/manual   → add a manual entry (stored in KV)
//   DELETE /api/manual?id=…  → remove a manual entry
//
// Sheet data comes from the published CSV (CSV_URL). Manual entries are stored
// in the KV namespace bound as MANUAL and merged in. If MANUAL isn't bound yet,
// the board still works read-only and the Add form is hidden.
import { parseCsv } from './csv.js';
import { buildDataset, manualToDashboard, STATES } from './classify.js';

const CACHE_SECONDS = 180;
const KV_KEY = 'manual_entries';

async function readManual(env) {
  if (!env.MANUAL) return [];
  const raw = await env.MANUAL.get(KV_KEY);
  return raw ? JSON.parse(raw) : [];
}
async function writeManual(env, list) {
  await env.MANUAL.put(KV_KEY, JSON.stringify(list));
}

async function getDataset(env) {
  if (!env.CSV_URL) throw new Error('CSV_URL is not configured');
  const res = await fetch(env.CSV_URL, { cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true } });
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  const text = await res.text();
  const manual = await readManual(env);
  return buildDataset(parseCsv(text), manual);
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

      return new Response(renderPage(data, { manualEnabled: !!env.MANUAL, editProtected: !!env.EDIT_TOKEN }), {
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
    --bg:#f6f7f9; --surface:#ffffff; --line:#e6e8ec; --line2:#eef0f3;
    --txt:#1d2330; --muted:#6b7280; --accent:#2563eb; --accent-weak:#eff4ff;
    --shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.04);
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  header { padding:18px 28px 14px; background:var(--surface); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:5; }
  .row { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; }
  h1 { margin:0; font-size:19px; font-weight:650; letter-spacing:-.01em; }
  .sub { color:var(--muted); font-size:12.5px; margin-top:2px; }
  .legend { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px; }
  .pill { display:inline-flex; align-items:center; gap:7px; padding:5px 11px; border:1px solid var(--line); border-radius:8px; background:var(--surface); cursor:pointer; user-select:none; font-size:12.5px; transition:background .12s; }
  .pill:hover { background:var(--line2); }
  .pill.off { opacity:.45; }
  .dot { width:9px; height:9px; border-radius:50%; flex:none; }
  .pill .n { color:var(--muted); font-variant-numeric:tabular-nums; font-weight:600; }
  .btn { font:inherit; font-size:13px; font-weight:550; padding:8px 14px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
  .btn:hover { filter:brightness(1.05); }
  .btn.ghost { background:var(--surface); color:var(--txt); border-color:var(--line); }
  .btn.ghost:hover { background:var(--line2); }
  .header-actions { display:flex; gap:10px; align-items:center; }
  .dropdown { position:relative; }
  .menu { display:none; position:absolute; right:0; top:calc(100% + 6px); background:var(--surface); border:1px solid var(--line); border-radius:10px; box-shadow:0 8px 24px rgba(16,24,40,.12); min-width:300px; overflow:hidden; z-index:20; }
  .menu.open { display:block; }
  .menu button { display:block; width:100%; text-align:left; padding:10px 14px; border:0; background:none; font:inherit; font-size:13px; color:var(--txt); cursor:pointer; }
  .menu button:hover { background:var(--accent-weak); }
  .menu button + button { border-top:1px solid var(--line2); }
  .tag.owner-link { cursor:pointer; }
  .tag.owner-link:hover { background:var(--accent-weak); border-color:#cdddff; color:var(--accent); }
  /* Slide-over drawer (owner profile + team) */
  .overlay { position:fixed; inset:0; background:rgba(16,24,40,.4); display:none; z-index:50; }
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
  .bar { display:flex; height:8px; border-radius:5px; overflow:hidden; margin:4px 0 16px; background:var(--line2); }
  .bar i { display:block; height:100%; }
  .section-t { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:650; margin:18px 0 8px; display:flex; align-items:center; gap:7px; }
  .drow { display:flex; gap:10px; align-items:baseline; padding:9px 0; border-bottom:1px solid var(--line2); }
  .drow .sn { color:var(--muted); font-variant-numeric:tabular-nums; font-size:12px; min-width:26px; }
  .drow .dn { font-weight:550; font-size:13.5px; }
  .drow .dmeta { font-size:12px; color:var(--muted); }
  .chips { display:flex; flex-wrap:wrap; gap:6px; margin:2px 0 6px; }
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
  .card { position:relative; background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:15px 16px; box-shadow:var(--shadow); }
  .card.manual { border-style:dashed; }
  .card h3 { margin:0 0 8px; font-size:14.5px; font-weight:620; padding-right:22px; }
  .meta { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0; }
  .tag { font-size:11px; padding:2px 8px; border-radius:6px; background:var(--line2); color:#4b5563; border:1px solid var(--line); white-space:nowrap; }
  .tag.state { font-weight:600; }
  .tag.live { color:#067647; background:#ecfdf3; border-color:#abefc6; }
  .tag.src { color:var(--accent); background:var(--accent-weak); border-color:#cdddff; }
  .status { font-size:13px; margin:9px 0 4px; color:#374151; }
  .label { color:var(--muted); font-size:10.5px; text-transform:uppercase; letter-spacing:.05em; font-weight:600; }
  .field { margin-top:7px; }
  .field .val { font-size:12.5px; color:#4b5563; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .foot { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:11px; padding-top:9px; border-top:1px solid var(--line2); font-size:11.5px; color:var(--muted); }
  .del { position:absolute; top:10px; right:10px; width:22px; height:22px; border-radius:6px; border:1px solid var(--line); background:var(--surface); color:var(--muted); cursor:pointer; line-height:1; font-size:14px; }
  .del:hover { color:#b42318; border-color:#fda29b; background:#fef3f2; }
  .group-h { grid-column:1/-1; margin:16px 0 2px; font-size:12.5px; font-weight:600; color:var(--muted); }
  .warn { padding:9px 28px; background:#fffaeb; color:#93620a; font-size:12px; border-bottom:1px solid #fef0c7; }
  .empty { padding:48px 28px; color:var(--muted); }
  /* Add-entry panel */
  .panel { display:none; padding:16px 28px; background:var(--surface); border-bottom:1px solid var(--line); }
  .panel.open { display:block; }
  .form-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px; }
  .form-grid label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--muted); }
  .panel-actions { margin-top:12px; display:flex; gap:10px; align-items:center; }
  .msg { font-size:12.5px; }
  .msg.err { color:#b42318; } .msg.ok { color:#067647; }
</style>
</head>
<body>
<header>
  <div class="row">
    <div>
      <h1>Dashboard Tracker</h1>
      <div class="sub">${data.total} dashboards · ${data.sheetCount} from sheet${data.manualCount ? ` · ${data.manualCount} added manually` : ''} · updated ${escapeHtml(fresh)}</div>
    </div>
    <div class="header-actions">
      <button class="btn ghost" id="teamToggle">👤 Team view</button>
      <div class="dropdown">
        <button class="btn ghost" id="exportToggle">⬇ Export to Excel ▾</button>
        <div class="menu" id="exportMenu">
          <button data-export="all">All — full workbook (overview + per-client + per-owner sheets)</button>
          <button data-export="client">Client-wise — one sheet per client</button>
          <button data-export="owner">Owner-wise — one sheet per owner</button>
        </div>
      </div>
      ${opts.manualEnabled ? `<button class="btn" id="addToggle">+ Add dashboard</button>` : ''}
    </div>
  </div>
  <div class="legend" id="legend"></div>
</header>

${opts.manualEnabled ? `
<div class="panel" id="panel">
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

${data.gaps.length ? `<div class="warn">Note: sheet serial numbers ${data.gaps.join(', ')} are missing (likely deleted rows). ${data.sheetCount} sheet entries counted.</div>` : ''}

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

<script>
const DATA = ${payload};
const STATES = ${statesJson};
const CFG = ${cfg};
const SMAP = Object.fromEntries(STATES.map(s => [s.id, s]));
const hidden = new Set();

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

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
  const delBtn = (d.source==='manual' && CFG.manualEnabled) ? \`<button class="del" title="Delete" data-del="\${esc(d.id)}">×</button>\` : '';
  return \`<div class="card \${d.source==='manual'?'manual':''}" style="border-top:3px solid \${s.color}">
    \${delBtn}
    <h3>\${title}</h3>
    <div class="meta">
      <span class="tag state" style="color:\${s.color}">\${s.label}</span>
      \${d.isLive ? '<span class="tag live">● Live on Munshot</span>' : ''}
      \${d.customers.map(c => \`<span class="tag">\${esc(c)}</span>\`).join('')}
      <span class="tag owner-link" data-owner="\${esc(d.owner)}" title="View \${esc(d.owner)}'s full track">\${esc(d.owner)}</span>
      \${d.source==='manual' ? '<span class="tag src">Manual</span>' : ''}
    </div>
    \${d.status && d.status!=='-' ? \`<div class="status"><span class="label">Status</span><br>\${esc(d.status)}</div>\` : ''}
    \${fields.map(([k,v]) => \`<div class="field"><span class="label">\${k}</span><div class="val">\${esc(v)}</div></div>\`).join('')}
    <div class="foot"><span>\${meeting}</span><span>\${d.lastUpdated ? 'Updated '+esc(d.lastUpdated) : ''}</span></div>
  </div>\`;
}

function render(){
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
function bindDelete(){
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this manual entry?')) return;
    const res = await api('DELETE', '/api/manual?id='+encodeURIComponent(b.dataset.del));
    if (res.ok) location.reload(); else alert('Delete failed: '+(await res.json()).error);
  });
}

if (CFG.manualEnabled){
  const panel = document.getElementById('panel');
  document.getElementById('addToggle').onclick = () => panel.classList.toggle('open');
  document.getElementById('cancelBtn').onclick = () => panel.classList.remove('open');
  document.getElementById('saveBtn').onclick = async () => {
    const msg = document.getElementById('formMsg');
    const body = {
      name: document.getElementById('f_name').value,
      customer: document.getElementById('f_customer').value,
      owner: document.getElementById('f_owner').value,
      liveRaw: document.getElementById('f_live').value,
      status: document.getElementById('f_status').value,
      meetingUrl: document.getElementById('f_meeting').value,
      requirements: document.getElementById('f_req').value,
      improvement: document.getElementById('f_imp').value,
      feedback: document.getElementById('f_feedback').value,
    };
    if (!body.name.trim()){ msg.className='msg err'; msg.textContent='Name is required.'; return; }
    msg.className='msg'; msg.textContent='Saving…';
    const res = await api('POST', '/api/manual', body);
    if (res.ok){ msg.className='msg ok'; msg.textContent='Saved.'; location.reload(); }
    else { const e = await res.json().catch(()=>({})); msg.className='msg err'; msg.textContent='Error: '+(e.error||res.status); }
  };
}

// ── Owner profile drawer + team overview ───────────────────────────────────
const overlay = document.getElementById('overlay');
const drawer = document.getElementById('drawer');
function closeDrawer(){ overlay.classList.remove('open'); }
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDrawer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

function ownerStats(name){
  const list = DATA.dashboards.filter(d => d.owner === name);
  const byState = Object.fromEntries(STATES.map(s => [s.id, list.filter(d => d.state === s.id)]));
  const c = Object.fromEntries(STATES.map(s => [s.id, byState[s.id].length]));
  return {
    list, byState, c,
    total: list.length,
    completed: c.live + c.done,                 // shipped or finished our side
    active: c.review + c.in_progress,           // in flight
    pending: c.not_started,                     // not started yet
    blocked: c.blocked,                         // stuck / on hold
    clients: [...new Set(list.flatMap(d => d.customers))].sort(),
  };
}

function openOwner(name){
  const s = ownerStats(name);
  const stat = (num, lbl, color) => \`<div class="stat"><div class="num" style="color:\${color||'var(--txt)'}">\${num}</div><div class="lbl">\${lbl}</div></div>\`;
  const segs = STATES.filter(x => s.c[x.id]).map(x => \`<i style="width:\${(s.c[x.id]/s.total*100)}%;background:\${x.color}" title="\${x.label}: \${s.c[x.id]}"></i>\`).join('');
  const sections = STATES.filter(x => s.byState[x.id].length).map(x => {
    const rows = s.byState[x.id].map(d => \`<div class="drow"><span class="sn">\${d.serial?('#'+d.serial):'•'}</span><div><div class="dn">\${esc(d.name)}</div><div class="dmeta">\${esc(d.customers.join(', '))}\${d.status&&d.status!=='-'?' — '+esc(d.status):''}</div></div></div>\`).join('');
    return \`<div class="section-t"><span class="dot" style="background:\${x.color}"></span>\${x.label} · \${s.c[x.id]}</div>\${rows}\`;
  }).join('');
  drawer.innerHTML = \`
    <div class="drawer-head">
      <div><button class="back" id="backTeam">‹ Team view</button><h2>\${esc(name)}</h2>
      <div class="sub">\${s.total} dashboard\${s.total!==1?'s':''} · \${s.clients.length} client\${s.clients.length!==1?'s':''}</div></div>
      <button class="x" id="drawerX">×</button>
    </div>
    <div class="drawer-body">
      <div class="stat-row">
        \${stat(s.completed,'Completed','#16a34a')}\${stat(s.active,'Active','#f97316')}\${stat(s.pending,'Pending','#9ca3af')}\${stat(s.blocked,'Blocked','#ef4444')}
      </div>
      <div class="bar">\${segs}</div>
      \${s.clients.length?\`<div class="section-t">Clients</div><div class="chips">\${s.clients.map(c=>\`<span class="tag">\${esc(c)}</span>\`).join('')}</div>\`:''}
      \${sections}
    </div>\`;
  overlay.classList.add('open');
  document.getElementById('drawerX').onclick = closeDrawer;
  document.getElementById('backTeam').onclick = openTeam;
}

function openTeam(){
  const cards = DATA.owners.map(name => {
    const s = ownerStats(name);
    const segs = STATES.filter(x => s.c[x.id]).map(x => \`<i style="width:\${(s.c[x.id]/s.total*100)}%;background:\${x.color}"></i>\`).join('');
    return \`<div class="owner-card" data-owner="\${esc(name)}">
      <div class="on">\${esc(name)}</div>
      <div class="os">\${s.total} dashboards · \${s.completed} completed · \${s.active} active · \${s.pending} pending\${s.blocked?' · '+s.blocked+' blocked':''}</div>
      <div class="bar" style="margin:8px 0 0">\${segs}</div>
    </div>\`;
  }).join('');
  drawer.innerHTML = \`
    <div class="drawer-head"><div><h2>Team</h2><div class="sub">\${DATA.owners.length} people · click anyone to see their full track</div></div><button class="x" id="drawerX">×</button></div>
    <div class="drawer-body"><div class="owner-grid">\${cards}</div></div>\`;
  overlay.classList.add('open');
  document.getElementById('drawerX').onclick = closeDrawer;
  drawer.querySelectorAll('[data-owner]').forEach(el => el.onclick = () => openOwner(el.dataset.owner));
}

document.getElementById('teamToggle').onclick = openTeam;
// Click an owner chip on any card → open that person's profile
document.getElementById('grid').addEventListener('click', (e) => {
  const el = e.target.closest('[data-owner]');
  if (el) openOwner(el.dataset.owner);
});

// ── Export to Excel (multi-sheet .xlsx via SheetJS, loaded on first use) ────
function loadXLSX(){
  if (window.XLSX) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = resolve; s.onerror = () => reject(new Error('Could not load the Excel library.'));
    document.head.appendChild(s);
  });
}
function exportRows(list){
  return list.map(d => ({
    '#': d.serial ?? '',
    Dashboard: d.name,
    Customer: d.customer,
    'Assigned To': d.owner,
    State: SMAP[d.state].label,
    Live: d.isLive ? 'Live on Munshot' : 'No',
    Status: d.status,
    'Client Requirements': d.requirements,
    Improvements: d.improvement,
    Feedback: d.feedback,
    'Meeting Link': d.meetingUrl || d.meetingNote || '',
    'Last Updated': d.lastUpdated,
    Source: d.source,
  }));
}
function safeSheetName(wb, base){
  let name = String(base || 'Sheet');
  ['\\\\', '/', '?', '*', '[', ']', ':'].forEach(ch => { name = name.split(ch).join(' '); });
  name = name.replace(/\\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
  let n = name, i = 2;
  while (wb.SheetNames.includes(n)){ const suf = ' ('+i+')'; n = name.slice(0, 31 - suf.length) + suf; i++; }
  return n;
}
function addSheet(wb, base, rows){
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), safeSheetName(wb, base));
}
async function doExport(kind){
  try {
    await loadXLSX();
    const wb = XLSX.utils.book_new();
    const all = DATA.dashboards;
    if (kind === 'all'){
      addSheet(wb, 'All Dashboards', exportRows(all));
      DATA.customers.forEach(c => addSheet(wb, 'Client - '+c, exportRows(all.filter(d => d.customers.includes(c)))));
      DATA.owners.forEach(o => addSheet(wb, 'Owner - '+o, exportRows(all.filter(d => d.owner === o))));
      XLSX.writeFile(wb, 'dashboard-tracker-all.xlsx');
    } else if (kind === 'client'){
      DATA.customers.forEach(c => addSheet(wb, c, exportRows(all.filter(d => d.customers.includes(c)))));
      XLSX.writeFile(wb, 'dashboard-tracker-by-client.xlsx');
    } else {
      DATA.owners.forEach(o => addSheet(wb, o, exportRows(all.filter(d => d.owner === o))));
      XLSX.writeFile(wb, 'dashboard-tracker-by-owner.xlsx');
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
renderLegend();
render();
</script>
</body>
</html>`;
}
