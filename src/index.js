// index.js — Cloudflare Worker entry point.
//   GET /            → server-rendered dashboard (HTML) with data inlined
//   GET /api/data    → the parsed + classified dataset as JSON
//
// The Worker fetches the published Google Sheet CSV at the edge, caches it for
// a few minutes, classifies every row, and renders. Edit the sheet → it shows
// up within the cache window (default 3 min). Set CSV_URL in wrangler.toml.
import { parseCsv } from './csv.js';
import { buildDataset, STATES } from './classify.js';

const CACHE_SECONDS = 180;

async function getDataset(env) {
  const url = env.CSV_URL;
  if (!url) throw new Error('CSV_URL is not configured');
  const res = await fetch(url, { cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true } });
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  const text = await res.text();
  return buildDataset(parseCsv(text));
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
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

      return new Response(renderPage(data), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': `public, max-age=${CACHE_SECONDS}`,
        },
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

function renderPage(data) {
  const fresh = new Date(data.generatedAt).toUTCString();
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');
  const statesJson = JSON.stringify(STATES);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard Tracker</title>
<style>
  :root { --bg:#0f1117; --panel:#171a23; --panel2:#1f2430; --line:#2b3140; --txt:#e7ebf3; --muted:#9aa3b2; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif; }
  header { padding:20px 24px 12px; border-bottom:1px solid var(--line); position:sticky; top:0; background:rgba(15,17,23,.94); backdrop-filter:blur(8px); z-index:5; }
  h1 { margin:0 0 2px; font-size:20px; }
  .sub { color:var(--muted); font-size:12px; }
  .legend { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
  .pill { display:inline-flex; align-items:center; gap:7px; padding:5px 11px; border:1px solid var(--line); border-radius:999px; background:var(--panel); cursor:pointer; user-select:none; font-size:12px; }
  .pill.off { opacity:.4; }
  .dot { width:10px; height:10px; border-radius:50%; flex:none; }
  .pill .n { color:var(--muted); font-variant-numeric:tabular-nums; }
  .controls { display:flex; flex-wrap:wrap; gap:10px; padding:14px 24px; border-bottom:1px solid var(--line); align-items:center; }
  select, input { background:var(--panel2); color:var(--txt); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-size:13px; }
  input[type=search] { min-width:220px; flex:1; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:14px; padding:18px 24px 60px; }
  .card { background:var(--panel); border:1px solid var(--line); border-left:4px solid var(--line); border-radius:10px; padding:14px; }
  .card h3 { margin:0 0 6px; font-size:15px; }
  .meta { display:flex; flex-wrap:wrap; gap:6px; margin:6px 0; }
  .tag { font-size:11px; padding:2px 8px; border-radius:6px; background:var(--panel2); color:var(--muted); border:1px solid var(--line); }
  .tag.live { color:#bbf7d0; border-color:#14532d; background:#0c2417; }
  .status { font-size:13px; margin:8px 0 4px; }
  .label { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  .field { margin-top:6px; }
  .field .val { font-size:12px; color:#cdd4e0; }
  a { color:#7db1ff; }
  .foot { display:flex; justify-content:space-between; align-items:center; margin-top:10px; padding-top:8px; border-top:1px solid var(--line); font-size:11px; color:var(--muted); }
  .group-h { grid-column:1/-1; margin:14px 0 2px; font-size:13px; color:var(--muted); border-bottom:1px solid var(--line); padding-bottom:6px; }
  .warn { padding:10px 24px; background:#241a0c; color:#f5d28a; font-size:12px; border-bottom:1px solid var(--line); }
  .empty { padding:40px 24px; color:var(--muted); }
</style>
</head>
<body>
<header>
  <h1>Dashboard Tracker</h1>
  <div class="sub">${data.total} dashboards · synced from Google Sheet · updated ${escapeHtml(fresh)}</div>
  <div class="legend" id="legend"></div>
</header>
${data.gaps.length ? `<div class="warn">Note: serial numbers ${data.gaps.join(', ')} are missing from the sheet (likely deleted rows). ${data.total} real entries counted.</div>` : ''}
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
  <label style="font-size:12px;color:var(--muted)"><input type="checkbox" id="liveonly"> Live only</label>
</div>
<div class="grid" id="grid"></div>

<script>
const DATA = ${payload};
const STATES = ${statesJson};
const SMAP = Object.fromEntries(STATES.map(s => [s.id, s]));
const hidden = new Set();

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function renderLegend(){
  const el = document.getElementById('legend');
  el.innerHTML = STATES.map(s =>
    \`<span class="pill \${hidden.has(s.id)?'off':''}" data-id="\${s.id}"><span class="dot" style="background:\${s.color}"></span>\${s.label} <span class="n">\${DATA.counts[s.id]||0}</span></span>\`
  ).join('');
  el.querySelectorAll('.pill').forEach(p => p.onclick = () => {
    const id = p.dataset.id;
    hidden.has(id) ? hidden.delete(id) : hidden.add(id);
    render();
  });
}

function card(d){
  const s = SMAP[d.state];
  const fields = [
    ['Requirements', d.requirements],
    ['Improvements', d.improvement],
    ['Feedback', d.feedback],
  ].filter(([,v]) => v && v !== '-');
  const meeting = d.meetingUrl ? \`<a href="\${esc(d.meetingUrl)}" target="_blank" rel="noopener">▶ Recording / link</a>\`
                : d.meetingNote ? \`<span>\${esc(d.meetingNote)}</span>\` : '';
  return \`<div class="card" style="border-left-color:\${s.color}">
    <h3>#\${d.serial} · \${esc(d.name)}</h3>
    <div class="meta">
      <span class="tag" style="color:\${s.color};border-color:\${s.color}55">\${s.label}</span>
      \${d.isLive ? '<span class="tag live">● Live on Munshot</span>' : ''}
      <span class="tag">\${esc(d.customer)}</span>
      <span class="tag">\${esc(d.owner)}</span>
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
    if (cust && d.customer !== cust) return false;
    if (own && d.owner !== own) return false;
    if (liveonly && !d.isLive) return false;
    if (q) {
      const hay = (d.name+' '+d.status+' '+d.requirements+' '+d.improvement+' '+d.feedback+' '+d.customer+' '+d.owner).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const grid = document.getElementById('grid');
  if (!list.length){ grid.innerHTML = '<div class="empty">No dashboards match these filters.</div>'; return; }

  if (!groupby){ grid.innerHTML = list.map(card).join(''); return; }

  let groups;
  if (groupby === 'state'){
    groups = STATES.map(s => [s.label, list.filter(d => d.state === s.id)]).filter(([,a]) => a.length);
  } else {
    const keys = [...new Set(list.map(d => d[groupby]))].sort();
    groups = keys.map(k => [k, list.filter(d => d[groupby] === k)]);
  }
  grid.innerHTML = groups.map(([title, items]) =>
    \`<div class="group-h">\${esc(title)} · \${items.length}</div>\` + items.map(card).join('')
  ).join('');
}

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
