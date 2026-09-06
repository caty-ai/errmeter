# Heartbeats and silence

Every producer can emit:

```bash
errmeter emit --kind heartbeat --agent nightly
errmeter emit --kind heartbeat --agent host-agent --meta role=agent-host
```

Use `meta.role=watcher` for watcher-role heartbeats, `meta.role=agent-host` for agent-host loops, and leave it absent for ordinary jobs. The role controls board categorization. The host is config `host` or the lower-cased short OS hostname; `--meta host=...` is informational and does not override that identity.

Laptops can run `errmeter watch --role agent-host`: it flushes and sends host heartbeats without claiming work or running repair hooks. `errmeter install --role agent-host` registers that loop with launchd on macOS, systemd on Linux, or Task Scheduler on Windows. This CLI install is separate from the host-hook installer; `errmeter init` establishes configuration and board setup first. Watchers run `watch --role watcher` with the dedicated-user boundary in the [index](README.md).

`watch.heartbeat_gap_sec` sets the default silence threshold; `watch.gaps` supplies per-agent overrides, and watcher heartbeats use `watcher_gap_sec`. Choose gaps longer than expected schedule intervals, including sleep/offline periods. A producer must first send a heartbeat before its absence is observable. Detecting never-registered jobs belongs to the fma registration-gap check, not an errmeter registration scanner.

Read `[errmeter] heartbeat: <agent>@<host>` Issues for last-seen state and role labels. Heartbeats upsert those records instead of opening a new Issue every time. `errmeter status` reports local spool counts, last flush, watcher/install state and config; `errmeter status --check` additionally probes board/credential access. A successful local emit does not mean the board was updated: pending events may wait for network recovery. Coordinate any live `--check` with the host administrator because permission probes can write labels and a temporary probe Issue.
