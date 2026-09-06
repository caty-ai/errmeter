'use strict';

const { cleanValue } = require('./sinks/clean');

async function checkGaps(ctx, sink = ctx.sink) {
  const records = await sink.listHeartbeats(ctx);
  if (ctx.lookup_incomplete) return { gaps: 0, lookup_incomplete: true };
  const now = Date.parse(ctx.now());
  if (!Number.isFinite(now)) throw new Error('Heartbeat board time is unavailable');
  let gaps = 0;
  for (const record of records) {
    const identity = record.agent + '@' + record.host;
    const limit = ctx.config.watch.gaps?.[identity] ?? ctx.config.watch.heartbeat_gap_sec;
    const seen = Date.parse(record.lastSeen);
    if (Number.isFinite(seen) && now - seen <= limit * 1000) continue;
    if (ctx.signal?.aborted || ctx.lookup_incomplete) break;
    const alert = cleanValue({ key: 'heartbeat-gap:' + identity, title: 'Heartbeat gap: ' + identity,
      body: identity + ' has been silent since ' + record.lastSeen + ' (allowed gap ' + limit + ' seconds). ' + (ctx.config.owner.mention || ''),
      mention: ctx.config.owner.mention }, ctx.maskList || []);
    // The board owns episode election and notification, including crash cover.
    const result = await sink.upsertAlert(ctx, alert);
    if (result?.lookup_incomplete) ctx.lookup_incomplete = true;
    gaps++;
  }
  return { gaps, lookup_incomplete: Boolean(ctx.lookup_incomplete) };
}

module.exports = { checkGaps };
