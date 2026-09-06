# cron and launchd jobs

Prefer fma `scripts/run-with-heartbeat <job> -- <cmd>` wherever available. Once the [stage-1 patch](fma-job-heartbeat.md) is applied, its standard heartbeat file also reaches errmeter. The wrapper preserves the wrapped exit status and records duration; its signal forwarding covers child process groups.

A simple failure tail is useful for one-off commands, but preserve the command status explicitly:

```bash
your-job || { rc=$?; errmeter emit --agent nightly --message "exit $rc" --task nightly || true; exit "$rc"; }
```

The bare `your-job || errmeter emit ...` form reports but leaves the shell compound command successful after emit returns 0. Do not use that form when the scheduler needs the original failure status. Missing config never causes emit to fail; usage errors return 2, and a missing executable is a shell failure. `|| true` protects the saved-status path from either.

Without fma, use:

```bash
bash tools/host-hooks/examples/with-errmeter.sh nightly -- your-job --option
```

This plain Bash equivalent uses `set -uo pipefail`, without `-e`, runs the command, saves its exit code, and emits a heartbeat on 0 or `--kind error --message "exit <code>" --detail-file <captured stderr tail>` otherwise. It replays stderr after completion and passes the complete captured stderr to emit with `--tail=40`, so redaction runs before the last 40 lines are retained; stdout remains live. Temporary capture uses the OS temp directory and is removed on exit. Long-running noisy jobs need adequate temporary disk space. The original job status is returned even when errmeter is absent or fails. Configure PATH explicitly for cron/launchd so Node and errmeter can be found. For a literal crontab line, escape `%` where applicable; these examples contain none.
