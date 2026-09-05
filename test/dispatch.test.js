'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');
const { dispatch, cleanupDispatches, atomicState, buildPayload, buildEnvironment, outputCapture } = require('../src/dispatch');

function harness(t, overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-dispatch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.parse('2026-09-06T00:00:00.000Z');
  const calls = [], timers = new Map(), kills = [];
  let timerId = 0, invocation;
  const child = new EventEmitter();
  child.pid = 123456;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.unref = () => { child.unreferenced = true; };
  let input = '';
  child.stdin.on('data', chunk => { input += chunk; });
  const issue = { ref: 42, title: 'Failure', occurrences: 7, openedAt: '2026-09-05T00:00:00Z',
    lastOccurrenceAt: '2026-09-06T00:00:00Z', outcomes: [],
    latest: { schema: 1, id: 'event', ts: '2026-09-06T00:00:00Z', kind: 'error',
      agent: 'nora', host: 'vps-1', fingerprint: '0123456789abcdef', fpv: 1,
      message: 'failure', detail: 'detail', meta: { custom: 'value' } } };
  const claim = { won: true, claimRef: 12, expiresAt: new Date(now + 900000).toISOString() };
  const sink = {
    async renewClaim(...args) { calls.push(['renew', ...args]); return { ok: true, expiresAt: new Date(now + 1080000).toISOString() }; },
    async writeOutcome(...args) { calls.push(['outcome', ...args]); },
    async releaseClaim(...args) { calls.push(['release', ...args]); }, ...overrides
  };
  const ctx = { home, now: () => now, boardTime: now, sink, maskList: ['supersecret.value'],
    config: { sink: { type: 'github-issue', repo: 'owner/inbox' }, watch: { watcher_id: 'watcher-1',
      claim_ttl_sec: 900, renew_sec: 180, kill_grace_sec: 30, escalate_after: 2,
      dispatch: { command: ['/bin/hook', 'arg with spaces'], timeout_sec: 840, cwd: '/tmp',
        pass_env: ['PATH', 'HOME', 'ABSENT', 'ERRMETER_GITHUB_TOKEN', 'ERRMETER_HOME', 'ERRMETER_EXTRA'] } } } };
  const options = { now: () => now, platform: 'linux',
    env: { PATH: '/bin', HOME: '/example', PRIVATE: 'hidden', ERRMETER_GITHUB_TOKEN: 'supersecret.value',
      ERRMETER_HOME: home, ERRMETER_EXTRA: 'hidden' },
    spawn(command, args, settings) { invocation = { command, args, settings }; return child; },
    kill(pid, signal) { kills.push([pid, signal]); },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  return { home, now, ctx, options, issue, claim, child, calls, timers, kills,
    file: path.join(home, 'state', 'dispatch', '42.json'),
    invocation: () => invocation, input: () => input,
    async fire(ms) { const [id, timer] = [...timers].find(([, timer]) => timer.ms === ms); timers.delete(id); await timer.fn(); } };
}

test('post-outcome refresh failure still releases and returns escalation', async t => {
  const order = [];
  const h = harness(t, {
    async writeOutcome() { order.push('outcome'); },
    async getFailure(ctx) { order.push('refresh'); ctx.lookup_incomplete = true; throw Object.assign(new Error('budget'), { code: 'EAPI_BUDGET' }); },
    async releaseClaim() { order.push('release'); }
  });
  h.issue.outcomes = [{ status: 'dispatch-failed' }];
  const pending = dispatch(h.ctx, h.issue, h.claim, h.options);
  h.child.emit('close', 1, null);
  const result = await pending;
  assert.deepEqual(order, ['outcome', 'refresh', 'release']);
  assert.equal(result.needsHuman, true);
  assert.equal(result.consecutiveFailures, 2);
  assert.equal(fs.existsSync(h.file), false);
});

test('dispatch uses exact runner arguments, isolated env and payload, then writes outcome before release', async t => {
  const h = harness(t);
  const pending = dispatch(h.ctx, h.issue, h.claim, h.options);
  const invocation = h.invocation();
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [path.resolve(__dirname, '../bin/errmeter.js'), '_run',
    '--deadline-ms', String(h.now + 870000), '--deadline-mono-ms', '870000', '--timeout', '840',
    '--state', h.file, '--', '/bin/hook', 'arg with spaces']);
  assert.equal(invocation.settings.detached, true);
  assert.deepEqual(invocation.settings.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(invocation.settings.windowsHide, true);
  assert.equal(invocation.settings.cwd, '/tmp');
  assert.deepEqual(Object.keys(invocation.settings.env).sort(), ['PATH', 'HOME', 'ERRMETER_ISSUE_NUMBER',
    'ERRMETER_ISSUE_URL', 'ERRMETER_AGENT', 'ERRMETER_HOST', 'ERRMETER_FINGERPRINT', 'ERRMETER_EVENT_FILE',
    'ERRMETER_WATCHER_ID', 'ERRMETER_CLAIM_EXPIRES'].sort());
  const payload = JSON.parse(h.input());
  assert.deepEqual(payload.latest, h.issue.latest);
  assert.equal(payload.issue.url, 'https://github.com/owner/inbox/issues/42');
  assert.equal(payload.attempt, 1);
  const state = JSON.parse(fs.readFileSync(h.file));
  assert.equal(state.deadline_ms, h.now + 870000);
  assert.equal(state.claim_ref, 12);
  assert.equal(state.runner_pid, undefined);
  assert.equal(state.pid, undefined);
  assert.equal(fs.statSync(h.file).mode & 0o777, 0o600);
  h.child.stdout.write('earlier\nhttps://example.com/pr/1\n\n');
  h.child.emit('close', 0, null);
  const result = await pending;
  assert.equal(result.status, 'repaired');
  assert.equal(result.url, 'https://example.com/pr/1');
  assert.deepEqual(h.calls.map(call => call[0]), ['outcome', 'release']);
  assert.equal(fs.existsSync(h.file), false);
  assert.equal(h.timers.size, 0);
});

test('payload preserves full event, redacts secrets, uses file URL and trailing failure attempt', t => {
  const h = harness(t);
  h.ctx.config.sink = { type: 'file' };
  h.issue.latest.detail = 'supersecret.value';
  h.issue.outcomes = [{ status: 'dispatch-failed' }, { status: 'repaired' }, { status: 'dispatch-failed' }];
  const payload = buildPayload(h.ctx, h.issue, h.claim);
  assert.equal(payload.latest.detail, '[REDACTED]');
  assert.equal(payload.attempt, 2);
  assert.equal(payload.issue.url, 'file://' + h.home + '/board.jsonl#42');
  assert.equal(buildEnvironment({}, [], payload, 'state').ERRMETER_AGENT, 'nora');
});

test('sensitive metadata is redacted in both dispatch state and stdin and event first time wins', async t => {
  const h = harness(t);
  h.issue.latest.meta = { api_key: 'tiny', token: 'other', custom: 'keep' };
  h.issue.firstOccurrenceAt = '2026-08-01T00:00:00Z';
  h.issue.first_ts = '2026-08-02T00:00:00Z';
  const pending = dispatch(h.ctx, h.issue, h.claim, h.options);
  for (const payload of [JSON.parse(h.input()), JSON.parse(fs.readFileSync(h.file))]) {
    assert.deepEqual(payload.latest.meta, { api_key: '[REDACTED]', token: '[REDACTED]', custom: 'keep' });
    assert.equal(payload.issue.first_ts, h.issue.firstOccurrenceAt);
  }
  assert.equal(h.issue.latest.meta.api_key, 'tiny');
  h.child.emit('close', 0, null);
  await pending;
});

test('output buffers redact split secrets, PEM and oversized lines while retaining bounded tail', () => {
  const capture = outputCapture(['supersecret.value']);
  capture.write(Buffer.from('supersec')); capture.write(Buffer.from('ret.value\n'));
  assert.equal(capture.summary(), '[REDACTED]');
  capture.write('-----BEGIN ' + 'PRIVATE KEY-----\n');
  capture.write('secret body\n'.repeat(30));
  capture.write('-----END ' + 'PRIVATE KEY-----\n');
  assert.equal(capture.excerpt().includes('secret body'), false);
  capture.write('x'.repeat(70000) + 'supersecret.value\n');
  assert.equal(capture.summary(), '[errmeter: oversized output line omitted]');
  capture.write(Array.from({ length: 25 }, (_, i) => 'line ' + i + '\n').join(''));
  capture.write('a'.repeat(600)); capture.finish();
  assert.equal(capture.summary().length, 500);
  assert.equal(capture.excerpt().split('\n').length, 20);
  assert.equal(capture.excerpt().includes('line 5\n'), false);
});

test('confirmed renewal alone re-arms state and preserves hook PID fields', async t => {
  const h = harness(t);
  const pending = dispatch(h.ctx, h.issue, h.claim, h.options);
  const state = JSON.parse(fs.readFileSync(h.file));
  fs.writeFileSync(h.file, JSON.stringify({ ...state, pid: 456789, hook_pid: 456789 }));
  await h.fire(180000);
  const renewed = JSON.parse(fs.readFileSync(h.file));
  assert.equal(renewed.deadline_ms, h.now + 1050000);
  assert.equal(renewed.pid, 456789);
  assert.equal(renewed.claim_expires, new Date(h.now + 1080000).toISOString());
  assert.deepEqual(h.calls[0].slice(2), [42, { watcherId: 'watcher-1', claimRef: 12, ttlSec: 900 }]);
  h.child.emit('close', 0, null);
  await pending;
  assert.equal(h.kills.length, 0);
});

test('renewal replaces an existing state when Windows refuses rename-over-destination', async t => {
  const h = harness(t);
  const pending = dispatch(h.ctx, h.issue, h.claim, h.options);
  const rename = fs.renameSync;
  let refused = false;
  fs.renameSync = (from, to) => {
    if (to === h.file && fs.existsSync(to) && !refused) {
      refused = true;
      const error = new Error('Windows destination exists'); error.code = 'EPERM'; throw error;
    }
    return rename(from, to);
  };
  try { await h.fire(180000); } finally { fs.renameSync = rename; }
  assert.equal(refused, true);
  assert.equal(JSON.parse(fs.readFileSync(h.file)).deadline_ms, h.now + 1050000);
  assert.equal(h.kills.length, 0);
  h.child.emit('close', 0, null);
  assert.equal((await pending).status, 'repaired');
});

test('renewal holds the shared lock from current-state read through replacement across processes', async t => {
  const h = harness(t);
  const pending = dispatch(h.ctx, h.issue, h.claim, h.options);
  const originalRead = fs.readFileSync, originalRename = fs.renameSync;
  let lockedRead = false, collision;
  fs.readFileSync = (file, ...args) => {
    if (file === h.file) {
      lockedRead = fs.existsSync(h.file + '.lock');
      assert.equal(lockedRead, true);
    }
    return originalRead(file, ...args);
  };
  fs.renameSync = (from, to) => {
    if (to === h.file) {
      collision = spawnSync(process.execPath, ['-e',
        "const fs=require('node:fs');try{fs.openSync(process.argv[1],'wx');process.exit(2);}catch(error){process.exit(error.code==='EEXIST'?0:3);}",
        h.file + '.lock'], { encoding: 'utf8', env: {} });
    }
    return originalRename(from, to);
  };
  try { await h.fire(180000); }
  finally { fs.readFileSync = originalRead; fs.renameSync = originalRename; }
  assert.equal(lockedRead, true);
  assert.equal(collision.status, 0, collision.stderr);
  assert.equal(fs.existsSync(h.file + '.lock'), false);
  assert.equal(h.kills.length, 0);
  h.child.emit('close', 0, null);
  await pending;
});

test('a runner-held state lock makes renewal fail closed without changing state or stealing the lock', async t => {
  const h = harness(t);
  const pending = dispatch(h.ctx, h.issue, h.claim, h.options);
  const initial = fs.readFileSync(h.file, 'utf8');
  const lock = h.file + '.lock';
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    await h.fire(180000);
    assert.deepEqual(h.kills, [[-h.child.pid, 'SIGTERM']]);
    assert.equal(fs.readFileSync(h.file, 'utf8'), initial);
    assert.equal(fs.existsSync(lock), true);
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  h.child.emit('close', 124, null);
  assert.equal((await pending).status, 'dispatch-failed');
});

for (const result of [{ ok: false }, { ok: false, reason: 'holder-changed' }, { ok: false, reason: 'transport' }, { ok: true, statusCode: 503 }, { ok: true, expiresAt: 'invalid' }]) {
  test('unconfirmed renewal kills runner and cannot extend state: ' + JSON.stringify(result), async t => {
    const h = harness(t, { async renewClaim() { return result; } });
    const pending = dispatch(h.ctx, h.issue, h.claim, h.options);
    const initial = fs.readFileSync(h.file, 'utf8');
    await h.fire(180000);
    assert.deepEqual(h.kills, [[-h.child.pid, 'SIGTERM']]);
    assert.equal(fs.readFileSync(h.file, 'utf8'), initial);
    h.child.emit('close', 0, null);
    assert.equal((await pending).status, 'dispatch-failed');
    assert.equal(h.timers.size, 0);
    assert.equal(h.kills.length, 1);
  });
}

test('GitHub renewal retries transient transport while the hook keeps running', async t => {
  const h = harness(t, { renewClaim: require('../src/sinks/github-issue').renewClaim });
  h.ctx.config.sink.token = 'test.token.' + 'value';
  let posts = 0; let sleeps = 0;
  const date = new Date(h.now).toUTCString();
  h.ctx.http = async options => {
    if (options.method === 'POST') return { status: ++posts === 1 ? 502 : 201, date, headers: {}, body: {} };
    return { status: 200, date, headers: {}, body: [{ id: 12, created_at: new Date(h.now).toISOString(),
      body: '<!-- errmeter:claim watcher=watcher-1 expires=' + h.claim.expiresAt + ' ref=new -->' }] };
  };
  h.ctx.sleep = async delay => { sleeps++; assert.equal(delay, 2000); assert.deepEqual(h.kills, []); };
  const pending = dispatch(h.ctx, h.issue, h.claim, h.options);
  await h.fire(180000);
  assert.equal(posts, 2);
  assert.equal(sleeps, 1);
  assert.deepEqual(h.kills, []);
  h.child.emit('close', 0, null);
  assert.equal((await pending).status, 'repaired');
});

test('hanging renew is fenced at expires minus renew interval, and late success cannot mutate state', async t => {
  let answer;
  const h = harness(t, { renewClaim() { return new Promise(resolve => { answer = resolve; }); } });
  const pending = dispatch(h.ctx, h.issue, h.claim, h.options);
  const renewal = h.fire(180000);
  await h.fire(720000);
  assert.deepEqual(h.kills, [[-h.child.pid, 'SIGTERM']]);
  h.child.emit('close', 124, null);
  assert.equal((await pending).status, 'dispatch-failed');
  answer({ ok: true, expiresAt: new Date(h.now + 1080000).toISOString() });
  await renewal;
  assert.equal(fs.existsSync(h.file), false);
});

test('failed dispatch returns escalation on single outcome and redacted last 20 stderr lines', async t => {
  const h = harness(t);
  h.issue.outcomes = [{ status: 'dispatch-failed' }];
  const pending = dispatch(h.ctx, h.issue, h.claim, h.options);
  h.child.stderr.write(Array.from({ length: 25 }, (_, i) => 'line ' + i + ' supersecret.value\n').join(''));
  h.child.stdout.write('file:///not-a-pr\n');
  h.child.emit('close', 1, null);
  const result = await pending;
  assert.equal(result.needsHuman, true);
  assert.equal(result.escalate, true);
  assert.equal(result.consecutiveFailures, 2);
  assert.equal(result.url, undefined);
  assert.equal(result.excerpt.split('\n').length, 20);
  assert.equal(result.excerpt.includes('supersecret.value'), false);
  assert.equal(h.calls.filter(call => call[0] === 'outcome').length, 1);
});

test('spawn errors become failed outcomes and board failures preserve recovery state', async t => {
  const h = harness(t);
  const pending = dispatch(h.ctx, h.issue, h.claim, h.options);
  h.child.emit('error', new Error('spawn error containing supersecret.value'));
  assert.equal((await pending).status, 'dispatch-failed');
  const h2 = harness(t, { async writeOutcome() { throw new Error('board unavailable'); } });
  const failed = dispatch(h2.ctx, h2.issue, h2.claim, h2.options);
  h2.child.emit('close', 1, null);
  await assert.rejects(failed, /board unavailable/);
  assert.equal(fs.existsSync(h2.file), true);
  assert.equal(h2.calls.length, 0);
});

test('release transport failure after durable outcome still returns escalation without secret diagnostics', async t => {
  const h = harness(t, { async releaseClaim() { throw new Error('supersecret.value'); } });
  const logs = [];
  h.ctx.log = message => logs.push(message);
  h.issue.outcomes = [{ status: 'dispatch-failed' }];
  const pending = dispatch(h.ctx, h.issue, h.claim, h.options);
  h.child.emit('close', 1, null);
  const result = await pending;
  assert.equal(result.needsHuman, true);
  assert.equal(result.releaseFailed, true);
  assert.equal(h.calls.filter(call => call[0] === 'outcome').length, 1);
  assert.equal(fs.existsSync(h.file), false);
  assert.equal(JSON.stringify({ result, logs }).includes('supersecret.value'), false);
});

test('watcher abort detaches without killing runner or altering claim and state', async t => {
  const h = harness(t), controller = new AbortController();
  const pending = dispatch(h.ctx, h.issue, h.claim, { ...h.options, signal: controller.signal });
  const initial = fs.readFileSync(h.file, 'utf8');
  controller.abort();
  assert.deepEqual(await pending, { detached: true });
  assert.equal(h.child.unreferenced, true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.kills.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(fs.readFileSync(h.file, 'utf8'), initial);
});

test('restart cleanup signals hook and runner groups, falls back to PID and removes malformed state', async t => {
  const h = harness(t), kills = [];
  fs.mkdirSync(path.dirname(h.file), { recursive: true });
  fs.writeFileSync(h.file, JSON.stringify({ pid: 456789, runner_pid: 123456 }));
  fs.writeFileSync(h.file + '.lock', '');
  fs.writeFileSync(path.join(path.dirname(h.file), '44.json.lock'), '');
  fs.writeFileSync(path.join(path.dirname(h.file), '43.json'), 'broken JSON');
  const live = new Set([456789, 123456]);
  await cleanupDispatches(h.home, { platform: 'linux', kill(pid, signal) {
    assert.equal(fs.existsSync(h.file + '.lock'), true);
    if (signal === 0) {
      if (!live.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return;
    }
    kills.push([pid, signal]);
    if (pid === -456789) throw new Error('no process group');
    live.delete(Math.abs(pid));
  } });
  assert.deepEqual(kills, [[-456789, 'SIGTERM'], [456789, 'SIGTERM'], [-123456, 'SIGTERM']]);
  assert.deepEqual(fs.readdirSync(path.dirname(h.file)), []);
});

test('dispatch state updates recover an orphaned stale lock', t => {
  const h = harness(t);
  fs.mkdirSync(path.dirname(h.file), { recursive: true });
  const lock = h.file + '.lock';
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, started_ms: 0 }) + '\n');
  const old = new Date(Date.now() - 20000); fs.utimesSync(lock, old, old);
  atomicState(h.file, { value: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file)), { value: 1 });
  assert.equal(fs.existsSync(lock), false);
});

test('restart cleanup force-kills a TERM-resistant recorded process before deleting state', async t => {
  if (process.platform === 'win32') return;
  const h = harness(t);
  fs.mkdirSync(path.dirname(h.file), { recursive: true });
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });
  await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', resolve); });
  fs.writeFileSync(h.file, JSON.stringify({ pid: child.pid }) + '\n');
  await cleanupDispatches(h.home, { cleanupGraceMs: 100, cleanupKillMs: 1000 });
  let alive = true;
  try { process.kill(child.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
  if (alive) {
    const stat = (spawnSync('ps', ['-o', 'stat=', '-p', String(child.pid)], { encoding: 'utf8' }).stdout || '').trim();
    alive = Boolean(stat && !stat.startsWith('Z'));
  }
  assert.equal(alive, false);
  assert.equal(fs.existsSync(h.file), false);
});

test('real runner forwards JSON and isolated environment to a hook and returns its redacted output', async t => {
  const h = harness(t);
  h.ctx.boardTime = Date.now();
  h.claim.expiresAt = new Date(Date.now() + 30000).toISOString();
  Object.assign(h.ctx.config.watch, { claim_ttl_sec: 30, renew_sec: 5, kill_grace_sec: 5 });
  h.ctx.config.watch.dispatch = { command: [process.execPath, '-e',
    "let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const payload=JSON.parse(input);const state=JSON.parse(require('node:fs').readFileSync(process.env.ERRMETER_EVENT_FILE));if(payload.issue.ref!==42||process.env.ERRMETER_GITHUB_TOKEN||process.env.PRIVATE||state.pid!==process.pid||state.runner_pid!==process.ppid)process.exit(1);console.error('supersecret.value');console.log('https://example.com/pr/42');});"],
    timeout_sec: 3, pass_env: [] };
  const result = await dispatch(h.ctx, h.issue, h.claim, { env: h.options.env });
  assert.equal(result.status, 'repaired');
  assert.equal(result.url, 'https://example.com/pr/42');
  assert.equal(result.excerpt, '[REDACTED]');
  assert.equal(fs.existsSync(h.file), false);
});
