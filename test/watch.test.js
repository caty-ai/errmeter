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
function failingDetailProcess(home, phase, code) {
  const program = `
    const { tick } = require(${JSON.stringify(path.resolve(__dirname, '../src/watch'))});
    const controller = new AbortController();
    const ctx = {
      home: process.env.TEST_HOME, configPath: '', env: {}, maskList: [], signal: controller.signal,
      config: { watch: { role: 'watcher', watcher_id: 'test', claim_ttl_sec: 900, max_concurrent: 1,
        heartbeat_gap_sec: 900, gaps: {} }, owner: { mention: '' } },
      clock: () => Date.parse('2026-09-06T00:00:00Z'), emit: () => 0, flush: async () => 0,
      log: () => {}, checkGaps: async () => ({ gaps: 0 }),
      sink: {
        listOpenFailures: async () => [{ ref: 1, labels: [] }, { ref: 2, labels: [] }],
        getFailure: async (ctx, ref) => {
          if (process.env.TEST_PHASE === 'first' && ref === 1) {
            const error = new Error('detail failed');
            if (process.env.TEST_CODE) error.code = process.env.TEST_CODE;
            throw error;
          }
          return { ref, labels: [] };
        },
        claim: async () => ({ won: true, claimRef: 1, expiresAt: '2026-09-06T00:15:00.000Z' })
      },
      dispatch: async () => ({ status: 'repaired' })
    };
    ctx.now = () => ctx.boardTime || new Date(ctx.clock()).toISOString();
    tick(ctx, { once: true }).then(summary => process.stdout.write(JSON.stringify(summary)), error => {
      process.stderr.write(String(error.stack || error)); process.exitCode = 1;
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', program], { env: { TEST_HOME: home, TEST_PHASE: phase, TEST_CODE: code || '' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', exitCode => exitCode === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || 'probe exited ' + exitCode)));
  });
}

test('thirty open failures leave budget for the last candidate and its complete dispatch', async t => {
  const f = fixture(t);
  const stamp = '2026-09-06T00:00:00.000Z';
  const fake = await createGithubFake({ now: new Date(stamp) });
  t.after(() => fake.close());
  for (let ref = 1; ref <= 30; ref++) fake.seedIssue({
    body: '<!-- errmeter:failure fp=0123456789abcdef fpv=1 ids=event count=1 first=' + stamp + ' last=' + stamp + ' -->',
    labels: ['errmeter:failure', ...(ref < 30 ? ['errmeter:needs-human'] : [])]
  });
  const { ctx } = context({ home: f.home, http: request, sink: githubSink });
  ctx.config.sink = { repo: 'test/inbox', token: 'test.token.' + 'value', api_base: fake.url };
  ctx.config.max_api_calls_per_pass = 60;
  ctx.config.watch.escalate_after = 2;
  ctx.dispatch = async (leaseCtx, detail, claim) => {
    assert.equal(detail.ref, 30);
    assert.equal(leaseCtx.apiCalls, 0);
    await githubSink.writeOutcome(leaseCtx, detail.ref, { watcherId: 'test', status: 'repaired' });
    await githubSink.releaseClaim(leaseCtx, detail.ref, { watcherId: 'test', claimRef: claim.claimRef });
    return { status: 'repaired' };
  };
  const result = await tick(ctx, { once: true });
  assert.equal(result.dispatched, 1);
  assert.ok(ctx.apiCalls <= 60);
  assert.ok(fake.comments.some(row => row.issue_number === 30 && /errmeter:outcome /.test(row.body)));
  assert.ok(fake.comments.some(row => row.issue_number === 30 && /errmeter:release /.test(row.body)));
  assert.equal(fake.requests.filter(row => row.method === 'GET' && /\/issues\/(?:[1-9]|[12][0-9])(?:\?|$)/.test(row.url)).length, 0);
});

test('bounded scan leaves backlog without claiming or marking a complete lookup incomplete', async t => {
  const f = fixture(t);
  const fake = await createGithubFake({ now: new Date('2026-09-06T00:00:00.000Z') });
  t.after(() => fake.close());
  for (let ref = 1; ref <= 30; ref++) {
    fake.seedIssue({ body: '<!-- errmeter:failure fp=0123456789abcdef fpv=1 count=1 -->', labels: ['errmeter:failure'] });
    fake.seedComment(ref, { body: '<!-- errmeter:claim watcher=other expires=2026-09-06T01:00:00.000Z ref=new -->' });
  }
  const { ctx } = context({ home: f.home, http: request, sink: githubSink });
  ctx.config.sink = { repo: 'test/inbox', token: 'test.token.' + 'value', api_base: fake.url };
  ctx.config.max_api_calls_per_pass = 60;
  const result = await tick(ctx, { once: true });
  assert.equal(result.lookup_incomplete, false);
  assert.equal(result.dispatched, 0);
  assert.equal(ctx.apiCalls, 51);
  assert.equal(result.scanned, 25);
  assert.equal(result.unscanned, 5);
  assert.equal(result.pending_remaining, 0);
  assert.equal(fake.requests.filter(row => row.method === 'POST').length, 0);
});

for (const scenario of [{ blocked: 30, kind: 'once-failed' }, { blocked: 29, kind: 'foreign-claimed' }, { blocked: 30, kind: 'mixed-claimed-and-failed' }]) {
  test('persisted cursor reaches eligible tail on second tick after ' + scenario.blocked + ' ' + scenario.kind + ' rows', async t => {
    const f = fixture(t);
    const stamp = '2026-09-06T00:00:00.000Z';
    const fake = await createGithubFake({ now: new Date(stamp) });
    t.after(() => fake.close());
    for (let ref = 1; ref <= scenario.blocked + 1; ref++) {
      const claimed = scenario.kind === 'foreign-claimed' || scenario.kind === 'mixed-claimed-and-failed' && ref === 1;
      fake.seedIssue({ body: '<!-- errmeter:failure fp=0123456789abcdef fpv=1 count=1 last=' + stamp + ' -->',
        labels: ['errmeter:failure', ...(claimed && ref <= scenario.blocked ? ['errmeter:claimed'] : [])] });
      if (ref <= scenario.blocked) fake.seedComment(ref, { body: claimed
        ? '<!-- errmeter:claim watcher=other expires=2026-09-06T01:00:00.000Z ref=new -->'
        : '<!-- errmeter:outcome status=dispatch-failed watcher=other ts=' + stamp + ' -->' });
    }
    const completed = [];
    const makeContext = () => {
      const { ctx } = context({ home: f.home, http: request, sink: githubSink,
        dispatch: async (leaseCtx, detail, claim) => {
          completed.push(detail.ref);
          await githubSink.writeOutcome(leaseCtx, detail.ref, { status: 'repaired', watcherId: 'test' });
          await githubSink.releaseClaim(leaseCtx, detail.ref, { watcherId: 'test', claimRef: claim.claimRef });
          return { status: 'repaired' };
        } });
      ctx.config.sink = { repo: 'test/inbox', token: 'short', api_base: fake.url };
      ctx.config.max_api_calls_per_pass = 60;
      ctx.config.watch.escalate_after = 2;
      return ctx;
    };
    const firstCtx = makeContext();
    const first = await tick(firstCtx, { once: true });
    assert.equal(first.scanned, 25);
    assert.equal(first.unscanned, scenario.blocked + 1 - 25);
    assert.equal(first.pending_remaining, 0);
    assert.equal(first.lookup_incomplete, false);
    assert.equal(first.dispatched, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'state', 'scan_cursor.json'))), { ref: 25 });
    const second = await tick(makeContext(), { once: true });
    assert.equal(second.dispatched, 1);
    assert.equal(second.lookup_incomplete, false);
    assert.deepEqual(completed, [scenario.blocked + 1]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'state', 'scan_cursor.json'))), { ref: scenario.blocked + 1 });
    assert.deepEqual(fs.readdirSync(path.join(f.home, 'state')), ['scan_cursor.json']);
  });
}

test('fifty ineligible rows confirm exactly twenty-five per tick and wrap after restart', async t => {
  const f = fixture(t); const reads = [];
  const records = Array.from({ length: 50 }, (_, i) => ({ ref: i + 1, labels: [] }));
  const makeContext = () => context({ home: f.home, sink: {
    listOpenFailures: async ctx => { ctx.apiCalls++; return records; },
    getFailure: async (ctx, ref) => { ctx.apiCalls += 2; reads.push(ref); return { ref, lastOutcome: { at: '2026-09-06T00:00:00Z' }, occurrenceAfterLastOutcome: false }; },
    claim: () => assert.fail('ineligible')
  } }).ctx;
  for (let i = 0; i < 3; i++) {
    const result = await tick(makeContext());
    assert.equal(result.scanned, 25); assert.equal(result.unscanned, 25);
    assert.equal(result.pending_remaining, 0); assert.equal(result.lookup_incomplete, false);
  }
  assert.deepEqual(reads, records.map(row => row.ref).concat(records.slice(0, 25).map(row => row.ref)));
});

test('missing cursor references are ignored and deleted even when no capacity is available', async t => {
  const f = fixture(t); const file = path.join(f.home, 'state', 'scan_cursor.json');
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, JSON.stringify({ ref: 999 }));
  const { ctx } = context({ home: f.home, sink: { listOpenFailures: async () => [{ ref: 1, labels: [] }] } });
  ctx.config.watch.max_concurrent = 0;
  const result = await tick(ctx);
  assert.equal(fs.existsSync(file), false);
  assert.equal(result.scanned, 0); assert.equal(result.unscanned, 1);
});

test('claimed labels do not change scan order and stale mirrors are removed', async t => {
  const f = fixture(t); const reads = [], claims = [], removed = [];
  const { ctx } = context({ home: f.home, sink: {
    listOpenFailures: async () => [{ ref: 1, labels: ['errmeter:claimed'] }, { ref: 2, labels: [] }],
    getFailure: async (ctx, ref) => { reads.push(ref); return { ref, labels: ref === 1 ? ['errmeter:claimed'] : [] }; },
    removeLabels: async (ctx, ref, labels) => { removed.push([ref, labels]); },
    claim: async (ctx, ref) => { claims.push(ref); return { won: false }; }
  } });
  await tick(ctx);
  assert.deepEqual(reads, [1]); assert.deepEqual(claims, [1]);
  assert.deepEqual(removed, [[1, ['errmeter:claimed']]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'state', 'scan_cursor.json'))), { ref: 1 });
});

test('a sink without label removal is skipped and logged once', async t => {
  const f = fixture(t); const logs = [], requests = [];
  const { ctx } = context({ home: f.home, log: message => logs.push(message), http: options => requests.push(options), sink: {
    listOpenFailures: async () => [{ ref: 1, labels: ['errmeter:claimed'] }],
    getFailure: async () => ({ ref: 1, labels: ['errmeter:claimed'] }),
    claim: async () => ({ won: false })
  } });
  await tick(ctx);
  await tick(ctx);
  assert.deepEqual(logs, ['watch: sink does not support stale claimed label cleanup']);
  assert.deepEqual(requests, []);
});

for (const code of [null, 'EAPI_BUDGET']) test('a persistently failing detail read advances the next tick; code=' + (code || 'ordinary'), async t => {
  const f = fixture(t);
  const first = await failingDetailProcess(f.home, 'first', code);
  assert.equal(first.scanned, 1); assert.equal(first.unscanned, 1); assert.equal(first.dispatched, 0);
  assert.equal(first.lookup_incomplete, Boolean(code));
  assert.deepEqual(first.errors, code ? [] : ['detail failed']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'state', 'scan_cursor.json'))), { ref: 1 });
  const second = await failingDetailProcess(f.home, 'second', code);
  assert.equal(second.scanned, 1); assert.equal(second.dispatched, 1); assert.equal(second.lookup_incomplete, false);
});

test('a stale-labelled eligible row after 24 quiescent rows dispatches on the next tick', async t => {
  const f = fixture(t);
  const stamp = '2026-09-06T00:00:00.000Z';
  const fake = await createGithubFake({ now: new Date(stamp) });
  t.after(() => fake.close());
  for (let ref = 1; ref <= 25; ref++) {
    fake.seedIssue({ body: '<!-- errmeter:failure fp=0123456789abcdef fpv=1 count=1 last=' + stamp + ' -->',
      labels: ['errmeter:failure', ...(ref === 25 ? ['errmeter:claimed'] : [])] });
    if (ref < 25) fake.seedComment(ref, { body: '<!-- errmeter:outcome status=dispatch-failed watcher=other ts=' + stamp + ' -->' });
  }
  const completed = [];
  const { ctx } = context({ home: f.home, http: request, sink: githubSink,
    dispatch: async (leaseCtx, detail, claim) => {
      completed.push(detail.ref);
      await githubSink.writeOutcome(leaseCtx, detail.ref, { status: 'repaired', watcherId: 'test' });
      await githubSink.releaseClaim(leaseCtx, detail.ref, { watcherId: 'test', claimRef: claim.claimRef });
      return { status: 'repaired' };
    } });
  ctx.config.sink = { repo: 'test/inbox', token: 'short', api_base: fake.url };
  ctx.config.max_api_calls_per_pass = 60;
  ctx.config.watch.escalate_after = 2;
  const first = await tick(ctx, { once: true });
  assert.equal(first.scanned, 25); assert.equal(first.dispatched, 0); assert.equal(first.unscanned, 0);
  assert.equal(first.lookup_incomplete, true); assert.equal(ctx.apiCalls, 54);
  assert.equal(fake.issues[24].labels.some(label => label.name === 'errmeter:claimed'), false);
  const staleDeletes = fake.requests.filter(row => row.method === 'DELETE' &&
    row.url === '/repos/test/inbox/issues/25/labels/errmeter%3Aclaimed');
  assert.equal(staleDeletes.length, 1);
  assert.equal(staleDeletes[0].headers.authorization, 'Bearer ' + ctx.config.sink.token);
  assert.deepEqual(Object.entries(staleDeletes[0].headers)
    .filter(([, value]) => String(value).includes(ctx.config.sink.token)).map(([name]) => name), ['authorization']);
  assert.ok(!staleDeletes[0].url.includes(ctx.config.sink.token));
  assert.ok(!JSON.stringify(staleDeletes[0].body || '').includes(ctx.config.sink.token));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'state', 'scan_cursor.json'))), { ref: 24 });
  const second = await tick(ctx, { once: true });
  assert.equal(second.scanned, 1); assert.equal(second.dispatched, 1); assert.equal(second.lookup_incomplete, false);
  assert.deepEqual(completed, [25]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'state', 'scan_cursor.json'))), { ref: 25 });
  const priorRequests = fake.requests.length;
  const third = await tick(ctx, { once: true });
  assert.equal(third.scanned, 25); assert.equal(third.dispatched, 0); assert.equal(third.lookup_incomplete, false);
  assert.ok(fake.requests.slice(priorRequests).some(row => row.method === 'GET' && row.url === '/repos/test/inbox/issues/1'));
  assert.deepEqual(completed, [25]);
});

test('only one in-scan escalation runs and budget errors stop confirmation silently', async t => {
  const f = fixture(t); const labels = [], alerts = [], reads = [];
  const { ctx } = context({ home: f.home, sink: {
    listOpenFailures: async () => [1, 2, 3].map(ref => ({ ref, labels: [] })),
    getFailure: async (ctx, ref) => { reads.push(ref); return { ref, consecutiveFailures: 2 }; },
    addLabels: async (ctx, ref) => { labels.push(ref); },
    upsertAlert: async (ctx, alert) => { alerts.push(alert.key); return {}; }
  } });
  ctx.config.watch.escalate_after = 2;
  const first = await tick(ctx);
  assert.deepEqual(labels, [1]); assert.deepEqual(alerts, ['needs-human:1']);
  assert.equal(first.pending_remaining, 2); assert.equal(first.scanned, 3);
  reads.length = 0;
  ctx.sink.upsertAlert = async () => { throw Object.assign(new Error('budget'), { code: 'EAPI_BUDGET' }); };
  const second = await tick(ctx);
  assert.deepEqual(reads, [1]);
  assert.equal(second.lookup_incomplete, true); assert.deepEqual(second.errors, []);
  assert.equal(second.scanned, 1); assert.equal(second.unscanned, 2);
});

test('a failed escalation label and pending alert count as one remaining item', async () => {
  const { ctx } = context({ sink: {
    listOpenFailures: async () => [{ ref: 1, labels: [] }],
    getFailure: async () => ({ ref: 1, labels: [], consecutiveFailures: 2 }),
    addLabels: async () => { throw new Error('label failed'); },
    upsertAlert: async () => ({ pending: true })
  } });
  ctx.config.watch.escalate_after = 2;
  const result = await tick(ctx);
  assert.equal(result.pending_remaining, 1);
});

test('all label writes can fail while outcome, release, and next-tick escalation reconcile', async t => {
  const f = fixture(t);
  let failLabels = true;
  const fake = await createGithubFake({ now: new Date('2026-09-06T00:02:00.000Z'), onRequest(entry, board) {
    if (failLabels && ['POST', 'DELETE'].includes(entry.method) && /\/labels(?:\/|$)/.test(entry.url)) board.failNext(503);
  } });
  t.after(() => fake.close());
  fake.seedIssue({ body: '<!-- errmeter:failure fp=0123456789abcdef fpv=1 count=1 last=2026-09-06T00:00:00.000Z -->', labels: ['errmeter:failure'] });
  fake.seedComment(1, { body: '<!-- errmeter:outcome status=dispatch-failed watcher=old ts=2026-09-06T00:00:00.000Z -->' });
  fake.seedComment(1, { body: '<!-- errmeter:occurrence count=1 last=2026-09-06T00:01:00.000Z -->' });
  let dispatched;
  const { ctx } = context({ home: f.home, http: request, sink: githubSink,
    dispatch: async (...args) => { dispatched = await require('../src/dispatch').dispatch(...args); return dispatched; } });
  ctx.config.sink = { repo: 'test/inbox', token: 'short', api_base: fake.url };
  ctx.config.max_api_calls_per_pass = 60;
  Object.assign(ctx.config.watch, { escalate_after: 2, renew_sec: 180, kill_grace_sec: 30,
    dispatch: { command: [process.execPath, '-e', 'process.exit(1)'], timeout_sec: 840, pass_env: [] } });
  const first = await tick(ctx, { once: true });
  assert.equal(first.dispatched, 1); assert.equal(first.dispatch_failed, 1);
  assert.equal(dispatched.labelsFailed, true);
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'state', 'dispatch')), []);
  assert.equal(fake.comments.filter(row => /errmeter:outcome /.test(row.body)).length, 2);
  assert.ok(fake.comments.some(row => /errmeter:release watcher=test /.test(row.body)));
  assert.equal((await githubSink.getFailure({ ...ctx, apiCalls: 0 }, 1)).claim, null);
  const alertReads = fake.requests.filter(row => row.method === 'GET' && /labels=errmeter%3Aalert/.test(row.url)).length;
  failLabels = false;
  const second = await tick(ctx, { once: true });
  assert.equal(second.dispatched, 0);
  assert.ok(fake.issues[0].labels.some(label => label.name === 'errmeter:needs-human'));
  assert.ok(fake.requests.filter(row => row.method === 'GET' && /labels=errmeter%3Aalert/.test(row.url)).length > alertReads);
  assert.equal(fake.comments.filter(row => /errmeter:outcome /.test(row.body)).length, 2);
});

test('a successful in-dispatch escalation retry clears the repaired label failure', async t => {
  const f = fixture(t); let escalationFailures = 2; let dispatched;
  const fake = await createGithubFake({ now: new Date('2026-09-06T00:02:00.000Z'), onRequest(entry, board) {
    if (escalationFailures > 0 && entry.method === 'POST' && /\/labels$/.test(entry.url) &&
        entry.body?.labels?.includes('errmeter:needs-human')) {
      escalationFailures--;
      board.failNext(503);
    }
  } });
  t.after(() => fake.close());
  fake.seedIssue({ body: '<!-- errmeter:failure fp=0123456789abcdef fpv=1 count=1 last=2026-09-06T00:00:00.000Z -->', labels: ['errmeter:failure'] });
  fake.seedComment(1, { body: '<!-- errmeter:outcome status=dispatch-failed watcher=old ts=2026-09-06T00:00:00.000Z -->' });
  fake.seedComment(1, { body: '<!-- errmeter:occurrence count=1 last=2026-09-06T00:01:00.000Z -->' });
  const { ctx } = context({ home: f.home, http: request, sink: githubSink,
    dispatch: async (...args) => { dispatched = await require('../src/dispatch').dispatch(...args); return dispatched; } });
  ctx.config.sink = { repo: 'test/inbox', token: 'short', api_base: fake.url };
  ctx.config.max_api_calls_per_pass = 60;
  Object.assign(ctx.config.watch, { escalate_after: 2, renew_sec: 180, kill_grace_sec: 30,
    dispatch: { command: [process.execPath, '-e', 'process.exit(1)'], timeout_sec: 840, pass_env: [] } });
  const result = await tick(ctx, { once: true });
  assert.equal(result.dispatched, 1); assert.equal(result.dispatch_failed, 1);
  assert.equal(escalationFailures, 0);
  assert.equal(dispatched.labelsFailed, undefined);
  assert.ok(fake.issues[0].labels.some(label => label.name === 'errmeter:needs-human'));
});

test('watch once JSON exits zero for an unscanned quiescent backlog', async t => {
  const f = fixture(t, { watch: { watcher_id: 'test', dispatch: { command: ['node', 'repair.js'] } } });
  let stdout = '';
  const code = await watch(['--once', '--json'], f.env, { cleanup: () => {}, emit: () => 0, flush: async () => 0,
    sink: { listOpenFailures: async () => Array.from({ length: 30 }, (_, index) => ({ ref: index + 1, labels: [] })),
      getFailure: async (ctx, ref) => ({ ref, lastOutcome: {}, occurrenceAfterLastOutcome: false }),
      claim: () => assert.fail('ineligible') },
    checkGaps: async () => ({ gaps: 0 }), stdout: line => { stdout += line; }, stderr: () => {} });
  const summary = JSON.parse(stdout);
  assert.equal(code, 0); assert.equal(summary.scanned, 25); assert.equal(summary.unscanned, 5);
  assert.equal(summary.pending_remaining, 0); assert.equal(summary.lookup_incomplete, false);
});

test('confirmed consecutive failures reconcile label and one alert without dispatch', async () => {
  const { ctx } = context(); const calls = [];
  ctx.config.watch.escalate_after = 2;
  ctx.sink = { listOpenFailures: async () => [{ ref: 9, labels: [], detailed: false }],
    getFailure: async () => ({ ref: 9, labels: [], consecutiveFailures: 2 }),
    addLabels: async (ctx, ref, labels) => { calls.push(['labels', ref, labels]); },
    upsertAlert: async (ctx, alert) => { calls.push(['alert', alert.key]); return {}; },
    claim: () => assert.fail('reconciliation must not claim') };
  assert.equal((await tick(ctx, { once: true })).dispatched, 0);
  assert.deepEqual(calls, [['labels', 9, ['errmeter:needs-human']], ['alert', 'needs-human:9']]);
});

test('corrupt heartbeat timestamps fail closed as gaps', async () => {
  const { ctx } = context(); let alerts = 0;
  ctx.sink = { listHeartbeats: async () => [{ agent: 'broken', host: 'test', lastSeen: 'invalid' }],
    upsertAlert: async () => { alerts++; return {}; } };
  assert.equal((await checkGaps(ctx)).gaps, 1);
  assert.equal(alerts, 1);
});

test('watch and internal runner parsers validate flags without changing emit/flush parsing', () => {
  assert.match(require('../src/cli').USAGE.split('\n')[0], /<emit\|flush\|watch>/);
  assert.deepEqual(parseWatch(['--once', '--interval=2', '--role', 'agent-host']), { once: true, interval: 2, role: 'agent-host' });
  for (const args of [['--interval', '0'], ['--role', 'bad'], ['--once=true'], ['--no-flush']]) assert.throws(() => parseWatch(args));
  const run = parseRun(['--deadline-ms', '100', '--deadline-mono-ms=50', '--timeout', '1', '--state', '/tmp/state', '--', 'node', '-e', '']);
  assert.equal(run['deadline-ms'], 100);
  assert.deepEqual(run.command, ['node', '-e', '']);
  assert.throws(() => parseRun(['--timeout', '1']));
});

test('flush and watch configuration default host to the short OS hostname', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({ schema: 1, sink: { type: 'file' }, watch: { role: 'agent-host' } }));
  for (const command of ['flush', 'watch']) {
    const result = require('../src/config').resolveConfig({}, f.env, { command });
    assert.equal(result.config.host, os.hostname().split('.')[0]);
  }
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
  let finish; let dispatches = 0; let dispatchContext; const budgets = [];
  const { ctx } = context();
  const detail = { ref: 1, labels: [], claim: null, lastOutcome: null };
  ctx.sink = {
    listOpenFailures: async ctx => { budgets.push(ctx.apiCalls); ctx.apiCalls = 5; return [detail]; },
    getFailure: async () => detail,
    claim: async () => ({ won: true, claimRef: 1, expiresAt: '2026-09-06T00:15:00Z' })
  };
  ctx.dispatch = async leaseCtx => { dispatchContext = leaseCtx; assert.equal(leaseCtx.apiCalls, 0); leaseCtx.apiCalls = 12; dispatches++; return new Promise(resolve => { finish = resolve; }); };
  assert.equal((await tick(ctx)).dispatched, 1);
  assert.equal(ctx.running.size, 1);
  assert.equal((await tick(ctx)).dispatched, 0);
  assert.equal(dispatches, 1);
  assert.deepEqual(budgets, [0, 0]);
  assert.equal(dispatchContext.apiCalls, 12);
  assert.equal(ctx.apiCalls, 5);
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
  assert.equal(stdout, 'watch: role=agent-host flush=0 eligible=0 claimed=0 dispatched=0 gaps=0 scanned=0 unscanned=0\n');
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

test('tick confirms only ascending candidates up to capacity', async () => {
  const calls = []; const { ctx } = context();
  const records = [10, 2, 5].map(ref => ({ ref, labels: [], lastOutcome: null }));
  ctx.sink = { listOpenFailures: async () => records,
    getFailure: async (ctx, ref) => { calls.push(ref); return records.find(record => record.ref === ref); },
    claim: async () => ({ won: false }) };
  const summary = await tick(ctx, { once: true });
  assert.equal(summary.eligible, 1);
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
