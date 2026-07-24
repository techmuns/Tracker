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

// One cohesive, calm scale (muted slate → soft indigo/violet → emerald) instead
// of a 7-colour rainbow — reads as steady progress toward "done".
export const STATES = [
  { id: 'not_started',      label: 'Not Started Yet',        color: '#cdd3de', desc: 'Not started yet / not assigned' },
  { id: 'ui_ux',            label: 'UI/UX Creation',         color: '#aeb8f2', desc: 'Designing the dashboard UI/UX' },
  { id: 'data_integration', label: 'Data Integration',       color: '#8f9bec', desc: 'Wiring live data into the dashboard' },
  { id: 'final_check',      label: 'Final Check',            color: '#7381e6', desc: 'Internal QA / final verification' },
  { id: 'feedback_open',    label: 'Open for Feedbacks',     color: '#8f74e8', desc: 'Shared with the client, awaiting feedback' },
  { id: 'feedback_incorp',  label: 'Feedback Incorporation', color: '#7a5ee0', desc: 'Incorporating client feedback' },
  { id: 'completed',        label: 'Completed',              color: '#21ba72', desc: 'Finished' },
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
// Fold "Not Assigned" / "-" / "(Priority)" / status-like junk into a blank
// owner. Real names never start with "(" or "-", so those are junk.
const ownerName = (raw) => {
  const o = clean(raw);
  return (!o || /^[(\-]/.test(o) || /^(not assigned|unassigned|none|na|n\/a|-+|tbd|priority)$/i.test(o)) ? '' : o;
};

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

// Normalize a dashboard's links into [{label, url}]. Accepts a modern array of
// {label,url}, and falls back to a single legacy meetingUrl as the first link.
export function normalizeLinks(links, legacyUrl, legacyLabel = 'First client meeting') {
  const out = [];
  if (Array.isArray(links)) {
    for (const l of links) {
      const url = String((l && l.url) ?? '').trim();
      if (!/^https?:\/\//i.test(url)) continue;
      out.push({ label: clean((l && l.label) || '') || 'Link', url });
    }
  }
  if (!out.length) {
    const u = String(legacyUrl ?? '').trim();
    if (/^https?:\/\//i.test(u)) out.push({ label: legacyLabel, url: u });
  }
  return out;
}

// Progress 0..1 along the 7-stage pipeline (stage 1 = 0%, stage 7 = 100%).
export function progressOf(stateId) {
  const i = STATES.findIndex((s) => s.id === stateId);
  if (i < 0) return 0;
  return STATES.length > 1 ? i / (STATES.length - 1) : 0;
}

// Canonical customer names — collapse obvious duplicates so counts/grouping are
// correct. Add aliases here as the sheet grows. (Keys matched case-insensitively.)
const CUSTOMER_ALIASES = {
  'vimana': 'Vimana Capital',
};
function canonicalCustomer(name) {
  const c = clean(name);
  // Drop junk placeholders (legacy "Unassigned"/"-"/etc.) so they never show as a client.
  if (/^(unassigned|not assigned|none|n\/a|na|-+|tbd|priority)$/i.test(c)) return '';
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

// The published sheet's columns get reordered over time, so map them by HEADER
// NAME rather than by fixed position. Returns { field: columnIndex } for the
// fields we recognise, or null if this row isn't a usable header.
const HEADER_ALIASES = {
  name: ['dashboards', 'dashboard', 'dashboard name', 'name of dashboard'],
  customer: ['name of customer', 'customer name', 'customer', 'client', 'name'],
  owner: ['assigned to', 'owner', 'assignee', 'assigned'],
  liveRaw: ['live', 'live or not', 'is live'],
  status: ['execution status', 'status', 'stage'],
  requirements: ['comments - deadline', 'comments', 'comment', 'deadline', 'requirements', 'reqs', 'requirement'],
  improvement: ['improvement', 'improve', 'improvements'],
  feedback: ['feedback'],
  link: ['meeting link', 'link', 'recording', 'recording / link'],
  lastUpdated: ['last updated', 'updated', 'last update'],
};
export function mapHeader(row) {
  if (!Array.isArray(row)) return null;
  const cells = row.map((s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim());
  const idx = {};
  for (const [field, names] of Object.entries(HEADER_ALIASES)) {
    const i = cells.findIndex((c) => c && names.includes(c));
    if (i !== -1) idx[field] = i;
  }
  // Trust it as a header only if the essentials are present.
  return (idx.name != null && idx.owner != null) ? idx : null;
}
// Reorder a raw row into the canonical positions rowToDashboard expects.
export function remapRow(cells, idx) {
  const at = (f) => (idx[f] != null ? cells[idx[f]] : '');
  return [cells[0], at('name'), at('customer'), at('owner'), at('liveRaw'),
    at('requirements'), at('improvement'), at('feedback'), at('status'),
    at('link'), at('lastUpdated'), ''];
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
  const customerList = splitCustomers(customer);

  return {
    serial,
    source: 'sheet',
    id: 'sheet-' + serial,
    name: clean(name),
    customers: customerList,
    customer: customerList.join(' & '),
    owner: ownerName(owner),
    liveRaw: clean(liveRaw),
    isLive,
    requirements: clean(requirements),
    improvement: clean(improvement),
    feedback: clean(feedback),
    status: clean(status),
    state,
    meetingUrl,
    meetingNote,
    links: normalizeLinks(null, meetingUrl, meetingNote || 'Recording / link'),
    lastUpdated: clean(lastUpdated),
    note: !blank(extra) && !/^https?:\/\//i.test(String(extra).trim()) ? clean(extra) : '',
    dueDate: '',
    manualStatus: '',
    requirementFiles: [],
    feedbacks: [],
  };
}

// Map a manually-entered object (from the dashboard's Add form, stored in KV)
// into the same dashboard shape, using the identical color logic.
export function manualToDashboard(m) {
  const liveRaw = m.liveRaw || (m.isLive ? 'Live on Munshot' : 'Not Live');
  const { state, isLive } = classify({ status: m.status, liveRaw, stage: m.stage });
  const url = String(m.meetingUrl ?? '').trim();
  const customerList = splitCustomers(m.customer);
  const serial = Number.parseInt(m.serial, 10);
  return {
    serial: Number.isFinite(serial) ? serial : null,
    source: 'manual',
    id: m.id,
    name: clean(m.name),
    customers: customerList,
    customer: customerList.join(' & '),
    owner: ownerName(m.owner),
    liveRaw: clean(liveRaw),
    isLive,
    requirements: clean(m.requirements),
    improvement: clean(m.improvement),
    feedback: clean(m.feedback),
    status: clean(m.status),
    state,
    links: normalizeLinks(m.links, url),
    meetingUrl: (normalizeLinks(m.links, url)[0] || {}).url || '',
    dashboardUrl: String(m.dashboardUrl ?? '').trim(),
    meetingNote: '',
    lastUpdated: clean(m.lastUpdated),
    note: clean(m.note),
    dueDate: clean(m.dueDate),
    manualStatus: clean(m.manualStatus),
    requirementFiles: Array.isArray(m.requirementFiles) ? m.requirementFiles : [],
    feedbacks: normalizeFeedbacks(m.feedbacks),
    sections: normalizeSections(m.sections),
    // Brief for the assignee: what to do + reference images/files + links.
    brief: clean(m.brief),
    briefFiles: Array.isArray(m.briefFiles) ? m.briefFiles : [],
    briefLinks: normalizeLinks(m.briefLinks),
    publishedAt: m.publishedAt || '',
    publishRef: m.publishRef || '',
  };
}

// Sections/subsections tree (admin-page structure), capped at MAX_SECTION_DEPTH
// levels. Each node is { name, children:[…] }; empty/garbage nodes are dropped.
export const MAX_SECTION_DEPTH = 4;
export function normalizeSections(list, depth = 1) {
  if (!Array.isArray(list) || depth > MAX_SECTION_DEPTH) return [];
  const out = [];
  for (const n of list) {
    if (!n || typeof n !== 'object') continue;
    const name = clean(n.name);
    const children = depth < MAX_SECTION_DEPTH ? normalizeSections(n.children, depth + 1) : [];
    if (name || children.length) out.push({ name, children });
  }
  return out;
}

// Structured feedbacks: each is a dated client comment with optional link/files
// and a yes/no "implemented" toggle. Tolerates partially-filled objects.
export function normalizeFeedbacks(list) {
  if (!Array.isArray(list)) return [];
  return list.map((f, i) => ({
    id: f.id || 'fb' + i,
    label: clean(f.label) || 'Feedback ' + (i + 1),
    category: clean(f.category),
    date: clean(f.date),
    text: clean(f.text),
    link: /^https?:\/\//i.test(String(f.link ?? '').trim()) ? String(f.link).trim() : '',
    files: Array.isArray(f.files) ? f.files : [],
    implemented: !!f.implemented,
    perPage: Math.min(3, Math.max(1, parseInt(f.perPage, 10) || 1)), // screenshots per deck page (1–3)
  }));
}

// Convert raw CSV rows into standalone editable entries (the shape stored in
// KV as manual entries) — used by the one-time "import & go standalone" step.
export function rowsToEntries(rows) {
  const out = [];
  const hdr = rows.length ? mapHeader(rows[0]) : null;
  const dataRows = hdr ? rows.slice(1) : rows;
  let lastCustomer = '';
  for (const raw of dataRows) {
    const cells = hdr ? remapRow(raw, hdr) : (Array.isArray(raw) ? raw.slice() : raw);
    if (Array.isArray(cells)) {
      if (cells[2] != null && String(cells[2]).trim()) lastCustomer = String(cells[2]);
      else if (lastCustomer) cells[2] = lastCustomer;
    }
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
      links: d.links,
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
  const hdr = rows.length ? mapHeader(rows[0]) : null;
  const dataRows = hdr ? rows.slice(1) : rows;
  let lastCustomer = '';
  for (const r of dataRows) {
    const cells = hdr ? remapRow(r, hdr) : (Array.isArray(r) ? r.slice() : r);
    // Merged client cells export blank on continuation rows — carry the client down.
    if (Array.isArray(cells)) {
      if (cells[2] != null && String(cells[2]).trim()) lastCustomer = String(cells[2]);
      else if (lastCustomer) cells[2] = lastCustomer;
    }
    const d = rowToDashboard(cells);
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

  // Daily-update history. For app-stored entries the stage lives on the entry
  // itself (canonical); for read-only SHEET rows the latest update's stage can
  // override it (so you can advance a sheet card without touching the sheet).
  // The latest update always supplies the display note + date.
  const updates = opts.updates || {};
  const notes = opts.notes || {};
  for (const d of dashboards) {
    const log = Array.isArray(updates[d.id]) ? updates[d.id] : [];
    d.updates = log;
    // Free-form working notes a teammate jots while working the dashboard.
    d.notes = Array.isArray(notes[d.id]) ? notes[d.id] : [];
    if (log.length) {
      const latest = log[log.length - 1];
      if (d.source === 'sheet' && latest.state && STATE_IDS.has(latest.state)) d.state = latest.state;
      if (latest.note) d.latestNote = clean(latest.note);
      if (latest.date) d.lastUpdated = clean(latest.date);
    }
    d.progress = progressOf(d.state);
  }

  // Priority overlay — a map of { dashboardId: level } (1 = highest). 0/absent = none.
  const priority = opts.priority || {};
  for (const d of dashboards) {
    const raw = priority[d.id];
    const lvl = raw === true ? 1 : Number.parseInt(raw, 10); // tolerate legacy boolean
    d.priorityLevel = Number.isFinite(lvl) && lvl > 0 ? lvl : 0;
    d.priority = d.priorityLevel > 0;
  }

  // Assignment overlay — { dashboardId: ownerName }. An explicit (often
  // auto-balanced) owner that overrides the sheet/manual owner, so work can be
  // (re)assigned without editing the Google Sheet.
  const assignments = opts.assignments || {};
  for (const d of dashboards) {
    const a = assignments[d.id];
    if (a && String(a).trim()) { d.owner = clean(a); d.autoAssigned = true; }
  }

  const counts = Object.fromEntries(STATES.map((s) => [s.id, 0]));
  for (const d of dashboards) counts[d.state]++;
  const liveCount = dashboards.filter((d) => d.isLive).length;
  const priorityCount = dashboards.filter((d) => d.priority).length;
  // Feedback roll-up (for the to-do views): pending = not yet implemented.
  let fbTotal = 0, fbPending = 0;
  for (const d of dashboards) for (const f of (d.feedbacks || [])) { fbTotal++; if (!f.implemented) fbPending++; }

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
    fbTotal,
    fbPending,
    gaps,
    customers: [...new Set([...dashboards.flatMap((d) => d.customers), ...(roster.customers || [])])].filter(Boolean).sort(),
    owners: [...new Set([...dashboards.map((d) => d.owner), ...(roster.owners || [])])].filter(Boolean).sort(),
    people: opts.people || {},
    clientDetails: opts.clients || {},
    dashboards,
  };
}
