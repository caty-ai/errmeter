'use strict';

// User units start at login unless loginctl enable-linger is enabled. Status
// probes loginctl show-user <user> -p Linger; unavailable probes report unknown.

const path = require('node:path');
function quote(value) {
  return '"' + String(value).replace(/%/g, '%%').replace(/\$/g, () => '$$').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
}
const label = role => 'errmeter-' + role + '.service';
function artefactPath(role, scope, ctx = {}) {
  return path.posix.join(scope === 'system' ? '/etc/systemd/system' : path.posix.join(ctx.homedir || require('node:os').homedir(), '.config/systemd/user'), label(role));
}
function plan(ctx) {
  // Tabs and other control whitespace are not stable in unit path settings.
  for (const value of [ctx.home, ctx.configPath, ctx.nodePath, ctx.binPath, ctx.homedir]) {
    if (typeof value === 'string' && /[\t\v\f\r\n]/.test(value)) throw new Error('unsupported systemd path whitespace');
  }
  const label = ctx.label || 'errmeter-' + ctx.role + '.service';
  const artefactPath = ctx.artefactPath || path.posix.join(ctx.scope === 'system' ? '/etc/systemd/system' : path.posix.join(ctx.homedir, '.config/systemd/user'), label);
  const prefix = ctx.scope === 'system' ? [] : ['--user'];
  const command = args => ({ command: 'systemctl', args: [...prefix, ...args] });
  const args = [ctx.nodePath, ctx.binPath, 'watch', '--role', ctx.role, '--home', ctx.home, '--config', ctx.configPath];
  const setting = value => quote(value).replace(/\$\$/g, '$');
  // These settings consume the entire value as a path, not an argv word. Quotes
  // would become literal path characters; only systemd specifiers need escaping.
  const trailingSafe = value => /[\\\s]$/.test(value) ? value + '/.' : value;
  const settingPath = value => String(value).replace(/%/g, '%%');
  const content = '[Unit]\nDescription=errmeter ' + ctx.role + '\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=' + args.map(quote).join(' ') +
    '\nRestart=always\nRestartSec=5\nEnvironment=' + setting('ERRMETER_HOME=' + ctx.home) + '\nWorkingDirectory=' + settingPath(trailingSafe(ctx.home)) +
    '\nStandardOutput=' + (ctx.systemdVersion >= 240 ? 'append:' + settingPath(path.posix.join(ctx.home, 'logs/watch.out.log')) : 'journal') +
    '\nStandardError=' + (ctx.systemdVersion >= 240 ? 'append:' + settingPath(path.posix.join(ctx.home, 'logs/watch.err.log')) : 'journal') +
    '\n\n[Install]\nWantedBy=' + (ctx.scope === 'system' ? 'multi-user.target' : 'default.target') + '\n';
  return { label, artefactPath, content, query: command(['show', label, '--property=LoadState', '--property=ActiveState']),
    install: [command(['daemon-reload']), command(['enable', '--now', label])],
    uninstall: [command(['disable', '--now', label])], afterRemove: [command(['daemon-reload'])] };
}
async function execute(spec, runner, action) {
  for (const item of plan(spec)[action]) {
    if ((await runner.exec(item.command, item.args)).code !== 0) {
      const subcommand = item.args.includes('enable') ? 'enable --now' : item.args.includes('disable') ? 'disable --now' : 'daemon-reload';
      throw new Error('registration command failed: systemctl ' + subcommand);
    }
  }
}
async function status(spec, runner) {
  const prefix = spec.scope === 'system' ? [] : ['--user'];
  const unit = spec.label || label(spec.role);
  const enabled = await runner.exec('systemctl', [...prefix, 'is-enabled', unit]);
  if (enabled.code !== 0 && ![1, 4].includes(enabled.code)) throw new Error('systemctl is-enabled failed');
  if (enabled.code !== 0 && !/disabled|not-found|masked|static|indirect|linked|does not exist|could not be found|no such file/i.test((enabled.stdout || '') + (enabled.stderr || ''))) throw new Error('systemctl is-enabled failed');
  const registered = enabled.code === 0 || !/not-found|does not exist|could not be found|no such file/i.test((enabled.stdout || '') + (enabled.stderr || ''));
  const active = await runner.exec('systemctl', [...prefix, 'is-active', unit]);
  if (![0, 3, 4].includes(active.code)) throw new Error('systemctl is-active failed');
  if (!registered) return { registered: false, running: null };
  const pidResult = await runner.exec('systemctl', [...prefix, 'show', unit, '-p', 'MainPID']);
  if (pidResult.code !== 0) throw new Error('systemctl show failed');
  const match = /(?:MainPID=)?(\d+)/.exec(pidResult.stdout || '');
  return { registered, running: active.code === 0 && match && Number(match[1]) > 0 ? Number(match[1]) : null };
}
async function prepare(spec, runner, { dryRun = false } = {}) {
  if (spec.scope === 'user') spec.notes = ["note: user services start at login; run 'loginctl enable-linger " + (spec.username || require('node:os').userInfo().username) + "' to start at boot"];
  if (spec.systemdVersion !== undefined) return;
  try {
    const result = await runner.exec('systemctl', ['--version']);
    const version = /^systemd\s+(\d+)/.exec(result.stdout || '');
    if (result.code !== 0 || !version) throw new Error('systemctl version failed');
    spec.systemdVersion = Number(version[1]);
  } catch (error) {
    if (!dryRun) throw error;
    spec.notes = ['# systemd version unknown — StandardOutput shown as journal', ...(spec.notes || [])];
  }
}
function assertPrivilege(spec) { if (spec.scope === 'system' && spec.uid !== 0) throw new Error('system registration requires root'); }
module.exports = { label, artefactPath, render: spec => plan(spec).content, install: (spec, runner) => execute(spec, runner, 'install'), assertPrivilege,
  uninstall: (spec, runner) => execute(spec, runner, 'uninstall'), status, prepare, plan };
