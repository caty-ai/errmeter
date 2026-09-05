'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { run } = require('../src/run');
const { parseRun: parse } = require('../src/cli');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-run-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'dispatch.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, issue: { ref: 42 }, latest: { message: 'failure' }, deadline_ms: 21000 }));
  return { dir, file };
}
function args(file, extra = {}) {
  return ['--deadline-ms', String(extra.wall === undefined ? 21000 : extra.wall),
    '--deadline-mono-ms', String(extra.mono === undefined ? 20000 : extra.mono),
    '--timeout', String(extra.timeout === undefined ? 30 : extra.timeout), '--state', file, '--', process.execPath,
    '-e', extra.script || 'process.stdin.resume();'];
}
function fake(t, extra = {}) {
  const f = fixture(t);
  let now = 0; let wallOffset = 1000; let monoOffset = 0;
  const timers = new Map(); let next = 0;
  const child = new EventEmitter();
  Object.assign(child, { pid: 43210, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  let output = ''; let errors = ''; let payload = '';
  stdout.on('data', data => { output += data; }); stderr.on('data', data => { errors += data; });
  child.stdin.on('data', data => { payload += data; });
  const calls = []; const killed = [];
  const signals = new EventEmitter();
  const io = { stdin, stdout, stderr, signals, platform: 'linux', pid: 12345,
    clock: () => now + wallOffset, monotonic: () => now + monoOffset,
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    spawn(...values) { calls.push(values); return child; },
    kill(pid, signal) { killed.push([pid, signal]); }, ...extra };
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const pending = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (!pending.length) break;
      const [id, timer] = pending[0]; now = timer.at; timers.delete(id); timer.fn();
    }
    now = end;
  }
  return { ...f, io, child, stdin, stdout, stderr, calls, killed, signals, timers, advance,
    output: () => output, errors: () => errors, payload: () => payload,
    jumpWall(ms) { wallOffset += ms; }, jumpMono(ms) { monoOffset += ms; },
    start(overrides) { return run(args(f.file, overrides), io); },
    state(value) { fs.writeFileSync(f.file, JSON.stringify(value)); } };
}

test('runner creates PID-only state when absent at startup', async t => {
  const f = fake(t);
  fs.unlinkSync(f.file);
  const pending = f.start();
  f.child.emit('spawn');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { pid: 43210, runner_pid: 12345 });
  f.child.emit('close', 0, null);
  assert.equal(await pending, 0);
});

test('runner parser requires deadlines, timeout, state, and a literal argv separator', () => {
  for (const input of [[], ['--bad', '1'], args('x').filter(x => x !== '--'), args('x', { timeout: -1 }),
    args('x', { mono: NaN }), ['--state', 'x', '--', 'node']]) assert.throws(() => parse(input));
  const result = parse(['--deadline-ms=1000', '--deadline-mono-ms=900', '--timeout=1', '--state=x', '--', 'node', '--anything', 'a; echo unsafe']);
  assert.deepEqual(result.command, ['node', '--anything', 'a; echo unsafe']);
});

test('runner forwards streams and EOF, merges both pids atomically, and returns hook exit', async t => {
  const f = fake(t);
  const result = f.start();
  const state = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.deepEqual(state, { schema: 1, issue: { ref: 42 }, latest: { message: 'failure' }, deadline_ms: 21000, pid: 43210, runner_pid: 12345 });
  assert.deepEqual(fs.readdirSync(f.dir), ['dispatch.json']);
  assert.deepEqual(f.calls[0][2], { shell: false, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  f.stdin.end('{"payload":true}\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.payload(), '{"payload":true}\n');
  assert.equal(f.child.stdin.writableEnded, true);
  f.child.stdout.write('summary\n'); f.child.stderr.write('diagnostic\n');
  f.child.emit('close', 7, null);
  assert.equal(await result, 7);
  assert.equal(f.output(), 'summary\n'); assert.equal(f.errors(), 'diagnostic\n');
  assert.equal(f.timers.size, 0); assert.equal(f.signals.listenerCount('SIGTERM'), 0);
});

test('runner refuses already expired leases without spawning a hook', async t => {
  const f = fake(t);
  assert.equal(await f.start({ wall: 1000 }), 124);
  assert.equal(await f.start({ mono: 0 }), 124);
  assert.equal(f.calls.length, 0);
});

for (const code of ['EEXIST', 'EPERM', 'EACCES']) {
  test('runner replaces existing state after Windows rename ' + code, async t => {
    const f = fake(t, { platform: 'win32' });
    const rename = fs.renameSync;
    const unlink = fs.unlinkSync;
    const removed = [];
    let attempts = 0;
    let result;
    fs.renameSync = (source, target) => {
      assert.equal(target, f.file);
      if (++attempts === 1) throw Object.assign(new Error('destination exists'), { code });
      assert.equal(fs.existsSync(target), false);
      return rename(source, target);
    };
    fs.unlinkSync = file => { removed.push(file); return unlink(file); };
    try { result = f.start(); } finally { fs.renameSync = rename; fs.unlinkSync = unlink; }
    f.child.emit('close', 0, null);
    assert.equal(await result, 0);
    assert.equal(attempts, 2);
    assert.equal(removed[0], f.file);
    assert.equal(removed.length, 3, 'only the destination, temporary file, and owned lock are removed');
    assert.ok(removed[1].startsWith(f.file + '.'));
    assert.ok(removed[1].endsWith('.tmp'));
    assert.equal(removed[2], f.file + '.lock');
    assert.deepEqual(fs.readdirSync(f.dir), ['dispatch.json']);
    const state = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    assert.equal(state.pid, 43210); assert.equal(state.runner_pid, 12345);
    assert.deepEqual(state.issue, { ref: 42 });
    assert.deepEqual(state.latest, { message: 'failure' });
  });
}

test('PID merge excludes a concurrent renewal through both read and replacement', async t => {
  const f = fake(t);
  const script = 'const fs=require("node:fs"),file=process.argv[1],lock=file+".lock";let fd;' +
    'try{fd=fs.openSync(lock,"wx",0o600);}catch(e){process.exit(e.code==="EEXIST"?23:24);}' +
    'try{const value=JSON.parse(fs.readFileSync(file,"utf8"));value.deadline_ms=99000;fs.writeFileSync(file,JSON.stringify(value));}' +
    'finally{fs.closeSync(fd);fs.unlinkSync(lock);}';
  const renewal = () => spawnSync(process.execPath, ['-e', script, f.file], { timeout: 5000 });
  const read = fs.readFileSync; const rename = fs.renameSync;
  const attempts = [];
  let result;
  fs.readFileSync = (file, ...options) => {
    const value = read(file, ...options);
    if (file === f.file) attempts.push(renewal());
    return value;
  };
  fs.renameSync = (source, target) => {
    if (target === f.file) attempts.push(renewal());
    return rename(source, target);
  };
  try { result = f.start(); } finally { fs.readFileSync = read; fs.renameSync = rename; }
  f.child.emit('close', 0, null);
  assert.equal(await result, 0);
  assert.deepEqual(attempts.map(attempt => attempt.status), [23, 23]);
  assert.equal(fs.existsSync(f.file + '.lock'), false);
  assert.equal(renewal().status, 0, 'renewal acquires the lock after PID recording finishes');
  const state = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(state.deadline_ms, 99000); assert.equal(state.pid, 43210); assert.equal(state.runner_pid, 12345);
});

test('a busy state lock leaves renewal untouched and fails closed with hook-tree termination', async t => {
  const f = fake(t);
  const original = fs.readFileSync(f.file, 'utf8');
  const lock = f.file + '.lock';
  fs.writeFileSync(lock, 'another writer', { flag: 'wx', mode: 0o600 });
  const result = f.start();
  assert.deepEqual(f.killed, [[-43210, 'SIGTERM']]);
  f.advance(10000);
  assert.equal(await result, 125);
  assert.deepEqual(f.killed.at(-1), [-43210, 'SIGKILL']);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another writer');
  assert.deepEqual(fs.readdirSync(f.dir).sort(), ['dispatch.json', 'dispatch.json.lock']);
});

test('a state read failure releases the acquired lock before failing closed', async t => {
  const f = fake(t);
  fs.writeFileSync(f.file, '{');
  const result = f.start();
  assert.equal(fs.existsSync(f.file + '.lock'), false);
  f.advance(10000);
  assert.equal(await result, 125);
  assert.deepEqual(fs.readdirSync(f.dir), ['dispatch.json']);
});

for (const mode of ['wall forward', 'wall backward', 'monotonic', 'timeout']) {
  test('runner enforces earliest fence: ' + mode, async t => {
    const f = fake(t);
    const result = f.start(mode === 'timeout' ? { timeout: 2 } : mode === 'monotonic' ? { mono: 2000 } : {});
    if (mode === 'wall forward') f.jumpWall(50000);
    if (mode === 'wall backward') f.jumpWall(-50000);
    f.advance(mode === 'wall backward' ? 20000 : mode === 'wall forward' ? 1000 : 2000);
    assert.deepEqual(f.killed, [[43210 * -1, 'SIGTERM']]);
    f.child.emit('close', null, 'SIGTERM');
    assert.equal(f.timers.size, 1, 'descendants remain supervised after direct child exits');
    f.advance(9999);
    assert.equal(f.killed.some(([, signal]) => signal === 'SIGKILL'), false);
    f.advance(1);
    assert.equal(await result, 124);
    assert.deepEqual(f.killed.at(-1), [-43210, 'SIGKILL']);
  });
}

test('renewal at five seconds advances both deadlines but never resets timeout', async t => {
  const f = fake(t);
  const result = f.start({ wall: 7000, mono: 6000, timeout: 9 });
  f.state({ deadline_ms: 21000 });
  f.advance(4999); assert.equal(f.killed.length, 0);
  f.advance(1001); assert.equal(f.killed.length, 0, 'old fence was extended');
  f.advance(3000); assert.deepEqual(f.killed, [[-43210, 'SIGTERM']]);
  f.advance(10000); assert.equal(await result, 124);
});

test('a newer renewal generation re-arms after a backward wall-clock step', async t => {
  const f = fake(t);
  const result = f.start({ wall: 7000, mono: 6000 });
  f.jumpWall(-10000);
  f.state({ deadline_ms: 5000, deadline_generation: 1 });
  f.advance(6000);
  assert.equal(f.killed.length, 0, 'numeric wall deadline may fall while the renewed lease moves forward');
  f.advance(8000);
  assert.deepEqual(f.killed, [[-43210, 'SIGTERM']]);
  f.advance(10000); assert.equal(await result, 124);
});

test('repeated reads of the same deadline never re-arm monotonic fence after wall rollback', async t => {
  const f = fake(t);
  const result = f.start({ wall: 7000, mono: 6000 });
  f.state({ deadline_ms: 13000 });
  f.advance(5000);
  f.jumpWall(-100000);
  f.advance(7000);
  assert.deepEqual(f.killed, [[-43210, 'SIGTERM']]);
  f.advance(10000); assert.equal(await result, 124);
});

for (const state of ['missing', 'invalid', 'older', 'string', 'null']) {
  test('runner keeps the original fence for ' + state + ' renewal state', async t => {
    const f = fake(t); const result = f.start({ wall: 7000, mono: 6000 });
    if (state === 'missing') fs.unlinkSync(f.file);
    else if (state === 'invalid') fs.writeFileSync(f.file, '{');
    else f.state(state === 'null' ? null : { deadline_ms: state === 'string' ? '999999' : 2000 });
    f.advance(6000); assert.deepEqual(f.killed, [[-43210, 'SIGTERM']]);
    f.advance(10000); assert.equal(await result, 124);
  });
}

test('SIGTERM and broken watcher pipes preserve the forced-kill path', async t => {
  const f = fake(t); const result = f.start();
  f.stdout.emit('error', Object.assign(new Error('closed watcher'), { code: 'EPIPE' }));
  f.stderr.emit('error', Object.assign(new Error('closed watcher'), { code: 'EPIPE' }));
  f.child.stdout.write('still running'); f.child.stderr.write('still running');
  f.signals.emit('SIGTERM');
  f.child.emit('close', null, 'SIGTERM');
  f.advance(10000);
  assert.equal(await result, 124);
  assert.deepEqual(f.killed.at(-1), [-43210, 'SIGKILL']);
});

test('Windows termination invokes taskkill with the hook tree', async t => {
  const f = fake(t, { platform: 'win32' });
  const killer = new EventEmitter();
  const launch = f.io.spawn;
  f.io.spawn = (...values) => values[0] === 'taskkill' ? (f.calls.push(values), killer) : launch(...values);
  const result = f.start({ timeout: 1 });
  assert.equal(f.calls[0][2].detached, false);
  f.advance(1000);
  assert.deepEqual(f.calls[1], ['taskkill', ['/PID', '43210', '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }]);
  killer.emit('close', 0);
  assert.equal(await result, 124);
});

test('spawn failures return 125 and do not leave active timers', async t => {
  const f = fake(t);
  const result = f.start(); f.child.emit('error', new Error('ENOENT'));
  assert.equal(await result, 125); assert.equal(f.timers.size, 0);
  const g = fake(t, { spawn() { throw new Error('spawn failed'); } });
  assert.equal(await g.start(), 125); assert.equal(g.timers.size, 0);
});

function subprocess(t, file, script, overrides = {}) {
  const command = args(file, { wall: Date.now() + 10000, mono: 10000, timeout: 10, script, ...overrides });
  const child = spawn(process.execPath, [path.join(__dirname, '../bin/errmeter.js'), '_run', ...command],
    { detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('runner test timed out')); }, 15000);
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, done };
}

test('real _run CLI forwards JSON, argv, output, EOF, and hook exit code', async t => {
  const f = fixture(t);
  const hook = 'let data="";process.stdin.on("data",x=>data+=x);process.stdin.on("end",()=>{process.stdout.write(data);process.stderr.write("hook diagnostic\\n");process.exitCode=7;});';
  const p = subprocess(t, f.file, hook);
  p.child.stdin.end('{"schema":1,"message":"example"}\n');
  const result = await p.done;
  assert.equal(result.code, 7, result.stderr);
  assert.equal(result.stdout, '{"schema":1,"message":"example"}\n');
  assert.equal(result.stderr, 'hook diagnostic\n');
  const state = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(state.runner_pid, p.child.pid); assert.ok(state.pid > 0); assert.notEqual(state.pid, state.runner_pid);
});

test('real _run fences a hook after watcher output pipes disappear', async t => {
  const f = fixture(t);
  const p = subprocess(t, f.file, 'setInterval(()=>process.stdout.write("alive\\n"),20);', { wall: Date.now() + 400, mono: 400 });
  p.child.stdin.end('{}\n');
  p.child.stdout.destroy(); p.child.stderr.destroy();
  const result = await p.done;
  assert.equal(result.code, 124);
});

async function waitFor(check, timeout = 4000) {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= until) throw new Error('runner condition did not become true');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function processGone(pid) {
  try { process.kill(pid, 0); } catch (error) { return error.code === 'ESRCH'; }
  // A killed orphan can remain as a zombie briefly until its new parent reaps
  // it. It is no longer executable and therefore satisfies the tree-kill
  // guarantee even though kill(0) still sees the process-table entry.
  try { return /^Z/.test(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()); }
  catch (_) { return true; }
}

test('real runner survives watcher SIGKILL and independently terminates its hook', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const ready = path.join(f.dir, 'ready'); const stopped = path.join(f.dir, 'stopped');
  const hook = 'const fs=require("node:fs");fs.writeFileSync(' + JSON.stringify(ready) + ',"ready");' +
    'process.on("SIGTERM",()=>{fs.writeFileSync(' + JSON.stringify(stopped) + ',"fenced");process.exit(0);});setInterval(()=>{},100);';
  const argv = [path.join(__dirname, '../bin/errmeter.js'), '_run', ...args(f.file, {
    wall: Date.now() + 1500, mono: 1500, timeout: 5, script: hook
  })];
  const script = 'const p=require("node:child_process").spawn(process.execPath,' + JSON.stringify(argv) +
    ',{detached:true,stdio:["pipe","pipe","pipe"]});p.stdin.end("{}\\n");setInterval(()=>{},100);';
  const watcher = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  let recorded = {};
  t.after(() => {
    watcher.kill('SIGKILL');
    for (const pid of [recorded.pid, recorded.runner_pid]) if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch (_) {} }
  });
  await waitFor(() => fs.existsSync(ready));
  recorded = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  watcher.kill('SIGKILL');
  await waitFor(() => { try { return fs.readFileSync(stopped, 'utf8') === 'fenced'; } catch (_) { return false; } });
  assert.equal(fs.readFileSync(stopped, 'utf8'), 'fenced');
});

test('real runner kills a TERM-resistant descendant after the ten second grace', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const ready = path.join(f.dir, 'descendant');
  const grandchild = 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(' + JSON.stringify(ready) + ',String(process.pid));setInterval(()=>{},100);';
  const hook = 'require("node:child_process").spawn(process.execPath,["-e",' + JSON.stringify(grandchild) + '],{stdio:"inherit"});setInterval(()=>{},100);';
  const started = Date.now();
  const p = subprocess(t, f.file, hook, { wall: Date.now() + 1000, mono: 1000 });
  p.child.stdin.end('{}\n');
  let pid;
  t.after(() => {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
  });
  await waitFor(() => fs.existsSync(ready));
  pid = Number(fs.readFileSync(ready, 'utf8'));
  const result = await p.done;
  assert.equal(result.code, 124, result.stderr);
  assert.ok(Date.now() - started >= 10000, 'runner retained the grace period for its descendant');
  await waitFor(() => processGone(pid));
});
