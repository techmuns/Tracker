// ── Publish a dashboard to the Munshot admin page ────────────────────────
// POSTs a tracker card to Munshot's create-dashboard endpoint so it goes live
// on chat.muns without anyone re-typing it there.
//
//   POST https://birdnest.muns.io/agents/dashboards
//   Authorization: Bearer <MUNS_TOKEN>     ← from the Worker env, never the browser
//   accept: */*
//   Content-Type: application/json
//
// The endpoint has a default so publishing works with no configuration;
// MUNS_DASHBOARD_URL overrides it if it ever moves.
import { normalizeSections, normalizeRepo } from './classify.js';

export const DEFAULT_DASHBOARD_URL = 'https://birdnest.muns.io/agents/dashboards';

// Optional fields the API accepts that this app has no source of data for yet.
// They are passed through when a stored entry happens to carry one, and left
// out entirely otherwise — an omitted key is safer than an invented value,
// especially for organizationIds/userIds, where a wrong guess would expose a
// dashboard to the wrong client.
const PASSTHROUGH = [
  'widgetConfig', 'tickers', 'sectors',
  'industries', 'keywords', 'organizationIds', 'userIds',
];

// `category` is REQUIRED — Munshot rejects a publish without it:
//   400 ["category should not be empty", "category must be a string"]
// The tracker has no category field of its own, so this is the fallback for
// any dashboard that doesn't carry one. "markets" is the value from Munshot's
// own API example, so it is known-good rather than invented; override it per
// deployment with MUNS_DEFAULT_CATEGORY, or per dashboard by putting a
// `category` on the stored entry.
export const DEFAULT_CATEGORY = 'General';

// The categories Munshot's own "Create Dashboard" form offers. It also accepts
// a new one typed in free-hand, so this is a suggestion list, not an enum —
// the field is a datalist, not a locked dropdown. (Their live list also holds
// case-duplicates and a couple of test entries; those are left out here.)
export const MUNS_CATEGORIES = [
  'Analytics', 'Companies', 'Crypto', 'Design POC', 'ERP', 'General',
  'Heatmaps', 'India', 'Industry', 'Insights', 'Labs', 'Macro', 'Markets',
  'News', 'Portfolios', 'Private Markets', 'Research', 'Screener', 'Sectors',
  'Trading', 'Workspace', 'Others',
];

// The two embed modes Munshot's form offers. "iframe" is confirmed by their
// API example; the TradingView wire value is inferred from the label and
// should be corrected here if Munshot rejects it. Every dashboard the tracker
// holds is a URL embed, so that stays the default.
export const MUNS_DASHBOARD_TYPES = [
  { value: 'iframe', label: 'URL Embed (Iframe)' },
  { value: 'tradingview', label: 'TradingView Widget (JSON)' },
];

// The tracker stores sections as a nested tree — [{ name, children:[…] }] —
// but the API wants a flat object of { sectionName: description }. Flatten one
// level: each top-level section becomes a key, its immediate children become
// the description. Deeper nesting cannot survive a string value, so it is
// dropped rather than mangled.
export function sectionsToMap(list) {
  const out = {};
  for (const node of normalizeSections(list)) {
    const name = String(node.name || '').trim();
    if (!name) continue;
    const kids = (node.children || []).map((c) => String((c && c.name) || '').trim()).filter(Boolean);
    out[name] = kids.join(', ');
  }
  return out;
}

// Pure, so the mapping can be tested without touching the network.
export function buildPublishPayload(entry, opts) {
  const e = entry || {};
  const fallbackCategory = String((opts && opts.defaultCategory) || DEFAULT_CATEGORY).trim() || DEFAULT_CATEGORY;
  const category = String(e.category || '').trim() || fallbackCategory;
  const payload = {
    type: e.dashboardType || 'iframe',          // URL Embed (Iframe) by default
    link: String(e.dashboardUrl || '').trim(),
    title: String(e.name || '').trim(),
    description: String(e.note || '').trim(),
    category,
    sections: sectionsToMap(e.sections),
    favourite: e.favourite === true,
  };
  const repo = normalizeRepo(e.githubRepo);
  if (repo) payload.githubLink = 'https://github.com/' + repo;
  for (const k of PASSTHROUGH) {
    const v = e[k];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    payload[k] = v;
  }
  return payload;
}

// Which credential creates the dashboard, in order of preference:
//
//  1. userToken — the signed-in Munshot user's JWT, handed to the browser by
//     the host iframe and forwarded on this one request. This is the one that
//     actually works: creating a dashboard is a privileged action and the
//     user has that authority in their own right.
//  2. MUNS_DASHBOARD_TOKEN — an optional higher-privilege service token, for
//     publishing outside the iframe (a cron, say) if one is ever issued.
//  3. MUNS_TOKEN — the everyday service token. Fine for digest emails and the
//     people directory; Munshot answers 403 "Insufficient authority" when it
//     tries to create a dashboard, so it is the last resort, not the default.
//
// The user's JWT is used for this call and nothing else: never stored, never
// logged, never sent anywhere but Munshot. We don't verify it here either —
// Munshot is the authority on its own token and will reject a bad one.
export function publishToken(env, userToken) {
  const fromUser = typeof userToken === 'string' ? userToken.trim() : '';
  if (fromUser) return { token: fromUser, source: 'host-user' };
  if (env && env.MUNS_DASHBOARD_TOKEN) return { token: env.MUNS_DASHBOARD_TOKEN, source: 'dashboard-token' };
  if (env && env.MUNS_TOKEN) return { token: env.MUNS_TOKEN, source: 'muns-token' };
  return { token: '', source: 'none' };
}

// Munshot nests validation errors as {message:{message:[...]}} — pull out the
// human-readable rules wherever they sit.
function validationMessages(j) {
  const outer = j && j.message;
  const inner = outer && typeof outer === 'object' && !Array.isArray(outer) ? outer.message : outer;
  if (Array.isArray(inner)) return inner.filter((x) => typeof x === 'string');
  if (typeof inner === 'string') return [inner];
  return [];
}

export async function publishToMuns(env, entry, userToken) {
  const { token, source } = publishToken(env, userToken);
  if (!token) {
    return { ok: false, error: 'No Munshot credential available — open the tracker from the Munshot site so it can pass your session, or set MUNS_TOKEN.' };
  }
  const endpoint = env.MUNS_DASHBOARD_URL || DEFAULT_DASHBOARD_URL;
  const payload = buildPublishPayload(entry, { defaultCategory: env.MUNS_DEFAULT_CATEGORY });

  // Munshot's own form makes these compulsory, and a dashboard published
  // without them never goes live. Catching it here names the field plainly
  // instead of bouncing off the API with a 400.
  const missing = [];
  if (!payload.title) missing.push('a dashboard name');
  if (!payload.link) missing.push('a dashboard link');
  if (!payload.category) missing.push('a category');
  if (!payload.type) missing.push('a dashboard type');
  if (!Array.isArray(payload.organizationIds) || !payload.organizationIds.length) {
    missing.push('at least one organisation (who can see it on Munshot)');
  }
  if (missing.length) {
    return {
      ok: false,
      error: 'Add ' + missing.join(', ') + ' in Edit, then publish again.',
      missing,
    };
  }

  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify(payload),
    });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch (e) {}
    const ref = j && (j.id || j._id || j.dashboardId || (j.data && (j.data.id || j.data._id)));
    // authSource names WHICH credential was used, never its value — the whole
    // 403 diagnosis turns on knowing whether the user's JWT or a service token
    // made the call.
    const out = { ok: r.ok, status: r.status, ref: ref ? String(ref) : '', response: (t || '').slice(0, 600), authSource: source };
    // On rejection, echo where we posted and what we sent, so a contract
    // mismatch is visible in one round. No secrets: the token travels in the
    // Authorization header and is never part of the body.
    if (!r.ok) {
      out.endpoint = String(endpoint);
      out.sent = payload;
      // Translate the two auth failures, which are otherwise indistinguishable
      // walls of JSON. The 401/403 split is the whole diagnosis: 401 means the
      // token was rejected, 403 means it was accepted but lacks the role.
      if (r.status === 403) {
        out.hint = source === 'host-user'
          ? 'Munshot recognised you but your user account is not allowed to create dashboards — ask for that permission on your Munshot account.'
          : 'Published with a service token, which Munshot does not allow to create dashboards. Open the tracker from inside the Munshot site so it can use your own session instead.';
      } else if (r.status === 401) {
        out.hint = source === 'host-user'
          ? 'Munshot rejected your session — it may have expired. Reload the Munshot page and try again.'
          : 'Munshot rejected the service token — check MUNS_TOKEN (or MUNS_DASHBOARD_TOKEN if set).';
      } else if (r.status === 400) {
        // Field-level validation. Munshot returns every failing rule at once,
        // so surfacing them plainly names exactly what the payload is missing.
        const msgs = validationMessages(j);
        if (msgs.length) out.hint = 'Munshot rejected the dashboard: ' + msgs.join('; ');
      }
    }
    return out;
  } catch (e) {
    return {
      ok: false,
      error: 'Could not reach ' + endpoint + ' — ' + String((e && e.message) || e),
      endpoint: String(endpoint),
      sent: payload,
    };
  }
}
