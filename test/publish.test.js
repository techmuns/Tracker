import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublishPayload, sectionsToMap, publishToMuns, publishToken, DEFAULT_DASHBOARD_URL } from '../src/publish.js';

// A complete, publishable entry: Munshot requires name, link, category, type
// and at least one organisation.
const entry = {
  name: 'The Wrap',
  dashboardUrl: 'https://app.munshot.com/d/the-wrap',
  note: 'Weekly wrap dashboard',
  category: 'Research',
  dashboardType: 'iframe',
  organizationIds: [1],
  githubRepo: 'techmuns/the-wrap',
  sections: [
    { name: 'Overview', children: [{ name: 'Summary' }, { name: 'Highlights' }] },
    { name: 'Financials', children: [] },
  ],
};

test('payload matches the documented Munshot contract', () => {
  const p = buildPublishPayload(entry);
  assert.equal(p.type, 'iframe');
  assert.equal(p.title, 'The Wrap');
  assert.equal(p.link, 'https://app.munshot.com/d/the-wrap');
  assert.equal(p.description, 'Weekly wrap dashboard');
  assert.equal(p.githubLink, 'https://github.com/techmuns/the-wrap');
  assert.equal(p.favourite, false);
  assert.equal(p.category, 'Research');
  assert.deepEqual(p.organizationIds, [1]);
});

test('sections flatten from the stored tree into the API object map', () => {
  // The API wants { name: description }, not the tracker's [{name, children}].
  assert.deepEqual(sectionsToMap(entry.sections), {
    Overview: 'Summary, Highlights',
    Financials: '',
  });
  const p = buildPublishPayload(entry);
  assert.ok(!Array.isArray(p.sections), 'sections must be an object, not an array');
});

test('sections survive junk input', () => {
  assert.deepEqual(sectionsToMap(null), {});
  assert.deepEqual(sectionsToMap([{ name: '  ' }, null, { children: [] }]), {});
});

test('githubLink accepts a full URL as well as owner/repo', () => {
  assert.equal(
    buildPublishPayload({ name: 'x', githubRepo: 'https://github.com/techmuns/Tracker.git' }).githubLink,
    'https://github.com/techmuns/Tracker',
  );
  // Omitted entirely when there's no repo, rather than sent empty.
  assert.equal('githubLink' in buildPublishPayload({ name: 'x' }), false);
});

test('category is always sent — Munshot rejects a publish without it', () => {
  // 400 ["category should not be empty", "category must be a string"]
  assert.equal(buildPublishPayload({ name: 'x' }).category, 'General');
  assert.equal(buildPublishPayload({ name: 'x', category: 'research' }).category, 'research');
  // Deployment-wide override, and the per-entry value still wins over it.
  assert.equal(buildPublishPayload({ name: 'x' }, { defaultCategory: 'internal' }).category, 'internal');
  assert.equal(buildPublishPayload({ name: 'x', category: 'research' }, { defaultCategory: 'internal' }).category, 'research');
  // Never blank, whatever junk arrives.
  assert.equal(buildPublishPayload({ name: 'x', category: '   ' }).category, 'General');
  assert.equal(buildPublishPayload({ name: 'x' }, { defaultCategory: '  ' }).category, 'General');
  for (const p of [buildPublishPayload({ name: 'x' }), buildPublishPayload({ name: 'x', category: 'z' })]) {
    assert.equal(typeof p.category, 'string');
    assert.ok(p.category.length > 0);
  }
});

test('validation errors are surfaced field by field', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({
      message: { message: ['category should not be empty', 'category must be a string'], error: 'Bad Request', statusCode: 400 },
    }),
  });
  try {
    const r = await publishToMuns({ MUNS_TOKEN: 't' }, entry);
    assert.match(r.hint, /category should not be empty; category must be a string/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('optional API fields are omitted unless the entry actually carries them', () => {
  const bare = buildPublishPayload({ name: 'x' });
  // category is deliberately NOT in this list — Munshot requires it, so it
  // always ships with a default (see the category test above).
  for (const k of ['organizationIds', 'userIds', 'tickers', 'sectors', 'industries', 'keywords', 'widgetConfig']) {
    assert.equal(k in bare, false, `${k} must not be invented`);
  }
  const rich = buildPublishPayload({ name: 'x', organizationIds: [1, 2], keywords: ['equity'], category: 'markets' });
  assert.deepEqual(rich.organizationIds, [1, 2]);
  assert.deepEqual(rich.keywords, ['equity']);
  assert.equal(rich.category, 'markets');
});

test('publishToMuns posts to the default endpoint with bearer auth', async () => {
  const orig = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return { ok: true, status: 201, text: async () => JSON.stringify({ id: 42 }) };
  };
  try {
    const r = await publishToMuns({ MUNS_TOKEN: 'tok' }, entry);
    assert.equal(r.ok, true);
    assert.equal(r.ref, '42');
    assert.equal(seen.url, DEFAULT_DASHBOARD_URL);
    assert.equal(seen.headers.Authorization, 'Bearer tok');
    assert.equal(seen.headers.accept, '*/*');
    assert.equal(seen.body.title, 'The Wrap');
    // The token must never travel in the body.
    assert.ok(!JSON.stringify(seen.body).includes('tok'));
  } finally {
    globalThis.fetch = orig;
  }
});

test('MUNS_DASHBOARD_URL overrides the default endpoint', async () => {
  const orig = globalThis.fetch;
  let url = null;
  globalThis.fetch = async (u) => {
    url = String(u);
    return { ok: true, status: 200, text: async () => '{}' };
  };
  try {
    await publishToMuns({ MUNS_TOKEN: 't', MUNS_DASHBOARD_URL: 'https://elsewhere.example/x' }, entry);
    assert.equal(url, 'https://elsewhere.example/x');
  } finally {
    globalThis.fetch = orig;
  }
});

test('a rejection reports the endpoint and what was sent', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => '{"message":"category should not be empty"}',
  });
  try {
    const r = await publishToMuns({ MUNS_TOKEN: 't' }, entry);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.match(r.response, /category should not be empty/);
    assert.equal(r.endpoint, DEFAULT_DASHBOARD_URL);
    assert.equal(r.sent.title, 'The Wrap');
  } finally {
    globalThis.fetch = orig;
  }
});

test("the host user's JWT outranks every service token", async () => {
  const orig = globalThis.fetch;
  let auth = null;
  globalThis.fetch = async (u, init) => {
    auth = init.headers.Authorization;
    return { ok: true, status: 200, text: async () => '{}' };
  };
  try {
    const env = { MUNS_TOKEN: 'email-tok', MUNS_DASHBOARD_TOKEN: 'admin-tok' };
    const r = await publishToMuns(env, entry, 'user-jwt');
    assert.equal(auth, 'Bearer user-jwt');
    assert.equal(r.authSource, 'host-user');

    // Blank/whitespace user tokens fall through rather than sending garbage.
    const blank = await publishToMuns(env, entry, '   ');
    assert.equal(auth, 'Bearer admin-tok');
    assert.equal(blank.authSource, 'dashboard-token');
  } finally {
    globalThis.fetch = orig;
  }
});

test('publishToken reports the source without leaking the value', () => {
  assert.deepEqual(publishToken({ MUNS_TOKEN: 'm' }, 'jwt'), { token: 'jwt', source: 'host-user' });
  assert.deepEqual(publishToken({ MUNS_TOKEN: 'm', MUNS_DASHBOARD_TOKEN: 'd' }), { token: 'd', source: 'dashboard-token' });
  assert.deepEqual(publishToken({ MUNS_TOKEN: 'm' }), { token: 'm', source: 'muns-token' });
  assert.deepEqual(publishToken({}), { token: '', source: 'none' });
});

test('403 hint depends on which credential was used', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '{"message":"Insufficient authority"}' });
  try {
    const asUser = await publishToMuns({ MUNS_TOKEN: 't' }, entry, 'user-jwt');
    assert.match(asUser.hint, /your user account is not allowed/);

    const asService = await publishToMuns({ MUNS_TOKEN: 't' }, entry);
    assert.match(asService.hint, /Open the tracker from inside the Munshot site/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('MUNS_DASHBOARD_TOKEN takes precedence over MUNS_TOKEN', async () => {
  const orig = globalThis.fetch;
  let auth = null;
  globalThis.fetch = async (u, init) => {
    auth = init.headers.Authorization;
    return { ok: true, status: 200, text: async () => '{}' };
  };
  try {
    await publishToMuns({ MUNS_TOKEN: 'email-tok', MUNS_DASHBOARD_TOKEN: 'admin-tok' }, entry);
    assert.equal(auth, 'Bearer admin-tok');
    await publishToMuns({ MUNS_TOKEN: 'email-tok' }, entry);
    assert.equal(auth, 'Bearer email-tok', 'falls back when the override is unset');
  } finally {
    globalThis.fetch = orig;
  }
});

test('403 vs 401 get distinct, readable hints', async () => {
  const orig = globalThis.fetch;
  const withStatus = (status, body) => async () => ({ ok: false, status, text: async () => body });
  try {
    globalThis.fetch = withStatus(403, '{"message":{"message":"Insufficient authority"}}');
    const forbidden = await publishToMuns({ MUNS_TOKEN: 't' }, entry);
    assert.match(forbidden.hint, /does not allow to create dashboards/);

    globalThis.fetch = withStatus(401, '{"message":"Unauthorized"}');
    const unauth = await publishToMuns({ MUNS_TOKEN: 't' }, entry);
    assert.match(unauth.hint, /rejected the service token/);

    // Same statuses, but as the signed-in user — different advice entirely.
    globalThis.fetch = withStatus(401, '{"message":"Unauthorized"}');
    const staleSession = await publishToMuns({ MUNS_TOKEN: 't' }, entry, 'jwt');
    assert.match(staleSession.hint, /may have expired/);

    globalThis.fetch = withStatus(400, '{"message":"link must be a URL address"}');
    const badReq = await publishToMuns({ MUNS_TOKEN: 't' }, entry);
    assert.match(badReq.hint, /link must be a URL address/, 'a 400 names the offending field');
  } finally {
    globalThis.fetch = orig;
  }
});

test('missing token and missing title are caught before any request', async () => {
  const orig = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, text: async () => '{}' }; };
  try {
    const noTok = await publishToMuns({}, entry);
    assert.equal(noTok.ok, false);
    assert.match(noTok.error, /MUNS_TOKEN/);

    // Munshot's form makes name, link, category, type and organisation
    // compulsory; catch them here rather than bouncing off the API.
    const bare = await publishToMuns({ MUNS_TOKEN: 't' }, { name: '   ' });
    assert.equal(bare.ok, false);
    assert.deepEqual(bare.missing, [
      'a dashboard name',
      'a dashboard link',
      'at least one organisation (who can see it on Munshot)',
    ]);
    assert.match(bare.error, /then publish again/);

    // A complete entry missing only its audience.
    const noOrg = await publishToMuns({ MUNS_TOKEN: 't' }, { ...entry, organizationIds: [] });
    assert.deepEqual(noOrg.missing, ['at least one organisation (who can see it on Munshot)']);

    assert.equal(called, false, 'no request should be attempted');
  } finally {
    globalThis.fetch = orig;
  }
});
