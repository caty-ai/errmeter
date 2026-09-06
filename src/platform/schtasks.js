'use strict';

// Task Scheduler has no KeepAlive equivalent, so the wrapper restarts watch
// after it exits. Tasks default to a 72-hour execution limit; users must adjust
// that task setting for uninterrupted operation beyond 72 hours.
const path = require('node:path');
function quote(value) {
  // Batch expansion of percent signs occurs even inside quotes. Delayed expansion
  // is explicitly disabled in the wrapper so exclamation marks stay literal.
  if (/["\r\n\0]/.test(value)) throw new Error('unsupported Windows path');
  return '"' + value.replace(/%/g, '%%') + '"';
}
const label = role => 'errmeter-' + role;
const artefactPath = (role, scope, ctx = {}) => path.win32.join(ctx.home || path.win32.join(require('node:os').homedir(), '.errmeter'), label(role) + '.cmd');
function plan(ctx) {
  const label = 'errmeter-' + ctx.role;
  const artefactPath = path.win32.join(ctx.home, label + '.cmd');
  const args = [ctx.nodePath, ctx.binPath, 'watch', '--role', ctx.role, '--home', ctx.home, '--config', ctx.configPath];
  const content = '@echo off\r\nrem Task Scheduler default execution limit is 72 hours; adjust it for continuous operation.\r\nsetlocal DisableDelayedExpansion\r\nset "ERRMETER_HOME=' + quote(ctx.home).slice(1, -1) + '"\r\n:retry\r\n' + args.map(quote).join(' ') + '\r\ntimeout /t 5 /nobreak >nul 2>&1\r\nif errorlevel 1 ping -n 6 127.0.0.1 >nul 2>&1\r\ngoto retry\r\n';
  // The wrapper supplies --home/--config directly; no caller environment or
  // credential values are copied into the scheduled task.
  // Expansion happens in the outer cmd before the wrapper can protect itself;
  // reject those unusual home paths instead of registering a different path.
  if (/%/.test(artefactPath)) throw new Error('unsupported scheduled task path');
  const taskCommand = 'cmd.exe /d /v:off /s /c ""' + artefactPath + '""';
  const createArgs = ['/Create', '/TN', label, '/TR', taskCommand, '/SC', ctx.scope === 'system' ? 'ONSTART' : 'ONLOGON'];
  if (ctx.scope === 'system') createArgs.push('/RU', 'SYSTEM');
  createArgs.push('/RL', 'LIMITED', '/F');
  return { label, artefactPath, content, query: { command: 'schtasks', args: ['/Query', '/TN', label, '/FO', 'LIST', '/V'] },
    install: [{ command: 'schtasks', args: createArgs }],
    uninstall: [{ command: 'schtasks', args: ['/Delete', '/TN', label, '/F'] }] };
}
function inspect(result) {
  if (result.code === 0) return { registered: true, running: /:\s*Running\b/i.test(result.stdout || ''), pid: null };
  if (result.code === 1 && /cannot find|does not exist|not found/i.test((result.stdout || '') + (result.stderr || ''))) return { registered: false, running: false, pid: null };
  throw new Error('schtasks query failed');
}
async function execute(spec, runner, action) {
  for (const item of plan(spec)[action]) {
    const result = await runner.exec(item.command, item.args);
    if (result.code !== 0 && !(item.allowStopped && /not running/i.test(result.stderr || ''))) throw new Error('registration command failed: schtasks ' + item.args[0]);
  }
}
async function status(spec, runner) { const item = plan(spec).query; return inspect(await runner.exec(item.command, item.args)); }
async function assertPrivilege(spec, runner) {
  if (spec.scope !== 'system') return;
  let elevated;
  if (spec.isElevated !== undefined) elevated = typeof spec.isElevated === 'function' ? await spec.isElevated() : spec.isElevated;
  else {
    if (process.platform !== 'win32') throw new Error('system registration requires administrator');
    let result;
    try { result = await runner.exec('net', ['session']); }
    catch (_) { throw new Error('system registration privilege could not be determined'); }
    if (!Number.isInteger(result?.code)) throw new Error('system registration privilege could not be determined');
    elevated = result.code === 0;
  }
  if (elevated !== true) throw new Error('system registration requires administrator');
}
module.exports = { label, artefactPath, render: spec => plan(spec).content, install: (spec, runner) => execute(spec, runner, 'install'),
  uninstall: (spec, runner) => execute(spec, runner, 'uninstall'), status, assertPrivilege, plan };
