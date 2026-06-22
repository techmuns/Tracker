// classify.js — turns a messy spreadsheet row into a clean dashboard object
// with one of 6 work-states. Pure functions: no Worker/Node APIs, so this is
// runnable + testable anywhere.
//
// ── The 6-state waterfall (most complete → least) ──────────────────────────
// The COLOR comes from the free-text "Status" column. "Live or Not" is a
// SEPARATE signal shown as a badge, but it also promotes a finished/empty
// status to green (a card that's live with no outstanding work).
//
//   live        green   Live on Munshot, nothing outstanding
//   done        blue    Work complete on our side, not yet live
//   review      yellow  Almost done — sanity check / client feedback / QA
//   in_progress orange  Actively being built, wired, or fixed
//   blocked     red     Waiting on client, on hold, or unresolved
//   not_started grey    Not started or not assigned
//
// Tune the keyword lists below to change how Status text maps to a state.

export const STATES = [
  { id: 'live',        label: 'Live',              color: '#22c55e', desc: 'Live on Munshot, nothing outstanding' },
  { id: 'done',        label: 'Done — not live',   color: '#3b82f6', desc: 'Work complete on our side, not yet live' },
  { id: 'review',      label: 'In Review / QA',    color: '#eab308', desc: 'Almost done — sanity check / client feedback' },
  { id: 'in_progress', label: 'In Progress',       color: '#f97316', desc: 'Actively being built / wired / fixed' },
  { id: 'blocked',     label: 'Blocked / On Hold', color: '#ef4444', desc: 'Waiting on client or unresolved' },
  { id: 'not_started', label: 'Not Started',       color: '#9ca3af', desc: 'Not started or not assigned' },
];

export const STATE_BY_ID = Object.fromEntries(STATES.map((s) => [s.id, s]));

// Keyword buckets, checked in this order — first match wins.
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
    'dashboard is live', 'dashboard live', 'all done',
  ],
  not_started: ['not started', 'not assigned'],
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

// Core: decide the state id for a row.
export function classify({ status, liveRaw }) {
  const isLive = isLiveValue(liveRaw);
  const t = clean(status).toLowerCase();

  if (!blank(status)) {
    if (has(t, KEYWORDS.review))      return { state: 'review',      isLive };
    if (has(t, KEYWORDS.blocked))     return { state: 'blocked',     isLive };
    if (has(t, KEYWORDS.in_progress)) return { state: 'in_progress', isLive };
    if (has(t, KEYWORDS.done))        return { state: isLive ? 'live' : 'done', isLive };
    if (has(t, KEYWORDS.not_started)) return { state: 'not_started', isLive };
  }
  // No decisive keyword: live wins green, otherwise it hasn't started.
  return { state: isLive ? 'live' : 'not_started', isLive };
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

  return {
    serial,
    source: 'sheet',
    id: 'sheet-' + serial,
    name: clean(name),
    customer: canonicalCustomer(customer) || 'Unassigned',
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
  const { state, isLive } = classify({ status: m.status, liveRaw });
  const url = String(m.meetingUrl ?? '').trim();
  return {
    serial: null,
    source: 'manual',
    id: m.id,
    name: clean(m.name),
    customer: canonicalCustomer(m.customer) || 'Unassigned',
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

// Build the full dataset + summary from parsed CSV rows, merged with any
// manually-entered records (KV).
export function buildDataset(rows, manual = []) {
  const sheet = [];
  for (const r of rows) {
    const d = rowToDashboard(r);
    if (d) sheet.push(d);
  }
  sheet.sort((a, b) => a.serial - b.serial);

  const manualCards = manual.map(manualToDashboard).filter((d) => d.name);
  const dashboards = [...sheet, ...manualCards]; // sheet first (by serial), manual after

  const counts = Object.fromEntries(STATES.map((s) => [s.id, 0]));
  for (const d of dashboards) counts[d.state]++;

  // Detect gaps in the SHEET serial sequence (e.g. rows 34 & 36 missing).
  const serials = sheet.map((d) => d.serial);
  const gaps = [];
  if (serials.length) {
    for (let n = serials[0]; n <= serials[serials.length - 1]; n++) {
      if (!serials.includes(n)) gaps.push(n);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    total: dashboards.length,
    sheetCount: sheet.length,
    manualCount: manualCards.length,
    counts,
    gaps,
    customers: [...new Set(dashboards.map((d) => d.customer))].sort(),
    owners: [...new Set(dashboards.map((d) => d.owner))].sort(),
    dashboards,
  };
}
