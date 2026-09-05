'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { normalize, fingerprint, FPV } = require('../src/fingerprint');
const vectors = require('./fixtures/fingerprint.json');

test('all nine normative fingerprint vectors and hash shape', () => {
  assert.equal(vectors.length, 9);
  assert.equal(FPV, 1);
  for (const { message, normalized } of vectors) {
    assert.equal(normalize(message), normalized);
    assert.equal(fingerprint('a', message), createHash('sha256').update('a\n' + normalized).digest('hex').slice(0, 16));
    assert.match(fingerprint('a', message), /^[0-9a-f]{16}$/);
  }
});
test('fingerprint depends on agent and preserves small error codes and quoted keys', () => {
  assert.notEqual(fingerprint('a', 'error 404'), fingerprint('b', 'error 404'));
  assert.notEqual(fingerprint('a', vectors[0].message), fingerprint('a', vectors[1].message));
  assert.notEqual(fingerprint('a', vectors[4].message), fingerprint('a', vectors[5].message));
  assert.equal(normalize('  ERROR\n  123 1234 0xCAFE abcdef123456 550e8400-e29b-41d4-a716-446655440000'), 'error 123 # #hex# #hex# #uuid#');
  assert.equal(normalize('x'.repeat(300)), 'x'.repeat(200));
  assert.equal(normalize('at C:\\opt\\app\\x.js:12:3'), 'at #path#:#');
});
