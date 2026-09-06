'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { init } = require('../src/init');
const { PERMISSION_NOTE } = require('../src/status');
const EXPECTED_LABELS = ['errmeter', 'errmeter:failure', 'errmeter:heartbeat', 'errmeter:alert',
  'errmeter:role:watcher', 'errmeter:role:agent-host', 'errmeter:claimed', 'errmeter:dispatched',
  'errmeter:repaired', 'errmeter:dispatch-failed', 'errmeter:needs-human'];

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-init-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let stdout = '', stderr = '', result;
  return { home, env: { ERRMETER_HOME: home }, io: {
    stdout: text => { stdout += text; }, stderr: text => { stderr += text; }, onResult: value => { result = value; }
  }, out: () => ({ stdout, stderr, result }) };
}

function transport(requests, options = {}) {
  return async request => {
    requests.push(request);
    const target = new URL(request.url).pathname;
    if (options.fail === request.method + ' ' + target) return { status: 403, body: { message: 'private response' } };
    if (request.method === 'POST' && target.endsWith('/labels')) return { status: options.existing ? 422 : 201, body: { message: 'already_exists' } };
    if (request.method === 'POST' && target.endsWith('/issues')) return { status: 201, body: { number: 9 } };
    if (target.endsWith('/contents/')) return { status: options.overScoped ? 200 : 404 };
    if (target.endsWith('/pulls')) return { status: 403 };
    return { status: 200, body: [] };
  };
}

test('init writes private complete config and directories without secrets or network', async t => {
  const f = fixture(t); const secret = ['private', 'credential'].join('.');
  const code = await init(['--repo', 'test/inbox', '--family', 'family', '--host', 'host-a', '--role', 'agent-host', '--json'],
    { ...f.env, ERRMETER_GITHUB_TOKEN: secret }, { ...f.io, http: () => assert.fail('unexpected network') });
  assert.equal(code, 0);
  const file = path.join(f.home, 'config.json');
  const raw = fs.readFileSync(file, 'utf8'); const config = JSON.parse(raw);
  assert.equal(config.schema, 1); assert.equal(config.sink.repo, 'test/inbox'); assert.equal(config.family, 'family');
  assert.equal(config.host, 'host-a'); assert.equal(config.watch.role, 'agent-host');
  assert.deepEqual(config, { schema: 1, family: 'family', host: 'host-a', sink: { type: 'github-issue', repo: 'test/inbox',
    token_file: '~/.errmeter/github-token', api_base: 'https://api.github.com' }, watch: { role: 'agent-host' }, owner: { mention: '' }, notify: [] });
  assert.equal(raw.includes(secret), false); assert.equal(f.out().stdout.includes(secret), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  for (const dir of ['spool/pending', 'state', 'logs']) assert.ok(fs.statSync(path.join(f.home, dir)).isDirectory());
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'spool')), ['pending']);
  assert.equal(JSON.parse(f.out().stdout).checked, false);
});

test('init refuses existing config and force replaces bytes with a private new file', async t => {
  const f = fixture(t); const file = path.join(f.home, 'config.json');
  fs.writeFileSync(file, 'original', { mode: 0o644 });
  assert.equal(await init(['--repo', 'test/inbox'], f.env, f.io), 4); assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  assert.equal(await init(['--repo', 'test/inbox', '--force', '--host', 'replacement'], f.env, f.io), 0);
  assert.equal(JSON.parse(fs.readFileSync(file)).host, 'replacement');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(f.home).filter(name => name.endsWith('.tmp')), []);
});

test('init respects separate config path and refuses a concurrent destination without overwriting it', async t => {
  const f = fixture(t); const file = path.join(f.home, 'settings', 'custom.json');
  const disk = Object.create(fs);
  disk.linkSync = (source, destination) => { fs.writeFileSync(destination, 'other initializer'); return fs.linkSync(source, destination); };
  assert.equal(await init(['--repo', 'test/inbox', '--config', file], f.env, { ...f.io, fs: disk }), 4);
  assert.equal(fs.readFileSync(file, 'utf8'), 'other initializer');
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1);
});

test('init check creates every label, closes probe and explains the least privilege limit', async t => {
  const f = fixture(t); const requests = [];
  assert.equal(await init(['--repo', 'test/inbox', '--check', '--json'], { ...f.env, ERRMETER_GITHUB_TOKEN: ['sample', 'board'].join('.') },
    { ...f.io, http: transport(requests, { existing: true, overScoped: true }) }), 0);
  assert.deepEqual(requests.filter(r => new URL(r.url).pathname.endsWith('/labels')).map(r => r.body.name), EXPECTED_LABELS);
  assert.deepEqual(requests.find(r => r.method === 'POST' && new URL(r.url).pathname.endsWith('/issues')).body.labels, ['errmeter']);
  assert.deepEqual(requests.find(r => r.method === 'PATCH').body, { state: 'closed' });
  assert.equal(f.out().result.permission_note, PERMISSION_NOTE);
  assert.ok(f.out().stderr.includes('over-scoped (warning)'));
  assert.ok(f.out().stderr.includes("consistent with least privilege, not proof — confirm on the token's permission page (checkpoint #2)"));
});

test('init check names failed write probe and retains created local config', async t => {
  const f = fixture(t); const requests = [];
  const code = await init(['--repo', 'test/inbox', '--check'], { ...f.env, ERRMETER_GITHUB_TOKEN: ['sample', 'board'].join('.') },
    { ...f.io, http: transport(requests, { fail: 'POST /repos/test/inbox/issues' }) });
  assert.equal(code, 3); assert.match(f.out().stderr, /POST \/repos\/test\/inbox\/issues/);
  assert.equal(f.out().stderr.includes('private response'), false);
  assert.ok(fs.existsSync(path.join(f.home, 'config.json')));
});

test('init cleans temporary file after write failure without touching original force target', async t => {
  const f = fixture(t); const file = path.join(f.home, 'config.json'); fs.writeFileSync(file, 'original');
  const disk = Object.create(fs); disk.renameSync = () => { throw new Error('disk failure'); };
  assert.equal(await init(['--repo', 'test/inbox', '--force'], f.env, { ...f.io, fs: disk }), 3);
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  assert.equal(fs.readdirSync(f.home).filter(name => name.endsWith('.tmp')).length, 0);
});

test('init requires repo and prints config and token paths with private mode', async t => {
  const f = fixture(t);
  const disk = Object.create(fs); disk.existsSync = () => false;
  assert.equal(await init([], f.env, f.io), 2);
  assert.equal(await init(['--repo', 'test/inbox'], f.env, { ...f.io, fs: disk }), 0);
  assert.ok(f.out().stdout.includes(path.join(f.home, 'config.json')));
  assert.ok(f.out().stdout.includes('put the token in ~/.errmeter/github-token (mode 0600); it does not exist yet'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, 'config.json'))).family, '');
});

test('init check probes existing config and api_base without rewriting or requiring repo', async t => {
  const f = fixture(t); const file = path.join(f.home, 'config.json'); const requests = [];
  const original = JSON.stringify({ schema: 1, host: 'existing', sink: {
    type: 'github-issue', repo: 'existing/board', api_base: 'https://board.example.invalid/api/v3',
    token_file: '/existing/token'
  }, watch: { role: 'agent-host' } }, null, 4) + '\n';
  fs.writeFileSync(file, original, { mode: 0o600 });
  const before = fs.statSync(file);
  const env = { ...f.env, ERRMETER_GITHUB_TOKEN: ['sample', 'board'].join('.') };
  const disk = Object.create(fs);
  disk.mkdirSync = disk.openSync = () => assert.fail('check must not create or rewrite local files');
  assert.equal(await init(['--check'], env, { ...f.io, fs: disk, http: transport(requests) }), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.equal(fs.statSync(file).mode, before.mode);
  assert.ok(requests.length > 0);
  assert.ok(requests.every(request => request.url.startsWith('https://board.example.invalid/api/v3/repos/existing/board')));
  assert.equal(f.out().result.config_created, false);
  assert.equal(f.out().result.checked, true);
  assert.equal(f.out().result.token_file, '/existing/token');
  assert.match(f.out().stdout, /init: config checked:/);
  assert.equal(await init(['--repo', 'ignored/new', '--check'], env, { ...f.io, fs: disk,
    http: transport([], { fail: 'GET /api/v3/repos/existing/board' }) }), 3);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('init check warns when closing the created probe Issue fails', async t => {
  const f = fixture(t); const requests = [];
  assert.equal(await init(['--repo', 'test/inbox', '--check', '--json'],
    { ...f.env, ERRMETER_GITHUB_TOKEN: ['sample', 'board'].join('.') },
    { ...f.io, http: transport(requests, { fail: 'PATCH /repos/test/inbox/issues/9' }) }), 3);
  assert.match(f.out().stderr, /warning: probe Issue #9 left open — close it manually/);
  assert.match(JSON.parse(f.out().stdout).warnings[0], /Issue #9/);
  assert.equal(f.out().stderr.includes('private response'), false);
});
