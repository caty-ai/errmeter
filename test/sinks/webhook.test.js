'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const sink = require('../../src/sinks/webhook');
const client = require('../../src/http');
test('webhook delivers exact heartbeat, failure and alert JSON bodies and configured headers', async t => {
  const received = []; let status = 202;
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => { received.push({ body: JSON.parse(body), headers: request.headers }); response.writeHead(status); response.end('{}'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const ctx = { config: { sink: { url: 'http://127.0.0.1:' + server.address().port, headers: { 'X-Custom': 'test.header.value' } } }, http: client.request };
  const event = { id: 'one', kind: 'heartbeat', agent: 'a' };
  const group = { fingerprint: 'fp', fpv: 1, agent: 'a', events: [{ ...event, kind: 'error' }], count: 1, counter: 'omit' };
  await sink.deliverHeartbeat(ctx, event); assert.deepEqual((await sink.deliverFailureGroup(ctx, group)).delivered, ['one']);
  await sink.upsertAlert(ctx, { key: 'alert', body: 'help' });
  assert.deepEqual(received.map(row => row.body), [event, { fingerprint: 'fp', fpv: 1, agent: 'a', count: 1, events: group.events }, { alert: { key: 'alert', body: 'help' } }]);
  assert.equal(received[0].headers['content-type'], 'application/json'); assert.equal(received[0].headers['x-custom'], 'test.header.value');
  status = 503;
  await assert.rejects(sink.deliverHeartbeat(ctx, event), { status: 503 });
  ctx.dryRun = true; await sink.deliverHeartbeat(ctx, event); assert.equal(received.length, 4);
});
test('webhook board reads reject with NotABoard and exposes no future claim operations', async () => {
  for (const name of ['listOpenFailures', 'getFailure', 'listHeartbeats']) await assert.rejects(sink[name]({}), sink.NotABoard);
  assert.deepEqual(Object.keys(sink).sort(), ['NotABoard', 'deliverFailureGroup', 'deliverHeartbeat', 'getFailure', 'listHeartbeats', 'listOpenFailures', 'upsertAlert'].sort());
});
