'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sink = require('../../src/sinks/file');
function context(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-file-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, config: { host: 'host', file: {}, watch: {} }, now: () => '2026-09-05T12:00:00.000Z' };
}
function event(id, ts = '2026-09-05T11:00:00.000Z') { return { schema: 1, id, ts, kind: 'error', agent: 'a', host: 'h', fingerprint: 'abc', fpv: 1, message: 'broken' }; }
function group(events, counter) { return { fingerprint: 'abc', fpv: 1, agent: 'a', count: events.length, events, ...(counter ? { counter } : {}) }; }
test('file renew reports explicit holder-change and dry-run reasons', async t => {
  const ctx = context(t);
  const failure = await sink.deliverFailureGroup(ctx, group([event('one')]));
  const lease = await sink.claim(ctx, failure.ref, { watcherId: 'holder', ttlSec: 900 });
  assert.deepEqual(await sink.renewClaim(ctx, failure.ref, { watcherId: 'other', claimRef: lease.claimRef, ttlSec: 900 }), { ok: false, reason: 'holder-changed' });
  assert.deepEqual(await sink.renewClaim({ ...ctx, dryRun: true }, failure.ref, { watcherId: 'holder', claimRef: lease.claimRef, ttlSec: 900 }), { ok: false, reason: 'dry-run' });
  await sink.removeLabels(ctx, failure.ref, ['errmeter:claimed']);
  assert.equal((await sink.getFailure(ctx, failure.ref)).labels.includes('errmeter:claimed'), false);
});
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
  assert.deepEqual(rows.map(row => row.seq), [1, 2, 3, 4, 5]);
  assert.equal(rows[2].channel, 'none'); assert.ok(rows[2].notified);
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
test('file sequence replacement recovers Windows rename errors', async t => {
  const ctx = context(t);
  const sequence = path.join(ctx.home, 'board.seq');
  const rename = fs.renameSync;
  let blocked = 0;
  fs.renameSync = (from, to) => {
    if (to === sequence && fs.existsSync(to)) {
      const error = new Error('Destination exists');
      error.code = ['EEXIST', 'EPERM', 'EACCES'][blocked++];
      throw error;
    }
    return rename(from, to);
  };
  try {
    for (let i = 0; i < 4; i++) await sink.deliverFailureGroup(ctx, group([event('sequence-' + i)]));
  } finally { fs.renameSync = rename; }
  assert.equal(blocked, 3);
  assert.equal(fs.readFileSync(sequence, 'utf8'), '4\n');
  assert.equal((await sink.listOpenFailures(ctx))[0].occurrences, 4);
});
test('file claim, renew, release and outcome rebuild authoritative state', async t => {
  const ctx = context(t);
  const { ref } = await sink.deliverFailureGroup(ctx, group([event('one')]));
  const first = await sink.claim(ctx, ref, { watcherId: 'a', ttlSec: 900 });
  assert.equal(first.won, true);
  assert.equal((await sink.claim(ctx, ref, { watcherId: 'b', ttlSec: 900 })).won, false);
  ctx.now = () => '2026-09-05T12:03:00.000Z';
  assert.equal((await sink.renewClaim(ctx, ref, { watcherId: 'a', claimRef: first.claimRef, ttlSec: 900 })).ok, true);
  assert.equal((await sink.renewClaim(ctx, ref, { watcherId: 'b', claimRef: first.claimRef, ttlSec: 900 })).ok, false);
  await sink.releaseClaim(ctx, ref, { watcherId: 'a', claimRef: first.claimRef });
  assert.equal((await sink.getFailure(ctx, ref)).claim, null);
  assert.equal((await sink.releaseClaim(ctx, ref, { watcherId: 'a', claimRef: first.claimRef })).skipped, true);
  const next = await sink.claim(ctx, ref, { watcherId: 'b', ttlSec: 900 });
  assert.equal(next.won, true);
  const outcome = { status: 'dispatch-failed', watcherId: 'b', claimRef: next.claimRef, summary: 'failed' };
  await sink.writeOutcome(ctx, ref, outcome);
  assert.equal((await sink.writeOutcome(ctx, ref, outcome)).skipped, true);
  const detail = await sink.getFailure(ctx, ref);
  assert.equal(detail.claim, null); assert.equal(detail.outcomes.length, 1);
  assert.equal(detail.lastOutcome.status, 'dispatch-failed');
  assert.equal((await sink.claim(ctx, ref, { watcherId: 'a', ttlSec: 900 })).won, false);
  await sink.deliverFailureGroup(ctx, group([event('two', '2026-09-05T12:04:00.000Z')]));
  assert.equal((await sink.claim(ctx, ref, { watcherId: 'a', ttlSec: 900 })).won, true);
  assert.equal((await sink.getFailure(ctx, ref)).outcomes.length, 1);
});
test('file expired leases permit takeover and escalation blocks later occurrences', async t => {
  const ctx = context(t);
  const { ref } = await sink.deliverFailureGroup(ctx, group([event('one')]));
  await sink.claim(ctx, ref, { watcherId: 'a', ttlSec: 60 });
  ctx.now = () => '2026-09-05T12:01:00.000Z';
  const next = await sink.claim(ctx, ref, { watcherId: 'b', ttlSec: 60 });
  assert.equal(next.won, true);
  await sink.writeOutcome(ctx, ref, { status: 'dispatch-failed', watcherId: 'b', claimRef: next.claimRef, summary: 'failed', escalate: true });
  await sink.deliverFailureGroup(ctx, group([event('two', '2026-09-05T12:02:00.000Z')]));
  assert.ok((await sink.getFailure(ctx, ref)).labels.includes('errmeter:needs-human'));
  assert.equal((await sink.claim(ctx, ref, { watcherId: 'a', ttlSec: 60 })).won, false);
  const summary = (await sink.listOpenFailures(ctx))[0];
  assert.equal(summary.claim, null); assert.equal(summary.lastOutcome.status, 'dispatch-failed');
  assert.equal(summary.claims, undefined);
});
test('file notification marks only successful send, retries failed cover after window', async t => {
  const ctx = context(t); let calls = 0;
  ctx.notify = async () => { calls++; return { sent: [] }; };
  const alert = { key: 'silent', body: 'help' };
  assert.equal((await sink.upsertAlert(ctx, alert)).notified, false);
  assert.equal((await sink.upsertAlert(ctx, alert)).winner, false); assert.equal(calls, 1);
  ctx.now = () => '2026-09-05T12:02:01.000Z';
  ctx.notify = async () => { calls++; throw new Error('offline'); };
  assert.equal((await sink.upsertAlert(ctx, alert)).notified, false);
  ctx.now = () => '2026-09-05T12:04:02.000Z';
  ctx.notify = async () => { calls++; return { sent: ['telegram', 'slack'] }; };
  assert.equal((await sink.upsertAlert(ctx, alert)).notified, true);
  assert.equal((await sink.upsertAlert(ctx, alert)).winner, false); assert.equal(calls, 3);
  const rows = fs.readFileSync(path.join(ctx.home, 'board.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const marks = rows.filter(row => row.op === 'alert-notified');
  assert.equal(marks.length, 1); assert.equal(marks[0].channel, 'telegram,slack'); assert.equal(marks[0].episodeRef, 2);
});
test('file claim operations obey dry-run and incomplete-read guards', async t => {
  const ctx = context(t);
  const { ref } = await sink.deliverFailureGroup(ctx, group([event('one')]));
  const board = path.join(ctx.home, 'board.jsonl'); const before = fs.readFileSync(board, 'utf8');
  ctx.dryRun = true;
  await sink.claim(ctx, ref, { watcherId: 'a', ttlSec: 60 });
  await sink.renewClaim(ctx, ref, { watcherId: 'a', claimRef: 2, ttlSec: 60 });
  await sink.releaseClaim(ctx, ref, { watcherId: 'a', claimRef: 2 });
  await sink.writeOutcome(ctx, ref, { watcherId: 'a', claimRef: 2, status: 'repaired' });
  assert.equal(fs.readFileSync(board, 'utf8'), before);
  ctx.dryRun = false; await sink.claim(ctx, ref, { watcherId: 'a', ttlSec: 60 });
  ctx.config.file.scan_max_lines = 1;
  for (const op of ['claim', 'renewClaim', 'releaseClaim']) await assert.rejects(sink[op](ctx, ref, { watcherId: 'a', claimRef: 2, ttlSec: 60 }), { code: 'LOOKUP_INCOMPLETE' });
});
test('file outcomes retain the redacted last 20 lines of dispatch excerpts', async t => {
  const ctx = context(t); ctx.maskList = ['private-secret'];
  const { ref } = await sink.deliverFailureGroup(ctx, group([event('one')]));
  const lines = Array.from({ length: 25 }, (_, i) => i + ' private-secret');
  await sink.writeOutcome(ctx, ref, { watcherId: 'a', claimRef: 2, status: 'dispatch-failed', excerpt: lines.join('\n') });
  const rows = fs.readFileSync(path.join(ctx.home, 'board.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).excerpt.split('\n').length, 20);
  assert.ok(rows.at(-1).excerpt.startsWith('5 [REDACTED]'));
  assert.equal(rows.at(-1).excerpt.includes('private-secret'), false);
});
test('file board elects one cross-process claimant and allocates unique sequences', async t => {
  const ctx = context(t);
  const { ref } = await sink.deliverFailureGroup(ctx, group([event('one')]));
  const script = `
    const sink = require(process.argv[1]);
    const ctx = { home: process.argv[2], config: { host: 'host', file: {}, watch: {} }, now: () => '2026-09-05T12:00:00.000Z' };
    process.on('message', async () => {
      try {
        const watcherId = 'watcher-' + process.argv[3];
        const result = await sink.claim(ctx, Number(process.argv[4]), { watcherId, ttlSec: 900 });
        await sink.deliverHeartbeat(ctx, { id: watcherId, kind: 'heartbeat', agent: watcherId, host: 'host', ts: ctx.now() });
        process.send({ result }, () => process.disconnect());
      } catch (error) { process.send({ error: error.stack }, () => process.disconnect()); process.exitCode = 1; }
    });
    process.send({ ready: true });
  `;
  const children = Array.from({ length: 6 }, (_, index) => {
    const child = spawn(process.execPath, ['-e', script, require.resolve('../../src/sinks/file'), ctx.home, String(index), String(ref)],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let result; let errors = '';
    child.stderr.on('data', data => { errors += data; });
    const ready = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('message', message => { if (message.ready) resolve(); else if (message.error) reject(new Error(message.error)); else result = message.result; });
      child.once('exit', code => { if (!result) reject(new Error('Child exited before readiness/result: ' + code + ' ' + errors)); });
    });
    const finished = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.once('exit', code => { if (code === 0 && result) resolve(result); else reject(new Error('Child failed: ' + code + ' ' + errors)); });
    });
    return { child, ready, finished };
  });
  await Promise.all(children.map(item => item.ready));
  children.forEach(item => item.child.send('go'));
  const results = await Promise.all(children.map(item => item.finished));
  assert.equal(results.filter(result => result.won).length, 1);
  const rows = fs.readFileSync(path.join(ctx.home, 'board.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal((await sink.getFailure(ctx, ref)).claim.claimRef, results.find(result => result.won).claimRef);
});
test('file board recovers a dead lock owner and waits for a living owner', async t => {
  const ctx = context(t);
  const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { exited.on('error', reject); exited.on('exit', resolve); });
  const directory = path.join(ctx.home, 'board.jsonl.lock');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, exited.pid + '.dead'), '');
  const { ref } = await sink.deliverFailureGroup(ctx, group([event('one')]));
  assert.equal(fs.existsSync(directory), false);
  fs.mkdirSync(directory);
  const owner = path.join(directory, process.pid + '.abcdef');
  fs.writeFileSync(owner, '');
  let settled = false;
  const pending = sink.claim(ctx, ref, { watcherId: 'a', ttlSec: 900 }).then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(settled, false); assert.equal(fs.existsSync(owner), true);
  fs.unlinkSync(owner); fs.rmdirSync(directory);
  assert.equal((await pending).won, true);
  assert.equal(fs.readdirSync(ctx.home).some(name => name.includes('.lock')), false);
  fs.mkdirSync(directory);
  assert.equal((await sink.getFailure(ctx, ref)).claim.watcherId, 'a');
  assert.equal(fs.existsSync(directory), false);

  const candidateOwner = exited.pid + '.dead';
  const candidate = directory + '.candidate-' + candidateOwner;
  fs.mkdirSync(candidate); fs.writeFileSync(path.join(candidate, candidateOwner), '');
  assert.equal((await sink.getFailure(ctx, ref)).claim.watcherId, 'a');
  assert.equal(fs.existsSync(candidate), false, 'dead acquisition candidates are bounded');

  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, process.pid + '.abcdef'), '');
  const old = new Date(Date.now() - 180000); fs.utimesSync(directory, old, old);
  assert.equal((await sink.getFailure(ctx, ref)).claim.watcherId, 'a');
  assert.equal(fs.existsSync(directory), false, 'bounded staleness recovers a reused living PID');
});
