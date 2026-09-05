'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { install, uninstall, registrationStatus } = require('../src/install');
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
    assert.equal(spec.content, '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ERRMETER_HOME=C:\\Users\\test\\.errmeter"\r\n"C:\\Program Files\\nodejs\\node.exe" "C:\\errmeter\\bin\\errmeter.js" "watch" "--role" "' + role + '" "--home" "C:\\Users\\test\\.errmeter" "--config" "C:\\Users\\test\\.errmeter\\config.json"\r\nexit /b %errorlevel%\r\n');
    assert.equal(spec.artefactPath, 'C:\\Users\\test\\.errmeter\\errmeter-' + role + '.cmd');
    assert.equal(spec.install[0].args[4], 'cmd.exe /d /v:off /s /c ""' + spec.artefactPath + '""');
    assert.deepEqual(spec.install[0].args.slice(5), ['/SC', scope === 'system' ? 'ONSTART' : 'ONLOGON', ...(scope === 'system' ? ['/RU', 'SYSTEM'] : ['/RL', 'LIMITED']), '/F']);
  });
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-install-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, '.errmeter'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ schema: 1, sink: { type: 'file' }, watch: { role: 'agent-host' } }));
  const calls = []; const output = []; const errors = [];
  const io = { platform: 'darwin', homedir: root, uid: 501, stdout: text => output.push(text), stderr: text => errors.push(text),
    runner: { async exec(command, args) { calls.push({ command, args }); return args[0] === 'print' ? { code: 113, stderr: 'Could not find service' } : { code: 0 }; } } };
  return { root, home, env: { ERRMETER_HOME: home }, calls, output, errors, io };
}
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
test('Linux dry-run renders the conservative journal unit without invoking systemctl', async t => {
  const f = fixture(t);
  const denyWrites = new Proxy(fs, { get(target, name) { if (/write|mkdir|unlink|rename|open/i.test(name)) return () => { throw new Error('write attempted'); }; return target[name]; } });
  const io = { ...f.io, platform: 'linux', fs: denyWrites, runner: { exec: () => { throw new Error('runner invoked'); } } };
  assert.equal(await install(['--dry-run', '--json'], f.env, io), 0);
  const result = JSON.parse(f.output.join(''));
  assert.match(result.artefact.content, /StandardOutput=journal/);
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
test('registration failure retains its artefact for explicit uninstall and dry-uninstall writes nothing', async t => {
  const f = fixture(t);
  f.io.runner.exec = async (command, args) => args[0] === 'print' ? { code: 113 } : { code: 5 };
  assert.equal(await install([], f.env, f.io), 3);
  assert.equal(await install([], f.env, f.io), 4);
  const before = fs.readdirSync(path.join(f.root, 'Library/LaunchAgents'));
  assert.equal(await uninstall(['--dry-run', '--json'], f.env, f.io), 0);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'Library/LaunchAgents')), before);
});
test('POSIX system registration refuses missing privileges before filesystem and tool actions', async t => {
  const f = fixture(t);
  for (const platform of ['darwin', 'linux']) for (const action of [install, uninstall]) {
    assert.equal(await action(['--system'], f.env, { ...f.io, platform, uid: 501,
      fs: new Proxy({}, { get() { throw new Error('filesystem action before privilege check'); } }) }), 3);
  }
  assert.equal(f.calls.length, 0);
});
