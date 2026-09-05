# errmeter requirements (v1)

Status: **frozen candidate v1.2** for contract-freeze issue #2 (two review rounds folded in). Input: [design-brief-v0.md](design-brief-v0.md).
Companion documents: [architecture.md](architecture.md) (how the parts fit), [contract.md](contract.md) (the frozen interfaces).

Wording: **MUST / MUST NOT / SHOULD / MAY** are used in the RFC 2119 sense. Each requirement has a stable id (`R-*`, `N-*`, `X-*`) so reviews and Done-when records can point at it.

## 1. One-paragraph summary

errmeter is a small Node.js tool that lets every AI agent in a family *shout* when it fails (`emit`), keeps the shout on local disk so it is never lost (`spool`), delivers it to a bulletin board when the network allows (`flush` → `sink`), and lets any always-on machine pick it up, hand it to a repair agent, and tell a human when nobody is alive to repair (`watch`). GitHub is used only as a free bulletin board (Issues API). Nothing in errmeter runs on GitHub Actions or any paid CI.

## 2. Users and their stories

Three roles. One person or one machine can hold several roles.

### 2.1 Agent (the side that shouts)

An agent is any process that does work on behalf of the family: Claude Code, Codex CLI, OpenClaw, Hermes, a cron-like script, `sitter` itself. It runs on a laptop, a VPS, or a Windows box.

- **R-A1** As an agent, when I fail I run **one command** with the error text and I am done. I do not need to know who reads it, where the network is, or whether GitHub is up. (`errmeter emit`)
- **R-A2** As an agent, `emit` MUST NOT fail my own run. It MUST return exit 0 and return quickly (target: under 200 ms on a warm Node) even when the disk is nearly full, the network is down, or the config is missing. The only non-zero exit is a usage error on the command line itself.
- **R-A3** As an agent, I can send a *heartbeat* through the same command (`--kind heartbeat`) so that "I am alive" and "I failed" travel the same road. No second mechanism to install.
- **R-A4** As an agent, the tail of my log that leaves the machine is **redacted** (tokens, keys, passwords masked; home paths shortened; only the last N lines). I do not have to remember to do this myself.
- **R-A5** As an agent, I can attach a few key=value facts (task name, PR number, run id) so the repair side has context without reading my whole log.

### 2.2 Watcher (the side that looks, wakes, fixes)

A watcher is `errmeter watch` running on any always-on machine. Several watchers may run at once on different machines; all of them may go down.

- **R-W1** As a watcher, I wake up every interval, read the bulletin board, and for each unclaimed failure I try to **claim** it. Exactly one watcher wins a claim; the others move on.
- **R-W2** As a watcher, after claiming I run the family's **dispatch hook** (a command the family configures) with the failure as input, **under the claim lease** (the hook is killed if I lose or cannot renew the claim), and I write the outcome back to the board (attempted / repaired / failed, with the repair PR link if any). A record I marked repaired or failed is not dispatched again until the problem occurs again.
- **R-W3** As a watcher, if my dispatch dies or I die mid-way, my claim goes **stale** after a fixed time and another watcher may take it over. Nothing is stuck forever because one machine rebooted.
- **R-W4** As a watcher, I check heartbeats and raise a **gap alert** when an agent (including other watchers) has been silent longer than its allowed gap. Alerts are recorded on the board first and only one watcher per episode sends to the human channels (Telegram / Slack / generic webhook); they are not repeated every interval.
- **R-W5** As a watcher, I send my own heartbeat like any agent, so my death is visible to the others.
- **R-W6** As a watcher, I never run on GitHub-hosted compute and never require `gh`, `git`, or any package to be installed. I talk to the board with plain HTTPS.

### 2.3 Owner (the human of last resort)

- **R-O1** As the owner, I want to be told **only** when the automation cannot handle it: every watcher is silent, or a repair has failed and needs a human. Routine failures that were repaired automatically MUST NOT page me.
- **R-O2** As the owner, I can see the whole history in one place (the inbox repo's Issues): what failed, how often, who claimed it, what the repair did.
- **R-O3** As the owner, I decide the **auto-fix boundary**. v1: the dispatch hook may open a pull request; it MUST NOT merge. Merging is a human act.
- **R-O4** As the owner, installing on a new machine is one command that generates the OS-native "start at boot" registration (launchd / systemd / Task Scheduler) and one command that removes it. No manual plist / unit editing.
- **R-O5** As the owner, the token errmeter holds is scoped to the inbox repo and to Issues only. It never appears in logs, spool files, Issue bodies, or error output.
- **R-O6** As the owner, I can point the tool at a different board (a file, my own HTTP endpoint) without touching the code, and other families can use the tool without any reference to my family.

## 3. Functional requirements (cross-cutting)

- **R-F1 Durability before delivery.** Every emitted event is written to the local spool **before** any network is attempted. Delivery is a separate step (`flush`) that may run later, on the same machine.
- **R-F2 At-least-once delivery, idempotent sink.** A spooled event is retried until the sink accepts it; **no unacknowledged event is ever evicted for capacity** (above the hard limit, new events are folded into per-fingerprint counters — content is reduced, counts are kept; [contract §3.3](contract.md)). The sink MUST tolerate seeing the same event id twice (a crash between "sent" and "marked sent" is expected) and MUST NOT create a second Issue / second comment for the same event id.
- **R-F3 Storm folding.** Repeated failures with the same fingerprint (same agent, same first error line) go into **one** open Issue as comments. Many pending events with the same fingerprint in one flush pass are folded into one comment with a count. The board MUST NOT receive one Issue per retry loop iteration.
- **R-F4 Heartbeats do not create failure Issues.** A heartbeat updates a per-agent liveness record on the board (one Issue per agent, edited in place). Pending heartbeats for the same agent are coalesced to the latest one at flush time.
- **R-F5 Claims are visible and deterministic.** The claim protocol works with **one shared token** (all watchers appearing as the same GitHub user) and has a deterministic tie-break that every watcher computes the same way from board data alone.
- **R-F6 Dead-man switch.** If **all** watchers are silent, the owner is told by a path that does not depend on a watcher being alive. In v1 that path is the flush step, which runs after every emit and on every tick of any loop process — including the lightweight `watch --role agent-host` loop that any non-repairing machine can run. The alert is board-first with a single winner (one notification per episode, however many hosts notice), and an empty set of watcher records never alerts. Detection needs **at least one agent-host loop or one emitting agent alive**; if every machine is dead at once, nobody can shout (X-3). Details: [architecture.md §6](architecture.md).
- **R-F7 Bootstrapping the board.** One command (`errmeter init`) creates the labels the board needs, verifies positively that the token can read and write Issues on the inbox repo, and warns when it can see more than that (over-scope). Proof of least privilege is a human look at the token's permission page (EPIC #1 checkpoint #2), not an API probe.
- **R-F8 Status.** One command (`errmeter status`) shows, locally and without network if asked: spool depth, last successful flush, last error, watcher state.

## 4. Non-functional requirements

- **N-1 Runtime floor: Node.js 18.** No syntax, API, or flag newer than Node 18.0. The banned/allowed list is in [contract.md §10](contract.md). Verified on Node 18 / 20 / 22 / 24 by a script that runs on any machine (issue #7); **never** by GitHub Actions.
- **N-2 Zero dependencies.** `package.json` has no `dependencies` and no `devDependencies`. Tests use `node:test` and `node:assert`. No TypeScript, no build step, no bundler. What is in the repo is what runs.
- **N-3 No GitHub Actions / paid CI dependency.** The repo MAY carry no `.github/workflows/` at all in v1. Nothing in the runtime path calls the Actions API or expects a runner.
- **N-4 Three operating systems.** macOS, Linux, Windows (native, not only WSL). Paths, line endings, file locking, and process spawning MUST behave on all three. OS-specific code is limited to **three named branches**, all isolated under `src/platform/`: boot registration (`install`), process-tree termination of the dispatch hook, and the POSIX-only token-file mode check (Windows warns and relies on profile ACLs). Nothing else may branch on the platform.
- **N-5 No cron dependency.** `watch` loops by itself with `setTimeout`. `install` only registers "start this process at boot / keep it alive".
- **N-6 The spool never fails.** Writing the spool is the one thing that MUST work: if the configured home is unwritable, `emit` falls back to the OS temp dir and says so on stderr, but still exits 0. Spool writes are atomic (write temp, rename) so a crash never leaves a half-written event.
- **N-7 Bounded resources.** Spool size, per-event size, detail tail length, comments per Issue per hour, and API calls per flush pass all have configured caps with safe defaults. A storm degrades to "count folded into one comment", never to "disk full" or "rate-limited into silence".
- **N-8 Secrets stay home.** The board token is read from a `0600` file or from `ERRMETER_GITHUB_TOKEN`; notify secrets are **file-only**. Secrets are never written to any file errmeter creates, never passed to the dispatch hook (its environment is an allowlist), and are masked if they appear in any text that errmeter forwards — including hook stdout/stderr excerpts and errmeter's own log.
- **N-9 Redaction before egress.** All text that leaves the machine, and all text errmeter writes to the board or its log, passes the redactor ([contract.md §4](contract.md)). Redaction is applied at `emit` time so the spool on disk is already redacted; emit builds its mask list from the secret files it can read (without ever using them), so the board token is masked in the spool whenever emit runs as the token's owner.
- **N-10 Generic from day one.** No family name, host name, repo name, or person is hard-coded. Everything family-specific lives in the config file of that family. The tool repo (`caty-ai/errmeter`) is publishable as-is.
- **N-11 Sitter-level simplicity.** One executable (`bin/errmeter.js`), a handful of plain `.js` modules, one JSON config file, one home directory. A newcomer can read the whole runtime in an afternoon.
- **N-12 Observable without a debugger.** Every subcommand supports `--json` output for machines and prints one-line human summaries otherwise. Errors errmeter itself hits are written to `~/.errmeter/errmeter.log` (rotated by size) and, when it is a watcher, also emitted as its own events.

## 5. Out of scope for v1 (X-*)

- **X-1** Running anything on GitHub Actions, or any hosted CI, for any purpose (including tests and publishing gates; #7 and #9 solve these locally / on the VPS).
- **X-2** Metrics dashboards, time-series storage, charts. The board (Issues) is the record; `status` is the only view.
- **X-3** Detecting "the entire family is dead" (no loop process and no emitting agent left anywhere). This needs a third party (an external uptime pinger). v1 exposes enough (heartbeat Issues have a stable title and a `ts=` marker) for someone to point such a service at it; errmeter does not ship it.
- **X-4** Auto-merge of repair PRs, or any write to repositories other than the inbox. The dispatch hook is the family's own program and uses its own credentials; errmeter never lends its token to it.
- **X-5** Multi-tenant boards (several families sharing one inbox repo). One family = one inbox repo.
- **X-6** Log shipping. errmeter forwards a redacted tail of at most a few KB per event, not full logs. Full logs stay where the agent put them; the event carries a path or URL as `meta` if useful.
- **X-7** A web UI, a daemon protocol, sockets, or an HTTP server. Everything is files, HTTPS calls out, and child processes.
- **X-8** Replacing `sitter`. sitter watches a running job; errmeter records and routes what sitter (or anyone) reports. sitter's `on-fail` hook calling `errmeter emit` is the integration (#8).

## 6. Acceptance (how the Epic will be judged against this document)

| Done-when in EPIC #1 | Requirements it proves |
|---|---|
| Failure from any one agent becomes an Issue within 5 min and is claimed → dispatched automatically | R-A1, R-A2, R-F1, R-F2, R-F3, R-W1, R-W2, R-F5 |
| Emit while GitHub is unreachable; nothing lost after recovery (below the hard limit; counted above it) | R-F1, R-F2, N-6, N-7 |
| All watchers stopped → heartbeat-gap alert reaches the owner's Telegram (test setup: at least one `agent-host` loop or emitting agent with notify configured stays up) | R-W5, R-F6, R-O1 |
| Node 18/20/22/24 matrix green without Actions | N-1, N-2, N-3 |
| Publication gate and npm publish | N-10, N-11, R-O6 |
