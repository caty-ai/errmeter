#!/usr/bin/env bash
# Local installed-runtime evidence; never installs or downloads Node.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
allow_missing=0
json=0
for arg in "$@"; do
  case "$arg" in
    --allow-missing) allow_missing=1 ;;
    --json) json=1 ;;
    --help|-h) echo 'Usage: test-matrix.sh [--json] [--allow-missing]'
      echo 'MATRIX_VERSIONS="18 20 22 24" selects installed majors. --allow-missing is not merge evidence.'; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done
versions=${MATRIX_VERSIONS-18 20 22 24}
if [[ ! $versions =~ ^[[:space:]]*[1-9][0-9]*([[:space:]]+[1-9][0-9]*)*[[:space:]]*$ ]]; then
  echo 'MATRIX_VERSIONS must be a nonempty whitespace-separated list of positive majors.' >&2; exit 2
fi
read -r -a majors <<< "$(printf '%s' "$versions" | tr '\n\t' '  ')"
manager=scan
nvm_script=${NVM_DIR:-$HOME/.nvm}/nvm.sh
[[ -s $nvm_script ]] || nvm_script=$HOME/.nvm/nvm.sh
if [[ -s $nvm_script ]]; then
  # nvm is third-party shell code; load without nounset and without switching Node.
  set +u
  # shellcheck disable=SC1090
  if source "$nvm_script" --no-use >/dev/null 2>&1 && command -v nvm >/dev/null; then manager=nvm; fi
  set -eu
fi
if [[ $manager == scan ]]; then
  if command -v fnm >/dev/null 2>&1; then manager=fnm
  elif command -v volta >/dev/null 2>&1; then manager=volta; fi
fi
# Numeric sort works with macOS sort (which lacks GNU sort -V).
newest() { sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1; }
resolve_node() {
  local major=$1 candidate version root
  case "$manager" in
    nvm|scan)
      root=${NVM_DIR:-$HOME/.nvm}/versions/node
      [[ $manager != scan ]] || root=$HOME/.nvm/versions/node
      version=$(for candidate in "$root"/v"$major".*/bin/node; do
        [[ -x $candidate ]] || continue
        candidate=${candidate%/bin/node}; candidate=${candidate##*/v}
        [[ $candidate =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && printf '%s\n' "$candidate"
      done | newest)
      [[ -z $version ]] || printf '%s\n' "$root/v$version/bin/node"
      ;;
    fnm)
      version=$(fnm list 2>/dev/null | sed -nE "s/.*v($major\.[0-9]+\.[0-9]+)([[:space:]].*)?$/\1/p" | newest) || return 2
      if [[ -n $version ]]; then
        # Exact installed version from the inventory; fnm exec does not install.
        fnm exec --using "$version" -- node -p 'process.execPath' || return 2
      fi
      ;;
    volta)
      root=${VOLTA_HOME:-$HOME/.volta}/tools/image/node
      version=$(for candidate in "$root"/"$major".*/bin/node; do
        [[ -x $candidate ]] || continue
        candidate=${candidate%/bin/node}; candidate=${candidate##*/}
        [[ $candidate =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && printf '%s\n' "$candidate"
      done | newest)
      [[ -z $version ]] || printf '%s\n' "$root/$version/bin/node"
      ;;
  esac
  return 0
}
install_hint() {
  case "$manager" in
    nvm) echo "Install separately: nvm install $1" >&2 ;;
    scan) echo "Install separately: install Node $1 via nvm/fnm/volta (no manager detected)" >&2 ;;
    fnm) echo "Install separately: fnm install $1" >&2 ;;
    volta) echo "Install separately: volta install node@$1" >&2 ;;
  esac
}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/errmeter-matrix.XXXXXX") || exit 2
trap 'rm -rf "$tmp"' EXIT
rows=$tmp/rows
: > "$rows"
status=0
missing=0
runtime=$(command -v node || true)
# Hard-code shell-expanded files: package.json belongs to another lane, and
# `node --test test/` breaks on Node >=22. Node itself need not expand globs.
# `find` (not a `test/**/*.test.js` glob) is used so any *.test.js file is
# picked up regardless of nesting depth -- a file under e.g. test/emit/ was
# previously silently skipped and the matrix stayed green -- and so this
# stays portable to bash 3.2 (macOS's default /bin/bash), which lacks
# globstar.
tests=()
while IFS= read -r -d '' file; do tests+=("$file"); done \
  < <(find test -name '*.test.js' -print0 | sort -z)
if [[ ${#tests[@]} -eq 0 || ! -f scripts/check-node18.sh ]]; then
  echo 'Setup error: test files and scripts/check-node18.sh are required.' >&2; exit 2
fi
for major in "${majors[@]}"; do
  if ! executable=$(resolve_node "$major"); then
    echo "Cannot inspect $manager installed versions for Node $major." >&2; exit 2
  fi
  if [[ -z $executable ]]; then
    printf '%s\tMISSING\t-\t-\n' "$major" >> "$rows"
    missing=$((missing + 1)); install_hint "$major"
    if [[ $allow_missing == 0 ]]; then status=1; fi
    continue
  fi
  runtime=$executable
  actual=$("$executable" --version 2>/dev/null) || actual=unknown
  start=$SECONDS
  result=FAIL
  passed=0
  failed=0
  if [[ $actual == v"$major".* ]]; then
    code=0
    PATH="$(dirname "$executable"):$PATH" NODE_DISABLE_COLORS=1 "$executable" --test "${tests[@]}" > "$tmp/test.log" 2>&1 || code=$?
    # Piped output is TAP on Node 18 and may be spec on newer releases.
    # File-level blind spot: a *.test.js file that exits (e.g. process.exit)
    # before defining any test() still counts as one passing file in
    # node:test's summary; only the aggregate counts below are checked.
    passed=$(sed -nE 's/^(#|ℹ)[[:space:]]+pass ([0-9]+).*/\2/p' "$tmp/test.log" | tail -n 1)
    failed=$(sed -nE 's/^(#|ℹ)[[:space:]]+fail ([0-9]+).*/\2/p' "$tmp/test.log" | tail -n 1)
    total=$(sed -nE 's/^(#|ℹ)[[:space:]]+tests ([0-9]+).*/\2/p' "$tmp/test.log" | tail -n 1)
    if [[ $code == 0 && ${failed:-unknown} == 0 && ${total:-0} -gt 0 && ${passed:-0} -gt 0 ]]; then result=PASS; fi
    if [[ $result == FAIL ]]; then cat "$tmp/test.log" >&2; fi
  else
    echo "Node $major resolved to unexpected runtime $actual ($executable)." >&2
  fi
  [[ $result == PASS ]] || status=1
  printf '%s\t%s\t%s passed, %s failed\t%ss\n' "$major ($actual)" "$result" "${passed:-?}" "${failed:-?}" "$((SECONDS - start))" >> "$rows"
done
if [[ -n $runtime ]]; then
  start=$SECONDS
  result=PASS
  check_code=0
  PATH="$(dirname "$runtime"):$PATH" bash scripts/check-node18.sh > "$tmp/static.log" 2>&1 || check_code=$?
  if [[ $check_code != 0 ]]; then result=FAIL; status=1; fi
  if [[ $check_code == 2 || $check_code == 126 || $check_code == 127 ]]; then status=2; fi
  cat "$tmp/static.log" >&2
  printf 'check-node18\t%s\t-\t%ss\n' "$result" "$((SECONDS - start))" >> "$rows"
else
  # No installed Node was found anywhere (not on PATH, nor any requested
  # major) -- this can only happen when every requested major is MISSING.
  # That is a missing-versions condition, not a usage/setup error: print
  # the accumulated evidence and fail with exit 1, not 2.
  echo 'No installed Node is available to run the static check.' >&2
  result=SKIPPED
  printf 'check-node18\tSKIPPED\t-\t-\n' >> "$rows"
  status=1
fi
majors_ran=$(( ${#majors[@]} - missing ))
if [[ $status == 0 ]]; then
  if [[ $majors_ran -eq 0 && ${#majors[@]} -gt 0 ]]; then
    matrix_label=INCOMPLETE
  else
    matrix_label=PASS
  fi
else
  matrix_label=FAIL
fi
summary="Matrix: $matrix_label; ${#majors[@]} majors requested; $missing missing; check-node18 $result."
if [[ $allow_missing == 1 ]]; then summary="$summary --allow-missing: NOT merge evidence."; fi
if [[ $json == 1 ]]; then
  if [[ -n $runtime ]]; then
    "$runtime" -e 'const fs=require("fs"); console.log(JSON.stringify(fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(line=>{const [Node,result,tests,duration]=line.split("\t");return {Node,result,tests,duration};}),null,2))' "$rows"
  else
    # Bash-only fallback: no Node executable is available to run the usual
    # JSON serializer.
    first=1
    printf '['
    while IFS=$'\t' read -r label res counts duration; do
      [[ $first == 1 ]] || printf ','
      first=0
      printf '\n  {\n    "Node": "%s",\n    "result": "%s",\n    "tests": "%s",\n    "duration": "%s"\n  }' \
        "$label" "$res" "$counts" "$duration"
    done < "$rows"
    printf '\n]\n'
  fi
  echo "$summary" >&2
else
  printf '| Node | result | tests | duration |\n| --- | --- | --- | --- |\n'
  while IFS=$'\t' read -r label result counts duration; do printf '| %s | %s | %s | %s |\n' "$label" "$result" "$counts" "$duration"; done < "$rows"
  echo "$summary"
fi
exit "$status"
