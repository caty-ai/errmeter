'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { redact } = require('../redact');
const version = require('../../package.json').version;

function now(ctx) { return new Date(ctx.boardTime || (ctx.now ? ctx.now() : Date.now())).toISOString(); }
function limit(ctx, key, fallback) { return ctx.config[key] ?? ctx.config.sink[key] ?? ctx.config.spool?.[key] ?? fallback; }
function unknown(ctx) {
  ctx.lookup_incomplete = true;
  const error = new Error('GitHub listing incomplete');
  error.code = 'ELOOKUP_INCOMPLETE';
  return error;
}
async function api(ctx, method, target, body) {
  if ((ctx.apiCalls || 0) >= limit(ctx, 'max_api_calls_per_pass', 60)) { const error = unknown(ctx); error.code = 'EAPI_BUDGET'; throw error; }
  const base = ctx.config.sink.api_base || 'https://api.github.com';
  const url = new URL(target, base);
  // Never forward credentials to an origin supplied by an untrusted Link header.
  if (url.origin !== new URL(base).origin) throw unknown(ctx);
  ctx.apiCalls = (ctx.apiCalls || 0) + 1;
  const response = await (ctx.http || require('../http').request)({ method, url: url.href,
    headers: { Authorization: 'Bearer ' + ctx.config.sink.token, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'errmeter/' + version },
    body: body === undefined ? undefined : JSON.parse(redact(JSON.stringify(body), [...(ctx.maskList || []), ctx.config.sink.token].filter(Boolean))) });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error('GitHub HTTP ' + response.status);
    error.status = response.status; error.headers = response.headers; throw error;
  }
  const date = response.date || response.headers?.date;
  if (date && Number.isFinite(new Date(date).getTime())) ctx.boardTime = new Date(date).toISOString();
  return response;
}
function root(ctx) { return '/repos/' + ctx.config.sink.repo; }
async function list(ctx, target) {
  let next = target + (target.includes('?') ? '&' : '?') + 'per_page=100';
  const rows = [];
  for (let page = 0; next; page++) {
    if (page >= limit(ctx, 'max_pages_per_list', 10)) throw unknown(ctx);
    const res = await api(ctx, 'GET', next);
    if (!Array.isArray(res.body)) throw unknown(ctx);
    rows.push(...res.body);
    const links = res.headers?.link || res.headers?.Link || '';
    next = (links.match(/<([^>]+)>;\s*rel="next"/) || [])[1];
  }
  return rows;
}
function markers(body, type) {
  const result = [];
  for (const match of (body || '').matchAll(/<!-- errmeter:([a-z-]+)(?: ([^\n]*?))? -->/g)) {
    if (type && match[1] !== type) continue;
    const item = { type: match[1] };
    for (const field of (match[2] || '').split(' ')) { const at = field.indexOf('='); if (at >= 0) item[field.slice(0, at)] = field.slice(at + 1); }
    result.push(item);
  }
  return result;
}
function allMarkers(issue, comments) { return [issue, ...comments].flatMap(row => markers(row.body)); }
function idsIn(issue, comments) { return new Set(allMarkers(issue, comments).flatMap(m => (m.ids || '').split(',').filter(Boolean))); }
function latest(body) {
  const matches = [...(body || '').matchAll(/```json\n([\s\S]*?)\n```/g)];
  try { return JSON.parse(matches.at(-1)?.[1] || '{}'); } catch (_) { return {}; }
}
async function comments(ctx, ref) { return list(ctx, root(ctx) + '/issues/' + ref + '/comments'); }
async function post(ctx, ref, body) { return (await api(ctx, 'POST', root(ctx) + '/issues/' + ref + '/comments', { body })).body; }
async function removeComment(ctx, id) { await api(ctx, 'DELETE', root(ctx) + '/issues/comments/' + id); }
async function issue(ctx, ref) { return (await api(ctx, 'GET', root(ctx) + '/issues/' + ref)).body; }
async function patch(ctx, ref, payload) { return (await api(ctx, 'PATCH', root(ctx) + '/issues/' + ref, payload)).body; }
async function issues(ctx, label, state = 'open') { return (await list(ctx, root(ctx) + '/issues?state=' + state + '&labels=' + encodeURIComponent(label))).filter(i => !i.pull_request); }
function cacheRead(ctx, name) { try { return JSON.parse(fs.readFileSync(path.join(ctx.home, 'state', name + '.json'), 'utf8')); } catch (_) { return {}; } }
function cacheWrite(ctx, name, key, value) {
  if (ctx.dryRun) return;
  const data = cacheRead(ctx, name); data[key] = value;
  const target = path.join(ctx.home, 'state', name + '.json'); fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 }); fs.renameSync(tmp, target); } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}
function counterRef(group) { const c = group.counter; return typeof c === 'string' ? c : c?.ref || c?.counter_ref || (c?.nonce ? c.nonce + '.' + (c.k || 0) : group.counter_ref); }
function bodyFor(ctx, group, events, kind, extra = '') {
  const counter = counterRef(group);
  const first = events[0] || group.events[0] || {}; const last = events.at(-1) || group.events.at(-1) || {};
  const count = counter ? group.count : events.reduce((n, e) => n + Number(e.meta?._folded_count || 1), 0);
  const prefix = kind === 'failure' ? ' fp=' + group.fingerprint + ' fpv=' + group.fpv : '';
  const marker = '<!-- errmeter:' + kind + prefix + ' ids=' + (counter ? '' : events.map(e => e.id).join(',')) + ' count=' + count + ' first=' + first.ts + ' last=' + last.ts + (kind === 'failure' ? ' schema=1' : '') + (counter ? ' counter_ref=' + counter : '') + (kind === 'occurrence' ? ' ts=' + now(ctx) : '') + extra + ' -->';
  return marker + '\n\n' + (Number(last.schema) > 1 ? 'Newer event schema; delivered verbatim.\n\n' : '') + (last.message || '') + '\n\n```json\n' + JSON.stringify(last, null, 2) + '\n```';
}
async function createFailure(ctx, group, events, extra) {
  return (await api(ctx, 'POST', root(ctx) + '/issues', { title: '[errmeter] ' + group.agent + ': ' + (events.at(-1)?.message || group.events.at(-1)?.message || '').slice(0, 80), body: bodyFor(ctx, group, events, 'failure', extra), labels: ['errmeter', 'errmeter:failure'] })).body;
}
async function duplicate(ctx, canonical, dup, migrate) {
  const mine = await post(ctx, canonical.number, '<!-- errmeter:reconcile from=' + dup.number + ' -->');
  const rows = await comments(ctx, canonical.number);
  const ttl = (ctx.config.watch?.claim_ttl_sec ?? 900) * 1000;
  const candidates = rows.filter(c => markers(c.body, 'reconcile').some(m => m.from === String(dup.number)) && new Date(now(ctx)) - new Date(c.created_at) < ttl).sort((a, b) => a.id - b.id);
  if (candidates[0]?.id !== mine.id) { await removeComment(ctx, mine.id); return false; }
  if (migrate) {
    const dupRows = await comments(ctx, dup.number);
    const known = idsIn(canonical, rows);
    const missing = [...idsIn(dup, dupRows)].filter(id => !known.has(id));
    if (missing.length) {
      const ms = allMarkers(dup, dupRows).filter(m => m.ids);
      const first = ms.map(m => m.first).filter(Boolean).sort()[0] || dup.created_at;
      const last = ms.map(m => m.last).filter(Boolean).sort().at(-1) || dup.created_at;
      await post(ctx, canonical.number, '<!-- errmeter:occurrence ids=' + missing.join(',') + ' count=' + missing.length + ' first=' + first + ' last=' + last + ' migrated_from=' + dup.number + ' ts=' + now(ctx) + ' -->\n\nMigrated from #' + dup.number + '\n\n```json\n' + JSON.stringify(latest(dupRows.at(-1)?.body || dup.body)) + '\n```');
    }
    const knownCounters = new Set(allMarkers(canonical, rows).map(m => m.counter_ref).filter(Boolean));
    for (const m of allMarkers(dup, dupRows)) {
      if (!m.counter_ref || knownCounters.has(m.counter_ref)) continue;
      await post(ctx, canonical.number, '<!-- errmeter:occurrence ids= count=' + m.count + ' first=' + m.first + ' last=' + m.last + ' counter_ref=' + m.counter_ref + ' migrated_from=' + dup.number + ' ts=' + now(ctx) + ' -->');
      knownCounters.add(m.counter_ref);
    }
  }
  await post(ctx, dup.number, '<!-- errmeter:duplicate-of ref=' + canonical.number + ' -->');
  await patch(ctx, dup.number, { state: 'closed' });
  return true;
}
async function deliverFailureGroup(ctx, group) {
  const cache = cacheRead(ctx, 'fingerprints')[group.fingerprint];
  let cached;
  if (cache?.ref) { try { cached = await issue(ctx, cache.ref); } catch (e) { if (e.status !== 404) throw e; } }
  // Listing even after cache hits detects concurrent creations and never treats partial data as absence.
  const open = (await issues(ctx, 'errmeter:failure')).filter(i => markers(i.body, 'failure').some(m => m.fp === group.fingerprint)).sort((a, b) => a.number - b.number);
  let canonical = open[0]; const known = new Set(); const counter = counterRef(group); let counterKnown = false;
  const history = [...open];
  if (cached && !history.some(i => i.number === cached.number)) history.push(cached);
  if (!cached || cached.state !== 'open') {
    const closed = (await issues(ctx, 'errmeter:failure', 'closed')).filter(i => markers(i.body, 'failure').some(m => m.fp === group.fingerprint)).sort((a, b) => b.number - a.number);
    if (closed[0] && !history.some(i => i.number === closed[0].number)) history.push(closed[0]);
  }
  for (const ref of cache?.duplicates || []) if (!history.some(i => i.number === ref)) history.push(await issue(ctx, ref));
  for (let index = 0; index < history.length; index++) {
    const previous = markers(history[index].body, 'failure')[0]?.continues;
    if (previous && !history.some(i => i.number === Number(previous))) history.push(await issue(ctx, Number(previous)));
  }
  let continuation;
  for (const row of history) {
    const cs = await comments(ctx, row.number);
    if (row.state === 'closed' && allMarkers(row, cs).some(m => m.type === 'rolled-over')) continuation = Math.max(continuation || 0, row.number);
    idsIn(row, cs).forEach(id => known.add(id));
    if (counter && allMarkers(row, cs).some(m => m.counter_ref === counter)) counterKnown = true;
  }
  const acknowledged = group.events.filter(e => known.has(e.id)).map(e => e.id);
  const fresh = group.events.filter(e => !known.has(e.id));
  if (canonical) {
    for (const dup of open.slice(1)) if (!await duplicate(ctx, canonical, dup, true)) return { ref: canonical.number, pending: true, delivered: acknowledged };
  }
  if (counterKnown || (!counter && !fresh.length)) return { ref: canonical?.number || history[0]?.number, skipped: true, delivered: group.events.map(e => e.id) };
  if (canonical) {
    cacheWrite(ctx, 'fingerprints', group.fingerprint, { ref: canonical.number, state: 'open', duplicates: [...new Set([...(cache?.duplicates || []), ...open.slice(1).map(i => i.number)])] });
    const rows = await comments(ctx, canonical.number);
    const recent = rows.filter(c => markers(c.body, 'occurrence').some(m => new Date(now(ctx)) - new Date(m.ts) < 3600000));
    if (recent.length >= limit(ctx, 'max_comments_per_issue_per_hour', 12)) return { ref: canonical.number, pending: true, delivered: acknowledged };
    if (rows.length >= limit(ctx, 'max_comments_per_issue', 400)) {
      await post(ctx, canonical.number, '<!-- errmeter:rolled-over -->');
      await patch(ctx, canonical.number, { state: 'closed' });
      const old = canonical.number;
      canonical = await createFailure(ctx, group, fresh, ' continues=' + old);
      cacheWrite(ctx, 'fingerprints', group.fingerprint, { ref: canonical.number, state: 'open', duplicates: [...new Set([old, ...(cache?.duplicates || [])])] });
      return { ref: canonical.number, created: true, delivered: group.events.map(e => e.id) };
    }
    await post(ctx, canonical.number, bodyFor(ctx, group, fresh, 'occurrence'));
    return { ref: canonical.number, created: false, delivered: group.events.map(e => e.id) };
  }
  canonical = await createFailure(ctx, group, fresh, continuation ? ' continues=' + continuation : '');
  cacheWrite(ctx, 'fingerprints', group.fingerprint, { ref: canonical.number, state: 'open', duplicates: history.map(i => i.number) });
  return { ref: canonical.number, created: true, delivered: group.events.map(e => e.id) };
}

function heartbeatRecord(row) { const m = markers(row.body, 'heartbeat')[0]; return m ? { ref: row.number, agent: m.agent, host: m.host, role: m.role || null, lastSeen: m.ts, message: (row.body || '').split('-->')[1]?.trim() || '' } : null; }
async function listHeartbeats(ctx) { return (await issues(ctx, 'errmeter:heartbeat')).map(heartbeatRecord).filter(Boolean); }
async function deliverHeartbeat(ctx, event) {
  const key = event.agent + '@' + event.host; const cached = cacheRead(ctx, 'heartbeats')[key]; let found;
  if (cached) { try { const row = await issue(ctx, cached.ref || cached); if (row.state === 'open') found = heartbeatRecord(row); } catch (e) { if (e.status !== 404) throw e; } }
  if (!found) found = (await listHeartbeats(ctx)).filter(h => h.agent === event.agent && h.host === event.host).sort((a, b) => a.ref - b.ref)[0];
  if (found && new Date(found.lastSeen) >= new Date(event.ts)) return { ref: found.ref, skipped: true };
  const role = event.meta?.role || '';
  const body = '<!-- errmeter:heartbeat agent=' + event.agent + ' host=' + event.host + ' role=' + role + ' ts=' + event.ts + ' -->\n\n' + (event.message || '');
  let ref;
  if (found) { await patch(ctx, found.ref, { body }); ref = found.ref; }
  else { const labels = ['errmeter', 'errmeter:heartbeat']; if (role) labels.push('errmeter:role:' + role); ref = (await api(ctx, 'POST', root(ctx) + '/issues', { title: '[errmeter] heartbeat: ' + key, body, labels })).body.number; }
  cacheWrite(ctx, 'heartbeats', key, ref); return { ref };
}
async function getFailure(ctx, ref) {
  const row = await issue(ctx, ref); const cs = await comments(ctx, ref); const ms = allMarkers(row, cs); const failure = markers(row.body, 'failure')[0] || {};
  const events = [row, ...cs].map(c => latest(c.body)).filter(e => e.id); const event = events.at(-1) || {};
  const outcomes = cs.flatMap(c => markers(c.body, 'outcome').map(m => ({ status: m.status, watcherId: m.watcher, at: m.ts, summary: c.body.split('-->')[1]?.trim() || '' })));
  const claims = cs.flatMap(c => markers(c.body, 'claim').map(m => ({ claimRef: m.ref === 'new' ? c.id : Number(m.ref), watcherId: m.watcher, createdAt: c.created_at, expiresAt: m.expires,
    live: new Date(m.expires) > new Date(now(ctx)) && !cs.some(later => later.id > c.id && markers(later.body).some(end => ['release', 'outcome'].includes(end.type) && end.watcher === m.watcher)) })));
  return { ref: row.number, fingerprint: failure.fp, fpv: Number(failure.fpv), agent: event.agent, host: event.host, title: row.title, labels: (row.labels || []).map(l => typeof l === 'string' ? l : l.name), openedAt: row.created_at,
    lastOccurrenceAt: ms.map(m => m.last).filter(Boolean).sort().at(-1), occurrences: ms.reduce((n, m) => n + (['failure', 'occurrence'].includes(m.type) ? Number(m.count || 0) : 0), 0), claim: claims.filter(c => c.live).sort((a, b) => a.claimRef - b.claimRef)[0] || null,
    lastOutcome: outcomes.at(-1) || null, latest: event, claims, outcomes, occurrenceIds: [...idsIn(row, cs)] };
}
async function listOpenFailures(ctx) {
  const rows = await issues(ctx, 'errmeter:failure'); const result = [];
  for (const row of rows) { if (!markers(row.body, 'failure').length) continue; const detail = await getFailure(ctx, row.number); const { latest: event, claims, outcomes, occurrenceIds, ...summary } = detail; result.push(summary); }
  return result;
}
async function upsertAlert(ctx, alert) {
  const matching = async () => (await issues(ctx, 'errmeter:alert')).filter(i => markers(i.body, 'alert').some(m => m.key === alert.key)).sort((a, b) => a.number - b.number);
  let matches = await matching();
  if (!matches.length) {
    await api(ctx, 'POST', root(ctx) + '/issues', { title: '[errmeter] alert: ' + alert.key, body: '<!-- errmeter:alert key=' + alert.key + ' -->\n\n' + (alert.body || ''), labels: ['errmeter', 'errmeter:alert'] });
    matches = await matching();
    if (!matches.length) throw unknown(ctx);
  }
  const canonical = matches[0];
  for (const dup of matches.slice(1)) if (!await duplicate(ctx, canonical, dup, false)) return { ref: canonical.number, winner: false };
  const prefix = '<!-- errmeter:alert-episode key=' + alert.key + ' host=' + ctx.config.host + ' ts=';
  const stamp = now(ctx); const mine = await post(ctx, canonical.number, prefix + stamp + ' -->');
  let rows = await comments(ctx, canonical.number);
  const windowMs = (ctx.config.watch?.renotify_sec ?? 21600) * 1000;
  const episodes = rows.flatMap(c => markers(c.body, 'alert-episode').filter(m => m.key === alert.key && new Date(now(ctx)) - new Date(m.ts) < windowMs).map(m => ({ ...m, id: c.id, body: c.body }))).sort((a, b) => a.id - b.id);
  const winner = episodes.find(e => e.cover !== '1');
  let chosen = mine; let original;
  if (winner?.id !== mine.id) {
    await removeComment(ctx, mine.id);
    if (!winner || winner.notified || new Date(now(ctx)) - new Date(winner.ts) < (ctx.config.watch?.notify_confirm_sec ?? 120) * 1000) return { ref: canonical.number, winner: false };
    chosen = await post(ctx, canonical.number, prefix + now(ctx) + ' cover=1 -->');
    rows = await comments(ctx, canonical.number);
    const covers = rows.filter(c => markers(c.body, 'alert-episode').some(m => m.key === alert.key && m.cover === '1' && new Date(now(ctx)) - new Date(m.ts) < windowMs)).sort((a, b) => a.id - b.id);
    if (covers[0]?.id !== chosen.id) { await removeComment(ctx, chosen.id); return { ref: canonical.number, winner: false }; }
    original = winner;
  }
  // This flush lane has no notification channel; the alert's owner mention is the notification.
  const notified = ' notified=' + now(ctx) + ' channel=none -->';
  await api(ctx, 'PATCH', root(ctx) + '/issues/comments/' + chosen.id, { body: chosen.body.replace(' -->', notified) });
  if (original) await api(ctx, 'PATCH', root(ctx) + '/issues/comments/' + original.id, { body: original.body.replace(' -->', notified) });
  return { ref: canonical.number, winner: true };
}

module.exports = { deliverHeartbeat, deliverFailureGroup, listOpenFailures, getFailure, listHeartbeats, upsertAlert };
