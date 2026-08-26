import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublishPayload, sectionsToMap, publishToMuns, DEFAULT_DASHBOARD_URL } from '../src/publish.js';

const entry = {
  name: 'The Wrap',
  dashboardUrl: 'https://app.munshot.com/d/the-wrap',
  note: 'Weekly wrap dashboard',
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

test('optional API fields are omitted unless the entry actually carries them', () => {
  const bare = buildPublishPayload({ name: 'x' });
  for (const k of ['organizationIds', 'userIds', 'tickers', 'sectors', 'industries', 'keywords', 'category', 'widgetConfig']) {
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
    assert.match(forbidden.hint, /not allowed to create dashboards/);

    globalThis.fetch = withStatus(401, '{"message":"Unauthorized"}');
    const unauth = await publishToMuns({ MUNS_TOKEN: 't' }, entry);
    assert.match(unauth.hint, /rejected the token itself/);

    globalThis.fetch = withStatus(400, '{"message":"category should not be empty"}');
    const badReq = await publishToMuns({ MUNS_TOKEN: 't' }, entry);
    assert.equal(badReq.hint, undefined, 'validation errors speak for themselves');
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

    const noTitle = await publishToMuns({ MUNS_TOKEN: 't' }, { name: '   ' });
    assert.equal(noTitle.ok, false);
    assert.match(noTitle.error, /title is required/);

    assert.equal(called, false, 'no request should be attempted');
  } finally {
    globalThis.fetch = orig;
  }
});
