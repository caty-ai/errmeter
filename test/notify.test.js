'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { notify } = require('../src/notify');
const { resolveConfig, secretFile, ConfigError } = require('../src/config');

function fixture(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-notify-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = { schema: 1, host: 'test-host', sink: { type: 'file' }, watch: { role: 'agent-host' }, ...extra };
  function resolve(command = 'watch', env = {}) {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
    return resolveConfig({ home }, env, { command });
  }
  function secret(name, value, mode = 0o600) {
    const file = path.join(home, name);
    fs.writeFileSync(file, value, { mode });
    fs.chmodSync(file, mode);
    return file;
  }
  return { home, config, resolve, secret };
}

test('notify tries every channel in order, uses exact payloads and never leaks transport diagnostics', async () => {
  const token = 'short'; const slack = 'https://hooks.example.invalid/private-path';
  const calls = []; const logs = [];
  const channels = [{ type: 'telegram', token, chat_id: '123' }, { type: 'slack', webhook_url: slack },
    { type: 'webhook', url: 'https://example.invalid/hook', headers: { 'X-Key': 'tiny' } }];
  const ctx = { config: { notify: channels }, maskList: ['other-secret'], log: line => logs.push(line), http: async request => {
    calls.push(request);
    if (calls.length === 1) throw new Error('failed at ' + request.url);
    if (calls.length === 2) return { status: 503, body: slack };
    return { status: 204 };
  } };
  const result = await notify(ctx, { key: 'gap', title: 'short tiny', body: 'other-secret', extra: 'never forwarded' });
  assert.deepEqual(result, { sent: ['webhook'], failed: ['telegram', 'slack'] });
  assert.deepEqual(calls.map(row => row.url), ['https://api.telegram.org/botshort/sendMessage', slack, channels[2].url]);
  assert.deepEqual(calls[0].body, { chat_id: '123', text: '[REDACTED] [REDACTED]\n[REDACTED]' });
  assert.deepEqual(calls[1].body, { text: calls[0].body.text });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[2].body)), { alert: { key: 'gap', title: '[REDACTED] [REDACTED]', body: '[REDACTED]' } });
  assert.deepEqual(calls[2].headers, { 'X-Key': 'tiny' });
  assert.equal(logs.length, 2);
  for (const secret of [token, slack, 'api.telegram.org', 'tiny', 'other-secret']) assert.equal(JSON.stringify(logs).includes(secret), false);
});

test('notify supports request objects and keeps trying when the logger throws', async () => {
  let count = 0;
  const ctx = { config: { notify: [{ type: 'webhook', url: 'https://example.invalid' }, { type: 'webhook', url: 'https://example.invalid' }] },
    http: { request: async () => { count++; return { status: count === 1 ? 500 : 200 }; } }, log() { throw new Error('log failed'); } };
  assert.deepEqual(await notify(ctx, { title: 'title', body: 'body' }), { sent: ['webhook'], failed: ['webhook'] });
  ctx.dryRun = true;
  assert.deepEqual(await notify(ctx, {}), { sent: [], failed: [] });
  assert.equal(count, 2);
});

test('watch config resolves frozen defaults and parses per-agent gap strings', t => {
  const f = fixture(t, { watch: { role: 'agent-host', gaps: { 'nora@test-host': '3600' } } });
  const { watch } = f.resolve().config;
  assert.equal(watch.watcher_id, 'test-host');
  for (const [key, value] of Object.entries({ interval_sec: 60, claim_ttl_sec: 900, renew_sec: 180, kill_grace_sec: 30,
    max_concurrent: 1, escalate_after: 2, watcher_gap_sec: 600, heartbeat_gap_sec: 900, renotify_sec: 21600, notify_confirm_sec: 120 })) assert.equal(watch[key], value);
  assert.equal(watch.gaps['nora@test-host'], 3600);
  assert.deepEqual(watch.dispatch, { command: [], timeout_sec: 840, cwd: undefined,
    pass_env: ['PATH', 'HOME', 'LANG', 'TMPDIR', 'TEMP', 'SYSTEMROOT', 'USERPROFILE'] });
});

test('watch validates lease bounds, dispatch shape and board capabilities at startup', t => {
  const f = fixture(t);
  for (const watch of [{ role: 'watcher' }, { role: 'watcher', dispatch: { command: [''] } }, { role: 'agent-host', renew_sec: 301 },
    { role: 'agent-host', dispatch: { timeout_sec: 871 } }, { role: 'agent-host', dispatch: { command: [12] } },
    { role: 'agent-host', dispatch: { pass_env: ['PATH', 12] } }, { role: 'agent-host', interval_sec: 0 },
    { role: 'agent-host', gaps: { agent: '12x' } }, { role: 'agent-host', gaps: { agent: -1 } }]) {
    f.config.watch = watch;
    assert.throws(() => f.resolve(), error => error instanceof ConfigError && /^watch: [^\n]+$/.test(error.message));
    assert.doesNotThrow(() => f.resolve('flush'));
  }
  f.config.watch = { role: 'watcher', dispatch: { command: ['node', 'repair.js'], timeout_sec: 870 }, renew_sec: 300 };
  assert.equal(f.resolve().config.watch.dispatch.timeout_sec, 870);
  f.config.watch = {};
  assert.doesNotThrow(() => f.resolve('flush'));
  f.config.sink = { type: 'webhook', url: 'https://example.invalid' };
  assert.throws(() => f.resolve(), /watch: webhook sink is not a board/);
  assert.doesNotThrow(() => f.resolve('flush'));
  assert.doesNotThrow(() => f.resolve('emit'));
});

test('watch role and interval flags override config before startup validation', t => {
  const f = fixture(t, { watch: { role: 'watcher', interval_sec: 0 } });
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(f.config));
  const result = resolveConfig({ home: f.home, role: 'agent-host', interval: 10 }, {}, { command: 'watch' });
  assert.equal(result.config.watch.role, 'agent-host');
  assert.equal(result.config.watch.interval_sec, 10);
  assert.throws(() => resolveConfig({ home: f.home, role: 'unknown' }, {}, { command: 'watch' }), /unknown watch role/);
});

test('watcher ids are normalized to the marker-safe agent alphabet', t => {
  const f = fixture(t, { host: 'VPS-ONE', watch: { role: 'agent-host' } });
  assert.equal(f.resolve().config.watch.watcher_id, 'vps-one');
  for (const watcher_id of ['vps one', 'bad=value', 'x'.repeat(65)]) {
    f.config.watch = { role: 'agent-host', watcher_id };
    assert.throws(() => f.resolve(), /watch: invalid watcher_id/);
  }
});

test('notify credentials load only from protected files and enter the mask list', t => {
  const f = fixture(t);
  const telegram = 'fixture.bot.value'; const slack = 'https://example.invalid/private-slack'; const header = 'key';
  f.config.notify = [{ type: 'telegram', bot_token_file: f.secret('telegram', telegram), token: 'ignored', chat_id: '123' },
    { type: 'slack', webhook_url_file: f.secret('slack', slack), webhook_url: 'ignored' },
    { type: 'webhook', url: 'https://example.invalid', headers_file: f.secret('headers', JSON.stringify({ 'X-Key': header })), headers: { 'X-Key': 'ignored' } }];
  const result = f.resolve();
  assert.equal(result.config.notify[0].token, telegram);
  assert.equal(result.config.notify[1].webhook_url, slack);
  assert.deepEqual(result.config.notify[2].headers, { 'X-Key': header });
  for (const value of [telegram, slack, header]) assert.ok(result.maskList.includes(value));
  f.config.notify = [{ type: 'telegram', token: telegram, chat_id: '123' }];
  assert.throws(() => f.resolve('watch', { TELEGRAM_BOT_TOKEN: telegram }), /credential file is required/);
  f.config.notify = [{ type: 'slack', webhook_url: slack }];
  assert.throws(() => f.resolve(), /credential file is required/);
});

test('shared credential reader accepts 0600 and 0400, rejects accessible or executable files with exact wording', t => {
  if (process.platform === 'win32') return;
  const f = fixture(t);
  for (const mode of [0o600, 0o400]) assert.equal(secretFile(f.secret('allowed-' + mode, 'fixture', mode)), 'fixture');
  for (const mode of [0o644, 0o640, 0o604, 0o700, 0o610, 0o601]) {
    const file = f.secret('denied-' + mode, 'fixture', mode);
    for (const command of ['flush', 'watch']) assert.throws(() => secretFile(file, { command }), error => {
      assert.equal(error.code, 'EPERM_TOKEN_FILE_MODE');
      assert.equal(error.message, command + ': EPERM_TOKEN_FILE_MODE: credential file must be 0600 or stricter (no group/other bits, no exec)');
      return true;
    });
    f.config.notify = [{ type: 'telegram', bot_token_file: file, chat_id: '123' }];
    assert.throws(() => f.resolve(), /EPERM_TOKEN_FILE_MODE/);
    assert.doesNotThrow(() => f.resolve('emit'));
  }
});

test('watch rejects malformed config, credentials and notify headers without exposing values', t => {
  const f = fixture(t);
  const cases = [
    { type: 'telegram', bot_token_file: f.secret('blank', ''), chat_id: '123' },
    { type: 'telegram', bot_token_file: f.secret('newline', 'first\nsecond'), chat_id: '123' },
    { type: 'slack', webhook_url_file: f.secret('invalid-url', 'secret-invalid-value') },
    { type: 'webhook', url: 'https://example.invalid', headers_file: f.secret('bad-json', '{') },
    { type: 'webhook', url: 'https://example.invalid', headers_file: f.secret('bad-header', JSON.stringify({ 'X-Key': 'first\nsecond' })) }
  ];
  for (const entry of cases) {
    f.config.notify = [entry];
    assert.throws(() => f.resolve(), error => /^watch: [^\n]+$/.test(error.message) && !error.message.includes('secret-invalid-value'));
  }
  fs.writeFileSync(path.join(f.home, 'config.json'), '{');
  assert.throws(() => resolveConfig({ home: f.home }, {}, { command: 'watch' }), /watch: cannot read valid config/);
});
