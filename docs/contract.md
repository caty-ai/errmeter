# errmeter contract (v1) — FROZEN INTERFACES

Status: **freeze candidate v1.7** for issue #2 (v1.0 → v1.7: seven review rounds folded in; see the changelog at the end). Once the owner approves, every section marked **[frozen]** may change only through a new contract issue that bumps the relevant version field. Sections marked **[default]** are tunable defaults that implementations MUST honour but families MAY override in config.

Companions: [requirements.md](requirements.md), [architecture.md](architecture.md). Requirement ids (`R-*`, `N-*`) and decision ids (`D-*`) refer to those files.

Wording: MUST / MUST NOT / SHOULD / MAY as in RFC 2119. "Reader" = any code that consumes a format; "writer" = code that produces it. "Board time" = the `Date` header of the last successful board response (see §6.0).

---

## 1. Versioning and freeze rules [frozen]

- Versioned surfaces: `schema` (event), `config.schema` (config file), `fpv` (fingerprint algorithm, §2.1), and the board marker prefix `errmeter:`. All are integers or fixed strings.
- Readers MUST ignore unknown fields. Readers MUST NOT drop data whose version is *higher* than they understand; they deliver it verbatim and annotate (event → board with note; config → refuse to start with a clear message).
- Adding an optional field is not a version bump. Renaming, removing, changing a type, changing the fingerprint algorithm, or changing a default that affects the board layout is a bump.
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
  "fpv": 1,
  "meta": { "pr": "https://github.com/x/y/pull/12", "run_id": "sitter-20260905-1307" },
  "emitter": "errmeter/1.0.0",
  "attempts": 0
}
```

| field | type | required | writer | rules |
|---|---|---|---|---|
| `schema` | integer | yes | emit | `1` for this contract. |
| `id` | string | yes | emit | UUID v4 (`crypto.randomUUID()`). Globally unique; the idempotency key for the sink. |
| `ts` | string | yes | emit | ISO 8601 UTC with milliseconds, `Z` suffix. Time of emit. |
| `kind` | `"error"` \| `"heartbeat"` | yes | emit | Closed enum. Anything else is a usage error at emit and a `dead/` event at flush. |
| `agent` | string | yes | emit | `[a-z0-9._/-]{1,64}` **after lower-casing** (emit lower-cases; `Nora` and `nora` are one agent). Source: `--agent` > `ERRMETER_AGENT` > config `agent` > `"unknown"`. Watchers use `watcher/<watcher_id>`. |
| `host` | string | yes | emit | `[a-z0-9._-]{1,64}` after lower-casing. Source: config `host` > `os.hostname()` (domain stripped). |
| `family` | string | no | emit | From config. ≤ 64 chars. Informational only (X-5). |
| `task` | string | no | emit | ≤ 200 chars after redaction. |
| `message` | string | yes for `error`; MAY be empty for `heartbeat` | emit | First line of the failure. ≤ 500 chars after redaction; single line (CR/LF → space). |
| `detail` | string | no | emit | Redacted tail. ≤ `detail_max_bytes` after redaction; newlines preserved. Truncation marks with a leading line `[errmeter: truncated to last N lines]`. Empty in compact mode (§3.3). |
| `fingerprint` | string | yes for `error`; absent for `heartbeat` | emit | 16 lowercase hex chars, §2.1. |
| `fpv` | integer | yes for `error` | emit | Fingerprint algorithm version, `1`. |
| `meta` | object | no | emit | Keys `[A-Za-z0-9_.-]{1,32}`, string values ≤ 256 chars, ≤ 16 entries. Values pass the redactor. Keys starting with `_` are reserved (`_spool_fallback`, `_compact`, `_folded_count`). |
| `emitter` | string | yes | emit | `errmeter/<package version>`. |
| `attempts` | integer | yes | emit (0), flush (increments) | Delivery attempts. The only field flush may rewrite in a pending file. |

Size cap for the whole serialized event: **32 KiB**. emit shrinks `detail` first, then `meta` values, to fit.

### 2.1 Fingerprint, `fpv = 1` [frozen]

```
n = message
  .toLowerCase()
  .replace(/(?:[a-z]:)?(?:[\\/][^\s"'`:;,)]+){2,}/g, "#path#")    // absolute or multi-segment paths (posix + windows)
  .replace(/https?:\/\/[^\s"'`)]+/g, "#url#")                       // urls
  .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "#uuid#")
  .replace(/\b0x[0-9a-f]+\b/g, "#hex#")
  .replace(/\b[0-9a-f]{12,}\b/g, "#hex#")                          // long hex ids / hashes
  .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "#ip#")
  .replace(/:\d+(?::\d+)?\b/g, ":#")                                // :port, :line:col
  .replace(/\b\d{4,}\b/g, "#")                                      // 4+ digit numbers (ids, timestamps, pids)
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 200)
fingerprint = sha256(agent + "\n" + n).hex.slice(0, 16)
```

Rules of the algorithm: numbers of 1–3 digits are **kept** (HTTP status, exit codes, errno); quoted strings are **kept** (`reading 'userId'` and `reading 'orgId'` are two problems); paths, URLs, UUIDs, long hex, IPs, ports and line:col positions are wiped. `host` and `task` are not part of the fingerprint. Families that want per-host records put the host in `agent` (`nora@vps-1`).

Normative vectors (tests MUST pin these; `agent = "a"` for all):

| message | normalized |
|---|---|
| `HTTP 404 fetching invoice 1234` | `http 404 fetching invoice #` |
| `HTTP 500 fetching invoice 9876` | `http 500 fetching invoice #` (≠ previous) |
| `ECONNREFUSED 10.0.0.1:5432` | `econnrefused #ip#:#` |
| `ECONNREFUSED db.internal:6379` | `econnrefused db.internal:#` (≠ previous — a hostname is not an IP; accepted) |
| `TypeError: Cannot read properties of undefined (reading 'userId')` | `typeerror: cannot read properties of undefined (reading 'userid')` |
| `TypeError: Cannot read properties of undefined (reading 'orgId')` | `... (reading 'orgid')` (≠ previous) |
| `ENOENT: no such file, open '/tmp/run-abc/a.txt'` | `enoent: no such file, open '#path#'` |
| `ENOENT: no such file, open '/tmp/run-xyz/a.txt'` | same as previous |
| `Error at /opt/app/src/x.js:123:45` | `error at #path#:#` |

### 2.2 Heartbeat events

Same object with `kind: "heartbeat"`, no `fingerprint`/`fpv`, `message` MAY be a short status, `detail` SHOULD be empty. `meta.role` = `"watcher"` for `watch --role watcher`, `"agent-host"` for `watch --role agent-host` (§11), otherwise absent.

---

## 3. Spool format and locations [frozen] (D-2)

Home: `ERRMETER_HOME` → else `path.join(os.homedir(), ".errmeter")`. Same on macOS, Linux, Windows.

| path | content |
|---|---|
| `spool/pending/<ts>-<id>.json` | one event; `<ts>` = `ts` with `:` and `.` replaced by `-`; `<id>` = event id |
| `spool/pending/counters.log` | overflow log (§3.3): one line per occurrence, `<fingerprint>\t<fpv>\t<agent>\t<host>\t<ts>\t<message>\n`, hard-truncated to ≤ 320 bytes (message first), appended with `O_APPEND` |
| `spool/pending/overflow-exceeded.json` | ceiling marker (§3.3): written once when the overflow log reaches `overflow_max_bytes`; the only loss boundary of the spool |
| `spool/pending/counters.<nonce>.log` | an overflow log cut by flush (renamed, being delivered); `<nonce>` is the counter idempotency key |
| `spool/pending/heartbeat-<agent>@<host>.json` | heartbeat upsert file used in counter mode (one per agent, tmp+rename) |
| `spool/pending/*.tmp` | in-flight writes; readers ignore; older than 60 s = garbage, flush deletes |
| `spool/sent/<same name>` | delivered; moved here after the sink confirmed; deleted after `sent_retention_days` **or when `sent/` exceeds `sent_max_bytes` (oldest first)** — everything here is already on the board, so deletion is always safe |
| `spool/dead/<same name>` | **unprocessable only** (bad JSON, unknown `kind`, unknown higher `schema` after one delivery attempt as raw text failed). Never used for capacity. Deleted after `dead_retention_days` **or when `dead/` exceeds `dead_max_bytes` (oldest first)**. |
| `spool/flush.lock` | see §3.2 |

Heartbeat upsert file names use `encodeURIComponent(agent)@encodeURIComponent(host)`; heartbeat lines in the overflow log carry `-` as fingerprint and `0` as fpv.
Reserved `_`-prefixed meta keys sit outside the 16-entry cap.

### 3.1 Write / move protocol

- Write (emit): serialize → write `<name>.tmp` → `fsync` (best effort) → `rename` to `<name>.json`. Never open the final name for writing.
- Move (flush): `unlink` the destination if it exists (Windows `rename` fails on an existing target), then `rename`. A move that fails is retried next pass; the event stays pending (duplicate delivery is prevented by the board markers, §5.1, not by the move).
- Read (flush): `readdir` `pending/`, ignore `.tmp`, sort by name, oldest first, up to `max_events_per_pass`. Counter files are processed after event files.
- Fallback: if the home is unwritable, emit uses `path.join(os.tmpdir(), "errmeter-spool")` with the same layout and sets `meta._spool_fallback`. flush drains both.

### 3.2 Flush lock (single-flight per home)

- Acquire: `open(flush.lock, "wx")` and write `{ "pid", "nonce", "ts", "host" }`. Failure = someone holds it → exit 0 silently (emit-spawned) or return "busy" (`flush` command, exit 1).
- Refresh: the holder rewrites `ts` every `lock_refresh_sec` (30) while alive.
- **Linger** (autonomous retry without a loop): when a pass ends with events still pending because of a transport failure, an **emit-spawned** flush does not exit; it keeps the lock, sleeps the current backoff (refreshing the lock every 30 s), re-lists `pending/` and retries, until either nothing is pending or `flush_linger_sec` (3600) has elapsed since it started, then exits. A one-shot agent on a laptop therefore gets up to an hour of automatic retry after the network returns, with no daemon. Loop-driven and manual flushes do not linger (they exit and rely on the next tick). Backoff longer than `flush_linger_sec` is remembered in `state/last_flush.json`, not slept.
- Steal: a lock whose `ts` is older than `lock_stale_sec` (600) MAY be stolen **only** by `rename(flush.lock, flush.lock.stale-<my nonce>)` followed by a fresh `wx` create. The rename is atomic; a second stealer's rename fails with `ENOENT` and it exits. Never `unlink` then create.

### 3.3 Capacity: nothing unacknowledged is ever evicted

- Below `pending_soft_limit` (5000 files): normal.
- Between soft and hard limit: **compact mode** — emit writes events with empty `detail` and `meta._compact = "1"`. Content is reduced, every event still exists.
- At or above `pending_hard_limit` (20000 files): **counter mode** — emit does not create a new event file; it **appends one line** to `pending/counters.log` (`O_APPEND`; the line is hard-truncated by emit to **≤ 320 bytes**, under the 512-byte POSIX `PIPE_BUF` atomic-append floor for regular-file appends on the supported OSes, and Windows `FILE_APPEND_DATA` writes of this size are not interleaved). No lock, no read-modify-write, so concurrent appends never clobber each other and the file count no longer grows. Heartbeats in counter mode are upserted into `pending/heartbeat-<agent>@<host>.json` (one file per agent, tmp+rename), at most `max_heartbeat_files` (1000) such files; beyond that, a heartbeat is written as a line of the overflow log (`kind=heartbeat` in the message field) and folded by flush into the heartbeat upsert.
- **Append-then-verify** (closes the rename race): after the append, emit `fstat`s its open handle; if `nlink == 0` (the file it wrote into has been deleted by flush, see below) it re-appends the same line to a freshly opened `pending/counters.log`. A line can only be lost in two named cases, both requiring an emit process to stall longer than `cut_settle_sec` between `open` and `write`: (a) its late write lands in the microsecond window between flush's final re-read and the unlink, or (b) emit crashes after that late write but before its `fstat`/re-append. Both are accepted, documented residuals of a mode that is already degraded (≥ 20000 undelivered files).
- **Ceiling**: when `counters.log` is at or above `overflow_max_bytes` (64 MB ≈ 200 000 occurrences), emit stops appending and instead writes (once, tmp+rename, idempotent) `pending/overflow-exceeded.json` `{ "since": <ts> }`; further occurrences are **dropped with their counts**. The size check is unlocked, so concurrent emitters can overshoot the ceiling; emit therefore never appends when the size is at or above `overflow_max_bytes + overflow_guard_bytes` (1 MiB) — the **hard** cap regardless of concurrency (an append that would cross it is dropped like any post-ceiling occurrence). This is the single, explicit loss boundary of the spool (R-F2). flush turns the marker into one `upsertAlert` key `spool-overflow:<host>` and deletes it once the overflow log has drained below half the ceiling.
- flush **cuts** the log by renaming it to `counters.<nonce>.log` (atomic; concurrent emits simply start a new `counters.log`), and cuts **only when no cut file is pending** (an undelivered cut is processed first, so at most one cut file exists at a time). It then waits `cut_settle_sec` (2) so that any emit which had the old inode open has finished its write, reads the cut, folds lines per fingerprint into one occurrence comment carrying `counter_ref=<nonce>` and `count=`, and, after every group is on the board, **re-reads the cut file's size**: if it grew, the new tail lines are delivered the same way under a **new idempotency key `counter_ref=<nonce>.<k>`** (`k` = 1, 2, … per re-read pass; the first delivery is `<nonce>.0`), repeated until the size is stable; only then is the cut file deleted. **Durable checkpoint**: before each board write for pass `k`, flush writes (tmp+rename) `state/cuts/<nonce>.json` = `{ "k": k, "offset": <byte offset where pass k starts>, "end": <byte offset where pass k ends — the file size observed when the pass was opened, fixed for the life of the pass>, "posted": [fingerprints already on the board for this k] }`, and after the write updates `posted`. Recovery algorithm for a cut file found at startup: read the checkpoint (absent = `k` 0, `offset` 0, `end` = current size, `posted` empty — and write it before the first board write); for pass `k`, lines from `offset` to **`end`** (never the current size) are the pass; each fingerprint in the pass is posted under `<nonce>.<k>` unless it is in `posted` **or** the board already carries `counter_ref=<nonce>.<k>` for it; when the pass is complete, the next checkpoint is written with `offset` = old `end`, `end` = current size, `k + 1`, `posted` empty (bytes that arrived after the old `end` therefore always belong to the next pass); the file is deleted only when a pass finds no new bytes after `cut_settle_sec`. Thus every byte of the cut belongs to exactly one `k`, and a tail is never skipped because an earlier `k` was posted. Crash recovery: a cut file whose `<nonce>` already appears as `counter_ref=` on the Issue for that fingerprint is not re-posted for that fingerprint (counter idempotency key); once all its fingerprints are accounted for it is deleted. **No pending file is ever moved to `dead/` for capacity reasons.** **Total spool bound** (N-7) = `pending/` (`pending_hard_limit × 32 KiB` + heartbeat upserts ≤ `max_heartbeat_files` × 32 KiB) + `counters.log` (≤ `overflow_max_bytes` + `overflow_guard_bytes`) + one cut file (≤ the same) + `sent/` (`sent_max_bytes`) + `dead/` (`dead_max_bytes`) = 640 + 32 + 65 + 65 + 256 + 64 MB ≈ **1.12 GB absolute worst case** with defaults, every term capped by a configured value; `state/` files are O(fingerprints) JSON and `errmeter.log` is size-rotated at `log_max_bytes`. In practice far lower because compact mode starts at the soft limit.
- Malformed overflow lines that cannot be parsed are counted and skipped by flush (reported in `state/last_flush.json` `errors` and the log); a cut with no valid line is preserved in `dead/`. This is an accepted residual next to the overflow ceiling.
- Requirements wording that follows from this: "nothing lost" means *no event below the hard limit is lost; above it, content is folded into counts* (R-F2, §6 of requirements.md).

Limits [default]: `detail_max_bytes` 8192 · `tail_lines` 40 · `pending_soft_limit` 5000 · `pending_hard_limit` 20000 · `sent_retention_days` 7 · `sent_max_bytes` 268435456 · `dead_retention_days` 30 · `dead_max_bytes` 67108864 · `log_max_bytes` 10485760 · `lock_refresh_sec` 30 · `lock_stale_sec` 600 · `flush_linger_sec` 3600 · `cut_settle_sec` 2 · `overflow_max_bytes` 67108864 · `overflow_guard_bytes` 1048576 · `max_heartbeat_files` 1000 · `max_events_per_pass` 500.

---

## 4. Redaction [frozen]

The redactor is one pure function `redact(text, maskList) → text`. It is applied to **every string that leaves the machine or is written by errmeter**: at emit (`task`, `message`, `detail`, `meta` values → spool), at flush (same fields again before egress), by watch to **hook stdout/stderr excerpts and outcome summaries** before `writeOutcome`, to alert bodies, and to every line of `errmeter.log`.

Mask list construction: at process start each command reads the secret files it *can* read (board token, notify secrets, and **every `*_file` credential named in config**, including the webhook sink's `headers_file` — read-only, never sent by emit) and adds their contents to the mask list; if a file is unreadable the mask list simply lacks it. emit therefore masks the board token in the spool whenever the token file is readable by the emitting user (the common case: same user, same home). Env values are added for env var names matching rule 4.

| # | rule | replacement |
|---|---|---|
| 1 | Any string in the mask list (≥ 8 chars) | `[REDACTED]` |
| 2 | PEM blocks `-----BEGIN [A-Z ]*PRIVATE KEY-----` … `-----END [A-Z ]*PRIVATE KEY-----` | `[REDACTED PEM]` |
| 3 | Known shapes: `ghp_[A-Za-z0-9]{20,}`, `github_pat_[A-Za-z0-9_]{20,}`, `gh[ousr]_[A-Za-z0-9]{20,}`, `sk-[A-Za-z0-9_-]{16,}`, `xox[abprs]-[A-Za-z0-9-]{10,}`, `AKIA[0-9A-Z]{16}`, `AIza[0-9A-Za-z_-]{35}`, `[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}` (Telegram bot), `https://hooks\.slack\.com/services/[A-Za-z0-9/]+`, `https://discord(app)?\.com/api/webhooks/[^\s]+` | `[REDACTED TOKEN]` |
| 4 | `key=value` / `key: value` / `"key": "value"` where key matches `/(token|secret|password|passwd|pwd|api[_-]?key|auth|bearer|cookie|session)/i` | key kept, value → `[REDACTED]` |
| 5 | `Authorization: <scheme> <value>` and `Bearer <value>` | `Authorization: [REDACTED]` / `Bearer [REDACTED]` |
| 6 | URL userinfo `scheme://user:pass@host`; query params named as in rule 4 | `scheme://[REDACTED]@host`, `?key=[REDACTED]` |
| 7 | `os.homedir()` literal (and `%USERPROFILE%` form) | `~` |
| 8 | Tail: keep the last `tail_lines` lines of `detail` | prepend `[errmeter: truncated to last N lines]` |

Deterministic; never logs what it removed. Vectors in `test/fixtures/redact/`.

---

## 5. Sink adapter interface [frozen]

A sink module exports the functions below. All take `ctx` first: `{ config, home, log, http, now }` (`home` = resolved errmeter home; `now()` = board time when known, else local). Transport failures throw (flush retries); idempotent no-ops return `{ skipped: true }`. **This table is the only list of names**; architecture.md refers to it.

```js
// delivery (flush)
deliverHeartbeat(ctx, event)                    // → { ref }
deliverFailureGroup(ctx, group)                 // → { ref, created, delivered: [ids] }
   // group = { fingerprint, fpv, agent, events: [oldest..newest], count, counter? }
// board (watch). Non-board sinks throw NotABoard.
listOpenFailures(ctx)                           // → [ FailureSummary ]      (paginated, budgeted, §5.4)
getFailure(ctx, ref)                            // → FailureDetail
claim(ctx, ref, { watcherId, ttlSec })          // → { won, claimRef, expiresAt }   atomic: post → re-read → tie-break → cleanup (§6)
renewClaim(ctx, ref, { watcherId, claimRef, ttlSec })  // → { ok, expiresAt }   MUST be confirmed 2xx to count
releaseClaim(ctx, ref, { watcherId, claimRef })
writeOutcome(ctx, ref, outcome)                 // outcome = { status: "repaired"|"dispatch-failed"|"needs-human", summary, url?, watcherId }
listHeartbeats(ctx)                             // → [ HeartbeatRecord ]
upsertAlert(ctx, alert)                         // alert = { key, title, body, mention? } → { ref, winner }  (§5.3)
```

Types [frozen field lists]:

```
FailureSummary  = { ref, fingerprint, fpv, agent, host, title, labels: [string], openedAt, lastOccurrenceAt, occurrences, claim: Claim|null, lastOutcome: Outcome|null }
FailureDetail   = FailureSummary + { latest: Event, claims: [Claim], outcomes: [Outcome], occurrenceIds: [string] }
Claim           = { claimRef, watcherId, createdAt, expiresAt, live: boolean }
Outcome         = { status, watcherId, at, summary, url? }
HeartbeatRecord = { ref, agent, host, role: "watcher"|"agent-host"|null, lastSeen (ISO from marker), message }
Event           = the §2 object
```

Idempotency keys the sink MUST honour: event `id` (never two board writes for one id), counter `<nonce>.<k>` (§3.3, `counter_ref=`), `fingerprint` (never two *open* failure records for one fingerprint — with the reconciliation in §5.2), alert `key` (one open alert record per key).

`deliverHeartbeat` lookup order: `state/heartbeats.json` cache (`agent@host → ref`) → list open Issues labelled `errmeter:heartbeat` (full pagination) and match `agent=`/`host=` in the marker → create. Delivery = `PATCH` of the Issue body (marker `ts` = the event's `ts`; an older event never overwrites a newer marker).

### 5.1 `github-issue` board layout [frozen]

All markers are HTML comments on their own line; `key=value` pairs separated by single spaces; values never contain spaces (ids are comma-joined). Every marker starts with `errmeter:`.

| record | title | body / comment |
|---|---|---|
| Failure Issue | `[errmeter] <agent>: <newest message, first 80 chars>` | marker `<!-- errmeter:failure fp=<fingerprint> fpv=1 ids=<id,...> count=<n> first=<ts> last=<ts> schema=1 -->` + human summary + `latest` event as a fenced ```json block (full §2 object, already redacted) |
| Occurrence comment | — | `<!-- errmeter:occurrence ids=<id,...> count=<n> first=<ts> last=<ts> -->` + summary + fenced ```json `latest` event (if a counter: `ids=` empty, `count` from the counter) |
| Heartbeat Issue | `[errmeter] heartbeat: <agent>@<host>` | `<!-- errmeter:heartbeat agent= host= role= ts=<ISO of the event> -->` + last message. **Liveness = `ts` in the marker**, never Issue `updated_at`. |
| Alert Issue | `[errmeter] alert: <key>` | `<!-- errmeter:alert key= -->` + body; each alert episode is a comment `<!-- errmeter:alert-episode key= host= ts= -->` (§5.3) |
| Claim comment | — | `<!-- errmeter:claim watcher=<id> expires=<ISO> ref=<claimRef-or-new> -->` |
| Release comment | — | `<!-- errmeter:release watcher=<id> ref=<claimRef> -->` |
| Outcome comment | — | `<!-- errmeter:outcome status= watcher= ts= -->` + redacted summary + url + fenced last-20-lines excerpt (redacted) |

`ids=` in a failure marker or occurrence marker lists **every** event id delivered by that board write. Crash recovery: a pending event whose `id` appears in any marker of the open (or most recently closed) Issue for its fingerprint is moved to `sent/` without a new write.

Labels (created by `errmeter init`):

| label | meaning |
|---|---|
| `errmeter` | every Issue errmeter creates |
| `errmeter:failure` / `errmeter:heartbeat` / `errmeter:alert` | record type |
| `errmeter:role:watcher` / `errmeter:role:agent-host` | heartbeat Issue of a loop process |
| `errmeter:claimed` | advisory mirror of a live claim (comments are authoritative) |
| `errmeter:dispatched` | hook started at least once |
| `errmeter:repaired` | last outcome exit 0 (a fix was *proposed*) |
| `errmeter:dispatch-failed` | last outcome failed |
| `errmeter:needs-human` | escalated; owner notified |

Comment throttle [default]: `max_comments_per_issue` 400 (rollover, §5.2) · `max_comments_per_issue_per_hour` 12, counted from the `ts=` of occurrence markers on that Issue (read from the board, so all hosts share the count). Beyond the cap, flush leaves the events pending (they fold into the next comment when the window frees). Heartbeat and claim writes are not throttled.

### 5.2 Fingerprint lookup and reconciliation [frozen]

Order: `state/fingerprints.json` cache (`fp → { ref, state }`) → list open Issues with label `errmeter:failure` (`per_page=100`, all pages, budgeted §5.4) and match `fp=` in the failure marker → not found = create.

- Budget exhausted before the listing completed → **unknown**: do not create, leave events pending, record `lookup_incomplete` in `state/last_flush.json`. Never create on an incomplete listing.
- Two open Issues with the same `fp` (concurrent create from two hosts): the **lowest Issue number** is canonical. Reconciliation is itself an **election** so that two hosts cannot both migrate: the finder posts `<!-- errmeter:reconcile from=<dup> -->` on the canonical Issue, re-reads (full pagination), and proceeds only if its reconcile comment has the **lowest id** among reconcile comments with the same `from=` (losers delete exactly their own comment and skip). The winner then **migrates** the ids from the duplicate's markers **that are not already present in any marker of the canonical Issue** (an empty set means: post nothing) with one comment `<!-- errmeter:occurrence ids=<missing ids> count=<n> first= last= migrated_from=<dup> -->`, then posts `<!-- errmeter:duplicate-of ref=<canonical> -->` on the duplicate and closes it (one of the two things errmeter may close), and updates the cache (`fp → canonical`, plus `duplicates: [dup]`). A crashed winner leaves an open duplicate; the next finder runs the same election (the crashed winner's reconcile comment is older than `claim_ttl_sec` and is ignored), and the "not already present" filter makes the re-run a no-op for anything already migrated. Crash recovery (§5.1) checks the canonical Issue **and** any Issue labelled/marked as its duplicate, so an event written to the duplicate before the migration is never re-posted.
- **Rollover**: when an Issue's comment count reaches `max_comments_per_issue` (400 — below GitHub's 1000-comment pagination horizon at 100/page × `max_pages_per_list`), flush posts `<!-- errmeter:rolled-over -->`, closes it (the second thing errmeter may close), creates a fresh Issue for the fingerprint with `continues=<old>` in its marker, and updates the cache. Claim reads on the new Issue are complete again.
- Cache hit whose Issue is closed and **not** by errmeter (duplicate or rollover): create a new Issue (a returning problem is a new record) and update the cache.
- `deliverFailureGroup` when the Issue exists: filter `events` to ids not already in any marker, then one occurrence comment; `delivered` = the ids actually written.

### 5.3 Alerts: board-first, single winner [frozen]

`upsertAlert` = find the alert Issue by listing open Issues labelled `errmeter:alert` and matching `key=` (full pagination; if two exist, the **lowest number** is canonical and the other is closed as `duplicate-of`, exactly as in §5.2) → create it if absent → **re-list once more after creating** (if a lower-numbered alert Issue for the same key now exists, the creator is on the wrong Issue: it closes its own as `duplicate-of` and continues on the canonical one) → post an episode comment → re-read → the episode comment with the **lowest id** whose `ts` is within `renotify_sec` of now is the winner. Return `{ winner: <my comment is the winner> }`. **Only the winner calls `notify`**, then edits its own episode comment to add `notified=<ISO>`. Losers delete their own episode comment (by the id they just created; never another id). **Winner crash cover**: a candidate that sees the winning episode still lacking `notified=` after `notify_confirm_sec` (120) of board time runs the **same election again** with a `cover=1` episode comment: lowest-id `cover=1` comment within the window notifies and marks the original; the others delete theirs. Every path to a human channel is therefore an election on the board; the residual duplicate is one notification per `notify_confirm_sec` window, only when the winner crashed between posting and notifying. This is the claim protocol (§6) reused for alerts.

### 5.4 Pagination and API budget [frozen]

- Every list call uses `per_page=100` and follows `Link: rel="next"` until exhausted or `max_pages_per_list` (10) is hit. An exhausted page budget is **incomplete** and MUST be treated as unknown (no create, no dispatch, no alert).
- `max_api_calls_per_pass` (60) per flush pass and per watch tick. Backoff on 403/429 honours `Retry-After` / `X-RateLimit-Reset`; on 5xx exponential from 5 s. Backoff longer than `lock_refresh_sec` is stored in `state/last_flush.json` and the process exits/skips the tick.
- Comment reads for a claim decision (§6) MUST be complete (all pages); if not, the watcher does not dispatch.

### 5.5 `file` sink

Appends one JSON line per board write to `file.path` (default `<home>/board.jsonl`): `{ "seq", "op", ...payload, "ts" }` where `seq` is a monotonically increasing integer maintained in `<home>/board.seq` (read → increment → write via tmp+rename, under the flush lock). Board functions scan at most the last `file.scan_max_lines` (50 000) lines. Tie-break for claims/alerts = lowest `seq`. Same-host only.

### 5.6 `webhook` sink

`POST webhook.url`, `Content-Type: application/json`, body = event (heartbeat) or `{ fingerprint, fpv, agent, count, events }` (failure group); `webhook.headers_file` for auth headers. 2xx = delivered. Board functions throw `NotABoard`; `watch` refuses to start against it.

---

## 6. Claim protocol [frozen] (D-4)

### 6.0 Clock

All `expires` comparisons use **board time**: the `Date` header of the response that returned the comments being evaluated. Local clocks are used only for scheduling ticks.

### 6.1 State derived from comments

1. A **claim** is a comment whose first line is an `errmeter:claim` marker; `ref` in the marker is the claim id it renews (`new` for a fresh claim).
2. A claim is **live** if `expires` > board time and no later `errmeter:release` or `errmeter:outcome` by the same `watcher=` exists.
3. The **holder** is the `watcher=` of the live claim with the **lowest comment id** among all comments **listed ascending with full pagination** (§5.4). Comment ids are used as returned by the list endpoint; the contract relies on list order, not on any global id property.
4. **Eligible for claim** = Issue open, no `errmeter:needs-human`, no live claim, **and** (no outcome yet **or** an occurrence marker with `last=` later than the last outcome's `ts=`). A `repaired` or `dispatch-failed` record is therefore not re-dispatched until the problem happens again.
5. **Consecutive failures** = number of trailing `dispatch-failed` outcomes since the last `repaired` outcome or, if none, since Issue creation. **Occurrence markers do not reset the count** (they only re-open eligibility under rule 4). `≥ escalate_after` → `needs-human` (§9). Worked example with `escalate_after = 2`: occurrence → fail (1) → new occurrence → fail (2) → `needs-human`.

### 6.2 Operations

- **claim**: post `errmeter:claim ref=new expires=<board now + ttlSec>` → re-read all comments → if holder: add label `errmeter:claimed`, return `{ won: true, claimRef: <own comment id> }`; else delete **exactly the comment id just created** (fallback: post `errmeter:release` for it), return `{ won: false }`.
- **renew**: post `errmeter:claim ref=<claimRef> expires=<board now + ttlSec>`. Counts as renewed **only** on a 2xx response. Renewed every `renew_sec`; `renew_sec` MUST be ≤ `claim_ttl_sec / 3`.
- **release**: post `errmeter:release ref=<claimRef>`; remove label.
- **fence** (the rule that prevents two hooks): the hook always has an **absolute deadline** `D = expires − kill_grace_sec` (board time; the runner keeps **both** a monotonic deadline `hrtime_now + (D − board_now)` and a wall-clock deadline `Date.now() + (D − board_now)` and kills at whichever expires **first** — a forward wall-clock step or a suspend/resume that the monotonic clock did not count is caught by the wall clock, a backward NTP step is caught by the monotonic clock; `kill_grace_sec` (30) is the budget for residual rate drift within one lease, which is orders of magnitude above ppm-class drift over 15 minutes), and a duration cap `timeout_sec`. It is killed at `min(spawn + timeout_sec, D)`, and earlier if a renew fails or is not confirmed by `expires − renew_sec`. A renewed claim moves `expires` and therefore `D` forward; the watcher re-arms the deadline on every confirmed renew. The deadline is enforced by the **runner** (§9: `errmeter _run`), a tiny wrapper that is the hook's parent and process-group leader and that survives the watcher's death — so an orphan hook dies at `D` even if the watcher hard-crashed the instant after spawning. `dispatch.timeout_sec ≤ claim_ttl_sec − kill_grace_sec` is still validated at startup so the duration cap never exceeds a single lease. Watcher restart additionally kills any pid recorded in `state/dispatch/*.json` before its first tick.

Defaults [default]: `claim_ttl_sec` 900 · `renew_sec` 180 · `kill_grace_sec` 30 · `dispatch.timeout_sec` 840 (families with long repairs raise both together) · `escalate_after` 2 · `max_concurrent` 1.

Worst-case with these defaults: a watcher that hard-crashes leaves the Issue idle until `expires` (≤ `claim_ttl_sec`) before takeover — a *gap*, never an *overlap*, because the orphan is dead at `D < expires` by construction.

---

## 7. Configuration [frozen keys, default values]

File: `ERRMETER_CONFIG` → else `<home>/config.json`. JSON, no comments. **Secrets are never in this file and never in environment variables except `ERRMETER_GITHUB_TOKEN`**; notify secrets are file-only.

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
    "role": "watcher",
    "watcher_id": "vps-1",
    "interval_sec": 60,
    "claim_ttl_sec": 900,
    "renew_sec": 180,
    "max_concurrent": 1,
    "escalate_after": 2,
    "heartbeat_gap_sec": 900,
    "watcher_gap_sec": 600,
    "renotify_sec": 21600,
    "gaps": { "nora@vps-1": 3600 },
    "dispatch": { "command": ["node", "/opt/family/repair.js"], "timeout_sec": 840, "cwd": "/opt/family", "pass_env": ["PATH", "HOME", "LANG", "TMPDIR", "TEMP", "SYSTEMROOT", "USERPROFILE"] }
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

Environment variables read [frozen names]: `ERRMETER_HOME`, `ERRMETER_CONFIG`, `ERRMETER_AGENT`, `ERRMETER_GITHUB_TOKEN`, `ERRMETER_LOG_LEVEL`. No other variable is read.

`~` in `*_file` expands to `os.homedir()`. One `sink` (D-3). `notify` entries are tried in order, all sent (best effort). `watch.role`: `watcher` (full loop) or `agent-host` (flush + own heartbeat + dead-man only; no claim/dispatch/gap). Unknown `type`/`role` fails at flush/watch startup, never at emit. `init` writes this file and refuses to overwrite without `--force`.

---

## 8. Token and permission boundary [frozen]

- Board token: GitHub **fine-grained** PAT (or an installation token the family manages) with access to **the inbox repo only**, permissions **Issues: Read and write**, **Metadata: Read**. Nothing else.
- Source: `ERRMETER_GITHUB_TOKEN` → else `sink.token_file`. POSIX: file mode MUST be `0600` or stricter (`EPERM_TOKEN_FILE_MODE` otherwise). Windows: mode check is not available through `fs.stat`; errmeter warns once and relies on the user profile ACL. This is one of the three platform-specific behaviours allowed by N-4.
- `init --check` / `status --check` verify **positively** what errmeter needs: `GET /repos/{repo}`, `GET /repos/{repo}/issues?per_page=1`, creating the errmeter labels (`POST /repos/{repo}/labels`, idempotent on 422 already-exists), and creating+closing one probe Issue titled `[errmeter] probe` (proves Issues write). They **also** probe `GET /repos/{repo}/contents/` and `GET /repos/{repo}/pulls?per_page=1`: a `200` is reported as **over-scoped** (warning). A `403`/`404` is *consistent with* least privilege but is **not proof** — an empty repo returns 404 even with Contents read; the authoritative check is the human checkpoint #2 in EPIC #1 (owner looks at the token's permission page). The output says exactly this.
- The token string is added to the mask list after loading. It is **not** passed to the dispatch hook (§9 env allowlist), not written to any file errmeter creates, and never logged.
- Notify secrets: file-only, same `0600` rule, same mask-list treatment.

---

## 9. Dispatch hook contract [frozen] (D-5, D-6)

Invocation by `watch --role watcher` after `claim` returned `won: true`:

- The watcher spawns the **runner**: `node bin/errmeter.js _run --deadline-ms <wall-clock ms epoch> --deadline-mono-ms <ms from now> --timeout <sec> --state <home>/state/dispatch/<issue>.json -- <command...>` with `{ detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'], windowsHide: true }`. The runner spawns the hook (`shell: false`, same stdio), records both pids in the state file, and **kills the hook tree at the earliest of: the wall-clock deadline, the monotonic deadline, the timeout — regardless of whether the watcher is still alive** (§6.2 explains why two clocks). The watcher re-arms the runner's deadline after each confirmed renew by writing the new deadline into the state file (the runner re-reads it every 5 s; a missing or unparsable file means "keep the current deadline"). POSIX: the runner is a process-group leader (`detached: true`) and kills the group; Windows: `taskkill /PID <hook pid> /T /F`. (Platform-specific behaviour #2 allowed by N-4.)
- **env**: **not inherited**. Built from `pass_env` (config; default list in §7) copied from the watcher's environment, plus: `ERRMETER_ISSUE_NUMBER`, `ERRMETER_ISSUE_URL`, `ERRMETER_AGENT`, `ERRMETER_HOST`, `ERRMETER_FINGERPRINT`, `ERRMETER_EVENT_FILE`, `ERRMETER_WATCHER_ID`, `ERRMETER_CLAIM_EXPIRES` (ISO). `ERRMETER_HOME`, `ERRMETER_GITHUB_TOKEN`, and every `ERRMETER_*` not listed here are never passed.
- **stdin**: the dispatch payload JSON, then EOF. `ERRMETER_EVENT_FILE`: the same JSON at `<home>/state/dispatch/<issue>.json` (also records `pid` for restart cleanup).
- Payload:

```json
{
  "schema": 1,
  "issue": { "ref": 42, "url": "https://github.com/owner/errmeter-inbox/issues/42", "title": "...", "occurrences": 7, "first_ts": "...", "last_ts": "..." },
  "latest": { "schema": 1, "id": "...", "ts": "...", "kind": "error", "agent": "...", "host": "...", "message": "...", "detail": "...", "fingerprint": "...", "fpv": 1, "meta": {} },
  "attempt": 1,
  "watcher_id": "vps-1",
  "claim_expires": "2026-09-05T13:22:41Z"
}
```

`latest` is the full §2 object inline, reconstructed from the fenced JSON block of the newest occurrence (or the Issue body).

- **Exit code** `0` = repair attempted; the **last non-empty stdout line** (redacted, ≤ 500 chars) is the outcome summary (a PR URL by convention). Any other exit, a timeout (`timeout_sec`; kill = `SIGTERM` to the group, `SIGKILL` after 10 s; Windows `taskkill /T /F`), a fence kill (§6.2), or a spawn error = `dispatch-failed`; the last 20 lines of stderr are recorded **after redaction**.
- After `escalate_after` consecutive failures: label `errmeter:needs-human`, owner notified once via `upsertAlert` key `needs-human:<issue>`.
- **Boundary (D-6)**: the hook MAY open pull requests and comment in target repos with its own credentials. It MUST NOT merge, push to protected branches, or close the inbox Issue; `repaired` means "a fix was proposed". errmeter cannot police the hook's credentials; this rule is restated in `docs/integrations/` for hook authors. errmeter's own token structurally cannot do any of these (§8). **Process boundary, stated honestly**: the hook runs as the watcher's OS user and can read whatever that user can, including `<home>/github-token`. errmeter does not hand the token over, but it cannot hide it from a same-user process; families that need that isolation run `watch --role watcher` under a dedicated OS user with its own home (documented in `docs/integrations/`).

---

## 10. Node.js 18 floor [frozen]

Two lists, different meanings. #7's matrix tests the first; lint/review enforces the second.

**A. Not available or experimental at Node 18.0 — MUST NOT be used** (using them breaks on the floor): global `fetch` / `Request` / `Response` (ExperimentalWarning on 18), `util.parseArgs` (18.3), `node:test` `describe`/`it` (18.7 — tests use `test()` only) and `mock.timers` (20), `fs.cpSync` (experimental), `Array.prototype.{toSorted,toReversed,with,toSpliced}` (20), `Object.groupBy` / `Map.groupBy` (21), `Set.prototype.{union,intersection,…}` (22), `Promise.withResolvers` (22), `String.prototype.isWellFormed` (20), RegExp `v` flag (20), `node:sqlite` (22), `Array.fromAsync` (22), `--experimental-*` flags, `--env-file` (20).

**B. Available at 18 but prohibited by project policy** (simplicity, zero build): ESM `import`/`export` in `src/` and `bin/` (CommonJS only, so a single `node bin/errmeter.js` works with no `type` field games), TypeScript, any `dependencies`/`devDependencies`, `structuredClone` on non-plain data, `worker_threads`, native addons.

Allowed and expected: `node:fs` (incl. `promises`, `rmSync`, `mkdirSync({recursive})`, `renameSync`, `openSync` with `wx`), `node:path`, `node:os`, `node:crypto` (`randomUUID`, `createHash`), `node:https`/`node:http`, `node:child_process` (`spawn`, `execFile`), `node:util` (except `parseArgs`), `node:test` `test()` + `node:assert` (tests only), `node:events`, `node:stream`, `node:readline`, `node:url`, `AbortController`, optional chaining, nullish coalescing, class fields, `Array.prototype.at`, `Object.hasOwn`, `String.prototype.replaceAll`. Anything available in 18.0 and not in list B is permitted.

`package.json` `engines.node` = `">=18"`. `bin/errmeter.js` starts with a version guard (exit 2 below 18).

---

## 11. CLI surface [frozen names and exit codes]

`errmeter <command> [flags]`. Global: `--home <dir>`, `--config <file>`, `--json`, `--quiet`, `--version`, `--help`.

| command | flags | exit codes |
|---|---|---|
| `emit` | `--agent`, `--kind error\|heartbeat` (default `error`), `--message <text>`, `--detail-file <path>` \| `--detail -` (stdin), `--tail <n>`, `--task`, `--meta k=v` (repeatable), `--no-flush` | `0` after the spool write succeeded (incl. fallback and counter mode); `2` usage error only |
| `flush` | `--dry-run` (list the board writes it would make — groups, counts, target refs — and touch nothing: no lock, no network write, no spool move; reads are allowed) | `0` nothing pending remains; `1` some remain (transient/busy/lookup incomplete); `2` usage error only; `3` config/token error |
| `watch` | `--role watcher\|agent-host` (default from config), `--once` (single tick), `--interval <sec>` | runs until signal; `--once` returns `0`/`1`/`3` like flush |
| `init` | `--repo`, `--family`, `--host`, `--role`, `--force`, `--check` | `0` ok (warnings printed for over-scope); `3` token/permission problem (names the failing probe); `4` refused to overwrite |
| `status` | `--check` (network), `--notify-test` | `0` healthy; `1` degraded (pending > soft limit, last flush failed, gap present, zero watcher heartbeats known); `3` cannot check |
| `install` / `uninstall` | `--role`, `--dry-run`, `--user\|--system` | defined in #6 within these exit-code meanings |
| `_run` (internal) | `--deadline-ms <ms>`, `--deadline-mono-ms <ms>`, `--timeout <sec>`, `--state <file>`, `-- <command...>` | exit code of the hook; `124` on timeout/deadline kill; `125` spawn error. Not part of the public surface; may change without a version bump. |

Output: without `--json`, one summary line on stdout, diagnostics on stderr. With `--json`, one JSON object on stdout.

---

## 12. Test hooks (non-normative, for #3–#7)

- `ERRMETER_HOME` pointed at a temp dir isolates every test.
- The `file` sink is the reference board for `watch`/`claim` unit tests; `github-issue` is tested against a local `node:http` fake implementing: `GET /repos/:r`, `GET/POST/PATCH /repos/:r/issues*`, `GET/POST /repos/:r/issues/:n/comments` (with `Link` pagination), `DELETE /repos/:r/issues/comments/:id`, `POST /repos/:r/labels`, `GET /repos/:r/contents/`, `GET /repos/:r/pulls`, and a `Date` header on every response.
- Fixtures: `test/fixtures/redact/*.txt` + `.expected`; `test/fixtures/fingerprint.json` = the §2.1 vector table.

---

## Changelog

- v1.7 note (2026-09-05, #4): flush returns 2 for a usage error (was unspecified); no other change.

- v1.7 note (2026-09-05, #12): clarify heartbeat file-name encoding, overflow heartbeat sentinels, and reserved metadata outside the 16-entry cap; no field or format change.

- **v1.7 (2026-09-05)** after round-7 confirmation (Codex NO-GO on one item): cut checkpoint persists the active pass's `end` offset, fixed at pass open, so bytes arriving after it always belong to the next pass (Codex's stated condition applied verbatim).

- **v1.6 (2026-09-05)** after round-6 confirmation (Codex NO-GO on two text items): durable per-cut checkpoint `state/cuts/<nonce>.json` with a recovery algorithm mapping every byte to exactly one `k`; `max_heartbeat_files` and `overflow_guard_bytes` make every term of the spool bound a configured cap (≈ 1.12 GB).

- **v1.5 (2026-09-05)** after round-5 confirmation (Codex NO-GO on two text items): tail deliveries of a cut use `counter_ref=<nonce>.<k>` so re-read tails are never omitted; second residual loss case (crash between late append and re-append) named; ceiling overshoot quantified; `sent_max_bytes` / `dead_max_bytes` / `log_max_bytes` added and the **total** spool bound stated (≈ 1.1 GB worst case).

- **v1.4 (2026-09-05)** after round-4 confirmation (GLM GO, Codex NO-GO): overflow-log cut made race-free in practice (append-then-verify `nlink` check on the emit side, `cut_settle_sec` wait + re-read-until-stable before delete on the flush side, at most one cut file) with the residual stated; explicit spool ceiling `overflow_max_bytes` = the single documented loss boundary, surfaced as an alert; duplicate-Issue reconciliation is itself a lowest-id election; overflow line bound corrected to 320 B hard-truncated (GLM NIT).

- **v1.3 (2026-09-05)** after round-3 confirmation (Grok GO, GLM GO-WITH-MINOR, Codex NO-GO): counter mode rewritten as an append-only overflow log cut by rename (no lock, no lost increment, no file growth, idempotent by cut nonce — replaces the locked JSON counter and its unbounded compact fallback); id migration posts only ids absent from the canonical Issue (re-entry safe); alert creation re-lists after create and the winner-crash cover is itself an election; runner enforces the earliest of wall-clock and monotonic deadlines (suspend/resume and NTP steps both covered); R-F2 states the retry guarantee precisely (loop = unbounded; no loop = linger + next emit).

- **v1.2 (2026-09-05)** after round-2 delta review (Gemini GO, Muse GO, Grok GO-WITH-MINOR, GLM NO-GO, Codex NO-GO): consecutive-failure count no longer reset by occurrences (`needs-human` was unreachable — found independently by GLM and Codex); absolute deadline enforced by an `_run` runner that survives watcher death (1-second overlap at spawn delay); counter increments under a `wx` lock with compact-file fallback + counter idempotency key; heartbeat files upserted in counter mode; duplicate-Issue id migration before close; Issue rollover at 400 comments; alert Issue reconciliation + winner-crash cover; emit-spawned flush lingers up to 1 h for autonomous retry; `deliverHeartbeat` lookup order; all `*_file` credentials in the mask list; same-user process boundary stated. Owner decision requested on N-4 (three named platform branches vs the brief's literal "only boot registration").

- **v1.1 (2026-09-05)** after round-1 five-seat review (GLM 5.3 / Gemini 3.8 Flash / Muse Spark 1.3 / Grok 4.6 / Codex GPT-5.6 Sol, all NO-GO): fence rule + `timeout ≤ ttl − grace` + board-time clock (W3); `repaired` not re-dispatched until a new occurrence; alerts board-first single-winner + empty-set rule + `agent-host` role so the dead-man has a periodic trigger (W4); no capacity eviction — compact/counter modes (W2); `ids=` on every marker + duplicate-Issue reconciliation + lookup fail-closed on incomplete listing (W2); notify secrets file-only, hook env allowlist, redaction of hook output and logs, emit masks the token (W1); fingerprint v1 rewritten with vectors; sink types frozen; heartbeat liveness from marker `ts`; pagination/budget rules; §10 split into "absent at 18" vs "policy"; lock steal via atomic rename; Windows rename note; N-4 wording aligned (three named platform branches).
