'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { parse, UsageError, USAGE } = require('./cli');
const { resolveConfig, ConfigError } = require('./config');
const { redact, buildMaskList, tailLines, sensitiveKey } = require('./redact');
const { fingerprint, FPV } = require('./fingerprint');
const spool = require('./spool');
const version = require('../package.json').version;

function write(target, text) {
  try {
    if (typeof target === 'function') target(text);
    else target.write(text);
  } catch (_) { /* A closed output must not break a caller's hook. */ }
}
function prefix(text, length) {
  const part = text.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(part) ? part.slice(0, -1) : part;
}
function suffixBytes(text, budget) {
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - Math.max(0, budget));
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}
function capDetail(text, maxBytes, tail) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = `[errmeter: truncated to last ${tail} lines]`;
  // A configured cap smaller than the marker cannot accommodate a marked tail.
  if (Buffer.byteLength(marker) > maxBytes) return '';
  const body = text.startsWith(marker + '\n') ? text.slice(marker.length + 1) : text;
  const remaining = maxBytes - Buffer.byteLength(marker) - 1;
  return remaining < 0 ? marker : marker + '\n' + suffixBytes(body, remaining);
}
function fitEvent(event) {
  // Reserve room for both spool-owned metadata entries and their JSON punctuation.
  const limit = 32768 - 64;
  const size = () => Buffer.byteLength(JSON.stringify(event) + '\n');
  if (size() > limit && event.detail) {
    let lines = event.detail.split(/\r\n|\r|\n/);
    if (/^\[errmeter: truncated to last \d+ lines\]$/.test(lines[0])) lines.shift();
    if (lines.at(-1) === '') lines.pop();
    while (size() > limit && lines.length) {
      lines.shift();
      event.detail = `[errmeter: truncated to last ${lines.length} lines]\n` + lines.join('\n');
    }
  }
  while (size() > limit) {
    const keys = Object.keys(event.meta || {}).filter(key => event.meta[key].length);
    if (!keys.length) break;
    for (const key of keys) event.meta[key] = prefix(event.meta[key], Math.floor(event.meta[key].length / 2));
  }
  return event;
}
function emit(argv, env = process.env, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let diagnosed = false;
  const diagnose = text => {
    if (!diagnosed) { diagnosed = true; write(stderr, text.replace(/[\r\n]+/g, ' ').trim() + '\n'); }
  };
  let flags;
  try { flags = parse(argv); }
  catch (error) {
    diagnose(error instanceof UsageError ? error.message : 'emit: unexpected failure');
    return error instanceof UsageError ? 2 : 0;
  }
  try {
    if (flags.help || flags.version) {
      if (!flags.quiet) write(stdout, flags.version ? version + '\n' : USAGE);
      return 0;
    }
    const { home, configPath, config, warning } = resolveConfig(flags, env);
    if (warning) diagnose(warning);
    const masks = buildMaskList(config, env);
    const clean = value => redact(String(value), masks);
    const identity = (value, allowed) => prefix(clean(value).toLowerCase().replace(allowed, '-'), 64) || 'unknown';
    const agent = identity(flags.agent ?? env.ERRMETER_AGENT ?? config.agent ?? 'unknown', /[^a-z0-9._/-]/g);
    const host = identity(config.host ?? os.hostname().split('.')[0], /[^a-z0-9._-]/g);
    const event = {
      schema: 1, id: crypto.randomUUID(), ts: new Date().toISOString(), kind: flags.kind,
      agent, host, message: prefix(clean(flags.message ?? '').replace(/[\r\n]+/g, ' '), 500),
      emitter: 'errmeter/' + version, attempts: 0
    };
    if (typeof config.family === 'string') event.family = prefix(clean(config.family), 64);
    if (flags.task !== undefined) event.task = prefix(clean(flags.task), 200);
    const meta = Object.create(null);
    for (const key of Object.keys(flags.meta)) {
      const value = clean(flags.meta[key]);
      meta[key] = sensitiveKey.test(key) ? '[REDACTED]' : prefix(value, 256);
    }
    if (Object.keys(meta).length) event.meta = meta;
    const tail = flags.tail ?? config.spool.tail_lines;
    if (event.kind === 'error') {
      event.fpv = FPV;
      event.fingerprint = fingerprint(agent, event.message);
      let detail;
      try {
        if (flags['detail-file'] !== undefined) detail = fs.readFileSync(flags['detail-file'], 'utf8');
        else if (flags.detail === '-') detail = io.readStdin ? io.readStdin() : fs.readFileSync(0, 'utf8');
      } catch (_) { diagnose('emit: unable to read detail'); }
      if (detail !== undefined) event.detail = capDetail(tailLines(clean(detail), tail).text, config.spool.detail_max_bytes, tail);
    }
    fitEvent(event);
    let result;
    try {
      result = (io.writeEvent ?? spool.writeEvent)(home, event, { spool: config.spool, stderr: diagnose });
    } catch (_) { diagnose('emit: unable to write spool'); result = { ok: false }; }
    if (!result || !result.ok) {
      result = { ok: false, fallback: Boolean(result?.fallback) };
      diagnose('emit: unable to write spool');
    }
    if (result.ok && !flags['no-flush']) {
      try {
        const child = (io.spawn ?? childProcess.spawn)(process.execPath,
          [path.resolve(__dirname, '../bin/errmeter.js'), 'flush', '--home', home, '--config', configPath],
          { detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true });
        if (child.on) child.on('error', () => {});
        child.unref();
      } catch (_) { /* Flush is best effort and never holds emit open. */ }
    }
    if (!flags.quiet) {
      const summary = { ok: result.ok, id: event.id, ts: event.ts, kind: event.kind, agent, host,
        ...(event.fingerprint ? { fingerprint: event.fingerprint } : {}),
        mode: result.mode ?? null, path: result.path ?? null, fallback: Boolean(result.fallback) };
      write(stdout, flags.json ? JSON.stringify(summary) + '\n' :
        result.ok ? `emit ${result.mode} ${event.id} ${result.path}\n` : 'emit failed\n');
    }
    return 0;
  } catch (error) {
    diagnose(error instanceof ConfigError ? error.message : 'emit: unexpected failure');
    if (!flags.quiet) write(stdout, flags.json ? '{"ok":false,"mode":null,"path":null,"fallback":false}\n' : 'emit failed\n');
    return 0;
  }
}
function main(argv) {
  // Stream errors are asynchronous, including EPIPE when a pipeline closes early.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  try { process.exitCode = emit(argv); }
  catch (_) { write(process.stderr, 'emit: unexpected failure\n'); process.exitCode = 0; }
}
module.exports = { emit, main };
