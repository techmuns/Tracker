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
  'widgetConfig', 'category', 'tickers', 'sectors',
  'industries', 'keywords', 'organizationIds', 'userIds',
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
export function buildPublishPayload(entry) {
  const e = entry || {};
  const payload = {
    type: e.dashboardType || 'iframe',          // URL Embed (Iframe) by default
    link: String(e.dashboardUrl || '').trim(),
    title: String(e.name || '').trim(),
    description: String(e.note || '').trim(),
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

// Creating a dashboard needs more authority than sending an email or reading
// the directory, so the endpoint can 403 ("Insufficient authority") on a token
// that works fine elsewhere. MUNS_DASHBOARD_TOKEN lets publishing use a
// higher-privilege token without disturbing MUNS_TOKEN, which the digest
// emails and the people directory both depend on. Falls back to MUNS_TOKEN
// when it isn't set, so nothing changes until you need it.
export function publishToken(env) {
  return (env && (env.MUNS_DASHBOARD_TOKEN || env.MUNS_TOKEN)) || '';
}

export async function publishToMuns(env, entry) {
  const token = publishToken(env);
  if (!token) {
    return { ok: false, error: 'MUNS_TOKEN is not set in the Worker environment (wrangler secret put MUNS_TOKEN).' };
  }
  const endpoint = env.MUNS_DASHBOARD_URL || DEFAULT_DASHBOARD_URL;
  const payload = buildPublishPayload(entry);
  if (!payload.title) return { ok: false, error: 'A dashboard title is required before publishing.' };

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
    const out = { ok: r.ok, status: r.status, ref: ref ? String(ref) : '', response: (t || '').slice(0, 600) };
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
        out.hint = 'Munshot accepted the token but this account is not allowed to create dashboards. Ask for the dashboard-create permission on it, or put a token that already has it in MUNS_DASHBOARD_TOKEN.';
      } else if (r.status === 401) {
        out.hint = 'Munshot rejected the token itself — check MUNS_TOKEN (or MUNS_DASHBOARD_TOKEN if set).';
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
