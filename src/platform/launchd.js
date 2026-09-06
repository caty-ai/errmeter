'use strict';

// ERRMETER_INSTALL_LABEL_SUFFIX is an internal test-only isolation hook. It
// changes this module's label/path for install, status, and uninstall together.

const path = require('node:path');
const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
function label(role, env = process.env) {
  const suffix = env.ERRMETER_INSTALL_LABEL_SUFFIX || '';
  if (suffix && !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(suffix)) throw new Error('invalid install label suffix');
  return 'ai.caty.errmeter.' + role + (suffix ? '.' + suffix : '');
}
function artefactPath(role, scope, ctx = {}) {
  return path.posix.join(scope === 'system' ? '/Library/LaunchDaemons' : path.posix.join(ctx.homedir || require('node:os').homedir(), 'Library/LaunchAgents'), label(role, ctx.env) + '.plist');
}
function plan(ctx) {
  const suffix = ctx.env.ERRMETER_INSTALL_LABEL_SUFFIX || '';
  if (suffix && !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(suffix)) throw new Error('invalid install label suffix');
  const label = 'ai.caty.errmeter.' + ctx.role + (suffix ? '.' + suffix : '');
  const domain = ctx.scope === 'system' ? 'system' : 'gui/' + ctx.uid;
  const artefactPath = path.posix.join(ctx.scope === 'system' ? '/Library/LaunchDaemons' : path.posix.join(ctx.homedir, 'Library/LaunchAgents'), label + '.plist');
  const args = [ctx.nodePath, ctx.binPath, 'watch', '--role', ctx.role, '--home', ctx.home, '--config', ctx.configPath];
  const content = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n' +
    '  <key>Label</key><string>' + xml(label) + '</string>\n  <key>ProgramArguments</key>\n  <array>\n' + args.map(arg => '    <string>' + xml(arg) + '</string>\n').join('') +
    '  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n' +
    '  <key>EnvironmentVariables</key>\n  <dict><key>ERRMETER_HOME</key><string>' + xml(ctx.home) + '</string></dict>\n' +
    '  <key>WorkingDirectory</key><string>' + xml(ctx.home) + '</string>\n' +
    '  <key>StandardOutPath</key><string>' + xml(path.posix.join(ctx.home, 'logs/watch.out.log')) + '</string>\n' +
    '  <key>StandardErrorPath</key><string>' + xml(path.posix.join(ctx.home, 'logs/watch.err.log')) + '</string>\n</dict>\n</plist>\n';
  return { label, artefactPath, content, query: { command: 'launchctl', args: ['print', domain + '/' + label] },
    install: [{ command: 'launchctl', args: ['bootstrap', domain, artefactPath] }],
    uninstall: [{ command: 'launchctl', args: ['bootout', domain + '/' + label] }] };
}
function inspect(result) {
  if (result.code === 0) { const pid = /(?:pid|"PID")\s*=\s*(\d+)/i.exec(result.stdout || '') || /^\s*(\d+)\s+[-\d]+\s+\S+/m.exec(result.stdout || ''); return { registered: true, running: pid && Number(pid[1]) > 0 ? Number(pid[1]) : null }; }
  if ([3, 113].includes(result.code) || /could not find service|service not found/i.test(result.stderr || '')) return { registered: false, running: null };
  throw new Error('launchctl query failed');
}
const unavailable = result => /(?:unknown|unrecognized|unsupported|not supported|not implemented|invalid)\s+(?:subcommand|command)|unrecognized subcommand/i.test(result.stderr || '');
async function execute(spec, runner, action) {
  const item = plan(spec)[action][0];
  let result = await runner.exec(item.command, item.args);
  let subcommand = item.args[0];
  if (result.code !== 0 && unavailable(result)) {
    subcommand = action === 'install' ? 'load' : 'unload';
    result = await runner.exec('launchctl', [subcommand, '-w', artefactPath(spec.role, spec.scope, spec)]);
  }
  if (result.code !== 0) throw new Error('launchctl ' + subcommand + ' failed');
}
async function status(spec, runner) {
  const item = plan(spec).query;
  let result = await runner.exec(item.command, item.args);
  if (result.code !== 0 && unavailable(result)) result = await runner.exec('launchctl', ['list', label(spec.role, spec.env)]);
  return inspect(result);
}
function assertPrivilege(spec) { if (spec.scope === 'system' && spec.uid !== 0) throw new Error('system registration requires root'); }
module.exports = { label, artefactPath, render: spec => plan(spec).content, install: (spec, runner) => execute(spec, runner, 'install'), assertPrivilege,
  uninstall: (spec, runner) => execute(spec, runner, 'uninstall'), status, plan };
