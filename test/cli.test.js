'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const { parse, UsageError } = require('../src/cli');
const { resolveConfig, DEFAULTS } = require('../src/config');
const bin = path.resolve(__dirname, '../bin/errmeter.js');

test('parser accepts both flag spellings, repeated metadata, and zero tail', () => {
  const args = parse(['--message=a=b', '--agent', 'Nora', '--meta=x=y=z', '--meta', 'empty=', '--tail=0', '--no-flush', '--json', '--quiet']);
  assert.equal(args.message, 'a=b'); assert.equal(args.meta.x, 'y=z');
  assert.equal(args.meta.empty, ''); assert.equal(args.tail, 0); assert.equal(args.agent, 'Nora');
});
test('invalid flags, kind, meta and tail are usage errors', () => {
  const cases = [['--wat'], ['--message'], ['--message', '--json'], ['--kind=bogus'],
    ['--tail=-1'], ['--tail=1.5'], ['--tail=9007199254740992'], ['--tail=NaN'],
    ['--meta=_private=x'], ['--meta=a b=x'], ['--meta=bad'], ['--meta=' + 'k'.repeat(33) + '=x'],
    ['--detail=x'], ['--detail=-', '--detail-file=x'], ['--json=true'], ['--home='], ['positional']];
  for (const args of cases) assert.throws(() => parse(['--message=x', ...args]), UsageError);
  assert.throws(() => parse([]), UsageError);
  assert.throws(() => parse(['--message=x', ...Array(17).fill('--meta=x=y')]), UsageError);
  assert.equal(parse(['--kind=heartbeat']).kind, 'heartbeat');
  assert.equal(parse(['--message=']).message, '');
});
test('entry help, version, flush stub and unknown commands have prescribed codes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-cli-'));
  const env = { ...process.env, ERRMETER_HOME: dir };
  delete env.ERRMETER_CONFIG;
  try {
    for (const args of [[], ['--help'], ['emit', '--help']]) {
      const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env });
      assert.equal(result.status, 0); assert.match(result.stdout, /Usage:/); assert.match(result.stdout, /Values starting with -- must be passed as --flag=value/); assert.equal(result.stderr, '');
    }
    const version = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', env });
    assert.equal(version.stdout.trim(), require('../package.json').version); assert.equal(version.status, 0);
    for (const [args, code] of [[['flush'], 3], [['bogus'], 2], [['emit', '--kind=bogus', '--message=x'], 2]]) {
      const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env });
      assert.equal(result.status, code); assert.equal(result.stdout, '');
      assert.equal(result.stderr.trim().split('\n').length, 1);
      if (args[0] === 'flush') assert.equal(result.stderr.trim(), 'flush: invalid configuration');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('version guard executes before loading any module on old Node', () => {
  let error = ''; let status;
  const stop = new Error('stop');
  assert.throws(() => vm.runInNewContext(fs.readFileSync(bin, 'utf8'), {
    process: { versions: { node: '16.20.0' }, stderr: { write: text => { error += text; } }, exit: code => { status = code; throw stop; } },
    require: () => assert.fail('loaded module before guard')
  }), value => value === stop);
  assert.equal(status, 2); assert.equal(error.trim().split('\n').length, 1);
});
test('home/config precedence, silent invalid configs, all spool defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-config-'));
  try {
    const cfg = path.join(dir, 'settings.json');
    fs.writeFileSync(cfg, JSON.stringify({ agent: 'config-agent', spool: { tail_lines: 3, pending_hard_limit: 4, detail_max_bytes: -1 } }));
    const loaded = resolveConfig({ home: dir, config: cfg }, { ERRMETER_HOME: '/ignored', ERRMETER_CONFIG: '/ignored' });
    assert.equal(loaded.home, dir); assert.equal(loaded.config.agent, 'config-agent');
    assert.equal(loaded.config.spool.tail_lines, 3); assert.equal(loaded.config.spool.detail_max_bytes, 8192);
    assert.equal(resolveConfig({}, { ERRMETER_HOME: dir, ERRMETER_CONFIG: cfg }).configPath, cfg);
    for (const invalid of ['{', 'null', '[]']) {
      fs.writeFileSync(cfg, invalid);
      assert.deepEqual(resolveConfig({ home: dir, config: cfg }, {}).config.spool, DEFAULTS);
    }
    assert.equal(resolveConfig({}, {}).home, path.join(os.homedir(), '.errmeter'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
