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
caught_signal=''
forward_signal() {
  caught_signal=$2
  kill -s "$1" "$child" 2>/dev/null || true
}

exec 3<&0
"$@" <&3 2>"$stderr_file" &
child=$!
exec 3<&-
trap 'forward_signal HUP 129' HUP
trap 'forward_signal INT 130' INT
trap 'forward_signal TERM 143' TERM
wait "$child"
rc=$?
if [ -n "$caught_signal" ]; then
  trap '' HUP INT TERM
  wait "$child" 2>/dev/null || true
  rc=$caught_signal
fi
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
