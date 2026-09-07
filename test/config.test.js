'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { resolveConfig, ConfigError } = require('../src/config');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-config-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = { schema: 1, sink: { type: 'github-issue', repo: 'test/inbox',
    token_file: path.join(home, 'missing-token') }, watch: { role: 'agent-host' } };
  return { home, config, resolve(command, env = {}) {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
    return resolveConfig({ home }, env, { command });
  } };
}

for (const command of ['flush', 'watch']) {
  for (const [name, mutate, message] of [
    ['notify webhook URL', config => { config.notify = [{ type: 'webhook', url: 'not a url' }]; }, 'invalid notify webhook URL'],
    ['sink API URL', config => { config.sink.api_base = 'ftp://x'; }, 'invalid sink URL'],
    ['GitHub repo', config => { config.sink.repo = 'bad'; }, 'invalid GitHub repo'],
    ['valid config', () => {}, 'cannot read credential file']
  ]) test(command + ': ' + name + ' with a missing token file', t => {
    const f = fixture(t);
    mutate(f.config);
    assert.throws(() => f.resolve(command), { constructor: ConfigError, message: command + ': ' + message });
  });

  test(command + ': invalid Telegram chat_id precedes a missing bot token setting', t => {
    const f = fixture(t);
    f.config.notify = [{ type: 'telegram', chat_id: '' }];
    assert.throws(() => f.resolve(command, { ERRMETER_GITHUB_TOKEN: 'tok-fixture' }),
      { constructor: ConfigError, message: command + ': invalid Telegram chat_id' });
  });

  test(command + ': Slack webhook URL is validated after reading its file', t => {
    const f = fixture(t);
    const webhookFile = path.join(f.home, 'slack-webhook');
    fs.writeFileSync(webhookFile, 'not a url', { mode: 0o600 });
    f.config.notify = [{ type: 'slack', webhook_url_file: webhookFile }];
    assert.throws(() => f.resolve(command, { ERRMETER_GITHUB_TOKEN: 'tok-fixture' }),
      { constructor: ConfigError, message: command + ': invalid Slack webhook URL' });
  });

  test(command + ': invalid notify URL precedes unsafe token permissions', { skip: process.platform === 'win32' }, t => {
    const f = fixture(t);
    fs.writeFileSync(f.config.sink.token_file, 'tok-fixture', { mode: 0o644 });
    fs.chmodSync(f.config.sink.token_file, 0o644);
    f.config.notify = [{ type: 'webhook', url: 'not a url' }];
    assert.throws(() => f.resolve(command),
      { constructor: ConfigError, message: command + ': invalid notify webhook URL' });
    f.config.notify = [];
    assert.throws(() => f.resolve(command), { constructor: ConfigError, code: 'EPERM_TOKEN_FILE_MODE' });
  });

  test(command + ': later notify settings precede an earlier notify secret', t => {
    const f = fixture(t);
    f.config.sink = { type: 'file' };
    f.config.notify = [{ type: 'slack', webhook_url_file: path.join(f.home, 'missing-slack') },
      { type: 'webhook', url: 'not a url' }];
    assert.throws(() => f.resolve(command),
      { constructor: ConfigError, message: command + ': invalid notify webhook URL' });
  });
}

test('flush: webhook sink URL precedes its missing headers file', t => {
  const f = fixture(t);
  f.config.sink = { type: 'webhook', url: 'ftp://x', headers_file: path.join(f.home, 'missing-headers') };
  assert.throws(() => f.resolve('flush'), { constructor: ConfigError, message: 'flush: invalid sink URL' });
});
