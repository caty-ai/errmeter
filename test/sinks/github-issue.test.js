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
