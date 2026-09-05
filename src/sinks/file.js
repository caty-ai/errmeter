'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { cleanValue, cleanEvent } = require('./clean');
const { deriveClaimState } = require('../claim');
// Board operations can include a 30-second notification request. Only steal a
// living-PID lock after a comfortably larger bound; dead owners recover at once.
const LOCK_STALE_MS = 120000;

function time(ctx) { return new Date(ctx.now ? ctx.now() : Date.now()).toISOString(); }
// This reference board grows without a retention bound; operators must trim it.
function location(ctx) { return (ctx.config.file || {}).path || path.join(ctx.home, 'board.jsonl'); }
function removeOwner(directory, owner) {
  try { fs.unlinkSync(path.join(directory, owner)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  // Never remove recursively: another candidate can replace the empty directory
  // before rmdir, and its unique owner file must remain untouched.
  try { fs.rmdirSync(directory); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
}
function recoverDeadOwner(directory, candidate = false) {
  let owners;
  try { owners = fs.readdirSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  // Candidates are published with their owner already present. An empty lock
  // is therefore a release/recovery interrupted after unlink, never acquisition.
  if (owners.length === 0) {
    if (candidate) {
      try { if (Date.now() - fs.statSync(directory).mtimeMs < LOCK_STALE_MS) return; }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
    }
    try { fs.rmdirSync(directory); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    return;
  }
  if (owners.length !== 1 || !/^[1-9][0-9]*\.[a-f0-9-]+$/.test(owners[0])) return;
  const pid = Number(owners[0].split('.')[0]);
  try {
    if (Date.now() - fs.statSync(directory).mtimeMs >= LOCK_STALE_MS) {
      removeOwner(directory, owners[0]); return;
    }
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') removeOwner(directory, owners[0]); }
}
function recoverCandidates(directory) {
  const parent = path.dirname(directory);
  const prefix = path.basename(directory) + '.candidate-';
  let names;
  try { names = fs.readdirSync(parent); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of names) if (name.startsWith(prefix)) recoverDeadOwner(path.join(parent, name), true);
}
async function boardOperation(ctx, operation, args) {
  // Dry-run must not create even a transient lock or sequence file.
  if (ctx.dryRun) return operation(ctx, ...args);
  const directory = location(ctx) + '.lock';
  const owner = process.pid + '.' + crypto.randomUUID();
  const candidate = directory + '.candidate-' + owner;
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  recoverCandidates(directory);
  fs.mkdirSync(candidate, { mode: 0o700 });
  let acquired = false;
  try {
    fs.writeFileSync(path.join(candidate, owner), JSON.stringify({ pid: process.pid,
      started_ms: Math.floor(Date.now() - process.uptime() * 1000), created_ms: Date.now() }) + '\n',
    { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; attempt < 200; attempt++) {
      try { fs.renameSync(candidate, directory); acquired = true; break; }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        recoverDeadOwner(directory);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    if (!acquired) { const error = new Error('File board is busy'); error.code = 'BOARD_BUSY'; throw error; }
    return await operation(ctx, ...args);
  } finally {
    removeOwner(acquired ? directory : candidate, owner);
  }
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, value);
    try { fs.fsyncSync(fd); } catch (_) { /* Best effort on unsupported filesystems. */ }
    fs.closeSync(fd); fd = undefined;
    try { fs.renameSync(tmp, file); } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      fs.renameSync(tmp, file);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

// Read from the tail so a large board does not require loading its whole history.
function scan(ctx) {
  let fd;
  try { fd = fs.openSync(location(ctx), 'r'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  try {
    const limit = (ctx.config.file || {}).scan_max_lines ?? 50000;
    let position = fs.fstatSync(fd).size;
    if (limit === 0) { const result = []; result.incomplete = position > 0; return result; }
    let tail = Buffer.alloc(0);
    let lines = 0;
    while (position > 0 && lines <= limit) {
      const length = Math.min(position, 8192);
      position -= length;
      const chunk = Buffer.alloc(length);
      fs.readSync(fd, chunk, 0, length, position);
      for (const byte of chunk) if (byte === 10) lines++;
      tail = Buffer.concat([chunk, tail]);
    }
    const raw = tail.toString('utf8').split('\n');
    if (raw[raw.length - 1] === '') raw.pop();
    const truncated = position > 0 || raw.length > limit;
    const result = raw.slice(-limit).filter(Boolean).map(line => JSON.parse(line));
    result.incomplete = truncated;
    return result;
  } finally { fs.closeSync(fd); }
}
function complete(ctx, rows) {
  // A truncated history cannot prove absence or deduplication. Every board
  // operation fails closed here before allocating a sequence or appending.
  if (rows.incomplete) {
    ctx.lookup_incomplete = true;
    const error = new Error('File board lookup incomplete: scan_max_lines exceeded');
    error.code = 'LOOKUP_INCOMPLETE';
    throw error;
  }
}
function nextSequence(ctx, rows) {
  const sequenceFile = path.join(ctx.home, 'board.seq');
  let previous = 0;
  try { previous = Number(fs.readFileSync(sequenceFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Number.isSafeInteger(previous) || previous < 0) throw new Error('Invalid board sequence');
  return Math.max(previous, ...rows.map(row => row.seq)) + 1;
}
function append(ctx, op, payload, rows) {
  const seq = nextSequence(ctx, rows);
  atomic(path.join(ctx.home, 'board.seq'), String(seq) + '\n');
  const row = { seq, op, ...payload, ts: time(ctx) };
  fs.mkdirSync(path.dirname(location(ctx)), { recursive: true });
  fs.appendFileSync(location(ctx), JSON.stringify(row) + '\n', { mode: 0o600 });
  rows.push(row);
  return row;
}
function failures(rows) {
  const records = new Map();
  for (const row of rows) {
    if (row.op === 'failure' || row.op === 'occurrence') records.set(row.ref, JSON.parse(JSON.stringify(row.record)));
    const record = records.get(row.ref);
    if (!record) continue;
    if (row.op === 'claim') record.labels = [...new Set(record.labels.concat('errmeter:claimed'))];
    if (row.op === 'release' || row.op === 'outcome') record.labels = record.labels.filter(label => label !== 'errmeter:claimed');
    if (row.op === 'outcome') {
      record.labels = record.labels.filter(label => !['errmeter:repaired', 'errmeter:dispatch-failed'].includes(label));
      const labels = [...record.labels, 'errmeter:dispatched', 'errmeter:' + row.status];
      if (row.escalate) labels.push('errmeter:needs-human');
      record.labels = [...new Set(labels)];
    }
  }
  return records;
}
function detail(ctx, rows, ref) {
  const record = failures(rows).get(Number(ref));
  if (!record) return null;
  const state = deriveClaimState({ issue: record, comments: rows.filter(row => row.ref === Number(ref)), now: time(ctx) });
  return { ...record, claim: state.claim, claims: state.claims, outcomes: state.outcomes,
    lastOutcome: state.lastOutcome, occurrenceAfterLastOutcome: state.occurrenceAfterLastOutcome };
}
function summary(record) {
  const { latest, claims, outcomes, occurrenceIds, counterRefs, ...result } = record;
  return result;
}
async function deliverFailureGroup(ctx, group) {
  const rows = scan(ctx); complete(ctx, rows);
  const existing = Array.from(failures(rows).values()).find(record => record.fingerprint === group.fingerprint);
  const counter = typeof group.counter === 'string' ? group.counter : group.counter && (group.counter.ref || group.counter.counter_ref);
  const events = (group.events || []).map(event => cleanEvent(event, ctx.maskList || []));
  const ids = new Set(existing ? existing.occurrenceIds : []);
  const fresh = events.filter(event => event.id && !ids.has(event.id));
  if ((counter && existing && existing.counterRefs.includes(counter)) || (!counter && fresh.length === 0)) {
    return { ref: existing && existing.ref, created: false, delivered: events.map(event => event.id).filter(Boolean), skipped: true };
  }
  const deliveredEvents = counter ? events : fresh;
  const latest = deliveredEvents[deliveredEvents.length - 1] || events[events.length - 1];
  if (!latest) throw new Error('Failure group requires an event');
  const first = deliveredEvents[0] || latest;
  const count = counter ? group.count : fresh.length === events.length ? group.count : fresh.length;
  const ref = existing ? existing.ref : nextSequence(ctx, rows);
  const record = existing ? JSON.parse(JSON.stringify(existing)) : {
    ref, fingerprint: group.fingerprint, fpv: group.fpv, agent: group.agent, host: first.host,
    title: cleanValue('[errmeter] ' + group.agent + ': ' + String(latest.message || '').slice(0, 80), ctx.maskList || []),
    labels: ['errmeter', 'errmeter:failure'], openedAt: first.ts, lastOccurrenceAt: first.ts,
    occurrences: 0, claim: null, lastOutcome: null, latest: first, claims: [], outcomes: [], occurrenceIds: [], counterRefs: []
  };
  record.occurrences += count;
  record.occurrenceIds = Array.from(new Set(record.occurrenceIds.concat(counter ? [] : fresh.map(event => event.id))));
  if (counter) record.counterRefs.push(counter);
  if (latest.ts >= record.lastOccurrenceAt) { record.latest = latest; record.lastOccurrenceAt = latest.ts; }
  if (ctx.dryRun) return { ref: existing ? ref : null, created: !existing, delivered: [], count, pending: true };
  append(ctx, existing ? 'occurrence' : 'failure', { ref, fingerprint: group.fingerprint, ids: counter ? [] : fresh.map(event => event.id), count, ...(counter ? { counter_ref: counter } : {}), record }, rows);
  return { ref, created: !existing, delivered: events.map(event => event.id).filter(Boolean) };
}
async function listOpenFailures(ctx) {
  const rows = scan(ctx); complete(ctx, rows);
  return Array.from(failures(rows).keys()).map(ref => summary(detail(ctx, rows, ref)));
}
async function getFailure(ctx, ref) {
  const rows = scan(ctx); complete(ctx, rows);
  const record = detail(ctx, rows, ref);
  if (!record) return null;
  const { counterRefs, ...result } = record;
  return result;
}
function heartbeats(rows) {
  const records = new Map();
  for (const row of rows) if (row.op === 'heartbeat') records.set(row.record.agent + '@' + row.record.host, row.record);
  return records;
}
async function listHeartbeats(ctx) {
  const rows = scan(ctx); complete(ctx, rows);
  return Array.from(heartbeats(rows).values());
}
async function deliverHeartbeat(ctx, event) {
  event = cleanEvent(event, ctx.maskList || []);
  const rows = scan(ctx); complete(ctx, rows);
  const existing = heartbeats(rows).get(event.agent + '@' + event.host);
  const prior = event.id && rows.find(row => row.op === 'heartbeat' && row.id === event.id);
  if (prior) return { ref: prior.ref, skipped: true };
  if (existing && existing.lastSeen >= event.ts) return { ref: existing.ref, skipped: true };
  const ref = existing ? existing.ref : nextSequence(ctx, rows);
  const record = { ref, agent: event.agent, host: event.host, role: event.meta && event.meta.role || null, lastSeen: event.ts, message: event.message || '' };
  if (ctx.dryRun) return { ref: existing ? ref : null, pending: true };
  append(ctx, 'heartbeat', { ref, id: event.id, record }, rows);
  return { ref };
}
async function upsertAlert(ctx, alert) {
  const rows = scan(ctx); complete(ctx, rows);
  let issue = rows.find(row => row.op === 'alert' && row.key === alert.key);
  if (ctx.dryRun) return { ref: issue ? issue.seq : null, winner: false, pending: true };
  if (!issue) issue = append(ctx, 'alert', { key: alert.key, title: cleanValue(alert.title || '[errmeter] alert: ' + alert.key, ctx.maskList || []), body: cleanValue(alert.body, ctx.maskList || []), mention: alert.mention }, rows);
  const now = time(ctx);
  const watch = ctx.config.watch || {};
  const recent = rows.filter(row => row.op === 'alert-episode' && row.key === alert.key && Date.parse(row.ts) > Date.parse(now) - (watch.renotify_sec ?? 21600) * 1000).sort((a, b) => a.seq - b.seq);
  if (recent.length) {
    const winner = recent.find(row => !row.cover);
    const confirmed = winner && (winner.notified || rows.some(row => row.op === 'alert-notified' && row.episodeRef === winner.seq));
    if (winner && !confirmed && Date.parse(now) - Date.parse(winner.ts) >= (watch.notify_confirm_sec ?? 120) * 1000) {
      const covers = recent.filter(row => row.cover && Date.parse(row.ts) >= Date.parse(now) - (watch.notify_confirm_sec ?? 120) * 1000);
      if (covers.length === 0) {
        const cover = append(ctx, 'alert-episode', { ref: issue.seq, key: alert.key, host: ctx.config.host, cover: 1 }, rows);
        return notifyEpisode(ctx, alert, issue, cover, winner, rows);
      }
    }
    return { ref: issue.seq, winner: false, skipped: true };
  }
  const episode = append(ctx, 'alert-episode', { ref: issue.seq, key: alert.key, host: ctx.config.host }, rows);
  return notifyEpisode(ctx, alert, issue, episode, episode, rows);
}
async function notifyEpisode(ctx, alert, issue, episode, winner, rows) {
  let channel = 'none';
  if (ctx.notify) {
    try {
      const result = await ctx.notify(alert);
      if (!Array.isArray(result?.sent) || result.sent.length === 0) return { ref: issue.seq, winner: true, episodeRef: episode.seq, notified: false };
      channel = result.sent.join(',');
    } catch (_) { return { ref: issue.seq, winner: true, episodeRef: episode.seq, notified: false }; }
  }
  // Notification may await I/O; refresh to avoid allocating from stale history.
  rows = scan(ctx); complete(ctx, rows);
  append(ctx, 'alert-notified', { ref: issue.seq, key: alert.key, episodeRef: winner.seq,
    notifierRef: episode.seq, notified: time(ctx), channel }, rows);
  return { ref: issue.seq, winner: true, episodeRef: episode.seq, notified: true };
}

function requireFailure(ctx, rows, ref) {
  const record = detail(ctx, rows, ref);
  if (!record) { const error = new Error('Failure not found: ' + ref); error.code = 'NOT_FOUND'; throw error; }
  return record;
}
function claimOptions(options) {
  if (!/^[a-z0-9._/-]{1,64}$/.test(options.watcherId || '')) throw new Error('Invalid watcherId');
  if (options.ttlSec !== undefined && (!Number.isFinite(options.ttlSec) || options.ttlSec <= 0)) throw new Error('Invalid claim TTL');
}
async function claim(ctx, ref, options) {
  claimOptions(options);
  const rows = scan(ctx); complete(ctx, rows);
  const record = requireFailure(ctx, rows, ref);
  const state = deriveClaimState({ issue: record, comments: rows.filter(row => row.ref === Number(ref)), now: time(ctx) });
  if (!state.eligible || ctx.dryRun) return { won: false, ...(ctx.dryRun ? { pending: true } : {}) };
  const expiresAt = new Date(Date.parse(time(ctx)) + (options.ttlSec ?? 900) * 1000).toISOString();
  const mine = append(ctx, 'claim', { ref: Number(ref), watcherId: options.watcherId, claimRef: 'new', expiresAt }, rows);
  const after = scan(ctx); complete(ctx, after);
  const elected = detail(ctx, after, ref).claim;
  if (elected?.commentId !== mine.seq) {
    append(ctx, 'release', { ref: Number(ref), watcherId: options.watcherId, claimRef: mine.seq }, after);
    return { won: false };
  }
  return { won: true, claimRef: mine.seq, expiresAt };
}
async function renewClaim(ctx, ref, options) {
  claimOptions(options);
  const rows = scan(ctx); complete(ctx, rows);
  const record = requireFailure(ctx, rows, ref);
  if (ctx.dryRun || record.claim?.watcherId !== options.watcherId || String(record.claim.claimRef) !== String(options.claimRef)) return { ok: false };
  const expiresAt = new Date(Date.parse(time(ctx)) + (options.ttlSec ?? 900) * 1000).toISOString();
  append(ctx, 'claim', { ref: Number(ref), watcherId: options.watcherId, claimRef: options.claimRef, expiresAt }, rows);
  return { ok: true, expiresAt };
}
async function releaseClaim(ctx, ref, options) {
  claimOptions(options);
  const rows = scan(ctx); complete(ctx, rows); requireFailure(ctx, rows, ref);
  if (ctx.dryRun) return { pending: true };
  const already = rows.find(row => row.op === 'release' && row.ref === Number(ref) && row.watcherId === options.watcherId && String(row.claimRef) === String(options.claimRef));
  if (already) return { skipped: true };
  append(ctx, 'release', { ref: Number(ref), watcherId: options.watcherId, claimRef: options.claimRef }, rows);
  return { ok: true };
}
async function writeOutcome(ctx, ref, outcome) {
  claimOptions(outcome);
  if (!['repaired', 'dispatch-failed', 'needs-human'].includes(outcome.status)) throw new Error('Invalid outcome status');
  const rows = scan(ctx); complete(ctx, rows); requireFailure(ctx, rows, ref);
  if (ctx.dryRun) return { pending: true };
  const already = outcome.claimRef != null && rows.find(row => row.op === 'outcome' && row.ref === Number(ref) &&
    row.watcherId === outcome.watcherId && String(row.claimRef) === String(outcome.claimRef));
  if (already) return { skipped: true };
  const excerpt = outcome.excerpt ?? outcome.stderr;
  append(ctx, 'outcome', { ref: Number(ref), watcherId: outcome.watcherId, status: outcome.status,
    summary: cleanValue(String(outcome.summary || ''), ctx.maskList || []).slice(0, 500),
    ...(outcome.url ? { url: cleanValue(outcome.url, ctx.maskList || []) } : {}),
    ...(excerpt ? { excerpt: cleanValue(String(excerpt).split(/\r?\n/).slice(-20).join('\n'), ctx.maskList || []) } : {}),
    ...(outcome.claimRef != null ? { claimRef: outcome.claimRef } : {}), ...(outcome.escalate ? { escalate: true } : {}) }, rows);
  return { ok: true };
}
const operations = { deliverHeartbeat, deliverFailureGroup, listOpenFailures, getFailure, listHeartbeats, upsertAlert,
  claim, renewClaim, releaseClaim, writeOutcome };
module.exports = Object.fromEntries(Object.entries(operations).map(([name, operation]) =>
  [name, (ctx, ...args) => boardOperation(ctx, operation, args)]));
