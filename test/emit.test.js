'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temporaryHomes = [];
process.once('exit', () => {
  for (const home of temporaryHomes) fs.rmSync(home, { recursive: true, force: true });
});
const { spawn } = require('node:child_process');
const { emit } = require('../src/emit');
const { fingerprint } = require('../src/fingerprint');
function workspace(t, config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-emit-'));
  temporaryHomes.push(home);
  if (config) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  return home;
}
function run(home, args, extra = {}, env = {}) {
  let stdout = ''; let stderr = '';
  const code = emit(['--home', home, ...args], env, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; }, ...extra });
  return { code, stdout, stderr };
}
function events(home) {
  const dir = path.join(home, 'spool/pending');
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => ({ name, event: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) }));
}
test('event and JSON summary contain redacted schema fields and normative fingerprint', t => {
  const home = workspace(t, { host: 'My-Host', family: 'family', agent: 'config' });
  const secret = 'credential-value-123';
  const result = run(home, ['--agent=Nora', '--message', secret + '\r\nfailed ghp_abcdefghijklmnopqrstuvwxyz0123', '--task=task', '--meta=run_id=abc', '--no-flush', '--json'], {}, { APP_PASSWORD: secret });
  assert.equal(result.code, 0); assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout); const { event, name } = events(home)[0];
  assert.equal(output.agent, 'nora'); assert.equal(event.host, 'my-host'); assert.equal(event.family, 'family');
  assert.equal(event.message, '[REDACTED] failed [REDACTED TOKEN]'); assert.equal(event.task, 'task');
  assert.equal(event.schema, 1); assert.equal(event.fpv, 1); assert.equal(event.attempts, 0);
  assert.equal(event.fingerprint, fingerprint('nora', event.message)); assert.match(event.fingerprint, /^[0-9a-f]{16}$/);
  assert.match(event.id, /^[0-9a-f-]{14}4[0-9a-f-]{21}$/);
  assert.equal(name, event.ts.replace(/[:.]/g, '-') + '-' + event.id + '.json');
  assert.deepEqual(Object.keys(output).sort(), ['ok', 'id', 'ts', 'kind', 'agent', 'host', 'fingerprint', 'mode', 'path', 'fallback'].sort());
});
test('identity precedence, sanitization, optional limits and metadata limits', t => {
  const home = workspace(t, { agent: 'CONFIG', host: 'HOST @/', family: 'f'.repeat(65) });
  run(home, ['--message=' + 'x'.repeat(600), '--task=' + 't'.repeat(201), '--meta=a=' + 'v'.repeat(300), '--no-flush'], {}, { ERRMETER_AGENT: 'ENV A/' });
  const event = events(home)[0].event;
  assert.equal(event.agent, 'env-a/'); assert.equal(event.host, 'host---');
  assert.equal(event.message.length, 500); assert.equal(event.meta.a.length, 256);
  assert.equal(event.task, undefined); assert.equal(event.family, undefined);
});
test('detail redaction precedes tail; stdin and byte cap preserve UTF-8 and marker', t => {
  const home = workspace(t, { spool: { tail_lines: 2, detail_max_bytes: 100 } });
  run(home, ['--message=x', '--detail=-', '--no-flush'], { readStdin: () => 'old\nAuthorization: Basic private\n' + '猫'.repeat(100) });
  const detail = events(home)[0].event.detail;
  assert.match(detail, /^\[errmeter: truncated to last 2 lines\]\n/);
  assert.ok(Buffer.byteLength(detail) <= 100); assert.ok(!detail.includes('\ufffd')); assert.ok(!detail.includes('private'));
});
test('whole serialized event cap includes newline and highly escaped metadata', t => {
  const home = workspace(t, { spool: { detail_max_bytes: 1000000, tail_lines: 500 } });
  const args = ['--message=' + '\u0000'.repeat(500), '--detail=-', '--no-flush'];
  for (let i = 0; i < 16; i++) args.push('--meta=k' + i + '=' + '\u0000'.repeat(256));
  run(home, args, { readStdin: () => ('\u0000'.repeat(2000) + '\n').repeat(100) });
  const { name, event } = events(home)[0];
  assert.ok(fs.statSync(path.join(home, 'spool/pending', name)).size <= 32768);
  assert.equal(event.detail, '[errmeter: truncated to last 500 lines]\n');
});
test('heartbeat omits error fields and detail, role only caller supplied', t => {
  const home = workspace(t);
  run(home, ['--kind=heartbeat', '--detail-file=/missing', '--no-flush']);
  const event = events(home)[0].event;
  for (const key of ['detail', 'fingerprint', 'fpv', 'meta']) assert.equal(event[key], undefined);
  run(home, ['--kind=heartbeat', '--meta=role=watcher', '--no-flush']);
  assert.ok(events(home).some(item => item.event.meta?.role === 'watcher'));
});
test('no-flush and failed writes suppress spawn; successful writes detach and unref', t => {
  const home = workspace(t); let calls = 0; let unrefs = 0;
  const fake = (file, args, options) => {
    calls++; assert.equal(file, process.execPath); assert.equal(args[1], 'flush');
    assert.equal(args[3], home); assert.equal(options.stdio, 'ignore');
    assert.equal(options.detached, process.platform !== 'win32'); assert.equal(options.windowsHide, true);
    return { on: () => {}, unref: () => { unrefs++; } };
  };
  run(home, ['--message=x', '--no-flush'], { spawn: fake }); assert.equal(calls, 0);
  run(home, ['--message=x'], { spawn: fake }); assert.equal(calls, 1); assert.equal(unrefs, 1);
  const failed = run(home, ['--message=x'], { spawn: fake, writeEvent: () => ({ ok: false }) });
  assert.equal(calls, 1); assert.equal(failed.code, 0); assert.equal(failed.stdout, 'emit failed\n');
  const thrown = run(home, ['--message=x'], { writeEvent: () => { throw new Error('secret'); } });
  assert.equal(thrown.code, 0); assert.ok(!thrown.stderr.includes('secret'));
  assert.equal(run(home, ['--message=x'], { spawn: () => { throw new Error('spawn'); } }).code, 0);
});
test('unreadable detail and write failure produce at most one diagnostic; quiet suppresses stdout', t => {
  const home = workspace(t);
  const result = run(home, ['--message=x', '--detail-file=/missing', '--quiet'], { writeEvent: () => { throw new Error('secret'); } });
  assert.equal(result.code, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr.trim().split('\n').length, 1);
  const readable = run(home, ['--message=x', '--detail-file=/missing', '--no-flush']);
  assert.equal(readable.code, 0); assert.equal(events(home)[0].event.detail, undefined);
});
test('20 concurrent CLI emits write 20 distinct valid pending events', async t => {
  const home = workspace(t); const bin = path.resolve(__dirname, '../bin/errmeter.js');
  await Promise.all(Array.from({ length: 20 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'emit', '--message=event ' + i, '--no-flush', '--quiet'], { env: { ...process.env, ERRMETER_HOME: home, ERRMETER_CONFIG: path.join(home, 'config.json') }, stdio: 'pipe' });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => { try { assert.equal(code, 0); assert.equal(stderr, ''); resolve(); } catch (error) { reject(error); } });
  })));
  const found = events(home); assert.equal(found.length, 20); assert.equal(new Set(found.map(item => item.event.id)).size, 20);
  assert.ok(!fs.readdirSync(path.join(home, 'spool/pending')).some(name => name.endsWith('.tmp')));
});
test('every configured credential file remains available to masking, including spool extensions', t => {
  const home = workspace(t);
  const secret = 'opaque-credential-xyz';
  const credential = path.join(home, 'credential');
  fs.writeFileSync(credential, secret);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ spool: { custom_file: credential } }));
  const result = run(home, ['--message=' + secret, '--no-flush']);
  assert.equal(result.code, 0); assert.equal(events(home)[0].event.message, '[REDACTED]');
});
test('higher configuration schema is refused clearly without breaking the hook', t => {
  const home = workspace(t, { schema: 2 });
  const result = run(home, ['--message=x', '--no-flush']);
  assert.equal(result.code, 0); assert.equal(result.stderr, 'emit: unsupported config schema\n');
  assert.equal(fs.existsSync(path.join(home, 'spool')), false);
});
test('configured small limits reach compact, counter, and dropped through emit', t => {
  const home = workspace(t, { spool: { pending_soft_limit: 0, pending_hard_limit: 1, overflow_max_bytes: 1, overflow_guard_bytes: 1000 } });
  const first = JSON.parse(run(home, ['--message=x', '--no-flush', '--json']).stdout);
  const second = JSON.parse(run(home, ['--message=x', '--no-flush', '--json']).stdout);
  const third = JSON.parse(run(home, ['--message=x', '--no-flush', '--json']).stdout);
  assert.equal(first.mode, 'compact'); assert.equal(second.mode, 'counter'); assert.equal(third.mode, 'dropped');
  assert.equal(events(home).find(item => item.event.kind === 'error').event.meta._compact, '1');
});
