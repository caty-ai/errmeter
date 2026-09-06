#!/usr/bin/env bash
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 3
exec bash "$ROOT/errmeter-hooks-install.sh" --mode status "$@"
