'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { flush } = require('../src/flush');
const { emit } = require('../src/emit');
const { createGithubFake } = require('./fixtures/github-fake');

const epoch = Date.parse('2026-09-05T12:00:00.000Z');
function fixture(t, extra = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-flush-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const config = { schema: 1, host: 'test-host', sink: { type: 'file' }, ...extra };
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  let now = epoch;
  const env = { ERRMETER_HOME: home };
  return { base, home, config, env, setNow(value) { now = value; },
    async run(args = [], io = {}) {
      let stdout = ''; let stderr = '';
      const code = await flush(args, env, { tmpdir: base, clock: () => now,
        sleep: async ms => { now += ms; }, stdout: value => { stdout += value; }, stderr: value => { stderr += value; }, ...io });
      return { code, stdout, stderr };
    } };
}
function write(root, name, value, area = 'pending') {
  const file = path.join(root, 'spool', area, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value) + '\n');
  return file;
}
function event(id, extra = {}) {
  return { schema: 1, id, ts: new Date(epoch).toISOString(), kind: 'error', agent: 'a', host: 'test-host',
    message: 'failure example', fingerprint: '0123456789abcdef', fpv: 1, attempts: 0, emitter: 'errmeter/0.0.0', ...extra };
}
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function rows(home) { return fs.readFileSync(path.join(home, 'board.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); }
function state(f) { return json(path.join(f.home, 'state', 'last_flush.json')); }
function cli(f, args, command = 'flush') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../bin/errmeter.js'), command, ...args], {
      env: { ...f.env, ERRMETER_CONFIG: path.join(f.home, 'config.json'), TMPDIR: f.base, TMP: f.base, TEMP: f.base },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('errmeter CLI exceeded 20 second test timeout'));
    }, 20000);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
function counter(fp = '0123456789abcdef', agent = 'a', message = 'failure') {
  return [fp, fp === '-' ? 0 : 1, agent, 'test-host', new Date(epoch).toISOString(), message].join('\t') + '\n';
}
function snapshot(root) {
  const result = {};
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name); const stat = fs.statSync(file);
      result[path.relative(root, file)] = { mode: stat.mode, mtime: stat.mtimeMs,
        data: stat.isDirectory() ? null : fs.readFileSync(file).toString('base64') };
      if (stat.isDirectory()) visit(file);
    }
  }
  visit(root); return result;
}
const ack = {
  deliverFailureGroup: async (ctx, group) => ({ ref: 1, delivered: group.events.map(ev => ev.id) }),
  deliverHeartbeat: async () => ({ ref: 1 }), listHeartbeats: async () => [],
  listOpenFailures: async () => [], upsertAlert: async () => ({ ref: 1 })
};

test('GitHub flush preserves redacted strings, markers and fenced JSON through create and occurrence writes', async t => {
  const fake = await createGithubFake(); t.after(() => fake.close());
  const f = fixture(t, { sink: { type: 'github-issue', repo: 'test/inbox', api_base: fake.url } });
  f.env.ERRMETER_GITHUB_TOKEN = 'fixture.credential.value';
  const secrets = ['detail', 'message', 'api', 'password', 'short'].map(part => [part, 'secret'].join('-'));
  const variants = [
    { message: 'failure', detail: 'Authorization: Bearer ' + secrets[0] + '\nsecond line' },
    { message: 'Bearer ' + secrets[1] },
    { message: 'api_key=' + secrets[2] },
    { message: 'Authorization: [REDACTED]', detail: 'password="' + secrets[3] + '"\nsecond line', meta: { password: secrets[4] } }
  ];
  for (const [index, fields] of variants.entries()) {
    const original = event('redaction-' + index, fields);
    write(f.home, 'redaction.json', original);
    const result = await f.run(['--json']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(state(f).pending_remaining, 0);
    assert.equal(json(path.join(f.home, 'spool/sent/redaction.json')).id, original.id);
    const body = index === 0 ? fake.issues[0].body : fake.comments.at(-1).body;
    assert.match(body, new RegExp('<!-- errmeter:' + (index === 0 ? 'failure fp=0123456789abcdef fpv=1 ' : 'occurrence ') + 'ids=' + original.id + ' count=1 first=[^\\n]+ -->'));
    const fenced = body.match(/```json\n([\s\S]*?)\n```/);
    assert.ok(fenced);
    const parsed = JSON.parse(fenced[1]);
    const { redact } = require('../src/redact');
    assert.equal(parsed.message, redact(original.message));
    if (original.detail) assert.equal(parsed.detail, redact(original.detail));
    if (original.meta) assert.equal(parsed.meta.password, '[REDACTED]');
    const payloads = JSON.stringify(fake.requests.filter(r => r.body).map(r => r.body));
    for (const secret of secrets) assert.equal(payloads.includes(secret), false);
  }
  assert.equal((await require('../src/sinks/github-issue').getFailure({ home: f.home, config: { sink: { repo: 'test/inbox', api_base: fake.url, token: f.env.ERRMETER_GITHUB_TOKEN } } }, 1)).occurrences, 4);
});

test('malformed counter lines report one error and still drain valid groups', async t => {
  const f = fixture(t);
  write(f.home, 'counters.bad.log', counter() + 'malformed\n' + counter('fedcba9876543210'));
  const result = await f.run(['--json']);
  assert.equal(result.code, 1);
  assert.equal(state(f).errors.length, 1);
  assert.equal(state(f).pending_remaining, 0);
  assert.equal(rows(f.home).length, 2);
  assert.equal(state(f).backoff_until, undefined);
  assert.equal((await f.run()).code, 0);
});

test('file and webhook serialize already-redacted event fields without consuming their JSON structure', async t => {
  for (const type of ['file', 'webhook']) {
    const f = fixture(t, { sink: type === 'file' ? { type } : { type, url: 'https://example.invalid/events' } });
    const secret = ['field', 'credential', 'value'].join('.');
    const original = event('structured-' + type, { message: 'Bearer ' + secret,
      detail: 'Authorization: Bearer ' + secret + '\nsecond line', meta: { password: secret, note: 'api_key=' + secret } });
    write(f.home, 'fields.json', original);
    let posted;
    const result = await f.run([], { http: async request => { posted = JSON.parse(JSON.stringify(request.body)); return { status: 200 }; } });
    assert.equal(result.code, 0, result.stderr);
    const latest = type === 'file' ? rows(f.home)[0].record.latest : posted.events[0];
    assert.equal(latest.message, 'Bearer [REDACTED]');
    assert.equal(latest.detail, 'Authorization: [REDACTED]\nsecond line');
    assert.equal(latest.meta.password, '[REDACTED]');
    assert.equal(latest.meta.note, 'api_key=[REDACTED]');
    assert.equal(JSON.stringify(type === 'file' ? rows(f.home) : posted).includes(secret), false);
    assert.equal(json(path.join(f.home, 'spool/sent/fields.json')).id, original.id);
  }
});

test('an incomplete counter tail remains pending for a later completed write', async t => {
  const f = fixture(t); const source = counter().slice(0, -1);
  const file = write(f.home, 'counters.incomplete.log', source);
  assert.equal((await f.run()).code, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), source);
  assert.match(state(f).errors[0], /incomplete counter line/);
  fs.appendFileSync(file, '\n');
  assert.equal((await f.run()).code, 0);
  assert.equal(rows(f.home).length, 1);
});

test('wholly malformed counter cuts move intact to dead and stop blocking new logs', async t => {
  const f = fixture(t); const source = 'invalid\nmalformed\n';
  write(f.home, 'counters.bad.log', source); write(f.home, 'counters.log', counter());
  assert.equal((await f.run()).code, 1);
  assert.equal(fs.readFileSync(path.join(f.home, 'spool/dead/counters.bad.log'), 'utf8'), source);
  assert.equal(fs.existsSync(path.join(f.home, 'state/cuts/bad.json')), false);
  assert.equal((await f.run()).code, 0);
  assert.equal(rows(f.home).length, 1);
});

test('dry-run accepts a checkpoint without posted and explains unchanged pending exit 1', async t => {
  const f = fixture(t); const source = counter();
  write(f.home, 'counters.recovery.log', source);
  fs.mkdirSync(path.join(f.home, 'state/cuts'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'state/cuts/recovery.json'), JSON.stringify({ k: 0, offset: 0, end: Buffer.byteLength(source) }));
  const before = snapshot(f.home);
  const result = await f.run(['--dry-run']);
  assert.equal(result.code, 1); assert.match(result.stdout, /recovery\.0/);
  assert.match(result.stdout, /Dry-run leaves pending work unchanged \(exit 1\)/);
  assert.deepEqual(snapshot(f.home), before);
});

test('flush usage errors exit 2 without touching home', async t => {
  const f = fixture(t); const before = snapshot(f.home);
  assert.equal((await f.run(['--unknown'])).code, 2);
  assert.equal((await cli(f, ['--unknown'])).code, 2);
  assert.deepEqual(snapshot(f.home), before);
});

test('flush groups oldest first, drains home and fallback, and moves only acknowledged ids', async t => {
  const f = fixture(t); const fallback = path.join(f.base, 'errmeter-spool');
  write(f.home, 'b.json', event('b', { ts: new Date(epoch + 1000).toISOString() }));
  write(f.home, 'a.json', event('a'));
  write(fallback, 'c.json', event('c', { meta: { _spool_fallback: '1' } }));
  const seen = [];
  const result = await f.run(['--json'], { sink: { ...ack, deliverFailureGroup: async (ctx, group) => {
    seen.push(group); return { ref: 1, delivered: ['a', 'c'] };
  } } });
  assert.equal(result.code, 1); assert.deepEqual(seen[0].events.map(ev => ev.id), ['a', 'c', 'b']);
  assert.equal(seen[0].count, 3);
  assert.ok(fs.existsSync(path.join(f.home, 'spool/sent/a.json')));
  assert.ok(fs.existsSync(path.join(fallback, 'spool/sent/c.json')));
  assert.ok(fs.existsSync(path.join(f.home, 'spool/pending/b.json')));
  assert.equal(JSON.parse(result.stdout).pending_remaining, 1);
  assert.equal((await f.run()).code, 0); assert.equal(rows(f.home)[0].record.latest.id, 'b');
});

test('server down retains pending and durable backoff, then resends after restart', async t => {
  const fake = await createGithubFake(); t.after(() => fake.close());
  const f = fixture(t, { sink: { type: 'github-issue', repo: 'test/inbox', api_base: fake.url }, spool: { lock_refresh_sec: 0 } });
  f.env.ERRMETER_GITHUB_TOKEN = ['fixture', 'credential', 'value'].join('.');
  write(f.home, 'a.json', event('a'));
  await fake.close();
  const failed = await f.run(['--json']);
  assert.equal(failed.code, 1); assert.equal(state(f).pending_remaining, 1);
  assert.equal(Date.parse(state(f).backoff_until), epoch + 5000);
  assert.ok(fs.existsSync(path.join(f.home, 'spool/pending/a.json')));
  await fake.start();
  assert.equal((await f.run()).code, 1); assert.equal(fake.requests.length, 0);
  f.setNow(epoch + 5000);
  assert.equal((await f.run()).code, 0);
  assert.equal(fake.issues.filter(issue => issue.labels.some(label => label.name === 'errmeter:failure')).length, 1);
  assert.ok(fs.existsSync(path.join(f.home, 'spool/sent/a.json')));
  assert.equal(state(f).backoff_until, undefined);
});

test('fresh lock is busy exit 1 and silent linger exit 0; stale lock is renamed before acquisition', async t => {
  const f = fixture(t); const file = path.join(f.home, 'spool/flush.lock');
  fs.mkdirSync(path.dirname(file));
  const old = { pid: 1, nonce: 'old', ts: new Date(epoch).toISOString(), host: 'old-host' };
  fs.writeFileSync(file, JSON.stringify(old));
  const originalInode = fs.statSync(file).ino;
  assert.deepEqual(await f.run(), { code: 1, stdout: 'busy\n', stderr: '' });
  assert.deepEqual(await f.run(['--linger']), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(json(file), old);
  f.setNow(epoch + 601000);
  assert.equal((await f.run()).code, 0);
  assert.equal(fs.existsSync(file), false);
  const stale = fs.readdirSync(path.dirname(file)).filter(name => name.startsWith('flush.lock.stale-'));
  assert.equal(stale.length, 1); assert.deepEqual(json(path.join(path.dirname(file), stale[0])), old);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(path.dirname(file), stale[0])).ino, originalInode);
});

test('lock refresh keeps ownership and release preserves a replacement lock', async t => {
  const f = fixture(t, { spool: { lock_refresh_sec: 0 } });
  write(f.home, 'a.json', event('a'));
  const file = path.join(f.home, 'spool/flush.lock');
  const replacement = { nonce: 'replacement', ts: new Date(epoch).toISOString() };
  const result = await f.run([], { sink: { ...ack, deliverFailureGroup: async () => {
    const first = json(file); f.setNow(epoch + 1000);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(json(file).nonce, first.nonce); assert.equal(Date.parse(json(file).ts), epoch + 1000);
    fs.renameSync(file, file + '.test-old'); fs.writeFileSync(file, JSON.stringify(replacement));
    return { ref: 1, delivered: [] };
  } } });
  assert.equal(result.code, 1); assert.deepEqual(json(file), replacement);
});

test('stale tmp files are removed, fresh tmp ignored, invalid JSON and kind go dead', async t => {
  const f = fixture(t);
  const stale = write(f.home, 'old.tmp', 'unfinished'); fs.utimesSync(stale, new Date(epoch - 61000), new Date(epoch - 61000));
  const fresh = write(f.home, 'new.tmp', 'unfinished'); fs.utimesSync(fresh, new Date(epoch), new Date(epoch));
  write(f.home, 'bad.json', '{'); write(f.home, 'kind.json', event('x', { kind: 'unknown' }));
  assert.equal((await f.run()).code, 0);
  assert.equal(fs.existsSync(stale), false); assert.ok(fs.existsSync(fresh));
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'spool/dead')).sort(), ['bad.json', 'kind.json']);
});

test('cut checkpoint precedes first write, fixes end and assigns late bytes to k=1', async t => {
  const f = fixture(t, { spool: { cut_settle_sec: 0 } });
  const first = counter(); const late = counter('fedcba9876543210');
  write(f.home, 'counters.log', first);
  const seen = [];
  assert.equal((await f.run([], { sink: { ...ack, deliverFailureGroup: async (ctx, group) => {
    const [nonce, k] = group.counter.split('.');
    const checkpoint = json(path.join(f.home, 'state/cuts', nonce + '.json'));
    assert.equal(checkpoint.k, Number(k)); assert.deepEqual(checkpoint.posted, []);
    seen.push({ group, checkpoint });
    if (k === '0') {
      assert.equal(checkpoint.end, Buffer.byteLength(first));
      fs.appendFileSync(path.join(f.home, 'spool/pending', 'counters.' + nonce + '.log'), late);
      assert.equal(json(path.join(f.home, 'state/cuts', nonce + '.json')).end, Buffer.byteLength(first));
    } else {
      assert.equal(k, '1'); assert.equal(checkpoint.offset, Buffer.byteLength(first));
      assert.equal(checkpoint.end, Buffer.byteLength(first + late));
    }
    return { ref: 1, delivered: [] };
  } } })).code, 0);
  assert.deepEqual(seen.map(item => item.group.count), [1, 1]);
  assert.deepEqual(seen.map(item => item.group.fingerprint), ['0123456789abcdef', 'fedcba9876543210']);
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'spool/pending')), []);
});

test('counter recovery uses saved end and posted groups, and drains existing cut before new log', async t => {
  const f = fixture(t, { spool: { cut_settle_sec: 0 } });
  const first = counter(); const second = counter('fedcba9876543210');
  write(f.home, 'counters.recover.log', first + second); write(f.home, 'counters.log', first);
  fs.mkdirSync(path.join(f.home, 'state/cuts'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'state/cuts/recover.json'), JSON.stringify({ k: 0, offset: 0, end: Buffer.byteLength(first), posted: ['0123456789abcdef'] }));
  const seen = [];
  assert.equal((await f.run([], { sink: { ...ack, deliverFailureGroup: async (ctx, group) => { seen.push(group); return { ref: 1 }; } } })).code, 1);
  assert.deepEqual(seen.map(group => group.counter), ['recover.1']);
  assert.ok(fs.existsSync(path.join(f.home, 'spool/pending/counters.log')));
  assert.equal((await f.run()).code, 0);
});

test('counter heartbeat sentinel and encoded slash upsert deliver heartbeats, preserving replacement', async t => {
  const f = fixture(t, { spool: { cut_settle_sec: 0 } });
  write(f.home, 'counters.log', counter('-', 'watcher/one', 'kind=heartbeat'));
  const old = event('old', { kind: 'heartbeat', agent: 'watcher/one' });
  const replacement = { ...old, id: 'new', ts: new Date(epoch + 1000).toISOString() };
  const file = write(f.home, 'heartbeat-watcher%2Fone@test-host.json', old);
  const seen = [];
  const result = await f.run([], { sink: { ...ack, deliverFailureGroup: async () => assert.fail('heartbeat became failure'),
    deliverHeartbeat: async (ctx, ev) => { seen.push(ev); if (ev.id === 'old') fs.writeFileSync(file, JSON.stringify(replacement)); return { ref: 1 }; } } });
  assert.equal(result.code, 1); assert.equal(seen.length, 2);
  assert.ok(seen.every(ev => ev.agent === 'watcher/one' && ev.kind === 'heartbeat'));
  assert.equal(seen[1].fingerprint, undefined); assert.equal(seen[1].fpv, undefined);
  assert.deepEqual(json(file), replacement); assert.equal((await f.run()).code, 0);
});

test('overflow marker produces webhook alert and is removed only after acknowledged drain', async t => {
  const f = fixture(t, { sink: { type: 'webhook', url: 'https://example.invalid/hook' } });
  const file = write(f.home, 'overflow-exceeded.json', { since: new Date(epoch).toISOString() });
  const requests = [];
  assert.equal((await f.run([], { http: async request => { requests.push(request); return { status: 204 }; } })).code, 0);
  assert.equal(requests[0].body.alert.key, 'spool-overflow:test-host');
  assert.equal(fs.existsSync(file), false);
});

test('dry-run reads target refs but touches no lock, spool, checkpoint, cache or log', async t => {
  const f = fixture(t, { spool: { cut_settle_sec: 0 } });
  write(f.home, 'a.json', event('a')); assert.equal((await f.run()).code, 0);
  write(f.home, 'b.json', event('b')); write(f.home, 'counters.log', counter());
  write(f.home, 'stale.tmp', 'unfinished');
  const before = snapshot(f.home);
  const result = await f.run(['--dry-run', '--json']);
  assert.equal(result.code, 1); assert.deepEqual(snapshot(f.home), before);
  const writes = JSON.parse(result.stdout).writes;
  assert.ok(writes.some(row => row.op === 'failure' && row.target === 1));
  assert.ok(writes.some(row => row.counter === 'next-cut.0'));
});

test('0644 token and invalid config return exit 3 before touching spool', async t => {
  if (process.platform === 'win32') return; // POSIX permissions; Windows ACL policy is covered below.
  const f = fixture(t, { sink: { type: 'github-issue', repo: 'test/inbox' } });
  const tokenFile = path.join(f.base, 'credential'); fs.writeFileSync(tokenFile, 'fixture.credential.value', { mode: 0o644 }); fs.chmodSync(tokenFile, 0o644);
  f.config.sink.token_file = tokenFile; fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(f.config));
  const before = snapshot(f.home); const result = await f.run();
  assert.equal(result.code, 3); assert.match(result.stderr, /EPERM_TOKEN_FILE_MODE/); assert.deepEqual(snapshot(f.home), before);
  fs.writeFileSync(path.join(f.home, 'config.json'), '{'); assert.equal((await f.run()).code, 3);
});

test('emit and flush never persist or print a constructed credential, including failure diagnostics', async t => {
  const f = fixture(t); const credential = ['gh', 'p_', 'z'.repeat(27)].join('');
  f.env.ERRMETER_GITHUB_TOKEN = credential;
  let output = '';
  assert.equal(emit(['--message', 'failed ' + credential, '--no-flush'], f.env, { stdout: value => { output += value; }, stderr: value => { output += value; } }), 0);
  const result = await f.run(['--json'], { sink: { ...ack, deliverFailureGroup: async (ctx, group) => {
    assert.equal(JSON.stringify(group).includes(credential), false);
    throw new Error('request rejected ' + credential);
  } } });
  assert.equal(result.code, 1); output += result.stdout + result.stderr;
  assert.equal(output.includes(credential), false);
  for (const value of Object.values(snapshot(f.home))) if (value.data !== null) assert.equal(Buffer.from(value.data, 'base64').toString().includes(credential), false);
  assert.match(fs.readFileSync(path.join(f.home, 'errmeter.log'), 'utf8'), /REDACTED/);
  assert.equal(state(f).pending_remaining, 1);
});

test('flush re-redacts old events before egress without rewriting their contents', async t => {
  const f = fixture(t); const credential = ['historical', 'credential', 'material'].join('.');
  f.env.ERRMETER_GITHUB_TOKEN = credential;
  const file = write(f.home, 'a.json', event('a', { message: credential, task: credential, detail: credential, meta: { value: credential, password: 'short' } }));
  let delivered;
  await f.run([], { sink: { ...ack, deliverFailureGroup: async (ctx, group) => {
    delivered = group.events;
    return { delivered: [] };
  } } });
  assert.ok(delivered); assert.equal(JSON.stringify(delivered).includes(credential), false);
  assert.equal(delivered[0].meta.password, '[REDACTED]');
  assert.equal(json(file).message, credential);
});

test('linger retries with backoff while holding lock and returns success after recovery', async t => {
  const f = fixture(t); write(f.home, 'a.json', event('a')); let calls = 0;
  const result = await f.run(['--linger'], { sink: { ...ack, deliverFailureGroup: async (ctx, group) => {
    assert.ok(fs.existsSync(path.join(f.home, 'spool/flush.lock')));
    if (++calls === 1) throw Object.assign(new Error('temporary failure'), { status: 503 });
    return { ref: 1, delivered: group.events.map(ev => ev.id) };
  } } });
  assert.equal(result.code, 0); assert.equal(calls, 2); assert.equal(state(f).pending_remaining, 0);
  assert.equal(fs.existsSync(path.join(f.home, 'spool/flush.lock')), false);
});

test('rate-limit delay is durable and linger does not sleep beyond its deadline', async t => {
  const f = fixture(t, { spool: { flush_linger_sec: 10 } }); write(f.home, 'a.json', event('a'));
  const result = await f.run(['--linger'], { sleep: async () => assert.fail('must not sleep beyond linger'), sink: { ...ack,
    deliverFailureGroup: async () => { throw Object.assign(new Error('rate limited'), { status: 429, headers: { 'retry-after': '90' } }); } } });
  assert.equal(result.code, 1); assert.equal(Date.parse(state(f).backoff_until), epoch + 90000);
});

test('retention prunes sent/dead by age and bytes while preserving pending', async t => {
  const f = fixture(t, { spool: { sent_max_bytes: 5, dead_max_bytes: 5, sent_retention_days: 1, dead_retention_days: 1, max_events_per_pass: 0 } });
  for (const area of ['sent', 'dead']) {
    const old = write(f.home, 'old', 'old', area); fs.utimesSync(old, new Date(epoch - 172800000), new Date(epoch - 172800000));
    const middle = write(f.home, 'middle', '12345', area); fs.utimesSync(middle, new Date(epoch - 1000), new Date(epoch - 1000));
    write(f.home, 'new', '12345', area);
  }
  const pending = write(f.home, 'a.json', event('a'));
  assert.equal((await f.run()).code, 1); assert.ok(fs.existsSync(pending));
  for (const area of ['sent', 'dead']) assert.deepEqual(fs.readdirSync(path.join(f.home, 'spool', area)), ['new']);
});

test('dead-man alerts only a nonempty fully-known all-stale watcher set using board time', async t => {
  const f = fixture(t); const alerts = [];
  for (const [records, incomplete, expected] of [
    [[], false, 0], [[{ role: 'agent-host', lastSeen: new Date(0).toISOString() }], false, 0],
    [[{ role: 'watcher', lastSeen: new Date(epoch).toISOString() }], false, 0],
    [[{ role: 'watcher', lastSeen: new Date(0).toISOString() }], true, 0],
    [[{ role: 'watcher', lastSeen: new Date(0).toISOString() }], false, 1]
  ]) {
    alerts.length = 0;
    await f.run([], { sink: { ...ack, listHeartbeats: async ctx => { ctx.lookup_incomplete = incomplete; ctx.boardTime = new Date(epoch).toISOString(); return records; },
      upsertAlert: async (ctx, alert) => { alerts.push(alert); return { ref: 1 }; } } });
    assert.equal(alerts.length, expected); if (expected) assert.equal(alerts[0].key, 'all-watchers-silent');
  }
});

test('higher schema retains unknown fields and GitHub note; transport failure keeps it pending', async t => {
  const fake = await createGithubFake(); t.after(() => fake.close());
  const f = fixture(t, { sink: { type: 'github-issue', repo: 'test/inbox', api_base: fake.url } });
  f.env.ERRMETER_GITHUB_TOKEN = 'fixture.credential.value';
  const ev = event('future', { schema: 2, future: { field: ['retained'] } });
  write(f.home, 'future.json', ev);
  fake.setFailure(503); assert.equal((await f.run()).code, 1);
  assert.ok(fs.existsSync(path.join(f.home, 'spool/pending/future.json')));
  fake.setFailure(null); f.setNow(epoch + 10000);
  assert.equal((await f.run()).code, 0);
  assert.match(fake.issues[0].body, /Newer event schema; delivered verbatim/);
  assert.match(fake.issues[0].body, /"retained"/);
});

test('only unprocessable higher schemas go dead after a rejected delivery', async t => {
  const f = fixture(t);
  write(f.home, 'current.json', event('current'));
  write(f.home, 'future.json', event('future', { schema: 2 }));
  write(f.home, 'heartbeat-a@test-host.json', event('future-heartbeat', { schema: 2, kind: 'heartbeat' }));
  const reject = async () => { throw Object.assign(new Error('unprocessable payload'), { status: 422 }); };
  await f.run([], { sink: { ...ack, deliverFailureGroup: reject, deliverHeartbeat: reject } });
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'spool/dead')).sort(), ['future.json', 'heartbeat-a@test-host.json']);
  assert.ok(fs.existsSync(path.join(f.home, 'spool/pending/current.json')));
});

test('event pass limit is sorted, and counters follow event delivery', async t => {
  const f = fixture(t, { spool: { max_events_per_pass: 1, cut_settle_sec: 0 } });
  write(f.home, 'b.json', event('b')); write(f.home, 'a.json', event('a')); write(f.home, 'counters.log', counter());
  const order = [];
  assert.equal((await f.run([], { sink: { ...ack, deliverFailureGroup: async (ctx, group) => {
    order.push(group.counter ? 'counter' : group.events[0].id); return { ref: 1, delivered: group.events.map(ev => ev.id) };
  } } })).code, 1);
  assert.deepEqual(order, ['a', 'counter']);
  assert.ok(fs.existsSync(path.join(f.home, 'spool/pending/b.json')));
});

test('counter failure retains cut and checkpoint for retry without cutting new log', async t => {
  const f = fixture(t, { spool: { cut_settle_sec: 0 } });
  write(f.home, 'counters.log', counter());
  await f.run([], { sink: { ...ack, deliverFailureGroup: async () => { throw Object.assign(new Error('down'), { status: 503 }); } } });
  const cut = fs.readdirSync(path.join(f.home, 'spool/pending'))[0];
  assert.match(cut, /^counters\..+\.log$/);
  const checkpoint = json(path.join(f.home, 'state/cuts', cut.slice(9, -4) + '.json'));
  assert.deepEqual(checkpoint.posted, []); assert.equal(checkpoint.end, Buffer.byteLength(counter()));
  write(f.home, 'counters.log', counter()); f.setNow(epoch + 5000);
  assert.equal((await f.run()).code, 1); assert.ok(fs.existsSync(path.join(f.home, 'spool/pending/counters.log')));
  assert.equal((await f.run()).code, 0);
});

test('quiet suppresses stdout/stderr while log rotation preserves redacted diagnostics', async t => {
  const f = fixture(t, { spool: { log_max_bytes: 20 } });
  write(f.home, 'a.json', event('a')); fs.writeFileSync(path.join(f.home, 'errmeter.log'), 'previous diagnostic\n');
  const result = await f.run(['--quiet'], { sink: { ...ack, deliverFailureGroup: async () => { throw new Error('temporary failure'); } } });
  assert.deepEqual(result, { code: 1, stdout: '', stderr: '' });
  assert.equal(fs.readFileSync(path.join(f.home, 'errmeter.log.1'), 'utf8'), 'previous diagnostic\n');
  assert.equal(fs.readFileSync(path.join(f.home, 'errmeter.log'), 'utf8'), 'temporary failure\n');
});

test('dry-run against GitHub makes only reads and leaves home byte-for-byte unchanged', async t => {
  const fake = await createGithubFake(); t.after(() => fake.close());
  const f = fixture(t, { sink: { type: 'github-issue', repo: 'test/inbox', api_base: fake.url } });
  f.env.ERRMETER_GITHUB_TOKEN = 'fixture.credential.value'; write(f.home, 'a.json', event('a'));
  const before = snapshot(f.home); const result = await f.run(['--dry-run', '--json']);
  assert.equal(result.code, 1); assert.ok(fake.requests.length > 0);
  assert.ok(fake.requests.every(request => request.method === 'GET')); assert.deepEqual(snapshot(f.home), before);
});

test('real CLI retries a restarted GitHub server and never exposes a constructed credential', async t => {
  const fake = await createGithubFake(); t.after(() => fake.close());
  const f = fixture(t, { sink: { type: 'github-issue', repo: 'test/inbox', api_base: fake.url } });
  const credential = ['gh', 'p_', 'q'.repeat(27)].join(''); f.env.ERRMETER_GITHUB_TOKEN = credential;
  const emitted = await cli(f, ['--message', 'failure ' + credential, '--no-flush', '--json'], 'emit');
  assert.equal(emitted.code, 0);
  const names = fs.readdirSync(path.join(f.home, 'spool/pending')); assert.equal(names.length, 1);
  await fake.close();
  const failed = await cli(f, ['--json']); assert.equal(failed.code, 1);
  assert.equal(state(f).pending_remaining, 1); assert.ok(state(f).backoff_until);
  assert.ok(state(f).errors.length > 0);
  assert.equal(JSON.stringify(state(f)).includes(credential), false);
  assert.ok(state(f).errors.every(message => typeof message === 'string' && !message.includes(credential)));
  assert.ok(fs.existsSync(path.join(f.home, 'spool/pending', names[0])));
  await fake.start();
  // Respect the persisted retry deadline in the actual process, without mocking time.
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(state(f).backoff_until) - Date.now()) + 20));
  const resent = await cli(f, ['--json']); assert.equal(resent.code, 0);
  assert.equal(JSON.parse(resent.stdout).pending_remaining, 0);
  assert.ok(fs.existsSync(path.join(f.home, 'spool/sent', names[0])));
  assert.equal(fake.issues.filter(issue => issue.labels.some(label => label.name === 'errmeter:failure')).length, 1);
  for (const result of [emitted, failed, resent]) assert.equal((result.stdout + result.stderr).includes(credential), false);
  for (const value of Object.values(snapshot(f.home))) if (value.data !== null) assert.equal(Buffer.from(value.data, 'base64').toString().includes(credential), false);
});

test('real CLI enforces busy, silent linger and mutation-free dry-run against GitHub', async t => {
  const fake = await createGithubFake(); t.after(() => fake.close());
  const f = fixture(t, { sink: { type: 'github-issue', repo: 'test/inbox', api_base: fake.url } });
  f.env.ERRMETER_GITHUB_TOKEN = 'fixture.credential.value'; write(f.home, 'a.json', event('a'));
  const lock = path.join(f.home, 'spool/flush.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'busy', ts: new Date().toISOString(), host: 'test-host' }));
  assert.deepEqual(await cli(f, []), { code: 1, stdout: 'busy\n', stderr: '' });
  assert.deepEqual(await cli(f, ['--linger']), { code: 0, stdout: '', stderr: '' });
  const before = snapshot(f.home); const dry = await cli(f, ['--dry-run', '--json']);
  assert.equal(dry.code, 1); assert.ok(JSON.parse(dry.stdout).writes.length);
  assert.deepEqual(snapshot(f.home), before); assert.ok(fake.requests.every(request => request.method === 'GET'));
});

test('real CLI refuses a 0644 token with exit 3 and no home mutations or credential output', async t => {
  if (process.platform === 'win32') return; // POSIX permissions; Windows ACL policy is covered below.
  const f = fixture(t, { sink: { type: 'github-issue', repo: 'test/inbox' } });
  const credential = ['private', 'fixture', 'material'].join('.');
  const tokenFile = path.join(f.base, 'credential');
  fs.writeFileSync(tokenFile, credential); fs.chmodSync(tokenFile, 0o644);
  f.config.sink.token_file = tokenFile; fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(f.config));
  const before = snapshot(f.home); const result = await cli(f, ['--json']);
  assert.equal(result.code, 3); assert.match(result.stderr, /EPERM_TOKEN_FILE_MODE/);
  assert.equal((result.stdout + result.stderr).includes(credential), false); assert.deepEqual(snapshot(f.home), before);
});

test('permanently rejected future events finish successfully without transport backoff', async t => {
  const f = fixture(t);
  write(f.home, 'future.json', event('future', { schema: 2 }));
  write(f.home, 'heartbeat-a@test-host.json', event('future-heartbeat', { schema: 2, kind: 'heartbeat' }));
  const reject = async () => { throw Object.assign(new Error('unprocessable payload'), { status: 422 }); };
  const result = await f.run(['--json'], { sink: { ...ack, deliverFailureGroup: reject, deliverHeartbeat: reject } });
  assert.equal(result.code, 0); assert.equal(state(f).pending_remaining, 0);
  assert.equal(state(f).backoff_until, undefined); assert.deepEqual(state(f).errors, []);
  assert.equal(fs.readdirSync(path.join(f.home, 'spool/dead')).length, 2);
});

test('Windows config uses profile ACL warning instead of rejecting POSIX mode bits', t => {
  const f = fixture(t, { sink: { type: 'github-issue', repo: 'test/inbox' } });
  const tokenFile = path.join(f.base, 'credential');
  fs.writeFileSync(tokenFile, 'fixture.credential.value'); fs.chmodSync(tokenFile, 0o644);
  f.config.sink.token_file = tokenFile; fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(f.config));
  // Force a fresh module instance to verify the process-once warning on any host OS.
  const modulePath = require.resolve('../src/config'); const loaded = require.cache[modulePath];
  delete require.cache[modulePath];
  try {
    const windowsConfig = require('../src/config').resolveConfig;
    const result = windowsConfig({}, f.env, { command: 'flush', platform: 'win32' });
    assert.match(result.warning, /Windows.*profile ACL/);
    assert.equal(result.config.sink.token, 'fixture.credential.value');
    assert.equal(windowsConfig({}, f.env, { command: 'flush', platform: 'win32' }).warning, undefined);
  } finally { require.cache[modulePath] = loaded; }
});

test('overflow marker remains at half ceiling or without a successful alert acknowledgement', async t => {
  for (const scenario of ['half', 'pending', 'failed']) {
    const line = counter();
    const f = fixture(t, { spool: { cut_settle_sec: 0, overflow_max_bytes: Buffer.byteLength(line) * (scenario === 'half' ? 2 : 4) } });
    write(f.home, 'counters.log', line);
    const marker = write(f.home, 'overflow-exceeded.json', { since: new Date(epoch).toISOString() });
    let alerts = 0;
    const result = await f.run([], { sink: { ...ack, deliverFailureGroup: async () => ({ pending: true }),
      upsertAlert: async () => {
        alerts++;
        if (scenario === 'failed') throw Object.assign(new Error('alert unavailable'), { status: 503 });
        return scenario === 'pending' ? { pending: true } : { ref: 1 };
      } } });
    assert.equal(result.code, 1); assert.equal(alerts, 1); assert.ok(fs.existsSync(marker), scenario);
  }
});

test('real CLI steals stale lock by rename, cleans stale tmp and delivers encoded and counter heartbeats plus overflow', async t => {
  const fake = await createGithubFake(); t.after(() => fake.close());
  const f = fixture(t, { sink: { type: 'github-issue', repo: 'test/inbox', api_base: fake.url }, spool: { cut_settle_sec: 0 } });
  f.env.ERRMETER_GITHUB_TOKEN = 'fixture.credential.value';
  write(f.home, 'heartbeat-watcher%2Fone@test-host.json', event('upsert', { kind: 'heartbeat', agent: 'watcher/one' }));
  write(f.home, 'counters.log', counter('-', 'watcher/overflow', 'kind=heartbeat'));
  write(f.home, 'overflow-exceeded.json', { since: new Date().toISOString() });
  const staleTmp = write(f.home, 'stale.tmp', 'unfinished');
  fs.utimesSync(staleTmp, new Date(Date.now() - 61000), new Date(Date.now() - 61000));
  const freshTmp = write(f.home, 'fresh.tmp', 'unfinished');
  const lock = path.join(f.home, 'spool/flush.lock');
  const old = { nonce: 'stale-cli', pid: 1, host: 'old-host', ts: new Date(Date.now() - 601000).toISOString() };
  fs.writeFileSync(lock, JSON.stringify(old)); const inode = fs.statSync(lock).ino;
  const result = await cli(f, ['--json']); assert.equal(result.code, 0);
  const artifacts = fs.readdirSync(path.dirname(lock)).filter(name => name.startsWith('flush.lock.stale-'));
  assert.equal(artifacts.length, 1);
  const stolen = path.join(path.dirname(lock), artifacts[0]); assert.deepEqual(json(stolen), old);
  if (process.platform !== 'win32') assert.equal(fs.statSync(stolen).ino, inode);
  assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(staleTmp), false); assert.ok(fs.existsSync(freshTmp));
  assert.ok(fs.existsSync(path.join(f.home, 'spool/sent/heartbeat-watcher%2Fone@test-host.json')));
  const heartbeats = fake.issues.filter(issue => issue.labels.some(label => label.name === 'errmeter:heartbeat'));
  assert.equal(heartbeats.length, 2);
  assert.ok(heartbeats.some(issue => issue.body.includes('agent=watcher/one')));
  assert.ok(heartbeats.some(issue => issue.body.includes('agent=watcher/overflow')));
  assert.ok(fake.issues.some(issue => issue.body.includes('key=spool-overflow:test-host')));
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'spool/pending')), ['fresh.tmp']);
});

test('real CLI persists counter checkpoint before POST and posts late bytes under k=1', async t => {
  let f; let nonce; const writes = []; const line = counter();
  const fake = await createGithubFake({ onRequest(request) {
    if (request.method !== 'POST' || !/errmeter:(failure|occurrence)/.test(request.body?.body || '')) return;
    const cuts = fs.readdirSync(path.join(f.home, 'spool/pending')).filter(name => /^counters\..+\.log$/.test(name));
    assert.equal(cuts.length, 1); nonce = cuts[0].slice(9, -4);
    const checkpoint = json(path.join(f.home, 'state/cuts', nonce + '.json'));
    assert.deepEqual(checkpoint.posted, []);
    assert.equal(checkpoint.k, writes.length);
    assert.match(request.body.body, new RegExp('counter_ref=' + nonce.replace(/\./g, '\\.') + '\\.' + checkpoint.k));
    writes.push(checkpoint);
    if (checkpoint.k === 0) {
      assert.equal(checkpoint.offset, 0); assert.equal(checkpoint.end, Buffer.byteLength(line));
      fs.appendFileSync(path.join(f.home, 'spool/pending', cuts[0]), line);
      assert.equal(json(path.join(f.home, 'state/cuts', nonce + '.json')).end, Buffer.byteLength(line));
    } else {
      assert.equal(checkpoint.offset, Buffer.byteLength(line)); assert.equal(checkpoint.end, Buffer.byteLength(line) * 2);
    }
  } });
  t.after(() => fake.close());
  f = fixture(t, { sink: { type: 'github-issue', repo: 'test/inbox', api_base: fake.url }, spool: { cut_settle_sec: 0 } });
  f.env.ERRMETER_GITHUB_TOKEN = 'fixture.credential.value'; write(f.home, 'counters.log', line);
  assert.equal((await cli(f, ['--json'])).code, 0); assert.equal(writes.length, 2);
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'spool/pending')), []);
  assert.equal(fs.existsSync(path.join(f.home, 'state/cuts', nonce + '.json')), false);
});

test('delivery attempts are durable before network work and preserve unknown fields across retries', async t => {
  const f = fixture(t); const original = event('attempt', { extension: { untouched: ['value'] } });
  const file = write(f.home, 'a.json', original); let calls = 0;
  const sink = { ...ack, deliverFailureGroup: async (ctx, group) => {
    calls++;
    assert.equal(group.events[0].attempts, calls);
    assert.deepEqual(json(file), { ...original, attempts: calls });
    if (calls === 1) throw Object.assign(new Error('down'), { status: 503 });
    return { ref: 1, delivered: ['attempt'] };
  } };
  assert.equal((await f.run([], { sink })).code, 1); assert.equal(json(file).attempts, 1);
  f.setNow(epoch + 5000); assert.equal((await f.run([], { sink })).code, 0);
  assert.equal(json(path.join(f.home, 'spool/sent/a.json')).attempts, 2);
});

test('SIGTERM retains lock through in-flight delivery and excludes a second flush', async t => {
  const f = fixture(t); write(f.home, 'a.json', event('signal')); let returned = false;
  const lock = path.join(f.home, 'spool/flush.lock');
  const result = await f.run([], { sink: { ...ack, deliverFailureGroup: async () => {
    process.emit('SIGTERM');
    assert.ok(fs.existsSync(lock), 'signal must not release an in-flight operation');
    assert.deepEqual(await f.run(), { code: 1, stdout: 'busy\n', stderr: '' });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(fs.existsSync(lock)); returned = true;
    return { ref: 1, delivered: ['signal'] };
  } } });
  assert.equal(result.code, 1); assert.equal(returned, true); assert.equal(fs.existsSync(lock), false);
  assert.equal((await f.run()).code, 0);
});

test('heartbeat replacement at the compare-to-rename window remains undelivered pending', async t => {
  const f = fixture(t); const name = 'heartbeat-watcher%2Fone@test-host.json';
  const old = event('old-window', { kind: 'heartbeat', agent: 'watcher/one' });
  const replacement = { ...old, id: 'replacement-window', ts: new Date(epoch + 1000).toISOString() };
  const canonical = write(f.home, name, old);
  const rename = fs.renameSync; let injected = false;
  fs.renameSync = function (source, target) {
    if (path.dirname(target) === path.join(f.home, 'spool/sent') && !injected) {
      injected = true; fs.writeFileSync(canonical, JSON.stringify(replacement));
    }
    return rename.apply(this, arguments);
  };
  let result;
  try { result = await f.run([], { sink: ack }); } finally { fs.renameSync = rename; }
  assert.equal(injected, true); assert.equal(result.code, 1);
  assert.deepEqual(json(canonical), replacement);
  assert.equal(json(path.join(f.home, 'spool/sent', name)).id, old.id);
  assert.equal((await f.run()).code, 0);
});

test('claimed heartbeat remains enumerable after failed delivery and retries to canonical sent name', async t => {
  const f = fixture(t); const name = 'heartbeat-watcher%2Fone@test-host.json';
  write(f.home, name, event('claimed', { kind: 'heartbeat', agent: 'watcher/one' }));
  assert.equal((await f.run([], { sink: { ...ack, deliverHeartbeat: async () => { throw Object.assign(new Error('down'), { status: 503 }); } } })).code, 1);
  const names = fs.readdirSync(path.join(f.home, 'spool/pending'));
  assert.equal(names.length, 1); assert.match(names[0], /^heartbeat-claimed-[a-f0-9-]+\.json$/);
  assert.equal(json(path.join(f.home, 'spool/pending', names[0])).attempts, 1);
  f.setNow(epoch + 5000); assert.equal((await f.run([], { sink: ack })).code, 0);
  assert.equal(json(path.join(f.home, 'spool/sent', name)).attempts, 2);
});

test('separate flush invocations preserve exponential retry delay across a skipped tick', async t => {
  const f = fixture(t, { spool: { lock_refresh_sec: 0 } }); write(f.home, 'a.json', event('backoff')); let calls = 0;
  const sink = { ...ack, deliverFailureGroup: async () => { calls++; throw Object.assign(new Error('down'), { status: 503 }); } };
  await f.run([], { sink }); assert.equal(Date.parse(state(f).backoff_until), epoch + 5000);
  f.setNow(epoch + 2000); await f.run([], { sink }); assert.equal(calls, 1);
  f.setNow(epoch + 5000); await f.run([], { sink }); assert.equal(calls, 2);
  assert.equal(Date.parse(state(f).backoff_until), epoch + 15000);
});

test('dry-run applies the global event cap across roots while retaining counter writes', async t => {
  const f = fixture(t, { spool: { max_events_per_pass: 1, cut_settle_sec: 0 } });
  write(f.home, 'a.json', event('a'));
  write(path.join(f.base, 'errmeter-spool'), 'b.json', event('b', { fingerprint: 'fedcba9876543210' }));
  write(f.home, 'counters.log', counter());
  const result = await f.run(['--dry-run', '--json']); const writes = JSON.parse(result.stdout).writes;
  assert.equal(writes.filter(row => row.op === 'failure' && !row.counter).length, 1);
  assert.ok(writes.some(row => row.counter));
  assert.equal(writes.some(row => row.fingerprint === 'fedcba9876543210'), false);
});

test('heartbeat hosts ending in the former claimed suffix retain their exact canonical sent name', async t => {
  const f = fixture(t);
  const host = 'host.claimed-12345678-1234-4234-8234-123456789abc';
  const name = 'heartbeat-a@' + host + '.json';
  write(f.home, name, event('suffix-host', { kind: 'heartbeat', agent: 'a', host }));
  assert.equal((await f.run([], { sink: ack })).code, 0);
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'spool/sent')), [name]);
});

test('near-NAME_MAX heartbeat names use short staging names for delivery and retry', async t => {
  const f = fixture(t);
  const agent = 'a' + '/'.repeat(59); const host = 'h'.repeat(60);
  const name = 'heartbeat-' + encodeURIComponent(agent) + '@' + host + '.json';
  assert.equal(Buffer.byteLength(name), 254);
  write(f.home, name, event('long-heartbeat', { kind: 'heartbeat', agent, host }));
  const first = await f.run([], { sink: { ...ack, deliverHeartbeat: async () => { throw Object.assign(new Error('down'), { status: 503 }); } } });
  assert.equal(first.code, 1);
  const pending = fs.readdirSync(path.join(f.home, 'spool/pending'));
  assert.equal(pending.length, 1); assert.match(pending[0], /^heartbeat-claimed-[a-f0-9-]+\.json$/);
  f.setNow(epoch + 5000); assert.equal((await f.run([], { sink: ack })).code, 0);
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'spool/sent')), [name]);
});

test('heartbeat claim ENOENT leaves that upsert retryable without blocking another group', async t => {
  const f = fixture(t); write(f.home, 'a.json', event('other-group'));
  const name = 'heartbeat-a@test-host.json';
  const heartbeat = write(f.home, name, event('rename-window', { kind: 'heartbeat' }));
  const rename = fs.renameSync; let injected = false;
  fs.renameSync = function (source, target) {
    if (source === heartbeat && !injected) {
      injected = true;
      throw Object.assign(new Error('emitter replacement window'), { code: 'ENOENT' });
    }
    return rename.apply(this, arguments);
  };
  let result;
  try { result = await f.run([], { sink: ack }); } finally { fs.renameSync = rename; }
  assert.equal(result.code, 1); assert.equal(injected, true);
  assert.ok(fs.existsSync(path.join(f.home, 'spool/sent/a.json')));
  assert.ok(fs.existsSync(heartbeat)); assert.equal(json(heartbeat).attempts, 0);
  assert.equal((await f.run([], { sink: ack })).code, 0);
  assert.equal(json(path.join(f.home, 'spool/sent', name)).attempts, 1);
});

test('failed heartbeat passes retain only the newest claim until delivery succeeds', async t => {
  const f = fixture(t); const name = 'heartbeat-a@test-host.json'; const called = [];
  const sink = { ...ack, deliverHeartbeat: async (ctx, ev) => { called.push(ev.id); throw Object.assign(new Error('down'), { status: 503 }); } };
  for (let i = 0; i < 3; i++) {
    f.setNow(epoch + i * 100000);
    write(f.home, name, event('heartbeat-' + i, { kind: 'heartbeat', ts: new Date(epoch + i * 1000).toISOString() }));
    assert.equal((await f.run([], { sink })).code, 1);
    const pending = fs.readdirSync(path.join(f.home, 'spool/pending'));
    assert.equal(pending.length, 1);
    assert.match(pending[0], /^heartbeat-claimed-[a-f0-9-]+\.json$/);
    assert.equal(json(path.join(f.home, 'spool/pending', pending[0])).id, 'heartbeat-' + i);
    assert.equal(fs.existsSync(path.join(f.home, 'spool/sent', name)), false);
    assert.equal(called.length, i + 1);
  }
  f.setNow(epoch + 1000000); assert.equal((await f.run([], { sink: ack })).code, 0);
  assert.equal(json(path.join(f.home, 'spool/sent', name)).id, 'heartbeat-2');
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'spool/sent')), [name]);
  assert.deepEqual(called, ['heartbeat-0', 'heartbeat-1', 'heartbeat-2']);
});

test('short saved dead-man backoff does not defer newly pending events on a manual flush', async t => {
  const f = fixture(t); let checks = 0;
  const sink = { ...ack, listHeartbeats: async () => {
    if (++checks === 1) throw Object.assign(new Error('dead-man unavailable'), { status: 503 });
    return [];
  } };
  assert.equal((await f.run([], { sink })).code, 1); assert.equal(Date.parse(state(f).backoff_until), epoch + 5000);
  write(f.home, 'new.json', event('new'));
  assert.equal((await f.run([], { sink })).code, 0);
  assert.ok(fs.existsSync(path.join(f.home, 'spool/sent/new.json')));
});

test('manual retry escalation defers only once saved duration exceeds the refresh threshold', async t => {
  const f = fixture(t); write(f.home, 'a.json', event('threshold')); let calls = 0;
  const sink = { ...ack, deliverFailureGroup: async () => { calls++; throw Object.assign(new Error('down'), { status: 503 }); } };
  for (const delay of [5000, 10000, 20000, 40000]) {
    await f.run([], { sink }); assert.equal(Date.parse(state(f).backoff_until), epoch + delay);
  }
  assert.equal(calls, 4); await f.run([], { sink }); assert.equal(calls, 4);
});

test('sink receives maskList and only contract failure fields, never raw spool sources', async t => {
  const f = fixture(t); const credential = ['old', 'fixture', 'credential'].join('.');
  f.env.ERRMETER_GITHUB_TOKEN = credential; write(f.home, 'a.json', event('payload', { message: credential }));
  let payload; let maskList;
  await f.run([], { sink: { ...ack, deliverFailureGroup: async (ctx, group) => {
    payload = group; maskList = ctx.maskList; return { ref: 1, delivered: ['payload'] };
  } } });
  assert.ok(maskList.includes(credential));
  assert.deepEqual(Object.keys(payload).sort(), ['agent', 'count', 'events', 'fingerprint', 'fpv']);
  assert.equal(JSON.stringify(payload).includes(credential), false);
});

test('completed counter delivery deletes checkpoint while file lookup-incomplete never lingers', async t => {
  const f = fixture(t, { spool: { cut_settle_sec: 0 } });
  write(f.home, 'counters.log', counter()); assert.equal((await f.run()).code, 0);
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'state/cuts')), []);
  const board = path.join(f.home, 'board.jsonl'); fs.appendFileSync(board, fs.readFileSync(board));
  f.config.file = { scan_max_lines: 1 }; fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(f.config));
  write(f.home, 'a.json', event('incomplete'));
  let sleeps = 0;
  const result = await f.run(['--linger'], { sleep: async () => { sleeps++; throw new Error('unexpected sleep'); } });
  assert.equal(result.code, 1); assert.equal(sleeps, 0); assert.equal(state(f).lookup_incomplete, true);
  assert.equal(state(f).backoff_until, undefined);
});

test('every future-schema event sharing a fingerprint has its own verbatim GitHub write', async t => {
  const fake = await createGithubFake(); t.after(() => fake.close());
  const f = fixture(t, { sink: { type: 'github-issue', repo: 'test/inbox', api_base: fake.url } });
  f.env.ERRMETER_GITHUB_TOKEN = 'fixture.credential.value';
  write(f.home, 'future-a.json', event('future-a', { schema: 2, future: { data: 'one' } }));
  write(f.home, 'future-b.json', event('future-b', { schema: 3, future: { data: 'two' }, ts: new Date(epoch + 1000).toISOString() }));
  write(f.home, 'current.json', event('current', { ts: new Date(epoch + 2000).toISOString() }));
  assert.equal((await f.run()).code, 0);
  const bodies = [...fake.issues, ...fake.comments].map(record => record.body);
  for (const id of ['future-a', 'future-b']) {
    const body = bodies.find(value => value.includes('"id": "' + id + '"'));
    assert.ok(body); assert.match(body, /Newer event schema; delivered verbatim/);
  }
  assert.equal(fs.readdirSync(path.join(f.home, 'spool/sent')).length, 3);
});

test('signal-woken linger preserves the current failure timestamp for restarted backoff', async t => {
  const f = fixture(t, { spool: { lock_refresh_sec: 0 } }); write(f.home, 'a.json', event('wake'));
  const sink = { ...ack, deliverFailureGroup: async () => { throw Object.assign(new Error('down'), { status: 503 }); } };
  await f.run([], { sink }); f.setNow(epoch + 5000);
  let sleeps = 0;
  await f.run(['--linger'], { sink, sleep: async ms => {
    assert.equal(ms, 10000); sleeps++; f.setNow(epoch + 7000); process.emit('SIGTERM');
  } });
  assert.equal(sleeps, 1); assert.equal(Date.parse(state(f).ts), epoch + 5000);
  assert.equal(Date.parse(state(f).backoff_until), epoch + 15000);
  f.setNow(epoch + 15000); await f.run([], { sink });
  assert.equal(Date.parse(state(f).backoff_until), epoch + 35000);
});
