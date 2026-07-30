// ── GitHub commit tracking ───────────────────────────────────────────────
// Turns raw GitHub commits (from the REST API poll or a push webhook) into
// per-day, per-repo, per-dashboard activity we can show on the Performance
// view ("yesterday this much, today this much") and summarize with an LLM.
//
// The pure helpers (dayKey/parseCommits/aggregateByDay/overviewFromRows) have
// no I/O and are unit-tested. The db* helpers take a D1 binding; summarizeDay
// takes env. Everything degrades gracefully when D1 / keys are absent.

// The team works in India, so a "day" is bucketed in IST (UTC+5:30). A commit
// pushed at 1am IST counts for that IST calendar day, not the UTC one.
export const TZ_OFFSET_MIN = 330;

// YYYY-MM-DD for an epoch-ms timestamp, in the team's timezone.
export function dayKey(tsMs, offsetMin = TZ_OFFSET_MIN) {
  const d = new Date(tsMs + offsetMin * 60000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Normalize a GitHub commit list into the flat rows we store. Accepts both:
//  • REST  /repos/{repo}/commits → [{ sha, commit:{message,author:{date,name}}, author:{login} }]
//  • webhook push payload commits → [{ id, message, timestamp, author:{name,username} }]
export function parseCommits(list, repo, dashboardId, offsetMin = TZ_OFFSET_MIN) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const sha = c.sha || c.id;
    if (!sha) continue;
    const message = (c.commit ? c.commit.message : c.message) || '';
    const iso = c.commit ? (c.commit.author && c.commit.author.date) : c.timestamp;
    const ts = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(ts)) continue;
    const author =
      (c.author && (c.author.login || c.author.name || c.author.username)) ||
      (c.commit && c.commit.author && c.commit.author.name) || '';
    out.push({
      sha: String(sha),
      repo: String(repo || ''),
      dashboardId: String(dashboardId || ''),
      author: String(author || ''),
      message: String(message).split('\n')[0].trim().slice(0, 500),
      ts,
      day: dayKey(ts, offsetMin),
    });
  }
  return out;
}

// Roll rows up into { [repo]: { [day]: count } }.
export function aggregateByDay(rows) {
  const out = {};
  for (const r of rows || []) {
    (out[r.repo] = out[r.repo] || {});
    out[r.repo][r.day] = (out[r.repo][r.day] || 0) + 1;
  }
  return out;
}

// A list of the last `days` YYYY-MM-DD keys (ascending, ending today in TZ).
export function recentDays(days, nowMs, offsetMin = TZ_OFFSET_MIN) {
  const out = [];
  const todayKey = dayKey(nowMs, offsetMin);
  // Walk back from today using noon-anchored steps to dodge DST edge cases.
  const [y, m, d] = todayKey.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d, 12, 0, 0);
  for (let i = days - 1; i >= 0; i--) out.push(dayKey(base - i * 86400000, 0));
  return out;
}

// Build the founder-facing overview purely from rows + a dashboards list.
// dashboards: [{ id, name, githubRepo, owner, customers:[] }]
export function overviewFromRows(rows, dashboards, days, nowMs, offsetMin = TZ_OFFSET_MIN) {
  const span = recentDays(days, nowMs, offsetMin);
  const today = span[span.length - 1];
  const yesterday = span[span.length - 2];
  const last7 = new Set(span.slice(-7));
  const inSpan = new Set(span);

  // repo (lowercased) → dashboard
  const byRepo = new Map();
  for (const d of dashboards || []) {
    if (d.githubRepo) byRepo.set(d.githubRepo.toLowerCase(), d);
  }

  const totalByDay = Object.fromEntries(span.map((k) => [k, 0]));
  const perDash = new Map(); // id → { id, name, repo, owner, byDay, total, today, yesterday, last7 }
  let totalToday = 0, totalYesterday = 0, totalLast7 = 0, totalAll = 0;

  for (const r of rows || []) {
    if (!inSpan.has(r.day)) continue;
    totalByDay[r.day] = (totalByDay[r.day] || 0) + 1;
    totalAll++;
    if (r.day === today) totalToday++;
    if (r.day === yesterday) totalYesterday++;
    if (last7.has(r.day)) totalLast7++;

    const dash = byRepo.get(String(r.repo).toLowerCase());
    const id = dash ? dash.id : ('repo:' + r.repo);
    let e = perDash.get(id);
    if (!e) {
      e = { id, name: dash ? dash.name : r.repo, repo: r.repo, owner: dash ? dash.owner : '',
            byDay: Object.fromEntries(span.map((k) => [k, 0])), total: 0, today: 0, yesterday: 0, last7: 0 };
      perDash.set(id, e);
    }
    e.byDay[r.day]++; e.total++;
    if (r.day === today) e.today++;
    if (r.day === yesterday) e.yesterday++;
    if (last7.has(r.day)) e.last7++;
  }

  const dashboardsOut = [...perDash.values()].sort((a, b) => b.last7 - a.last7 || b.total - a.total);
  return {
    enabled: true,
    days: span,
    totalByDay,
    today: totalToday,
    yesterday: totalYesterday,
    last7: totalLast7,
    total: totalAll,
    dashboards: dashboardsOut,
  };
}

// ── Fuzzy repo matching (auto-link dashboards → their GitHub repos) ───────
const MATCH_STOP = new Set(['dashboard','dashboards','tracker','trackers','dash','the','a','of','and','for','to','on','v2','new']);
function normTokens(s, strip) {
  // Split camelCase ("HealthInsurer" → "Health Insurer") before tokenizing.
  const str = String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  let t = str.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (strip) { const f = t.filter((x) => !MATCH_STOP.has(x)); if (f.length) t = f; }
  return t;
}
function charBigrams(s) {
  s = String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const b = []; for (let i = 0; i < s.length - 1; i++) b.push(s.slice(i, i + 2));
  return b;
}
// Sørensen–Dice similarity of two token sets (0..1).
function dice(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}
// Similarity of a dashboard name to a repo name (word overlap + character bigrams).
export function repoMatchScore(dashName, repoName) {
  const ts = dice(normTokens(dashName, true), normTokens(repoName, true));
  const bg = dice(charBigrams(dashName), charBigrams(repoName));
  return 0.6 * ts + 0.4 * bg;
}
// The project slug from a deploy URL — the first subdomain label, which for
// Cloudflare Pages/Workers is basically the repo name.
//   https://oem-trends-tracker.pages.dev/…            → 'oem-trends-tracker'
//   https://luggagedashboard.acc-123.workers.dev/…    → 'luggagedashboard'
export function urlSlug(url) {
  const m = String(url || '').match(/^https?:\/\/([a-z0-9-]+)\./i);
  return m ? m[1] : '';
}
// For each dashboard, pick the best-matching repo. Matches on the deploy-URL
// slug (strongest signal — it's derived from the repo) AND the display name.
// `repos`: [{ full_name, name }]. Returns a suggestion + 0–100 score per dash.
export function matchRepos(dashboards, repos, threshold = 0.34) {
  return (dashboards || []).map((d) => {
    const slug = urlSlug(d.dashboardUrl);
    let best = '', bestScore = 0, second = 0;
    for (const r of repos || []) {
      const rn = r.name || String(r.full_name || '').split('/').pop();
      const s = Math.max(repoMatchScore(d.name, rn), slug ? repoMatchScore(slug, rn) : 0);
      if (s > bestScore) { second = bestScore; bestScore = s; best = r.full_name; }
      else if (s > second) { second = s; }
    }
    return {
      id: d.id, name: d.name, current: d.githubRepo || '',
      suggestion: bestScore >= threshold ? best : '',
      score: Math.min(100, Math.round(bestScore * 100)), margin: Math.round((bestScore - second) * 100),
    };
  });
}

// ── KV-backed commit activity ────────────────────────────────────────────
// Commit data is small, so it lives in the existing KV (no database to set up).
// Shape: { [repo]: { days: { [day]: { count, msgs:[…], summary } }, shas: { [sha]: day } } }

// Fold parsed commit rows into the activity object (idempotent by SHA). Returns
// a { [repo]: Set(day) } map of days that changed and need re-summarizing.
export function mergeCommitsIntoActivity(activity, rows) {
  const dirty = {};
  for (const r of rows || []) {
    let a = activity[r.repo]; if (!a) a = activity[r.repo] = { days: {}, shas: {} };
    if (a.shas[r.sha]) continue;            // already counted
    a.shas[r.sha] = r.day;
    let d = a.days[r.day]; if (!d) d = a.days[r.day] = { count: 0, msgs: [], summary: '' };
    d.count++;
    if (d.msgs.length < 80) d.msgs.push(r.message);
    (dirty[r.repo] = dirty[r.repo] || new Set()).add(r.day);
  }
  return dirty;
}

// Drop days (and their SHAs) older than the retained window so KV stays small.
export function pruneActivity(activity, keepDays, nowMs, offsetMin = TZ_OFFSET_MIN) {
  const span = new Set(recentDays(keepDays, nowMs, offsetMin));
  for (const repo of Object.keys(activity || {})) {
    const a = activity[repo];
    for (const day of Object.keys(a.days || {})) if (!span.has(day)) delete a.days[day];
    for (const sha of Object.keys(a.shas || {})) if (!span.has(a.shas[sha])) delete a.shas[sha];
    if (!Object.keys(a.days || {}).length) delete activity[repo];
  }
  return activity;
}

// Build the founder overview (same shape as overviewFromRows) from KV activity.
export function overviewFromActivity(activity, dashboards, days, nowMs, offsetMin = TZ_OFFSET_MIN) {
  const span = recentDays(days, nowMs, offsetMin);
  const today = span[span.length - 1];
  const yesterday = span[span.length - 2];
  const last7 = new Set(span.slice(-7));
  const inSpan = new Set(span);
  const byRepo = new Map();
  for (const d of dashboards || []) for (const rp of (d.allRepos || (d.githubRepo ? [d.githubRepo] : []))) byRepo.set(String(rp).toLowerCase(), d);
  const totalByDay = Object.fromEntries(span.map((k) => [k, 0]));
  const perDash = new Map();
  let tToday = 0, tYest = 0, tLast7 = 0, tAll = 0;
  for (const repo of Object.keys(activity || {})) {
    const a = activity[repo] || {};
    const dash = byRepo.get(String(repo).toLowerCase());
    const id = dash ? dash.id : ('repo:' + repo);
    let e = perDash.get(id);
    if (!e) {
      e = { id, name: dash ? dash.name : repo, repo, owner: dash ? dash.owner : '',
            byDay: Object.fromEntries(span.map((k) => [k, 0])), summaries: {}, total: 0, today: 0, yesterday: 0, last7: 0 };
      perDash.set(id, e);
    }
    for (const day of Object.keys(a.days || {})) {
      if (!inSpan.has(day)) continue;
      const c = a.days[day].count || 0; if (!c) continue;
      e.byDay[day] += c; e.total += c; totalByDay[day] += c; tAll += c;
      if (a.days[day].summary) e.summaries[day] = a.days[day].summary;
      if (day === today) { e.today += c; tToday += c; }
      if (day === yesterday) { e.yesterday += c; tYest += c; }
      if (last7.has(day)) { e.last7 += c; tLast7 += c; }
    }
  }
  const dashboardsOut = [...perDash.values()].filter((e) => e.total > 0)
    .sort((a, b) => b.last7 - a.last7 || b.total - a.total);
  return { enabled: true, days: span, totalByDay, today: tToday, yesterday: tYest, last7: tLast7, total: tAll, dashboards: dashboardsOut };
}

// ── D1 helpers (legacy; the app now uses KV activity above) ───────────────

// Idempotent upsert by sha. Chunks to stay under D1's bound-statement limits.
export async function dbIngest(db, rows) {
  if (!db || !rows || !rows.length) return 0;
  let n = 0;
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO commits (sha, repo, dashboard_id, author, message, ts, day) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const batch = rows.map((r) => stmt.bind(r.sha, r.repo, r.dashboardId, r.author, r.message, r.ts, r.day));
  for (let i = 0; i < batch.length; i += 50) {
    const res = await db.batch(batch.slice(i, i + 50));
    n += res.reduce((s, x) => s + (x.meta ? x.meta.changes || 0 : 0), 0);
  }
  return n;
}

// Fetch stored rows within the last `days` (in TZ) as {sha,repo,dashboardId,author,message,ts,day}.
export async function dbRecentRows(db, days, nowMs, offsetMin = TZ_OFFSET_MIN) {
  if (!db) return [];
  const span = recentDays(days, nowMs, offsetMin);
  const from = span[0];
  const { results } = await db
    .prepare('SELECT sha, repo, dashboard_id AS dashboardId, author, message, ts, day FROM commits WHERE day >= ? ORDER BY ts ASC')
    .bind(from)
    .all();
  return results || [];
}

// Commit messages for one repo on one day (for summarization).
export async function dbMessagesForDay(db, repo, day) {
  if (!db) return [];
  const { results } = await db
    .prepare('SELECT message, author FROM commits WHERE repo = ? AND day = ? ORDER BY ts ASC')
    .bind(repo, day)
    .all();
  return results || [];
}

// All stored summaries on/after fromDay, for attaching to the overview in bulk.
export async function dbSummariesSince(db, fromDay) {
  if (!db) return [];
  const { results } = await db
    .prepare('SELECT repo, day, summary, count FROM daily_summary WHERE day >= ?')
    .bind(fromDay)
    .all();
  return results || [];
}

export async function dbGetSummary(db, repo, day) {
  if (!db) return null;
  const row = await db.prepare('SELECT summary, count FROM daily_summary WHERE repo = ? AND day = ?').bind(repo, day).first();
  return row || null;
}

export async function dbPutSummary(db, repo, day, count, summary, nowMs) {
  if (!db) return;
  await db
    .prepare('INSERT INTO daily_summary (repo, day, count, summary, updated_at) VALUES (?, ?, ?, ?, ?) ' +
             'ON CONFLICT(repo, day) DO UPDATE SET count = excluded.count, summary = excluded.summary, updated_at = excluded.updated_at')
    .bind(repo, day, count, summary, nowMs)
    .run();
}

// ── LLM summary (OpenAI) ─────────────────────────────────────────────────
// Turn a day's raw commit messages into a few short, plain-English bullet
// points a non-technical founder can read. Falls back to the first messages as
// bullets when no key is set or the call fails. Returns '' for no commits.
export async function summarizeMessages(env, repo, day, messages) {
  const lines = (messages || []).map((m) => (typeof m === 'string' ? m : m.message)).filter(Boolean);
  if (!lines.length) return '';
  const fallback = lines.slice(0, 3).map((l) => '• ' + l).join('\n').slice(0, 500);
  const key = env && env.OPENAI_API_KEY;
  if (!key) return fallback;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: (env.OPENAI_MODEL || 'gpt-4o-mini'),
        temperature: 0.2,
        max_tokens: 180,
        messages: [
          { role: 'system', content: 'You summarize a day of code commits for a NON-technical founder. Reply with 1 to 3 very short bullet points, each on its own line starting with "• ". Use plain language, no jargon, no file names or code terms. Fewer points is better. If little happened, use one bullet.' },
          { role: 'user', content: `Repo ${repo}, ${day}. Commit messages:\n` + lines.slice(0, 40).map((l) => '- ' + l).join('\n') },
        ],
      }),
    });
    if (!res.ok) return fallback;
    const j = await res.json();
    let txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    txt = (txt || '').trim();
    if (!txt) return fallback;
    // Normalize each line to a "• " bullet.
    txt = txt.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => l.replace(/^([•\-*]\s*)?/, '• ')).join('\n');
    return txt.slice(0, 600);
  } catch {
    return fallback;
  }
}

// ── GitHub access tokens ─────────────────────────────────────────────────
// Each dashboard repo belongs to one of two accounts (ceekay / techmuns) whose
// read tokens live in the Worker env as CEEKAY_AT / TECHMUNS_AT. Match by the
// repo owner, then fall back to trying the other token (repos under a shared
// org still resolve). A generic GITHUB_TOKEN, if set, is tried last.
export function ghTokensFor(env, repo) {
  if (!env) return [];
  const owner = String(repo || '').split('/')[0].toLowerCase();
  const cee = env.CEEKAY_AT, tech = env.TECHMUNS_AT, gen = env.GITHUB_TOKEN;
  const out = [];
  if (owner === 'ceekay' && cee) out.push(cee);
  else if (owner === 'techmuns' && tech) out.push(tech);
  for (const t of [cee, tech, gen]) if (t && !out.includes(t)) out.push(t);
  return out;
}
export function hasGhToken(env) {
  return !!(env && (env.CEEKAY_AT || env.TECHMUNS_AT || env.GITHUB_TOKEN));
}

// ── GitHub REST fetch ────────────────────────────────────────────────────
// Pull commits for one repo since `sinceMs`. Tries the owner-matched token
// first, then the other on an auth/visibility error. Returns parsed rows.
export async function fetchRepoCommits(env, repo, dashboardId, sinceMs) {
  const baseHeaders = {
    'User-Agent': 'muns-tracker',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const since = new Date(sinceMs).toISOString();
  const url = `https://api.github.com/repos/${repo}/commits?per_page=100&since=${encodeURIComponent(since)}`;
  const tokens = ghTokensFor(env, repo);
  const tries = tokens.length ? tokens : [null];
  let lastStatus = 0;
  for (const tok of tries) {
    const headers = { ...baseHeaders };
    if (tok) headers.Authorization = 'Bearer ' + tok;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const list = await res.json().catch(() => []);
      return { ok: true, status: 200, rows: parseCommits(list, repo, dashboardId) };
    }
    lastStatus = res.status;
    // Only a wrong/insufficient token is worth retrying with another token.
    if (res.status !== 401 && res.status !== 403 && res.status !== 404) break;
  }
  return { ok: false, status: lastStatus, rows: [] };
}
