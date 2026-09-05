'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULTS = {
  pending_soft_limit: 5000,
  pending_hard_limit: 20000,
  overflow_max_bytes: 67108864,
  overflow_guard_bytes: 1048576,
  max_heartbeat_files: 1000
};

// Slice on Unicode boundaries: neither JSON nor the tab-separated log gets
// replacement characters when its byte budget ends inside a multibyte character.
function bytePrefix(text, bytes) {
  let result = '';
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (size > bytes) break;
    result += character;
    bytes -= size;
  }
  return result;
}

function serialize(event) {
  const size = () => Buffer.byteLength(JSON.stringify(event) + '\n');
  // Reserved metadata is added here, so enforce the envelope cap again.
  while (size() > 32768 && event.detail) {
    const lines = event.detail.split('\n');
    const marker = /^\[errmeter: truncated to last \d+ lines\]$/.test(lines[0]);
    if (lines.length > (marker ? 2 : 1)) {
      lines.splice(marker ? 1 : 0, 1);
      event.detail = lines.join('\n');
    } else if (marker && lines.length > 1) {
      const chars = Array.from(lines[1]);
      chars.shift();
      event.detail = lines[0] + '\n' + chars.join('');
    } else {
      event.detail = Array.from(event.detail).slice(1).join('');
    }
  }
  if (event.meta) {
    for (const key of Object.keys(event.meta)) {
      while (size() > 32768 && event.meta[key] && !key.startsWith('_')) {
        event.meta[key] = Array.from(event.meta[key]).slice(0, -1).join('');
      }
    }
  }
  const data = JSON.stringify(event) + '\n';
  if (Buffer.byteLength(data) > 32768) throw new Error('event exceeds spool envelope');
  return data;
}

function atomicWrite(io, destination, data, nonce, replace) {
  const temporary = destination.endsWith('.json')
    ? destination.slice(0, -5) + (nonce ? '-' + nonce : '') + '.tmp'
    : destination + '-' + nonce + '.tmp';
  let fd;
  let owned = false;
  try {
    fd = io.openSync(temporary, 'wx', 0o600);
    owned = true;
    io.writeFileSync(fd, data, 'utf8');
    try { io.fsyncSync(fd); } catch (_) { /* durability is best effort */ }
    io.closeSync(fd);
    fd = undefined;
    try {
      io.renameSync(temporary, destination);
    } catch (error) {
      // POSIX rename replaces atomically. Windows may need the documented
      // unlink-then-rename fallback when this is an upsert.
      if (!replace || !['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      try { io.unlinkSync(destination); } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      }
      io.renameSync(temporary, destination);
    }
    owned = false;
  } finally {
    if (fd !== undefined) {
      try { io.closeSync(fd); } catch (_) { /* preserve original failure */ }
    }
    if (owned) {
      try { io.unlinkSync(temporary); } catch (_) { /* flush removes stale tmp */ }
    }
  }
}

function exists(io, file) {
  try { io.statSync(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function counterLine(event) {
  const heartbeat = event.kind === 'heartbeat';
  const prefix = [heartbeat ? '-' : event.fingerprint, heartbeat ? 0 : event.fpv,
    event.agent, event.host, event.ts].join('\t') + '\t';
  const budget = 320 - Buffer.byteLength(prefix) - 1;
  if (budget < 0) throw new Error('invalid counter fields');
  const message = heartbeat ? 'kind=heartbeat' : String(event.message).replace(/[\t\r\n]+/g, ' ');
  return prefix + bytePrefix(message, budget) + '\n';
}

function appendCounter(io, pending, event, limits) {
  const file = path.join(pending, 'counters.log');
  const marker = path.join(pending, 'overflow-exceeded.json');
  const line = counterLine(event);
  function ceilingReached() {
    let size = 0;
    try { size = io.statSync(file).size; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const hard = limits.overflow_max_bytes + limits.overflow_guard_bytes;
    if (size >= limits.overflow_max_bytes || size + Buffer.byteLength(line) > hard) {
      if (!exists(io, marker)) {
        atomicWrite(io, marker, JSON.stringify({ since: event.ts }) + '\n', event.id, false);
      }
      return true;
    }
    return false;
  }
  // A second append is required only when flush unlinked our open inode.
  // Re-check the ceiling for the fresh log too.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (ceilingReached()) return { mode: 'dropped', path: marker };
    const fd = io.openSync(file, 'a', 0o600);
    let unlinked;
    try {
      const data = Buffer.from(line, 'utf8');
      const written = io.writeSync(fd, data, 0, data.length);
      if (written !== data.length) throw new Error('incomplete counter append');
      unlinked = io.fstatSync(fd).nlink === 0;
    } finally {
      io.closeSync(fd);
    }
    if (!unlinked || attempt === 1) return { mode: 'counter', path: file };
  }
}

function writeAt(home, event, limits, io) {
  const root = path.join(home, 'spool');
  const pending = path.join(root, 'pending');
  for (const name of ['pending', 'sent', 'dead']) {
    io.mkdirSync(path.join(root, name), { recursive: true, mode: 0o700 });
  }
  const entries = io.readdirSync(pending);
  const count = entries.filter(name => name.endsWith('.json') && name !== 'overflow-exceeded.json').length;
  if (count >= limits.pending_hard_limit) {
    if (event.kind === 'heartbeat') {
      const name = 'heartbeat-' + encodeURIComponent(event.agent) + '@' + encodeURIComponent(event.host) + '.json';
      const destination = path.join(pending, name);
      const heartbeats = entries.filter(entry => entry.startsWith('heartbeat-') && entry.endsWith('.json')).length;
      if (heartbeats < limits.max_heartbeat_files || exists(io, destination)) {
        atomicWrite(io, destination, serialize(event), event.id, true);
        return { mode: 'counter', path: destination };
      }
    }
    return appendCounter(io, pending, event, limits);
  }
  const mode = count >= limits.pending_soft_limit ? 'compact' : 'normal';
  if (mode === 'compact') {
    event.detail = '';
    event.meta = Object.assign({}, event.meta, { _compact: '1' });
  }
  const destination = path.join(pending, event.ts.replace(/[:.]/g, '-') + '-' + event.id + '.json');
  atomicWrite(io, destination, serialize(event), '', false);
  return { mode, path: destination };
}

// options.spool holds resolved limits. fs, tmpdir, stderr are injectable only
// through this API, never environment-driven. Caller-owned events are untouched.
function writeEvent(home, event, options = {}) {
  try {
    const io = options.fs || fs;
    const limits = Object.assign({}, DEFAULTS, options.spool);
    const copy = () => JSON.parse(JSON.stringify(event));
    try {
      return Object.assign({ ok: true, fallback: false }, writeAt(home, copy(), limits, io));
    } catch (_) {
      const fallbackEvent = copy();
      fallbackEvent.meta = Object.assign({}, fallbackEvent.meta, { _spool_fallback: '1' });
      const temporaryRoot = typeof options.tmpdir === 'function' ? options.tmpdir() : options.tmpdir || os.tmpdir();
      return Object.assign({ ok: true, fallback: true },
        writeAt(path.join(temporaryRoot, 'errmeter-spool'), fallbackEvent, limits, io));
    }
  } catch (_) {
    try {
      const stderr = options.stderr || (text => process.stderr.write(text));
      stderr('emit: local spool write failed\n');
    } catch (_) { /* emitting must never break the caller */ }
    return { ok: false, mode: 'normal', path: null, fallback: true };
  }
}

module.exports = { writeEvent };
