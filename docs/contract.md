# errmeter contract (v1) — FROZEN INTERFACES

Status: **freeze candidate** for issue #2. Once the owner approves, every section marked **[frozen]** may change only through a new contract issue that bumps the relevant version field. Sections marked **[default]** are tunable defaults that implementations MUST honour but families MAY override in config.

Companions: [requirements.md](requirements.md), [architecture.md](architecture.md). Requirement ids (`R-*`, `N-*`) and decision ids (`D-*`) refer to those files.

Wording: MUST / MUST NOT / SHOULD / MAY as in RFC 2119. "Reader" = any code that consumes a format; "writer" = code that produces it.

---

## 1. Versioning and freeze rules [frozen]

- `schema` (event), `config.schema` (config file), and the board marker prefix `errmeter:` are the three versioned surfaces. All are integers or fixed strings; there are no semver ranges inside the contract.
- Readers MUST ignore unknown fields. Readers MUST NOT drop data whose version is *higher* than they understand; they deliver it verbatim and annotate (event → board with note; config → refuse to start with a clear message, since acting on a config you cannot read is unsafe).
- Adding an optional field is not a version bump. Renaming, removing, changing a type, or changing a default that affects the board layout is a bump.
- Anything not described here is undefined behaviour and MUST NOT be relied on by another module.

---

## 2. Event schema [frozen] (D-1)

One event = one JSON object, UTF-8, no BOM, newline-terminated when written to a file.

```json
{
  "schema": 1,
  "id": "6f1c2a3e-9b0d-4c7a-8e21-0f4b9d2c1a55",
  "ts": "2026-09-05T13:07:41.213Z",
  "kind": "error",
  "agent": "nora",
  "host": "vps-1",
  "family": "kumaru",
  "task": "x-collector nightly publish",
  "message": "TypeError: Cannot read properties of undefined (reading 'id')",
  "detail": "... last 40 lines, redacted ...",
  "fingerprint": "a3f9c2e17b04d8e6",
  "meta": { "pr": "https://github.com/x/y/pull/12", "run_id": "sitter-20260905-1307" },
  "emitter": "errmeter/1.0.0",
  "attempts": 0
}
```

| field | type | required | writer | rules |
|---|---|---|---|---|
| `schema` | integer | yes | emit | `1` for this contract. |
| `id` | string | yes | emit | UUID v4 (`crypto.randomUUID()`). Globally unique; the idempotency key for the sink. |
| `ts` | string | yes | emit | ISO 8601 UTC with milliseconds, `Z` suffix. Time of emit, not of the underlying failure. |
| `kind` | `"error"` \| `"heartbeat"` | yes | emit | Closed enum. Anything else is a usage error at emit and a `dead/` event at flush. |
| `agent` | string | yes | emit | `[A-Za-z0-9._/-]{1,64}`. Logical name. Source: `--agent` > `ERRMETER_AGENT` > config `agent` > `"unknown"`. Watchers use `watcher/<watcher_id>`. |
| `host` | string | yes | emit | `[A-Za-z0-9._-]{1,64}`. Source: config `host` > `os.hostname()` (lower-cased, domain stripped). |
| `family` | string | no | emit | From config. Free text ≤ 64. Informational only (X-5). |
| `task` | string | no | emit | ≤ 200 chars after redaction. What the agent was doing. |
| `message` | string | yes for `error`; MAY be empty for `heartbeat` | emit | First line of the failure. ≤ 500 chars after redaction; single line (CR/LF replaced by space). |
| `detail` | string | no | emit | Redacted tail. ≤ `detail_max_bytes` (8192) after redaction; newlines preserved. Truncation marks with a leading line `[errmeter: truncated to last N lines]`. |
| `fingerprint` | string | yes for `error`; absent for `heartbeat` | emit | 16 lowercase hex chars, see §2.1. |
| `meta` | object | no | emit | String keys `[A-Za-z0-9_.-]{1,32}`, string values ≤ 256 chars, ≤ 16 entries. Values pass the redactor. Keys starting with `_` are reserved for errmeter (`_spool_fallback`, `_folded`). |
| `emitter` | string | yes | emit | `errmeter/<package version>`. |
| `attempts` | integer | yes | emit (0), flush (increments) | Delivery attempts so far. The only field flush may rewrite in a pending file. |

Size cap for the whole serialized event: **32 KiB**. emit MUST shrink `detail` first, then `meta` values, to fit.

### 2.1 Fingerprint [frozen]

```
normalized = message
  .toLowerCase()
  .replace(/0x[0-9a-f]+/g, "#")             // hex literals
  .replace(/[0-9a-f]{8,}/g, "#")            // long hex ids / hashes
  .replace(/\d+/g, "#")                     // any number
  .replace(/(["'`]).*?\1/g, "$1#$1")        // quoted strings
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 200)
fingerprint = sha256(agent + "\n" + normalized).hex.slice(0, 16)
```

`host` is deliberately **not** part of the fingerprint: the same error on two hosts is one problem. `task` is not part either. Families that want per-host Issues put the host in `agent` (`nora@vps-1`).

### 2.2 Heartbeat events

Same object with `kind: "heartbeat"`, no `fingerprint`, `message` MAY be a short status (`"idle"`, `"run 42 ok"`), `detail` SHOULD be empty. `meta.role` = `"watcher"` for watcher heartbeats (used by the dead-man check), otherwise absent.

---

## 3. Spool format and locations [frozen] (D-2)

Home: `ERRMETER_HOME` → else `path.join(os.homedir(), ".errmeter")`. Same on macOS, Linux, Windows.

| path | content |
|---|---|
| `spool/pending/<ts>-<id>.json` | one event; `<ts>` = `ts` with `:` and `.` replaced by `-` (sortable, filesystem-safe), `<id>` = event id |
| `spool/pending/*.tmp` | in-flight writes; readers ignore; older than 60 s = garbage, flush deletes |
| `spool/sent/<same name>` | delivered; moved here by flush after the sink confirmed; deleted after `sent_retention_days` |
| `spool/dead/<same name>` | refused by the sink as unprocessable (bad JSON, unknown `kind`) or evicted by `pending_hard_limit`; deleted after `dead_retention_days` |
| `spool/flush.lock` | JSON `{ "pid": 123, "ts": "...", "host": "..." }`; created with `wx` flag (exclusive). A lock older than `lock_stale_sec` MAY be deleted by the next flush. |

Write protocol (emit): serialize → write `<name>.tmp` → `fsync` (best effort; ignore errors) → `rename` to `<name>.json`. Never open the final name for writing.

Read protocol (flush): `readdir` `pending/`, ignore `.tmp`, sort by name (= by time), process oldest first, up to `max_events_per_pass`. A file that fails `JSON.parse` goes to `dead/`.

Fallback: if the home is unwritable, emit uses `path.join(os.tmpdir(), "errmeter-spool")` with the same layout and sets `meta._spool_fallback = "<original path>"`. flush drains both.

Limits [default]: `detail_max_bytes` 8192 · `tail_lines` 40 · `pending_soft_limit` 5000 (warn) · `pending_hard_limit` 20000 (evict oldest → dead) · `sent_retention_days` 7 · `dead_retention_days` 30 · `lock_stale_sec` 600 · `max_events_per_pass` 500.

---

## 4. Redaction [frozen]

Applied by emit to `task`, `message`, `detail`, and every `meta` value; applied again by flush to the same fields before egress (defence in depth). Order matters; each rule replaces with the literal shown.

| # | rule | replacement |
|---|---|---|
| 1 | Any string in the runtime mask list (the loaded board token, notify secrets, values of env vars whose name matches rule 4) | `[REDACTED]` |
| 2 | PEM blocks: `-----BEGIN [A-Z ]*PRIVATE KEY-----` … `-----END [A-Z ]*PRIVATE KEY-----` (multi-line) | `[REDACTED PEM]` |
| 3 | Known token shapes: `ghp_[A-Za-z0-9]{20,}`, `github_pat_[A-Za-z0-9_]{20,}`, `gho_`/`ghu_`/`ghs_`/`ghr_` + 20+, `sk-[A-Za-z0-9_-]{16,}`, `xox[abprs]-[A-Za-z0-9-]{10,}`, `AKIA[0-9A-Z]{16}`, `AIza[0-9A-Za-z_-]{35}`, `[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}` (Telegram bot) | `[REDACTED TOKEN]` |
| 4 | `key=value` / `key: value` / `"key": "value"` where key matches `/(token|secret|password|passwd|pwd|api[_-]?key|auth|bearer|cookie|session)/i` | key kept, value → `[REDACTED]` |
| 5 | `Authorization: <scheme> <value>` headers and `Bearer <value>` | `Authorization: [REDACTED]` / `Bearer [REDACTED]` |
| 6 | URL userinfo `scheme://user:pass@host` and query params named as in rule 4 | `scheme://[REDACTED]@host`, `?key=[REDACTED]` |
| 7 | Home directory paths: the literal `os.homedir()` (and `%USERPROFILE%` form on Windows) | `~` |
| 8 | Tail: keep only the last `tail_lines` lines of `detail` | prepend `[errmeter: truncated to last N lines]` |

Redaction MUST be pure and deterministic (same input → same output) so tests can pin it. The redactor never logs what it removed.

---

## 5. Sink adapter interface [frozen]

A sink is a module exporting an object with the following async functions. All take `ctx` first: `{ config, log, http, now }`. All throw on transport failure (flush retries); they return `{ skipped: true }` for idempotent no-ops.

```js
// delivery (used by flush)
deliverHeartbeat(ctx, event)                 // → { ref }            upsert the per-agent liveness record
deliverFailureGroup(ctx, group)              // → { ref, created }   group = { fingerprint, events: [oldest..newest], count }
// board reads/writes (used by watch; a sink that is not a board throws NotABoard)
listOpenFailures(ctx)                        // → [ IssueSummary ]
getFailure(ctx, ref)                         // → IssueDetail (with claim comments)
claim(ctx, ref, { watcherId, expiresAt })    // → { won: bool, claimRef }
renewClaim(ctx, ref, { watcherId, expiresAt })
releaseClaim(ctx, ref, { watcherId })
writeOutcome(ctx, ref, outcome)              // outcome = { status: "repaired"|"dispatch-failed"|"needs-human", summary, url? }
listHeartbeats(ctx)                          // → [ { agent, host, role?, lastSeen (ISO), ref } ]
upsertAlert(ctx, alert)                      // alert = { key, title, body, mention? } ; dedup by key
```

Idempotency keys the sink MUST honour: event `id` (never two board writes for one id), `fingerprint` (never two open failure records for one fingerprint), alert `key` (one open alert record per key).

`ref` is opaque to callers (for `github-issue` it is the Issue number; for `file` it is a line offset; for `webhook` it is the response id or `null`).

### 5.1 `github-issue` sink board layout [frozen]

| thing | value |
|---|---|
| Failure Issue title | `[errmeter] <agent>: <message first 80 chars>` |
| Failure Issue body | human summary + fenced `detail` + hidden marker line `<!-- errmeter:fp=<fingerprint> id=<first event id> schema=1 -->` |
| Occurrence comment | `<!-- errmeter:occurrence ids=<id1,id2,...> count=<n> first=<ts> last=<ts> -->` + human summary + latest `detail` |
| Heartbeat Issue title | `[errmeter] heartbeat: <agent>@<host>` (one per agent@host, never closed by errmeter) |
| Heartbeat Issue body | marker `<!-- errmeter:heartbeat agent=<agent> host=<host> role=<role> -->` + last message; **liveness = Issue `updated_at`** (body edit) |
| Alert Issue title | `[errmeter] alert: <key>` (e.g. `all-watchers-silent`, `gap:<agent>@<host>`) |
| Claim comment | `<!-- errmeter:claim watcher=<watcherId> expires=<ISO> -->` (see §6) |
| Outcome comment | `<!-- errmeter:outcome status=<status> watcher=<watcherId> -->` + summary + url |

Labels (created by `errmeter init`, all prefixed to avoid collisions with a family's own labels):

| label | meaning |
|---|---|
| `errmeter` | every Issue errmeter creates |
| `errmeter:failure` / `errmeter:heartbeat` / `errmeter:alert` | record type |
| `errmeter:role:watcher` | heartbeat Issue of a watcher |
| `errmeter:claimed` | an unexpired claim exists (mirror of the claim comment; the comment is authoritative) |
| `errmeter:dispatched` | hook was started at least once |
| `errmeter:repaired` | last hook run exited 0 (a fix was *proposed*) |
| `errmeter:dispatch-failed` | last hook run failed |
| `errmeter:needs-human` | escalated; owner notified |

Fingerprint lookup order: `state/fingerprints.json` cache → list open Issues with label `errmeter:failure` (100/page, all pages, budgeted) and match the `fp=` marker → not found = create. A cache hit whose Issue turns out closed → create a new Issue and update the cache (a closed problem that returns is a new record, linked by the marker's `fp`).

API budget [default]: `max_api_calls_per_pass` 60; backoff on 403/429 honouring `Retry-After` / `X-RateLimit-Reset`, capped at 1 h; on 5xx exponential from 5 s.

### 5.2 `file` sink

Appends one JSON line per board write to `file.path` (default `~/.errmeter/board.jsonl`): `{ "op": "failure"|"occurrence"|"heartbeat"|"claim"|"outcome"|"alert", ...payload, "ts" }`. Implements the board functions by scanning the file (same host only). Intended for tests and single-machine families.

### 5.3 `webhook` sink

`POST webhook.url` with `Content-Type: application/json`, body = the event (heartbeat) or `{ fingerprint, count, events }` (failure group); optional `webhook.headers_file` for auth headers. 2xx = delivered. Board functions throw `NotABoard`; `watch` refuses to start against it.

---

## 6. Claim protocol [frozen] (D-4)

State of a failure record is derived from its comments, newest last:

1. A **claim** is a comment whose first line matches `<!-- errmeter:claim watcher=<id> expires=<ISO> -->`.
2. A claim is **live** if `expires` is in the future **and** no later `errmeter:outcome` or `errmeter:release` comment by the same watcher exists.
3. The **holder** is the author of the live claim with the **lowest comment id**. (Author is the same user for all watchers sharing a token, so `watcher=` in the marker is the identity; comment id is the tie-break because GitHub assigns them monotonically per repository.)
4. **To claim**: post a claim comment with `expires = now + claim_ttl_sec` → re-read the comments → if you are the holder, add label `errmeter:claimed` and proceed; otherwise delete your own claim comment (or post `<!-- errmeter:release watcher=<id> -->` if deletion is not permitted) and skip.
5. **To renew** while the hook runs: post a new claim comment every `renew_sec`; the old one is superseded by `expires` only (no deletion needed). `renew_sec` MUST be < `claim_ttl_sec / 2`.
6. **Stale**: no live claim. Any watcher may claim. The label `errmeter:claimed` is advisory; watchers MUST evaluate the comments, not the label, before dispatching.
7. **Terminal**: a record with `errmeter:needs-human`, or closed, is never claimed.

Defaults [default]: `claim_ttl_sec` 1800 · `renew_sec` 300 · `escalate_after` 2 · `max_concurrent` 1.

---

## 7. Configuration [frozen keys, default values]

File: `ERRMETER_CONFIG` → else `<home>/config.json`. JSON, comments not allowed. Secrets are **never** in this file; they are referenced by `*_file` keys or supplied by env.

```json
{
  "schema": 1,
  "family": "kumaru",
  "host": "vps-1",
  "agent": "unknown",
  "sink": {
    "type": "github-issue",
    "repo": "owner/errmeter-inbox",
    "token_file": "~/.errmeter/github-token",
    "api_base": "https://api.github.com"
  },
  "spool": { "tail_lines": 40, "detail_max_bytes": 8192, "sent_retention_days": 7 },
  "watch": {
    "watcher_id": "vps-1",
    "interval_sec": 60,
    "claim_ttl_sec": 1800,
    "renew_sec": 300,
    "max_concurrent": 1,
    "escalate_after": 2,
    "heartbeat_gap_sec": 900,
    "watcher_gap_sec": 600,
    "renotify_sec": 21600,
    "gaps": { "nora@vps-1": 3600 },
    "dispatch": { "command": ["node", "/opt/family/repair.js"], "timeout_sec": 3600, "cwd": "/opt/family" }
  },
  "notify": [
    { "type": "telegram", "bot_token_file": "~/.errmeter/telegram-token", "chat_id": "123456789" },
    { "type": "slack", "webhook_url_file": "~/.errmeter/slack-webhook" },
    { "type": "webhook", "url": "https://example.invalid/hook", "headers_file": "~/.errmeter/hook-headers" }
  ],
  "owner": { "mention": "@shojikumaru" }
}
```

Precedence: CLI flag > environment variable > config file > built-in default.

Environment variables [frozen names]: `ERRMETER_HOME`, `ERRMETER_CONFIG`, `ERRMETER_AGENT`, `ERRMETER_GITHUB_TOKEN`, `ERRMETER_LOG_LEVEL` (`error|warn|info|debug`, default `info`). No other env var is read.

`~` in any `*_file` path expands to `os.homedir()`. Only one `sink` (D-3). `notify` is an array; each entry is tried in order, all are sent (best effort, failures logged). Unknown `type` values fail at startup of flush/watch, not at emit.

`init` writes this file with the family's answers and refuses to overwrite an existing one without `--force`.

---

## 8. Token and permission boundary [frozen]

- The board token is a GitHub **fine-grained** personal access token (or a GitHub App installation token the family manages itself) with repository access limited to **the inbox repo only** and permissions **Issues: Read and write**, **Metadata: Read**. No Contents, no Actions, no Pull requests, no Workflows.
- Source: `ERRMETER_GITHUB_TOKEN` → else `sink.token_file`. On POSIX the file MUST be mode `0600` or stricter; errmeter refuses (`EPERM_TOKEN_FILE_MODE`) otherwise. On Windows the check is skipped and documented.
- `errmeter init --check` and `errmeter status --check` verify: `GET /repos/{repo}` succeeds, `GET /repos/{repo}/issues?per_page=1` succeeds, `POST /repos/{repo}/labels` (creating the errmeter labels) succeeds, and **`GET /repos/{repo}/contents/`** is `403/404` (proof that Contents is not granted; a `200` is reported as *over-scoped* and is a warning, not a failure, because some families legitimately reuse tokens — but the human checkpoint #2 in EPIC #1 expects the warning to be absent).
- The token string is added to the redactor mask list immediately after loading. It MUST NOT be passed to the dispatch hook (not in env, not in the event file, not on stdin) and MUST NOT appear in `errmeter.log` at any log level.
- Notify secrets follow the same `*_file` + `0600` rule.

---

## 9. Dispatch hook contract [frozen] (D-5, D-6)

Invocation by `watch` after a won claim:

- `spawn(command[0], command.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true })`
- **stdin**: the dispatch payload JSON, then EOF. **`ERRMETER_EVENT_FILE`**: path to the same JSON written under `<home>/state/dispatch/<issue>.json`.
- **env** (added to the inherited environment): `ERRMETER_ISSUE_NUMBER`, `ERRMETER_ISSUE_URL`, `ERRMETER_AGENT`, `ERRMETER_HOST`, `ERRMETER_FINGERPRINT`, `ERRMETER_EVENT_FILE`, `ERRMETER_HOME`, `ERRMETER_WATCHER_ID`. **Removed** from the environment before spawn: `ERRMETER_GITHUB_TOKEN`.
- Dispatch payload:

```json
{
  "schema": 1,
  "issue": { "ref": 42, "url": "https://github.com/owner/errmeter-inbox/issues/42", "title": "...", "occurrences": 7, "first_ts": "...", "last_ts": "..." },
  "latest": { "...": "the newest event object (§2)" },
  "attempt": 1,
  "watcher_id": "vps-1"
}
```

- **Exit code** `0` = repair attempted; the **last non-empty stdout line** is recorded as the outcome summary (a PR URL by convention). Any other exit code, a timeout (`timeout_sec`, kill signal `SIGTERM` then `SIGKILL` after 10 s; on Windows `taskkill /T /F`), or a spawn error = `dispatch-failed`; the last 20 lines of stderr are recorded.
- `watch` writes the outcome comment and label (§5.1), and after `escalate_after` consecutive failures for the same record adds `errmeter:needs-human` and notifies the owner once.
- **Boundary (D-6)**: the hook MAY open pull requests and post comments in target repos using its own credentials. The hook MUST NOT merge, push to protected branches, or close the inbox Issue; `repaired` means "a fix was proposed". errmeter cannot police the hook's own credentials — this is the family's rule and is stated in `docs/integrations/` for the hook authors. errmeter's own token structurally cannot do any of these (§8).

---

## 10. Node.js 18 floor: allowed and banned [frozen]

Allowed (present in Node 18.0): `node:fs` (incl. `fs.promises`, `fs.rmSync`, `fs.mkdirSync({recursive})`), `node:path`, `node:os`, `node:crypto` (`randomUUID`, `createHash`), `node:https`/`node:http`, `node:child_process` (`spawn`, `execFile`), `node:util` (`parseArgs` **not** allowed — added in 18.3, use a hand-written flag parser), `node:test` (18.0+, use only in tests), `node:assert`, `node:events`, `node:stream`, `node:readline`, `node:url`, `AbortController`, optional chaining, nullish coalescing, class fields, top-level `await` is **not** used (CommonJS only).

Banned: global `fetch` (ExperimentalWarning on 18), `structuredClone` on anything but plain data, `Array.prototype.{toSorted,toReversed,with}` (20+), `Object.groupBy`, `Set` methods (union etc.), `Promise.withResolvers`, `import` syntax (ESM) anywhere in `src/` or `bin/`, `--experimental-*` flags, `node:sqlite`, `node:test` `mock.timers`, `fs.cpSync` (18.0 experimental), `util.parseArgs`, `String.prototype.isWellFormed`, RegExp `v` flag, any TypeScript, any `package.json` `dependencies`/`devDependencies`.

`package.json` `engines.node` = `">=18"`. `bin/errmeter.js` begins with a version guard that prints one line and exits 2 below 18.

---

## 11. CLI surface [frozen names and exit codes]

`errmeter <command> [flags]`. Global flags: `--home <dir>`, `--config <file>`, `--json`, `--quiet`, `--version`, `--help`.

| command | flags | exit codes |
|---|---|---|
| `emit` | `--agent <name>`, `--kind error\|heartbeat` (default `error`), `--message <text>` (or first line of detail), `--detail-file <path>` \| `--detail -` (stdin), `--tail <n>`, `--task <text>`, `--meta k=v` (repeatable), `--no-flush` | `0` always after the spool write succeeded (including fallback); `2` usage error only |
| `flush` | `--once` (default), `--dry-run` | `0` all pending delivered or nothing pending; `1` some remain pending (transient); `3` config/token error |
| `watch` | `--once` (single tick, for tests), `--interval <sec>` | runs until signal; `--once` returns `0`/`1`/`3` like flush |
| `init` | `--repo`, `--family`, `--host`, `--force`, `--check` | `0` ok; `3` token/permission problem (message names the missing permission); `4` refused to overwrite |
| `status` | `--check` (network), `--notify-test` | `0` healthy; `1` degraded (pending > soft limit, last flush failed, gap present); `3` cannot check |
| `install` / `uninstall` | `--dry-run`, `--user\|--system` | defined in #6 within these exit-code meanings |

Output: without `--json`, one summary line per command on stdout, diagnostics on stderr. With `--json`, one JSON object on stdout, nothing else.

---

## 12. Test hooks (non-normative, for #3–#7)

- `ERRMETER_HOME` pointed at a temp dir isolates every test.
- The `file` sink is the reference board for unit tests of `watch`/`claim`; the `github-issue` sink is tested against a local `node:http` fake that implements the handful of endpoints used (`GET/POST/PATCH /repos/:r/issues*`, `/labels`, `/issues/:n/comments`, `DELETE /issues/comments/:id`, `GET /repos/:r`, `GET /repos/:r/contents/`).
- Redaction test vectors live in `test/fixtures/redact/*.txt` with `*.expected` siblings.
