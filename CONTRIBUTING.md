# Contributing

Run the installed Node.js 18, 20, 22 and 24 releases locally before submitting:

```sh
bash scripts/test-matrix.sh
```

On Windows (PowerShell 5.1+ or 7, with Bash available for the static check):

```powershell
powershell -NoProfile -File scripts/test-matrix.ps1
# Or: pwsh -NoProfile -File scripts/test-matrix.ps1
```

The scripts select the newest installed release of each requested major using
nvm (nvm-windows on Windows), fnm, or Volta. Bash also scans
`~/.nvm/versions/node` when no manager is available. They never install or
download Node. Missing versions print an installation hint and fail the matrix.

Use `MATRIX_VERSIONS="18 22"` in Bash, or `$env:MATRIX_VERSIONS = "18 22"`
in PowerShell, for a focused check. `--json` emits the table as a JSON array.
`--allow-missing` allows absent versions for local exploration; its output
**is not merge evidence**. When every requested major is absent and a Node
runtime is available for the static check and that check passes, an
`--allow-missing` run reports `Matrix: INCOMPLETE` (exit 0) instead of PASS,
since no requested major was actually run. Exit codes are 0 for success, 1 for failed
tests, static violations or missing versions, and 2 for usage/setup errors
(bad flags, an empty `MATRIX_VERSIONS`, no test files found, or, in PowerShell,
a resolved `bash` that is not Git Bash (WSL/Cygwin)) -- missing majors alone
never raise exit 2.

The `CI:` line of a PR completion record must include the pasted Markdown
matrix table from `scripts/test-matrix.sh` (or `.ps1`), with **all four majors
green plus the `check-node18` row**. Put the table immediately below `CI:`.
Focused or `--allow-missing` runs do not satisfy this requirement.

GitHub Actions is intentionally not used (owner constraint). Run the matrix on
a VPS or a developer machine and paste its evidence into the PR.

The deny list in `scripts/check-node18.sh` mirrors the two lists in
[the contract, section 10](docs/contract.md#10-nodejs-18-floor-frozen):
A covers APIs absent or experimental at Node 18.0; B covers project policy.
Run it separately with `bash scripts/check-node18.sh`. Its comments name the
grep limitations that still require review, including array `.with()` and
heuristic regex flag detection. See docs/contract.md §12 for isolated test
hooks.

Tests are discovered recursively under `test/` (explicit file list, not the
directory form, which fails on Node 22+), so any `*.test.js` file counts
regardless of nesting. A `*.test.js` file that exits (e.g. `process.exit`)
before defining any `test()` still counts as one passing file in node:test's
summary; the matrix checks aggregate pass/fail counts, not individual files.
Reviewers should also compare the `tests` column against the previous
record -- a drop (e.g. 41 to 1) with an otherwise-green row is a red flag
the matrix cannot catch on its own.

The `.ps1` path is unverified on Windows from this macOS worktree; treat its
table as evidence only once someone has actually run it on a real Windows
host.

## Publication gate

Run `python3 -B tools/check_publication_gate.py --root . --account-slug shojikumaru --no-registry` before publication. `npm test` runs this local gate too (Python 3.9+; clearly skipped only when `python3` is absent).
