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
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function minimumWatchClaimBudget(config) {
  return (config.max_pages_per_list ?? config.sink?.max_pages_per_list ?? 10) + 7;
}
let warnedWindows = false;
function secretFile(file, options = {}) {
  const command = options.command || 'flush';
  if (typeof file !== 'string' || !file) throw new ConfigError(command + ': credential file is required');
  const expanded = file === '~' ? os.homedir() : /^~[\\/]/.test(file) ? path.join(os.homedir(), file.slice(2)) : file;
  let fd;
  try {
    fd = fs.openSync(expanded, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new ConfigError(command + ': credential must be a regular file');
    if ((options.platform ?? process.platform) === 'win32') {
      if (!warnedWindows) {
        options.onWarning?.(command + ': credential file mode cannot be checked on Windows; relying on profile ACL');
        warnedWindows = true;
      }
    } else if ((stat.mode & 0o177) !== 0) {
      const error = new ConfigError(command + ': EPERM_TOKEN_FILE_MODE: credential file must be 0600 or stricter (no group/other bits, no exec)');
      error.code = 'EPERM_TOKEN_FILE_MODE';
      throw error;
    }
    return fs.readFileSync(fd, 'utf8').trim();
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(command + ': cannot read credential file');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function resolveConfig(flags = {}, env = process.env, options = {}) {
  const command = options.command || 'emit';
  const strict = ['flush', 'watch'].includes(command);
  const home = path.resolve(flags.home ?? env.ERRMETER_HOME ?? path.join(os.homedir(), '.errmeter'));
  const configPath = path.resolve(flags.config ?? env.ERRMETER_CONFIG ?? path.join(home, 'config.json'));
  let config = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
    else if (strict) throw new ConfigError(command + ': config must be an object');
  } catch (error) {
    if (strict && (error.code !== 'ENOENT' || flags.config || env.ERRMETER_CONFIG)) {
      throw new ConfigError(command + ': cannot read valid config');
    }
  }
  if (strict && config.schema !== undefined && (!Number.isInteger(config.schema) || config.schema < 1)) {
    throw new ConfigError(command + ': invalid config schema');
  }
  if (strict && config.spool !== undefined && (!config.spool || typeof config.spool !== 'object' || Array.isArray(config.spool))) {
    throw new ConfigError(command + ': invalid spool config');
  }
  let warning;
  if (typeof config.schema === 'number' && config.schema > 1) {
    if (strict) throw new ConfigError(command + ': config schema not supported');
    warning = `emit: config schema ${config.schema} not supported, using defaults`;
    config = {};
  }
  const extra = config.spool && typeof config.spool === 'object' && !Array.isArray(config.spool) ? config.spool : {};
  const spool = { ...extra, ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = config.spool?.[key];
    if (strict && value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new ConfigError(command + ': invalid spool limit');
    if (Number.isSafeInteger(value) && value >= 0) spool[key] = value;
  }
  if (!strict) return { home, configPath, warning, config: { ...config, spool } };
  return flushConfig({ home, configPath, config: { ...config, spool } }, env, options, flags);
}
function flushConfig(result, env, options, flags) {
  const { home } = result;
  const config = result.config;
  config.host ??= os.hostname().split('.')[0];
  const command = options.command || 'flush';
  const invalid = message => new ConfigError(command + ': ' + message);
  const readSecret = file => secretFile(file, { ...options, onWarning: warning => { result.warning = warning; } });
  for (const key of ['sink', 'watch', 'owner', 'file']) {
    if (config[key] !== undefined && !object(config[key])) throw invalid('invalid config section');
  }
  config.sink = { type: 'github-issue', api_base: 'https://api.github.com', ...config.sink };
  if (!['github-issue', 'file', 'webhook'].includes(config.sink.type)) throw invalid('unknown sink type');
  if (command === 'watch' && config.sink.type === 'webhook') throw invalid('webhook sink is not a board');
  config.watch = { role: 'watcher', watcher_gap_sec: 600, heartbeat_gap_sec: 900,
    renotify_sec: 21600, notify_confirm_sec: 120, watcher_id: config.host || os.hostname().split('.')[0],
    interval_sec: 60, claim_ttl_sec: 900, renew_sec: 180, kill_grace_sec: 30,
    max_concurrent: 1, escalate_after: 2, gaps: {}, ...config.watch };
  if (command === 'watch') {
    if (flags.role !== undefined) config.watch.role = flags.role;
    if (flags.interval !== undefined) config.watch.interval_sec = flags.interval;
  }
  if (!['watcher', 'agent-host'].includes(config.watch.role)) throw invalid('unknown watch role');
  if (command === 'watch' && config.watch.dispatch !== undefined && !object(config.watch.dispatch)) throw invalid('invalid dispatch config');
  config.watch.dispatch = { command: [], timeout_sec: 840, cwd: undefined,
    pass_env: ['PATH', 'HOME', 'LANG', 'TMPDIR', 'TEMP', 'SYSTEMROOT', 'USERPROFILE'], ...config.watch.dispatch };
  if (command === 'watch') {
    if (typeof config.watch.watcher_id !== 'string') throw invalid('invalid watcher_id');
    config.watch.watcher_id = config.watch.watcher_id.toLowerCase();
    if (!/^[a-z0-9._/-]{1,64}$/.test(config.watch.watcher_id)) throw invalid('invalid watcher_id');
    const dispatch = config.watch.dispatch;
    if (!Array.isArray(dispatch.command) || dispatch.command.some(arg => typeof arg !== 'string') ||
        (config.watch.role === 'watcher' && (!dispatch.command.length || !dispatch.command[0].trim()))) {
      throw invalid('dispatch.command must be a nonempty string array for watcher');
    }
    if (!Array.isArray(dispatch.pass_env) || dispatch.pass_env.some(name => typeof name !== 'string')) throw invalid('invalid dispatch.pass_env');
    if (dispatch.cwd !== undefined && (typeof dispatch.cwd !== 'string' || !dispatch.cwd.trim())) throw invalid('invalid dispatch.cwd');
    for (const key of ['interval_sec', 'claim_ttl_sec', 'renew_sec', 'max_concurrent', 'escalate_after']) {
      if (!Number.isSafeInteger(config.watch[key]) || config.watch[key] <= 0) throw invalid('invalid watch.' + key);
    }
    if (!Number.isSafeInteger(config.watch.kill_grace_sec) || config.watch.kill_grace_sec < 0) throw invalid('invalid watch.kill_grace_sec');
    if (!Number.isSafeInteger(dispatch.timeout_sec) || dispatch.timeout_sec <= 0) throw invalid('invalid dispatch.timeout_sec');
    if (config.watch.renew_sec > config.watch.claim_ttl_sec / 3) throw invalid('renew_sec must be <= claim_ttl_sec / 3');
    if (dispatch.timeout_sec > config.watch.claim_ttl_sec - config.watch.kill_grace_sec) throw invalid('dispatch.timeout_sec must be <= claim_ttl_sec - kill_grace_sec');
    if (!object(config.watch.gaps)) throw invalid('invalid watch.gaps');
    for (const [key, value] of Object.entries(config.watch.gaps)) {
      const gap = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
      if (!Number.isSafeInteger(gap) || gap < 0) throw invalid('invalid watch.gaps');
      config.watch.gaps[key] = gap;
    }
  }
  config.owner = { mention: '', ...config.owner };
  config.notify = config.notify ?? [];
  if (!Array.isArray(config.notify) || config.notify.some(entry => !object(entry) || !['telegram', 'slack', 'webhook'].includes(entry.type))) {
    throw invalid('invalid notify type');
  }
  config.file = { path: path.join(home, 'board.jsonl'), scan_max_lines: 50000, ...config.file };
  if (typeof config.file.path !== 'string' || !config.file.path) throw invalid('invalid board file path');
  const limits = { max_comments_per_issue: 400, max_comments_per_issue_per_hour: 12,
    max_pages_per_list: 10, max_api_calls_per_pass: 60 };
  for (const [key, value] of Object.entries(limits)) config[key] = config[key] ?? config.sink[key] ?? value;
  for (const [section, keys] of [[config, Object.keys(limits)], [config.watch, ['watcher_gap_sec', 'heartbeat_gap_sec', 'renotify_sec', 'notify_confirm_sec']], [config.file, ['scan_max_lines']]]) {
    for (const key of keys) if (!Number.isSafeInteger(section[key]) || section[key] < 0) throw invalid('invalid numeric config');
  }
  if (command === 'watch' && config.watch.role === 'watcher') {
    const minimum = minimumWatchClaimBudget(config);
    if (config.max_api_calls_per_pass < minimum) {
      const message = 'max_api_calls_per_pass=' + config.max_api_calls_per_pass + ' is below the minimum ' + minimum +
        ' (max_pages_per_list + 7) needed to elect one claim';
      const error = invalid(message);
      error.code = message;
      throw error;
    }
  }
  function checkURL(value, label) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch (_) { throw invalid('invalid ' + label + ' URL'); }
  }
  // Validate every non-secret setting before reading any credential file.
  if (config.sink.type === 'github-issue' &&
      (typeof config.sink.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.sink.repo))) throw invalid('invalid GitHub repo');
  if (config.sink.type !== 'file') checkURL(config.sink.type === 'github-issue' ? config.sink.api_base : config.sink.url, 'sink');
  for (const entry of config.notify) {
    if (entry.type === 'telegram') {
      if (!['string', 'number'].includes(typeof entry.chat_id) || !String(entry.chat_id).trim()) throw invalid('invalid Telegram chat_id');
    } else if (entry.type === 'webhook') {
      checkURL(entry.url, 'notify webhook');
    }
  }
  // Inline credentials are never accepted as sources.
  delete config.sink.token;
  delete config.sink.headers;
  const secrets = [];
  if (config.sink.type === 'github-issue') {
    const token = env.ERRMETER_GITHUB_TOKEN || readSecret(config.sink.token_file);
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw invalid('missing or invalid GitHub credential');
    config.sink.token = token.trim();
    secrets.push(config.sink.token);
  }
  function readHeaders(file) {
    let headers;
    try { headers = JSON.parse(readSecret(file)); }
    catch (error) { if (error instanceof ConfigError) throw error; throw invalid('invalid headers file'); }
    if (!object(headers) || Object.entries(headers).some(([key, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value))) throw invalid('invalid headers file');
    secrets.push(...Object.values(headers));
    return headers;
  }
  if (config.sink.type === 'webhook' && config.sink.headers_file) config.sink.headers = readHeaders(config.sink.headers_file);
  for (const entry of config.notify) {
    delete entry.token;
    delete entry.bot_token;
    delete entry.webhook_url;
    delete entry.headers;
    if (entry.type === 'telegram') {
      entry.token = readSecret(entry.bot_token_file);
      if (!entry.token || /[\s/?#]/.test(entry.token)) throw invalid('invalid Telegram credential');
      secrets.push(entry.token);
    } else if (entry.type === 'slack') {
      entry.webhook_url = readSecret(entry.webhook_url_file);
      checkURL(entry.webhook_url, 'Slack webhook');
      secrets.push(entry.webhook_url);
    } else {
      if (entry.headers_file !== undefined) entry.headers = readHeaders(entry.headers_file);
    }
  }
  result.maskList = Array.from(new Set([...require('./redact').buildMaskList(config, env), ...secrets])).sort((a, b) => b.length - a.length);
  return result;
}
module.exports = { DEFAULTS, resolveConfig, ConfigError, secretFile, minimumWatchClaimBudget };
