'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DEFAULTS, resolveConfig, ConfigError } = require('./config');
const { cleanValue } = require('./sinks/clean');
const { buildMaskList } = require('./redact');
const githubIssue = require('./sinks/github-issue');

const LABELS = ['errmeter', 'errmeter:failure', 'errmeter:heartbeat', 'errmeter:alert',
  'errmeter:role:watcher', 'errmeter:role:agent-host', 'errmeter:claimed',
  'errmeter:dispatched', 'errmeter:repaired', 'errmeter:dispatch-failed', 'errmeter:needs-human'];
const PERMISSION_NOTE = '403/404: consistent with least privilege, not proof — confirm on the token\'s permission page (checkpoint #2). An empty repo returns 404 even with Contents read; the authoritative check is the human checkpoint #2 in EPIC #1 (owner looks at the token\'s permission page).';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function output(stream, text) { if (typeof stream === 'function') stream(text); else stream?.write(text); }

// Shared by init and status; diagnostics never incorporate response bodies or
// transport errors, either of which can contain credentials.
async function probePermissions(ctx) {
  const root = '/repos/' + ctx.config.sink.repo;
  const probes = [];
  const warnings = [];
  const requestTarget = target => {
    const base = new URL(ctx.config.sink.api_base || 'https://api.github.com');
    const relative = new URL(target, 'https://errmeter.invalid');
    const prefix = base.pathname.replace(/\/+$/, '');
    base.pathname = prefix + relative.pathname;
    base.search = relative.search;
    base.hash = '';
    return base.toString();
  };
  async function probe(method, target, body, accept = response => response.status >= 200 && response.status < 300) {
    const name = method + ' ' + target;
    let response;
    try { response = await githubIssue.request(ctx, method, requestTarget(target), body); }
    catch (_) {
      const origin = new URL(ctx.config.sink.api_base || 'https://api.github.com').origin;
      const error = new Error('Permission probe failed: ' + name + ' (transport to ' + origin + ')');
      error.probe = name; throw error;
    }
    if (!response || !accept(response)) {
      const status = Number.isInteger(response?.status) ? response.status : 'invalid response';
      const error = new Error('Permission probe failed: ' + name + ' (HTTP ' + status + ')');
      error.probe = name; throw error;
    }
    probes.push({ probe: name, status: response.status });
    return response;
  }
  await probe('GET', root);
  await probe('GET', root + '/issues?per_page=1');
  for (const name of LABELS) {
    await probe('POST', root + '/labels', { name, color: '6e7781' }, response =>
      response.status >= 200 && response.status < 300 || response.status === 422 &&
      (response.body?.message === 'already_exists' || response.body?.errors?.some(error => error.code === 'already_exists')));
  }
  const created = await probe('POST', root + '/issues', { title: '[errmeter] probe',
    body: 'Temporary errmeter Issues permission check.', labels: ['errmeter'] });
  if (!Number.isSafeInteger(created.body?.number) || created.body.number <= 0) {
    const error = new Error('Permission probe failed: POST ' + root + '/issues (missing Issue number)');
    error.probe = 'POST ' + root + '/issues'; throw error;
  }
  try {
    await probe('PATCH', root + '/issues/' + created.body.number, { state: 'closed' });
  } catch (error) {
    error.warnings = ['warning: probe Issue #' + created.body.number + ' left open — close it manually'];
    throw error;
  }
  for (const suffix of ['/contents/', '/pulls?per_page=1']) {
    const response = await probe('GET', root + suffix, undefined, result => [200, 403, 404].includes(result.status));
    if (response.status === 200) warnings.push('over-scoped (warning): GET ' + root + suffix + ' returned 200');
  }
  return { probes, warnings, permission_note: PERMISSION_NOTE };
}

function readJSON(io, file, fallback) {
  try { return JSON.parse(io.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw new ConfigError('status: cannot read valid local state/config'); }
}

function localConfig(flags, env, io = {}) {
  const disk = io.fs || fs;
  const home = path.resolve(flags.home ?? env.ERRMETER_HOME ?? path.join(os.homedir(), '.errmeter'));
  const configPath = path.resolve(flags.config ?? env.ERRMETER_CONFIG ?? path.join(home, 'config.json'));
  const config = readJSON(disk, configPath);
  const invalid = () => { throw new ConfigError('status: invalid config'); };
  if (!object(config) || config.schema !== 1) invalid();
  for (const key of ['sink', 'spool', 'watch', 'owner', 'file']) if (config[key] !== undefined && !object(config[key])) invalid();
  config.sink = { type: 'github-issue', ...config.sink };
  config.spool = { ...DEFAULTS, ...config.spool };
  config.watch = { role: 'watcher', interval_sec: 60, heartbeat_gap_sec: 900, watcher_gap_sec: 600, gaps: {}, ...config.watch };
  if (!['github-issue', 'file', 'webhook'].includes(config.sink.type) || !['watcher', 'agent-host'].includes(config.watch.role)) invalid();
  if (config.sink.type === 'github-issue' && (typeof config.sink.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.sink.repo))) invalid();
  if (config.sink.type === 'webhook' && typeof config.sink.url !== 'string') invalid();
  if (config.sink.type === 'file' && config.file?.path !== undefined && (typeof config.file.path !== 'string' || !config.file.path)) invalid();
  if (config.sink.type !== 'file') {
    try {
      const target = new URL(config.sink.type === 'github-issue' ? config.sink.api_base || 'https://api.github.com' : config.sink.url);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) invalid();
    } catch (_) { invalid(); }
  }
  if (config.notify !== undefined && (!Array.isArray(config.notify) || config.notify.some(entry => !object(entry) || !['telegram', 'slack', 'webhook'].includes(entry.type)))) invalid();
  for (const key of Object.keys(DEFAULTS)) if (!Number.isSafeInteger(config.spool[key]) || config.spool[key] < 0) invalid();
  for (const key of ['heartbeat_gap_sec', 'watcher_gap_sec']) if (!Number.isSafeInteger(config.watch[key]) || config.watch[key] < 0) invalid();
  if (!Number.isSafeInteger(config.watch.interval_sec) || config.watch.interval_sec <= 0) invalid();
  if (!object(config.watch.gaps)) invalid();
  return { home, configPath, config };
}

function countPending(disk, home) {
  try { return disk.readdirSync(path.join(home, 'spool', 'pending')).filter(name => !name.endsWith('.tmp')).length; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

async function boardHealth(ctx) {
  const sink = ctx.sink || require('./sinks/' + ctx.config.sink.type);
  if (typeof sink.listHeartbeats !== 'function') throw new ConfigError('status: sink is not a board');
  const heartbeats = await sink.listHeartbeats(ctx);
  if (ctx.lookup_incomplete || !Array.isArray(heartbeats)) throw new ConfigError('status: heartbeat lookup incomplete');
  let gaps = 0;
  if (ctx.config.sink.type === 'github-issue') {
    let next = '/repos/' + ctx.config.sink.repo + '/issues?state=open&labels=errmeter%3Aalert&per_page=100';
    for (let page = 0; next; page++) {
      if (page >= (ctx.config.max_pages_per_list ?? 10)) throw new ConfigError('status: alert lookup incomplete');
      const response = await githubIssue.request(ctx, 'GET', next);
      if (response?.status !== 200 || !Array.isArray(response.body)) throw new ConfigError('status: alert lookup failed');
      gaps += response.body.filter(row => !row.pull_request && /^<!-- errmeter:alert key=(?:heartbeat-gap:[^\s]+|all-watchers-silent) -->$/.test((row.body || '').split(/\r?\n/, 1)[0])).length;
      next = ((response.headers?.link || response.headers?.Link || '').match(/<([^>]+)>;\s*rel="next"/) || [])[1];
    }
  }
  return { watcher_heartbeats: heartbeats.filter(record => record.role === 'watcher').length, gaps };
}

async function status(argv, env = process.env, io = {}) {
  const stdout = io.stdout || process.stdout, stderr = io.stderr || process.stderr;
  let flags; let masks = []; let result;
  const report = (code, data) => {
    const cleaned = cleanValue(data, masks);
    data = cleaned;
    io.onResult?.(cleaned);
    if (!flags?.quiet) {
      if (flags?.json) output(stdout, JSON.stringify(cleaned) + '\n');
      else output(stdout, 'status: ' + (code === 2 ? 'usage error' : code === 3 ? 'cannot check' : code ? 'degraded' : 'healthy') +
        (data.pending === undefined ? '' : ', config=' + data.config_path + ', role=' + data.role + ', ' + data.pending +
        ' pending, last successful flush: ' + (data.last_successful_flush || 'never') +
        ', last flush: ' + (data.last_flush.ts || 'never') + ' pending=' + data.last_flush.pending_remaining + ' errors=' + data.last_flush.errors +
        ', last error: ' + (data.last_error || 'none') + ', watcher registered=' + data.watcher.registered +
        ' running=' + data.watcher.running + ' pid=' + (data.watcher.pid ?? 'none') +
        ', registration record: ' + (data.registration_record || 'none') +
        (data.watcher.linger ? ', linger: ' + data.watcher.linger : '') +
        ', last watch: ' + (data.last_watch.ts || 'never') + ' role=' + (data.last_watch.role || 'unknown') +
        ' dispatched=' + data.last_watch.dispatched + ' eligible=' + data.last_watch.eligible +
        ' scanned=' + data.last_watch.scanned + ' unscanned=' + data.last_watch.unscanned +
        ', watcher heartbeats: ' + (data.watcher_heartbeats === null ? 'unknown (use --check)' : data.watcher_heartbeats) +
        (data.notify ? ', notify sent=[' + data.notify.sent.join(',') + '] failed=[' + data.notify.failed.join(',') + ']' : '')) + '\n');
      for (const message of [...(data.warnings || []), ...(data.error ? [data.error] : []), ...(data.permission_note ? [data.permission_note] : [])]) output(stderr, cleanValue(message, masks) + '\n');
    }
    return code;
  };
  try {
    flags = require('./cli').parseStatus(argv);
    if (flags.help || flags.version) {
      output(stdout, flags.version ? require('../package.json').version + '\n' : require('./cli').USAGE); return 0;
    }
    let resolved = localConfig(flags, env, io);
    masks = buildMaskList(resolved.config, env);
    if (flags.check || flags['notify-test']) resolved = resolveConfig(flags, env, { command: 'flush', platform: io.platform });
    masks = [...masks, ...(resolved.maskList || [])];
    const { home, config } = resolved;
    const disk = io.fs || fs;
    const last = readJSON(disk, path.join(home, 'state', 'last_flush.json'), {});
    if (!object(last)) throw new ConfigError('status: invalid last flush state');
    if (last.errors !== undefined && (!Array.isArray(last.errors) || last.errors.some(error => typeof error !== 'string')) ||
        last.ts !== undefined && (typeof last.ts !== 'string' || !Number.isFinite(Date.parse(last.ts))) ||
        last.lookup_incomplete !== undefined && typeof last.lookup_incomplete !== 'boolean' ||
        last.pending_remaining !== undefined && (!Number.isSafeInteger(last.pending_remaining) || last.pending_remaining < 0)) throw new ConfigError('status: invalid last flush state');
    const lastWatch = readJSON(disk, path.join(home, 'state', 'last_watch.json'), {});
    if (!object(lastWatch) || lastWatch.ts !== undefined && (typeof lastWatch.ts !== 'string' || !Number.isFinite(Date.parse(lastWatch.ts)))) throw new ConfigError('status: invalid last watch state');
    for (const key of ['dispatched', 'eligible', 'scanned', 'unscanned']) if (lastWatch[key] !== undefined && (!Number.isSafeInteger(lastWatch[key]) || lastWatch[key] < 0)) throw new ConfigError('status: invalid last watch state');
    if (lastWatch.role !== undefined && !['watcher', 'agent-host'].includes(lastWatch.role)) throw new ConfigError('status: invalid last watch state');
    const registration = await (io.registrationStatus || require('./install').registrationStatus)({ ...flags, check: false }, env, { ...io, resolved });
    const running = registration.running ?? null;
    const watcher = { registered: Boolean(registration.registered), running,
      pid: registration.pid ?? (typeof running === 'number' ? running : null),
      ...(registration.linger ? { linger: registration.linger } : {}) };
    const flushFailed = Boolean(last.errors?.length || last.lookup_incomplete);
    const flushStale = last.ts ? (io.clock || Date.now)() - Date.parse(last.ts) > 2 * config.watch.interval_sec * 1000 : watcher.registered;
    result = { config_path: resolved.configPath, role: registration.role || flags.role || config.watch.role,
      registration_record: registration.registrationRecord || null,
      pending: countPending(disk, home), pending_soft_limit: config.spool.pending_soft_limit,
      last_flush: { ts: last.ts || null, pending_remaining: last.pending_remaining ?? 0, errors: last.errors?.length || 0 },
      last_watch: { ts: lastWatch.ts || null, role: lastWatch.role || null, dispatched: lastWatch.dispatched ?? 0,
        eligible: lastWatch.eligible ?? 0, scanned: lastWatch.scanned ?? 0, unscanned: lastWatch.unscanned ?? 0 },
      last_successful_flush: last.last_successful_flush || (!flushFailed ? last.ts : null) || null,
      last_error: Array.isArray(last.errors) ? last.errors.at(-1) || null : null,
      last_flush_failed: flushFailed, last_flush_stale: flushStale, watcher, watcher_heartbeats: null, gaps: null,
      warnings: [...(resolved.warning ? [resolved.warning] : []), ...(registration.warnings || [])] };
    if (registration.registrationRecord && registration.installedRole !== config.watch.role) {
      result.warnings.push('installed role ' + registration.installedRole + ' differs from config watch.role ' + config.watch.role);
    }
    const ctx = { ...resolved, env, maskList: masks, http: io.http, sink: io.sink, clock: io.clock || Date.now };
    ctx.now = () => ctx.boardTime || new Date(ctx.clock()).toISOString();
    if (flags.check) {
      if (config.sink.type === 'webhook') throw new ConfigError('status: sink is not a board');
      if (config.sink.type === 'github-issue') {
        const checked = await probePermissions(ctx);
        result.probes = checked.probes; result.warnings.push(...checked.warnings); result.permission_note = checked.permission_note;
      }
      Object.assign(result, await boardHealth(ctx));
    }
    if (flags['notify-test']) {
      result.notify = await (io.notify || require('./notify').notify)(ctx, {
        key: 'notify-test', title: '[errmeter] notify test', body: config.host + ' ' + new Date(ctx.clock()).toISOString() });
    }
    if (!last.ts) result.warnings.push('no flush recorded yet');
    if (result.watcher_heartbeats === 0) result.warnings.push('no watcher known');
    const degraded = !last.ts || result.pending > result.pending_soft_limit || flushFailed || flushStale || watcher.registered && !lastWatch.ts ||
      result.gaps > 0 || result.watcher_heartbeats === 0 || result.notify?.failed?.length;
    if (registration.platform === 'linux' && registration.scope === 'user' && (flags.check || watcher.registered && degraded)) {
      watcher.linger = await require('./install').probeLinger(io);
    }
    return report(degraded ? 1 : 0, result);
  } catch (error) {
    const usage = error instanceof require('./cli').UsageError;
    const message = error instanceof ConfigError || usage || error.probe ? error.message : 'status: cannot check local or board state';
    return report(usage ? 2 : 3, { ...result, error: message,
      warnings: [...(result?.warnings || []), ...(error.warnings || [])],
      ...(error.probe ? { failing_probe: error.probe } : {}) });
  }
}

async function main(argv) {
  try { process.exitCode = await status(argv); }
  catch (_) { process.exitCode = 3; if (!argv.includes('--quiet')) output(process.stderr, 'status: unexpected failure\n'); }
}
module.exports = { status, main, probePermissions, PERMISSION_NOTE, LABELS, localConfig };
