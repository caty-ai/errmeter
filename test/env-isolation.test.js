'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cleanEnv } = require('./fixtures/env');

test('cleanEnv strips inherited ERRMETER_* without mutating process.env and applies overrides last', t => {
  const keys = ['ERRMETER_CONFIG', 'ERRMETER_GITHUB_TOKEN', 'ERRMETER_HOME', 'errmeter_config'];
  const original = keys.map(key => process.env[key]);
  t.after(() => {
    keys.forEach((key, index) => {
      if (original[index] === undefined) delete process.env[key];
      else process.env[key] = original[index];
    });
  });
  for (const key of keys) process.env[key] = 'inherited-test-value';
  const before = Object.assign({}, process.env);
  const env = cleanEnv();
  assert.deepEqual(Object.keys(env).filter(key => key.toUpperCase().startsWith('ERRMETER_')), []);
  assert.equal(env.PATH, before.PATH);
  assert.equal(cleanEnv({ ERRMETER_HOME: '/x' }).ERRMETER_HOME, '/x');
  assert.deepEqual(Object.assign({}, process.env), before);
});

test('test env builders never spread process.env directly', () => {
  const offenders = [];
  for (const dir of ['test', 'test/sinks']) {
    const absolute = path.join(__dirname, '..', dir);
    for (const name of fs.readdirSync(absolute).sort()) {
      if (!name.endsWith('.test.js') || path.join(absolute, name) === __filename) continue;
      fs.readFileSync(path.join(absolute, name), 'utf8').split('\n').forEach((line, index) => {
        if (/\.\.\.process\.env\b/.test(line)) offenders.push(`${dir}/${name}:${index + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, [], `Raw process.env spreads must use cleanEnv:\n${offenders.join('\n')}`);
});
