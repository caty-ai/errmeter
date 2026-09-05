'use strict';

const USAGE = 'Usage: errmeter <emit|flush|watch> [--home DIR] [--config FILE] [--json] [--quiet]\n' +
  'emit: --agent NAME --kind error|heartbeat --message TEXT [--detail-file PATH | --detail -] [--tail N] [--task TEXT] [--meta k=v] [--no-flush]\n' +
  'watch: [--role watcher|agent-host] [--once] [--interval SEC]\n' +
  'Values starting with -- must be passed as --flag=value.\n';
class UsageError extends Error {}
function parse(argv) {
  const result = { kind: 'error', meta: Object.create(null) };
  const boolean = new Set(['json', 'quiet', 'no-flush', 'help', 'version']);
  const values = new Set(['home', 'config', 'agent', 'kind', 'message', 'detail-file', 'detail', 'tail', 'task', 'meta']);
  let entries = 0;
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([^=]+)(?:=([\s\S]*))?$/.exec(argv[i]);
    if (!match) throw new UsageError('emit: expected a flag');
    const key = match[1];
    if (boolean.has(key)) {
      if (match[2] !== undefined) throw new UsageError('emit: boolean flags take no value');
      result[key] = true;
      continue;
    }
    if (!values.has(key)) throw new UsageError('emit: unknown flag');
    let value = match[2];
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError('emit: missing flag value');
    }
    if (key === 'meta') {
      const pair = /^([A-Za-z0-9_.-]{1,32})=([\s\S]*)$/.exec(value);
      if (!pair || pair[1].startsWith('_') || ++entries > 16) throw new UsageError('emit: invalid meta');
      result.meta[pair[1]] = pair[2];
    } else result[key] = value;
  }
  if (!['error', 'heartbeat'].includes(result.kind)) throw new UsageError('emit: invalid kind');
  if (result.tail !== undefined) {
    if (!/^\d+$/.test(result.tail) || !Number.isSafeInteger(Number(result.tail))) throw new UsageError('emit: invalid tail');
    result.tail = Number(result.tail);
  }
  if (result.detail !== undefined && result.detail !== '-') throw new UsageError('emit: detail must be -');
  if (result.detail !== undefined && result['detail-file'] !== undefined) throw new UsageError('emit: conflicting detail sources');
  for (const key of ['home', 'config', 'detail-file']) {
    if (result[key] === '') throw new UsageError('emit: empty path');
  }
  if (!result.help && !result.version && result.kind === 'error' && result.message === undefined) throw new UsageError('emit: message is required');
  return result;
}
function parseFlush(argv) {
  const result = {};
  const boolean = new Set(['json', 'quiet', 'dry-run', 'linger', 'help', 'version']);
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([^=]+)(?:=([\s\S]*))?$/.exec(argv[i]);
    if (!match) throw new UsageError('flush: expected a flag');
    const key = match[1];
    if (boolean.has(key)) {
      if (match[2] !== undefined) throw new UsageError('flush: boolean flags take no value');
      result[key] = true;
    } else {
      if (key !== 'home' && key !== 'config') throw new UsageError('flush: unknown flag');
      const value = match[2] === undefined ? argv[++i] : match[2];
      if (value === undefined || (match[2] === undefined && value.startsWith('--'))) throw new UsageError('flush: missing flag value');
      if (!value) throw new UsageError('flush: empty path');
      result[key] = value;
    }
  }
  return result;
}
function parseWatch(argv) {
  const result = {};
  const boolean = new Set(['json', 'quiet', 'once', 'help', 'version']);
  const values = new Set(['home', 'config', 'role', 'interval']);
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([^=]+)(?:=([\s\S]*))?$/.exec(argv[i]);
    if (!match) throw new UsageError('watch: expected a flag');
    const key = match[1];
    if (boolean.has(key)) {
      if (match[2] !== undefined) throw new UsageError('watch: boolean flags take no value');
      result[key] = true;
    } else {
      if (!values.has(key)) throw new UsageError('watch: unknown flag');
      const value = match[2] === undefined ? argv[++i] : match[2];
      if (!value || (match[2] === undefined && value.startsWith('--'))) throw new UsageError('watch: missing flag value');
      result[key] = value;
    }
  }
  if (result.role !== undefined && !['watcher', 'agent-host'].includes(result.role)) throw new UsageError('watch: invalid role');
  if (result.interval !== undefined) {
    if (!/^\d+$/.test(result.interval) || !Number.isSafeInteger(Number(result.interval)) || Number(result.interval) <= 0) throw new UsageError('watch: invalid interval');
    result.interval = Number(result.interval);
  }
  return result;
}
function parseRun(argv) {
  const result = {};
  const values = new Set(['deadline-ms', 'deadline-mono-ms', 'timeout', 'state']);
  let i = 0;
  for (; i < argv.length && argv[i] !== '--'; i++) {
    const match = /^--([^=]+)(?:=([\s\S]*))?$/.exec(argv[i]);
    if (!match || !values.has(match[1])) throw new UsageError('_run: invalid flag');
    const value = match[2] === undefined ? argv[++i] : match[2];
    if (!value || (match[2] === undefined && value.startsWith('--'))) throw new UsageError('_run: missing flag value');
    result[match[1]] = value;
  }
  result.command = argv.slice(i + 1);
  if (!result.state || !result.command.length || !result.command[0]) throw new UsageError('_run: state and command required');
  for (const key of ['deadline-ms', 'deadline-mono-ms', 'timeout']) {
    if (!/^\d+(?:\.\d+)?$/.test(result[key] || '') || !Number.isFinite(Number(result[key]))) throw new UsageError('_run: invalid deadline or timeout');
    result[key] = Number(result[key]);
  }
  return result;
}
module.exports = { parse, parseFlush, parseWatch, parseRun, UsageError, USAGE };
