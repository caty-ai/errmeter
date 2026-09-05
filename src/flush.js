'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { resolveConfig } = require('./config');
const { parseFlush, USAGE } = require('./cli');
const { buildMaskList, sensitiveKey } = require('./redact');
const { cleanValue } = require('./sinks/clean');
const version = require('../package.json').version;

function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    try { fs.fsyncSync(fd); } catch (_) { /* best effort */ }
    fs.closeSync(fd); fd = undefined;
    try { fs.renameSync(tmp, file); } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      fs.renameSync(tmp, file);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (_) { /* renamed or failed */ }
  }
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && arguments.length > 1) return fallback; throw error; }
}
function entries(dir) {
  try { return fs.readdirSync(dir).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function size(file) {
  try { return fs.statSync(file).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}
function output(target, text) {
  try { if (typeof target === 'function') target(text); else target.write(text); } catch (_) { /* closed pipe */ }
}
function eventForBoard(event, masks) {
  const clean = cleanValue(event, masks);
  if (clean.meta && typeof clean.meta === 'object') {
    for (const key of Object.keys(clean.meta)) if (sensitiveKey.test(key)) clean.meta[key] = '[REDACTED]';
  }
  return clean;
}
function acquire(home, limits, clock) {
  const file = path.join(home, 'spool', 'flush.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  let fd;
  function create() {
    fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce, ts: new Date(clock()).toISOString(), host: os.hostname() }) + '\n');
  }
  try { create(); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let old;
    try { old = readJSON(file); } catch (_) { return null; }
    if (!Number.isFinite(Date.parse(old.ts)) || clock() - Date.parse(old.ts) <= limits.lock_stale_sec * 1000) return null;
    try { fs.renameSync(file, file + '.stale-' + nonce); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    try { create(); } catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  }
  let released = false;
  function owned() {
    if (released) return false;
    try { return readJSON(file).nonce === nonce; } catch (_) { return false; }
  }
  function refresh() {
    if (!owned()) return;
    // Rewrite our open inode: a stealer's replacement must never be overwritten.
    const data = JSON.stringify({ pid: process.pid, nonce, ts: new Date(clock()).toISOString(), host: os.hostname() }) + '\n';
    fs.writeSync(fd, data, 0, 'utf8'); fs.ftruncateSync(fd, Buffer.byteLength(data));
  }
  const timer = setInterval(() => { try { refresh(); } catch (_) { /* next ownership check fails closed */ } }, Math.max(1, limits.lock_refresh_sec * 1000));
  return { owned, release() {
    clearInterval(timer);
    if (owned()) { try { fs.unlinkSync(file); } catch (_) { /* best effort */ } }
    released = true;
    try { fs.closeSync(fd); } catch (_) { /* already closed */ }
  } };
}
function move(item, destination) {
  if (item.source !== fs.readFileSync(item.file, 'utf8')) return false;
  const target = path.join(path.dirname(path.dirname(item.file)), destination, item.basename || path.basename(item.file));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.renameSync(item.file, target);
  return true;
}
function attempt(item) {
  const event = JSON.parse(item.source);
  event.attempts = (Number.isSafeInteger(event.attempts) && event.attempts >= 0 ? event.attempts : 0) + 1;
  atomic(item.file, event);
  item.source = JSON.stringify(event) + '\n';
  item.event.attempts = event.attempts;
}
function failurePayload(group) {
  const { fingerprint, fpv, agent, count, events, counter } = group;
  return { fingerprint, fpv, agent, count, events, ...(counter === undefined ? {} : { counter }) };
}
function prune(root, type, days, maxBytes, clock) {
  const dir = path.join(root, 'spool', type);
  const files = entries(dir).map(name => ({ file: path.join(dir, name), stat: fs.statSync(path.join(dir, name)) }))
    .filter(item => item.stat.isFile()).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.file.localeCompare(b.file));
  let total = files.reduce((sum, item) => sum + item.stat.size, 0);
  for (const item of files) {
    if (clock() - item.stat.mtimeMs > days * 86400000 || total > maxBytes) {
      fs.unlinkSync(item.file); total -= item.stat.size;
    }
  }
}
function pendingCount(roots) {
  return roots.reduce((total, home) => total + entries(path.join(home, 'spool', 'pending')).filter(name => !name.endsWith('.tmp')).length, 0);
}
function foldedLines(buffer, nonce, k, masks, onInvalid = () => {}) {
  const groups = new Map();
  for (const line of buffer.toString('utf8').split('\n')) {
    if (!line) continue;
    const [fingerprint, fpv, agent, host, ts, ...message] = line.split('\t');
    if (!agent || !host || !Number.isFinite(Date.parse(ts)) || !/^\d+$/.test(fpv || '') || !message.length ||
        !(fingerprint === '-' && fpv === '0' || /^[a-f0-9]{16}$/.test(fingerprint) && Number(fpv) > 0)) {
      onInvalid();
      continue;
    }
    const heartbeat = fingerprint === '-' && fpv === '0';
    const key = heartbeat ? '-' + agent + '@' + host : fingerprint;
    let group = groups.get(key);
    const event = eventForBoard({ schema: 1, id: nonce + '.' + k + '.' + key, ts,
      kind: heartbeat ? 'heartbeat' : 'error', agent, host, message: message.join('\t'),
      ...(heartbeat ? {} : { fingerprint, fpv: Number(fpv) }), emitter: 'errmeter/' + version, attempts: 0 }, masks);
    if (!group) {
      group = { key, heartbeat, fingerprint, fpv: Number(fpv), agent, count: 0, events: [], counter: nonce + '.' + k };
      groups.set(key, group);
    }
    group.count++; group.events.push(event);
  }
  for (const group of groups.values()) group.events.sort((a, b) => a.ts.localeCompare(b.ts));
  return Array.from(groups.values());
}
async function drainCut(root, ctx, sink, masks, sleep, guard, onError) {
  const pending = path.join(root, 'spool', 'pending');
  let cuts = entries(pending).filter(name => /^counters\..+\.log$/.test(name));
  if (!cuts.length && entries(pending).includes('counters.log')) {
    guard();
    const name = 'counters.' + randomUUID() + '.log';
    fs.renameSync(path.join(pending, 'counters.log'), path.join(pending, name));
    cuts = [name];
    await sleep(ctx.config.spool.cut_settle_sec * 1000);
  }
  for (const name of cuts) {
    const file = path.join(pending, name);
    const nonce = name.slice('counters.'.length, -'.log'.length);
    const checkpoint = path.join(ctx.home, 'state', 'cuts', nonce + '.json');
    let cut = readJSON(checkpoint, null);
    if (!cut) cut = { k: 0, offset: 0, end: size(file), posted: [] };
    if (!Number.isSafeInteger(cut.k) || cut.k < 0 || !Number.isSafeInteger(cut.offset) || cut.offset < 0 ||
        !Number.isSafeInteger(cut.end) || cut.end < cut.offset || cut.end > size(file) || !Array.isArray(cut.posted)) {
      throw new Error('invalid counter checkpoint; cut retained');
    }
    for (;;) {
      guard();
      const buffer = fs.readFileSync(file).subarray(cut.offset, cut.end);
      if (buffer.length && buffer[buffer.length - 1] !== 10) throw new Error('incomplete counter line; cut retained');
      let invalid = 0;
      const groups = foldedLines(buffer, nonce, cut.k, masks, () => { invalid++; });
      if (invalid) onError(Object.assign(new Error('invalid overflow counter lines skipped: ' + invalid), { code: 'ECOUNTER_INVALID' }));
      atomic(checkpoint, cut);
      let complete = true;
      for (const group of groups) {
        if (cut.posted.includes(group.key)) continue;
        guard();
        try {
          // Persist even on recovery before the first request for this group.
          atomic(checkpoint, cut);
          const result = group.heartbeat
            ? await sink.deliverHeartbeat(ctx, group.events[group.events.length - 1])
            : await sink.deliverFailureGroup(ctx, failurePayload(group));
          if (result && !result.pending && !result.throttled && !result.lookup_incomplete && (result.ref != null || result.skipped)) {
            cut.posted.push(group.key); atomic(checkpoint, cut);
          } else complete = false;
        } catch (error) { complete = false; onError(error); }
      }
      if (!complete) return;
      await sleep(ctx.config.spool.cut_settle_sec * 1000);
      guard();
      const end = size(file);
      if (end === cut.end) {
        // Preserve the pass boundary until the cut is gone: losing it first
        // would reinterpret a recovered tail as part of pass zero.
        if (invalid && !groups.length && !foldedLines(fs.readFileSync(file), nonce, cut.k, masks).length) move({ file, source: fs.readFileSync(file, 'utf8') }, 'dead');
        else fs.unlinkSync(file);
        fs.unlinkSync(checkpoint);
        break;
      }
      if (end < cut.end) throw new Error('counter cut shrank; cut retained');
      cut = { k: cut.k + 1, offset: cut.end, end, posted: [] };
      atomic(checkpoint, cut);
    }
  }
}
function backoff(error, previous, clock) {
  const status = error.status ?? error.statusCode;
  const headers = error.headers || {};
  if (status === 403 || status === 429) {
    const retry = headers['retry-after'];
    const reset = Number(headers['x-ratelimit-reset']);
    const retryAt = retry !== undefined && /^\d+(?:\.\d+)?$/.test(String(retry)) ? clock() + Number(retry) * 1000 : Date.parse(retry);
    return Math.max(clock() + 5000, Number.isFinite(retryAt) ? retryAt : 0, Number.isFinite(reset) ? reset * 1000 : 0);
  }
  return clock() + (previous ? Math.min(previous * 2, 3600000) : 5000);
}
async function dryRun(roots, ctx, sink, masks) {
  const writes = []; const grouped = new Map(); const heartbeats = new Map();
  let remaining = ctx.config.spool.max_events_per_pass;
  for (const root of roots) {
    const pending = path.join(root, 'spool', 'pending');
    const names = entries(pending);
    const json = names.filter(name => name.endsWith('.json') && name !== 'overflow-exceeded.json');
    const ordered = [...json.filter(name => !name.startsWith('heartbeat-')), ...json.filter(name => name.startsWith('heartbeat-'))];
    const selected = new Set(ordered.slice(0, remaining));
    remaining -= selected.size;
    for (const name of names) {
      if (name.endsWith('.tmp')) continue;
      if (name === 'overflow-exceeded.json') { writes.push({ op: 'alert', key: 'spool-overflow:' + ctx.config.host, count: 1, target: null }); continue; }
      if (/^counters(?:\..+)?\.log$/.test(name)) {
        const nonce = name === 'counters.log' ? 'next-cut' : name.slice(9, -4);
        const checkpoint = readJSON(path.join(ctx.home, 'state', 'cuts', nonce + '.json'), null);
        const bytes = fs.readFileSync(path.join(pending, name));
        const groups = foldedLines(bytes.subarray(checkpoint?.offset || 0, checkpoint?.end ?? bytes.length), nonce, checkpoint?.k || 0, masks);
        for (const group of groups) if (!checkpoint?.posted?.includes(group.key)) writes.push({ op: group.heartbeat ? 'heartbeat' : 'failure', fingerprint: group.fingerprint, counter: group.counter, count: group.count, target: null });
        continue;
      }
      if (!selected.has(name)) continue;
      try {
        const event = eventForBoard(readJSON(path.join(pending, name)), masks);
        if (event.kind === 'heartbeat') heartbeats.set(JSON.stringify([event.agent, event.host]), { op: 'heartbeat', agent: event.agent, host: event.host, count: 1, target: null });
        else if (event.kind === 'error') {
          const key = event.schema > 1 ? event : event.fingerprint;
          if (!grouped.has(key)) grouped.set(key, { op: 'failure', fingerprint: event.fingerprint, count: 0, target: null });
          grouped.get(key).count++;
        } else writes.push({ op: 'dead', count: 1, target: name });
      } catch (_) { writes.push({ op: 'dead', count: 1, target: name }); }
    }
  }
  writes.push(...grouped.values(), ...heartbeats.values());
  if (ctx.config.sink.type !== 'webhook') {
    const failures = await sink.listOpenFailures(ctx);
    const heartbeats = await sink.listHeartbeats(ctx);
    for (const write of writes) {
      const match = write.op === 'failure' ? failures.find(record => record.fingerprint === write.fingerprint)
        : write.op === 'heartbeat' ? heartbeats.find(record => record.agent === write.agent && record.host === write.host) : null;
      if (match) write.target = match.ref;
    }
  } else for (const write of writes) if (write.op !== 'dead') write.target = ctx.config.sink.url;
  return writes;
}

async function flush(argv, env = process.env, io = {}) {
  const stdout = io.stdout ?? process.stdout; const stderr = io.stderr ?? process.stderr;
  let flags;
  try { flags = parseFlush(argv); } catch (_) { output(stderr, 'flush: invalid arguments\n'); return 2; }
  if (flags.help || flags.version) { if (!flags.quiet) output(stdout, flags.version ? version + '\n' : USAGE); return 0; }
  let resolved;
  try { resolved = resolveConfig(flags, env, { command: 'flush' }); }
  catch (error) { if (!flags.quiet) output(stderr, 'flush: ' + (error.code || 'invalid configuration') + '\n'); return 3; }
  const { home, config } = resolved;
  const masks = [...buildMaskList(config, env), ...(resolved.maskList || []), config.sink.token, ...Object.values(config.sink.headers || {})].filter(value => typeof value === 'string' && value.length);
  const clean = value => cleanValue(value, masks);
  const clock = io.clock || Date.now;
  const log = message => {
    const line = clean(String(message)).replace(/[\r\n]+/g, ' ') + '\n';
    if (!flags.quiet) output(stderr, line);
    if (flags['dry-run']) return;
    const file = path.join(home, 'errmeter.log');
    try {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      if (size(file) + Buffer.byteLength(line) > config.spool.log_max_bytes) {
        try { fs.unlinkSync(file + '.1'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (fs.existsSync(file)) fs.renameSync(file, file + '.1');
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch (_) { /* logging cannot change acknowledgement */ }
  };
  if (resolved.warning) log(resolved.warning);
  const sink = io.sink || require('./sinks/' + config.sink.type);
  const ctx = { config, home, log, maskList: masks, http: io.http || require('./http').request,
    now: () => ctx.boardTime || new Date(clock()).toISOString(), dryRun: Boolean(flags['dry-run']) };
  const fallback = path.join(io.tmpdir || os.tmpdir(), 'errmeter-spool');
  const roots = [home];
  if (fallback !== home && fs.existsSync(path.join(fallback, 'spool'))) roots.push(fallback);
  let lock; let stopped = false; let wake;
  const signal = () => { stopped = true; if (wake) wake(); };
  const sleep = io.sleep || (ms => new Promise(resolve => {
    const timer = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  }));
  const guard = () => {
    if (stopped || !lock?.owned()) throw Object.assign(new Error('flush interrupted or lock lost'), { code: 'EINTERRUPTED' });
    if (ctx.apiCalls >= config.max_api_calls_per_pass) {
      ctx.lookup_incomplete = true;
      throw Object.assign(new Error('API budget exhausted'), { code: 'EAPI_BUDGET' });
    }
  };
  let state = { ts: new Date(clock()).toISOString(), pending_remaining: 0, lookup_incomplete: false, errors: [] };
  let writes;
  try {
    if (flags['dry-run']) {
      writes = await dryRun(roots, ctx, sink, masks);
      state.pending_remaining = pendingCount(roots); state.lookup_incomplete = Boolean(ctx.lookup_incomplete);
    } else {
      lock = acquire(home, config.spool, clock);
      if (!lock) {
        if (flags.linger) return 0;
        if (!flags.quiet) output(stdout, flags.json ? '{"busy":true,"pending_remaining":1}\n' : 'busy\n');
        return 1;
      }
      process.on('SIGINT', signal); process.on('SIGTERM', signal);
      const started = clock();
      const saved = readJSON(path.join(home, 'state', 'last_flush.json'), {});
      let until = Date.parse(saved.backoff_until) || 0;
      let backoffStartedAt = Date.parse(saved.ts);
      if (!Number.isFinite(backoffStartedAt)) backoffStartedAt = clock();
      let delay = Math.max(0, until - backoffStartedAt);
      if (!flags.linger && delay <= config.spool.lock_refresh_sec * 1000) until = 0;
      for (;;) {
        let transport = false;
        const previousDelay = delay;
        ctx.apiCalls = 0; ctx.lookup_incomplete = false;
        const onError = error => {
          const message = clean(error.message || error.code || 'flush operation failed');
          state.errors.push(message); log(message);
          if (['EAPI_BUDGET', 'ELOOKUP_INCOMPLETE', 'LOOKUP_INCOMPLETE'].includes(error.code)) ctx.lookup_incomplete = true;
          else if (!['EINTERRUPTED', 'ECOUNTER_INVALID'].includes(error.code)) {
            transport = true;
            const retryUntil = Math.max(until, backoff(error, previousDelay, clock));
            if (retryUntil > until) backoffStartedAt = clock();
            until = retryUntil;
            delay = until - clock();
          }
        };
        if (until <= clock()) {
          until = 0;
          // last_flush describes the current pass; prior failures remain in the log.
          state.errors = [];
          const items = []; let remaining = config.spool.max_events_per_pass;
          for (const root of roots) {
            const pending = path.join(root, 'spool', 'pending');
            const names = entries(pending);
            for (const name of names.filter(value => value.endsWith('.tmp'))) {
              const file = path.join(pending, name);
              if (clock() - fs.statSync(file).mtimeMs > 60000) fs.unlinkSync(file);
            }
            const json = names.filter(name => name.endsWith('.json') && name !== 'overflow-exceeded.json');
            const ordered = [...json.filter(name => !name.startsWith('heartbeat-')), ...json.filter(name => name.startsWith('heartbeat-'))];
            for (const name of ordered.slice(0, remaining)) {
              guard(); remaining--;
              let file = path.join(pending, name);
              let basename = name;
              if (name.startsWith('heartbeat-')) {
                const claimed = /^heartbeat-claimed-[0-9a-f-]{36}\.json$/;
                if (!claimed.test(name)) {
                  // Claim the inode before reading or modifying it. Emits can
                  // replace the canonical upsert while this private file waits.
                  const staged = path.join(pending, 'heartbeat-claimed-' + randomUUID() + '.json');
                  try { fs.renameSync(file, staged); }
                  catch (error) {
                    if (error.code === 'ENOENT') continue; // Emitter's replacement window; retry next pass.
                    throw error;
                  }
                  file = staged;
                  basename = path.basename(staged);
                }
              }
              const source = fs.readFileSync(file, 'utf8');
              let event;
              try { event = JSON.parse(source); } catch (_) { move({ file, source, basename }, 'dead'); continue; }
              if (!event || !['error', 'heartbeat'].includes(event.kind)) { move({ file, source, basename }, 'dead'); continue; }
              if (name.startsWith('heartbeat-') && event.kind === 'heartbeat') {
                basename = 'heartbeat-' + encodeURIComponent(event.agent) + '@' + encodeURIComponent(event.host) + '.json';
              }
              items.push({ file, source, basename, event: eventForBoard(event, masks) });
            }
          }
          const groups = new Map();
          for (const item of items.filter(item => item.event.kind === 'error').sort((a, b) => String(a.event.ts).localeCompare(String(b.event.ts)))) {
            const event = item.event;
            // A future payload must remain the latest (verbatim) event of its
            // own board write, even if schema 1 occurrences share its fingerprint.
            const key = event.schema > 1 ? item : event.fingerprint;
            if (!groups.has(key)) groups.set(key, { fingerprint: event.fingerprint, fpv: event.fpv, agent: event.agent, events: [], count: 0, items: [] });
            const group = groups.get(key); group.events.push(event); group.items.push(item); group.count++;
          }
          for (const group of groups.values()) {
            guard();
            try {
              for (const item of group.items) attempt(item);
              const result = await sink.deliverFailureGroup(ctx, failurePayload(group));
              const delivered = new Set(result?.delivered || []);
              for (const item of group.items) if (delivered.has(item.event.id)) move(item, 'sent');
            } catch (error) {
              // A newer payload rejected as unprocessable has had its verbatim
              // attempt. Authentication, rate limits and transport remain retryable.
              if ([400, 422].includes(error.status ?? error.statusCode)) {
                for (const item of group.items) if (item.event.schema > 1) move(item, 'dead');
                if (group.items.every(item => item.event.schema > 1)) continue;
              }
              onError(error);
            }
          }
          const heartbeatGroups = new Map();
          for (const item of items.filter(item => item.event.kind === 'heartbeat')) {
            const key = JSON.stringify([item.event.agent, item.event.host]);
            if (!heartbeatGroups.has(key)) heartbeatGroups.set(key, []);
            heartbeatGroups.get(key).push(item);
          }
          for (const heartbeatItems of heartbeatGroups.values()) {
            guard();
            heartbeatItems.sort((a, b) => String(a.event.ts).localeCompare(String(b.event.ts)));
            const item = heartbeatItems[heartbeatItems.length - 1];
            try {
              attempt(item);
              const result = await sink.deliverHeartbeat(ctx, item.event);
              if (result && !result.pending && !result.throttled && !result.lookup_incomplete && (result.ref != null || result.skipped)) {
                // Superseded observations are acknowledged only once the board
                // has accepted the newest one. Keep each superseded observation
                // under its private claim name for an intact audit trail.
                for (const older of heartbeatItems.slice(0, -1)) move({ ...older, basename: path.basename(older.file) }, 'sent');
                move(item, 'sent');
              }
            } catch (error) {
              if (item.event.schema > 1 && [400, 422].includes(error.status ?? error.statusCode)) {
                move(item, 'dead');
                continue;
              }
              onError(error);
              // These private claims are superseded observations of one
              // upsert. Retain only the newest claim for the next pass.
              for (const older of heartbeatItems.slice(0, -1)) {
                try { fs.unlinkSync(older.file); }
                catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
              }
            }
          }
          for (const root of roots) {
            guard();
            try { await drainCut(root, ctx, sink, masks, sleep, guard, onError); } catch (error) { onError(error); }
            const pending = path.join(root, 'spool', 'pending'); const marker = path.join(pending, 'overflow-exceeded.json');
            if (fs.existsSync(marker)) {
              guard();
              try {
                const value = readJSON(marker);
                const alert = clean({ key: 'spool-overflow:' + (config.host || os.hostname().split('.')[0]), title: 'Spool overflow exceeded', body: 'Spool overflow since ' + value.since + ' ' + (config.owner.mention || '') });
                const result = await sink.upsertAlert(ctx, alert);
                const overflowBytes = entries(pending).filter(name => /^counters(?:\..+)?\.log$/.test(name)).reduce((sum, name) => sum + size(path.join(pending, name)), 0);
                if (result && !result.pending && !result.lookup_incomplete && (result.ref != null || result.skipped || result.winner !== undefined) && overflowBytes < config.spool.overflow_max_bytes / 2) fs.unlinkSync(marker);
              } catch (error) { onError(error); }
            }
            prune(root, 'sent', config.spool.sent_retention_days, config.spool.sent_max_bytes, clock);
            prune(root, 'dead', config.spool.dead_retention_days, config.spool.dead_max_bytes, clock);
          }
          if (config.sink.type !== 'webhook') {
            guard();
            try {
              const watchers = (await sink.listHeartbeats(ctx)).filter(record => record.role === 'watcher');
              if (!ctx.lookup_incomplete && watchers.length && watchers.every(record => Date.parse(ctx.now()) - Date.parse(record.lastSeen) > config.watch.watcher_gap_sec * 1000)) {
                await sink.upsertAlert(ctx, clean({ key: 'all-watchers-silent', title: 'All watchers are silent',
                  body: 'All watcher heartbeats are older than ' + config.watch.watcher_gap_sec + ' seconds. ' + (config.owner.mention || ''), mention: config.owner.mention }));
              }
            } catch (error) { onError(error); }
          }
        } else transport = true;
        // Deferred ticks keep the current failure's timestamp, including after
        // an early-woken linger sleep, so restart recovers the same delay.
        state.ts = new Date(until > clock() ? backoffStartedAt : clock()).toISOString(); state.pending_remaining = pendingCount(roots);
        state.lookup_incomplete = Boolean(ctx.lookup_incomplete);
        delete state.backoff_until;
        if (until > clock()) state.backoff_until = new Date(until).toISOString();
        atomic(path.join(home, 'state', 'last_flush.json'), state);
        const available = config.spool.flush_linger_sec * 1000 - (clock() - started);
        if (!flags.linger || !transport || !state.pending_remaining || stopped || until - clock() > available || available <= 0) break;
        await sleep(Math.max(0, until - clock()));
      }
    }
  } catch (error) {
    state.errors.push(clean(error.message || 'flush failed')); log(state.errors[state.errors.length - 1]);
    if (error.code === 'EAPI_BUDGET' || ctx.lookup_incomplete) state.lookup_incomplete = true;
    try { state.pending_remaining = pendingCount(roots); } catch (_) { state.pending_remaining = 1; }
    if (!flags['dry-run'] && lock && !stopped) {
      try { atomic(path.join(home, 'state', 'last_flush.json'), state); } catch (_) { /* report failure below */ }
    }
  } finally {
    if (lock) lock.release();
    process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
  }
  const failed = Boolean(state.pending_remaining || state.lookup_incomplete || state.errors.length || stopped);
  if (!flags.quiet) output(stdout, flags.json ? JSON.stringify(clean({ ...state, ...(writes ? { writes } : {}) })) + '\n'
    : 'flush: ' + state.pending_remaining + ' pending' + (state.lookup_incomplete ? ', lookup incomplete' : '') +
      (writes ? ', would write ' + JSON.stringify(clean(writes)) : '') + (state.errors.length ? ', ' + state.errors.length + ' errors' : '') +
      (writes && failed ? '. Dry-run leaves pending work unchanged (exit 1).' : '') + '\n');
  return failed ? 1 : 0;
}
function main(argv) {
  process.stdout.on('error', () => {}); process.stderr.on('error', () => {});
  return flush(argv).then(code => { process.exitCode = code; }, () => {
    if (!argv.includes('--quiet')) output(process.stderr, 'flush: unexpected failure\n'); process.exitCode = 1;
  });
}
module.exports = { flush, main };
