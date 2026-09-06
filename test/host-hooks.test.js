'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const tools = path.join(root, 'tools/host-hooks');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(tools, '.test-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = {
    '.claude/settings.json': '{\n  "other" : [1, {"x": "braces } and \\\" quotes"}],\n  "hooks": { "Stop": [] }\n}\n',
    '.claude/scripts/sitter-on-fail.sh': '#!/usr/bin/env bash\nset -u\npayload=$(cat)\nLOG=/dev/null\nprintf "%s\\n" "$payload" >>"$LOG"\n\nroute_ask() { :; }\nexit 0\n',
    '.codex/config.toml': '# preserve this comment\nnotify = ["echo", "turn-ended", "--previous-notify", "[\\"node\\",\\"prior.js\\"]"]\n[features]\nhooks = true\n'
  };
  for (const [rel, data] of Object.entries(original)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); }
  const bin = path.join(dir, 'fake-bin'); fs.mkdirSync(bin);
  const record = path.join(dir, 'argv.jsonl');
  fs.writeFileSync(path.join(bin, 'errmeter'), '#!' + process.execPath + '\nconst fs=require("node:fs");fs.appendFileSync(process.env.RECORD,JSON.stringify({args:process.argv.slice(2),detail:process.argv.includes("--detail")?fs.readFileSync(0,"utf8"):null})+"\\n");console.log("local status");process.exit(Number(process.env.FAKE_RC||0));\n', { mode: 0o755 });
  const env = { ...process.env, HOME: dir, TMPDIR: dir, USER: 'fixture', PATH: bin + path.delimiter + path.dirname(process.execPath) + path.delimiter + process.env.PATH, RECORD: record };
  const run = (name, args = [], extra = {}) => spawnSync('bash', [path.join(tools, name), ...args], { env, encoding: 'utf8', ...extra });
  return { dir, original, env, run, record };
}
function snapshot(dir) {
  const entries = [];
  function walk(p) { for (const n of fs.readdirSync(p).sort()) { const q = path.join(p, n); if (fs.statSync(q).isDirectory()) walk(q); else entries.push([path.relative(dir, q), fs.readFileSync(q).toString('base64')]); } }
  walk(dir); return entries;
}
test('host installer dry-run is read-only and names exact replacements', t => {
  const f = fixture(t), before = snapshot(f.dir), r = f.run('errmeter-hooks-install.sh', ['--all']);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Dry run/); assert.match(r.stdout, /before/); assert.deepEqual(snapshot(f.dir), before);
});
test('host install backs up bytes, inserts one hook, preserves unrelated JSON and is idempotent', t => {
  const f = fixture(t), r = f.run('errmeter-hooks-install.sh', ['--all', '--apply']); assert.equal(r.status, 0, r.stderr);
  const settings = fs.readFileSync(path.join(f.dir, '.claude/settings.json'), 'utf8'), obj = JSON.parse(settings), original = JSON.parse(f.original['.claude/settings.json']);
  assert.equal(obj.hooks.PostToolUseFailure.length, 1); delete obj.hooks.PostToolUseFailure; assert.deepEqual(obj, original);
  const inserted = ',"PostToolUseFailure":' + JSON.stringify(JSON.parse(settings).hooks.PostToolUseFailure);
  assert.equal(settings.replace(inserted, ''), f.original['.claude/settings.json']);
  const backups = fs.readdirSync(path.join(f.dir, '.errmeter/backups')); assert.equal(backups.length, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.dir, '.errmeter/backups', backups[0], 'manifest.json')));
  for (const [rel, data] of Object.entries(f.original)) assert.equal(Buffer.from(manifest.entries.find(e => e.rel === rel).before, 'base64').toString('utf8'), data);
  assert.equal(manifest.entries.find(e => e.rel === '.errmeter/hooks/claude-code-emit.sh').before, null);
  const before = snapshot(f.dir), again = f.run('errmeter-hooks-install.sh', ['--all', '--apply']); assert.equal(again.status, 0); assert.match(again.stdout, /no changes/); assert.deepEqual(snapshot(f.dir), before);
});
test('host status reports installed then exact drift, restore recovers original bytes and removes new hooks', t => {
  const f = fixture(t); assert.equal(f.run('errmeter-hooks-install.sh', ['--all', '--apply']).status, 0);
  let r = f.run('errmeter-hooks-status.sh'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /claude-code: installed/);
  fs.appendFileSync(path.join(f.dir, '.claude/settings.json'), '\n');
  r = f.run('errmeter-hooks-status.sh'); assert.equal(r.status, 1, r.stderr); assert.match(r.stdout, /claude-code: drifted/);
  r = f.run('errmeter-hooks-restore.sh'); assert.equal(r.status, 0, r.stderr);
  for (const [rel, bytes] of Object.entries(f.original)) assert.equal(fs.readFileSync(path.join(f.dir, rel), 'utf8'), bytes);
  assert.equal(fs.existsSync(path.join(f.dir, '.errmeter/hooks/claude-code-emit.sh')), false);
  assert.equal(fs.existsSync(path.join(f.dir, '.errmeter/hooks/codex-notify-emit.sh')), false);
});
test('named target selection leaves other host files alone', t => {
  const f = fixture(t); const r = f.run('errmeter-hooks-install.sh', ['--claude-code', '--apply']); assert.equal(r.status, 0, r.stderr);
  for (const rel of ['.codex/config.toml', '.claude/scripts/sitter-on-fail.sh']) assert.equal(fs.readFileSync(path.join(f.dir, rel), 'utf8'), f.original[rel]);
});
test('bad settings, ambiguous TOML and symlinks fail before any installation write', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.dir, '.claude/settings.json'), '{oops');
  let before = snapshot(f.dir), r = f.run('errmeter-hooks-install.sh', ['--all', '--apply']); assert.equal(r.status, 3); assert.deepEqual(snapshot(f.dir), before);
  fs.writeFileSync(path.join(f.dir, '.claude/settings.json'), f.original['.claude/settings.json']); fs.writeFileSync(path.join(f.dir, '.codex/config.toml'), 'notify = [\n "echo"\n]\n');
  before = snapshot(f.dir); r = f.run('errmeter-hooks-install.sh', ['--all', '--apply']); assert.equal(r.status, 3); assert.deepEqual(snapshot(f.dir), before);
  fs.unlinkSync(path.join(f.dir, '.claude/settings.json')); fs.symlinkSync(path.join(f.dir, '.codex/config.toml'), path.join(f.dir, '.claude/settings.json'));
  assert.equal(f.run('errmeter-hooks-install.sh', ['--claude-code', '--apply']).status, 3);
});
test('usage errors do not mutate and status parse failures return cannot', t => {
  const f = fixture(t); assert.equal(f.run('errmeter-hooks-install.sh').status, 2); assert.equal(f.run('errmeter-hooks-restore.sh', ['--from', '../bad']).status, 2);
  fs.writeFileSync(path.join(f.dir, '.claude/settings.json'), 'bad'); assert.equal(f.run('errmeter-hooks-status.sh').status, 3);
});
test('plain wrapper preserves successful and failed command codes and emits bounded stderr detail', t => {
  const f = fixture(t);
  let r = f.run('examples/with-errmeter.sh', ['Nightly', '--', 'bash', '-c', 'exit 0']); assert.equal(r.status, 0, r.stderr);
  r = f.run('examples/with-errmeter.sh', ['Nightly', '--', 'bash', '-c', 'echo problem >&2; exit 7'], { env: { ...f.env, FAKE_RC: '2' } }); assert.equal(r.status, 7); assert.match(r.stderr, /problem/);
  const records = fs.readFileSync(f.record, 'utf8').trim().split('\n').map(JSON.parse); assert.equal(records.length, 2);
  assert.ok(records[0].args.includes('heartbeat')); assert.ok(records[0].args.includes('--agent=nightly')); assert.ok(records[1].args.includes('--message=exit 7')); assert.ok(records[1].args.some(a => a.startsWith('--detail-file=')));
});
test('Claude adapter handles JSON and garbage, limits message promotion, and never fails', t => {
  const f = fixture(t);
  for (const payload of [JSON.stringify({ tool_name: 'Bash', error: 'private error', session_id: '12345678-1234-1234-1234-123456789abc' }), 'garbage', JSON.stringify({ tool_name: 'untrusted-value', session_id: 'untrusted-value' })]) {
    const r = f.run('examples/claude-code-emit.sh', [], { input: payload, env: { ...f.env, FAKE_RC: '2' } }); assert.equal(r.status, 0);
  }
  const records = fs.readFileSync(f.record, 'utf8').trim().split('\n').map(JSON.parse); assert.equal(records.length, 3); assert.ok(records[0].args.includes('Bash failed')); assert.ok(records[1].args.includes('tool failed')); assert.ok(records[2].args.includes('tool failed')); assert.equal(records[2].args.includes('untrusted-value'), false);
  assert.match(records[0].detail, /private error/);
  assert.equal(f.run('examples/claude-code-emit.sh', [], { input: '{}', env: { ...f.env, ERRMETER_HOOKS_DISABLE: '1' } }).status, 0);
  assert.equal(fs.readFileSync(f.record, 'utf8').trim().split('\n').length, 3);
});
test('Codex notify chains previous argv without evaluation and emits heartbeat plus fixed failure', t => {
  const f = fixture(t), event = JSON.stringify({ type: 'turn-failed', 'last-assistant-message': 'Failure detail' });
  const previous = [path.join(f.dir, 'fake-bin/errmeter'), 'previous'];
  const r = f.run('examples/codex-notify-emit.sh', ['--previous-notify', JSON.stringify(previous), event]); assert.equal(r.status, 0);
  const records = fs.readFileSync(f.record, 'utf8').trim().split('\n').map(JSON.parse); assert.equal(records.length, 3); assert.deepEqual(records[0].args, ['previous', event]); assert.ok(records[1].args.includes('heartbeat')); assert.ok(records[2].args.includes('Codex turn reported failure')); assert.equal(records[2].detail, event);
});
test('job-heartbeat patch applies cleanly against the current host source', t => {
  const source = path.join(require('node:os').homedir(), 'claude-workspace/family-memory-architecture/scripts/job-heartbeat');
  if (!fs.existsSync(source)) { t.skip('Current fma scripts/job-heartbeat is absent on this host'); return; }
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'errmeter-patch-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts')); fs.copyFileSync(source, path.join(dir, 'scripts/job-heartbeat'));
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: dir }).status, 0);
  const r = spawnSync('git', ['apply', '--check', path.join(tools, 'examples/job-heartbeat.patch')], { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr);
  const applied = spawnSync('git', ['apply', path.join(tools, 'examples/job-heartbeat.patch')], { cwd: dir, encoding: 'utf8' }); assert.equal(applied.status, 0, applied.stderr);
  assert.match(fs.readFileSync(path.join(dir, 'scripts/job-heartbeat'), 'utf8'), /subprocess.run\(command, check=False, timeout=10/);
});
test('HOME normalization, dangling symlinks, and invalid UTF-8 are rejected safely', t => {
  const f = fixture(t);
  assert.equal(f.run('errmeter-hooks-install.sh', ['--claude-code'], { env: { ...f.env, HOME: f.dir + '/' } }).status, 0);
  assert.equal(f.run('errmeter-hooks-install.sh', ['--claude-code'], { env: { ...f.env, HOME: '/' } }).status, 3);
  assert.equal(f.run('errmeter-hooks-install.sh', ['--claude-code'], { env: { ...f.env, HOME: 'relative' } }).status, 3);
  const dest = path.join(f.dir, '.claude/settings.json'); fs.unlinkSync(dest); fs.symlinkSync(path.join(f.dir, 'missing'), dest);
  assert.equal(f.run('errmeter-hooks-install.sh', ['--claude-code', '--apply']).status, 3); fs.unlinkSync(dest);
  fs.writeFileSync(dest, Buffer.from([0xff, 0xfe])); const before = snapshot(f.dir);
  assert.equal(f.run('errmeter-hooks-install.sh', ['--claude-code', '--apply']).status, 3); assert.deepEqual(snapshot(f.dir), before);
});
test('notify-looking contents of TOML multiline strings remain untouched', t => {
  const f = fixture(t), dest = path.join(f.dir, '.codex/config.toml');
  for (const quote of ['"'.repeat(3), String.fromCharCode(39).repeat(3)]) {
    const text = 'description = ' + quote + '\nnotify = ["fake"]\n[pretend]\n' + quote + '\n';
    fs.writeFileSync(dest, text); const before = snapshot(f.dir);
    assert.equal(f.run('errmeter-hooks-install.sh', ['--codex', '--apply']).status, 3); assert.deepEqual(snapshot(f.dir), before);
    fs.writeFileSync(dest, text + 'notify = ["real"]\n');
    assert.equal(f.run('errmeter-hooks-install.sh', ['--codex']).status, 0);
  }
});
test('restore preserves bytes even when the current editable file becomes invalid UTF-8', t => {
  const f = fixture(t); assert.equal(f.run('errmeter-hooks-install.sh', ['--claude-code', '--apply']).status, 0);
  fs.writeFileSync(path.join(f.dir, '.claude/settings.json'), Buffer.from([0xff, 0x00, 0xfe]));
  assert.equal(f.run('errmeter-hooks-restore.sh').status, 0);
  assert.equal(fs.readFileSync(path.join(f.dir, '.claude/settings.json'), 'utf8'), f.original['.claude/settings.json']);
  const backups = fs.readdirSync(path.join(f.dir, '.errmeter/backups')).map(n => JSON.parse(fs.readFileSync(path.join(f.dir, '.errmeter/backups', n, 'manifest.json'))));
  assert.ok(backups.find(m => m.kind === 'restore').entries.some(e => e.before === Buffer.from([0xff, 0x00, 0xfe]).toString('base64')));
});
test('Claude keeps large complete payloads until emit redacts PEM blocks', t => {
  const f = fixture(t), begin = '-'.repeat(5) + 'BEGIN ' + 'PRIVATE KEY' + '-'.repeat(5), end = '-'.repeat(5) + 'END ' + 'PRIVATE KEY' + '-'.repeat(5);
  const payload = JSON.stringify({ tool_name: 'Bash', error: begin + '\n' + 'sensitive-body\n'.repeat(6000) + end });
  assert.equal(f.run('examples/claude-code-emit.sh', [], { input: payload }).status, 0);
  const recorded = JSON.parse(fs.readFileSync(f.record, 'utf8').trim()); assert.equal(recorded.detail, payload);
  const { redact } = require('../src/redact'); assert.equal(redact(recorded.detail, []).includes('sensitive-body'), false);
  assert.equal(fs.readdirSync(f.dir).some(n => n.startsWith('errmeter-hook.')), false);
});
test('wrapper passes leading-dash identity and complete PEM stderr through real emit redaction', t => {
  const f = fixture(t), begin = '-'.repeat(5) + 'BEGIN ' + 'PRIVATE KEY' + '-'.repeat(5), end = '-'.repeat(5) + 'END ' + 'PRIVATE KEY' + '-'.repeat(5);
  const real = path.join(root, 'bin/errmeter.js'), launcher = path.join(f.dir, 'fake-bin/errmeter');
  fs.writeFileSync(launcher, '#!/usr/bin/env bash\nexec "' + process.execPath + '" "' + real + '" "$@" --no-flush\n', { mode: 0o755 });
  const input = begin + '\n' + 'sensitive-body\n'.repeat(80) + end + '\n';
  const r = f.run('examples/with-errmeter.sh', ['--job', '--', 'bash', '-c', 'cat >&2; exit 9'], { input, env: { ...f.env, ERRMETER_HOME: path.join(f.dir, 'spool-home') } }); assert.equal(r.status, 9);
  const pending = path.join(f.dir, 'spool-home/spool/pending'), events = fs.readdirSync(pending).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(pending, n))));
  assert.equal(events.length, 1); assert.equal(events[0].agent, '--job'); assert.equal(events[0].task, '--job'); assert.equal(events[0].detail.includes('sensitive-body'), false); assert.match(events[0].detail, /REDACTED/);
});
