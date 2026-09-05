'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sink = require('../../src/sinks/github-issue');
const { request } = require('../../src/http');
const { createGithubFake } = require('../fixtures/github-fake');
const stamp = '2026-09-05T12:00:00.000Z';
async function setup(t, options) {
  const fake = await createGithubFake({ now: new Date(stamp), ...options });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-gh-'));
  t.after(async () => { await fake.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const ctx = { home, http: request, now: () => stamp, log() {}, config: { host: 'host', sink: { repo: 'test/inbox', token: 'test.token.' + 'value.1', api_base: fake.url }, watch: { notify_confirm_sec: 120 }, max_api_calls_per_pass: 500 } };
  return { fake, ctx };
}
function event(id, ts = stamp) { return { schema: 1, id, ts, kind: 'error', agent: 'a', host: 'host', fingerprint: '0123456789abcdef', fpv: 1, message: 'failure', meta: {} }; }
function group(...events) { return { fingerprint: '0123456789abcdef', fpv: 1, agent: 'a', count: events.length, events }; }
function failureBody(ids, fp = '0123456789abcdef') { return '<!-- errmeter:failure fp=' + fp + ' fpv=1 ids=' + ids + ' count=1 first=' + stamp + ' last=' + stamp + ' schema=1 -->\n\n```json\n' + JSON.stringify(event(ids)) + '\n```'; }
function writes(fake) { return fake.requests.filter(r => ['POST', 'PATCH', 'DELETE'].includes(r.method)); }

test('GitHub creates once, comments once, and recovers every delivered id without writes', async t => {
  const { fake, ctx } = await setup(t);
  const first = await sink.deliverFailureGroup(ctx, group(event('one'), event('two')));
  assert.equal(first.created, true); assert.deepEqual(first.delivered, ['one', 'two']);
  assert.match(fake.issues[0].body, /ids=one,two count=2/);
  const second = await sink.deliverFailureGroup(ctx, group(event('three')));
  assert.equal(second.created, false); assert.match(fake.comments[0].body, /errmeter:occurrence ids=three count=1/);
  const before = writes(fake).length;
  assert.deepEqual((await sink.deliverFailureGroup(ctx, group(event('one'), event('two'), event('three')))).delivered, ['one', 'two', 'three']);
  assert.equal(writes(fake).length, before);
  const detail = await sink.getFailure(ctx, first.ref);
  assert.equal(detail.occurrences, 3); assert.deepEqual(detail.occurrenceIds, ['one', 'two', 'three']);
  assert.equal((await sink.listOpenFailures(ctx)).length, 1);
  for (const r of fake.requests) { assert.equal(r.headers.authorization, 'Bearer ' + ctx.config.sink.token); assert.ok(!r.url.includes(ctx.config.sink.token)); assert.ok(!JSON.stringify(r.body || '').includes(ctx.config.sink.token)); }
});

test('GitHub direct delivery redacts every event string before composing issue text', async t => {
  const { fake, ctx } = await setup(t);
  const secret = ['ghp_', 's'.repeat(24)].join('');
  const bearer = ['bearer', 'fixture', 'credential'].join('-');
  const unclean = { ...event('unclean'), message: 'failure ' + secret, detail: 'detail ' + secret + '\nBearer ' + bearer };
  await sink.deliverFailureGroup(ctx, group(unclean));

  const { title, body } = fake.issues[0];
  assert.equal(title.includes(secret), false);
  assert.equal(body.includes(secret), false);
  assert.equal(body.includes(bearer), false);
  assert.match(body, /^<!-- errmeter:([a-z-]+)(?: ([^\n]*?))? -->$/m);
  const human = body.split('\n\n')[1];
  assert.equal(human.includes(secret), false);
  const fenced = body.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(fenced);
  const parsed = JSON.parse(fenced[1]);
  assert.equal(JSON.stringify(parsed).includes(secret), false);
  assert.equal(JSON.stringify(parsed).includes(bearer), false);
});

test('GitHub incomplete list or exhausted API budget never creates', async t => {
  const { fake, ctx } = await setup(t, { pageSize: 1 });
  fake.seedIssue({ body: failureBody('other', '1111111111111111'), labels: ['errmeter:failure'] });
  fake.seedIssue({ body: failureBody('other2', '2222222222222222'), labels: ['errmeter:failure'] });
  ctx.config.max_pages_per_list = 1;
  await assert.rejects(sink.deliverFailureGroup(ctx, group(event('one'))), { code: 'ELOOKUP_INCOMPLETE' });
  assert.equal(ctx.lookup_incomplete, true); assert.equal(writes(fake).length, 0);
  ctx.config.max_api_calls_per_pass = 0;
  await assert.rejects(sink.deliverFailureGroup(ctx, group(event('one'))), { code: 'EAPI_BUDGET' });
  assert.equal(writes(fake).length, 0);
});

test('GitHub reconciles duplicate issues to lowest number and migrates only missing ids', async t => {
  const { fake, ctx } = await setup(t);
  const a = fake.seedIssue({ body: failureBody('one'), labels: ['errmeter:failure'] });
  const b = fake.seedIssue({ body: failureBody('two'), labels: ['errmeter:failure'] });
  await sink.deliverFailureGroup(ctx, group(event('three')));
  assert.equal(a.state, 'open'); assert.equal(b.state, 'closed');
  assert.ok(fake.comments.some(c => c.issue_number === a.number && /ids=two count=1/.test(c.body)));
  assert.ok(fake.comments.some(c => c.issue_number === b.number && c.body === '<!-- errmeter:duplicate-of ref=' + a.number + ' -->'));
  const before = writes(fake).length;
  await sink.deliverFailureGroup(ctx, group(event('two')));
  assert.equal(writes(fake).length, before);
});

test('GitHub heartbeat honors marker time and roles', async t => {
  const { fake, ctx } = await setup(t);
  const hb = { id: 'heartbeat', kind: 'heartbeat', agent: 'watcher/a', host: 'host', ts: stamp, message: 'alive', meta: { role: 'watcher' } };
  await sink.deliverHeartbeat(ctx, hb);
  assert.ok(fake.issues[0].labels.some(l => l.name === 'errmeter:role:watcher'));
  const before = writes(fake).length;
  await sink.deliverHeartbeat(ctx, { ...hb, ts: '2026-09-05T11:59:00.000Z' });
  assert.equal(writes(fake).length, before);
  await sink.deliverHeartbeat(ctx, { ...hb, ts: '2026-09-05T12:01:00.000Z' });
  assert.equal((await sink.listHeartbeats(ctx))[0].lastSeen, '2026-09-05T12:01:00.000Z');
});

test('GitHub alert winner marks channel none, next candidate loses and deletes only itself', async t => {
  const { fake, ctx } = await setup(t);
  const alert = { key: 'all-watchers-silent', body: '@owner watchers silent' };
  assert.equal((await sink.upsertAlert(ctx, alert)).winner, true);
  assert.match(fake.comments[0].body, /notified=.* channel=none/);
  const winningId = fake.comments[0].id;
  assert.equal((await sink.upsertAlert(ctx, alert)).winner, false);
  assert.equal(fake.issues.length, 1);
  assert.ok(fake.comments.some(c => c.id === winningId));
  assert.ok(!fake.requests.some(r => r.method === 'DELETE' && r.url.endsWith('/' + winningId)));
});

test('GitHub alert cover elects after an unconfirmed winner expires', async t => {
  const { fake, ctx } = await setup(t);
  const a = fake.seedIssue({ body: '<!-- errmeter:alert key=stale -->', labels: ['errmeter:alert'] });
  const original = fake.seedComment(a.number, { body: '<!-- errmeter:alert-episode key=stale host=old ts=2026-09-05T11:57:00.000Z -->' });
  assert.equal((await sink.upsertAlert(ctx, { key: 'stale', body: 'alert' })).winner, true);
  assert.match(original.body, /notified=/);
  assert.ok(fake.comments.some(c => /cover=1 notified=/.test(c.body)));
});

test('GitHub occurrence throttle retains fresh events while acknowledging old ids', async t => {
  const { fake, ctx } = await setup(t);
  const a = fake.seedIssue({ body: failureBody('one'), labels: ['errmeter:failure'] });
  fake.seedComment(a.number, { body: '<!-- errmeter:occurrence ids=two count=1 first=' + stamp + ' last=' + stamp + ' ts=' + stamp + ' -->' });
  ctx.config.max_comments_per_issue_per_hour = 1;
  const result = await sink.deliverFailureGroup(ctx, group(event('one'), event('three')));
  assert.deepEqual(result.delivered, ['one']); assert.equal(result.pending, true); assert.equal(writes(fake).length, 0);
});

test('GitHub counter refs survive crash recovery without reposting or event ids', async t => {
  const { fake, ctx } = await setup(t);
  const g = { ...group(event('synthetic')), count: 9, counter: 'nonce.0' };
  await sink.deliverFailureGroup(ctx, g);
  assert.match(fake.issues[0].body, /ids= count=9/); assert.match(fake.issues[0].body, /counter_ref=nonce\.0/);
  assert.equal(fake.comments.length, 0);
  assert.equal(writes(fake).length, 1);
  const before = writes(fake).length;
  assert.equal((await sink.deliverFailureGroup(ctx, g)).skipped, true);
  assert.equal(writes(fake).length, before);
  await sink.deliverFailureGroup(ctx, { ...g, counter: 'nonce.1', count: 2 });
  assert.match(fake.comments[0].body, /counter_ref=nonce\.1/);
  assert.equal((await sink.getFailure(ctx, fake.issues[0].number)).occurrences, 11);
});

test('GitHub rolls over full issues and preserves crash recovery against predecessor', async t => {
  const { fake, ctx } = await setup(t);
  await sink.deliverFailureGroup(ctx, group(event('one')));
  await sink.deliverFailureGroup(ctx, group(event('two')));
  ctx.config.max_comments_per_issue = 1;
  await sink.deliverFailureGroup(ctx, group(event('three')));
  assert.equal(fake.issues[0].state, 'closed'); assert.equal(fake.issues[1].state, 'open');
  assert.match(fake.issues[1].body, /continues=1/);
  const before = writes(fake).length;
  await sink.deliverFailureGroup(ctx, group(event('one')));
  assert.equal(writes(fake).length, before);
});

function claimMarker(watcher, expires, ref = 'new') { return '<!-- errmeter:claim watcher=' + watcher + ' expires=' + expires + ' ref=' + ref + ' -->'; }

test('GitHub claim, renewal, and release use board time and exact protocol markers', async t => {
  let boardNow = stamp;
  const { fake, ctx } = await setup(t, { now: () => boardNow, pageSize: 1 });
  const row = fake.seedIssue({ body: failureBody('one'), labels: ['errmeter:failure'] });
  ctx.now = () => '2040-01-01T00:00:00Z';
  const result = await sink.claim(ctx, row.number, { watcherId: 'first', ttlSec: 900 });
  assert.deepEqual(result, { won: true, claimRef: fake.comments[0].id, expiresAt: '2026-09-05T12:15:00.000Z' });
  assert.equal(fake.comments[0].body, claimMarker('first', result.expiresAt));
  assert.ok(row.labels.some(label => label.name === 'errmeter:claimed'));
  boardNow = '2026-09-05T12:03:00.000Z';
  const renewed = await sink.renewClaim(ctx, row.number, { watcherId: 'first', claimRef: result.claimRef, ttlSec: 900 });
  assert.deepEqual(renewed, { ok: true, expiresAt: '2026-09-05T12:18:00.000Z' });
  assert.equal(fake.comments[1].body, claimMarker('first', renewed.expiresAt, result.claimRef));
  boardNow = '2026-09-05T12:16:00.000Z';
  assert.equal((await sink.getFailure(ctx, row.number)).claim.expiresAt, renewed.expiresAt);
  await sink.releaseClaim(ctx, row.number, { watcherId: 'first', claimRef: result.claimRef });
  assert.equal(fake.comments.at(-1).body, '<!-- errmeter:release watcher=first ref=' + result.claimRef + ' -->');
  assert.equal((await sink.getFailure(ctx, row.number)).claim, null);
  assert.ok(!row.labels.some(label => label.name === 'errmeter:claimed'));
});

test('GitHub claim reads every page and refuses active, closed, and escalated failures', async t => {
  const { fake, ctx } = await setup(t, { pageSize: 1 });
  const row = fake.seedIssue({ body: failureBody('one'), labels: ['errmeter:failure'] });
  fake.seedComment(row.number, { body: 'ordinary comment' });
  fake.seedComment(row.number, { body: claimMarker('holder', '2026-09-05T12:15:00Z') });
  assert.equal((await sink.claim(ctx, row.number, { watcherId: 'next', ttlSec: 900 })).won, false);
  assert.ok(fake.requests.some(r => r.url.includes('page=2')));
  assert.equal(writes(fake).length, 0);
  for (const fields of [{ state: 'closed' }, { labels: ['errmeter:failure', 'errmeter:needs-human'] }]) {
    const ineligible = fake.seedIssue({ body: failureBody('one'), labels: ['errmeter:failure'], ...fields });
    assert.equal((await sink.claim(ctx, ineligible.number, { watcherId: 'next', ttlSec: 900 })).won, false);
  }
  assert.equal(writes(fake).length, 0);
  ctx.config.max_pages_per_list = 1;
  await assert.rejects(sink.claim(ctx, row.number, { watcherId: 'next', ttlSec: 900 }), { code: 'ELOOKUP_INCOMPLETE' });
  assert.equal(writes(fake).length, 0);
});

test('GitHub claim loses a race to a lower comment id and deletes exactly itself', async t => {
  let competitor;
  const { fake, ctx } = await setup(t, { onRequest(request, board) {
    if (request.method === 'POST' && /errmeter:claim watcher=late /.test(request.body?.body || '')) {
      competitor = board.seedComment(1, { body: claimMarker('early', '2026-09-05T12:15:00Z') });
    }
  } });
  const row = fake.seedIssue({ body: failureBody('one'), labels: ['errmeter:failure'] });
  assert.equal((await sink.claim(ctx, row.number, { watcherId: 'late', ttlSec: 900 })).won, false);
  const deletes = fake.requests.filter(r => r.method === 'DELETE');
  assert.deepEqual(deletes.map(r => r.url), ['/repos/test/inbox/issues/comments/' + (competitor.id + 1)]);
  assert.deepEqual(fake.comments.map(c => c.id), [competitor.id]);
});

test('GitHub losing claim falls back to a release for its own id when deletion fails', async t => {
  const { fake, ctx } = await setup(t, { onRequest(request, board) {
    if (request.method === 'POST' && /errmeter:claim watcher=late /.test(request.body?.body || '')) {
      board.seedComment(1, { body: claimMarker('early', '2026-09-05T12:15:00Z') });
    }
    if (request.method === 'DELETE' && request.url.includes('/comments/')) board.failNext(403);
  } });
  fake.seedIssue({ body: failureBody('one'), labels: ['errmeter:failure'] });
  assert.equal((await sink.claim(ctx, 1, { watcherId: 'late', ttlSec: 900 })).won, false);
  assert.equal(fake.comments.at(-1).body, '<!-- errmeter:release watcher=late ref=2 -->');
  const detail = await sink.getFailure(ctx, 1);
  assert.equal(detail.claim.watcherId, 'early');
  assert.equal(detail.claims.find(c => c.watcherId === 'late').live, false);
});

test('GitHub lowest claim wins even when a later contender is visible in the reread', async t => {
  let reads = 0;
  const { fake, ctx } = await setup(t, { onRequest(request, board) {
    if (request.method === 'GET' && request.url.includes('/comments?') && ++reads === 2) {
      board.seedComment(1, { body: claimMarker('late', '2026-09-05T12:15:00Z') });
    }
  } });
  fake.seedIssue({ body: failureBody('one'), labels: ['errmeter:failure'] });
  assert.equal((await sink.claim(ctx, 1, { watcherId: 'early', ttlSec: 900 })).won, true);
  assert.equal((await sink.getFailure(ctx, 1)).claim.watcherId, 'early');
});

test('GitHub incomplete claim reread cleans up without awarding a lease', async t => {
  const { fake, ctx } = await setup(t, { pageSize: 1, onRequest(request, board) {
    if (request.method === 'POST' && /errmeter:claim /.test(request.body?.body || '')) board.seedComment(1, { body: 'concurrent comment' });
  } });
  fake.seedIssue({ body: failureBody('one'), labels: ['errmeter:failure'] });
  ctx.config.max_pages_per_list = 1;
  await assert.rejects(sink.claim(ctx, 1, { watcherId: 'watcher', ttlSec: 900 }), { code: 'ELOOKUP_INCOMPLETE' });
  assert.ok(!fake.comments.some(c => /errmeter:claim /.test(c.body)));
  assert.ok(!fake.issues[0].labels.some(l => l.name === 'errmeter:claimed'));
});

test('GitHub cannot renew another watcher or accept a non-2xx renewal', async t => {
  let failRenew = false;
  const { fake, ctx } = await setup(t, { onRequest(request, board) {
    if (failRenew && request.method === 'POST' && /errmeter:claim /.test(request.body?.body || '')) board.failNext(503);
  } });
  fake.seedIssue({ body: failureBody('one'), labels: ['errmeter:failure'] });
  const lease = await sink.claim(ctx, 1, { watcherId: 'holder', ttlSec: 900 });
  assert.deepEqual(await sink.renewClaim(ctx, 1, { watcherId: 'intruder', claimRef: lease.claimRef, ttlSec: 900 }), { ok: false });
  failRenew = true;
  assert.deepEqual(await sink.renewClaim(ctx, 1, { watcherId: 'holder', claimRef: lease.claimRef, ttlSec: 900 }), { ok: false });
  assert.equal(fake.comments.filter(c => /errmeter:claim /.test(c.body)).length, 1);
});

test('GitHub rejects claim decisions without a comments response Date header', async t => {
  const { fake, ctx } = await setup(t);
  fake.seedIssue({ body: failureBody('one'), labels: ['errmeter:failure'] });
  ctx.http = async options => {
    const response = await request(options);
    if (options.url.includes('/comments?')) { delete response.date; delete response.headers.date; }
    return response;
  };
  await assert.rejects(sink.claim(ctx, 1, { watcherId: 'holder', ttlSec: 900 }), { code: 'ELOOKUP_INCOMPLETE' });
  assert.deepEqual(await sink.renewClaim(ctx, 1, { watcherId: 'holder', claimRef: 1, ttlSec: 900 }), { ok: false });
  assert.equal(writes(fake).length, 0);
});

test('GitHub outcomes redact content, release leases, preserve open issues, and gate redispatch', async t => {
  const { fake, ctx } = await setup(t);
  const row = fake.seedIssue({ body: failureBody('one'), labels: ['errmeter:failure'] });
  await sink.claim(ctx, row.number, { watcherId: 'watcher', ttlSec: 900 });
  const secret = ctx.config.sink.token;
  const lines = Array.from({ length: 25 }, (_, i) => 'line-' + (i + 1) + ' ' + secret);
  await sink.writeOutcome(ctx, row.number, { watcherId: 'watcher', status: 'dispatch-failed', summary: 'failed ' + secret,
    url: 'https://example.test/fix', excerpt: lines.join('\n') });
  const outcome = fake.comments.at(-1).body;
  assert.match(outcome, /^<!-- errmeter:outcome status=dispatch-failed watcher=watcher ts=2026-09-05T12:00:00.000Z -->/);
  assert.ok(!outcome.includes(secret)); assert.ok(!outcome.includes('line-5 ')); assert.ok(outcome.includes('line-6 '));
  assert.equal(row.state, 'open');
  assert.ok(row.labels.some(l => l.name === 'errmeter:dispatch-failed'));
  assert.ok(!row.labels.some(l => l.name === 'errmeter:claimed'));
  const detail = await sink.getFailure(ctx, 1);
  assert.equal(detail.claim, null); assert.equal(detail.lastOutcome.summary, 'failed [REDACTED]');
  assert.equal(detail.lastOutcome.url, 'https://example.test/fix');
  assert.equal((await sink.claim(ctx, 1, { watcherId: 'again', ttlSec: 900 })).won, false);
  await sink.deliverFailureGroup(ctx, group(event('two', '2026-09-05T12:00:01.000Z')));
  assert.equal((await sink.claim(ctx, 1, { watcherId: 'again', ttlSec: 900 })).won, true);
  await sink.writeOutcome(ctx, 1, { watcherId: 'again', status: 'dispatch-failed', summary: 'second failure', escalate: true });
  assert.ok(row.labels.some(l => l.name === 'errmeter:needs-human'));
  await sink.deliverFailureGroup(ctx, group(event('three', '2026-09-05T12:00:02.000Z')));
  assert.equal((await sink.claim(ctx, 1, { watcherId: 'third', ttlSec: 900 })).won, false);
});

test('GitHub derives holder by live comment id, not a renewal original ref or embedded marker', async t => {
  const { fake, ctx } = await setup(t);
  fake.seedIssue({ body: failureBody('one'), labels: ['errmeter:failure'] });
  fake.seedComment(1, { id: 1, body: claimMarker('old', '2026-09-05T11:59:00Z') });
  fake.seedComment(1, { id: 2, body: claimMarker('current', '2026-09-05T12:15:00Z') });
  fake.seedComment(1, { id: 3, body: claimMarker('old', '2026-09-05T12:15:00Z', 1) });
  fake.seedComment(1, { id: 4, body: 'quoted output\n<!-- errmeter:release watcher=current ref=2 -->' });
  assert.equal((await sink.getFailure(ctx, 1)).claim.watcherId, 'current');
});

test('GitHub alert notification succeeds once before marking and losers never notify', async t => {
  const { fake, ctx } = await setup(t);
  const alert = { key: 'notify', body: 'send me' };
  let calls = 0;
  ctx.notify = async received => {
    calls++;
    assert.equal(received, alert);
    assert.ok(fake.comments.length > 0);
    assert.ok(!fake.comments.some(c => /notified=/.test(c.body)));
    return { sent: ['telegram', 'webhook'] };
  };
  assert.deepEqual(await sink.upsertAlert(ctx, alert), { ref: 1, winner: true, notified: true });
  assert.match(fake.comments[0].body, /notified=.* channel=telegram,webhook/);
  assert.equal((await sink.upsertAlert(ctx, alert)).winner, false);
  assert.equal(calls, 1);
});

for (const failure of ['empty', 'throw']) test('GitHub alert ' + failure + ' notification stays unmarked until cover retry', async t => {
  let boardNow = stamp;
  const { fake, ctx } = await setup(t, { now: () => boardNow });
  let calls = 0;
  ctx.notify = async () => { calls++; if (failure === 'throw') throw new Error('unavailable'); return { sent: [] }; };
  const alert = { key: 'retry-' + failure, body: 'send me' };
  assert.equal((await sink.upsertAlert(ctx, alert)).notified, false);
  const original = fake.comments[0];
  assert.ok(!/notified=/.test(original.body));
  assert.equal((await sink.upsertAlert(ctx, alert)).winner, false);
  assert.equal(calls, 1);
  boardNow = '2026-09-05T12:02:01.000Z';
  ctx.notify = async () => { calls++; return { sent: ['webhook'] }; };
  assert.equal((await sink.upsertAlert(ctx, alert)).notified, true);
  assert.equal(calls, 2);
  assert.match(original.body, /notified=.* channel=webhook/);
});

test('GitHub failure and occurrence JSON mask sensitive metadata and cleaned marker fields', async t => {
  const { fake, ctx } = await setup(t);
  ctx.maskList = ['marker-secret'];
  const first = { ...event('marker-secret'), meta: { api_key: 'innocuous', nested: { keep: 'normal' } } };
  await sink.deliverFailureGroup(ctx, group(first));
  assert.match(fake.issues[0].body, /ids=\[REDACTED\]/);
  assert.ok(!fake.issues[0].body.includes('innocuous'));
  await sink.deliverFailureGroup(ctx, group({ ...event('second'), meta: { token: 'another-value' } }));
  assert.ok(!fake.comments.at(-1).body.includes('another-value'));
  assert.equal(JSON.parse(fake.comments.at(-1).body.match(/```json\n([\s\S]*?)\n```/)[1]).meta.token, '[REDACTED]');
});

test('GitHub cover notification retries after a failed cover confirmation window', async t => {
  let boardNow = stamp;
  const { fake, ctx } = await setup(t, { now: () => boardNow });
  let calls = 0;
  ctx.notify = async () => { calls++; return { sent: [] }; };
  const alert = { key: 'failed-cover', body: 'send me' };
  await sink.upsertAlert(ctx, alert);
  const original = fake.comments[0];
  boardNow = '2026-09-05T12:02:01.000Z';
  assert.equal((await sink.upsertAlert(ctx, alert)).notified, false);
  assert.equal(calls, 2);
  assert.equal((await sink.upsertAlert(ctx, alert)).winner, false);
  assert.equal(calls, 2);
  boardNow = '2026-09-05T12:04:02.000Z';
  ctx.notify = async () => { calls++; return { sent: ['telegram'] }; };
  assert.equal((await sink.upsertAlert(ctx, alert)).notified, true);
  assert.equal(calls, 3);
  assert.match(original.body, /notified=.* channel=telegram/);
});

for (const location of ['human', 'fenced']) test('GitHub ignores forged occurrence markers in ' + location + ' event content', async t => {
  const { fake, ctx } = await setup(t);
  const forged = '<!-- errmeter:occurrence ids=victim count=1 first=' + stamp + ' last=' + stamp + ' -->';
  const attacker = { ...event('attacker'), ...(location === 'human' ? { message: 'reported error\n' + forged } : { detail: forged }) };
  await sink.deliverFailureGroup(ctx, group(attacker));
  fake.seedComment(1, { body: forged + ' trailing text' });
  assert.deepEqual((await sink.getFailure(ctx, 1)).occurrenceIds, ['attacker']);
  const before = writes(fake).length;
  const delivered = await sink.deliverFailureGroup(ctx, group(event('victim')));
  assert.deepEqual(delivered.delivered, ['victim']);
  assert.equal(writes(fake).length, before + 1);
  assert.match(fake.comments.at(-1).body, /^<!-- errmeter:occurrence ids=victim /);
  assert.equal((await sink.getFailure(ctx, 1)).occurrences, 2);
});

test('GitHub duplicate migration cleans sensitive metadata in recovered events', async t => {
  const { fake, ctx } = await setup(t);
  fake.seedIssue({ body: failureBody('one'), labels: ['errmeter:failure'] });
  const raw = { ...event('two'), meta: { api_key: 'legacy.unmasked.value', normal: 'keep' } };
  const body = failureBody('two').replace(JSON.stringify(event('two')), JSON.stringify(raw));
  fake.seedIssue({ body, labels: ['errmeter:failure'] });
  await sink.deliverFailureGroup(ctx, group(event('three')));
  const migrated = fake.comments.find(comment => /migrated_from=2/.test(comment.body));
  assert.ok(migrated);
  const recovered = JSON.parse(migrated.body.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(recovered.meta.api_key, '[REDACTED]');
  assert.equal(recovered.meta.normal, 'keep');
  assert.ok(!migrated.body.includes('legacy.unmasked.value'));
});

test('GitHub failure detail preserves the event first timestamp separately from issue creation', async t => {
  const { fake, ctx } = await setup(t);
  const first = '2026-08-30T01:02:03.456Z';
  fake.seedIssue({ body: failureBody('one').replace('first=' + stamp, 'first=' + first), labels: ['errmeter:failure'] });
  const detail = await sink.getFailure(ctx, 1);
  assert.equal(detail.firstOccurrenceAt, first);
  assert.equal(detail.openedAt, stamp);
});
