import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, rowToDashboard, buildDataset, manualToDashboard, rowsToEntries, splitCustomers, isLiveValue } from '../src/classify.js';
import { parseCsv } from '../src/csv.js';

test('isLiveValue reads the Live column', () => {
  assert.equal(isLiveValue('Live on Munshot'), true);
  assert.equal(isLiveValue('On Munshot'), true);
  assert.equal(isLiveValue('Not Live'), false);
  assert.equal(isLiveValue('-'), false);
  assert.equal(isLiveValue(''), false);
});

test('classify maps representative real statuses', () => {
  // not started
  assert.equal(classify({ status: 'Not Started Yet', liveRaw: 'Not Live' }).state, 'not_started');
  assert.equal(classify({ status: 'Not Assigned Yet - 20 May', liveRaw: 'Not Live' }).state, 'not_started');
  // blocked
  assert.equal(classify({ status: 'on Hold', liveRaw: '-' }).state, 'blocked');
  assert.equal(classify({ status: 'Need to take details from clients', liveRaw: '-' }).state, 'blocked');
  assert.equal(classify({ status: 'Client requirements Pending', liveRaw: 'Not Live' }).state, 'blocked');
  // in progress
  assert.equal(classify({ status: 'Fixing Portfolio and News agents', liveRaw: 'Live on Munshot' }).state, 'in_progress');
  assert.equal(classify({ status: 'In Making', liveRaw: 'Not Live' }).state, 'in_progress');
  assert.equal(classify({ status: 'Data wiring remained - 20 May', liveRaw: 'Not Live' }).state, 'in_progress');
  // review
  assert.equal(classify({ status: 'Almost completed from my side', liveRaw: 'Live on Munshot' }).state, 'review');
  assert.equal(classify({ status: 'need a data sanity check and some company needs a fix', liveRaw: 'Live on Munshot' }).state, 'review');
  assert.equal(classify({ status: 'Feedback pending from Chiraag sir', liveRaw: 'Live on Munshot' }).state, 'review');
  // done + live => live (green)
  assert.equal(classify({ status: 'All changes done', liveRaw: 'Live on Munshot' }).state, 'live');
  assert.equal(classify({ status: 'Made a Agent', liveRaw: 'On Munshot' }).state, 'live');
  // empty status but live => live
  assert.equal(classify({ status: '-', liveRaw: 'Live on Munshot' }).state, 'live');
  // empty status, not live => not started
  assert.equal(classify({ status: '', liveRaw: 'Not Live' }).state, 'not_started');
});

test('rowToDashboard skips spreadsheet noise', () => {
  assert.equal(rowToDashboard(['', '', '', 'Assigned to ', '', '', '']), null); // spacer
  assert.equal(rowToDashboard(['', 'No serial', 'Cust']), null);                  // no serial
  const d = rowToDashboard(['7', 'Portfolio monitoring', 'Vimana Capital', '', 'Not Live', 'Pending', '-', 'Pending Call', 'Need to take details from clients', '-', '']);
  assert.equal(d.serial, 7);
  assert.equal(d.owner, 'Unassigned');
  assert.equal(d.state, 'blocked');
});

test('rowToDashboard prefers a real URL for the meeting link across spilled columns', () => {
  const d = rowToDashboard(['4', 'Drug Launch', 'Beas Capital', 'Vipul', 'Live on Munshot', 'Received', 'x', 'y', 'All things fixed', 'Short Phone Call Recording', '21/05/2026', 'https://youtu.be/8QbN64Y8MVw']);
  assert.equal(d.meetingUrl, 'https://youtu.be/8QbN64Y8MVw');
  assert.equal(d.meetingNote, 'Short Phone Call Recording');
  assert.equal(d.state, 'live');
});

test('buildDataset counts, sorts, and finds serial gaps', () => {
  const csv = [
    ',Dashboards,Name of Customer,Assigned to,Live or Not,Reqs,Improve,Feedback,Status,Link,Updated,',
    '3,C dash,Cust C,Neha,Live on Munshot,Received,-,-,Real data wired in,-,,',
    '1,A dash,Cust A,Naval,Not Live,Received,-,-,Not Started Yet,-,,',
    ',,,,,,,,,,,',            // noise
    '5,E dash,Cust A,Vipul,Live on Munshot,Received,-,-,All changes done,-,,',
  ].join('\n');
  const data = buildDataset(parseCsv(csv));
  assert.equal(data.total, 3);
  assert.deepEqual(data.dashboards.map((d) => d.serial), [1, 3, 5]); // sorted
  assert.deepEqual(data.gaps, [2, 4]);                               // missing serials
  assert.equal(data.counts.not_started, 1);
  assert.equal(data.counts.in_progress, 1);
  assert.equal(data.counts.live, 1);
  assert.deepEqual(data.owners, ['Naval', 'Neha', 'Vipul']);
});

test('splitCustomers separates shared dashboards into distinct clients', () => {
  assert.deepEqual(splitCustomers('Arisag Partners & Beas Capital'), ['Arisag Partners', 'Beas Capital']);
  assert.deepEqual(splitCustomers('Incred & Arisag Partners'), ['Incred', 'Arisag Partners']);
  assert.deepEqual(splitCustomers('Vimana & Sage One'), ['Vimana Capital', 'Sage One']); // alias still applies
  assert.deepEqual(splitCustomers('Beas Capital'), ['Beas Capital']);                     // single unchanged
});

test('a shared-dashboard row lands under each client', () => {
  const d = rowToDashboard(['18', 'CG Checklist', 'Arisag Partners & Beas Capital', 'Nadam', 'Live on Munshot', 'Received', 'x', 'y', 'bug', '-', '']);
  assert.deepEqual(d.customers, ['Arisag Partners', 'Beas Capital']);
  assert.equal(d.customer, 'Arisag Partners & Beas Capital'); // display keeps the joined label
});

test('buildDataset customer list contains the split clients individually', () => {
  const csv = [
    ',Dashboards,Name,Assigned,Live,Reqs,Imp,Fb,Status,Link,Updated,',
    '1,A,Arisag Partners & Beas Capital,Naval,Not Live,Received,-,-,Not Started Yet,-,,',
  ].join('\n');
  const data = buildDataset(parseCsv(csv));
  assert.deepEqual(data.customers, ['Arisag Partners', 'Beas Capital']);
});

test('roster adds team members / clients with no dashboards yet', () => {
  const csv = [
    ',Dashboards,Name,Assigned,Live,Reqs,Imp,Fb,Status,Link,Updated,',
    '1,A,Beas Capital,Naval,Not Live,Received,-,-,Not Started Yet,-,,',
  ].join('\n');
  const data = buildDataset(parseCsv(csv), [], { roster: { owners: ['Zoya'], customers: ['New Fund'] } });
  assert.ok(data.owners.includes('Zoya'));
  assert.ok(data.customers.includes('New Fund'));
});

test('daily-update overlay: latest update changes state and counts', () => {
  const csv = [
    ',Dashboards,Name,Assigned,Live,Reqs,Imp,Fb,Status,Link,Updated,',
    '1,A,Beas Capital,Naval,Not Live,Received,-,-,Not Started Yet,-,,',
  ].join('\n');
  const updates = { 'sheet-1': [
    { ts: 1, date: '01/06/2026', state: 'in_progress', note: 'started' },
    { ts: 2, date: '05/06/2026', state: 'review', note: 'QA now' },
  ] };
  const data = buildDataset(parseCsv(csv), [], { updates });
  const d = data.dashboards[0];
  assert.equal(d.state, 'review');           // latest update wins
  assert.equal(d.latestNote, 'QA now');
  assert.equal(d.lastUpdated, '05/06/2026');
  assert.equal(data.counts.review, 1);       // counts reflect the override
  assert.equal(data.counts.not_started, 0);
});

test('rowsToEntries converts sheet rows into editable entries keeping serials', () => {
  const csv = [
    ',Dashboards,Name,Assigned,Live,Reqs,Imp,Fb,Status,Link,Updated,',
    '1,A,Beas Capital,Naval,Not Live,Received,-,-,Not Started Yet,-,,',
    '2,B,Arisaig,Vipul,Live on Munshot,-,-,-,Live,-,,',
  ].join('\n');
  const entries = rowsToEntries(parseCsv(csv));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, 'sheet-1');
  assert.equal(entries[0].serial, 1);
  assert.equal(entries[1].name, 'B');
});

test('standalone build: no sheet rows, entries carry serials and sort by them', () => {
  const manual = [
    { id: 'sheet-2', serial: 2, name: 'Two', owner: 'Vipul', customer: 'Arisaig', status: 'Live' },
    { id: 'x', name: 'No Serial', owner: 'Naval', customer: 'Beas', status: '' },
    { id: 'sheet-1', serial: 1, name: 'One', owner: 'Naval', customer: 'Beas', status: '' },
  ];
  const data = buildDataset([], manual, { standalone: true });
  assert.equal(data.standalone, true);
  assert.equal(data.sheetCount, 0);
  assert.deepEqual(data.dashboards.map((d) => d.name), ['One', 'Two', 'No Serial']); // serial asc, unnumbered last
});

test('people are passed through to the dataset for the employee terminal', () => {
  const people = { Naval: { joinDate: '2025-01-15', days: { '2026-06-23': 'present' } } };
  const data = buildDataset([], [{ id: 'a', name: 'D', owner: 'Naval', customer: 'Beas' }], { people, standalone: true });
  assert.equal(data.people.Naval.joinDate, '2025-01-15');
});

test('manualToDashboard uses the same colour logic and is tagged manual', () => {
  const d = manualToDashboard({ id: 'abc', name: 'Revenue Tracker', customer: 'Vimana', owner: 'Vipul', liveRaw: 'Live on Munshot', status: 'All changes done', meetingUrl: 'https://x.test/v' });
  assert.equal(d.source, 'manual');
  assert.equal(d.serial, null);
  assert.equal(d.customer, 'Vimana Capital'); // alias applied to manual too
  assert.equal(d.state, 'live');              // done + live => green
  assert.equal(d.meetingUrl, 'https://x.test/v');
});

test('buildDataset merges manual entries after sheet rows and recounts', () => {
  const csv = [
    ',Dashboards,Name,Assigned,Live,Reqs,Imp,Fb,Status,Link,Updated,',
    '1,A dash,Cust A,Naval,Not Live,Received,-,-,Not Started Yet,-,,',
  ].join('\n');
  const manual = [{ id: 'm1', name: 'Manual one', customer: 'Cust Z', owner: 'Neha', liveRaw: 'Not Live', status: 'In Making' }];
  const data = buildDataset(parseCsv(csv), manual);
  assert.equal(data.total, 2);
  assert.equal(data.sheetCount, 1);
  assert.equal(data.manualCount, 1);
  assert.equal(data.dashboards[0].source, 'sheet');   // sheet first
  assert.equal(data.dashboards[1].source, 'manual');  // manual after
  assert.equal(data.counts.not_started, 1);
  assert.equal(data.counts.in_progress, 1);
});
