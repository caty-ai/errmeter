'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { status, probePermissions } = require('../src/status');
const { createGithubFake } = require('./fixtures/github-fake');

function fixture(t, config = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-status-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ schema: 1, host: 'test', sink: { type: 'file' }, ...config }));
  let stdout = '', stderr = '', result;
  const io = { stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
    onResult: value => { result = value; }, registrationStatus: async () => ({ registered: false, running: false, pid: null }),
    clock: () => Date.parse('2026-09-06T00:00:00Z') };
  return { home, env: { ERRMETER_HOME: home }, io, out: () => ({ stdout, stderr, result }) };
}
function lastFlush(f, value) {
  fs.mkdirSync(path.join(f.home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'state', 'last_flush.json'), JSON.stringify(value));
}

test('local status needs no token, reads no board and reports successful flush and registration', async t => {
  const f = fixture(t, { sink: { type: 'github-issue', repo: 'test/inbox', token_file: '/missing' } });
  lastFlush(f, { ts: '2026-09-05T23:59:00Z', pending_remaining: 0, errors: [] });
  assert.equal(await status(['--json'], f.env, { ...f.io, http: () => assert.fail('network'), sink: { listHeartbeats: () => assert.fail('board') } }), 0);
  const result = JSON.parse(f.out().stdout);
  assert.equal(result.watcher_heartbeats, null); assert.equal(result.pending, 0);
  assert.equal(result.last_successful_flush, '2026-09-05T23:59:00Z'); assert.equal(result.watcher.registered, false);
  assert.deepEqual(result.last_flush, { ts: '2026-09-05T23:59:00Z', pending_remaining: 0, errors: 0 });
  assert.equal(result.config_path, path.join(f.home, 'config.json')); assert.equal(result.role, 'watcher');
});

test('pending threshold is strictly greater and temporary writes are excluded', async t => {
  const f = fixture(t, { spool: { pending_soft_limit: 1 } });
  lastFlush(f, { ts: '2026-09-05T23:59:00Z', errors: [] });
  const pending = path.join(f.home, 'spool', 'pending'); fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, 'one.json'), '{}'); fs.writeFileSync(path.join(pending, 'writing.tmp'), 'partial');
  assert.equal(await status([], f.env, f.io), 0);
  fs.writeFileSync(path.join(pending, 'counters.log'), 'record');
  assert.equal(await status([], f.env, f.io), 1); assert.equal(f.out().result.pending, 2);
});

test('status usage errors have their own summary and diagnostic', async t => {
  const f = fixture(t);
  assert.equal(await status(['--unknown-option'], f.env, f.io), 2);
  assert.equal(f.out().stdout, 'status: usage error\n');
  assert.match(f.out().stderr, /unknown/i);
});

test('configured unregistered host without a flush is degraded', async t => {
  const f = fixture(t);
  assert.equal(await status([], f.env, f.io), 1);
  assert.match(f.out().stdout, /^status: degraded/);
  assert.match(f.out().stderr, /no flush recorded yet/);
  assert.equal(f.out().result.last_successful_flush, null);
  assert.equal(f.out().result.watcher.registered, false);
});

test('failed last flush is degraded and exposed error is redacted', async t => {
  const f = fixture(t); const secret = ['private', 'board'].join('.');
  lastFlush(f, { ts: '2026-09-05T23:00:00Z', errors: ['failed with ' + secret] });
  assert.equal(await status(['--json'], { ...f.env, ERRMETER_GITHUB_TOKEN: secret }, f.io), 1);
  assert.equal(f.out().stdout.includes(secret), false); assert.equal(f.out().result.last_successful_flush, null);
  assert.equal(await status([], { ...f.env, ERRMETER_GITHUB_TOKEN: secret }, f.io), 1);
  assert.equal(f.out().stdout.includes(secret), false);
});

test('an incomplete last flush is failed even when its error list is empty', async t => {
  const f = fixture(t);
  lastFlush(f, { ts: '2026-09-05T23:59:00Z', pending_remaining: 0, lookup_incomplete: true, errors: [] });
  assert.equal(await status(['--json'], f.env, f.io), 1);
  assert.equal(f.out().result.last_flush_failed, true);
  assert.equal(f.out().result.last_successful_flush, null);
});

test('missing and malformed local configuration or state cannot be checked', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'config.json'), '{bad'); assert.equal(await status([], f.env, f.io), 3);
  fs.writeFileSync(path.join(f.home, 'config.json'), '{"schema":2}'); assert.equal(await status([], f.env, f.io), 3);
  fs.unlinkSync(path.join(f.home, 'config.json')); assert.equal(await status([], f.env, f.io), 3);
});

test('local status rejects malformed sink configuration without loading a token', async t => {
  const f = fixture(t, { sink: { type: 'github-issue', repo: 'not-a-repo', token_file: '/missing' } });
  assert.equal(await status([], f.env, f.io), 3);
});

test('check without known watchers degrades and sends no notification', async t => {
  const f = fixture(t);
  assert.equal(await status(['--check'], f.env, { ...f.io, sink: { listHeartbeats: async () => [] }, notify: () => assert.fail('unsolicited notification') }), 1);
  assert.equal(f.out().result.watcher_heartbeats, 0); assert.match(f.out().stderr, /no watcher known/);
});

test('heartbeat age alone does not invent a gap alert', async t => {
  const f = fixture(t); const record = { agent: 'watcher/test', host: 'test', role: 'watcher', lastSeen: '2026-09-05T23:59:00Z' };
  lastFlush(f, { ts: '2026-09-05T23:59:00Z', errors: [] });
  const io = { ...f.io, sink: { listHeartbeats: async () => [record] } };
  assert.equal(await status(['--check'], f.env, io), 0);
  record.lastSeen = '2026-09-05T00:00:00Z'; assert.equal(await status(['--check'], f.env, io), 0);
  assert.equal(f.out().result.gaps, 0);
});

test('explicit notify test tries configured channels and failure degrades', async t => {
  const f = fixture(t, { notify: [{ type: 'webhook', url: 'https://example.invalid/test' }] });
  lastFlush(f, { ts: '2026-09-05T23:59:00Z', errors: [] });
  let sends = 0;
  const io = { ...f.io, http: async request => {
    sends++; assert.equal(request.method, 'POST');
    assert.deepEqual({ ...request.body.alert }, { key: 'notify-test', title: '[errmeter] notify test', body: 'test 2026-09-06T00:00:00.000Z' });
    return { status: 204 };
  } };
  assert.equal(await status([], f.env, io), 0); assert.equal(sends, 0);
  assert.equal(await status(['--notify-test'], f.env, io), 0); assert.equal(sends, 1);
  assert.match(f.out().stdout, /notify sent=\[webhook\] failed=\[\]/);
  assert.equal(await status(['--notify-test'], f.env, { ...io, http: async () => ({ status: 500 }) }), 1);
  assert.deepEqual({ ...f.out().result.notify }, { sent: [], failed: ['webhook'] });
});

test('last flush age and missing registered watch degrade without penalizing a small pending backlog', async t => {
  const f = fixture(t);
  lastFlush(f, { ts: '2026-09-05T23:58:00Z', pending_remaining: 5, errors: [] });
  assert.equal(await status([], f.env, f.io), 0);
  lastFlush(f, { ts: '2026-09-05T23:57:59Z', pending_remaining: 0, errors: [] });
  assert.equal(await status([], f.env, f.io), 1);
  lastFlush(f, { ts: '2026-09-05T23:59:00Z', errors: [] });
  const io = { ...f.io, registrationStatus: async (flags, env, options) => {
    assert.equal(options.resolved.home, f.home); return { registered: true, running: 123 };
  } };
  assert.equal(await status([], f.env, io), 1);
  fs.writeFileSync(path.join(f.home, 'state', 'last_watch.json'), JSON.stringify({ ts: '2026-09-05T23:59:00Z', role: 'watcher', dispatched: 1, eligible: 2, scanned: 3, unscanned: 4 }));
  assert.equal(await status([], f.env, io), 0);
  assert.deepEqual({ ...f.out().result.watcher }, { registered: true, running: 123, pid: 123 });
  assert.equal(f.out().result.last_watch.unscanned, 4);
  fs.writeFileSync(path.join(f.home, 'state', 'last_watch.json'), '{');
  assert.equal(await status([], f.env, io), 3);
});

test('GitHub check performs probes against fake and reads heartbeat and open gap alerts', async t => {
  const fake = await createGithubFake({ now: '2026-09-06T00:00:00Z' }); t.after(() => fake.close());
  const f = fixture(t, { sink: { type: 'github-issue', repo: 'test/inbox', api_base: fake.url } });
  lastFlush(f, { ts: '2026-09-05T23:59:00Z', errors: [] });
  const env = { ...f.env, ERRMETER_GITHUB_TOKEN: ['sample', 'board'].join('.') };
  fake.seedIssue({ labels: ['errmeter:heartbeat'], body: '<!-- errmeter:heartbeat agent=watcher/test host=test role=watcher ts=2026-09-05T23:59:00Z -->' });
  assert.equal(await status(['--check'], env, f.io), 0);
  assert.equal(fake.issues.find(row => row.title === '[errmeter] probe').state, 'closed');
  fake.seedIssue({ labels: ['errmeter:alert'], body: '<!-- errmeter:alert key=all-watchers-silent -->' });
  assert.equal(await status(['--check'], env, f.io), 1);
});

test('status reports the probe Issue left open without response secrets', async t => {
  const f = fixture(t, { sink: { type: 'github-issue', repo: 'test/inbox' } });
  const secret = ['sample', 'board'].join('.');
  const http = async request => {
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/issues')) return { status: 201, body: { number: 42 } };
    if (request.method === 'PATCH') return { status: 403, body: { message: secret } };
    return { status: 200, body: [] };
  };
  assert.equal(await status(['--check'], { ...f.env, ERRMETER_GITHUB_TOKEN: secret }, { ...f.io, http }), 3);
  assert.match(f.out().stderr, /warning: probe Issue #42 left open — close it manually/);
  assert.equal(f.out().stderr.includes(secret), false);
  assert.equal(f.out().result.failing_probe, 'PATCH /repos/test/inbox/issues/42');
});

test('permission probe rejects non-existence 422 and never includes transport secrets', async () => {
  const ctx = { config: { sink: { repo: 'test/inbox', token: ['sample', 'board'].join('.') } },
    http: async request => ({ status: request.method === 'POST' ? 422 : 200, body: { errors: [{ code: 'invalid' }] } }) };
  await assert.rejects(() => probePermissions(ctx), /POST \/repos\/test\/inbox\/labels/);
  ctx.http = async () => { throw new Error(ctx.config.sink.token); };
  await assert.rejects(() => probePermissions(ctx), error => error.probe === 'GET /repos/test/inbox' && !error.message.includes(ctx.config.sink.token));
});

test('permission probe accepts GitHub already_exists errors and names create/close failures', async () => {
  const ctx = { config: { sink: { repo: 'test/inbox', token: ['sample', 'board'].join('.') } } };
  ctx.http = async request => {
    const target = new URL(request.url).pathname;
    if (request.method === 'POST' && target.endsWith('/labels')) return { status: 422, body: { errors: [{ code: 'already_exists' }] } };
    if (request.method === 'POST' && target.endsWith('/issues')) return { status: 201, body: { number: 7 } };
    if (target.endsWith('/contents/') || target.endsWith('/pulls')) return { status: 404 };
    return { status: 200, body: [] };
  };
  assert.equal((await probePermissions(ctx)).probes.filter(row => row.probe.endsWith('/labels')).every(row => row.status === 422), true);
  ctx.http = async request => request.method === 'POST' && new URL(request.url).pathname.endsWith('/issues')
    ? { status: 201, body: {} } : { status: 200, body: [] };
  await assert.rejects(() => probePermissions(ctx), error => error.probe === 'POST /repos/test/inbox/issues');
  ctx.http = async request => {
    const target = new URL(request.url).pathname;
    if (request.method === 'POST' && target.endsWith('/labels')) return { status: 201 };
    if (request.method === 'POST' && target.endsWith('/issues')) return { status: 201, body: { number: 8 } };
    if (request.method === 'PATCH') return { status: 403 };
    return { status: 200, body: [] };
  };
  await assert.rejects(() => probePermissions(ctx), error => error.probe === 'PATCH /repos/test/inbox/issues/8');
});
