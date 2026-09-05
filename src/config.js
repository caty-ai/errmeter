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
function resolveConfig(flags = {}, env = process.env) {
  const home = path.resolve(flags.home ?? env.ERRMETER_HOME ?? path.join(os.homedir(), '.errmeter'));
  const configPath = path.resolve(flags.config ?? env.ERRMETER_CONFIG ?? path.join(home, 'config.json'));
  let config = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
  } catch (_) { /* Emit works without a usable configuration. */ }
  let warning;
  if (typeof config.schema === 'number' && config.schema > 1) {
    warning = `emit: config schema ${config.schema} not supported, using defaults`;
    config = {};
  }
  const extra = config.spool && typeof config.spool === 'object' && !Array.isArray(config.spool) ? config.spool : {};
  const spool = { ...extra, ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = config.spool?.[key];
    if (Number.isSafeInteger(value) && value >= 0) spool[key] = value;
  }
  return { home, configPath, warning, config: { ...config, spool } };
}
module.exports = { DEFAULTS, resolveConfig, ConfigError };
