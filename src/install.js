'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { resolveConfig } = require('./config');
const { UsageError, USAGE } = require('./cli');
const platforms = { darwin: require('./platform/launchd'), linux: require('./platform/systemd'), win32: require('./platform/schtasks') };
const runner = { exec(command, args) {
  return new Promise((resolve, reject) => execFile(command, args, { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
    if (error && typeof error.code !== 'number') { reject(error); return; }
    resolve({ code: error ? error.code : 0, stdout, stderr });
  }));
} };
function output(target, text) { try { if (typeof target === 'function') target(text); else target.write(text); } catch (_) {} }
function safeReason(error) {
  // Never echo tool output, command arguments, or filesystem paths in errors.
  const message = String(error?.message || '');
  if (/^(?:unsupported platform|invalid role|invalid registration path|invalid install label suffix|unsupported Windows path|unsupported scheduled task path|unsupported systemd path whitespace|system registration requires (?:root|administrator)|system registration privilege could not be determined|(?:launchctl|systemctl|schtasks) [A-Za-z/-]+(?: [A-Za-z/-]+)? failed|registration command failed: (?:systemctl (?:daemon-reload|enable --now|disable --now)|schtasks \/(?:Create|Delete)))$/.test(message)) return message;
  if (['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EROFS'].includes(error?.code)) return 'platform or filesystem operation failed (' + error.code + ')';
  return 'invalid configuration or platform operation failed';
}
function buildSpec(flags, env = process.env, io = {}) {
  const platform = io.platform || process.platform;
  const adapter = platforms[platform];
  if (!adapter) throw new Error('unsupported platform');
  const resolved = io.resolved || (io.resolveConfig || resolveConfig)(flags, env, { command: 'watch' });
  const role = flags.role || resolved.config.watch.role;
  if (!['watcher', 'agent-host'].includes(role)) throw new Error('invalid role');
  const scope = flags.system ? 'system' : 'user';
  const ctx = { ...resolved, platform, role, scope, env, homedir: io.homedir || os.homedir(), uid: io.uid ?? (process.getuid ? process.getuid() : 0),
    username: io.username || os.userInfo().username, nodePath: io.nodePath || process.execPath, binPath: io.binPath || path.resolve(__dirname, '../bin/errmeter.js'), systemdVersion: io.systemdVersion, isElevated: io.isElevated };
  for (const value of [ctx.home, ctx.configPath, ctx.nodePath, ctx.binPath]) {
    if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new Error('invalid registration path');
  }
  return { ...ctx, ...adapter.plan(ctx), adapter };
}
function readInstallRecord(home, disk = fs) {
  let record;
  try { record = JSON.parse(disk.readFileSync(path.join(home, 'state/install.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!record || record.schema !== 1 || !platforms[record.platform] || !['watcher', 'agent-host'].includes(record.role) ||
      !['user', 'system'].includes(record.scope) || ['label', 'artefactPath', 'nodePath', 'binPath', 'installedAt'].some(key =>
        typeof record[key] !== 'string' || !record[key] || /[\0\r\n]/.test(record[key]))) throw new Error('invalid install record');
  return record;
}
function recordedSpec(spec, record, flags = {}) {
  if (record.platform !== spec.platform) throw new Error('install record platform mismatch');
  const role = flags.role || record.role;
  const scope = flags.system ? 'system' : flags.user ? 'user' : record.scope;
  const sameTarget = role === record.role && scope === record.scope;
  const ctx = { ...spec, role, scope, label: sameTarget ? record.label : undefined,
    artefactPath: sameTarget ? record.artefactPath : undefined, nodePath: record.nodePath, binPath: record.binPath };
  return { ...ctx, ...spec.adapter.plan(ctx) };
}
function writeInstallRecord(spec, disk) {
  const directory = path.join(spec.home, 'state');
  const target = path.join(directory, 'install.json');
  const temporary = target + '.' + process.pid + '.' + require('node:crypto').randomBytes(8).toString('hex') + '.tmp';
  const record = { schema: 1 };
  for (const key of ['platform', 'role', 'scope', 'label', 'artefactPath', 'nodePath', 'binPath']) record[key] = spec[key];
  record.installedAt = new Date().toISOString();
  disk.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    disk.writeFileSync(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
    disk.renameSync(temporary, target);
  } finally {
    try { disk.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function registrationStatus(flags = {}, env = process.env, io = {}) {
  let spec = io.spec || buildSpec(flags, env, io);
  const record = io.spec ? null : readInstallRecord(spec.home, io.fs || fs);
  if (record) spec = recordedSpec(spec, record, flags);
  const state = await spec.adapter.status(spec, io.runner || runner);
  if (spec.platform === 'linux' && spec.scope === 'user') {
    state.linger = 'unknown';
    try {
      const result = await (io.runner || runner).exec('loginctl', ['show-user', spec.username, '-p', 'Linger']);
      const match = /^Linger=(yes|no)\s*$/m.exec(result.stdout || '');
      if (result.code === 0 && match) state.linger = match[1];
    } catch (_) { /* Linger is advisory when loginctl is unavailable. */ }
  }
  return { ...state, registrationRecord: record ? path.join(spec.home, 'state/install.json') : null, installedRole: record?.role, label: spec.label, artefactPath: spec.artefactPath, role: spec.role, scope: spec.scope, platform: spec.platform };
}
async function command(action, argv, env, io) {
  const stdout = io.stdout || process.stdout; const stderr = io.stderr || process.stderr;
  let flags;
  const report = (data, code) => {
    if (!flags?.quiet) output(stdout, flags?.json ? JSON.stringify(data) + '\n' : (data.message || action + ': ' + data.status + (data.artefactPath ? ' ' + data.artefactPath : '') + (data.reason ? ': ' + data.reason : '') + (data.rollback ? '; rollback: ' + data.rollback : '') + (data.rollbackReason ? ': ' + data.rollbackReason : '')) + (data.notes?.length ? '\n' + data.notes.join('\n') : '') + '\n');
    return code;
  };
  try { flags = require('./cli').parseInstall(argv, action); }
  catch (error) {
    if (!(error instanceof UsageError)) throw error;
    if (!argv.includes('--quiet')) output(stderr, error.message + '\n');
    return 2;
  }
  if (flags.help || flags.version) { output(stdout, flags.help ? USAGE : require('../package.json').version + '\n'); return 0; }
  try {
    const files = io.fs || fs;
    let spec, record;
    if (action === 'uninstall') {
      const platform = io.platform || process.platform;
      const adapter = platforms[platform];
      if (!adapter) throw new Error('unsupported platform');
      // Reject explicitly privileged operations before touching the filesystem.
      if (flags.system && adapter.assertPrivilege) await adapter.assertPrivilege({
        scope: 'system', uid: io.uid ?? (process.getuid ? process.getuid() : 0), isElevated: io.isElevated
      }, io.runner || runner);
      const home = io.resolved?.home || path.resolve(flags.home ?? env.ERRMETER_HOME ?? path.join(os.homedir(), '.errmeter'));
      record = readInstallRecord(home, files);
      if (record) {
        // Removal needs registration identity, not a runnable watch config. A
        // changed, missing or invalid config must not strand an installed job.
        const configPath = path.resolve(flags.config ?? env.ERRMETER_CONFIG ?? path.join(home, 'config.json'));
        spec = buildSpec(flags, env, { ...io, nodePath: record.nodePath, binPath: record.binPath,
          resolved: { home, configPath, config: { watch: { role: record.role } } } });
      }
    }
    spec ||= buildSpec(flags, env, io);
    if (spec.adapter.assertPrivilege) await spec.adapter.assertPrivilege(spec, io.runner || runner);
    const recordPath = path.join(spec.home, 'state/install.json');
    if (action === 'install') record = readInstallRecord(spec.home, files);
    const warnings = [];
    if (record && action === 'uninstall') {
      if (flags.role && flags.role !== record.role) warnings.push('explicit role ' + flags.role + ' differs from installed role ' + record.role);
      if ((flags.user || flags.system) && spec.scope !== record.scope) warnings.push('explicit scope ' + spec.scope + ' differs from installed scope ' + record.scope);
      spec = recordedSpec(spec, record, flags);
      if (spec.adapter.assertPrivilege) await spec.adapter.assertPrivilege(spec, io.runner || runner);
    }
    if (record && action === 'install' && !flags['dry-run']) {
      const existing = await registrationStatus(flags, env, { ...io, spec: recordedSpec(spec, record) });
      return report({ command: action, status: existing.registered ? 'already-installed; uninstall first' : 'stale-install-record',
        ...(!existing.registered ? { message: 'stale install record at ' + recordPath + '; run uninstall to clean up' } : {}) }, 4);
    }
    if (spec.adapter.prepare) {
      await spec.adapter.prepare(spec, io.runner || runner, { dryRun: Boolean(flags['dry-run']) });
      spec.content = spec.adapter.render(spec);
    }
    const commands = action === 'install' ? spec.install : [...spec.uninstall, ...(spec.afterRemove || [])];
    const notes = [...warnings, ...(spec.notes || [])];
    const summary = { command: action, platform: spec.platform, role: spec.role, scope: spec.scope, label: spec.label, artefactPath: spec.artefactPath, ...(notes.length ? { notes } : {}) };
    if (flags['dry-run']) {
      const preview = { ...summary, status: 'dry-run', artefact: { path: spec.artefactPath, content: spec.content }, commands };
      if (!flags.quiet && !flags.json) output(stdout, spec.content + commands.map(item => item.command + ' ' + item.args.map(arg => JSON.stringify(arg)).join(' ')).join('\n') + '\n');
      return report(preview, 0);
    }
    let exists = false;
    try { files.lstatSync(spec.artefactPath); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const state = await registrationStatus(flags, env, { ...io, spec });
    if (action === 'install' && exists) return report({ ...summary, registered: state.registered,
      status: state.registered ? 'already-installed; uninstall first' : 'artefact-exists-unregistered',
      ...(!state.registered ? { message: 'install: artefact exists at ' + spec.artefactPath + ' but the service is not registered — run uninstall to clean up, then install' } : {}) }, 4);
    if (action === 'install' && state.registered) return report({ ...summary, status: 'already-installed; uninstall first' }, 4);
    const ownsRecord = record && spec.label === record.label && spec.scope === record.scope;
    if (action === 'uninstall' && !exists && !state.registered) {
      if (ownsRecord) files.unlinkSync(recordPath);
      return report({ ...summary, status: 'not-installed' }, 0);
    }
    const exec = async item => {
      const result = await (io.runner || runner).exec(item.command, item.args);
      if (result.code !== 0 && !(item.allowStopped && /not running/i.test(result.stderr || ''))) throw new Error('registration command failed');
    };
    if (action === 'install') {
      files.mkdirSync(path.dirname(spec.artefactPath), { recursive: true, mode: 0o700 });
      files.mkdirSync(path.join(spec.home, 'logs'), { recursive: true, mode: 0o700 });
      try { files.writeFileSync(spec.artefactPath, spec.content, { flag: 'wx', mode: 0o644 }); }
      catch (error) { if (error.code === 'EEXIST') return report({ ...summary, status: 'already-installed' }, 4); throw error; }
      let registered = false;
      try {
        await spec.adapter.install(spec, io.runner || runner);
        registered = true;
        writeInstallRecord(spec, files);
      }
      catch (error) {
        // Only this invocation's exclusive creation may be rolled back.
        try {
          if (registered) await spec.adapter.uninstall(spec, io.runner || runner);
          files.unlinkSync(spec.artefactPath);
          for (const item of spec.afterRemove || []) await exec(item);
        } catch (cleanupError) {
          return report({ ...summary, status: 'failed', reason: safeReason(error), rollback: 'failed', rollbackReason: safeReason(cleanupError) }, 3);
        }
        return report({ ...summary, status: 'failed', reason: safeReason(error), rollback: 'removed-created-artefact' }, 3);
      }
    } else {
      if (state.registered) await spec.adapter.uninstall(spec, io.runner || runner);
      if (exists) files.unlinkSync(spec.artefactPath);
      for (const item of spec.afterRemove || []) await exec(item);
      if (ownsRecord) files.unlinkSync(recordPath);
    }
    return report({ ...summary, status: action === 'install' ? 'installed' : 'uninstalled' }, 0);
  } catch (error) {
    const reason = safeReason(error);
    if (!flags.quiet && !flags.json) output(stderr, action + ': ' + reason + '\n');
    return report({ command: action, status: 'failed', reason }, 3);
  }
}
function install(argv, env = process.env, io = {}) { return command('install', argv, env, io); }
function uninstall(argv, env = process.env, io = {}) { return command('uninstall', argv, env, io); }
function main(argv, action = 'install') {
  return (action === 'uninstall' ? uninstall : install)(argv).then(code => { process.exitCode = code; }, () => { process.exitCode = 3; });
}
module.exports = { install, uninstall, main, buildSpec, registrationStatus };
