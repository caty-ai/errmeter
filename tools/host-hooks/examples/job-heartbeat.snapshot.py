#!/usr/bin/env python3
# Snapshot of the upstream `scripts/job-heartbeat` the patch was generated against.
# The patch header records the blob hashes of the upstream file before and after the change.
"""Emit a standard automation-job heartbeat JSON file."""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import lib_atomic


DEFAULT_HEARTBEAT_DIR = "~/.claude/state/heartbeats"
PAUSE_DIR = ".paused"
JOB_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
CORE_PAYLOAD_KEYS = frozenset(("job", "last_run", "status", "fail_count", "duration_ms", "docs", "reason"))


class HeartbeatPausedError(Exception):
    """Raised when the watchdog pause interlock blocks heartbeat replacement."""


def expand_path(path_text):
    return Path(os.path.expandvars(os.path.expanduser(path_text)))


def utc_now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def non_empty_value(value):
    if value == "":
        raise argparse.ArgumentTypeError("must not be empty")
    return value


def iso_utc_timestamp(value):
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be an ISO-8601 UTC timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise argparse.ArgumentTypeError("must be an ISO-8601 UTC timestamp")
    return value


def read_fail_count(path):
    try:
        if path.exists():
            previous = json.loads(path.read_text(encoding="utf-8"))
            return int(previous.get("fail_count", 0))
    except (OSError, ValueError, TypeError):
        return 0
    return 0


def write_heartbeat(path, job, status, reason, docs, duration_ms, envelope=None):
    pause_marker = path.parent / PAUSE_DIR / f"{path.name}.pause.json"
    if pause_marker.exists() or pause_marker.is_symlink():
        raise HeartbeatPausedError(
            f"{job} is paused; refusing to overwrite heartbeat evidence "
            f"(re-arm with scripts/watchdog --resume {job})"
        )
    fail_count = read_fail_count(path)
    fail_count = 0 if status == "ok" else fail_count + 1
    payload = {
        "job": job,
        "last_run": utc_now_iso(),
        "status": status,
        "fail_count": fail_count,
        "duration_ms": int(duration_ms),
        "docs": int(docs),
    }
    if status == "fail":
        payload["reason"] = (reason or "failed")[:300]
    if envelope:
        payload.update({key: value for key, value in envelope.items() if key not in CORE_PAYLOAD_KEYS})
    lib_atomic.atomic_write_json(path, payload)


def heartbeat_dir(args):
    return expand_path(args.heartbeat_dir or os.environ.get("FMA_HEARTBEAT_DIR") or DEFAULT_HEARTBEAT_DIR)


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Emit a standard job heartbeat.")
    parser.add_argument("job_name")
    parser.add_argument("status", choices=("ok", "fail"))
    parser.add_argument("--reason")
    parser.add_argument("--docs", type=int, default=0)
    parser.add_argument("--duration-ms", type=int, default=0)
    parser.add_argument("--heartbeat-dir")
    parser.add_argument("--run-id", type=non_empty_value)
    parser.add_argument(
        "--origin",
        choices=("user", "scheduled", "continuation", "recovery", "subagent"),
    )
    parser.add_argument("--started-at", type=iso_utc_timestamp)
    parser.add_argument("--last-progress-at", type=iso_utc_timestamp)
    parser.add_argument(
        "--terminal-reason",
        choices=("completed", "no-progress", "budget", "infra", "blocked", "user-paused"),
    )
    parser.add_argument(
        "--error-class",
        choices=("deterministic", "transient", "degenerate", "context-overflow"),
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    base = heartbeat_dir(args)
    envelope = {
        payload_key: getattr(args, argument_name)
        for argument_name, payload_key in (
            ("run_id", "run_id"),
            ("origin", "origin"),
            ("started_at", "started_at"),
            ("last_progress_at", "last_progress_at"),
            ("terminal_reason", "terminal_reason"),
            ("error_class", "error_class"),
        )
        if getattr(args, argument_name) is not None
    }
    try:
        if not JOB_NAME_RE.fullmatch(args.job_name):
            rejected = args.job_name[:80]
            path = base / "_invalid-job.json"
            write_heartbeat(
                path,
                "_invalid-job",
                "fail",
                f"invalid job name rejected: {rejected!r}",
                args.docs,
                args.duration_ms,
                envelope,
            )
            return 1
        write_heartbeat(
            base / f"{args.job_name}.json",
            args.job_name,
            args.status,
            args.reason,
            args.docs,
            args.duration_ms,
            envelope,
        )
    except HeartbeatPausedError as exc:
        print(f"heartbeat write blocked: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"heartbeat write failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
