# shellcheck shell=bash
# shellcheck disable=SC2154
errmeter emit --agent "sitter/${SITTER_AGENT:-unknown}" --message "${SITTER_EVENT:-fail}: ${SITTER_REASON:-}" --task "${SITTER_TASK:-}" --meta "run_id=${SITTER_RUN_ID:-}" --meta "project=${SITTER_PROJECT:-}" --detail - <<<"$payload" 2>/dev/null || true
