// classify.js — turns a messy spreadsheet row into a clean dashboard object
// with one of 7 pipeline STAGES. Pure functions: no Worker/Node APIs, so this
// is runnable + testable anywhere.
//
// ── The 7-stage pipeline (start → finish) ──────────────────────────────────
//   not_started      grey    Not started yet / not assigned
//   ui_ux            violet  UI/UX creation
//   data_integration blue    Data integration (wiring live data in)
//   final_check      cyan    Final check / internal QA
//   feedback_open    amber   Open for feedback (shared with client)
//   feedback_incorp  orange  Incorporating client feedback
//   completed        green   Completed
//
// "Live on Munshot" is a SEPARATE flag (a badge), independent of the stage —
// a dashboard can go live anytime from stage 2 onwards.
//
// New/edited dashboards carry an EXPLICIT stage (picked from a dropdown). For
// legacy sheet rows that only have free-text status, we map the status text to
// the closest stage with the keyword lists below.

export const STATES = [
  { id: 'not_started',      label: 'Not Started Yet',        color: '#9ca3af', desc: 'Not started yet / not assigned' },
  { id: 'ui_ux',            label: 'UI/UX Creation',         color: '#8b5cf6', desc: 'Designing the dashboard UI/UX' },
  { id: 'data_integration', label: 'Data Integration',       color: '#3b82f6', desc: 'Wiring live data into the dashboard' },
  { id: 'final_check',      label: 'Final Check',            color: '#06b6d4', desc: 'Internal QA / final verification' },
  { id: 'feedback_open',    label: 'Open for Feedbacks',     color: '#f59e0b', desc: 'Shared with the client, awaiting feedback' },
  { id: 'feedback_incorp',  label: 'Feedback Incorporation', color: '#f97316', desc: 'Incorporating client feedback' },
  { id: 'completed',        label: 'Completed',              color: '#22c55e', desc: 'Finished' },
];

export const STATE_BY_ID = Object.fromEntries(STATES.map((s) => [s.id, s]));
const STAGE_IDS = new Set(STATES.map((s) => s.id));

// Legacy free-text → stage. We reuse the keyword lists that were tuned for the
// real sheet to derive an old "work-state", then map that to the new stage.
const KEYWORDS = {
  review: [
    'almost complet', 'almost everything', 'sanity', 'cross verify', 'cross-verify',
    'feedback pending', 'pending from', 'meeting due', 'meeting pending', 'check for bugs',
    'bugs and data', 'data accuracy', 'ui fix', 'need clients feedback', 'cross verify no',
  ],
  blocked: [
    'on hold', 'confusion', 'need to take details', 'client requirements pending',
    'client requirement', 'pending call', 'pending email', 'need details',
  ],
  in_progress: [
    'in making', 'in progress', 'making', 'fixing', 'wiring', 'wired', 'remained',
    'being addressed', 'being adressed', 'started with', 'scraping', 'integration pending',
    'need to add', 'updated dashboard', '60%', 'need a improvement', 'improvement list',
    'pending to address', 'bug', 'wire', 'data wiring', 'need to check',
  ],
  done: [
    'all things fixed', 'all changes done', 'made a agent', 'made an agent',
    'completed and live', 'dashboard is completed', 'done history', 'all good',
    'dashboard is live', 'dashboard live', 'all done', 'completed',
  ],
  not_started: ['not started', 'not assigned'],
};
// Map the legacy work-state to the closest new pipeline stage.
const LEGACY_TO_STAGE = {
  live: 'completed',
  done: 'completed',
  review: 'final_check',
  in_progress: 'data_integration',
  blocked: 'not_started',
  not_started: 'not_started',
};

const has = (text, list) => list.some((k) => text.includes(k));

// Fix the recurring typos so display + matching stay consistent.
export function fixTypos(s) {
  if (!s) return s;
  return s
    .replace(/recieved/gi, 'Received')
    .replace(/inetgration/gi, 'integration')
    .replace(/adressed/gi, 'addressed')
    .replace(/cgecklist/gi, 'Checklist')
    .replace(/scorning/gi, 'Scoring')
    .replace(/trcaker/gi, 'Tracker')
    .replace(/dasksham/gi, 'Daksham')
    .replace(/screnshot/gi, 'Screenshot')
    .replace(/promotor/gi, 'Promoter');
}

const clean = (s) => fixTypos(String(s ?? '').replace(/\s+/g, ' ').trim());

// A blank-ish cell: empty, "-", "n/a", etc.
const blank = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return t === '' || t === '-' || t === '–' || t === 'n/a' || t === 'na';
};

export function isLiveValue(liveRaw) {
  const t = String(liveRaw ?? '').toLowerCase();
  if (t.includes('not live')) return false;
  return t.includes('munshot') || t.includes('live');
}

// Legacy free-text → old work-state (kept for sheet rows without an explicit stage).
function legacyState(status) {
  const t = clean(status).toLowerCase();
  if (!blank(status)) {
    if (has(t, KEYWORDS.review))      return 'review';
    if (has(t, KEYWORDS.blocked))     return 'blocked';
    if (has(t, KEYWORDS.in_progress)) return 'in_progress';
    if (has(t, KEYWORDS.done))        return 'done';
    if (has(t, KEYWORDS.not_started)) return 'not_started';
  }
  return null;
}

// Core: decide the pipeline stage for a row. An explicit `stage` (from the
// add/edit form) always wins; otherwise we infer it from the status text.
export function classify({ status, liveRaw, stage }) {
  const isLive = isLiveValue(liveRaw);
  if (stage && STAGE_IDS.has(stage)) return { state: stage, isLive };
  const legacy = legacyState(status);
  if (legacy) return { state: LEGACY_TO_STAGE[legacy], isLive };
  // No decisive keyword: a live dashboard is at least integrated; else not started.
  return { state: isLive ? 'data_integration' : 'not_started', isLive };
}

const firstUrl = (...vals) => vals.map((v) => String(v ?? '').trim()).find((v) => /^https?:\/\//i.test(v)) || '';

// Canonical customer names — collapse obvious duplicates so counts/grouping are
// correct. Add aliases here as the sheet grows. (Keys matched case-insensitively.)
const CUSTOMER_ALIASES = {
  'vimana': 'Vimana Capital',
};
function canonicalCustomer(name) {
  const c = clean(name);
  return CUSTOMER_ALIASES[c.toLowerCase()] || c;
}

// A cell like "Arisag Partners & Beas Capital" is TWO clients sharing one
// dashboard — split it so each is counted/filtered/grouped on its own.
export function splitCustomers(raw) {
  const cleaned = clean(raw);
  if (!cleaned) return [];
  return cleaned
    .split(/\s*[&+/]\s*|\s*,\s*/)
    .map((s) => canonicalCustomer(s))
    .filter(Boolean);
}

// Map one raw CSV row (array of cells) to a dashboard object, or null if the
// row is spreadsheet noise (no serial number / no name).
export function rowToDashboard(cells) {
  const [serialRaw, name, customer, owner, liveRaw, requirements, improvement, feedback, status, link, lastUpdated, extra] =
    cells.map((c) => String(c ?? ''));

  const serial = parseInt(String(serialRaw).trim(), 10);
  if (!Number.isFinite(serial)) return null;          // junk / spacer row
  if (blank(name)) return null;                        // no dashboard name

  const meetingUrl = firstUrl(link, extra);
  // Keep the descriptive label (e.g. "Short Phone Call Recording") even when the
  // actual URL spilled into a later column.
  const meetingNote = !blank(link) && !/^https?:\/\//i.test(link.trim()) ? clean(link) : '';
  const { state, isLive } = classify({ status, liveRaw });
  const customers = splitCustomers(customer);
  const customerList = customers.length ? customers : ['Unassigned'];

  return {
    serial,
    source: 'sheet',
    id: 'sheet-' + serial,
    name: clean(name),
    customers: customerList,
    customer: customerList.join(' & '),
    owner: clean(owner) || 'Unassigned',
    liveRaw: clean(liveRaw),
    isLive,
    requirements: clean(requirements),
    improvement: clean(improvement),
    feedback: clean(feedback),
    status: clean(status),
    state,
    meetingUrl,
    meetingNote,
    lastUpdated: clean(lastUpdated),
    note: !blank(extra) && !/^https?:\/\//i.test(String(extra).trim()) ? clean(extra) : '',
  };
}

// Map a manually-entered object (from the dashboard's Add form, stored in KV)
// into the same dashboard shape, using the identical color logic.
export function manualToDashboard(m) {
  const liveRaw = m.liveRaw || (m.isLive ? 'Live on Munshot' : 'Not Live');
  const { state, isLive } = classify({ status: m.status, liveRaw, stage: m.stage });
  const url = String(m.meetingUrl ?? '').trim();
  const customers = splitCustomers(m.customer);
  const customerList = customers.length ? customers : ['Unassigned'];
  const serial = Number.parseInt(m.serial, 10);
  return {
    serial: Number.isFinite(serial) ? serial : null,
    source: 'manual',
    id: m.id,
    name: clean(m.name),
    customers: customerList,
    customer: customerList.join(' & '),
    owner: clean(m.owner) || 'Unassigned',
    liveRaw: clean(liveRaw),
    isLive,
    requirements: clean(m.requirements),
    improvement: clean(m.improvement),
    feedback: clean(m.feedback),
    status: clean(m.status),
    state,
    meetingUrl: /^https?:\/\//i.test(url) ? url : '',
    meetingNote: '',
    lastUpdated: clean(m.lastUpdated),
    note: clean(m.note),
  };
}

// Convert raw CSV rows into standalone editable entries (the shape stored in
// KV as manual entries) — used by the one-time "import & go standalone" step.
export function rowsToEntries(rows) {
  const out = [];
  for (const cells of rows) {
    const d = rowToDashboard(cells);
    if (!d) continue;
    out.push({
      id: 'sheet-' + d.serial,
      createdAt: new Date().toISOString(),
      serial: d.serial,
      name: d.name,
      customer: d.customer,
      owner: d.owner,
      liveRaw: d.liveRaw,
      stage: d.state,
      status: d.status,
      requirements: d.requirements,
      improvement: d.improvement,
      feedback: d.feedback,
      meetingUrl: d.meetingUrl,
      lastUpdated: d.lastUpdated,
      note: d.note || d.meetingNote || '',
    });
  }
  return out;
}

const STATE_IDS = new Set(STATES.map((s) => s.id));

// Build the full dataset + summary from parsed CSV rows, merged with any
// manually-entered records, an extra roster (team members / clients added by
// hand), and a daily-update overlay — all stored in KV.
//   opts = { roster: { owners:[], customers:[] }, updates: { [dashboardId]: [{date,state,note}] } }
export function buildDataset(rows, manual = [], opts = {}) {
  const sheet = [];
  for (const r of rows) {
    const d = rowToDashboard(r);
    if (d) sheet.push(d);
  }
  sheet.sort((a, b) => a.serial - b.serial);

  const manualCards = manual.map(manualToDashboard).filter((d) => d.name);
  // Order by serial when present (imported / numbered cards), unnumbered last.
  const dashboards = [...sheet, ...manualCards].sort((a, b) => {
    const as = Number.isFinite(a.serial) ? a.serial : Infinity;
    const bs = Number.isFinite(b.serial) ? b.serial : Infinity;
    return as - bs;
  });

  // Apply the daily-update history: the latest update wins for state + note.
  const updates = opts.updates || {};
  for (const d of dashboards) {
    const log = Array.isArray(updates[d.id]) ? updates[d.id] : [];
    d.updates = log;
    if (log.length) {
      const latest = log[log.length - 1];
      if (latest.state && STATE_IDS.has(latest.state)) d.state = latest.state;
      if (latest.note) d.latestNote = clean(latest.note);
      if (latest.date) d.lastUpdated = clean(latest.date);
    }
  }

  // Priority flag overlay (set of dashboard ids marked as priority).
  const priority = opts.priority || {};
  for (const d of dashboards) d.priority = !!priority[d.id];

  const counts = Object.fromEntries(STATES.map((s) => [s.id, 0]));
  for (const d of dashboards) counts[d.state]++;
  const liveCount = dashboards.filter((d) => d.isLive).length;
  const priorityCount = dashboards.filter((d) => d.priority).length;

  // Detect gaps in the serial sequence (e.g. #34 & #36 missing).
  const serials = dashboards.map((d) => d.serial).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const gaps = [];
  if (serials.length) {
    const have = new Set(serials);
    for (let n = serials[0]; n <= serials[serials.length - 1]; n++) {
      if (!have.has(n)) gaps.push(n);
    }
  }

  const roster = opts.roster || {};
  return {
    generatedAt: new Date().toISOString(),
    standalone: !!opts.standalone,
    total: dashboards.length,
    sheetCount: sheet.length,
    manualCount: manualCards.length,
    counts,
    liveCount,
    priorityCount,
    gaps,
    customers: [...new Set([...dashboards.flatMap((d) => d.customers), ...(roster.customers || [])])].filter(Boolean).sort(),
    owners: [...new Set([...dashboards.map((d) => d.owner), ...(roster.owners || [])])].filter(Boolean).sort(),
    people: opts.people || {},
    tasks: opts.tasks || {},
    dashboards,
  };
}
