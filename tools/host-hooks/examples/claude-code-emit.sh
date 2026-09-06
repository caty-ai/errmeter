#!/usr/bin/env bash
# Claude Code hook: report a tool failure without ever failing the hook.
set -u

agent_user=$(printf '%s' "${USER:-}" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C sed 's/[^a-z0-9._\/-]/-/g')
[ -n "$agent_user" ] || agent_user=unknown

if [ "${ERRMETER_HOOKS_DISABLE:-0}" = "1" ]; then
  cat >/dev/null 2>&1 || true
  exit 0
fi
if ! command -v errmeter >/dev/null 2>&1; then
  cat >/dev/null 2>&1 || true
  exit 0
fi
if [ "${1:-}" = "--heartbeat" ]; then
  errmeter emit --kind heartbeat --agent "claude-code/$agent_user" >/dev/null 2>&1 || true
  exit 0
fi
umask 077
payload_file=$(mktemp "${TMPDIR:-/tmp}/errmeter-hook.XXXXXX") || exit 0
trap 'rm -f "$payload_file"' EXIT
trap 'exit 0' HUP INT TERM
cat >"$payload_file" 2>/dev/null || exit 0

tool_name=$(node -e '
  let value = "tool";
  try {
    const parsed = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const candidate = parsed && typeof parsed.tool_name === "string" ? parsed.tool_name : "";
    // Only known tool labels reach message; arbitrary payload strings stay in detail.
    if (["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent"].includes(candidate)) value = candidate;
  } catch (_) {}
  process.stdout.write(value);
' "$payload_file" 2>/dev/null || printf 'tool')

session_id=$(node -e '
  let value = "";
  try {
    const parsed = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const candidate = parsed && typeof parsed.session_id === "string" ? parsed.session_id : "";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)) value = candidate;
  } catch (_) {}
  process.stdout.write(value);
' "$payload_file" 2>/dev/null || true)

args=(emit --agent "claude-code/$agent_user" --message "$tool_name failed" --detail -)
[ -n "$session_id" ] && args+=(--meta "session=$session_id")
errmeter "${args[@]}" <"$payload_file" >/dev/null 2>&1 || true
exit 0
