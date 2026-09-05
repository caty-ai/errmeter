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
**is not merge evidence**. Exit codes are 0 for success, 1 for failed tests,
static violations or missing versions, and 2 for usage/setup errors.

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
heuristic regex flag detection. See section 12 for isolated test hooks.

Tests use explicit globs (`node --test test/*.test.js`, plus
`test/sinks/*.test.js` when present); the directory form fails on Node 22+.
