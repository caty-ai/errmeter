#!/usr/bin/env bash
# Run one job, preserve its exit status, and report its outcome to errmeter.
# Deliberately no `set -e`: failures must reach the error emit.
set -uo pipefail

usage() {
  echo "usage: with-errmeter.sh <job> -- <command> [args...]" >&2
  exit 2
}

job=${1:-}
[ -n "$job" ] && [ "${2:-}" = "--" ] && [ "$#" -ge 3 ] || usage
shift 2

agent=$(printf '%s' "$job" | LC_ALL=C tr '[:upper:]' '[:lower:]')
case "$agent" in
  ''|*[!a-z0-9._/-]*) echo "with-errmeter.sh: invalid job name" >&2; exit 2 ;;
esac
[ "${#agent}" -le 64 ] || { echo "with-errmeter.sh: job name is longer than 64 characters" >&2; exit 2; }

stderr_file=$(mktemp "${TMPDIR:-/tmp}/errmeter-stderr.XXXXXX") || exit 3
trap 'rm -f "$stderr_file"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

"$@" 2>"$stderr_file"
rc=$?
cat "$stderr_file" >&2

if command -v errmeter >/dev/null 2>&1; then
  if [ "$rc" -eq 0 ]; then
    errmeter emit --kind heartbeat --agent="$agent" --task="$job" >/dev/null 2>&1 || true
  else
    errmeter emit --kind error --agent="$agent" --message="exit $rc" \
      --task="$job" --tail=40 --detail-file="$stderr_file" >/dev/null 2>&1 || true
  fi
fi
exit "$rc"
