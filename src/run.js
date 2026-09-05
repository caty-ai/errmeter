'use strict';

const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { parseRun } = require('./cli');
const { atomicState } = require('./dispatch');

function recordPids(file, pid, runnerPid) {
  atomicState(file, state => ({ ...state, pid, runner_pid: runnerPid }));
}

function run(argv, io = {}) {
  let flags;
  try { flags = parseRun(argv); } catch (_) { return Promise.resolve(125); }
  const wall = io.clock || Date.now;
  const mono = io.monotonic || (() => Number(process.hrtime.bigint()) / 1e6);
  const schedule = io.setTimeout || setTimeout;
  const cancel = io.clearTimeout || clearTimeout;
  const launch = io.spawn || spawn;
  const kill = io.kill || process.kill.bind(process);
  const platform = io.platform || process.platform;
  const stdin = io.stdin || process.stdin;
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const signals = io.signals || process;
  let deadlineWall = flags['deadline-ms'];
  let deadlineMono = mono() + flags['deadline-mono-ms'];
  let deadlineGeneration = 0;
  const timeoutMono = mono() + flags.timeout * 1000;
  if (Math.min(deadlineWall - wall(), deadlineMono - mono(), timeoutMono - mono()) <= 0) return Promise.resolve(124);

  return new Promise(resolve => {
    let child;
    let deadlineTimer;
    let stateTimer;
    let killTimer;
    let stopping = false;
    let finished = false;
    let stopCode = 124;
    const relays = [];

    function finish(code) {
      if (finished) return;
      finished = true;
      cancel(deadlineTimer); cancel(stateTimer); cancel(killTimer);
      signals.removeListener('SIGTERM', stop);
      signals.removeListener('SIGINT', stop);
      if (child && child.stdin) stdin.unpipe(child.stdin);
      stdin.pause();
      stdin.removeListener('error', inputError);
      for (const { source, target, onError } of relays) {
        source.unpipe(target);
        target.removeListener('error', onError);
        source.resume();
      }
      resolve(code);
    }
    function inputError() { if (child && child.stdin) child.stdin.end(); }
    function relay(source, target) {
      // A dead watcher closes these pipes. Drain hook output so its fence still runs.
      const onError = () => { source.unpipe(target); source.resume(); };
      target.on('error', onError);
      source.on('error', () => {});
      source.pipe(target, { end: false });
      relays.push({ source, target, onError });
    }
    function groupSignal(signal) {
      try { kill(-child.pid, signal); return true; }
      catch (error) { return error.code !== 'ESRCH'; }
    }
    function stop() {
      if (stopping || finished) return;
      stopping = true;
      cancel(deadlineTimer); cancel(stateTimer);
      if (!child || !child.pid) { finish(stopCode); return; }
      if (platform === 'win32') {
        try {
          const killer = launch('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => { try { child.kill('SIGKILL'); } catch (_) {} finish(stopCode); });
          killer.once('close', () => finish(stopCode));
        } catch (_) { try { child.kill('SIGKILL'); } catch (_) {} finish(stopCode); }
      } else {
        if (!groupSignal('SIGTERM')) { finish(stopCode); return; }
        // Keep the runner alive even if the direct child exits: descendants can ignore TERM.
        killTimer = schedule(() => { groupSignal('SIGKILL'); finish(stopCode); }, 10000);
      }
    }
    function checkDeadline() {
      if (finished || stopping) return;
      const remaining = Math.min(deadlineWall - wall(), deadlineMono - mono(), timeoutMono - mono());
      if (remaining <= 0) { stop(); return; }
      // Bound checks so wall-clock jumps and suspend/resume are noticed promptly.
      deadlineTimer = schedule(checkDeadline, Math.min(remaining, 1000));
    }
    function refresh() {
      if (finished || stopping) return;
      // An already expired lease must never be revived by a late state read.
      if (Math.min(deadlineWall - wall(), deadlineMono - mono(), timeoutMono - mono()) <= 0) { stop(); return; }
      try {
        const state = JSON.parse(fs.readFileSync(flags.state, 'utf8'));
        const generation = Number.isSafeInteger(state?.deadline_generation) && state.deadline_generation >= 0 ?
          state.deadline_generation : deadlineGeneration;
        if (state && Number.isFinite(state.deadline_ms) &&
            (generation > deadlineGeneration || state.deadline_ms > deadlineWall)) {
          deadlineWall = state.deadline_ms;
          deadlineGeneration = generation;
          deadlineMono = mono() + Math.max(0, deadlineWall - wall());
          cancel(deadlineTimer);
          checkDeadline();
        }
      } catch (_) { /* missing or invalid state never changes the active fence */ }
      if (!finished && !stopping) stateTimer = schedule(refresh, 5000);
    }

    signals.on('SIGTERM', stop); signals.on('SIGINT', stop);
    stdin.on('error', inputError);
    try {
      child = launch(flags.command[0], flags.command.slice(1), {
        shell: false, detached: platform !== 'win32', windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'], env: io.env || process.env
      });
      child.once('error', () => finish(125));
      child.once('close', (code, signal) => {
        if (stopping) {
          if (platform !== 'win32' && !groupSignal(0)) finish(stopCode);
          return;
        }
        finish(Number.isInteger(code) ? code : 128 + (os.constants.signals[signal] || 1));
      });
      child.stdin.on('error', () => { stdin.unpipe(child.stdin); stdin.resume(); });
      relay(child.stdout, stdout); relay(child.stderr, stderr);
      if (child.pid) recordPids(flags.state, child.pid, io.pid || process.pid);
      stdin.pipe(child.stdin);
      checkDeadline();
      stateTimer = schedule(refresh, 5000);
    } catch (_) {
      stopCode = 125;
      stop();
    }
  });
}

function main(argv) {
  process.stdout.on('error', () => {}); process.stderr.on('error', () => {});
  return run(argv).then(code => { process.exitCode = code; }, () => { process.exitCode = 125; });
}

module.exports = { run, main };
