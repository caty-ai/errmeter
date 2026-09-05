'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseWatch, USAGE } = require('./cli');
const { resolveConfig } = require('./config');
const { buildMaskList } = require('./redact');
const { cleanValue } = require('./sinks/clean');
const { isEligible, consecutiveFailureCount } = require('./claim');
const version = require('../package.json').version;

function output(target, text) {
  try { if (typeof target === 'function') target(text); else target.write(text); } catch (_) { /* closed output */ }
}
function commandFlags(ctx) { return ['--home', ctx.home, '--config', ctx.configPath]; }
function reportError(ctx, error, errors = ctx.errors) {
  const message = cleanValue(String(error.message || error.code || 'watch operation failed'), ctx.maskList);
  errors.push(message);
  ctx.log(message);
  try {
    ctx.emit([...commandFlags(ctx), '--agent', 'watcher/' + ctx.config.watch.watcher_id,
      '--kind', 'error', '--message=' + message, '--no-flush', '--quiet'], ctx.env,
    { stderr: ctx.log, stdout: () => {} });
  } catch (_) { /* Reporting a loop error must not recurse. */ }
}
async function upsertNeedsHuman(ctx, issue, summary, failures = ctx.config.watch.escalate_after) {
  const url = issue.url || (ctx.config.sink?.repo ? 'https://github.com/' + ctx.config.sink.repo + '/issues/' + issue.ref : 'issue ' + issue.ref);
  const alert = await ctx.sink.upsertAlert(ctx, cleanValue({ key: 'needs-human:' + issue.ref,
    title: 'Needs human: ' + url,
    body: url + ' needs human attention after ' + failures + ' failed repair attempts. ' + (ctx.config.owner.mention || ''),
    mention: ctx.config.owner.mention }, ctx.maskList));
  if (alert?.pending || alert?.notified === false) summary.pending_remaining++;
  if (alert?.lookup_incomplete) { summary.lookup_incomplete = true; ctx.lookup_incomplete = true; }
}
function apiRemaining(ctx) {
  return (ctx.config.max_api_calls_per_pass ?? ctx.config.sink?.max_api_calls_per_pass ?? 60) - (ctx.apiCalls || 0);
}
function scanCursor(ctx, value) {
  const file = path.join(ctx.home, 'state', 'scan_cursor.json');
  if (value === undefined) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).ref; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; return null; }
  }
  if (value === null) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ref: value }) + '\n', { mode: 0o600, flag: 'wx' });
    try { fs.renameSync(tmp, file); }
    catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      try { fs.unlinkSync(file); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
      fs.renameSync(tmp, file);
    }
  } finally { try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
async function escalate(ctx, issue, summary, escalation, failures, addLabel = false) {
  if (escalation.used || ctx.signal.aborted || ctx.lookup_incomplete) {
    summary.pending_remaining++;
    return;
  }
  escalation.used = true;
  try {
    if (addLabel) {
      try { await ctx.sink.addLabels(ctx, issue.ref, ['errmeter:needs-human']); }
      catch (error) {
        if (['EAPI_BUDGET', 'ELOOKUP_INCOMPLETE', 'LOOKUP_INCOMPLETE'].includes(error.code)) { ctx.lookup_incomplete = true; summary.pending_remaining++; return; }
        ctx.log?.('watch: escalation label update failed'); summary.pending_remaining++;
      }
    }
    await upsertNeedsHuman(ctx, issue, summary, failures);
  } catch (error) {
    summary.pending_remaining++;
    if (['EAPI_BUDGET', 'ELOOKUP_INCOMPLETE', 'LOOKUP_INCOMPLETE'].includes(error.code)) ctx.lookup_incomplete = true;
    else reportError(ctx, error, summary.errors);
  }
}
async function reconcileNeedsHuman(ctx, failures, summary) {
  const records = failures.filter(record => (record.labels || [])
    .some(label => (typeof label === 'string' ? label : label.name) === 'errmeter:needs-human'));
  if (!records.length || ctx.signal.aborted || ctx.lookup_incomplete) return;
  // One durable retry per tick keeps this repair path fair without allowing a
  // large historical alert set to consume the claim or heartbeat-gap budget.
  const index = (ctx.needsHumanCursor || 0) % records.length;
  ctx.needsHumanCursor = index + 1;
  await escalate(ctx, records[index], summary, { used: false });
}
async function tick(ctx, options = {}) {
  ctx.running ||= new Map();
  ctx.apiCalls = 0;
  ctx.lookup_incomplete = false;
  ctx.errors = [];
  delete ctx.boardTime;
  const summary = { ts: new Date(ctx.clock()).toISOString(), role: ctx.config.watch.role,
    flush: 0, eligible: 0, claimed: 0, pending_remaining: 0, dispatched: 0, gaps: 0,
    scanned: 0, unscanned: 0, lookup_incomplete: false, errors: ctx.errors };
  const escalation = { used: false };
  let scanWindow, scanPredecessor;
  const confirmedRefs = new Set(), pendingClaims = new Set();
  const sink = ctx.sink;
  try {
    // Publish the current observation before dead-man evaluation in flush.
    const emitted = ctx.emit([...commandFlags(ctx), '--agent', 'watcher/' + ctx.config.watch.watcher_id,
      '--kind', 'heartbeat', '--meta', 'role=' + ctx.config.watch.role, '--no-flush', '--quiet'], ctx.env,
    { stdout: () => {}, stderr: ctx.log });
    if (emitted !== 0) throw new Error('Watcher heartbeat emit failed');
    let flushed;
    const code = await ctx.flush([...commandFlags(ctx), '--quiet'], ctx.env, {
      sink, http: ctx.http, notify: ctx.notify, clock: ctx.clock, tmpdir: ctx.tmpdir,
      onResult: result => { flushed = result; }, stdout: () => {}, stderr: ctx.log
    });
    summary.flush = code;
    summary.pending_remaining = flushed?.pending_remaining ?? (code ? 1 : 0);
    summary.lookup_incomplete = Boolean(flushed?.lookup_incomplete);
    if (flushed?.errors?.length) for (const message of flushed.errors) reportError(ctx, new Error(message));
    if (code === 3) throw new Error('Watcher flush configuration failed');
    if (ctx.signal.aborted || ctx.config.watch.role === 'agent-host') return summary;
    if (flushed?.backoff_until && Date.parse(flushed.backoff_until) > ctx.clock()) return summary;
    const failures = await sink.listOpenFailures(ctx);
    if (ctx.lookup_incomplete) return summary;
    let candidates = failures.filter(record => !ctx.running.has(record.ref) && !(record.labels || []).some(label =>
      (typeof label === 'string' ? label : label.name) === 'errmeter:needs-human'))
      .sort((a, b) => /^\d+$/.test(String(a.ref)) && /^\d+$/.test(String(b.ref)) ? Number(a.ref) - Number(b.ref) : String(a.ref).localeCompare(String(b.ref)));
    const cursor = scanCursor(ctx);
    const cursorIndex = candidates.findIndex(record => String(record.ref) === String(cursor));
    if (cursorIndex >= 0) candidates = candidates.slice(cursorIndex + 1).concat(candidates.slice(0, cursorIndex + 1));
    else if (cursor != null) scanCursor(ctx, null);
    summary.unscanned = candidates.length;
    const scanMaxConfirms = Math.max(0, Math.floor(((ctx.config.max_api_calls_per_pass ?? ctx.config.sink?.max_api_calls_per_pass ?? 60) - 10) / 2));
    scanPredecessor = candidates.at(-1)?.ref;
    scanWindow = candidates.slice(0, scanMaxConfirms);
    candidates = scanWindow;
    // Prioritize inside this round-robin window, never ahead of its boundary.
    const claimed = record => (record.labels || []).some(label => (typeof label === 'string' ? label : label.name) === 'errmeter:claimed');
    candidates = candidates.filter(record => !claimed(record)).concat(candidates.filter(claimed));
    const dispatches = [];
    const selected = [];
    const capacity = Math.max(0, ctx.config.watch.max_concurrent - ctx.running.size);
    for (const record of candidates) {
      if (selected.length >= capacity || summary.scanned >= scanMaxConfirms || apiRemaining(ctx) < 2 || ctx.signal.aborted || ctx.lookup_incomplete) break;
      if (ctx.running.has(record.ref)) continue;
      const detail = record.detailed === true ? record : await sink.getFailure(ctx, record.ref);
      if (ctx.lookup_incomplete) break;
      summary.scanned++;
      summary.unscanned--;
      confirmedRefs.add(record.ref);
      if (!detail) continue;
      const failures = detail.consecutiveFailures ?? consecutiveFailureCount(detail);
      if (failures >= ctx.config.watch.escalate_after) {
        await escalate(ctx, detail, summary, escalation, failures, true);
        if (ctx.lookup_incomplete) break;
        continue;
      }
      if (isEligible(detail, ctx.now(), true)) { selected.push(detail); pendingClaims.add(detail.ref); }
    }
    summary.eligible = selected.length;
    for (const record of selected) {
      if (ctx.signal.aborted || ctx.lookup_incomplete) break;
      if (ctx.running.size >= ctx.config.watch.max_concurrent) break;
      if (ctx.running.has(record.ref)) continue;
      const detail = record.detailed === true && !record.latest ? await sink.getFailure(ctx, record.ref) : record;
      if (ctx.lookup_incomplete || !detail || !isEligible(detail, ctx.now(), !ctx.lookup_incomplete)) continue;
      let claim;
      try { claim = await sink.claim(ctx, detail.ref, { watcherId: ctx.config.watch.watcher_id, ttlSec: ctx.config.watch.claim_ttl_sec }); }
      catch (error) {
        if (['EAPI_BUDGET', 'ELOOKUP_INCOMPLETE', 'LOOKUP_INCOMPLETE'].includes(error.code) || ctx.lookup_incomplete) {
          ctx.lookup_incomplete = true;
          break;
        }
        throw error;
      }
      if (claim?.lookup_incomplete || claim?.incomplete) ctx.lookup_incomplete = true;
      if (ctx.lookup_incomplete) break;
      pendingClaims.delete(detail.ref);
      if (!claim?.won) { summary.pending_remaining++; continue; }
      summary.claimed++;
      if (ctx.signal.aborted) {
        await sink.releaseClaim(ctx, detail.ref, { watcherId: ctx.config.watch.watcher_id, claimRef: claim.claimRef });
        break;
      }
      // Dispatch contexts retain their own observation clock and API budget;
      // a future tick must not reset an active lease's response state.
      const dispatchCtx = { ...ctx, apiCalls: 0, lookup_incomplete: false, errors: summary.errors };
      dispatchCtx.now = () => dispatchCtx.boardTime || new Date(ctx.clock()).toISOString();
      const promise = Promise.resolve().then(() => ctx.dispatch(dispatchCtx, detail, claim, { env: ctx.env, signal: ctx.signal }))
        .then(async result => {
          if (result?.status === 'dispatch-failed') summary.dispatch_failed = (summary.dispatch_failed || 0) + 1;
          if (result?.needsHuman) await upsertNeedsHuman(dispatchCtx, detail, summary, result.consecutiveFailures);
        })
        .catch(error => reportError(dispatchCtx, error, summary.errors))
        .finally(() => { summary.lookup_incomplete ||= Boolean(dispatchCtx.lookup_incomplete); ctx.running.delete(detail.ref); });
      ctx.running.set(detail.ref, promise);
      summary.dispatched++;
      dispatches.push(promise);
    }
    if (options.once) await Promise.all(dispatches);
    if (!ctx.signal.aborted && !ctx.lookup_incomplete) {
      const gaps = await ctx.checkGaps(ctx, sink);
      summary.gaps = gaps.gaps;
    }
    // The label survives watcher crashes and failed human-channel sends. Retry
    // only after current repair and gap work so historical alerts cannot starve it.
    await reconcileNeedsHuman(ctx, failures, summary);
  } catch (error) { reportError(ctx, error); }
  finally {
    if (confirmedRefs.size) {
      // Retry a confirmed eligible row before spending another tick on hints.
      // Once claimed, ordinary ring traversal resumes across deferred rows.
      const claimIndex = scanWindow.findIndex(record => pendingClaims.has(record.ref));
      const pendingIndex = claimIndex >= 0 ? claimIndex : scanWindow.findIndex(record => !confirmedRefs.has(record.ref));
      const cursor = pendingIndex === -1 ? scanWindow.at(-1).ref : pendingIndex === 0 ? scanPredecessor : scanWindow[pendingIndex - 1].ref;
      try { scanCursor(ctx, cursor); } catch (error) { reportError(ctx, error, summary.errors); }
    }
    summary.lookup_incomplete ||= Boolean(ctx.lookup_incomplete);
    summary.pending_remaining += summary.unscanned;
  }
  return summary;
}

async function watch(argv, env = process.env, io = {}) {
  const stdout = io.stdout ?? process.stdout; const stderr = io.stderr ?? process.stderr;
  let flags;
  try { flags = parseWatch(argv); } catch (_) { output(stderr, 'watch: invalid arguments\n'); return 2; }
  if (flags.help || flags.version) { if (!flags.quiet) output(stdout, flags.version ? version + '\n' : USAGE); return 0; }
  let resolved;
  try { resolved = resolveConfig(flags, env, { command: 'watch' }); }
  catch (error) { if (!flags.quiet) output(stderr, 'watch: ' + (error.code || 'invalid configuration') + '\n'); return 3; }
  const { home, config, configPath } = resolved;
  const masks = [...buildMaskList(config, env), ...(resolved.maskList || [])];
  const controller = new AbortController();
  const ctx = { home, config, configPath, env, maskList: masks, signal: controller.signal, clock: io.clock || Date.now,
    sink: io.sink || require('./sinks/' + config.sink.type), http: io.http || require('./http').request,
    emit: io.emit || require('./emit').emit, flush: io.flush || require('./flush').flush,
    dispatch: io.dispatch || require('./dispatch').dispatch, checkGaps: io.checkGaps || require('./heartbeat').checkGaps,
    tmpdir: io.tmpdir, now: () => ctx.boardTime || new Date(ctx.clock()).toISOString() };
  ctx.notify = io.notify || (config.notify.length ? alert => require('./notify').notify(ctx, alert) : undefined);
  ctx.log = message => {
    const line = cleanValue(String(message), masks).replace(/[\r\n]+/g, ' ').trim() + '\n';
    if (!flags.quiet) output(stderr, line);
    try {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      const file = path.join(home, 'errmeter.log');
      let size = 0;
      try { size = fs.statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (size + Buffer.byteLength(line) > config.spool.log_max_bytes && size) {
        try { fs.unlinkSync(file + '.1'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        fs.renameSync(file, file + '.1');
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch (_) { /* Logging cannot stop the loop. */ }
  };
  let timer; let wake;
  const signal = () => { controller.abort(); if (timer) clearTimeout(timer); if (wake) wake(); };
  const signals = io.signals || process;
  signals.on('SIGINT', signal); signals.on('SIGTERM', signal);
  try {
    if (resolved.warning) ctx.log(resolved.warning);
    await (io.cleanup || require('./dispatch').cleanupDispatches)(home, io);
    let code = 0;
    do {
      if (ctx.signal.aborted) break;
      const summary = await tick(ctx, { ...io, once: flags.once });
      code = summary.flush === 3 ? 3 : summary.flush || summary.pending_remaining || summary.lookup_incomplete || summary.errors.length || summary.dispatch_failed ? 1 : 0;
      if (!flags.quiet) output(stdout, flags.json ? JSON.stringify(cleanValue(summary, masks)) + '\n'
        : 'watch: role=' + summary.role + ' flush=' + summary.flush + ' eligible=' + summary.eligible + ' claimed=' + summary.claimed + ' dispatched=' + summary.dispatched + ' gaps=' + summary.gaps + '\n');
      if (flags.once || ctx.signal.aborted) break;
      await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, config.watch.interval_sec * 1000); });
      timer = undefined; wake = undefined;
    } while (!ctx.signal.aborted);
    return ctx.signal.aborted ? 0 : code;
  } catch (error) { ctx.log(error.message || 'watch startup failed'); return 1; }
  finally { if (timer) clearTimeout(timer); signals.removeListener('SIGINT', signal); signals.removeListener('SIGTERM', signal); }
}
function main(argv) {
  process.stdout.on('error', () => {}); process.stderr.on('error', () => {});
  return watch(argv).then(code => { process.exitCode = code; }, () => {
    if (!argv.includes('--quiet')) output(process.stderr, 'watch: unexpected failure\n'); process.exitCode = 1;
  });
}
module.exports = { watch, tick, main };
