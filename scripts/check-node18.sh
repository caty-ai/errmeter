#!/usr/bin/env bash
# Mirrors docs/contract.md section 10: A = Node 18.0 floor; B = policy.
set -euo pipefail
cd "$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

failed=0
scan() {
  local pattern matches match status
  while IFS= read -r pattern; do
    [ -n "$pattern" ] || continue
    status=0
    matches=$(grep -rnE -- "$pattern" "$@") || status=$?
    if [ "$status" -eq 0 ]; then
      while IFS= read -r match; do
        # Replace source text with the deny pattern; retain path and line.
        printf '%s: %s\n' "$(printf '%s\n' "$match" | cut -d: -f1-2)" "$pattern"
      done <<< "$matches"
      failed=1
    elif [ "$status" -ne 1 ]; then
      printf 'check-node18: grep failed (status %s)\n' "$status" >&2
      failed=1
    fi
  done
}

# A. One expression per entry makes comparison with the contract straightforward.
# Array.prototype.with is skipped: .with() cannot identify an array by grep.
# Regex-v detection is heuristic: constructor flags and literal /v terminators
# (combined flags, e.g. /x/gv, are now covered); multiline/computed flags and
# computed properties still need human review.
# Grep also sees comments/strings, so inspect any reported false positives.
# Residual classes grep cannot catch (human review): bare-identifier aliasing
# (`const f = fetch;`, `const u = set.union;`), `describe`/`it` imported but
# not called, subclassing of Response/Request, and `globalThis["fetch"]`
# string indexing.
scan src bin <<'PATTERNS'
(^|[^[:alnum:]_$])fetch[[:space:]]*\(
new[[:space:]]+Request[[:space:]]*\(
new[[:space:]]+Response[[:space:]]*\(
(^|[^[:alnum:]_$])(Request|Response)[[:space:]]*\.
(^|[^[:alnum:]_$])parseArgs([^[:alnum:]_$]|$)
mock[[:space:]]*\.[[:space:]]*timers
(^|[^[:alnum:]_$])cpSync([^[:alnum:]_$]|$)
\.[[:space:]]*toSorted[[:space:]]*\(
\.[[:space:]]*toReversed[[:space:]]*\(
\.[[:space:]]*toSpliced[[:space:]]*\(
Object[[:space:]]*\.[[:space:]]*groupBy
Map[[:space:]]*\.[[:space:]]*groupBy
\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(
Promise[[:space:]]*\.[[:space:]]*withResolvers
\.[[:space:]]*isWellFormed[[:space:]]*\(
\.[[:space:]]*toWellFormed[[:space:]]*\(
new[[:space:]]+RegExp[[:space:]]*\(.*,[[:space:]]*['"][a-z]*v[a-z]*['"]
/[dgimsuy]*v[dgimsuy]*([;,)[:space:]]|$)
node:sqlite
Array[[:space:]]*\.[[:space:]]*fromAsync
--experimental-
--env-file
PATTERNS

# A. package.json scripts values aren't run by the matrix; a banned flag
# hidden in a "scripts" entry (e.g. a pretest hook) would otherwise be
# unexercised. Grep can't scope to the "scripts" key, so this scans the
# whole file as a heuristic.
scan package.json <<'PATTERNS'
--experimental-
--env-file
PATTERNS

# A. Tests use test(), not the later describe()/it() API.
scan test <<'PATTERNS'
(^|[^[:alnum:]_$])(describe|it)[[:space:]]*\(
mock[[:space:]]*\.[[:space:]]*timers
PATTERNS

# B. structuredClone is conservatively banned: grep cannot prove plain data.
# TypeScript file extensions and native .node files are checked below as well;
# disguised TypeScript, dynamic addon loading and build steps need review.
# Dynamic import() is deliberately stricter than contract section 10 list B.
scan src bin <<'PATTERNS'
import[[:space:]]*\.[[:space:]]*meta
^[[:space:]]*import[[:space:]{*'"]
^[[:space:]]*export[[:space:]{*'"]
(^|[^[:alnum:]_$.])import[[:space:]]*\(
require[[:space:]]*\([[:space:]]*['"](typescript|ts-node(/[^'"]*)?|esbuild|tsx|@swc/[^'"]*)['"]
worker_threads
(^|[^[:alnum:]_$])structuredClone([^[:alnum:]_$]|$)
require[[:space:]]*\([[:space:]]*['"][^'"]*\.node['"]
PATTERNS

# JavaScript template literals deliberately remain literal shell text.
# shellcheck disable=SC2016
if ! node -e '
  const fs = require("fs");
  let failed = false;
  function violation(path, line, pattern) {
    console.log(`${path}:${line}: ${pattern}`);
    failed = true;
  }
  const text = fs.readFileSync("package.json", "utf8");
  const pkg = JSON.parse(text);
  function line(key) {
    let depth = 0;
    let lineNumber = 1;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (character === "\n") {
        lineNumber++;
      } else if (character === "{") {
        depth++;
      } else if (character === "}") {
        depth--;
      } else if (character === "\"") {
        const start = index;
        const keyLine = lineNumber;
        let escaped = false;
        for (index++; index < text.length; index++) {
          const stringCharacter = text[index];
          if (stringCharacter === "\n") lineNumber++;
          if (escaped) {
            escaped = false;
          } else if (stringCharacter === "\\") {
            escaped = true;
          } else if (stringCharacter === "\"") {
            break;
          }
        }
        let separator = index + 1;
        while (/\s/.test(text[separator])) separator++;
        if (depth === 1 && text[separator] === ":" &&
            text.slice(start, index + 1) === JSON.stringify(key)) {
          return keyLine;
        }
      }
    }
    return 1;
  }
  if (!pkg.engines || pkg.engines.node !== ">=18")
    violation("package.json", line("engines"), "engines.node must equal >=18");
  if (pkg.type === "module")
    violation("package.json", line("type"), "type must not be module");
  for (const key of ["dependencies", "devDependencies"])
    if (Object.prototype.hasOwnProperty.call(pkg, key))
      violation("package.json", line(key), `${key} key prohibited`);
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:[cm]?tsx?|node)$/.test(entry.name))
        violation(path, 1, "TypeScript/native addon file prohibited");
      else if (/\.(?:mjs|cjs)$/.test(entry.name))
        violation(path, 1, "Explicit ESM/CJS extension file prohibited (src/bin must be plain .js CommonJS)");
    }
  }
  walk("src");
  walk("bin");
  process.exitCode = failed ? 1 : 0;
'; then
  failed=1
fi

# NIT: contract section 10's last sentence requires this guard; grep for it
# directly since the deny-list scan above only looks for banned patterns.
if ! grep -q 'versions\.node' bin/errmeter.js 2>/dev/null || ! grep -q 'exit(2)' bin/errmeter.js 2>/dev/null; then
  printf 'bin/errmeter.js: version guard missing\n'
  failed=1
fi

if [ "$failed" -eq 0 ]; then
  printf 'check-node18: PASS\n'
fi
exit "$failed"
