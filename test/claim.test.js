'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveClaimState, isEligible, consecutiveFailureCount, holder } = require('../src/claim');
const now = '2026-09-05T12:00:00.000Z';
const later = '2026-09-05T12:15:00.000Z';
const issue = { state: 'open', labels: [], lastOccurrenceAt: '2026-09-05T11:00:00.000Z' };
function claim(id, watcherId, expiresAt = later, claimRef = 'new') {
  return { id, type: 'claim', watcherId, expiresAt, claimRef, ts: now };
}
function state(comments, extra = {}) { return deriveClaimState({ issue, comments, now, ...extra }); }
test('claims elect lowest comment id, including renewal ids, with board clock expiry', () => {
  const result = state([claim(9, 'a', later, 1), claim(8, 'b'), claim(1, 'a', now)]);
  assert.equal(result.holder, 'b'); assert.equal(result.claim.claimRef, 8);
  assert.equal(result.eligible, false); assert.equal(result.claims[0].live, false);
  assert.equal(holder(result), 'b');
});
test('only later release or outcome from the same watcher ends a live claim', () => {
  assert.equal(state([claim(2, 'a'), { id: 3, type: 'release', watcherId: 'b' }]).holder, 'a');
  assert.equal(state([{ id: 1, type: 'outcome', watcherId: 'a' }, claim(2, 'a')]).holder, 'a');
  assert.equal(state([claim(2, 'a'), { id: 3, type: 'release', watcherId: 'a', claimRef: 999 }]).holder, 'a');
  assert.equal(state([claim(2, 'a'), { id: 3, type: 'release', watcherId: 'a', claimRef: 2 }]).holder, null);
  assert.equal(state([claim(2, 'a'), { id: 3, type: 'outcome', watcherId: 'a' }]).holder, null);
});
test('loser release cannot revoke a same-watcher winner or its renewal chain', () => {
  const claims = [claim(2, 'a'), claim(3, 'a'), claim(4, 'a', later, 2)];
  const released = state([...claims, { id: 5, type: 'release', watcherId: 'a', claimRef: '3' }]);
  assert.deepEqual(released.claims.map(candidate => candidate.live), [true, false, true]);
  assert.equal(released.claim.claimRef, 2);
  const ended = state([...claims, { id: 5, type: 'release', watcherId: 'a', claimRef: '2' }]);
  assert.deepEqual(ended.claims.map(candidate => candidate.live), [false, true, false]);
});
test('incomplete listings and missing board time fail closed', () => {
  for (const extra of [{ complete: false }, { now: undefined }, { issue: { incomplete: true } }]) {
    const result = state([], extra); assert.equal(result.eligible, false); assert.equal(result.incomplete, true);
  }
  const comments = []; comments.incomplete = true;
  assert.equal(state(comments).eligible, false);
});
test('eligibility requires a strictly newer occurrence and excludes closed and escalated issues', () => {
  const outcome = { id: 1, type: 'outcome', status: 'repaired', watcherId: 'a', at: now };
  assert.equal(state([]).eligible, true);
  assert.equal(state([outcome]).eligible, false);
  assert.equal(state([outcome, { id: 2, type: 'occurrence', last: now }]).eligible, false);
  assert.equal(state([outcome, { id: 2, type: 'occurrence', last: later }]).eligible, true);
  assert.equal(isEligible({ ...issue, state: 'closed' }), false);
  assert.equal(isEligible({ ...issue, labels: [{ name: 'errmeter:needs-human' }] }), false);
});
test('occurrences never reset failure count, repaired outcome does', () => {
  const failed = id => ({ id, type: 'outcome', status: 'dispatch-failed', watcherId: 'a', at: now });
  assert.equal(state([failed(1), { id: 2, type: 'occurrence', last: later }, failed(3)]).consecutiveFailures, 2);
  const result = state([failed(1), { ...failed(2), status: 'repaired' }, failed(3)]);
  assert.equal(result.consecutiveFailures, 1); assert.equal(consecutiveFailureCount(result), 1);
});

test('comment ordering disambiguates board timestamps rounded to one second', () => {
  const issue = { state: 'open', labels: [], lastOccurrenceAt: '2026-09-06T00:00:00.900Z' };
  const outcome = { id: 2, op: 'outcome', status: 'repaired', watcherId: 'a', ts: '2026-09-06T00:00:00.000Z' };
  assert.equal(deriveClaimState({ issue, comments: [outcome], now: '2026-09-06T00:00:01Z' }).eligible, false);
  const occurrence = { id: 3, op: 'occurrence', last: '2026-09-06T00:00:00.900Z', ts: '2026-09-06T00:00:01Z' };
  assert.equal(deriveClaimState({ issue, comments: [outcome, occurrence], now: '2026-09-06T00:00:01Z' }).eligible, true);
});
test('raw GitHub markers must be first-line and outcome content stays separate', () => {
  const result = state([
    { id: 1, created_at: now, body: '<!-- errmeter:claim watcher=a expires=' + later + ' ref=new -->' },
    { id: 2, body: 'quoted\n<!-- errmeter:release watcher=a ref=1 -->' }
  ]);
  assert.equal(result.holder, 'a');
  const ended = state([{ id: 3, body: '<!-- errmeter:outcome status=repaired watcher=a ts=' + now + ' -->\n\nProposed fix\n\nhttps://example.test/pr/1\n\n```text\ntrace\n```' }]);
  assert.equal(ended.lastOutcome.summary, 'Proposed fix'); assert.equal(ended.lastOutcome.url, 'https://example.test/pr/1');
});
