'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { resolveConfig, ConfigError } = require('./config');
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
  if (error instanceof ConfigError) return error.message;
  // Never echo tool output, command arguments, or filesystem paths in errors.
  const message = String(error?.message || '');
  if (/^(?:unsupported platform|invalid role|invalid registration path|invalid install label suffix|unsupported Windows path|unsupported scheduled task path|unsupported systemd path whitespace|system registration requires (?:root|administrator)|system registration privilege could not be determined|(?:launchctl|systemctl|schtasks) [A-Za-z/-]+(?: [A-Za-z/-]+)? failed|registration command failed(?:: (?:systemctl (?:daemon-reload|enable --now|disable --now)|schtasks \/(?:Create|Delete)))?)$/.test(message)) return message;
  if (['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EROFS'].includes(error?.code)) return 'platform or filesystem operation failed (' + error.code + ')';
  return 'invalid configuration or platform operation failed';
}
function artefactLeftBehind(spec) {
  if (spec.platform === 'darwin') return '; launchd re-bootstraps it at next login — remove it by hand';
  if (spec.platform === 'linux') return '; the unit is disabled but its file remains — remove it by hand, then run \'systemctl ' + (spec.scope === 'user' ? '--user ' : '') + 'daemon-reload\'';
  if (spec.platform === 'win32') return '; the task is deleted but the wrapper file remains — remove it by hand';
  return '; remove it by hand';
}
function buildSpec(flags, env = process.env, io = {}) {
  const platform = io.platform || process.platform;
  const adapter = platforms[platform];
  if (!adapter) throw new Error('unsupported platform');
  const resolved = io.resolved || (io.resolveConfig || resolveConfig)(flags, env, { command: 'watch' });
  const role = flags.role || resolved.config.watch?.role || 'watcher';
  if (!['watcher', 'agent-host'].includes(role)) throw new Error('invalid role');
  const scope = flags.system ? 'system' : 'user';
  const ctx = { ...resolved, platform, role, scope, env, homedir: io.homedir || os.homedir(), uid: io.uid ?? (process.getuid ? process.getuid() : 0),
    username: io.username || os.userInfo().username, nodePath: io.nodePath || process.execPath, binPath: io.binPath || path.resolve(__dirname, '../bin/errmeter.js'), systemdVersion: io.systemdVersion, isElevated: io.isElevated };
  for (const value of [ctx.home, ctx.configPath, ctx.nodePath, ctx.binPath]) {
    if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new Error('invalid registration path');
  }
  return { ...ctx, ...adapter.plan(ctx), adapter };
}
function readInstallRecord(home, disk = fs, warnings = [], platform = process.platform) {
  const recordPath = path.join(home, 'state/install.json');
  let record;
  try { record = JSON.parse(disk.readFileSync(recordPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    warnings.push('install record unreadable or unsupported at ' + recordPath + ' — ignored');
    return null;
  }
  if (!record || record.schema !== 1 || record.platform !== platform || !platforms[record.platform] || !['watcher', 'agent-host'].includes(record.role) ||
      !['user', 'system'].includes(record.scope) || ['label', 'artefactPath', 'nodePath', 'binPath', 'installedAt'].some(key =>
        typeof record[key] !== 'string' || !record[key] || /[\0\r\n]/.test(record[key]))) {
    warnings.push('install record unreadable or unsupported at ' + recordPath + ' — ignored');
    return null;
  }
  return record;
}
function recordedSpec(spec, record, flags = {}) {
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
async function probeLinger(io = {}) {
  try {
    const result = await (io.runner || runner).exec('loginctl', ['show-user', io.username || os.userInfo().username, '-p', 'Linger']);
    const match = /^Linger=(yes|no)\s*$/m.exec(result.stdout || '');
    if (result.code === 0 && match) return match[1];
  } catch (_) { /* Linger is advisory when loginctl is unavailable. */ }
  return 'unknown';
}
async function registrationStatus(flags = {}, env = process.env, io = {}) {
  let spec = io.spec || buildSpec(flags, env, io);
  const warnings = [];
  const record = io.spec ? null : readInstallRecord(spec.home, io.fs || fs, warnings, spec.platform);
  if (record) spec = recordedSpec(spec, record, flags);
  const state = await spec.adapter.status(spec, io.runner || runner);
  if (spec.platform === 'linux' && spec.scope === 'user') {
    state.linger = flags.check ? await probeLinger({ ...io, username: spec.username }) : 'not probed (use --check)';
  }
  return { ...state, warnings, registrationRecord: record ? path.join(spec.home, 'state/install.json') : null, installedRole: record?.role, label: spec.label, artefactPath: spec.artefactPath, role: spec.role, scope: spec.scope, platform: spec.platform };
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
    const warnings = [];
    const platform = io.platform || process.platform;
    const adapter = platforms[platform];
    if (!adapter) throw new Error('unsupported platform');
    const home = io.resolved?.home || path.resolve(flags.home ?? env.ERRMETER_HOME ?? path.join(os.homedir(), '.errmeter'));
    const recordPath = path.join(home, 'state/install.json');
    const record = readInstallRecord(home, files, warnings, platform);
    const ignoredRecord = warnings.length > 0;
    const staleMessage = 'stale install record at ' + recordPath + '; run uninstall to clean up';
    if (action === 'install' && ignoredRecord) {
      if (!flags['dry-run']) return report({ command: action, status: 'stale-install-record', message: staleMessage }, 4);
      warnings.push(staleMessage);
    }
    let spec;
    if (record) {
      // Registration identity permits removal/refusal even with broken config.
      const configPath = path.resolve(flags.config ?? env.ERRMETER_CONFIG ?? path.join(home, 'config.json'));
      spec = buildSpec(flags, env, { ...io, nodePath: record.nodePath, binPath: record.binPath,
        resolved: { home, configPath, config: { watch: { role: record.role } } } });
    }
    if (record && action === 'install') {
      const existing = await registrationStatus(flags, env, { ...io, spec: recordedSpec(spec, record) });
      if (existing.registered || !flags['dry-run']) return report({ command: action, status: existing.registered ? 'already-installed; uninstall first' : 'stale-install-record',
        ...(!existing.registered ? { message: staleMessage } : {}) }, 4);
      warnings.push(staleMessage);
      spec = undefined;
    }
    if (!spec && action === 'install' && flags['dry-run']) {
      try { spec = buildSpec(flags, env, io); }
      catch (error) {
        if (!(error instanceof ConfigError) || error.code === 'EPERM_TOKEN_FILE_MODE' ||
            error.message !== 'watch: cannot read credential file') throw error;
        const resolved = (io.resolveConfig || resolveConfig)(flags, env, { command: 'status' });
        require('./status').localConfig(flags, env, io);
        warnings.push('credential file not found; install will need it');
        spec = buildSpec(flags, env, { ...io, resolved });
      }
    }
    if (!spec && action === 'uninstall') {
      let resolved;
      try {
        resolved = io.resolved || (io.resolveConfig || resolveConfig)(flags, env, { command: 'status' });
        // Non-strict resolution deliberately swallows corrupt files; validate
        // local settings separately without reading any credentials.
        if (!io.resolved) require('./status').localConfig(flags, env, io);
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        if (!flags.role || !(flags.user || flags.system)) throw new ConfigError('pass --role and --user|--system, or fix the config');
        resolved = { home, configPath: path.resolve(flags.config ?? env.ERRMETER_CONFIG ?? path.join(home, 'config.json')),
          config: { watch: { role: flags.role } } };
      }
      spec = buildSpec(flags, env, { ...io, resolved });
    }
    spec ||= buildSpec(flags, env, io);
    if (record && action === 'uninstall') {
      if (flags.role && flags.role !== record.role) warnings.push('explicit role ' + flags.role + ' differs from installed role ' + record.role);
      if ((flags.user || flags.system) && spec.scope !== record.scope) warnings.push('explicit scope ' + spec.scope + ' differs from installed scope ' + record.scope);
      spec = recordedSpec(spec, record, flags);
    }
    if (!flags['dry-run'] && spec.adapter.assertPrivilege) await spec.adapter.assertPrivilege(spec, io.runner || runner);
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
    const ownsRecord = ignoredRecord || record && spec.label === record.label && spec.scope === record.scope;
    const removeRecord = () => {
      if (!ownsRecord) return;
      try { files.unlinkSync(recordPath); }
      catch (error) {
        if (error.code !== 'ENOENT') {
          notes.push('warning: could not remove install record at ' + recordPath + '; ' + safeReason(error));
          summary.notes = notes;
        }
      }
    };
    if (action === 'uninstall' && !exists && !state.registered) {
      removeRecord();
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
      let artefactError;
      if (exists) {
        try { files.unlinkSync(spec.artefactPath); }
        catch (error) {
          if (error.code !== 'ENOENT') {
            let stillExists = false;
            try { files.lstatSync(spec.artefactPath); stillExists = true; }
            catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
            if (stillExists) artefactError = error;
          }
        }
      }
      try { for (const item of spec.afterRemove || []) await exec(item); }
      catch (afterRemoveError) {
        if (!artefactError) throw afterRemoveError;
        return report({ ...summary, status: 'failed', reason: 'artefact still present at ' + spec.artefactPath + ': ' + safeReason(artefactError) + artefactLeftBehind(spec) + '; also: ' + safeReason(afterRemoveError) }, 3);
      }
      if (artefactError) return report({ ...summary, status: 'failed', reason: 'artefact still present at ' + spec.artefactPath + ': ' + safeReason(artefactError) + artefactLeftBehind(spec) }, 3);
      removeRecord();
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
module.exports = { install, uninstall, main, buildSpec, registrationStatus, probeLinger, artefactLeftBehind };
