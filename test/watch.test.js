'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { watch, tick } = require('../src/watch');
const { flush } = require('../src/flush');
const { checkGaps } = require('../src/heartbeat');
const { parseWatch, parseRun } = require('../src/cli');
const { request } = require('../src/http');
const githubSink = require('../src/sinks/github-issue');
const { createGithubFake } = require('./fixtures/github-fake');

function fixture(t, config = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-watch-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ schema: 1, host: 'test',
    sink: { type: 'file' }, watch: { role: 'agent-host', watcher_id: 'test' }, ...config }));
  return { home, env: { ERRMETER_HOME: home } };
}
function context(extra = {}) {
  const controller = new AbortController();
  const ctx = { home: '/tmp/watch-test', configPath: '/tmp/watch-test/config.json', env: {},
    config: { watch: { role: 'watcher', watcher_id: 'test', claim_ttl_sec: 900, max_concurrent: 1,
      heartbeat_gap_sec: 900, gaps: {} }, owner: { mention: '@owner' } },
    maskList: [], signal: controller.signal, clock: () => Date.parse('2026-09-06T00:00:00Z'),
    emit: () => 0, flush: async (args, env, io) => { io.stdout('{"pending_remaining":0}'); return 0; },
    log: () => {}, checkGaps: async () => ({ gaps: 0 }),
    sink: { listOpenFailures: async () => [], getFailure: async () => null }, ...extra };
  ctx.now = () => ctx.boardTime || new Date(ctx.clock()).toISOString();
  return { ctx, controller };
}

test('watch and internal runner parsers validate flags without changing emit/flush parsing', () => {
  assert.deepEqual(parseWatch(['--once', '--interval=2', '--role', 'agent-host']), { once: true, interval: 2, role: 'agent-host' });
  for (const args of [['--interval', '0'], ['--role', 'bad'], ['--once=true'], ['--no-flush']]) assert.throws(() => parseWatch(args));
  const run = parseRun(['--deadline-ms', '100', '--deadline-mono-ms=50', '--timeout', '1', '--state', '/tmp/state', '--', 'node', '-e', '']);
  assert.equal(run['deadline-ms'], 100);
  assert.deepEqual(run.command, ['node', '-e', '']);
  assert.throws(() => parseRun(['--timeout', '1']));
});

test('agent-host emits heartbeat before flushing and never reads failures or gaps', async t => {
  const f = fixture(t);
  const calls = []; let stdout = '';
  const code = await watch(['--once', '--json'], f.env, {
    cleanup: home => { assert.equal(home, f.home); calls.push('cleanup'); },
    emit: args => { calls.push('emit'); assert.ok(args.includes('--no-flush')); assert.ok(args.includes('role=agent-host')); return 0; },
    flush: async (args, env, io) => { calls.push('flush'); assert.ok(!args.includes('--linger')); assert.ok(args.includes('--quiet')); assert.equal(io.notify, undefined); io.stdout('{"pending_remaining":0}'); return 0; },
    sink: { listOpenFailures: () => assert.fail('agent-host claimed') },
    checkGaps: () => assert.fail('agent-host checked gaps'), stdout: line => { stdout += line; }, stderr: () => {}
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, ['cleanup', 'emit', 'flush']);
  assert.equal(JSON.parse(stdout).role, 'agent-host');
});

test('watch once file sink flushes its current heartbeat in-process', async t => {
  const f = fixture(t);
  let stdout = '';
  const code = await watch(['--once', '--json'], f.env, { tmpdir: f.home, stdout: line => { stdout += line; }, stderr: () => {} });
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).pending_remaining, 0);
  const rows = fs.readFileSync(path.join(f.home, 'board.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].record.agent, 'watcher/test');
  assert.equal(rows[0].record.role, 'agent-host');
});

test('watch refuses webhook configuration before startup cleanup', async t => {
  const f = fixture(t, { sink: { type: 'webhook', url: 'http://localhost/hook' } });
  assert.equal(await watch(['--once'], f.env, { cleanup: () => assert.fail('cleanup before config refusal'), stdout: () => {}, stderr: () => {} }), 3);
});

test('gap checks use per-agent gap and board time and let upsertAlert own notifications', async () => {
  const { ctx } = context();
  ctx.boardTime = '2026-09-06T02:00:00Z';
  ctx.config.watch.gaps['slow@host'] = 10800;
  let alerts = [];
  ctx.notify = () => assert.fail('heartbeat called notify outside board election');
  ctx.sink = { listHeartbeats: async () => [
    { agent: 'fast', host: 'host', lastSeen: '2026-09-06T00:00:00Z' },
    { agent: 'slow', host: 'host', lastSeen: '2026-09-06T00:00:00Z' }
  ], upsertAlert: async (ctx, alert) => { alerts.push(alert); return { winner: false }; } };
  assert.equal((await checkGaps(ctx)).gaps, 1);
  assert.equal(alerts[0].key, 'heartbeat-gap:fast@host');
  assert.equal(alerts[0].mention, '@owner');
});

test('normal ticks retain running dispatches and refresh API budget without dispatch overlap', async () => {
  let finish; let dispatches = 0; const budgets = [];
  const { ctx } = context();
  const detail = { ref: 1, labels: [], claim: null, lastOutcome: null };
  ctx.sink = {
    listOpenFailures: async ctx => { budgets.push(ctx.apiCalls); ctx.apiCalls = 5; return [detail]; },
    getFailure: async () => detail,
    claim: async () => ({ won: true, claimRef: 1, expiresAt: '2026-09-06T00:15:00Z' })
  };
  ctx.dispatch = async () => { dispatches++; return new Promise(resolve => { finish = resolve; }); };
  assert.equal((await tick(ctx)).dispatched, 1);
  assert.equal(ctx.running.size, 1);
  assert.equal((await tick(ctx)).dispatched, 0);
  assert.equal(dispatches, 1);
  assert.deepEqual(budgets, [0, 0]);
  finish({ status: 'repaired' });
  await Promise.all(ctx.running.values());
  assert.equal(ctx.running.size, 0);
});

test('once waits for its dispatch outcome and reports failure', async t => {
  const f = fixture(t, { watch: { watcher_id: 'test', dispatch: { command: ['node', 'repair.js'] } } });
  let finish; let complete = false; let stdout = '';
  const detail = { ref: 1, labels: [], claim: null, lastOutcome: null };
  const promise = watch(['--once', '--json'], f.env, { cleanup: () => {}, emit: () => 0,
    flush: async (a, e, io) => { io.stdout('{"pending_remaining":0}'); return 0; },
    sink: { listOpenFailures: async () => [detail], getFailure: async () => detail, claim: async () => ({ won: true }) },
    dispatch: async () => new Promise(resolve => { finish = resolve; }), checkGaps: async () => ({ gaps: 0 }),
    stdout: line => { stdout += line; }, stderr: () => {}
  }).then(code => { complete = true; return code; });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(complete, false);
  assert.equal(typeof finish, 'function');
  finish({ status: 'dispatch-failed' });
  assert.equal(await promise, 1);
  assert.equal(JSON.parse(stdout).dispatch_failed, 1);
});

test('incomplete detail lookups never claim; errors are redacted and emitted without flush', async () => {
  const emitted = []; const { ctx } = context({ maskList: ['private-value'], emit: args => { emitted.push(args); return 0; } });
  ctx.sink = { listOpenFailures: async () => [{ ref: 1 }], getFailure: async ctx => { ctx.lookup_incomplete = true; return {}; }, claim: () => assert.fail('incomplete claim') };
  assert.equal((await tick(ctx)).lookup_incomplete, true);
  ctx.sink.listOpenFailures = async () => { throw new Error('error private-value'); };
  const summary = await tick(ctx);
  assert.deepEqual(summary.errors, ['error [REDACTED]']);
  assert.ok(emitted.at(-1).includes('--no-flush'));
  assert.ok(emitted.at(-1).includes('--message=error [REDACTED]'));
});

test('watch signal stops future ticks and removes its signal listeners', async t => {
  const f = fixture(t); const signals = new EventEmitter(); let emitted = 0;
  const code = await watch([], f.env, { signals, cleanup: () => {}, emit: () => { emitted++; return 0; },
    flush: async (args, env, io) => { signals.emit('SIGTERM'); io.stdout('{"pending_remaining":0}'); return 0; },
    stdout: () => {}, stderr: () => {} });
  assert.equal(code, 0); assert.equal(emitted, 1);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('watch text summary uses the frozen fields and internal flush emits no extra output', async t => {
  const f = fixture(t); let stdout = '';
  const code = await watch(['--once'], f.env, { tmpdir: f.home, stdout: line => { stdout += line; }, stderr: () => {} });
  assert.equal(code, 0);
  assert.equal(stdout, 'watch: role=agent-host flush=0 eligible=0 claimed=0 dispatched=0 gaps=0\n');
});

test('watch once preserves an internal flush configuration error exit code', async t => {
  const f = fixture(t); let stdout = '';
  const code = await watch(['--once', '--json'], f.env, { cleanup: () => {}, emit: () => 0,
    flush: async () => 3, stdout: line => { stdout += line; }, stderr: () => {} });
  assert.equal(code, 3);
  assert.equal(JSON.parse(stdout).flush, 3);
});

test('pre-labelled needs-human failures reconcile alerts again after transport or notification failure', async t => {
  const f = fixture(t, { watch: { watcher_id: 'test', dispatch: { command: ['node', 'repair.js'] } } });
  const alerts = []; let attempt = 0;
  const record = { ref: 8, labels: ['errmeter:needs-human'], url: 'https://github.com/test/inbox/issues/8' };
  const io = { cleanup: () => {}, emit: () => 0,
    flush: async (args, env, io) => { io.stdout('{"pending_remaining":0}'); return 0; },
    sink: { listOpenFailures: async () => [record],
      getFailure: () => assert.fail('escalated record is not dispatch eligible'),
      upsertAlert: async (ctx, alert) => {
        alerts.push(alert);
        if (++attempt === 1) throw new Error('temporary board failure');
        return attempt === 2 ? { winner: true, notified: false } : { winner: false, skipped: true };
      } },
    checkGaps: async () => ({ gaps: 0 }), stdout: () => {}, stderr: () => {}
  };
  assert.equal(await watch(['--once'], f.env, io), 1);
  assert.equal(await watch(['--once'], f.env, io), 1);
  assert.equal(await watch(['--once'], f.env, io), 0);
  assert.equal(alerts.length, 3);
  assert.ok(alerts.every(alert => alert.key === 'needs-human:8' && alert.body.includes(record.url)));
  assert.deepEqual(alerts[0], alerts[1]);
});

test('tick counts all eligible summaries and claims only ascending refs within capacity', async () => {
  const calls = []; const { ctx } = context();
  const records = [10, 2, 5].map(ref => ({ ref, labels: [], lastOutcome: null }));
  ctx.sink = { listOpenFailures: async () => records,
    getFailure: async (ctx, ref) => { calls.push(ref); return records.find(record => record.ref === ref); },
    claim: async () => ({ won: false }) };
  const summary = await tick(ctx, { once: true });
  assert.equal(summary.eligible, 3);
  assert.equal(summary.claimed, 0);
  assert.deepEqual(calls, [2]);
});

test('incomplete claim election is a silent skip and makes the tick incomplete', async () => {
  const emitted = []; const { ctx } = context({ emit: args => { emitted.push(args); return 0; } });
  const detail = { ref: 1, labels: [] };
  ctx.sink = { listOpenFailures: async () => [detail], getFailure: async () => detail,
    claim: async () => { throw Object.assign(new Error('incomplete'), { code: 'LOOKUP_INCOMPLETE' }); } };
  const summary = await tick(ctx);
  assert.equal(summary.lookup_incomplete, true);
  assert.deepEqual(summary.errors, []);
  assert.equal(emitted.length, 1);
});

test('escalated dispatch invokes one board alert including issue URL and owner mention', async () => {
  const { ctx } = context(); const alerts = [];
  const detail = { ref: 4, labels: [], url: 'https://github.com/test/inbox/issues/4' };
  ctx.sink = { listOpenFailures: async () => [detail], getFailure: async () => detail,
    claim: async () => ({ won: true }), upsertAlert: async (ctx, alert) => { alerts.push(alert); return { winner: true }; } };
  ctx.dispatch = async () => ({ status: 'dispatch-failed', needsHuman: true, consecutiveFailures: 2 });
  ctx.notify = () => assert.fail('watch may not notify directly');
  const summary = await tick(ctx, { once: true });
  assert.equal(summary.dispatch_failed, 1);
  assert.equal(summary.claimed, 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].key, 'needs-human:4');
  assert.match(alerts[0].body, /https:\/\/github.com\/test\/inbox\/issues\/4/);
  assert.match(alerts[0].body, /@owner/);
});

test('watch once repairs an emitted file-board failure through the real runner and releases its claim', async t => {
  const f = fixture(t, { watch: { watcher_id: 'test', dispatch: {
    command: [process.execPath, '-e', 'process.stdin.resume(); process.stdin.on("end", () => console.log("repair proposed"))']
  } } });
  assert.equal(require('../src/emit').emit(['--agent', 'test-agent', '--message', 'needs repair', '--no-flush', '--quiet'], f.env,
    { stdout: () => {}, stderr: () => {} }), 0);
  let stdout = ''; let stderr = '';
  const code = await watch(['--once', '--json'], f.env, { tmpdir: f.home,
    stdout: line => { stdout += line; }, stderr: line => { stderr += line; } });
  assert.equal(code, 0, stderr);
  const summary = JSON.parse(stdout);
  assert.equal(summary.claimed, 1); assert.equal(summary.dispatched, 1);
  const resolved = require('../src/config').resolveConfig({}, f.env, { command: 'watch' });
  const sink = require('../src/sinks/file');
  const ctx = { ...resolved, now: () => new Date().toISOString() };
  const records = await sink.listOpenFailures(ctx);
  const detail = await sink.getFailure(ctx, records[0].ref);
  assert.equal(detail.lastOutcome.status, 'repaired');
  assert.equal(detail.lastOutcome.summary, 'repair proposed');
  assert.equal(detail.claim, null);
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'state', 'dispatch')), []);
});

test('two full GitHub watchers elect one claim and run exactly one hook', async t => {
  const gates = new Map();
  async function rendezvous(key) {
    let gate = gates.get(key);
    if (!gate) {
      let release; gate = { count: 0, promise: new Promise(resolve => { release = resolve; }), release };
      gates.set(key, gate);
    }
    gate.count++;
    if (gate.count === 2) gate.release();
    await gate.promise;
  }
  let failureReads = 0;
  const fake = await createGithubFake({ onRequest: async entry => {
    if (entry.method === 'GET' && /^\/repos\/test\/inbox\/issues\/1\/comments\?/.test(entry.url) && failureReads < 4) {
      const pair = Math.floor(failureReads++ / 2); await rendezvous('read-' + pair);
    }
    if (entry.method === 'POST' && entry.url === '/repos/test/inbox/issues/1/comments' &&
        /^<!-- errmeter:claim .* ref=new -->$/.test(entry.body?.body || '')) await rendezvous('claim-post');
  } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-watch-race-'));
  t.after(async () => { await fake.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const token = 'test.token.' + 'value.1';
  const stamp = new Date().toISOString();
  const event = { schema: 1, id: 'race-event', ts: stamp, kind: 'error', agent: 'race-agent', host: 'race-host',
    fingerprint: '0123456789abcdef', fpv: 1, message: 'race failure', meta: {} };
  const seedCtx = { home: root, http: request, now: () => stamp, maskList: [token],
    config: { host: 'seed', sink: { repo: 'test/inbox', token, api_base: fake.url },
      watch: { claim_ttl_sec: 6 }, max_api_calls_per_pass: 500 } };
  const failure = await githubSink.deliverFailureGroup(seedCtx,
    { fingerprint: event.fingerprint, fpv: 1, agent: event.agent, count: 1, events: [event] });
  const runs = path.join(root, 'hook-runs.txt');
  const cli = path.resolve(__dirname, '../bin/errmeter.js');
  const homes = ['alpha', 'beta'].map(id => {
    const home = path.join(root, id); fs.mkdirSync(home);
    const config = { schema: 1, host: id, sink: { type: 'github-issue', repo: 'test/inbox', api_base: fake.url },
      owner: { mention: '@owner' }, watch: { role: 'watcher', watcher_id: id, claim_ttl_sec: 6,
        renew_sec: 2, kill_grace_sec: 1, max_concurrent: 1, dispatch: { timeout_sec: 4, pass_env: [],
          command: [process.execPath, '-e',
            "require('node:fs').appendFileSync(process.argv[1],process.env.ERRMETER_WATCHER_ID+'\\n');console.log('https://example.com/pr/race')", runs] } } };
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config)); return home;
  });
  function launch(home) {
    const child = spawn(process.execPath, [cli, 'watch', '--once', '--quiet'],
      { env: { ...process.env, ERRMETER_HOME: home, ERRMETER_GITHUB_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); });
  }
  const results = await Promise.all(homes.map(launch));
  assert.deepEqual(results.map(result => result.code).sort(), [0, 1], JSON.stringify(results));
  assert.equal(fs.readFileSync(runs, 'utf8').trim().split('\n').length, 1);
  const detail = await githubSink.getFailure({ ...seedCtx, apiCalls: 0 }, failure.ref);
  assert.equal(detail.outcomes.filter(outcome => outcome.status === 'repaired').length, 1);
  assert.equal(detail.claim, null);
  const newClaims = fake.comments.filter(comment => comment.issue_number === failure.ref &&
    /^<!-- errmeter:claim .* ref=new -->$/.test(comment.body));
  assert.equal(newClaims.length, 1, 'the losing watcher deletes exactly its own candidate');
  assert.equal(fake.requests.filter(entry => entry.method === 'DELETE' && /\/issues\/comments\//.test(entry.url)).length, 1);
});

test('#18 flush removes orphan cut checkpoints and folds superseded pending heartbeats', async t => {
  const f = fixture(t);
  const pending = path.join(f.home, 'spool', 'pending');
  const cuts = path.join(f.home, 'state', 'cuts');
  fs.mkdirSync(pending, { recursive: true });
  fs.mkdirSync(cuts, { recursive: true });
  fs.writeFileSync(path.join(cuts, 'orphan.json'), JSON.stringify({ k: 0, offset: 0, end: 0, posted: [] }));
  const base = { schema: 1, kind: 'heartbeat', agent: 'watcher/test', host: 'test', message: '', emitter: 'errmeter/0.0.0', attempts: 0 };
  fs.writeFileSync(path.join(pending, 'one.json'), JSON.stringify({ ...base, id: 'one', ts: '2026-09-05T11:59:00.000Z' }) + '\n');
  fs.writeFileSync(path.join(pending, 'two.json'), JSON.stringify({ ...base, id: 'two', ts: '2026-09-05T12:00:00.000Z' }) + '\n');
  const sink = { deliverHeartbeat: async () => ({ pending: true }), deliverFailureGroup: async () => ({ pending: true }),
    listHeartbeats: async () => [], listOpenFailures: async () => [], upsertAlert: async () => ({ ref: 1 }) };
  const code = await flush(['--home', f.home, '--config', path.join(f.home, 'config.json'), '--json'], f.env,
    { sink, tmpdir: f.home, stdout: () => {}, stderr: () => {} });
  assert.equal(code, 1);
  assert.deepEqual(fs.readdirSync(pending), ['two.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(pending, 'two.json'), 'utf8')).id, 'two');
  assert.deepEqual(fs.readdirSync(cuts), []);
});
