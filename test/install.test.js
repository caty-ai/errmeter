'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { install, uninstall, registrationStatus, artefactLeftBehind } = require('../src/install');
const launchd = require('../src/platform/launchd');
const systemd = require('../src/platform/systemd');
const schtasks = require('../src/platform/schtasks');

function context(role, scope) {
  return { role, scope, home: '/home/test/.errmeter', configPath: '/home/test/.errmeter/config.json', homedir: '/home/test',
    uid: 501, env: {}, nodePath: '/usr/bin/node', binPath: '/opt/errmeter/bin/errmeter.js' };
}
for (const role of ['watcher', 'agent-host']) for (const scope of ['user', 'system']) {
  test('launchd deterministic snapshot: ' + role + '/' + scope, () => {
    const spec = launchd.plan(context(role, scope));
    assert.equal(launchd.render(context(role, scope)), spec.content);
    assert.equal(spec.content, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n' +
      '  <key>Label</key><string>ai.caty.errmeter.' + role + '</string>\n  <key>ProgramArguments</key>\n  <array>\n' +
      '    <string>/usr/bin/node</string>\n    <string>/opt/errmeter/bin/errmeter.js</string>\n    <string>watch</string>\n    <string>--role</string>\n    <string>' + role + '</string>\n' +
      '    <string>--home</string>\n    <string>/home/test/.errmeter</string>\n    <string>--config</string>\n    <string>/home/test/.errmeter/config.json</string>\n' +
      '  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n' +
      '  <key>EnvironmentVariables</key>\n  <dict><key>ERRMETER_HOME</key><string>/home/test/.errmeter</string></dict>\n' +
      '  <key>WorkingDirectory</key><string>/home/test/.errmeter</string>\n' +
      '  <key>StandardOutPath</key><string>/home/test/.errmeter/logs/watch.out.log</string>\n' +
      '  <key>StandardErrorPath</key><string>/home/test/.errmeter/logs/watch.err.log</string>\n</dict>\n</plist>\n');
    assert.equal(spec.artefactPath, (scope === 'system' ? '/Library/LaunchDaemons/' : '/home/test/Library/LaunchAgents/') + spec.label + '.plist');
    assert.deepEqual(spec.install, [{ command: 'launchctl', args: ['bootstrap', scope === 'system' ? 'system' : 'gui/501', spec.artefactPath] }]);
  });
  test('systemd deterministic snapshot: ' + role + '/' + scope, () => {
    const spec = systemd.plan(context(role, scope));
    assert.equal(systemd.render(context(role, scope)), spec.content);
    assert.equal(spec.content, '[Unit]\nDescription=errmeter ' + role + '\nAfter=network.target\n\n[Service]\nType=simple\nExecStart="/usr/bin/node" "/opt/errmeter/bin/errmeter.js" "watch" "--role" "' + role + '" "--home" "/home/test/.errmeter" "--config" "/home/test/.errmeter/config.json"\nRestart=always\nRestartSec=5\nEnvironment="ERRMETER_HOME=/home/test/.errmeter"\nWorkingDirectory=/home/test/.errmeter\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=' + (scope === 'system' ? 'multi-user.target' : 'default.target') + '\n');
    assert.equal(spec.artefactPath, (scope === 'system' ? '/etc/systemd/system/' : '/home/test/.config/systemd/user/') + spec.label);
    assert.deepEqual(spec.install[1].args, [...(scope === 'system' ? [] : ['--user']), 'enable', '--now', spec.label]);
  });
  test('schtasks deterministic snapshot: ' + role + '/' + scope, () => {
    const spec = schtasks.plan({ ...context(role, scope), home: 'C:\\Users\\test\\.errmeter', configPath: 'C:\\Users\\test\\.errmeter\\config.json', nodePath: 'C:\\Program Files\\nodejs\\node.exe', binPath: 'C:\\errmeter\\bin\\errmeter.js' });
    assert.equal(spec.content, '@echo off\r\nrem Task Scheduler default execution limit is 72 hours; adjust it for continuous operation.\r\nsetlocal DisableDelayedExpansion\r\nset "ERRMETER_HOME=C:\\Users\\test\\.errmeter"\r\n:retry\r\n"C:\\Program Files\\nodejs\\node.exe" "C:\\errmeter\\bin\\errmeter.js" "watch" "--role" "' + role + '" "--home" "C:\\Users\\test\\.errmeter" "--config" "C:\\Users\\test\\.errmeter\\config.json"\r\ntimeout /t 5 /nobreak >nul 2>&1\r\nif errorlevel 1 ping -n 6 127.0.0.1 >nul 2>&1\r\ngoto retry\r\n');
    assert.equal(spec.artefactPath, (scope === 'system' ? 'C:\\ProgramData\\errmeter' : 'C:\\Users\\test\\.errmeter') + '\\errmeter-' + role + '.cmd');
    assert.equal(spec.install[0].args[4], 'cmd.exe /d /v:off /s /c ""' + spec.artefactPath + '""');
    assert.deepEqual(spec.install[0].args.slice(5), ['/SC', scope === 'system' ? 'ONSTART' : 'ONLOGON', ...(scope === 'system' ? ['/RU', 'SYSTEM'] : []), '/RL', 'LIMITED', '/F']);
  });
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-install-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, '.errmeter'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ schema: 1, sink: { type: 'file' }, watch: { role: 'agent-host', dispatch: { command: ['/usr/bin/true'] } } }));
  const calls = []; const output = []; const errors = [];
  const io = { platform: 'darwin', homedir: root, username: 'test-user', uid: 501, stdout: text => output.push(text), stderr: text => errors.push(text),
    runner: { async exec(command, args) { calls.push({ command, args }); return args[0] === 'print' ? { code: 113, stderr: 'Could not find service' } : { code: 0 }; } } };
  return { root, home, env: { ERRMETER_HOME: home }, calls, output, errors, io };
}
test('artefact-left-behind clauses are platform-specific', () => {
  assert.equal(artefactLeftBehind({ platform: 'darwin', scope: 'user' }), '; launchd re-bootstraps it at next login — remove it by hand');
  assert.equal(artefactLeftBehind({ platform: 'darwin', scope: 'system' }), '; launchd re-bootstraps it at next boot — remove it by hand');
  assert.equal(artefactLeftBehind({ platform: 'darwin' }), '; launchd re-bootstraps it at next login — remove it by hand');
  assert.equal(artefactLeftBehind({ platform: 'linux', scope: 'user' }), "; the unit is disabled but its file remains — remove it by hand, then run 'systemctl --user daemon-reload'");
  assert.equal(artefactLeftBehind({ platform: 'linux', scope: 'system' }), "; the unit is disabled but its file remains — remove it by hand, then run 'systemctl daemon-reload'");
  assert.equal(artefactLeftBehind({ platform: 'linux' }), "; the unit is disabled but its file remains — remove it by hand, then run 'systemctl --user daemon-reload'");
  assert.equal(artefactLeftBehind({ platform: 'win32' }), '; the task is deleted but the wrapper file remains — remove it by hand');
  assert.equal(artefactLeftBehind({ platform: 'other' }), '; remove it by hand');
});

async function installedArtefactFailure(t, platform, scope, afterRemoveFails = false, statAfterUnlinkCode) {
  const f = fixture(t); const artifacts = new Map(); const calls = [];
  let artefactPath; let rejectArtefactRemoval = false; let artefactUnlinkFailed = false; let registered = false; let removedRegistration = false;
  const disk = {
    readFileSync(file) { if (!artifacts.has(file)) throw Object.assign(new Error(), { code: 'ENOENT' }); return artifacts.get(file); },
    lstatSync(file) {
      if (artefactUnlinkFailed && file === artefactPath && statAfterUnlinkCode) throw Object.assign(new Error('private-stat-failure'), { code: statAfterUnlinkCode });
      if (!artifacts.has(file)) throw Object.assign(new Error(), { code: 'ENOENT' });
      return {};
    },
    mkdirSync() {},
    writeFileSync(file, content, options) { assert.equal(options.flag, 'wx'); artifacts.set(file, content); },
    renameSync(from, to) { artifacts.set(to, artifacts.get(from)); artifacts.delete(from); },
    unlinkSync(file) {
      if (rejectArtefactRemoval && file === artefactPath) {
        artefactUnlinkFailed = true;
        throw Object.assign(new Error('private-failure'), { code: 'EPERM' });
      }
      if (!artifacts.has(file)) throw Object.assign(new Error(), { code: 'ENOENT' });
      artifacts.delete(file);
    }
  };
  const runner = { async exec(command, args) {
    calls.push({ command, args });
    if (command === 'launchctl') {
      if (args[0] === 'print') return registered ? { code: 0, stdout: 'pid = 123' } : { code: 113, stderr: 'Could not find service' };
      if (args[0] === 'bootstrap') registered = true;
      if (args[0] === 'bootout') { registered = false; removedRegistration = true; }
    } else if (command === 'systemctl') {
      if (args.includes('is-enabled')) return registered ? { code: 0 } : { code: 4, stdout: 'not-found' };
      if (args.includes('is-active')) return { code: registered ? 0 : 4 };
      if (args.includes('show')) return { code: 0, stdout: 'MainPID=123' };
      if (args.includes('enable')) registered = true;
      if (args.includes('disable')) { registered = false; removedRegistration = true; }
      if (afterRemoveFails && removedRegistration && args.includes('daemon-reload')) return { code: 1 };
    } else if (command === 'schtasks') {
      if (args[0] === '/Query') return registered ? { code: 0, stdout: 'Status: Running' } : { code: 1, stderr: 'not found' };
      if (args[0] === '/Create') registered = true;
      if (args[0] === '/Delete') { registered = false; removedRegistration = true; }
    }
    return { code: 0 };
  } };
  const args = [...(scope === 'system' ? ['--system'] : []), '--json'];
  const io = { ...f.io, platform, uid: scope === 'system' ? 0 : 501, isElevated: true, systemdVersion: 240, fs: disk, runner };
  assert.equal(await install(args, f.env, io), 0);
  const installed = JSON.parse(f.output.pop()); artefactPath = installed.artefactPath; rejectArtefactRemoval = true;
  return { ...f, artifacts, calls, io, args, installed, recordPath: path.join(f.home, 'state/install.json') };
}

for (const [platform, scope, clause] of [
  ['darwin', 'user', '; launchd re-bootstraps it at next login — remove it by hand'],
  ['darwin', 'system', '; launchd re-bootstraps it at next boot — remove it by hand'],
  ['linux', 'user', "; the unit is disabled but its file remains — remove it by hand, then run 'systemctl --user daemon-reload'"],
  ['linux', 'system', "; the unit is disabled but its file remains — remove it by hand, then run 'systemctl daemon-reload'"],
  ['win32', 'user', '; the task is deleted but the wrapper file remains — remove it by hand'],
  ['win32', 'system', '; the task is deleted but the wrapper file remains — remove it by hand']
]) test('uninstall reports retained ' + platform + '/' + scope + ' artefact precisely', async t => {
  const f = await installedArtefactFailure(t, platform, scope);
  assert.equal(await uninstall(f.args, f.env, f.io), 3);
  const result = JSON.parse(f.output.pop());
  assert.equal(result.status, 'failed');
  assert.ok(result.reason.startsWith('artefact still present at ' + f.installed.artefactPath + ': '));
  assert.ok(result.reason.endsWith(clause));
  assert.equal(result.reason, 'artefact still present at ' + f.installed.artefactPath + ': platform or filesystem operation failed (EPERM)' + clause);
  assert.equal(f.artifacts.has(f.recordPath), true);
  if (platform === 'linux' && scope === 'user') {
    const disable = f.calls.findIndex(call => call.args.includes('disable'));
    const reload = f.calls.findLastIndex(call => call.args.includes('daemon-reload'));
    assert.deepEqual(f.calls[disable].args, ['--user', 'disable', '--now', f.installed.label]);
    assert.deepEqual(f.calls[reload].args, ['--user', 'daemon-reload']);
    assert.ok(disable < reload);
  }
});

test('uninstall preserves the artefact failure when lstat after unlink also fails', async t => {
  const f = await installedArtefactFailure(t, 'linux', 'user', false, 'EACCES');
  assert.equal(await uninstall(f.args, f.env, f.io), 3);
  const result = JSON.parse(f.output.pop());
  assert.equal(result.status, 'failed');
  assert.ok(result.reason.startsWith('artefact still present at ' + f.installed.artefactPath + ': platform or filesystem operation failed (EPERM)'));
  assert.ok(result.reason.endsWith("; the unit is disabled but its file remains — remove it by hand, then run 'systemctl --user daemon-reload'"));
  assert.equal(result.reason.includes('EACCES'), false);
  assert.equal(result.reason.includes('private-stat-failure'), false);
  assert.equal(f.artifacts.has(f.recordPath), true);
  const disable = f.calls.findIndex(call => call.args.includes('disable'));
  const reload = f.calls.findLastIndex(call => call.args.includes('daemon-reload'));
  assert.deepEqual(f.calls[reload].args, ['--user', 'daemon-reload']);
  assert.ok(disable < reload);
});

test('uninstall reports afterRemove failure without losing the retained-artefact reason', async t => {
  const f = await installedArtefactFailure(t, 'linux', 'user', true);
  assert.equal(await uninstall(f.args, f.env, f.io), 3);
  const result = JSON.parse(f.output.pop());
  assert.equal(result.status, 'failed');
  assert.ok(result.reason.startsWith('artefact still present at ' + f.installed.artefactPath + ': '));
  assert.ok(result.reason.endsWith('; also: registration command failed'));
  assert.equal(result.reason, 'artefact still present at ' + f.installed.artefactPath + ': platform or filesystem operation failed (EPERM)' +
    "; the unit is disabled but its file remains — remove it by hand, then run 'systemctl --user daemon-reload'; also: registration command failed");
  assert.equal(f.artifacts.has(f.recordPath), true);
});

test('tokenless uninstall and previews retain strict real install validation', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({ schema: 1, sink: {
    type: 'github-issue', repo: 'test/inbox', token_file: path.join(f.home, 'missing-token')
  }, watch: { role: 'agent-host' } }));
  for (const args of [[], ['--role', 'agent-host', '--user']]) {
    for (const action of [install, uninstall]) {
      assert.equal(await action([...args, '--dry-run', '--json'], f.env, f.io), 0);
      const preview = JSON.parse(f.output.pop());
      if (action === install) assert.ok(preview.notes.includes('credential file not found; install will need it'));
    }
    assert.equal(await uninstall([...args, '--json'], f.env, f.io), 0);
  }
  assert.equal(await install(['--json'], f.env, f.io), 3);
  assert.equal(JSON.parse(f.output.pop()).reason, 'watch: cannot read credential file');
});

for (const corrupt of ['{', JSON.stringify({ schema: 2 })]) test('invalid config and corrupt record require explicit role and scope: ' + corrupt, async t => {
  const f = fixture(t); const recordPath = path.join(f.home, 'state/install.json');
  fs.mkdirSync(path.dirname(recordPath)); fs.writeFileSync(recordPath, '{');
  fs.writeFileSync(path.join(f.home, 'config.json'), corrupt);
  for (const args of [[], ['--role', 'agent-host'], ['--user']]) {
    assert.equal(await uninstall([...args, '--json'], f.env, f.io), 3);
    assert.equal(JSON.parse(f.output.pop()).reason, 'pass --role and --user|--system, or fix the config');
  }
  for (const action of [install, uninstall]) {
    assert.equal(await action(['--dry-run', '--role', 'agent-host', '--user', '--json'], f.env, f.io), action === install ? 3 : 0);
    assert.equal(JSON.parse(f.output.pop()).status, action === install ? 'failed' : 'dry-run');
    assert.equal(fs.readFileSync(recordPath, 'utf8'), '{');
  }
  assert.equal(await uninstall(['--role', 'agent-host', '--user', '--json'], f.env, f.io), 0);
  assert.equal(fs.existsSync(recordPath), false);
});

for (const registered of [false, true]) for (const code of ['ENOENT', 'EISDIR', 'EPERM']) test('uninstall record cleanup tolerates ' + code + ', registered=' + registered, async t => {
  const f = fixture(t);
  assert.equal(await install(['--json'], f.env, f.io), 0);
  const installed = JSON.parse(f.output.pop());
  if (!registered) fs.unlinkSync(installed.artefactPath);
  const recordPath = path.join(f.home, 'state/install.json');
  const io = { ...f.io, fs: new Proxy(fs, { get(target, key) {
    if (key === 'unlinkSync') return file => {
      if (file === recordPath) throw Object.assign(new Error('private-failure'), { code });
      return fs.unlinkSync(file);
    };
    return target[key];
  } }), runner: { async exec(command, args) { return { code: args[0] === 'print' && !registered ? 113 : 0 }; } } };
  assert.equal(await uninstall(['--json'], f.env, io), 0);
  const result = JSON.parse(f.output.pop());
  assert.equal(result.status, registered ? 'uninstalled' : 'not-installed');
  assert.equal(Boolean(result.notes?.some(note => note.includes('could not remove install record'))), code !== 'ENOENT');
  assert.ok(!JSON.stringify(result).includes('private-failure'));
  assert.equal(fs.existsSync(installed.artefactPath), false);
});

for (const ignored of [false, true]) test('stale record previews and precedes system privilege, ignored=' + ignored, async t => {
  const f = fixture(t);
  assert.equal(await install(['--json'], f.env, f.io), 0);
  f.output.pop();
  const recordPath = path.join(f.home, 'state/install.json');
  if (ignored) fs.writeFileSync(recordPath, '{');
  const bytes = fs.readFileSync(recordPath, 'utf8');
  const message = 'stale install record at ' + recordPath + '; run uninstall to clean up';
  assert.equal(await install(['--system', '--json'], f.env, f.io), 4);
  assert.equal(JSON.parse(f.output.pop()).message, message);
  const denyWrites = new Proxy(fs, { get(target, key) {
    if (/write|mkdir|unlink|rename|open/i.test(key)) return () => assert.fail('dry-run write');
    return target[key];
  } });
  assert.equal(await install(['--system', '--dry-run', '--json'], f.env, { ...f.io, uid: 501, fs: denyWrites }), 0);
  const result = JSON.parse(f.output.pop());
  assert.equal(result.status, 'dry-run'); assert.ok(result.artefact.content); assert.ok(result.notes.includes(message));
  assert.equal(fs.readFileSync(recordPath, 'utf8'), bytes);
});

test('readable stale record refuses real install but validates preview config', async t => {
  const f = fixture(t);
  assert.equal(await install(['--json'], f.env, f.io), 0);
  f.output.pop();
  const recordPath = path.join(f.home, 'state/install.json');
  const bytes = fs.readFileSync(recordPath, 'utf8');
  fs.writeFileSync(path.join(f.home, 'config.json'), '{');
  const message = 'stale install record at ' + recordPath + '; run uninstall to clean up';
  assert.equal(await install(['--dry-run', '--json'], f.env, f.io), 3);
  const result = JSON.parse(f.output.pop());
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'watch: cannot read valid config');
  assert.equal(await install(['--json'], f.env, f.io), 4);
  assert.equal(JSON.parse(f.output.pop()).message, message);
  assert.equal(fs.readFileSync(recordPath, 'utf8'), bytes);
});

for (const [name, mutate] of [
  ['dispatch', config => { config.watch.role = 'watcher'; }],
  ['renew', config => { config.watch.renew_sec = 899; }],
  ['unknown sink', config => { config.sink.type = 'unknown'; }],
  ['webhook sink', config => { config.sink.type = 'webhook'; }],
  ['watcher id', config => { config.watch.watcher_id = 'invalid id'; }],
  ['budget', config => { config.watch.role = 'watcher'; config.watch.dispatch = { command: ['true'] }; config.max_api_calls_per_pass = 1; }]
]) test('install preview rejects invalid ' + name + ' before credential fallback', async t => {
  const f = fixture(t);
  const config = { schema: 1, sink: { type: 'github-issue', repo: 'test/inbox', token_file: path.join(f.home, 'missing') }, watch: { role: 'agent-host' } };
  mutate(config);
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(config));
  for (const env of [f.env, { ...f.env, ERRMETER_GITHUB_TOKEN: 'test-token' }]) {
    assert.equal(await install(['--json'], env, f.io), 3);
    const real = JSON.parse(f.output.pop());
    assert.equal(await install(['--dry-run', '--json'], env, f.io), 3);
    const preview = JSON.parse(f.output.pop());
    assert.equal(preview.status, 'failed');
    assert.equal(preview.reason, real.reason);
  }
  assert.equal(f.calls.length, 0);
});

for (const [name, mutate, reason] of [
  ['notify webhook URL', config => { config.notify = [{ type: 'webhook', url: 'not a url' }]; }, 'watch: invalid notify webhook URL'],
  ['sink URL', config => { config.sink.api_base = 'ftp://x'; }, 'watch: invalid sink URL'],
  ['GitHub repo', config => { config.sink.repo = 'bad'; }, 'watch: invalid GitHub repo']
]) test('tokenless install preview rejects an invalid ' + name, async t => {
  const f = fixture(t);
  const config = { schema: 1, sink: {
    type: 'github-issue', repo: 'test/inbox', token_file: path.join(f.home, 'missing-token')
  }, watch: { role: 'agent-host' } };
  mutate(config);
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(config));
  assert.equal(await install(['--role', 'agent-host', '--user', '--dry-run', '--json'], f.env, f.io), 3);
  const result = JSON.parse(f.output.pop());
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, reason);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(path.join(f.home, 'state/install.json')), false);
});

test('install preview rejects an unconfigured credential file', async t => {
  const f = fixture(t);
  for (const config of [
    { schema: 1, sink: { type: 'github-issue', repo: 'test/inbox' }, watch: { role: 'agent-host' } },
    { schema: 1, sink: { type: 'file' }, watch: { role: 'agent-host' }, notify: [{ type: 'telegram', chat_id: '1' }] }
  ]) {
    fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify(config));
    for (const args of [['--dry-run', '--json'], ['--json']]) {
      assert.equal(await install(args, f.env, f.io), 3);
      assert.equal(JSON.parse(f.output.pop()).reason, 'watch: credential file is required');
    }
  }
});

test('install preview credential fallback matches only a missing credential file', async t => {
  const f = fixture(t); const { ConfigError, resolveConfig } = require('../src/config');
  for (const [message, code, expected] of [
    ['watch: cannot read credential file', undefined, 0],
    ['watch: credential file is required', undefined, 3],
    ['watch: cannot read credential file', 'EPERM_TOKEN_FILE_MODE', 3],
    ['watch: credential must be a regular file', undefined, 3],
    ['watch: missing or invalid GitHub credential', undefined, 3],
    ['watch: invalid notify type', undefined, 3]
  ]) {
    const io = { ...f.io, resolveConfig(flags, env, options) {
      if (options.command === 'watch') throw Object.assign(new ConfigError(message), { code });
      return resolveConfig(flags, env, options);
    } };
    assert.equal(await install(['--dry-run', '--json'], f.env, io), expected);
    const result = JSON.parse(f.output.pop());
    if (expected === 0) assert.deepEqual(result.notes, ['credential file not found; install will need it']);
    else assert.equal(result.reason, message);
  }
});

test('install preview rejects unsafe credential permissions', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); const tokenFile = path.join(f.home, 'token');
  fs.writeFileSync(tokenFile, 'private-token', { mode: 0o644 });
  fs.chmodSync(tokenFile, 0o644);
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({ schema: 1, sink: { type: 'github-issue', repo: 'test/inbox', token_file: tokenFile }, watch: { role: 'agent-host' } }));
  assert.equal(await install(['--dry-run', '--json'], f.env, f.io), 3);
  assert.match(JSON.parse(f.output.pop()).reason, /EPERM_TOKEN_FILE_MODE/);
  assert.equal(f.calls.length, 0);
});

test('registered record refuses dry-run before config resolution', async t => {
  const f = fixture(t);
  assert.equal(await install(['--json'], f.env, f.io), 0); f.output.pop();
  fs.writeFileSync(path.join(f.home, 'config.json'), '{');
  assert.equal(await install(['--dry-run', '--json'], f.env, { ...f.io,
    resolveConfig: () => assert.fail('registered refusal must precede config resolution'),
    runner: { async exec() { return { code: 0 }; } } }), 4);
  assert.equal(JSON.parse(f.output.pop()).status, 'already-installed; uninstall first');
});

test('uninstall artefact cleanup tolerates ENOENT', async t => {
  const f = fixture(t);
  assert.equal(await install(['--json'], f.env, f.io), 0);
  const installed = JSON.parse(f.output.pop()); const calls = [];
  const io = { ...f.io, fs: new Proxy(fs, { get(target, key) {
    if (key === 'unlinkSync') return file => {
      if (file === installed.artefactPath) {
        fs.unlinkSync(file);
        throw Object.assign(new Error('private-failure'), { code: 'ENOENT' });
      }
      return fs.unlinkSync(file);
    };
    return target[key];
  } }), runner: { async exec(command, args) { calls.push(args); return { code: 0 }; } } };
  assert.equal(await uninstall(['--json'], f.env, io), 0);
  const result = JSON.parse(f.output.pop());
  assert.equal(result.status, 'uninstalled');
  assert.ok(calls.some(args => args[0] === 'bootout'));
  assert.ok(!JSON.stringify(result).includes('private-failure'));
  assert.equal(fs.existsSync(installed.artefactPath), false);
  assert.equal(fs.existsSync(path.join(f.home, 'state/install.json')), false);
});

for (const code of ['EPERM', 'EACCES']) test('uninstall artefact cleanup fails while ' + code + ' leaves it present', async t => {
  const f = fixture(t);
  assert.equal(await install(['--json'], f.env, f.io), 0);
  const installed = JSON.parse(f.output.pop()); const calls = [];
  const recordPath = path.join(f.home, 'state/install.json');
  let registered = true;
  const io = { ...f.io, fs: new Proxy(fs, { get(target, key) {
    if (key === 'unlinkSync') return file => {
      if (file === installed.artefactPath) throw Object.assign(new Error('private-failure'), { code });
      return fs.unlinkSync(file);
    };
    return target[key];
  } }), runner: { async exec(command, args) {
    calls.push(args);
    if (args[0] === 'print') return { code: registered ? 0 : 113 };
    if (args[0] === 'bootout') registered = false;
    return { code: 0 };
  } } };
  const reason = 'artefact still present at ' + installed.artefactPath + ': platform or filesystem operation failed (' + code + '); launchd re-bootstraps it at next login — remove it by hand';
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(await uninstall(['--json'], f.env, io), 3);
    const result = JSON.parse(f.output.pop());
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, reason);
    assert.equal(fs.existsSync(installed.artefactPath), true);
    assert.equal(fs.existsSync(recordPath), true);
    assert.ok(!JSON.stringify(result).includes('private-failure'));
  }
  assert.equal(calls.filter(args => args[0] === 'bootout').length, 1);
});

test('uninstall recovery guidance has a single command prefix per text line', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'config.json'), '{');
  assert.equal(await uninstall([], f.env, f.io), 3);
  assert.equal(f.errors.join(''), 'uninstall: pass --role and --user|--system, or fix the config\n');
  assert.equal(f.output.join(''), 'uninstall: failed: pass --role and --user|--system, or fix the config\n');
});

test('recorded system uninstall asserts elevation exactly once before writes', async t => {
  const f = fixture(t);
  const artifacts = new Map(); let assertions = 0;
  const disk = {
    readFileSync(file) { if (!artifacts.has(file)) throw Object.assign(new Error(), { code: 'ENOENT' }); return artifacts.get(file); },
    lstatSync() { throw Object.assign(new Error(), { code: 'ENOENT' }); },
    unlinkSync(file) { assert.equal(assertions, 1); artifacts.delete(file); }
  };
  const recordPath = path.join(f.home, 'state/install.json');
  artifacts.set(recordPath, JSON.stringify({ schema: 1, platform: 'win32', role: 'agent-host', scope: 'system',
    label: 'errmeter-agent-host', artefactPath: 'C:\\ProgramData\\errmeter\\errmeter-agent-host.cmd',
    nodePath: 'C:\\node.exe', binPath: 'C:\\errmeter.js', installedAt: new Date().toISOString() }));
  assert.equal(await uninstall(['--json'], f.env, { ...f.io, platform: 'win32', fs: disk,
    isElevated: () => { assertions++; return true; },
    runner: { async exec() { return { code: 1, stderr: 'not found' }; } } }), 0);
  assert.equal(assertions, 1); assert.equal(artifacts.size, 0);
});
test('dry-run previews commands and artefact without any filesystem writes or runner calls', async t => {
  const f = fixture(t);
  const denyWrites = new Proxy(fs, { get(target, name) { if (/write|mkdir|unlink|rename|open/i.test(name)) return () => { throw new Error('write attempted'); }; return target[name]; } });
  assert.equal(await install(['--dry-run', '--json'], { ...f.env, ERRMETER_GITHUB_TOKEN: 'secret.token.never.render' }, { ...f.io, fs: denyWrites }), 0);
  const result = JSON.parse(f.output.join(''));
  assert.equal(result.status, 'dry-run'); assert.match(result.artefact.content, /--config/);
  assert.equal(result.commands[0].command, 'launchctl'); assert.equal(f.calls.length, 0);
  assert.ok(!f.output.join('').includes('secret.token.never.render'));
  assert.ok(!fs.existsSync(path.join(f.root, 'Library')));
});
test('Linux dry-run reports an unknown version when the read-only probe is unavailable', async t => {
  const f = fixture(t);
  const denyWrites = new Proxy(fs, { get(target, name) { if (/write|mkdir|unlink|rename|open/i.test(name)) return () => { throw new Error('write attempted'); }; return target[name]; } });
  const io = { ...f.io, platform: 'linux', fs: denyWrites, runner: { exec: () => { throw new Error('runner invoked'); } } };
  assert.equal(await install(['--dry-run', '--json'], f.env, io), 0);
  const result = JSON.parse(f.output.join(''));
  assert.match(result.artefact.content, /StandardOutput=journal/);
  assert.equal(result.notes[0], '# systemd version unknown — StandardOutput shown as journal');
  assert.equal(result.commands[0].args.at(-1), 'daemon-reload');
});
test('install refuses overwrite; uninstall removes exact suffixed registration and is idempotent', async t => {
  const f = fixture(t); f.env.ERRMETER_INSTALL_LABEL_SUFFIX = 'test-6';
  assert.equal(await install(['--json'], f.env, f.io), 0);
  const spec = JSON.parse(f.output[0]); assert.match(spec.artefactPath, /ai\.caty\.errmeter\.agent-host\.test-6\.plist$/);
  assert.ok(fs.existsSync(spec.artefactPath));
  assert.equal(await install([], f.env, f.io), 4);
  f.io.runner.exec = async (command, args) => { f.calls.push({ command, args }); return { code: 0, stdout: 'state = running\npid = 123' }; };
  assert.equal((await registrationStatus({}, f.env, f.io)).running, 123);
  assert.equal(await uninstall([], f.env, f.io), 0);
  assert.ok(!fs.existsSync(spec.artefactPath));
  assert.ok(f.calls.some(call => call.args[0] === 'bootout' && call.args[1] === 'gui/501/ai.caty.errmeter.agent-host.test-6'));
  f.io.runner.exec = async () => ({ code: 113 });
  assert.equal(await uninstall([], f.env, f.io), 0);
});
test('configuration and platform command failures return 3, never leak command output', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'config.json'), '{');
  assert.equal(await install([], f.env, f.io), 3); assert.equal(f.calls.length, 0);
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({ schema: 1, sink: { type: 'file' }, watch: { role: 'agent-host' } }));
  f.io.runner.exec = async () => ({ code: 1, stderr: 'secret.token.never.render' });
  assert.equal(await install([], f.env, f.io), 3);
  assert.ok(!f.errors.join('').includes('secret.token.never.render'));
  assert.equal(await install([], f.env, { ...f.io, platform: 'other' }), 3);
});
test('rendering escapes XML and systemd expansions and rejects unsafe suffixes', () => {
  const ctx = context('watcher', 'user');
  assert.match(launchd.render({ ...ctx, home: '/tmp/a&b' }), /a&amp;b/);
  assert.match(systemd.render({ ...ctx, home: '/tmp/%i$HOME' }), /%%i\$\$HOME/);
  assert.match(systemd.render({ ...ctx, home: '/tmp/trailing\\' }), /WorkingDirectory=\/tmp\/trailing\\\/\.\nStandardOutput=/);
  assert.match(systemd.render({ ...ctx, home: '/tmp/trailing ' }), /WorkingDirectory=\/tmp\/trailing \/\.\nStandardOutput=/);
  assert.throws(() => launchd.render({ ...ctx, env: { ERRMETER_INSTALL_LABEL_SUFFIX: '../oops' } }));
  assert.throws(() => schtasks.render({ ...ctx, home: 'C:\\100% done!' }), /unsupported scheduled task path/);
  assert.match(schtasks.render({ ...ctx, home: 'C:\\safe!home' }), /set "ERRMETER_HOME=C:\\safe!home"/);
});
test('platform modules expose the same registration interface', () => {
  for (const adapter of [launchd, systemd, schtasks]) {
    for (const key of ['label', 'artefactPath', 'render', 'install', 'uninstall', 'status']) assert.equal(typeof adapter[key], 'function');
    assert.equal(typeof adapter.render(context('agent-host', 'user')), 'string');
  }
});
test('launchd uses compatibility commands only when modern subcommands are unavailable', async () => {
  const spec = context('watcher', 'user'); const calls = [];
  const runner = { async exec(command, args) { calls.push(args); return ['bootstrap', 'bootout', 'print'].includes(args[0])
    ? { code: 1, stderr: 'Unrecognized subcommand: ' + args[0] } : { code: 0, stdout: '"PID" = 987;' }; } };
  await launchd.install(spec, runner); await launchd.uninstall(spec, runner);
  assert.deepEqual(await launchd.status(spec, runner), { registered: true, running: 987 });
  assert.deepEqual(calls.map(args => args[0]), ['bootstrap', 'load', 'bootout', 'unload', 'print', 'list']);
  calls.length = 0;
  await assert.rejects(launchd.install(spec, { async exec(command, args) { calls.push(args); return { code: 5, stderr: 'Input/output error' }; } }));
  assert.equal(calls.length, 1);
  assert.deepEqual(await launchd.status(spec, { exec: async () => ({ code: 0, stdout: '456\t0\tai.caty.errmeter.watcher\n' }) }), { registered: true, running: 456 });
});
test('systemd detects log support, handles disabled registrations, and exposes MainPID', async () => {
  const spec = context('agent-host', 'user'); const calls = [];
  const runner = { async exec(command, args) {
    calls.push(args);
    if (args[0] === '--version') return { code: 0, stdout: 'systemd 240 (240.1)' };
    if (args.includes('is-enabled')) return { code: 1, stdout: 'disabled\n' };
    if (args.includes('show')) return { code: 0, stdout: 'MainPID=1234\n' };
    return { code: 0, stdout: 'active\n' };
  } };
  await systemd.prepare(spec, runner);
  assert.match(systemd.render(spec), /StandardOutput=append:\/home\/test\/\.errmeter\/logs\/watch.out.log\n/);
  assert.match(systemd.render({ ...spec, systemdVersion: 239 }), /StandardOutput=journal\nStandardError=journal/);
  await systemd.install(spec, runner); await systemd.uninstall(spec, runner);
  assert.deepEqual(await systemd.status(spec, runner), { registered: true, running: 1234 });
  assert.deepEqual(calls.slice(1, 4).map(args => args[1]), ['daemon-reload', 'enable', 'disable']);
  await assert.rejects(systemd.status(spec, { exec: async () => ({ code: 1, stderr: 'Access denied' }) }));
});
test('Windows registers only the task, deletes only that task, and distinguishes denied queries', async () => {
  const spec = context('agent-host', 'system'); const calls = [];
  const runner = { async exec(command, args) { calls.push(args); return { code: 0, stdout: 'Status: Running\r\n' }; } };
  await schtasks.install(spec, runner); await schtasks.uninstall(spec, runner);
  assert.deepEqual(calls.map(args => args[0]), ['/Create', '/Delete']);
  assert.equal((await schtasks.status(spec, runner)).running, true);
  assert.equal((await schtasks.status(spec, { exec: async () => ({ code: 1, stderr: 'The system cannot find the file specified.' }) })).registered, false);
  await assert.rejects(schtasks.status(spec, { exec: async () => ({ code: 1, stderr: 'Access is denied.' }) }));
});
test('registration failure removes its artefact and dry-uninstall writes nothing', async t => {
  const f = fixture(t);
  f.io.runner.exec = async (command, args) => args[0] === 'print' ? { code: 113 } : { code: 5 };
  assert.equal(await install([], f.env, f.io), 3);
  assert.equal(await install([], f.env, f.io), 3);
  const before = fs.readdirSync(path.join(f.root, 'Library/LaunchAgents'));
  assert.deepEqual(before, []);
  assert.equal(await uninstall(['--dry-run', '--json'], f.env, f.io), 0);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'Library/LaunchAgents')), before);
});
test('POSIX system registration refuses missing privileges before writes and tool actions', async t => {
  const f = fixture(t);
  for (const platform of ['darwin', 'linux']) for (const action of [install, uninstall]) {
    assert.equal(await action(['--system'], f.env, { ...f.io, platform, uid: 501,
      fs: new Proxy(fs, { get(target, key) { if (/write|mkdir|unlink|rename|open/i.test(key)) return () => assert.fail('write before privilege check'); return target[key]; } }) }), 3);
  }
  assert.equal(f.calls.length, 0);
});

for (const version of [239, 240, 256]) test('Linux dry-run matches installed unit on systemd ' + version, async t => {
  const f = fixture(t); const calls = [];
  const io = { ...f.io, platform: 'linux', runner: { async exec(command, args) {
    calls.push(args);
    if (args[0] === '--version') return { code: 0, stdout: 'systemd ' + version };
    if (args.includes('is-enabled')) return { code: 4, stdout: 'not-found' };
    if (args.includes('is-active')) return { code: 4 };
    return { code: 0 };
  } } };
  assert.equal(await install(['--dry-run', '--json'], f.env, io), 0);
  assert.deepEqual(calls, [['--version']]);
  const preview = JSON.parse(f.output.pop());
  assert.ok(preview.notes.includes("note: user services start at login; run 'loginctl enable-linger test-user' to start at boot"));
  assert.equal(fs.existsSync(preview.artefactPath), false);
  assert.match(preview.artefact.content, version >= 240 ? /StandardOutput=append:/ : /StandardOutput=journal/);
  assert.equal(await install(['--json'], f.env, io), 0);
  assert.ok(JSON.parse(f.output.pop()).notes.includes("note: user services start at login; run 'loginctl enable-linger test-user' to start at boot"));
  assert.equal(fs.readFileSync(preview.artefactPath, 'utf8'), preview.artefact.content);
});

test('unknown systemd version notes appear in text and JSON without leaking probe failures', async t => {
  const f = fixture(t);
  for (const result of [{ code: 0, stdout: 'unknown version' }, { code: 1, stderr: 'private-probe-output' }, null]) {
    const io = { ...f.io, platform: 'linux', runner: { async exec() {
      if (result) return result;
      throw Object.assign(new Error('private-probe-output'), { code: 'ENOENT' });
    } } };
    for (const args of [['--dry-run'], ['--dry-run', '--json']]) {
      f.output.length = 0;
      assert.equal(await install(args, f.env, io), 0);
      assert.match(f.output.join(''), /# systemd version unknown — StandardOutput shown as journal/);
      assert.ok(!f.output.join('').includes('private-probe-output'));
    }
  }
});

for (const platform of ['darwin', 'linux', 'win32']) test(platform + ' registration failure cleans artefact and permits retry', async t => {
  const f = fixture(t); const artifacts = new Map(); const calls = []; let fail = true;
  const fakeFs = {
    readFileSync(file) { if (!artifacts.has(file)) throw Object.assign(new Error(), { code: 'ENOENT' }); return artifacts.get(file); },
    lstatSync(file) { if (!artifacts.has(file)) throw Object.assign(new Error(), { code: 'ENOENT' }); return {}; },
    mkdirSync() {},
    writeFileSync(file, content, options) { assert.equal(options.flag, 'wx'); artifacts.set(file, content); },
    renameSync(from, to) { artifacts.set(to, artifacts.get(from)); artifacts.delete(from); },
    unlinkSync(file) { if (!artifacts.has(file)) throw Object.assign(new Error(), { code: 'ENOENT' }); artifacts.delete(file); }
  };
  const io = { ...f.io, platform, fs: fakeFs, systemdVersion: 240, runner: { async exec(command, args) {
    calls.push(args);
    if (args[0] === 'print') return { code: 113 };
    if (args[0] === '/Query') return { code: 1, stderr: 'not found' };
    if (args.includes('is-enabled')) return { code: 4, stdout: 'not-found' };
    if (args.includes('is-active')) return { code: 4 };
    if (fail && (args[0] === 'bootstrap' || args[0] === '/Create' || args.includes('enable'))) return { code: 5, stderr: 'private-command-output' };
    return { code: 0 };
  } } };
  assert.equal(await install(['--json'], f.env, io), 3);
  const result = JSON.parse(f.output.pop());
  assert.equal(result.rollback, 'removed-created-artefact');
  assert.equal(result.reason, platform === 'darwin' ? 'launchctl bootstrap failed' : platform === 'linux' ?
    'registration command failed: systemctl enable --now' : 'registration command failed: schtasks /Create');
  assert.equal(artifacts.size, 0);
  assert.ok(!JSON.stringify(result).includes('private-command-output'));
  if (platform === 'linux') assert.equal(calls.filter(args => args.includes('daemon-reload')).length, 2);
  fail = false;
  assert.equal(await install(['--json'], f.env, io), 0);
  assert.equal(artifacts.size, 2);
});

test('existing artefacts distinguish absent and present registrations without overwriting', async t => {
  const f = fixture(t);
  assert.equal(await install(['--json'], f.env, f.io), 0);
  const result = JSON.parse(f.output.pop()); const original = fs.readFileSync(result.artefactPath, 'utf8');
  fs.unlinkSync(path.join(f.home, 'state/install.json'));
  assert.equal(await install(['--json'], f.env, f.io), 4);
  const orphan = JSON.parse(f.output.pop());
  assert.equal(orphan.status, 'artefact-exists-unregistered');
  assert.equal(orphan.message, 'install: artefact exists at ' + result.artefactPath + ' but the service is not registered — run uninstall to clean up, then install');
  assert.equal(await install([], f.env, f.io), 4);
  assert.equal(f.output.pop(), orphan.message + '\n');
  f.io.runner.exec = async () => ({ code: 0 });
  assert.equal(await install(['--json'], f.env, f.io), 4);
  assert.equal(JSON.parse(f.output.pop()).status, 'already-installed; uninstall first');
  assert.equal(fs.readFileSync(result.artefactPath, 'utf8'), original);
});

test('failure causes are useful but never echo arbitrary tool errors in text or JSON', async t => {
  const f = fixture(t);
  f.io.runner.exec = async () => { throw Object.assign(new Error('private-command-output'), { code: 'ENOENT' }); };
  for (const args of [[], ['--json']]) {
    f.output.length = 0; f.errors.length = 0;
    assert.equal(await install(args, f.env, f.io), 3);
    assert.match(f.output.join(''), /ENOENT/);
    assert.ok(![...f.output, ...f.errors].join('').includes('private-command-output'));
  }
});

test('rollback errors are reported without masking the registration failure or leaking paths', async t => {
  const f = fixture(t);
  f.io.runner.exec = async (command, args) => args[0] === 'print' ? { code: 113 } : { code: 5 };
  const io = { ...f.io, fs: new Proxy(fs, { get(target, name) {
    if (name === 'unlinkSync') return () => { throw Object.assign(new Error('private-failure-path'), { code: 'EACCES' }); };
    return target[name];
  } }) };
  assert.equal(await install(['--json'], f.env, io), 3);
  const result = JSON.parse(f.output.pop());
  assert.equal(result.reason, 'launchctl bootstrap failed');
  assert.equal(result.rollback, 'failed');
  assert.match(result.rollbackReason, /EACCES/);
  assert.ok(fs.existsSync(result.artefactPath));
  assert.ok(!JSON.stringify(result).includes('private-failure-path'));
});

test('Windows system scope checks injected elevation before writes or task registration', async t => {
  const f = fixture(t);
  for (const action of [install, uninstall]) {
    assert.equal(await action(['--system', '--json'], f.env, { ...f.io, platform: 'win32', isElevated: false,
      fs: new Proxy(fs, { get(target, key) { if (/write|mkdir|unlink|rename|open/i.test(key)) return () => assert.fail('write before privilege check'); return target[key]; } }) }), 3);
    assert.match(JSON.parse(f.output.pop()).reason, /requires administrator/);
  }
  assert.equal(f.calls.length, 0);
  await schtasks.assertPrivilege({ scope: 'system', isElevated: async () => true }, f.io.runner);
  await schtasks.assertPrivilege({ scope: 'user', isElevated: false }, f.io.runner);
  assert.equal(f.calls.length, 0);
});

test('systemd rejects control whitespace and guards trailing whitespace only in WorkingDirectory', () => {
  for (const key of ['home', 'configPath', 'nodePath', 'binPath', 'homedir']) for (const char of ['\t', '\v', '\f', '\r', '\n']) {
    assert.throws(() => systemd.plan({ ...context('watcher', 'user'), [key]: '/tmp/a' + char + 'b' }), /unsupported systemd path whitespace/);
  }
  const rendered = systemd.render({ ...context('watcher', 'user'), home: '/tmp/a b ', systemdVersion: 240 });
  assert.match(rendered, /Environment="ERRMETER_HOME=\/tmp\/a b "\n/);
  assert.match(rendered, /WorkingDirectory=\/tmp\/a b \/\./);
  assert.match(rendered, /StandardOutput=append:\/tmp\/a b \/logs\/watch\.out\.log/);
  assert.match(rendered, /StandardError=append:\/tmp\/a b \/logs\/watch\.err\.log/);
  const trailingBackslash = systemd.render({ ...context('watcher', 'user'), home: '/tmp/trailing\\', systemdVersion: 240 });
  assert.ok(trailingBackslash.includes('Environment="ERRMETER_HOME=/tmp/trailing\\\\"\n'));
  assert.ok(trailingBackslash.includes('WorkingDirectory=/tmp/trailing\\/.\n'));
  assert.ok(trailingBackslash.includes('StandardOutput=append:/tmp/trailing\\/logs/watch.out.log\n'));
  assert.doesNotMatch(rendered, /[ \t]+$/m);
});

test('watcher configuration errors preserve dispatch.command guidance in text and JSON', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({ schema: 1, sink: { type: 'file' }, watch: { role: 'watcher' } }));
  assert.equal(await install([], f.env, f.io), 3);
  assert.match(f.output.pop(), /dispatch\.command/);
  assert.match(f.errors.pop(), /dispatch\.command/);
  assert.equal(await install(['--json'], f.env, f.io), 3);
  assert.match(JSON.parse(f.output.pop()).reason, /dispatch\.command/);
  assert.equal(f.calls.length, 0);
});

for (const recordState of ['schema-2', 'malformed', 'invalid', 'other-platform']) test(recordState + ' record warns and falls back for status and uninstall, but blocks install', async t => {
  const f = fixture(t);
  assert.equal(await install(['--json'], f.env, f.io), 0);
  const installed = JSON.parse(f.output.pop());
  const recordPath = path.join(f.home, 'state/install.json');
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  const bytes = recordState === 'malformed' ? '{' : JSON.stringify({ ...record, role: 'watcher',
    ...(recordState === 'schema-2' ? { schema: 2 } : recordState === 'other-platform' ? { platform: 'linux' } : { label: null }) });
  fs.writeFileSync(recordPath, bytes);
  let registered = true;
  f.io.runner.exec = async (command, args) => {
    f.calls.push({ command, args });
    if (args[0] === 'print') {
      assert.equal(args[1], 'gui/501/' + installed.label);
      return { code: registered ? 0 : 113, stdout: 'pid = 123' };
    }
    if (args[0] === 'bootout') {
      assert.equal(args[1], 'gui/501/' + installed.label);
      registered = false;
    }
    return { code: 0 };
  };
  const warning = 'install record unreadable or unsupported at ' + recordPath + ' — ignored';
  for (const healthy of [false, true]) {
    if (healthy) {
      for (const name of ['last_flush', 'last_watch']) fs.writeFileSync(path.join(f.home, 'state', name + '.json'), JSON.stringify({ ts: new Date().toISOString() }));
    }
    for (const args of [[], ['--json']]) {
      f.errors.length = 0;
      assert.equal(await require('../src/status').status(args, f.env, f.io), healthy ? 0 : 1);
      assert.ok(f.errors.includes(warning + '\n'));
      const output = f.output.pop();
      if (args.length) {
        const result = JSON.parse(output);
        assert.equal(result.role, 'agent-host');
        assert.equal(result.registration_record, null);
        assert.equal(result.watcher.registered, true);
        assert.ok(result.warnings.includes(warning));
      } else assert.match(output, /role=agent-host.*registration record: none/);
    }
  }
  const message = 'stale install record at ' + recordPath + '; run uninstall to clean up';
  assert.equal(await install([], f.env, f.io), 4);
  assert.equal(f.output.pop(), message + '\n');
  assert.equal(await install(['--json'], f.env, f.io), 4);
  assert.equal(JSON.parse(f.output.pop()).message, message);
  const configPath = path.join(f.home, 'config.json');
  const configBytes = fs.readFileSync(configPath, 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({ schema: 1, sink: { type: 'file' }, watch: { role: 'watcher' } }));
  for (const args of [[], ['--json']]) {
    assert.equal(await install(args, f.env, { ...f.io, resolveConfig: () => assert.fail('stale record must precede config validation') }), 4);
    const output = f.output.pop();
    assert.equal(args.length ? JSON.parse(output).message : output.trim(), message);
  }
  fs.writeFileSync(configPath, configBytes);
  assert.equal(fs.readFileSync(recordPath, 'utf8'), bytes);
  assert.equal(await uninstall(['--dry-run', '--json'], f.env, f.io), 0);
  assert.ok(JSON.parse(f.output.pop()).notes.includes(warning));
  assert.equal(fs.readFileSync(recordPath, 'utf8'), bytes);
  assert.equal(registered, true);
  assert.equal(await uninstall(['--json'], f.env, f.io), 0);
  assert.ok(JSON.parse(f.output.pop()).notes.includes(warning));
  assert.equal(registered, false);
  assert.equal(fs.existsSync(installed.artefactPath), false);
  assert.equal(fs.existsSync(recordPath), false);
});

test('recorded role and label survive config and suffix changes through status and uninstall', async t => {
  const f = fixture(t); f.env.ERRMETER_INSTALL_LABEL_SUFFIX = 'original';
  const configPath = path.join(f.home, 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.watch.role = 'watcher';
  fs.writeFileSync(configPath, JSON.stringify(config));
  assert.equal(await install(['--role', 'agent-host', '--json'], f.env, f.io), 0);
  const installed = JSON.parse(f.output.pop());
  const recordPath = path.join(f.home, 'state/install.json');
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  assert.deepEqual(Object.keys(record), ['schema', 'platform', 'role', 'scope', 'label', 'artefactPath', 'nodePath', 'binPath', 'installedAt']);
  assert.equal(record.schema, 1); assert.equal(record.role, 'agent-host');
  assert.equal(record.artefactPath, installed.artefactPath);
  assert.ok(Number.isFinite(Date.parse(record.installedAt)));
  assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(recordPath)), ['install.json']);
  f.env.ERRMETER_INSTALL_LABEL_SUFFIX = 'changed';
  let registered = true;
  f.io.runner.exec = async (command, args) => {
    f.calls.push({ command, args });
    if (args[0] === 'print') { assert.equal(args[1], 'gui/501/' + record.label); return { code: registered ? 0 : 113, stdout: 'pid = 123' }; }
    if (args[0] === 'bootout') { assert.equal(args[1], 'gui/501/' + record.label); registered = false; }
    return { code: 0 };
  };
  assert.equal(await install(['--json'], f.env, f.io), 4);
  assert.equal(JSON.parse(f.output.pop()).status, 'already-installed; uninstall first');
  const { status } = require('../src/status');
  assert.equal(await status(['--json'], f.env, f.io), 1);
  const result = JSON.parse(f.output.pop());
  assert.equal(result.role, 'agent-host');
  assert.equal(result.registration_record, recordPath);
  assert.ok(result.warnings.includes('installed role agent-host differs from config watch.role watcher'));
  assert.equal(await uninstall([], f.env, f.io), 0);
  assert.equal(fs.existsSync(recordPath), false);
  assert.equal(fs.existsSync(installed.artefactPath), false);
});

test('stale record blocks reinstall until uninstall and dry-run never writes a record', async t => {
  const f = fixture(t); const recordPath = path.join(f.home, 'state/install.json');
  assert.equal(await install(['--dry-run'], f.env, f.io), 0);
  assert.equal(fs.existsSync(recordPath), false);
  assert.equal(await install([], f.env, f.io), 0);
  const bytes = fs.readFileSync(recordPath, 'utf8');
  assert.equal(await install(['--json'], f.env, f.io), 4);
  assert.equal(JSON.parse(f.output.pop()).message, 'stale install record at ' + recordPath + '; run uninstall to clean up');
  assert.equal(await uninstall(['--dry-run'], f.env, f.io), 0);
  assert.equal(fs.readFileSync(recordPath, 'utf8'), bytes);
  assert.equal(await uninstall([], f.env, f.io), 0);
  assert.equal(fs.existsSync(recordPath), false);
  assert.equal(await install([], f.env, f.io), 0);
});

test('explicit uninstall target wins with warnings and preserves another registration record', async t => {
  const f = fixture(t);
  assert.equal(await install(['--role', 'watcher'], f.env, f.io), 0);
  assert.equal(await uninstall(['--role', 'agent-host', '--system', '--dry-run', '--json'], f.env, { ...f.io, uid: 0 }), 0);
  const result = JSON.parse(f.output.pop());
  assert.equal(result.role, 'agent-host'); assert.equal(result.scope, 'system');
  assert.ok(result.notes.includes('explicit role agent-host differs from installed role watcher'));
  assert.ok(result.notes.includes('explicit scope system differs from installed scope user'));
  assert.equal(await uninstall(['--role', 'agent-host'], f.env, f.io), 0);
  assert.ok(fs.existsSync(path.join(f.home, 'state/install.json')));
});

test('record rename failure unregisters service and removes only newly created artefacts', async t => {
  const f = fixture(t); const calls = [];
  const io = { ...f.io, fs: new Proxy(fs, { get(target, key) {
    if (key === 'renameSync') return () => { throw Object.assign(new Error(), { code: 'EACCES' }); };
    return target[key];
  } }), runner: { async exec(command, args) { calls.push(args); return { code: args[0] === 'print' ? 113 : 0 }; } } };
  assert.equal(await install(['--json'], f.env, io), 3);
  assert.equal(JSON.parse(f.output.pop()).rollback, 'removed-created-artefact');
  assert.deepEqual(calls.map(args => args[0]), ['print', 'bootstrap', 'bootout']);
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'state')), []);
});

test('Windows system wrapper honors ProgramData while retaining the configured home', () => {
  const ctx = { ...context('watcher', 'system'), env: { ProgramData: 'D:\\Shared Data' }, home: 'C:\\Users\\test\\.errmeter' };
  const spec = schtasks.plan(ctx);
  assert.equal(spec.artefactPath, 'D:\\Shared Data\\errmeter\\errmeter-watcher.cmd');
  assert.match(spec.content, /ERRMETER_HOME=C:\\Users\\test\\.errmeter/);
  assert.equal(schtasks.artefactPath(ctx.role, ctx.scope, ctx), spec.artefactPath);
});

for (const linger of ['yes', 'no', 'unknown']) test('Linux user status reports linger ' + linger, async t => {
  const f = fixture(t); const calls = [];
  const io = { ...f.io, platform: 'linux', username: 'test-user', runner: { async exec(command, args) {
    calls.push({ command, args });
    if (command === 'loginctl') {
      if (linger === 'unknown') throw Object.assign(new Error(), { code: 'ENOENT' });
      return { code: 0, stdout: 'Linger=' + linger + '\n' };
    }
    return args.includes('is-enabled') ? { code: 0, stdout: 'enabled' } : { code: 0, stdout: 'MainPID=123' };
  } } };
  assert.equal((await registrationStatus({ check: true }, f.env, io)).linger, linger);
  assert.deepEqual(calls.at(-1), { command: 'loginctl', args: ['show-user', 'test-user', '-p', 'Linger'] });
  assert.equal(await require('../src/status').status([], f.env, io), 1);
  assert.match(f.output.pop(), new RegExp('linger: ' + linger));
});

test('status explicit role overrides the recorded role while preserving recorded scope', async t => {
  const f = fixture(t);
  assert.equal(await install([], f.env, f.io), 0);
  const recordPath = path.join(f.home, 'state/install.json');
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  record.scope = 'system';
  fs.writeFileSync(recordPath, JSON.stringify(record));
  const io = { ...f.io, runner: { async exec(command, args) {
    assert.deepEqual(args, ['print', 'system/ai.caty.errmeter.watcher']);
    return { code: 113 };
  } } };
  assert.equal(await require('../src/status').status(['--role', 'watcher', '--json'], f.env, io), 1);
  assert.equal(JSON.parse(f.output.pop()).role, 'watcher');
  assert.equal(await require('../src/status').status(['--role', 'invalid'], f.env, io), 2);
});

test('status without a record reports absence and honors explicit role', async t => {
  const f = fixture(t);
  assert.equal(await require('../src/status').status(['--role', 'watcher'], f.env, f.io), 1);
  assert.match(f.output.pop(), /role=watcher.*registration record: none/);
  assert.equal(f.calls.at(-1).args[1], 'gui/501/ai.caty.errmeter.watcher');
});

test('implicit uninstall uses the record when watcher config has no dispatch', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({ schema: 1, sink: { type: 'file' }, watch: { role: 'watcher' } }));
  assert.equal(await install(['--role', 'agent-host', '--json'], f.env, f.io), 0);
  const installed = JSON.parse(f.output.pop());
  f.io.runner.exec = async (command, args) => {
    f.calls.push({ command, args });
    return { code: 0 };
  };
  assert.equal(await uninstall([], f.env, f.io), 0);
  assert.ok(f.calls.some(call => call.args[0] === 'bootout' && call.args[1] === 'gui/501/' + installed.label));
  assert.equal(fs.existsSync(installed.artefactPath), false);
  assert.equal(fs.existsSync(path.join(f.home, 'state/install.json')), false);
});

for (const configState of ['missing', 'invalid']) test('stale uninstall cleans recorded registration with ' + configState + ' config', async t => {
  const f = fixture(t);
  assert.equal(await install(['--json'], f.env, f.io), 0);
  const installed = JSON.parse(f.output.pop());
  const configPath = path.join(f.home, 'config.json');
  if (configState === 'missing') fs.unlinkSync(configPath);
  else fs.writeFileSync(configPath, '{');
  assert.equal(await uninstall([], f.env, { ...f.io, resolveConfig: () => assert.fail('must not validate config for recorded uninstall') }), 0);
  assert.equal(fs.existsSync(installed.artefactPath), false);
  assert.equal(fs.existsSync(path.join(f.home, 'state/install.json')), false);
});
