'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const DEFAULTS = Object.freeze({
  detail_max_bytes: 8192, tail_lines: 40, pending_soft_limit: 5000,
  pending_hard_limit: 20000, sent_retention_days: 7, sent_max_bytes: 268435456,
  dead_retention_days: 30, dead_max_bytes: 67108864, log_max_bytes: 10485760,
  lock_refresh_sec: 30, lock_stale_sec: 600, flush_linger_sec: 3600,
  cut_settle_sec: 2, overflow_max_bytes: 67108864, overflow_guard_bytes: 1048576,
  max_heartbeat_files: 1000, max_events_per_pass: 500
});
class ConfigError extends Error {}
function resolveConfig(flags = {}, env = process.env, options = {}) {
  const strict = options.command === 'flush';
  const home = path.resolve(flags.home ?? env.ERRMETER_HOME ?? path.join(os.homedir(), '.errmeter'));
  const configPath = path.resolve(flags.config ?? env.ERRMETER_CONFIG ?? path.join(home, 'config.json'));
  let config = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
    else if (strict) throw new ConfigError('flush: config must be an object');
  } catch (error) {
    if (strict && (error.code !== 'ENOENT' || flags.config || env.ERRMETER_CONFIG)) {
      throw new ConfigError('flush: cannot read valid config');
    }
  }
  if (strict && config.schema !== undefined && (!Number.isInteger(config.schema) || config.schema < 1)) {
    throw new ConfigError('flush: invalid config schema');
  }
  if (strict && config.spool !== undefined && (!config.spool || typeof config.spool !== 'object' || Array.isArray(config.spool))) {
    throw new ConfigError('flush: invalid spool config');
  }
  let warning;
  if (typeof config.schema === 'number' && config.schema > 1) {
    if (strict) throw new ConfigError('flush: config schema not supported');
    warning = `emit: config schema ${config.schema} not supported, using defaults`;
    config = {};
  }
  const extra = config.spool && typeof config.spool === 'object' && !Array.isArray(config.spool) ? config.spool : {};
  const spool = { ...extra, ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = config.spool?.[key];
    if (strict && value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new ConfigError('flush: invalid spool limit');
    if (Number.isSafeInteger(value) && value >= 0) spool[key] = value;
  }
  if (!strict) return { home, configPath, warning, config: { ...config, spool } };
  return flushConfig({ home, configPath, config: { ...config, spool } }, env, options);
}
let warnedWindows = false;
function flushConfig(result, env, options) {
  const { home } = result;
  const config = result.config;
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  for (const key of ['sink', 'watch', 'owner', 'file']) {
    if (config[key] !== undefined && !object(config[key])) throw new ConfigError('flush: invalid config section');
  }
  config.sink = { type: 'github-issue', api_base: 'https://api.github.com', ...config.sink };
  if (!['github-issue', 'file', 'webhook'].includes(config.sink.type)) throw new ConfigError('flush: unknown sink type');
  config.watch = { role: 'watcher', watcher_gap_sec: 600, heartbeat_gap_sec: 900,
    renotify_sec: 21600, notify_confirm_sec: 120, ...config.watch };
  if (!['watcher', 'agent-host'].includes(config.watch.role)) throw new ConfigError('flush: unknown watch role');
  config.owner = { mention: '', ...config.owner };
  config.notify = config.notify ?? [];
  if (!Array.isArray(config.notify) || config.notify.some(entry => !object(entry) || !['telegram', 'slack', 'webhook'].includes(entry.type))) {
    throw new ConfigError('flush: invalid notify type');
  }
  config.file = { path: path.join(home, 'board.jsonl'), scan_max_lines: 50000, ...config.file };
  if (typeof config.file.path !== 'string' || !config.file.path) throw new ConfigError('flush: invalid board file path');
  const limits = { max_comments_per_issue: 400, max_comments_per_issue_per_hour: 12,
    max_pages_per_list: 10, max_api_calls_per_pass: 60 };
  for (const [key, value] of Object.entries(limits)) config[key] = config[key] ?? config.sink[key] ?? value;
  for (const [section, keys] of [[config, Object.keys(limits)], [config.watch, ['watcher_gap_sec', 'heartbeat_gap_sec', 'renotify_sec', 'notify_confirm_sec']], [config.file, ['scan_max_lines']]]) {
    for (const key of keys) if (!Number.isSafeInteger(section[key]) || section[key] < 0) throw new ConfigError('flush: invalid numeric config');
  }
  const expand = file => file === '~' ? os.homedir() : /^~[\\/]/.test(file) ? path.join(os.homedir(), file.slice(2)) : file;
  function secretFile(file) {
    if (typeof file !== 'string' || !file) throw new ConfigError('flush: credential file is required');
    let fd;
    try {
      fd = fs.openSync(expand(file), 'r');
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new ConfigError('flush: credential must be a regular file');
      if ((options.platform ?? process.platform) === 'win32') {
        if (!warnedWindows) { result.warning = 'flush: credential file mode cannot be checked on Windows; relying on profile ACL'; warnedWindows = true; }
      } else if ((stat.mode & 0o177) !== 0) {
        const error = new ConfigError('flush: EPERM_TOKEN_FILE_MODE'); error.code = 'EPERM_TOKEN_FILE_MODE'; throw error;
      }
      return fs.readFileSync(fd, 'utf8').trim();
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError('flush: cannot read credential file');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  // Inline credentials are never accepted as sources.
  delete config.sink.token;
  delete config.sink.headers;
  const secrets = [];
  if (config.sink.type === 'github-issue') {
    const token = env.ERRMETER_GITHUB_TOKEN || secretFile(config.sink.token_file);
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new ConfigError('flush: missing or invalid GitHub credential');
    config.sink.token = token.trim();
    secrets.push(config.sink.token);
    if (typeof config.sink.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.sink.repo)) throw new ConfigError('flush: invalid GitHub repo');
  }
  if (config.sink.type === 'webhook' && config.sink.headers_file) {
    let headers;
    try { headers = JSON.parse(secretFile(config.sink.headers_file)); }
    catch (error) { if (error instanceof ConfigError) throw error; throw new ConfigError('flush: invalid headers file'); }
    if (!object(headers) || Object.entries(headers).some(([key, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value))) throw new ConfigError('flush: invalid headers file');
    config.sink.headers = headers;
    secrets.push(...Object.values(headers));
  }
  if (config.sink.type !== 'file') {
    try {
      const url = new URL(config.sink.type === 'github-issue' ? config.sink.api_base : config.sink.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch (_) { throw new ConfigError('flush: invalid sink URL'); }
  }
  result.maskList = Array.from(new Set([...require('./redact').buildMaskList(config, env), ...secrets])).sort((a, b) => b.length - a.length);
  return result;
}
module.exports = { DEFAULTS, resolveConfig, ConfigError };
