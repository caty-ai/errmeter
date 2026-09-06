'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { resolveConfig, ConfigError } = require('./config');
const { cleanValue } = require('./sinks/clean');
const { probePermissions } = require('./status');

function output(stream, text) { if (typeof stream === 'function') stream(text); else stream?.write(text); }
function template(flags) {
  const host = flags.host || os.hostname().split('.')[0];
  return { schema: 1, family: flags.family || '', host,
    sink: { type: 'github-issue', repo: flags.repo,
      token_file: '~/.errmeter/github-token', api_base: 'https://api.github.com' },
    watch: { role: flags.role || 'watcher' },
    notify: [], owner: { mention: '' } };
}

function writeConfig(disk, configPath, config, force) {
  const temporary = configPath + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = disk.openSync(temporary, 'wx', 0o600);
    disk.writeFileSync(fd, JSON.stringify(config, null, 2) + '\n');
    try { disk.fsyncSync(fd); } catch (_) { /* best effort */ }
    disk.closeSync(fd); fd = undefined;
    // A link publishes complete bytes without replacing a concurrently-created
    // config. Force uses atomic rename and never truncates the destination.
    if (force) disk.renameSync(temporary, configPath);
    else disk.linkSync(temporary, configPath);
  } finally {
    if (fd !== undefined) try { disk.closeSync(fd); } catch (_) {}
    try { disk.unlinkSync(temporary); } catch (_) {}
  }
}

async function init(argv, env = process.env, io = {}) {
  const stdout = io.stdout || process.stdout, stderr = io.stderr || process.stderr;
  const disk = io.fs || fs;
  let flags; let masks = [env.ERRMETER_GITHUB_TOKEN].filter(Boolean); let result;
  function report(code, data) {
    const cleaned = cleanValue(data, masks); io.onResult?.(cleaned);
    data = cleaned;
    if (!flags?.quiet) {
      output(stdout, flags?.json ? JSON.stringify(cleaned) + '\n' : 'init: ' +
        (code === 4 ? 'refused to overwrite config' : code ? 'failed' :
          (data.config_created ? 'config created: ' : 'config checked: ') + data.config_path +
          (data.config_created ? data.token_file_exists ? '; token file: ' + data.token_file :
            '; put the token in ' + data.token_file + ' (mode 0600); it does not exist yet' : '')) + '\n');
      for (const message of [...(data.warnings || []), ...(data.error ? [data.error] : []), ...(data.permission_note ? [data.permission_note] : [])]) output(stderr, cleanValue(message, masks) + '\n');
    }
    return code;
  }
  try {
    flags = require('./cli').parseInit(argv);
    if (flags.help || flags.version) {
      output(stdout, flags.version ? require('../package.json').version + '\n' : require('./cli').USAGE); return 0;
    }
    const home = path.resolve(flags.home ?? env.ERRMETER_HOME ?? path.join(os.homedir(), '.errmeter'));
    const configPath = path.resolve(flags.config ?? env.ERRMETER_CONFIG ?? path.join(home, 'config.json'));
    let existing = false;
    if (!flags.force) {
      try { disk.lstatSync(configPath); existing = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (existing && !flags.check) return report(4, { error: 'init: config exists; use --force to overwrite' });
    if (!existing) {
      if (!flags.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(flags.repo)) throw new (require('./cli').UsageError)('init: --repo owner/repo is required');
      for (const directory of [home, path.dirname(configPath), 'spool/pending', 'state', 'logs']) {
        disk.mkdirSync(path.isAbsolute(directory) ? directory : path.join(home, directory), { recursive: true, mode: 0o700 });
      }
      try { writeConfig(disk, configPath, template(flags), flags.force); }
      catch (error) { if (!flags.force && error.code === 'EEXIST') return report(4, { error: 'init: config exists; use --force to overwrite' }); throw error; }
    }
    result = { home, config_path: configPath, config_created: !existing,
      token_file: '~/.errmeter/github-token', token_file_mode: '0600',
      token_file_exists: disk.existsSync(path.join(os.homedir(), '.errmeter', 'github-token')), checked: false, warnings: [] };
    if (flags.check) {
      const resolved = resolveConfig({ ...flags, home, config: configPath }, env, { command: 'flush', platform: io.platform });
      masks = [...masks, ...(resolved.maskList || [])];
      result.token_file = resolved.config.sink.token_file;
      if (existing) delete result.token_file_exists;
      if (resolved.warning) result.warnings.push(resolved.warning);
      const checked = await probePermissions({ ...resolved, http: io.http });
      Object.assign(result, checked, { warnings: [...result.warnings, ...checked.warnings], checked: true });
    }
    return report(0, result);
  } catch (error) {
    const usage = error instanceof require('./cli').UsageError;
    const message = error instanceof ConfigError || usage || error.probe ? error.message : 'init: cannot create config';
    return report(usage ? 2 : 3, { ...result, error: message,
      warnings: [...(result?.warnings || []), ...(error.warnings || [])],
      ...(error.probe ? { failing_probe: error.probe } : {}) });
  }
}
async function main(argv) {
  try { process.exitCode = await init(argv); }
  catch (_) { process.exitCode = 3; if (!argv.includes('--quiet')) output(process.stderr, 'init: unexpected failure\n'); }
}
module.exports = { init, main };
