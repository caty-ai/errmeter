'use strict';

class NotABoard extends Error {
  constructor() { super('Webhook sink is not a board'); this.name = 'NotABoard'; this.code = 'NOT_A_BOARD'; }
}
async function post(ctx, body) {
  if (ctx.dryRun) return { status: 200 };
  const transport = typeof ctx.http === 'function' ? ctx.http : ctx.http.request;
  const response = await transport({ method: 'POST', url: ctx.config.sink.url, headers: { ...(ctx.config.sink.headers || {}), 'Content-Type': 'application/json' }, body });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error('Webhook HTTP ' + response.status);
    error.status = response.status; error.headers = response.headers; error.date = response.date;
    throw error;
  }
  return response;
}
async function deliverHeartbeat(ctx, event) { await post(ctx, event); return { ref: event.id }; }
async function deliverFailureGroup(ctx, group) {
  const { fingerprint, fpv, agent, count, events } = group;
  await post(ctx, { fingerprint, fpv, agent, count, events });
  return { ref: 'webhook', delivered: events.map(event => event.id).filter(Boolean) };
}
async function upsertAlert(ctx, alert) { await post(ctx, { alert }); return { winner: true }; }
async function listOpenFailures() { throw new NotABoard(); }
async function getFailure() { throw new NotABoard(); }
async function listHeartbeats() { throw new NotABoard(); }
module.exports = { deliverHeartbeat, deliverFailureGroup, listOpenFailures, getFailure, listHeartbeats, upsertAlert, NotABoard };
