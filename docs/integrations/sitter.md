# sitter failures

Insert this line in `~/.claude/scripts/sitter-on-fail.sh` after the JSONL append and before ask routing; the identical snippet is in `tools/host-hooks/examples/sitter-on-fail.snippet.sh`:

```bash
errmeter emit --agent "sitter/${SITTER_AGENT:-unknown}" --message "${SITTER_EVENT:-fail}: ${SITTER_REASON:-}" --task "${SITTER_TASK:-}" --meta "run_id=${SITTER_RUN_ID:-}" --meta "project=${SITTER_PROJECT:-}" --detail - <<<"$payload" 2>/dev/null || true
```

The host hook reads a JSON payload on stdin and receives `SITTER_*` identity variables. Its contract always exits 0: `|| true` protects sitter's hook-failure quarantine counter from a missing executable or usage error. The payload goes to `--detail -`, where emit redacts and bounds it. Emit also redacts reason, task, and metadata; keep those identity fields free of credentials. Unlike the fixed-message Claude/Codex adapters, this requested sitter line intentionally uses the existing reason. `--tail` can override the default last 40 lines.

`~/.claude/scripts/sitter-run` already presets `--on-fail` to `~/.claude/scripts/sitter-on-fail.sh` (override with `SITTER_ON_FAIL`), so installing the insertion covers its callers. Families without that preset can use:

```bash
sitter run --agent codex --task nightly --on-fail "$HOME/.claude/scripts/sitter-on-fail.sh" -- codex exec 'Run the scheduled checks'
```

For a brief file, redirect inside the wrapped shell: sitter does not forward its own stdin to the child. Use the heartbeat integrations for successful runs and silence; `--on-fail` alone is not a success heartbeat.
