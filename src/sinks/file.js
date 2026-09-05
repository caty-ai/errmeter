'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { redact } = require('../redact');

function time(ctx) { return new Date(ctx.now ? ctx.now() : Date.now()).toISOString(); }
// This reference board grows without a retention bound; operators must trim it.
function location(ctx) { return (ctx.config.file || {}).path || path.join(ctx.home, 'board.jsonl'); }
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, value);
    try { fs.fsyncSync(fd); } catch (_) { /* Best effort on unsupported filesystems. */ }
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
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
    const limit = (ctx.config.file || {}).scan_max_lines || 50000;
    let position = fs.fstatSync(fd).size;
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
    if (row.op === 'failure' || row.op === 'occurrence') records.set(row.ref, row.record);
  }
  return records;
}
function summary(record) {
  const { latest, claims, outcomes, occurrenceIds, counterRefs, ...result } = record;
  return result;
}
async function deliverFailureGroup(ctx, group) {
  const rows = scan(ctx); complete(ctx, rows);
  const existing = Array.from(failures(rows).values()).find(record => record.fingerprint === group.fingerprint);
  const counter = typeof group.counter === 'string' ? group.counter : group.counter && (group.counter.ref || group.counter.counter_ref);
  const events = group.events || [];
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
    title: redact('[errmeter] ' + group.agent + ': ' + String(latest.message || '').slice(0, 80), ctx.maskList || []),
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
  return Array.from(failures(rows).values()).map(summary);
}
async function getFailure(ctx, ref) {
  const rows = scan(ctx); complete(ctx, rows);
  const record = failures(rows).get(Number(ref));
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
  if (!issue) issue = append(ctx, 'alert', { key: alert.key, title: redact(alert.title || '[errmeter] alert: ' + alert.key, ctx.maskList || []), body: alert.body, mention: alert.mention }, rows);
  const now = time(ctx);
  const watch = ctx.config.watch || {};
  const recent = rows.filter(row => row.op === 'alert-episode' && row.key === alert.key && Date.parse(row.ts) > Date.parse(now) - (watch.renotify_sec || 21600) * 1000).sort((a, b) => a.seq - b.seq);
  if (recent.length) {
    const winner = recent.find(row => !row.cover);
    const confirmed = winner && (winner.notified || rows.some(row => row.op === 'alert-notified' && row.episodeRef === winner.seq));
    if (winner && !confirmed && Date.parse(now) - Date.parse(winner.ts) >= (watch.notify_confirm_sec ?? 120) * 1000) {
      const covers = recent.filter(row => row.cover && Date.parse(row.ts) >= Date.parse(now) - (watch.notify_confirm_sec ?? 120) * 1000);
      if (covers.length === 0) {
        const cover = append(ctx, 'alert-episode', { ref: issue.seq, key: alert.key, host: ctx.config.host, cover: 1, notified: now, channel: 'none' }, rows);
        append(ctx, 'alert-notified', { ref: issue.seq, key: alert.key, episodeRef: winner.seq, notified: now, channel: 'none' }, rows);
        return { ref: issue.seq, winner: true, episodeRef: cover.seq };
      }
    }
    return { ref: issue.seq, winner: false, skipped: true };
  }
  const episode = append(ctx, 'alert-episode', { ref: issue.seq, key: alert.key, host: ctx.config.host, notified: now, channel: 'none' }, rows);
  return { ref: issue.seq, winner: true, episodeRef: episode.seq };
}
module.exports = { deliverHeartbeat, deliverFailureGroup, listOpenFailures, getFailure, listHeartbeats, upsertAlert };
