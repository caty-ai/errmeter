'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { readFileSync } = fs;
const os = require('node:os');
const { createHash } = require('node:crypto');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const checker = path.join(root, 'tools/check_publication_gate.py');
const expectedHash = 'e70ed4d7684a774572194c36b2d2a5281a372b36eb6a001f8cfccf0486578c24';

function runPython(t, args) {
  const result = spawnSync('python3', ['-B', checker, ...args], {
    cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024
  });
  if (result.error && result.error.code === 'ENOENT') {
    t.skip('python3 is absent; install Python 3.9+ to run the publication gate');
    return;
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

// The gate scans the tree that gets published: the tracked files, with their working-copy
// content. A snapshot keeps the scan deterministic while other test files create and remove
// temporary fixtures under the repository in parallel.
function walk(base, rel) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
    if (['.git', 'node_modules', '.omx', '.omc', '.readme-work'].includes(entry.name)) continue;
    const child = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out.push(...walk(base, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

function trackedSnapshot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errmeter-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const list = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  // Exported source trees (git archive, npm tarball, zip download) have no .git: walk the tree instead,
  // skipping only the directories that never hold published content.
  const files = list.status === 0
    ? list.stdout.split('\0').filter(Boolean)
    : walk(root, '');
  for (const rel of files) {
    let data;
    try { data = readFileSync(path.join(root, rel)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  return dir;
}

test('publication gate accepts the tracked repository tree', (t) => {
  const dir = trackedSnapshot(t);
  assert.ok(fs.existsSync(path.join(dir, 'README.md')), 'README.md must be tracked');
  runPython(t, ['--root', dir, '--account-slug', 'shojikumaru', '--no-registry']);
});

test('publication gate embedded self-tests pass', (t) => {
  const help = runPython(t, ['--help']);
  if (help === undefined) return;
  assert.match(help, /--selftest/);
  runPython(t, ['--selftest']);
});

test('publication denylist is non-empty', () => {
  const policy = readFileSync(path.join(root, '.publication-denylist'), 'utf8');
  assert.ok(policy.split(/\r?\n/).some((line) => line.trim() && !line.startsWith('#')));
});

test('publication gate matches the canonical vendored bytes', () => {
  assert.equal(createHash('sha256').update(readFileSync(checker)).digest('hex'), expectedHash);
});
