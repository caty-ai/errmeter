'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { pathToFileURL } = require('node:url');
const { cleanValue, cleanEvent } = require('./sinks/clean');
const { consecutiveFailureCount } = require('./claim');

const DEFAULT_PASS_ENV = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'TEMP', 'SYSTEMROOT', 'USERPROFILE'];
const MAX_LINE = 65536;
// Wait one extra second so the runner owns the kill of its hook.
const DISPATCH_KILL_DELAY_MS = 11000;
const PROCESS_STARTED_MS = Math.floor(Date.now() - process.uptime() * 1000);
const LOCK_STALE_MS = 10000;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds) { Atomics.wait(LOCK_WAIT, 0, 0, milliseconds); }

function recoverStateLock(lock, staleMs = LOCK_STALE_MS) {
  let stat;
  try { stat = fs.statSync(lock); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  if (Date.now() - stat.mtimeMs >= staleMs) {
    try { fs.unlinkSync(lock); return true; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }
  let owner;
  try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch (_) { return false; }
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 1) return false;
  if (owner.pid === process.pid && owner.started_ms !== PROCESS_STARTED_MS) {
    try { fs.unlinkSync(lock); return true; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }
  try { process.kill(owner.pid, 0); }
  catch (error) {
    if (error.code !== 'ESRCH') return false;
    try { fs.unlinkSync(lock); return true; } catch (unlinkError) { if (unlinkError.code === 'ENOENT') return true; throw unlinkError; }
  }
  return false;
}

function withStateLock(file, operation, options = {}) {
  const lock = file + '.lock';
  const attempts = options.lockAttempts ?? 21;
  let lockFd;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      lockFd = fs.openSync(lock, 'wx', 0o600);
      try {
        fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, started_ms: PROCESS_STARTED_MS,
          created_ms: Date.now(), nonce: crypto.randomUUID() }) + '\n');
        try { fs.fsyncSync(lockFd); } catch (_) { /* Best effort. */ }
      } catch (error) {
        try { fs.closeSync(lockFd); } catch (_) {} lockFd = undefined;
        try { fs.unlinkSync(lock); } catch (_) {}
        throw error;
      }
      break;
    } catch (error) {
      if (lockFd !== undefined) { try { fs.closeSync(lockFd); } catch (_) {} lockFd = undefined; }
      if (error.code !== 'EEXIST' || !recoverStateLock(lock, options.lockStaleMs)) {
        if (error.code !== 'EEXIST' || attempt === attempts - 1) throw error;
        sleepSync(options.lockWaitMs ?? 5);
      }
    }
  }
  if (lockFd === undefined) { const error = new Error('Dispatch state is busy'); error.code = 'STATE_BUSY'; throw error; }
  try { return operation(); }
  finally {
    try { fs.closeSync(lockFd); } finally {
      try { fs.unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

function atomicState(file, update, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withStateLock(file, () => {
    // The runner uses the same lock for PID insertion. Hold it across the read
    // and replacement so neither writer can overwrite the other's fields.
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    let fd;
    try {
      let value = update;
      if (typeof update === 'function') {
        let current;
        try { current = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT' || !options.create) throw error; current = {}; }
        if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Invalid dispatch state');
        value = update(current);
      }
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(value) + '\n');
      try { fs.fsyncSync(fd); } catch (_) { /* Best effort. */ }
      fs.closeSync(fd); fd = undefined;
      try { fs.renameSync(tmp, file); }
      catch (error) {
        if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        // Windows may refuse to replace an existing destination. The runner
        // keeps its current fence during this brief missing-file interval.
        try { fs.unlinkSync(file); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
        fs.renameSync(tmp, file);
      }
      return value;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  });
}

function failureCount(issue) {
  return consecutiveFailureCount(issue.outcomes || (issue.lastOutcome ? [issue.lastOutcome] : []));
}

function buildPayload(ctx, issue, claim) {
  const url = issue.url || (ctx.config.sink?.type === 'file' ?
    pathToFileURL(path.resolve(ctx.config.file?.path || path.join(ctx.home, 'board.jsonl'))).href + '#' + issue.ref :
    ctx.config.sink?.repo ? 'https://github.com/' + ctx.config.sink.repo + '/issues/' + issue.ref : '');
  return cleanValue({
    schema: 1,
    issue: { ref: issue.ref, url, title: issue.title || '', occurrences: issue.occurrences,
      first_ts: issue.firstOccurrenceAt || issue.first_ts || issue.openedAt, last_ts: issue.lastOccurrenceAt },
    latest: cleanEvent(issue.latest, ctx.maskList || []),
    attempt: failureCount(issue) + 1,
    watcher_id: ctx.config.watch.watcher_id,
    claim_expires: claim.expiresAt
  }, ctx.maskList || []);
}

function buildEnvironment(env, passEnv, payload, stateFile) {
  const result = {};
  for (const key of passEnv || DEFAULT_PASS_ENV) {
    // Even an explicit pass_env entry cannot widen the ERRMETER boundary.
    if (!key.startsWith('ERRMETER_') && Object.hasOwn(env, key) && env[key] !== undefined) result[key] = env[key];
  }
  Object.assign(result, {
    ERRMETER_ISSUE_NUMBER: String(payload.issue.ref), ERRMETER_ISSUE_URL: payload.issue.url,
    ERRMETER_AGENT: payload.latest?.agent || '', ERRMETER_HOST: payload.latest?.host || '',
    ERRMETER_FINGERPRINT: payload.latest?.fingerprint || '', ERRMETER_EVENT_FILE: stateFile,
    ERRMETER_WATCHER_ID: payload.watcher_id, ERRMETER_CLAIM_EXPIRES: payload.claim_expires
  });
  return result;
}

// Retain complete bounded lines, never a raw suffix of an oversized secret.
// PEM state spans discarded lines so a long key cannot leak its ending.
function outputCapture(masks) {
  const decoder = new StringDecoder('utf8');
  let partial = '', oversized = false, pem = false, last = '';
  const lines = [];
  function line(raw) {
    const begin = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw);
    const end = /-----END [A-Z ]*PRIVATE KEY-----/.test(raw);
    let value = oversized ? '[errmeter: oversized output line omitted]' : raw.replace(/\r$/, '');
    if (pem || begin) value = '[REDACTED PEM]';
    pem = (pem || begin) && !end;
    value = cleanValue(value, masks);
    lines.push(value);
    if (lines.length > 20) lines.shift();
    if (value.trim()) last = value.trim().slice(0, 500);
    oversized = false;
  }
  function text(chunk) {
    for (const piece of chunk.split(/(?<=\n)/)) {
      const ended = piece.endsWith('\n');
      if (!oversized) {
        partial += ended ? piece.slice(0, -1) : piece;
        if (partial.length > MAX_LINE) { partial = partial.slice(0, MAX_LINE); oversized = true; }
      }
      if (ended) { line(partial); partial = ''; }
    }
  }
  return {
    write(chunk) { text(typeof chunk === 'string' ? chunk : decoder.write(chunk)); },
    finish() { text(decoder.end()); if (partial || oversized) line(partial); partial = ''; },
    summary() { return last; },
    excerpt() { return cleanValue(lines.join('\n'), masks); }
  };
}

function milliseconds(value) { return typeof value === 'number' ? value : Date.parse(value); }

function signalPids(pids, signal, options = {}) {
  const kill = options.kill || process.kill;
  const spawn = options.spawn || childProcess.spawn;
  for (const pid of new Set(pids)) {
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    if ((options.platform || process.platform) === 'win32') {
      try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch (_) { /* Best effort. */ }
    } else {
      try { kill(-pid, signal); }
      catch (_) { try { kill(pid, signal); } catch (_) { /* Already gone or inaccessible. */ } }
    }
  }
}

function processAlive(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  const kill = options.kill || process.kill;
  try { kill(pid, 0); } catch (error) { return error.code !== 'ESRCH'; }
  if ((options.platform || process.platform) !== 'win32' && !options.kill) {
    try {
      const status = childProcess.execFileSync('ps', ['-o', 'stat=', '-p', String(pid)],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (status.startsWith('Z')) return false;
    } catch (_) { return true; }
  }
  return true;
}

async function waitForExit(pids, options, milliseconds) {
  const deadline = Date.now() + milliseconds;
  let live = pids.filter(pid => processAlive(pid, options));
  while (live.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(1, deadline - Date.now()))));
    live = live.filter(pid => processAlive(pid, options));
  }
  return live;
}

async function cleanupDispatches(home, options = {}) {
  const directory = path.join(home, 'state', 'dispatch');
  let names;
  try { names = fs.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of names.filter(name => name.endsWith('.json'))) {
    const file = path.join(directory, name);
    let pids = [];
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      pids = [...new Set([state.pid, state.runner_pid, state.hook_pid]
        .filter(pid => Number.isSafeInteger(pid) && pid > 1))];
    } catch (_) { /* A malformed state cannot provide a trustworthy PID. */ }
    signalPids(pids, 'SIGTERM', options);
    let live = await waitForExit(pids, options, options.cleanupGraceMs ?? 1000);
    if (live.length && (options.platform || process.platform) !== 'win32') {
      signalPids(live, 'SIGKILL', options);
      live = await waitForExit(live, options, options.cleanupKillMs ?? 2000);
    }
    if (live.length) {
      const error = new Error('Could not stop prior dispatch'); error.code = 'DISPATCH_STILL_RUNNING'; throw error;
    }
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { fs.unlinkSync(file + '.lock'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const name of names.filter(name => name.endsWith('.json.lock'))) {
    const lock = path.join(directory, name);
    try { fs.unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function dispatch(ctx, issue, claim, options = {}) {
  const sink = options.sink || ctx.sink;
  const watch = ctx.config.watch;
  const settings = watch.dispatch;
  const watcherId = watch.watcher_id;
  const wallNow = options.now || Date.now;
  const schedule = options.setTimeout || setTimeout;
  const unschedule = options.clearTimeout || clearTimeout;
  const platform = options.platform || process.platform;
  const spawn = options.spawn || childProcess.spawn;
  const ttlSec = watch.claim_ttl_sec ?? 900;
  const renewSec = watch.renew_sec ?? 180;
  const graceSec = watch.kill_grace_sec ?? 30;
  if (options.signal?.aborted) return { detached: true };
  if (!claim.won) throw new Error('Dispatch requires a confirmed winning claim');
  if (!/^[1-9][0-9]*$/.test(String(issue.ref))) throw new Error('Invalid dispatch issue reference');
  const stateFile = path.join(ctx.home, 'state', 'dispatch', String(issue.ref) + '.json');
  const payload = buildPayload(ctx, issue, claim);
  const boardNow = () => milliseconds(ctx.boardTime ?? (ctx.now ? ctx.now() : wallNow()));
  let remaining = milliseconds(claim.expiresAt) - boardNow() - graceSec * 1000;
  if (!Number.isFinite(remaining)) throw new Error('Dispatch requires a valid claim deadline');
  let state = { ...payload, deadline_ms: wallNow() + remaining, deadline_generation: 0, claim_ref: claim.claimRef };
  atomicState(stateFile, state);
  const stdout = outputCapture(ctx.maskList || []), stderr = outputCapture(ctx.maskList || []);
  let child, renewTimer, confirmationTimer, killTimer, detach, stopped = false, failure = '';
  function signalTree(signal) {
    if (!child?.pid) return;
    let current = state;
    try { current = JSON.parse(fs.readFileSync(stateFile, 'utf8')); state = current; } catch (_) { /* Retain known PIDs. */ }
    signalPids([child.pid, current.pid, current.runner_pid, current.hook_pid], signal, { ...options, spawn, platform });
  }
  function fence(reason) {
    if (stopped || failure) return;
    failure = reason;
    unschedule(renewTimer); unschedule(confirmationTimer);
    signalTree('SIGTERM');
    if (platform !== 'win32') {
      // The runner first force-kills its hook at 10 seconds; leave it time to
      // finish that job before force-killing the runner itself.
      killTimer = schedule(() => signalTree('SIGKILL'), DISPATCH_KILL_DELAY_MS);
      killTimer.unref?.();
    }
  }
  function arm() {
    unschedule(renewTimer); unschedule(confirmationTimer);
    const confirmIn = state.deadline_ms - wallNow() + (graceSec - renewSec) * 1000;
    confirmationTimer = schedule(() => fence('claim renewal unconfirmed'), Math.max(0, confirmIn));
    renewTimer = schedule(async () => {
      try {
        const result = await sink.renewClaim(ctx, issue.ref, { watcherId, claimRef: claim.claimRef, ttlSec });
        if (stopped || failure) return;
        const status = result?.statusCode ?? result?.status;
        if (result?.ok !== true || (status !== undefined && !(status >= 200 && status < 300))) {
          fence('claim renewal failed'); return;
        }
        remaining = milliseconds(result.expiresAt) - boardNow() - graceSec * 1000;
        if (!Number.isFinite(remaining) || remaining <= 0) { fence('claim renewal invalid'); return; }
        // Read the runner's latest PIDs while holding the shared update lock.
        state = atomicState(stateFile, current => ({ ...current,
          deadline_ms: wallNow() + remaining, deadline_generation: (current.deadline_generation ?? 0) + 1,
          claim_expires: result.expiresAt }));
        arm();
      } catch (_) { fence('claim renewal failed'); }
    }, renewSec * 1000);
  }
  let completion;
  if (remaining <= 0) completion = { code: 124, signal: null };
  else {
    completion = await new Promise(resolve => {
      detach = () => {
        stopped = true;
        unschedule(renewTimer); unschedule(confirmationTimer);
        child?.unref();
        child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
        resolve({ detached: true });
      };
      try {
        child = spawn(process.execPath, [path.resolve(__dirname, '../bin/errmeter.js'), '_run',
          '--deadline-ms', String(state.deadline_ms), '--deadline-mono-ms', String(remaining),
          '--timeout', String(settings.timeout_sec ?? 840), '--state', stateFile, '--', ...settings.command],
        { detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
          cwd: settings.cwd, env: buildEnvironment(options.env || ctx.env || process.env, settings.pass_env, payload, stateFile) });
        child.stdout.on('data', chunk => stdout.write(chunk));
        child.stderr.on('data', chunk => stderr.write(chunk));
        child.stdin.on('error', () => { fence('runner stdin failed'); });
        child.on('error', () => { failure = 'runner spawn failed'; resolve({ code: 125, signal: null }); });
        child.on('close', (code, signal) => resolve({ code, signal }));
        child.stdin.end(JSON.stringify(payload) + '\n');
        arm();
        options.signal?.addEventListener('abort', detach, { once: true });
        if (options.signal?.aborted) detach();
      } catch (_) {
        if (child?.pid) fence('runner setup failed');
        failure = failure || 'runner spawn failed';
        resolve({ code: 125, signal: null });
      }
    });
  }
  stopped = true;
  unschedule(renewTimer); unschedule(confirmationTimer); unschedule(killTimer);
  if (detach) options.signal?.removeEventListener('abort', detach);
  if (completion.detached) return completion;
  stdout.finish(); stderr.finish();
  const status = completion.code === 0 && !completion.signal && !failure ? 'repaired' : 'dispatch-failed';
  const summary = stdout.summary() || failure || (status === 'repaired' ? 'Repair proposed' : 'Dispatch failed');
  let url;
  try { const parsed = new URL(summary); if (['http:', 'https:'].includes(parsed.protocol) && !/\s/.test(summary)) url = summary; } catch (_) { /* Summaries need not be URLs. */ }
  let consecutiveFailures = status === 'dispatch-failed' ? failureCount(issue) + 1 : 0;
  let needsHuman = consecutiveFailures >= (watch.escalate_after ?? 2);
  const outcome = { status, summary, ...(url ? { url } : {}), excerpt: stderr.excerpt(), watcherId, claimRef: claim.claimRef,
    ...(needsHuman ? { escalate: true } : {}) };
  // Preserve recovery state until the outcome is durable. An outcome itself
  // ends this watcher's claim, so release failure must not hide escalation.
  await sink.writeOutcome(ctx, issue.ref, outcome);
  if (status === 'dispatch-failed' && typeof sink.getFailure === 'function') {
    try {
      const refreshed = await sink.getFailure(ctx, issue.ref);
      if (refreshed && !ctx.lookup_incomplete) consecutiveFailures = Math.max(consecutiveFailures, failureCount(refreshed));
    } catch (_) { ctx.log?.('dispatch: failure refresh failed after outcome'); }
    needsHuman = consecutiveFailures >= (watch.escalate_after ?? 2);
  }
  let releaseFailed = false;
  try { await sink.releaseClaim(ctx, issue.ref, { watcherId, claimRef: claim.claimRef }); }
  catch (_) { releaseFailed = true; ctx.log?.('dispatch: claim release failed after outcome'); }
  try { fs.unlinkSync(stateFile); } catch (error) { if (error.code !== 'ENOENT') ctx.log?.('dispatch: could not remove completed state'); }
  return { ...outcome, exitCode: completion.code, signal: completion.signal,
    consecutiveFailures, needsHuman, ...(releaseFailed ? { releaseFailed: true } : {}) };
}

module.exports = { dispatch, cleanupDispatches, atomicState, recoverStateLock,
  buildPayload, buildEnvironment, outputCapture, failureCount };
