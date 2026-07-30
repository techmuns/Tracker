import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, parseCommits, aggregateByDay, recentDays, overviewFromRows, ghTokensFor, mergeCommitsIntoActivity, overviewFromActivity, matchRepos, pagesRepoMap } from '../src/commits.js';

test('dayKey buckets by IST (UTC+5:30)', () => {
  assert.equal(dayKey(Date.parse('2026-07-28T18:29:00Z')), '2026-07-28'); // 23:59 IST
  assert.equal(dayKey(Date.parse('2026-07-28T18:30:00Z')), '2026-07-29'); // 00:00 IST next day
  assert.equal(dayKey(Date.parse('2026-07-28T20:00:00Z')), '2026-07-29'); // 01:30 IST next day
});

test('parseCommits normalizes the REST commit shape', () => {
  const rows = parseCommits([
    { sha: 'abc', commit: { message: 'Fix bug\n\nlong body', author: { date: '2026-07-28T10:00:00Z', name: 'Vipul' } }, author: { login: 'vipul' } },
    { sha: 'no-date', commit: { message: 'x', author: {} } }, // no date → dropped
    { commit: { message: 'no sha', author: { date: '2026-07-28T10:00:00Z' } } }, // no sha → dropped
  ], 'muns/dash', 'd1');
  assert.equal(rows.length, 1);
  assert.deepEqual({ sha: rows[0].sha, repo: rows[0].repo, dashboardId: rows[0].dashboardId, author: rows[0].author, message: rows[0].message, day: rows[0].day },
    { sha: 'abc', repo: 'muns/dash', dashboardId: 'd1', author: 'vipul', message: 'Fix bug', day: '2026-07-28' });
});

test('parseCommits also accepts the webhook push shape', () => {
  const rows = parseCommits([
    { id: 'def', message: 'Add table', timestamp: '2026-07-28T11:00:00Z', author: { name: 'Sahil', username: 'sahil' } },
  ], 'muns/dash', '');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sha, 'def');
  assert.equal(rows[0].author, 'Sahil');
  assert.equal(rows[0].message, 'Add table');
});

test('aggregateByDay counts per repo per day', () => {
  const agg = aggregateByDay([
    { repo: 'a/b', day: '2026-07-28' }, { repo: 'a/b', day: '2026-07-28' }, { repo: 'a/b', day: '2026-07-29' },
    { repo: 'c/d', day: '2026-07-29' },
  ]);
  assert.deepEqual(agg, { 'a/b': { '2026-07-28': 2, '2026-07-29': 1 }, 'c/d': { '2026-07-29': 1 } });
});

test('recentDays returns N ascending day keys ending today', () => {
  const days = recentDays(3, Date.parse('2026-07-29T12:00:00Z'));
  assert.deepEqual(days, ['2026-07-27', '2026-07-28', '2026-07-29']);
});

test('overviewFromRows maps repos to dashboards and computes today/yesterday/7d', () => {
  const now = Date.parse('2026-07-29T12:00:00Z'); // IST day 2026-07-29
  const dashboards = [{ id: 'd1', name: 'Alpha', githubRepo: 'muns/alpha', owner: 'Vipul', customers: ['Acme'] }];
  const rows = [
    { repo: 'muns/alpha', day: '2026-07-29' }, { repo: 'muns/alpha', day: '2026-07-29' }, // today x2
    { repo: 'muns/alpha', day: '2026-07-28' },                                             // yesterday x1
    { repo: 'muns/alpha', day: '2026-06-01' },                                             // outside 14d window → ignored
  ];
  const ov = overviewFromRows(rows, dashboards, 14, now);
  assert.equal(ov.enabled, true);
  assert.equal(ov.today, 2);
  assert.equal(ov.yesterday, 1);
  assert.equal(ov.last7, 3);
  assert.equal(ov.total, 3);
  assert.equal(ov.dashboards.length, 1);
  const d = ov.dashboards[0];
  assert.equal(d.id, 'd1');
  assert.equal(d.byDay['2026-07-29'], 2);
  assert.equal(d.byDay['2026-07-28'], 1);
  assert.equal(d.today, 2);
});

test('overviewFromRows buckets commits from an unmapped repo under a repo: id', () => {
  const now = Date.parse('2026-07-29T12:00:00Z');
  const ov = overviewFromRows([{ repo: 'stranger/repo', day: '2026-07-29' }], [], 14, now);
  assert.equal(ov.today, 1);
  assert.equal(ov.dashboards[0].id, 'repo:stranger/repo');
  assert.equal(ov.dashboards[0].name, 'stranger/repo');
});

test('ghTokensFor matches the repo owner to the right account token', () => {
  const env = { CEEKAY_AT: 'cee', TECHMUNS_AT: 'tech' };
  // owner-matched token first, then the other as fallback
  assert.deepEqual(ghTokensFor(env, 'ceekay/alpha'), ['cee', 'tech']);
  assert.deepEqual(ghTokensFor(env, 'techmuns/beta'), ['tech', 'cee']);
  // unknown owner (e.g. an org) → try both
  assert.deepEqual(ghTokensFor(env, 'someorg/gamma'), ['cee', 'tech']);
  // only one token present
  assert.deepEqual(ghTokensFor({ CEEKAY_AT: 'cee' }, 'techmuns/x'), ['cee']);
  // none present
  assert.deepEqual(ghTokensFor({}, 'ceekay/x'), []);
});

test('mergeCommitsIntoActivity folds rows in, deduped by SHA', () => {
  const act = {};
  const d1 = mergeCommitsIntoActivity(act, [
    { sha: 'a', repo: 'r/x', day: '2026-07-30', message: 'Add login' },
    { sha: 'b', repo: 'r/x', day: '2026-07-30', message: 'Fix crash' },
    { sha: 'c', repo: 'r/x', day: '2026-07-29', message: 'Scaffold' },
  ]);
  assert.equal(act['r/x'].days['2026-07-30'].count, 2);
  assert.equal(act['r/x'].days['2026-07-29'].count, 1);
  assert.equal(act['r/x'].days['2026-07-30'].ai, false); // not AI-summarized yet
  assert.deepEqual([...d1['r/x']].sort(), ['2026-07-29', '2026-07-30']);
  // re-merging the same SHAs changes nothing (idempotent)
  const d2 = mergeCommitsIntoActivity(act, [{ sha: 'a', repo: 'r/x', day: '2026-07-30', message: 'Add login' }]);
  assert.equal(act['r/x'].days['2026-07-30'].count, 2);
  assert.equal(Object.keys(d2).length, 0);
});

test('overviewFromActivity computes today/yesterday/7d from KV activity', () => {
  const now = Date.parse('2026-07-30T12:00:00Z'); // IST day 2026-07-30
  const activity = { 'muns/alpha': { days: {
    '2026-07-30': { count: 3, msgs: [], summary: '• did stuff' },
    '2026-07-29': { count: 1, msgs: [], summary: '' },
  }, shas: {} } };
  const dashboards = [{ id: 'd1', name: 'Alpha', githubRepo: 'muns/alpha', owner: 'Vipul', customers: [] }];
  const ov = overviewFromActivity(activity, dashboards, 14, now);
  assert.equal(ov.enabled, true);
  assert.equal(ov.today, 3);
  assert.equal(ov.yesterday, 1);
  assert.equal(ov.total, 4);
  assert.equal(ov.dashboards[0].id, 'd1');
  assert.equal(ov.dashboards[0].summaries['2026-07-30'], '• did stuff');
});

test('matchRepos fuzzy-matches dashboards to the right repo', () => {
  const repos = [
    { full_name: 'ceekay/google-dashboard', name: 'google-dashboard' },
    { full_name: 'ceekay/cpu-prices-tracker', name: 'cpu-prices-tracker' },
    { full_name: 'techmuns/health-insurer', name: 'health-insurer' },
    { full_name: 'techmuns/aer-fleet-pricing', name: 'aer-fleet-pricing' },
    { full_name: 'ceekay/unrelated-thing', name: 'unrelated-thing' },
  ];
  const dashboards = [
    { id: '1', name: 'Google Dashboard', githubRepo: '' },
    { id: '2', name: 'CPU Prices Tracker Dashboard', githubRepo: '' },
    { id: '3', name: 'HealthInsurer Dashborad', githubRepo: '' },   // typo on purpose
    { id: '4', name: 'AER Fleet Pricing Dashboard', githubRepo: '' },
  ];
  const out = matchRepos(dashboards, repos);
  assert.equal(out.find(o => o.id === '1').suggestion, 'ceekay/google-dashboard');
  assert.equal(out.find(o => o.id === '2').suggestion, 'ceekay/cpu-prices-tracker');
  assert.equal(out.find(o => o.id === '3').suggestion, 'techmuns/health-insurer');
  assert.equal(out.find(o => o.id === '4').suggestion, 'techmuns/aer-fleet-pricing');
  assert.ok(out.find(o => o.id === '1').score >= 50);
});

test('matchRepos leaves a blank suggestion when nothing is close', () => {
  const out = matchRepos([{ id: 'x', name: 'Completely Different Thing', githubRepo: '' }],
    [{ full_name: 'a/zzz', name: 'zzz' }]);
  assert.equal(out[0].suggestion, '');
});

test('matchRepos uses the deploy-URL slug (strongest signal)', () => {
  const repos = [
    { full_name: 'techmuns/oem-trends-tracker', name: 'oem-trends-tracker' },
    { full_name: 'ceekay/solardash', name: 'solardash' },
    { full_name: 'ceekay/misc', name: 'misc' },
  ];
  const dashboards = [
    // vague display name, but the deploy URL nails the repo
    { id: '1', name: 'OEM Trends', githubRepo: '', dashboardUrl: 'https://oem-trends-tracker.pages.dev/' },
    { id: '2', name: 'Solar Board', githubRepo: '', dashboardUrl: 'https://solardash-2of.pages.dev/x' },
  ];
  const out = matchRepos(dashboards, repos);
  assert.equal(out.find(o => o.id === '1').suggestion, 'techmuns/oem-trends-tracker');
  assert.equal(out.find(o => o.id === '2').suggestion, 'ceekay/solardash');
});

test('pagesRepoMap + matchRepos gives exact repos from Cloudflare Pages', () => {
  const projects = [
    { subdomain: 'oem-trends-tracker.pages.dev', source: { config: { owner: 'techmuns', repo_name: 'oem-trends-tracker' } } },
    { name: 'solardash', subdomain: 'solardash-2of.pages.dev', source: { config: { owner: 'ceekay', repo_name: 'solar-dashboard' } } },
  ];
  const map = pagesRepoMap(projects);
  assert.equal(map['oem-trends-tracker'], 'techmuns/oem-trends-tracker');
  assert.equal(map['solardash-2of'], 'ceekay/solar-dashboard');
  // exactMap overrides fuzzy — note the repo name (solar-dashboard) differs from the slug
  const out = matchRepos(
    [{ id: '1', name: 'Solar Board', dashboardUrl: 'https://solardash-2of.pages.dev/' }],
    [{ full_name: 'ceekay/misc', name: 'misc' }], 0.34, map);
  assert.equal(out[0].suggestion, 'ceekay/solar-dashboard');
  assert.equal(out[0].exact, true);
  assert.equal(out[0].score, 100);
});
