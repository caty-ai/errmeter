# Codex

The local Codex notify contract supplies a JSON event as the final program argument at turn end; it is not a per-tool-failure hook. Two paths cover different needs:

1. Wrap `codex exec` in `sitter-run` for reliable process-exit/stall reporting; see [sitter](sitter.md).
2. Use `tools/host-hooks/examples/codex-notify-emit.sh` for a turn-end heartbeat and best-effort failure detection.

The inspected config already uses a notify wrapper with a `--previous-notify` argument containing an encoded argv array. Preserve the **whole current array**, including that wrapper and its arguments. The host-hook installer reads it rather than assuming any specific program. A portable example is:

```toml
notify = ["bash", "/absolute/path/to/.errmeter/hooks/codex-notify-emit.sh", "--previous-notify", "[\"node\",\"/absolute/path/to/previous-notify.js\"]"]
```

Use the actual absolute home path when configuring manually: TOML does not expand `$HOME`. The installer requires a single-line JSON-compatible TOML string array; it refuses unsupported syntax rather than guessing. Existing `hooks = true` is preserved, not used as evidence of a per-tool-failure callback.

The adapter calls the previous argv without shell evaluation, appending the original JSON event, with a 30-second timeout. It then emits `--kind heartbeat --agent "codex/${USER}"`. Event `type` containing fail/error, or `last-assistant-message` containing failed/failure/uncaught/fatal error, triggers the fixed message `Codex turn reported failure`, with the original event only in `--detail -`. This is best-effort: prose about a repaired failure can be a false positive, and a failure described differently can be missed. Use sitter for dependable process supervision.

The adapter always exits 0, including malformed JSON and missing emit. `ERRMETER_HOOKS_DISABLE=1` disables errmeter reporting but still chains to the previous notify command. It does not install any new Codex per-tool hook.
