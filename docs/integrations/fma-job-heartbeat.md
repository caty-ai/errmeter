# fma job-heartbeat integration

The fma job-heartbeat integration connects a sibling project that writes per-job heartbeat files. Apply [the checked-in patch](../../tools/host-hooks/examples/job-heartbeat.patch) to the current fma checkout. It mirrors the heartbeat only after its local JSON file has been durably written: success emits `--kind heartbeat --agent=<job> --meta=host=<short-hostname>`; failure emits `--kind error --agent=<job> --message=<reason> --meta=host=<short-hostname> --meta=fail_count=<n> --task=<job>`. `ERRMETER_BIN` wins when set, otherwise `PATH` is searched; hosts without errmeter skip silently. The bounded `subprocess.run(..., check=False, timeout=10)` ignores emit exit failures and catches hostname, argument-building, launch and timeout errors, preserving fma operation. This single file covers all existing fma job callers on every host without per-job registration commands.

This unified diff is also available as the linked patch file:

```diff
diff --git a/scripts/job-heartbeat b/scripts/job-heartbeat
index b6e3da2..4156e15 100755
--- a/scripts/job-heartbeat
+++ b/scripts/job-heartbeat
@@ -5,6 +5,9 @@ import argparse
 import json
 import os
 import re
+import shutil
+import socket
+import subprocess
 import sys
 from datetime import datetime, timezone
 from pathlib import Path
@@ -81,6 +84,35 @@ def write_heartbeat(path, job, status, reason, docs, duration_ms, envelope=None)
     if envelope:
         payload.update({key: value for key, value in envelope.items() if key not in CORE_PAYLOAD_KEYS})
     lib_atomic.atomic_write_json(path, payload)
+    return payload
+
+
+def emit_errmeter(payload):
+    """Best-effort mirror of the durable local heartbeat into errmeter."""
+    try:
+        errmeter = os.environ.get("ERRMETER_BIN") or shutil.which("errmeter")
+        if not errmeter:
+            return
+        host = socket.gethostname().split(".", 1)[0].lower() or "unknown"
+        command = [
+            errmeter,
+            "emit",
+            "--kind",
+            "heartbeat" if payload["status"] == "ok" else "error",
+            f"--agent={payload['job']}",
+            f"--meta=host={host}",
+        ]
+        if payload["status"] == "fail":
+            command.extend(
+                [
+                    f"--message={payload.get('reason', 'failed')}",
+                    f"--meta=fail_count={payload['fail_count']}",
+                    f"--task={payload['job']}",
+                ]
+            )
+        subprocess.run(command, check=False, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
+    except (OSError, ValueError, subprocess.TimeoutExpired):
+        pass
 
 
 def heartbeat_dir(args):
@@ -142,7 +174,7 @@ def main(argv=None):
                 envelope,
             )
             return 1
-        write_heartbeat(
+        payload = write_heartbeat(
             base / f"{args.job_name}.json",
             args.job_name,
             args.status,
@@ -151,6 +183,7 @@ def main(argv=None):
             args.duration_ms,
             envelope,
         )
+        emit_errmeter(payload)
     except HeartbeatPausedError as exc:
         print(f"heartbeat write blocked: {exc}", file=sys.stderr)
         return 2
```

## How to verify

From the fma checkout, preview and apply the patch, then run one successful and one failed heartbeat:

```bash
git apply --check /path/to/errmeter/tools/host-hooks/examples/job-heartbeat.patch
git apply /path/to/errmeter/tools/host-hooks/examples/job-heartbeat.patch
python3 scripts/job-heartbeat integration-check ok
python3 scripts/job-heartbeat integration-check fail --reason 'integration check'
errmeter status
find "${ERRMETER_HOME:-$HOME/.errmeter}/spool/pending" -type f | wc -l
```

The pending count may rise briefly and fall as background flush delivers events; count alone does not prove failure if delivery is fast. For a deterministic local spool check, invoke `errmeter emit --kind heartbeat --agent integration-check --no-flush` and compare `pending/` before/after. After delivery, inspect the stable Issue title `[errmeter] heartbeat: <job>@<host>` and the error Issue for the failed check. The title uses errmeter config `host` or its short OS hostname; the added `meta.host` is informational and does not override event identity. Existing `run-with-heartbeat <job> -- <cmd>` callers continue returning the command exit code. The host-hook installer never applies this repository patch.

Registration-gap detection belongs in fma: its own scheduled check detects missing job registration, including jobs that have never emitted. Once that check reports through `scripts/job-heartbeat`, the integration carries its success, failure, and later silence into errmeter like every other fma job. Errmeter does not independently enumerate or repair cron/launchd registrations.
