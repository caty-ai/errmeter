# Integrations

Start with [the fma job-heartbeat integration](fma-job-heartbeat.md) (a sibling project that writes per-job heartbeat files): one patch covers existing fma jobs on every host, including successful runs and silence. Registration-gap checks belong to fma; errmeter observes their check job too.

| Source | Integration | Use when |
| --- | --- | --- |
| sitter failures/stalls | [sitter --on-fail](sitter.md) | A process is supervised by sitter |
| Agent hooks | [Claude Code](claude-code.md), [Codex](codex.md) | Interactive sessions need failure/turn-end reporting |
| cron / launchd jobs | [job wrappers](cron.md) | A scheduled command needs exit-status reporting |
| Liveness | [heartbeats](heartbeat.md) | Detect an agent or host going silent |

Host-hook tools require Bash (including macOS 3.2) and Node 18+, with zero npm dependencies. From this checkout, run `bash tools/host-hooks/errmeter-hooks-install.sh --all` to preview, then add `--apply`. Select only `--sitter`, `--claude-code`, or `--codex` as needed. Every changed destination is backed up before writing under `~/.errmeter/backups/<timestamp>/manifest.json`; original bytes are base64-encoded and originally absent files are recorded. `errmeter-hooks-restore.sh [--from <timestamp>]` restores the newest installation backup by default, saving replaced bytes in a separate restore backup. Restore removes only hook files recorded as originally absent. When restore removes the final hook file, it also removes the emptied `~/.errmeter/hooks/` directory. Review the backup before restoring after unrelated host edits. The installer never edits fma. Dry-run previews collapse the absolute `$HOME` path to `~` through preview redaction, while written files use absolute paths.

`errmeter-hooks-status.sh` reports installed / not installed / drifted, errmeter on PATH, and a local `errmeter status` summary. It checks each integration by its own marker or entry plus the shipped hook file, so an unrelated edit elsewhere in `settings.json`, the sitter script, or Codex config remains `installed` with the note `unrelated local edits present`. A modified errmeter-owned entry, marker block, or hook file is `drifted`; an integration with none of its owned content present is `not installed`. Exit codes: 0 all inspected targets are installed, 1 at least one inspected target is not installed or drifted (also used when only some targets cannot be inspected), 2 usage, 3 every target failed inspection. Unsupported notify TOML formats fail without writing; use a single-line JSON-compatible string array. Existing config content, including `hooks = true`, remains unchanged except the notify line or inserted JSON hook entries. JSON is validated and edited through `node -e`, retaining original whitespace and all other bytes.

Use `<agent>` as the emitter identity. Names are lower-cased and must fit `[a-z0-9._/-]{1,64}`. The board composite identity is `<agent>@<host>`; `@` is **not** in the literal `--agent` charset, despite the per-host shorthand in contract §2.1. For separate per-host error fingerprints, use a legal name such as `agent/host`; ordinary heartbeat Issues already separate host records. `--meta` accepts at most 16 entries, keys `[A-Za-z0-9_.-]{1,32}`, values at most 256 characters, and no `_`-prefixed keys. Values and detail pass emit redaction; never deliberately put credentials in message or metadata.

`emit` returns 0 after the spool write and does not fail for invalid config or transport failure; 2 means usage error. Success does not prove delivery (or successful persistence if all spool locations fail). In shell, a bare `job || errmeter emit ...` changes the **compound command** status to the emit status, even though it cannot alter the already completed job status. Preserve `$?` explicitly as shown in [cron](cron.md). fma `run-with-heartbeat` and the plain wrapper pass the wrapped exit code through unchanged.

## Repair boundary (D-6)

A repair hook MAY open PRs and comment with its own credentials. It MUST NOT merge, push protected branches, or close the inbox Issue. Errmeter credentials have no repository content/PR authority and must not be used for these repair operations; the watcher owns its separate inbox lifecycle. An Issues-write token technically can close Issues (including init permission probes), so this is an enforced responsibility boundary, not a claim that GitHub can remove that individual permission. Hooks run as the watcher's OS user and can read anything that user can read. Families requiring isolation run `errmeter watch --role watcher` under a dedicated OS user with separately scoped repair credentials.

## Not done by this change

This checkout does not apply the host-side changes, apply or commit the fma patch, or confirm live inbox heartbeats. Perform those operational steps on each host. From the errmeter checkout, run:

```bash
bash tools/host-hooks/errmeter-hooks-install.sh --all --apply
git -C /path/to/family-memory-architecture apply /path/to/errmeter/tools/host-hooks/examples/job-heartbeat.patch
git -C /path/to/family-memory-architecture add scripts/job-heartbeat
git -C /path/to/family-memory-architecture commit
errmeter status --check
```

Record the live result using this template; run `errmeter status --check` on every listed host before marking its heartbeat as seen.

| agent | host | connected path | heartbeat seen |
| --- | --- | --- | --- |
| `<agent>` | `<host>` | `<hook, wrapper, or fma job-heartbeat>` | `yes / no` |
