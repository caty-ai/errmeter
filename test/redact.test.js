'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { redact, buildMaskList, tailLines } = require('../src/redact');

test('redaction fixture pairs cover rules one through seven', () => {
  const directory = path.join(__dirname, 'fixtures/redact');
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.txt'));
  assert.ok(files.length >= 7);
  for (const file of files) {
    const input = fs.readFileSync(path.join(directory, file), 'utf8').replaceAll('{{HOME}}', os.homedir()).replaceAll('{{DASHES}}', '-----');
    assert.equal(redact(input, ['literal.$secret']), fs.readFileSync(path.join(directory, file.replace(/\.txt$/, '.expected')), 'utf8'), file);
  }
});
test('mask list reads nested credential files, lines and sensitive environment names only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-mask-'));
  try {
    const file = path.join(dir, 'credential');
    fs.writeFileSync(file, 'abcdefgh123\nijklmnop456\nshort\n');
    const masks = buildMaskList({ sink: { token_file: file }, notify: [{ headers_file: file }], deeper: { custom_file: file }, absent_file: path.join(dir, 'missing') }, { ERRMETER_GITHUB_TOKEN: 'github.private.value', MY_API_KEY: 'api.private.value', SESSION_ID: 'session-private-value', ordinary: 'ordinary-private-value', PASSWORD: 'short' });
    for (const value of ['abcdefgh123', 'ijklmnop456', 'abcdefgh123\nijklmnop456\nshort', 'github.private.value', 'api.private.value', 'session-private-value']) assert.ok(masks.includes(value));
    assert.ok(!masks.includes('short'));
    assert.ok(!masks.includes('ordinary-private-value'));
    assert.equal(new Set(masks).size, masks.length);
    const realHome = os.homedir;
    try {
      os.homedir = () => dir;
      assert.ok(buildMaskList({ secret_file: '~/credential' }, {}).includes('abcdefgh123'));
    } finally { os.homedir = realHome; }
    const cyclic = {};
    cyclic.self = cyclic;
    assert.deepEqual(buildMaskList(cyclic, {}), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('literal masks use longest-first matching and PEM wins over its masked body', () => {
  assert.equal(redact('abcdefgh123 abcdefgh123', ['abcdefgh', 'abcdefgh123', 'short']), '[REDACTED] [REDACTED]');
  assert.equal(redact(['-----BEGIN', 'PRIVATE KEY-----\nabcdefgh123\n-----END', 'PRIVATE KEY-----'].join(' '), ['abcdefgh123']), '[REDACTED PEM]');
  assert.equal(redact('token=' + 'ghp_' + 'abcdefghijklmnopqrstuvwxyz' + ' Authorization: Bearer ' + 'ghp_' + 'abcdefghijklmnopqrstuvwxyz'), 'token=[REDACTED]');
});
test('all known token families are redacted', () => {
  const tokens = ['ghp_' + 'a'.repeat(20), 'github_pat_' + 'a'.repeat(20), ...'ousr'.split('').map(c => 'gh' + c + '_' + 'a'.repeat(20)), 'sk-' + 'a'.repeat(16), ...'abprs'.split('').map(c => 'xox' + c + '-' + 'a'.repeat(10)), 'AKIA' + 'A'.repeat(16), 'AIza' + 'a'.repeat(35), '123456789:AA' + 'a'.repeat(30), 'https://hooks.slack.com/services/A/B/C', 'https://discord.com/api/webhooks/abc/xyz', 'https://discordapp.com/api/webhooks/abc/xyz'];
  for (const token of tokens) assert.equal(redact(token), '[REDACTED TOKEN]');
});
test('tail keeps final lines and marker, treating terminal newline as line ending', () => {
  assert.deepEqual(tailLines('one\ntwo\nthree\n', 2), { text: '[errmeter: truncated to last 2 lines]\ntwo\nthree\n', truncated: true });
  assert.deepEqual(tailLines('one\ntwo\n', 2), { text: 'one\ntwo\n', truncated: false });
  assert.deepEqual(tailLines('one\r\ntwo\r\nthree\r\n', 2), { text: '[errmeter: truncated to last 2 lines]\ntwo\r\nthree\r\n', truncated: true });
  assert.deepEqual(tailLines('', 2), { text: '', truncated: false });
  assert.deepEqual(tailLines('one', 0), { text: '[errmeter: truncated to last 0 lines]\n', truncated: true });
});

test('value boundaries preserve quotes, query extent and ordinary lines', () => {
  const cases = [
    ['token=abc status=200', 'token=[REDACTED]'],
    ['a=1; token=xyz; b=2', 'a=1; token=[REDACTED]; b=2'],
    ['status: 200 ok', 'status: 200 ok'],
    ['status: 200 token=abc def', 'status: 200 token=[REDACTED]'],
    ['password: "abc def, ghi" status: 200', 'password: "[REDACTED]" status: 200'],
    ["key: 'safe'; password: 'abc def, ghi'", "key: 'safe'; password: '[REDACTED]'"],
    ['password="Bearer abc def"', 'password="[REDACTED]"'],
    ['password="abc \' def"', 'password="[REDACTED]"'],
    ['password="abc\nstatus: 200 ok', 'password="[REDACTED]\nstatus: 200 ok'],
    ['Bearer abc def, status=200; ok', 'Bearer [REDACTED], status=200; ok'],
    ['?token=abc#fragment status: 200 ok', '?token=[REDACTED]#fragment status: 200 ok'],
    ['?token=abc&safe=ok status: 200 ok', '?token=[REDACTED]&safe=ok status: 200 ok'],
    ['password: abc def\r\nstatus: 200 ok', 'password: [REDACTED]\r\nstatus: 200 ok'],
    ['https://user:p@ss@host/x', 'https://[REDACTED]@host/x'],
    ['https://user:p@ss@host?x=@safe', 'https://[REDACTED]@host?x=@safe'],
    ['https://user:p@ss@host#@safe', 'https://[REDACTED]@host#@safe']
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
});

test('sensitive pairs preserve boundary behavior', () => {
  const cases = [
    ['password: "abc \\"def\\" ghi"', 'password: "[REDACTED]"'],
    ['password=', 'password=[REDACTED]'],
    ['token=one; password=two', 'token=[REDACTED]; password=[REDACTED]'],
    ['token=one&password=two', 'token=[REDACTED]&password=[REDACTED]'],
    ['status=ok password=secret', 'status=ok password=[REDACTED]'],
    ['password=sk-' + 'a'.repeat(16), 'password=[REDACTED TOKEN]']
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
});

test('redaction stays fast for 100 KiB single lines', t => {
  const bytes = 100 * 1024;
  const pairs = Array.from({ length: 2000 }, (_, index) => `k${index}=v`).join('&');
  const cases = [
    ['no sensitive key', 'status:' + 'x'.repeat(bytes - 7)],
    ['sensitive key and long value', 'password:' + 'x'.repeat(bytes - 9)],
    ['2000 query pairs', '?' + pairs + '&padding=' + 'x'.repeat(bytes - pairs.length - 10)]
  ];
  for (const [name, input] of cases) {
    assert.equal(Buffer.byteLength(input), bytes, name);
    const start = process.hrtime.bigint();
    redact(input);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    t.diagnostic(`${name}: ${elapsedMs.toFixed(3)} ms`);
    assert.ok(elapsedMs < 500, `${name} took ${elapsedMs.toFixed(3)} ms`);
  }
});
