'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sink = require('../../src/sinks/file');
function context(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-file-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, config: { host: 'host', file: {}, watch: {} }, now: () => '2026-09-05T12:00:00.000Z' };
}
function event(id, ts = '2026-09-05T11:00:00.000Z') { return { schema: 1, id, ts, kind: 'error', agent: 'a', host: 'h', fingerprint: 'abc', fpv: 1, message: 'broken' }; }
function group(events, counter) { return { fingerprint: 'abc', fpv: 1, agent: 'a', count: events.length, events, ...(counter ? { counter } : {}) }; }
test('file sequences increase, records rebuild, and existing event IDs are never rewritten', async t => {
  const ctx = context(t);
  const first = await sink.deliverFailureGroup(ctx, group([event('one'), event('two')]));
  await sink.deliverFailureGroup(ctx, group([event('two'), event('three', '2026-09-05T11:30:00.000Z')]));
  const before = fs.readFileSync(path.join(ctx.home, 'board.jsonl'), 'utf8');
  const repeat = await sink.deliverFailureGroup(ctx, group([event('one')]));
  assert.equal(repeat.skipped, true); assert.deepEqual(repeat.delivered, ['one']);
  assert.equal(fs.readFileSync(path.join(ctx.home, 'board.jsonl'), 'utf8'), before);
  const rows = before.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.seq), [1, 2]);
  const records = await sink.listOpenFailures({ ...ctx });
  assert.equal(records.length, 1); assert.equal(records[0].occurrences, 3);
  const detail = await sink.getFailure(ctx, first.ref);
  assert.deepEqual(detail.occurrenceIds, ['one', 'two', 'three']); assert.equal(detail.latest.id, 'three');
});
test('file counter idempotency is scoped to fingerprint and pass key', async t => {
  const ctx = context(t);
  const cut = { ...group([event('synthetic')], 'cut.0'), count: 9 };
  await sink.deliverFailureGroup(ctx, cut);
  assert.equal((await sink.deliverFailureGroup(ctx, cut)).skipped, true);
  await sink.deliverFailureGroup(ctx, { ...cut, counter: 'cut.1', count: 4 });
  await sink.deliverFailureGroup(ctx, { ...cut, fingerprint: 'def' });
  const records = await sink.listOpenFailures(ctx);
  assert.deepEqual(records.map(record => record.occurrences), [13, 9]);
  assert.deepEqual((await sink.getFailure(ctx, records[0].ref)).occurrenceIds, []);
});
test('file heartbeats preserve newest event timestamp, role and stable reference', async t => {
  const ctx = context(t);
  const latest = { ...event('hb', '2026-09-05T11:30:00.000Z'), kind: 'heartbeat', agent: 'watcher/a', meta: { role: 'watcher' } };
  const result = await sink.deliverHeartbeat(ctx, latest);
  assert.equal((await sink.deliverHeartbeat(ctx, { ...latest, ts: event('old').ts })).skipped, true);
  const records = await sink.listHeartbeats(ctx);
  assert.equal(records[0].ref, result.ref); assert.equal(records[0].lastSeen, latest.ts); assert.equal(records[0].role, 'watcher');
});
test('file alert key and renotify window elect one episode then allow next window', async t => {
  const ctx = context(t); const alert = { key: 'all-watchers-silent', body: '@owner' };
  assert.equal((await sink.upsertAlert(ctx, alert)).winner, true);
  assert.equal((await sink.upsertAlert(ctx, alert)).winner, false);
  ctx.now = () => '2026-09-06T12:00:00.000Z';
  assert.equal((await sink.upsertAlert(ctx, alert)).winner, true);
  const rows = fs.readFileSync(path.join(ctx.home, 'board.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.op === 'alert').length, 1);
  assert.deepEqual(rows.map(row => row.seq), [1, 2, 3]);
  assert.equal(rows[1].channel, 'none'); assert.ok(rows[1].notified);
});
test('file dry run makes no writes and truncated reads fail closed', async t => {
  const ctx = context(t); ctx.dryRun = true;
  await sink.deliverFailureGroup(ctx, group([event('one')]));
  await sink.deliverHeartbeat(ctx, { ...event('hb'), kind: 'heartbeat' });
  await sink.upsertAlert(ctx, { key: 'alert', body: 'body' });
  assert.deepEqual(fs.readdirSync(ctx.home), []);
  ctx.dryRun = false;
  await sink.deliverFailureGroup(ctx, group([event('one')]));
  await sink.deliverFailureGroup(ctx, group([event('two')]));
  ctx.config.file.scan_max_lines = 1;
  await assert.rejects(sink.deliverFailureGroup(ctx, { ...group([event('three')]), fingerprint: 'new' }), { code: 'LOOKUP_INCOMPLETE' });
  assert.equal(ctx.lookup_incomplete, true);
});
test('file recovers an unconfirmed alert winner once after notify_confirm_sec', async t => {
  const ctx = context(t);
  const file = path.join(ctx.home, 'board.jsonl');
  const rows = [
    { seq: 1, op: 'alert', key: 'silent', ts: '2026-09-05T11:00:00.000Z' },
    { seq: 2, op: 'alert-episode', ref: 1, key: 'silent', ts: '2026-09-05T11:00:00.000Z' }
  ];
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  const result = await sink.upsertAlert(ctx, { key: 'silent', body: 'help' });
  assert.equal(result.winner, true);
  assert.equal((await sink.upsertAlert(ctx, { key: 'silent', body: 'help' })).winner, false);
  const recovered = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(recovered.filter(row => row.cover === 1).length, 1);
  assert.equal(recovered[3].episodeRef, 2); assert.equal(recovered[3].channel, 'none');
});
test('file sequence gaps after interrupted writes do not reuse board references', async t => {
  const ctx = context(t);
  fs.writeFileSync(path.join(ctx.home, 'board.seq'), '8\n');
  const result = await sink.deliverFailureGroup(ctx, group([event('one')]));
  const row = JSON.parse(fs.readFileSync(path.join(ctx.home, 'board.jsonl'), 'utf8'));
  assert.equal(result.ref, 9); assert.equal(row.seq, 9); assert.equal(row.record.ref, 9);
});
