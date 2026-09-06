# Claude Code

Copy `tools/host-hooks/examples/claude-code-emit.sh` to `~/.errmeter/hooks/claude-code-emit.sh`. Merge these entries into the existing `hooks` object in `~/.claude/settings.json` (the host-hook installer does this without replacing other settings):

```json
{
  "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bash \"$HOME/.errmeter/hooks/claude-code-emit.sh\"" }] }],
  "SessionEnd": [{ "hooks": [{ "type": "command", "command": "bash \"$HOME/.errmeter/hooks/claude-code-emit.sh\" --heartbeat" }] }]
}
```

The script captures complete stdin in a private temporary file, parses JSON from that file, and streams the whole file to emit before redaction/tailing. It removes the temporary file on exit and emits `--agent "claude-code/${USER}" --message "<tool_name> failed" --detail -`. Known tool names become short fixed labels; unknown or malformed payloads use `tool failed`. The entire payload, including `error`, stays in redacted detail. UUID-shaped `session_id` becomes `--meta session=...`; emit treats the session key as sensitive and redacts its value. Arbitrary tool/session strings are never promoted into message/meta. Malformed JSON and missing errmeter do not fail the host hook: it always exits 0.

Set `ERRMETER_HOOKS_DISABLE=1` in the agent environment to opt out for expected tool failures or when sitter already reports the same failure. `StopFailure` can use the same failure command if desired, with a generic label when no tool name exists. The installer registers only `PostToolUseFailure`; the `SessionEnd` entry above is an optional manual addition.

For livelier reporting, use a `Stop` hook with the `--heartbeat` command instead of `SessionEnd`. Per-stop heartbeats are chatty but cheap on the board because they upsert one Issue per agent/host; local events and transport still cost work. Session-end reporting is quieter but does not prove an active session is still running. Neither substitutes for the host watch loop.
