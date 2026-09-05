# Written from the macOS errmeter issue-7 worktree; Windows execution is unverified
# here. Targets Windows PowerShell 5.1 and PowerShell 7; needs Git Bash for the
# shared check-node18.sh. Only installed executables are used; no downloads.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$allowMissing = $false
$jsonOutput = $false
foreach ($argument in $args) {
    if ($argument -eq '-h') { $argument = '--help' }
    switch -Exact ($argument) {
        '--allow-missing' { $allowMissing = $true }
        '--json' { $jsonOutput = $true }
        '--help' {
            Write-Output 'Usage: ./scripts/test-matrix.ps1 [--allow-missing] [--json]'
            Write-Output 'MATRIX_VERSIONS defaults to "18 20 22 24". Never installs Node.'
            Write-Output '--allow-missing output is not merge evidence. Git Bash is required.'
            exit 0
        }
        default { [Console]::Error.WriteLine("Unknown argument: $argument"); exit 2 }
    }
}

function Invoke-Captured([string]$Executable, [string[]]$Arguments) {
    # PS 5.1 turns native stderr into ErrorRecords; retain it without throwing.
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $Executable @Arguments 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
        return [pscustomobject]@{ Output = $output; Code = $code }
    } finally { $ErrorActionPreference = $savedPreference }
}
function Get-InstalledVersions([string[]]$Lines) {
    foreach ($line in $Lines) {
        foreach ($match in [regex]::Matches($line, '(?<![\d.])v?(\d+\.\d+\.\d+)(?![\d.\w-])')) {
            $match.Groups[1].Value
        }
    }
}
function New-Row([string]$Node, [string]$Result, [string]$Tests, [string]$Duration) {
    [pscustomobject][ordered]@{ Node = $Node; result = $Result; tests = $Tests; duration = $Duration }
}
function Get-Count([string[]]$Lines, [string]$Name) {
    $value = -1L
    foreach ($line in $Lines) {
        if ($line -match ('^(?:#|\u2139)\s+' + $Name + '\s+(\d+)\s*$')) {
            $value = [long]$Matches[1]
        }
    }
    return $value
}

$originalPath = $env:PATH
$originalColors = $env:NODE_DISABLE_COLORS
# PS 5.1's default console encoding can mangle the "\u2139" (ℹ) glyph in
# node:test's spec-reporter output, corrupting the pass/fail counts below.
$originalOutputEncoding = $null
try { $originalOutputEncoding = [Console]::OutputEncoding } catch {}
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
    [Console]::Error.WriteLine('Console output encoding could not be set; non-ASCII reporter counts may not parse.')
}
$exitCode = 2
$locationPushed = $false
try {
    $versionsText = $env:MATRIX_VERSIONS
    if ($null -eq $versionsText) { $versionsText = '18 20 22 24' }
    $majors = @($versionsText.Trim() -split '\s+' | Where-Object { $_ -ne '' })
    if ($majors.Count -eq 0) { throw 'MATRIX_VERSIONS must contain positive integer majors.' }
    foreach ($major in $majors) {
        if ($major -notmatch '^[1-9][0-9]*$') { throw "Invalid Node major: $major" }
    }
    Push-Location (Split-Path -Parent $PSScriptRoot)
    $locationPushed = $true
    if (-not (Test-Path 'scripts/check-node18.sh' -PathType Leaf)) { throw 'Missing scripts/check-node18.sh.' }
    # Probe Git Bash's well-known install path first: `Get-Command bash` can
    # resolve to WSL's System32 bash.exe instead, which cannot run the POSIX
    # check-node18.sh the way Git Bash does.
    $bashCommand = $null
    foreach ($programFiles in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $programFiles) { continue }
        $candidate = Join-Path $programFiles 'Git\bin\bash.exe'
        if (Test-Path $candidate -PathType Leaf) {
            $bashCommand = [pscustomobject]@{ Source = $candidate }
            break
        }
    }
    if ($null -eq $bashCommand) {
        $bashCommand = Get-Command bash -CommandType Application -ErrorAction SilentlyContinue
    }
    if ($null -eq $bashCommand) { throw 'Git Bash is required for check-node18.sh; add bash.exe to PATH.' }
    $bashPlatform = Invoke-Captured $bashCommand.Source @('-lc', 'uname -s')
    $bashSystem = ($bashPlatform.Output -join "`n").Trim()
    if ($bashPlatform.Code -ne 0 -or $bashSystem -notmatch '^(MINGW|MSYS)') {
        throw "Resolved bash is not Git Bash (uname -s: $bashSystem); WSL bash is the likely cause."
    }
    # Hard-code the contract glob invocation, not package.json scripts (another
    # lane owns them). Expand explicitly: PowerShell passes wildcards literally,
    # and `node --test test/` breaks on Node >=22. Recurse (not just test/ and
    # test/sinks/) so any *.test.js file is picked up regardless of nesting
    # depth -- parity with the .sh script's `find test -name '*.test.js'` fix
    # (a nested test file was previously silently skipped and the matrix
    # stayed green).
    $testFiles = @(Get-ChildItem -Path 'test' -Filter '*.test.js' -File -Recurse |
        Sort-Object FullName | ForEach-Object { $_.FullName })
    if ($testFiles.Count -eq 0) { throw 'No test/*.test.js files found.' }
    $manager = $null
    foreach ($candidate in @('nvm', 'fnm', 'volta')) {
        if ($null -ne (Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue)) {
            $manager = $candidate
            break
        }
    }
    if ($null -eq $manager) { throw 'No nvm-windows, fnm or volta found on PATH.' }
    $listArgs = @('list')
    if ($manager -eq 'volta') { $listArgs += @('all', '--format=plain') }
    $inventory = Invoke-Captured $manager $listArgs
    if ($inventory.Code -ne 0) { throw "$manager list failed: $($inventory.Output -join ' ')" }
    $inventoryLines = $inventory.Output
    if ($manager -eq 'volta') {
        # Volta also lists npm/yarn/package versions; only "runtime node@x.y.z"
        # lines from the plain-format inventory count.
        $inventoryLines = @($inventoryLines | Where-Object { $_ -match '^\s*runtime\s+node@(\d+\.\d+\.\d+)' })
    }
    $installed = @(Get-InstalledVersions $inventoryLines | Sort-Object { [version]$_ } -Descending -Unique)
    $managerRoot = ''
    switch ($manager) {
        'nvm' {
            $managerRoot = $env:NVM_HOME
            if (-not $managerRoot) {
                $rootResult = Invoke-Captured 'nvm' @('root')
                if ($rootResult.Code -ne 0) { throw 'nvm root failed.' }
                foreach ($line in $rootResult.Output) {
                    if ($line -match '^\s*Current Root:\s*(.+?)\s*$') { $managerRoot = $Matches[1] }
                }
            }
        }
        'fnm' {
            $managerRoot = $env:FNM_DIR
            if (-not $managerRoot) {
                $environment = Invoke-Captured 'fnm' @('env', '--json')
                if ($environment.Code -ne 0) { throw 'fnm env --json failed.' }
                $managerRoot = ($environment.Output -join "`n" | ConvertFrom-Json).FNM_DIR
            }
        }
        'volta' {
            $managerRoot = $env:VOLTA_HOME
            if (-not $managerRoot) { $managerRoot = Join-Path $env:LOCALAPPDATA 'Volta' }
        }
    }
    if (-not $managerRoot) { throw "Cannot resolve $manager installation directory." }
    $rows = @()
    $failed = 0
    $missing = 0
    $passed = 0
    $setupFailed = $false
    $pathNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
    $staticNode = $null
    if ($null -ne $pathNode) { $staticNode = $pathNode.Source }
    $env:NODE_DISABLE_COLORS = '1'
    foreach ($major in $majors) {
        $selected = @($installed | Where-Object { $_ -match ('^' + $major + '\.') } | Select-Object -First 1)
        if ($selected.Count -eq 0) {
            $missing++
            $rows += New-Row $major 'MISSING' '-' '-'
            $hint = "$manager install $major"
            if ($manager -eq 'volta') { $hint = "volta install node@$major" }
            [Console]::Error.WriteLine("Node ${major}: MISSING; install with: $hint")
            continue
        }
        $release = $selected[0]
        switch ($manager) {
            'nvm' { $nodePath = Join-Path $managerRoot "v$release/node.exe" }
            'fnm' { $nodePath = Join-Path $managerRoot "node-versions/v$release/installation/node.exe" }
            'volta' { $nodePath = Join-Path $managerRoot "tools/image/node/$release/node.exe" }
        }
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $result = 'FAIL'
        $counts = '-'
        if (Test-Path $nodePath -PathType Leaf) {
            $env:PATH = (Split-Path -Parent $nodePath) + [IO.Path]::PathSeparator + $originalPath
            $actual = Invoke-Captured $nodePath @('--version')
            if ($actual.Code -eq 0 -and ($actual.Output -join '').Trim() -eq "v$release") {
                # Keep the LAST resolved Node for the static check, matching
                # the .sh script (which reassigns `runtime` every iteration).
                $staticNode = $nodePath
                $run = Invoke-Captured $nodePath (@('--test') + $testFiles)
                $total = Get-Count $run.Output 'tests'
                $pass = Get-Count $run.Output 'pass'
                $fail = Get-Count $run.Output 'fail'
                # Parity with the .sh script: an unparseable count renders as
                # "?", not "-" (which is reserved for MISSING/unrun rows).
                $passText = if ($pass -ge 0) { $pass } else { '?' }
                $failText = if ($fail -ge 0) { $fail } else { '?' }
                $counts = "$passText passed, $failText failed"
                if ($run.Code -eq 0 -and $total -gt 0 -and $pass -gt 0 -and $fail -eq 0) {
                    $result = 'PASS'
                } else {
                    [Console]::Error.WriteLine("Node ${release}: test run failed or no valid nonempty summary.")
                    [Console]::Error.WriteLine($run.Output -join "`n")
                }
            } else { [Console]::Error.WriteLine("Node ${release}: executable version mismatch.") }
        } else { [Console]::Error.WriteLine("Installed Node executable is missing: $nodePath") }
        $watch.Stop()
        $duration = $watch.Elapsed.TotalSeconds.ToString('0.000', [Globalization.CultureInfo]::InvariantCulture) + 's'
        $rows += New-Row "$major (v$release)" $result $counts $duration
        if ($result -eq 'PASS') { $passed++ } else { $failed++ }
    }
    $env:PATH = $originalPath
    if ($null -ne $staticNode) {
        $env:PATH = (Split-Path -Parent $staticNode) + [IO.Path]::PathSeparator + $originalPath
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $check = Invoke-Captured $bashCommand.Source @('scripts/check-node18.sh')
        $watch.Stop()
        $checkResult = 'FAIL'
        if ($check.Code -eq 0) { $checkResult = 'PASS' }
        if ($check.Code -eq 2 -or $check.Code -eq 126 -or $check.Code -eq 127) { $setupFailed = $true }
        if ($check.Output.Count -gt 0) { [Console]::Error.WriteLine($check.Output -join "`n") }
        $rows += New-Row 'check-node18' $checkResult '-' ($watch.Elapsed.TotalSeconds.ToString('0.000', [Globalization.CultureInfo]::InvariantCulture) + 's')
    } else {
        [Console]::Error.WriteLine('No installed Node is available to run the static check.')
        $checkResult = 'SKIPPED'
        $rows += New-Row 'check-node18' $checkResult '-' '-'
    }
    $exitCode = 0
    if ($failed -gt 0 -or $checkResult -ne 'PASS' -or ($missing -gt 0 -and -not $allowMissing)) { $exitCode = 1 }
    if ($setupFailed) { $exitCode = 2 }
    if ($jsonOutput) {
        ConvertTo-Json -InputObject @($rows) -Depth 3
    } else {
        Write-Output '| Node | result | tests | duration |'
        Write-Output '| --- | --- | --- | --- |'
        foreach ($row in $rows) { Write-Output "| $($row.Node) | $($row.result) | $($row.tests) | $($row.duration) |" }
    }
    $matrixResult = 'PASS'
    if ($exitCode -ne 0) {
        $matrixResult = 'FAIL'
    } elseif ($missing -eq $majors.Count -and $majors.Count -gt 0) {
        $matrixResult = 'INCOMPLETE'
    }
    $summary = "Matrix: $matrixResult; $($majors.Count) majors requested; $missing missing; check-node18 $checkResult."
    if ($allowMissing) { $summary += ' --allow-missing: NOT merge evidence.' }
    if ($jsonOutput) { [Console]::Error.WriteLine($summary) } else { Write-Output $summary }
} catch {
    [Console]::Error.WriteLine("Setup error: $($_.Exception.Message)")
    $exitCode = 2
} finally {
    $env:PATH = $originalPath
    $env:NODE_DISABLE_COLORS = $originalColors
    if ($null -ne $originalOutputEncoding) {
        try { [Console]::OutputEncoding = $originalOutputEncoding } catch {}
    }
    if ($locationPushed) { Pop-Location }
}
exit $exitCode
