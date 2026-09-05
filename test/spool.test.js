'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temporaryHomes = [];
process.once('exit', () => {
  for (const home of temporaryHomes) fs.rmSync(home, { recursive: true, force: true });
});
const { randomUUID } = require('node:crypto');
const { writeEvent } = require('../src/spool');

function temporary(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-spool-test-'));
  temporaryHomes.push(home);
  return home;
}
function event(extra = {}) {
  return Object.assign({ schema: 1, id: randomUUID(), ts: '2026-09-05T13:07:41.213Z',
    kind: 'error', agent: 'nora', host: 'vps-1', message: 'failure', detail: 'trace',
    fingerprint: 'a3f9c2e17b04d8e6', fpv: 1, emitter: 'errmeter/1.0.0', attempts: 0 }, extra);
}
const capacity = { pending_soft_limit: 1, pending_hard_limit: 2 };
function read(result) { return JSON.parse(fs.readFileSync(result.path, 'utf8')); }
function counterOptions(extra = {}) {
  return { spool: Object.assign({ pending_soft_limit: 0, pending_hard_limit: 0 }, extra) };
}

test('normal spool uses exclusive tmp, best-effort fsync, atomic rename and exact filename', t => {
  const home = temporary(t);
  const original = event();
  const opens = [];
  const io = Object.assign({}, fs, {
    openSync(file, flag, mode) { opens.push([file, flag]); return fs.openSync(file, flag, mode); },
    fsyncSync() { throw new Error('unsupported'); }
  });
  const result = writeEvent(home, original, { fs: io });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'normal');
  assert.equal(result.fallback, false);
  assert.equal(path.basename(result.path), '2026-09-05T13-07-41-213Z-' + original.id + '.json');
  assert.deepEqual(read(result), original);
  assert.equal(fs.readFileSync(result.path, 'utf8').endsWith('\n'), true);
  assert.deepEqual(opens, [[result.path.replace(/\.json$/, '.tmp'), 'wx']]);
  assert.deepEqual(fs.readdirSync(path.dirname(result.path)), [path.basename(result.path)]);
  for (const directory of ['sent', 'dead']) assert.equal(fs.statSync(path.join(home, 'spool', directory)).isDirectory(), true);
});

test('soft limit compacts while ignoring temporary and overflow marker files', t => {
  const home = temporary(t);
  const first = writeEvent(home, event(), { spool: capacity });
  fs.writeFileSync(path.join(path.dirname(first.path), 'ignored.tmp'), '');
  fs.writeFileSync(path.join(path.dirname(first.path), 'overflow-exceeded.json'), '{}');
  const original = event({ meta: { run: '1' } });
  const result = writeEvent(home, original, { spool: capacity });
  assert.equal(result.mode, 'compact');
  assert.equal(read(result).detail, '');
  assert.deepEqual(read(result).meta, { run: '1', _compact: '1' });
  assert.equal(original.detail, 'trace');
  assert.deepEqual(original.meta, { run: '1' });
});

test('hard limit appends one UTF-8 line within 320 bytes, preserving all fixed fields', t => {
  const home = temporary(t);
  writeEvent(home, event(), { spool: capacity });
  writeEvent(home, event(), { spool: capacity });
  const original = event({ message: '秘密\tline\n' + '😀'.repeat(500) });
  let writes = 0;
  const io = Object.assign({}, fs, { writeSync(...args) { writes += 1; return fs.writeSync(...args); } });
  const result = writeEvent(home, original, { fs: io, spool: capacity });
  assert.equal(result.mode, 'counter');
  const line = fs.readFileSync(result.path, 'utf8');
  assert.equal(writes, 1);
  assert.ok(Buffer.byteLength(line) <= 320);
  assert.equal(line.includes('\ufffd'), false);
  assert.equal(line.split('\n').length, 2);
  assert.deepEqual(line.trimEnd().split('\t').slice(0, 5),
    [original.fingerprint, '1', original.agent, original.host, original.ts]);
  assert.equal(fs.readdirSync(path.dirname(result.path)).filter(name => name.endsWith('.json')).length, 2);
});

test('append-then-verify reopens and re-appends after an external unlink', t => {
  const home = temporary(t);
  let writes = 0;
  const file = path.join(home, 'spool', 'pending', 'counters.log');
  const io = Object.assign({}, fs, {
    writeSync(...args) {
      if (writes++ === 0) fs.unlinkSync(file);
      return fs.writeSync(...args);
    }
  });
  const result = writeEvent(home, event(), Object.assign(counterOptions(), { fs: io }));
  assert.equal(result.mode, 'counter');
  assert.equal(writes, 2);
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').length, 2);
});

test('overflow ceiling writes one persistent marker and drops without further appends', t => {
  const home = temporary(t);
  const options = counterOptions({ overflow_max_bytes: 100, overflow_guard_bytes: 100 });
  const first = writeEvent(home, event(), options);
  fs.writeFileSync(first.path, 'x'.repeat(100));
  const original = event();
  const dropped = writeEvent(home, original, options);
  assert.equal(dropped.mode, 'dropped');
  assert.deepEqual(read(dropped), { since: original.ts });
  const next = writeEvent(home, event({ ts: '2026-09-06T13:07:41.213Z' }), options);
  assert.equal(next.mode, 'dropped');
  assert.deepEqual(read(next), { since: original.ts });
  assert.equal(fs.statSync(first.path).size, 100);
  assert.equal(fs.readdirSync(path.dirname(first.path)).some(name => name.endsWith('.tmp')), false);
});

test('hard cap rejects a prospective crossing and any already oversized log', t => {
  const home = temporary(t);
  const options = counterOptions({ overflow_max_bytes: 100, overflow_guard_bytes: 5 });
  const result = writeEvent(home, event({ message: 'x'.repeat(500) }), options);
  assert.equal(result.mode, 'dropped');
  const file = path.join(home, 'spool', 'pending', 'counters.log');
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, 'x'.repeat(105));
  assert.equal(writeEvent(home, event(), options).mode, 'dropped');
  assert.equal(fs.statSync(file).size, 105);
});

test('heartbeat upserts reuse safe filenames and overflow after the configured limit', t => {
  const home = temporary(t);
  const options = counterOptions({ max_heartbeat_files: 1 });
  const heartbeat = event({ kind: 'heartbeat', agent: 'watcher/main' });
  delete heartbeat.fingerprint;
  delete heartbeat.fpv;
  delete heartbeat.detail;
  const first = writeEvent(home, heartbeat, options);
  assert.equal(path.basename(first.path), 'heartbeat-watcher%2Fmain@vps-1.json');
  const updated = event(Object.assign({}, heartbeat, { id: randomUUID(), message: 'updated' }));
  const second = writeEvent(home, updated, options);
  assert.equal(second.path, first.path);
  assert.equal(read(second).message, 'updated');
  const overflow = writeEvent(home, Object.assign({}, heartbeat, { id: randomUUID(), agent: 'other' }), options);
  assert.equal(overflow.mode, 'counter');
  assert.match(fs.readFileSync(overflow.path, 'utf8'), /^-\t0\tother\tvps-1\t[^\t]+\tkind=heartbeat\n$/);
  assert.equal(fs.readdirSync(path.dirname(first.path)).filter(name => name.endsWith('.json')).length, 1);
  assert.equal(fs.readdirSync(path.dirname(first.path)).some(name => name.endsWith('.tmp')), false);
});

test('Windows-style existing destination rename failure retries heartbeat upsert', t => {
  const home = temporary(t);
  const options = counterOptions();
  const original = event({ kind: 'heartbeat' });
  const first = writeEvent(home, original, options);
  const io = Object.assign({}, fs, {
    renameSync(from, to) {
      if (fs.existsSync(to)) throw Object.assign(new Error('destination exists'), { code: 'EEXIST' });
      return fs.renameSync(from, to);
    }
  });
  const second = writeEvent(home, event({ kind: 'heartbeat', message: 'new' }), Object.assign({}, options, { fs: io }));
  assert.equal(second.path, first.path);
  assert.equal(second.fallback, false);
  assert.equal(read(second).message, 'new');
});

test('failed primary write retries the whole write under temporary root with reserved meta', t => {
  const root = temporary(t);
  const home = path.join(root, 'not-a-directory');
  fs.writeFileSync(home, 'blocked');
  const original = event();
  const result = writeEvent(home, original, { tmpdir: root });
  assert.equal(result.ok, true);
  assert.equal(result.fallback, true);
  assert.ok(result.path.startsWith(path.join(root, 'errmeter-spool', 'spool', 'pending')));
  assert.deepEqual(read(result).meta, { _spool_fallback: '1' });
  assert.equal(original.meta, undefined);
});

test('failed rename cleans the temporary file before fallback', t => {
  const root = temporary(t);
  const home = path.join(root, 'primary');
  const io = Object.assign({}, fs, {
    renameSync(from, to) {
      if (to.startsWith(home + path.sep)) throw new Error('write denied');
      return fs.renameSync(from, to);
    }
  });
  const result = writeEvent(home, event(), { fs: io, tmpdir: root });
  assert.equal(result.fallback, true);
  assert.deepEqual(fs.readdirSync(path.join(home, 'spool', 'pending')), []);
});

test('both homes failing returns false and exactly one generic diagnostic, never throws', t => {
  const home = temporary(t);
  const messages = [];
  const io = Object.assign({}, fs, { mkdirSync() { throw new Error('secret-token-value'); } });
  const result = writeEvent(home, event(), { fs: io, stderr: message => messages.push(message) });
  assert.equal(result.ok, false);
  assert.deepEqual(messages, ['emit: local spool write failed\n']);
  assert.doesNotThrow(() => writeEvent(home, event(), { fs: io, stderr() { throw new Error('broken pipe'); } }));
});

test('serialized event remains at most 32 KiB after fallback metadata is added', t => {
  const root = temporary(t);
  const home = path.join(root, 'blocked');
  fs.writeFileSync(home, 'blocked');
  const original = event({ detail: '[errmeter: truncated to last 40 lines]\n' + '😀'.repeat(9000),
    meta: { note: 'a'.repeat(256) } });
  const result = writeEvent(home, original, { tmpdir: root });
  assert.equal(result.ok, true);
  assert.ok(fs.statSync(result.path).size <= 32768);
  assert.ok(read(result).detail.startsWith('[errmeter: truncated to last 40 lines]\n'));
  assert.equal(read(result).meta._spool_fallback, '1');
});
