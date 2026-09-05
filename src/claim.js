'use strict';

function countConsecutiveFailures(outcomes = []) {
  let count = 0;
  for (let i = outcomes.length - 1; i >= 0; i--) {
    if (outcomes[i].status === 'repaired') break;
    if (outcomes[i].status === 'dispatch-failed') count++;
  }
  return count;
}

function liveClaims(detail, now, complete = true) {
  if (!complete || detail?.incomplete || detail?.lookup_incomplete) return [];
  const claims = Array.isArray(detail) ? detail : detail?.claims || (detail?.claim ? [detail.claim] : []);
  return claims.filter(claim => claim.live && (now === undefined || Date.parse(claim.expiresAt) > new Date(now).getTime()))
    .sort((a, b) => Number(a.commentId ?? a.claimRef) - Number(b.commentId ?? b.claimRef));
}

function holder(detail, now, complete = true) { return liveClaims(detail, now, complete)[0]?.watcherId || null; }
function consecutiveFailureCount(detailOrOutcomes) {
  return countConsecutiveFailures(Array.isArray(detailOrOutcomes) ? detailOrOutcomes : detailOrOutcomes?.outcomes || []);
}

function isEligible(issue, now, complete = true) {
  if (!complete || !issue || issue.detailed === false || issue.incomplete || issue.lookup_incomplete || issue.state === 'closed' || issue.closed === true) return false;
  const labels = (issue.labels || []).map(label => typeof label === 'string' ? label : label.name);
  if (labels.includes('errmeter:needs-human') || liveClaims(issue, now).length) return false;
  if (!issue.lastOutcome) return true;
  if (typeof issue.occurrenceAfterLastOutcome === 'boolean') return issue.occurrenceAfterLastOutcome;
  return Date.parse(issue.lastOccurrenceAt) > Date.parse(issue.lastOutcome.at);
}

// Only the first line can be a protocol comment. Quoted markers in hook output
// or fenced event JSON must never grant or end a lease.
function commentRecord(comment) {
  if (typeof comment.body === 'string') {
    const match = /^<!-- errmeter:([a-z-]+)(?: ([^\r\n]*))? -->$/.exec(comment.body.split(/\r?\n/, 1)[0]);
    if (!match) return null;
    const fields = {};
    for (const field of (match[2] || '').split(' ')) {
      const at = field.indexOf('=');
      if (at > 0) fields[field.slice(0, at)] = field.slice(at + 1);
    }
    let summary = comment.body.split(/\r?\n/).slice(1).join('\n').trim();
    let url;
    if (match[1] === 'outcome') {
      summary = summary.replace(/(?:^|\n\n)```text\n[\s\S]*?\n```\s*$/, '').trim();
      const link = /(?:^|\n\n)(https?:\/\/\S+)$/.exec(summary);
      if (link) { url = link[1]; summary = summary.slice(0, link.index).trim(); }
    }
    return { id: comment.id, type: match[1], watcherId: fields.watcher,
      claimRef: fields.ref === 'new' ? comment.id : fields.ref,
      expiresAt: fields.expires, createdAt: comment.created_at,
      at: fields.ts || comment.created_at, last: fields.last, status: fields.status,
      summary, ...(url ? { url } : {}) };
  }
  return { ...comment, id: comment.id ?? comment.seq, type: comment.type || comment.op,
    createdAt: comment.createdAt || comment.ts, at: comment.at || comment.ts,
    last: comment.last || comment.record?.lastOccurrenceAt };
}

function deriveClaimState({ issue = {}, comments = [], now, complete = true }) {
  const incomplete = !complete || comments.incomplete === true || issue.incomplete === true ||
    issue.lookup_incomplete === true || !Number.isFinite(new Date(now).getTime());
  if (incomplete) return { claims: [], outcomes: [], claim: null, holder: null,
    lastOutcome: null, consecutiveFailures: 0, eligible: false, incomplete: true };
  const records = comments.map(commentRecord).filter(Boolean).sort((a, b) => Number(a.id) - Number(b.id));
  const claims = records.filter(record => record.type === 'claim').map(record => ({
    claimRef: record.claimRef === 'new' || record.claimRef == null ? record.id : /^\d+$/.test(String(record.claimRef)) ? Number(record.claimRef) : record.claimRef,
    commentId: record.id, watcherId: record.watcherId, createdAt: record.createdAt, expiresAt: record.expiresAt,
    live: Boolean(record.watcherId) && Date.parse(record.expiresAt) > new Date(now).getTime() &&
      !records.some(later => Number(later.id) > Number(record.id) && later.watcherId === record.watcherId &&
        (later.type === 'outcome' || (later.type === 'release' && String(later.claimRef) ===
          String(record.claimRef === 'new' || record.claimRef == null ? record.id : record.claimRef))))
  }));
  const outcomes = records.filter(record => record.type === 'outcome').map(record => ({
    status: record.status, watcherId: record.watcherId, at: record.at, summary: record.summary || '',
    ...(record.url ? { url: record.url } : {}), ...(record.claimRef != null ? { claimRef: record.claimRef } : {})
  }));
  const claim = claims.find(candidate => candidate.live) || null;
  const lastOutcome = outcomes.at(-1) || null;
  const lastOutcomeRecord = records.filter(record => record.type === 'outcome').at(-1);
  const lastOccurrenceAt = records.filter(record => record.type === 'occurrence').map(record => record.last)
    .concat(issue.lastOccurrenceAt || []).filter(stamp => Number.isFinite(Date.parse(stamp))).sort().at(-1);
  const occurrenceAfterLastOutcome = !lastOutcomeRecord ? false : records.some(record =>
    record.type === 'occurrence' && Number(record.id) > Number(lastOutcomeRecord.id) &&
    Date.parse(record.last) > Date.parse(lastOutcome.at));
  return { claims, outcomes, claim, holder: claim?.watcherId || null, lastOutcome,
    consecutiveFailures: countConsecutiveFailures(outcomes),
    occurrenceAfterLastOutcome,
    eligible: isEligible({ ...issue, claims, claim, lastOutcome, lastOccurrenceAt, occurrenceAfterLastOutcome }), incomplete: false };
}

async function acquireClaim(ctx, sink, ref, options = {}) {
  const detail = await sink.getFailure(ctx, ref);
  if (ctx.lookup_incomplete || !isEligible(detail)) return { won: false };
  return sink.claim(ctx, ref, { watcherId: options.watcherId || ctx.config.watch.watcher_id,
    ttlSec: options.ttlSec ?? ctx.config.watch.claim_ttl_sec ?? 900 });
}

module.exports = { deriveClaimState, liveClaims, holder, isEligible, consecutiveFailureCount, countConsecutiveFailures, acquireClaim };
