#!/usr/bin/env bash
# Codex notify adapter: preserve the previous notify program, then report to errmeter.
set -u

previous_notify=''
event=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --previous-notify)
      [ "$#" -ge 2 ] || exit 0
      previous_notify=$2
      shift 2
      ;;
    *)
      event=$1
      shift
      ;;
  esac
done

if [ -n "$previous_notify" ]; then
  node -e '
    const { spawnSync } = require("node:child_process");
    try {
      const command = JSON.parse(process.argv[1]);
      if (Array.isArray(command) && command.length && command.every(v => typeof v === "string")) {
        spawnSync(command[0], command.slice(1).concat(process.argv[2]), {
          stdio: "ignore", windowsHide: true, timeout: 30000
        });
      }
    } catch (_) {}
  ' "$previous_notify" "$event" >/dev/null 2>&1 || true
fi

[ "${ERRMETER_HOOKS_DISABLE:-0}" = "1" ] && exit 0
command -v errmeter >/dev/null 2>&1 || exit 0

agent_user=$(printf '%s' "${USER:-}" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C sed 's/[^a-z0-9._\/-]/-/g')
[ -n "$agent_user" ] || agent_user=unknown

errmeter emit --kind heartbeat --agent "codex/$agent_user" >/dev/null 2>&1 || true
is_failure=$(node -e '
  let failed = false;
  try {
    const value = JSON.parse(process.argv[1]);
    const type = typeof value.type === "string" ? value.type : "";
    const last = typeof value["last-assistant-message"] === "string" ? value["last-assistant-message"] : "";
    failed = /(?:fail|error)/i.test(type) || /(?:failed|failure|uncaught|fatal error)/i.test(last);
  } catch (_) {}
  process.stdout.write(failed ? "1" : "0");
' "$event" 2>/dev/null || printf '0')

if [ "$is_failure" = "1" ]; then
  printf '%s' "$event" | errmeter emit --agent "codex/$agent_user" \
    --message "Codex turn reported failure" --detail - >/dev/null 2>&1 || true
fi
exit 0
