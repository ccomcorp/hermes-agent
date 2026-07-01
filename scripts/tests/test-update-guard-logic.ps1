# Unit tests for Hermes update-guard decision logic.
# Tests the pure decision functions in Update-Guard-Helpers.ps1.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tests/test-update-guard-logic.ps1
# Exit 0 = all pass. Exit 1 = failures.
$ErrorActionPreference = "Continue"

$repoRoot   = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$helperPath = Join-Path $repoRoot ".venv\Scripts\Update-Guard-Helpers.ps1"

if (-not (Test-Path $helperPath)) {
    Write-Host "SKIP: $helperPath not found." -ForegroundColor Yellow
    Write-Host "  (TDD red phase -- create Update-Guard-Helpers.ps1 to activate these tests.)"
    exit 0
}

. $helperPath

$failures = 0
function Assert-Equal {
    param([Parameter(Mandatory)] $Expected, [Parameter(Mandatory)] $Actual, [Parameter(Mandatory)][string] $Label)
    if ($Expected -ne $Actual) {
        Write-Host "FAIL: $Label" -ForegroundColor Red
        Write-Host "  expected: [$Expected]  actual: [$Actual]"
        $script:failures++
    } else { Write-Host "OK:   $Label" -ForegroundColor Green }
}
function Assert-True {
    param([Parameter(Mandatory)] $Condition, [Parameter(Mandatory)][string] $Label)
    if (-not $Condition) { Write-Host "FAIL: $Label" -ForegroundColor Red; $script:failures++ }
    else { Write-Host "OK:   $Label" -ForegroundColor Green }
}
function Assert-Null {
    param([AllowNull()][Parameter(Mandatory)] $Value, [Parameter(Mandatory)][string] $Label)
    Assert-True ($null -eq $Value) $Label
}

# ============================================================================
# A. Get-HermesGapDecision -- Step 0.5 routing matrix (Gap 2)
# ============================================================================
Write-Host "`n=== A. Get-HermesGapDecision ===================================" -ForegroundColor Cyan

$d = Get-HermesGapDecision -BehindOrigin 0 -BehindUpstream 0
Assert-Equal "done"    $d.Action   "A1: (0,0) -> action=done"
Assert-Equal 0         $d.ExitCode "A1: (0,0) -> exitCode=0"

$d = Get-HermesGapDecision -BehindOrigin 5 -BehindUpstream 3
Assert-Equal "proceed" $d.Action   "A2: (5,3) -> action=proceed"
Assert-Equal 0         $d.ExitCode "A2: (5,3) -> exitCode=0"
Assert-True  ($d.Warnings -match 'upstream') "A2: (5,3) -> warning mentions upstream"

$d = Get-HermesGapDecision -BehindOrigin 0 -BehindUpstream 7
Assert-Equal "no-op"   $d.Action   "A3: (0,7) -> action=no-op"
Assert-Equal 4         $d.ExitCode "A3: (0,7) -> exitCode=4"
Assert-True  ($d.Message -match 'upstream') "A3: (0,7) -> message mentions upstream"
Assert-True  ($d.Message -match 'manual')   "A3: (0,7) -> message mentions manual merge"

$d = Get-HermesGapDecision -BehindOrigin 10 -BehindUpstream 0
Assert-Equal "proceed" $d.Action   "A4: (10,0) -> action=proceed"
Assert-Equal 0         $d.ExitCode "A4: (10,0) -> exitCode=0"
Assert-True  ([string]::IsNullOrEmpty($d.Warnings)) "A4: (10,0) -> no upstream warning"

$d = Get-HermesGapDecision -BehindOrigin 2 -BehindUpstream -1
Assert-Equal "proceed" $d.Action   "A5: (2,-1) -> action=proceed (unknown upstream)"
Assert-Equal 0         $d.ExitCode "A5: (2,-1) -> exitCode=0"

$d = Get-HermesGapDecision -BehindOrigin -1 -BehindUpstream -1
Assert-Equal "proceed" $d.Action   "A6: (-1,-1) -> action=proceed (both unknown)"

$d = Get-HermesGapDecision -BehindOrigin 0 -BehindUpstream 7 -Force
Assert-Equal "no-op"   $d.Action   "A7: (0,7)+Force -> action=no-op"
Assert-Equal 0         $d.ExitCode "A7: (0,7)+Force -> exitCode=0 (force overrides routing error)"

# ============================================================================
# B. Test-HermesSeamRegression -- Step 3.6 (Gap 3)
# ============================================================================
Write-Host "`n=== B. Test-HermesSeamRegression ===============================" -ForegroundColor Cyan

$r = Test-HermesSeamRegression -Baseline 18 -Current 18
Assert-Equal "pass"  $r.Status "B1: (18,18) -> pass"
Assert-True  ([string]::IsNullOrEmpty($r.Fatal)) "B1: no fatal message"

$r = Test-HermesSeamRegression -Baseline 18 -Current 20
Assert-Equal "warn"  $r.Status "B2: (18,20) -> warn"
Assert-True  ($r.Message -match '20') "B2: message contains new count"
Assert-True  ([string]::IsNullOrEmpty($r.Fatal)) "B2: no fatal"

$r = Test-HermesSeamRegression -Baseline 18 -Current 17
Assert-Equal "fatal" $r.Status "B3: (18,17) -> fatal"
Assert-True  (-not [string]::IsNullOrEmpty($r.Fatal)) "B3: fatal message present"
Assert-True  ($r.Fatal -match 'REGRESSION') "B3: fatal says REGRESSION"
Assert-True  ($r.Fatal -match '17') "B3: fatal contains post-count"

$r = Test-HermesSeamRegression -Baseline 18 -Current 0
Assert-Equal "fatal" $r.Status "B4: (18,0) -> fatal"

$r = Test-HermesSeamRegression -Baseline 0 -Current 0
Assert-Equal "pass"  $r.Status "B5: (0,0) -> pass (no seams expected)"

$r = Test-HermesSeamRegression -Baseline 0 -Current 5
Assert-Equal "warn"  $r.Status "B6: (0,5) -> warn (unexpected new seams)"

# ============================================================================
# C. Resolve-HermesVenvPath -- hotfix (venv vs .venv priority)
# ============================================================================
Write-Host "`n=== C. Resolve-HermesVenvPath ==================================" -ForegroundColor Cyan

# C1. Only .venv exists
$t1 = Join-Path $env:TEMP ("hgu-test-c1-" + [System.IO.Path]::GetRandomFileName())
$p1 = Join-Path $t1 ".venv\Scripts"
New-Item -ItemType Directory -Path $p1 -Force | Out-Null
$py1 = Join-Path $p1 "python.exe"
[System.IO.File]::WriteAllText($py1, "x")
Assert-Equal $py1 (Resolve-HermesVenvPath -RepoRoot $t1) "C1: .venv found -> returned"
[System.IO.Directory]::Delete($t1, $true)

# C2. Only venv (no dot prefix)
$t2 = Join-Path $env:TEMP ("hgu-test-c2-" + [System.IO.Path]::GetRandomFileName())
$p2 = Join-Path $t2 "venv\Scripts"
New-Item -ItemType Directory -Path $p2 -Force | Out-Null
$py2 = Join-Path $p2 "python.exe"
[System.IO.File]::WriteAllText($py2, "x")
Assert-Equal $py2 (Resolve-HermesVenvPath -RepoRoot $t2) "C2: venv fallback -> returned"
[System.IO.Directory]::Delete($t2, $true)

# C3. Both exist -> .venv wins
$t3 = Join-Path $env:TEMP ("hgu-test-c3-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path (Join-Path $t3 ".venv\Scripts") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $t3 "venv\Scripts")  -Force | Out-Null
$dotPy  = Join-Path $t3 ".venv\Scripts\python.exe"
$venvPy = Join-Path $t3 "venv\Scripts\python.exe"
[System.IO.File]::WriteAllText($dotPy, "x")
[System.IO.File]::WriteAllText($venvPy, "x")
Assert-Equal $dotPy (Resolve-HermesVenvPath -RepoRoot $t3) "C3: both exist -> .venv priority"
[System.IO.Directory]::Delete($t3, $true)

# C4. Neither venv exists -> null
$t4 = Join-Path $env:TEMP ("hgu-test-c4-" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $t4 -Force | Out-Null
Assert-Null (Resolve-HermesVenvPath -RepoRoot $t4) "C4: no venv -> null"
[System.IO.Directory]::Delete($t4, $true)

# ============================================================================
# D. Test-HermesSeamLiveness -- Step 5 (seam liveness parity, CI mirror)
# ============================================================================
Write-Host "`n=== D. Test-HermesSeamLiveness =================================" -ForegroundColor Cyan

$l = Test-HermesSeamLiveness -ExitCode 0
Assert-Equal "pass" $l.Status "D1: exit 0 -> pass"
Assert-True  (-not $l.Fatal) "D1: exit 0 -> not fatal"

$l = Test-HermesSeamLiveness -ExitCode 1
Assert-Equal "fail" $l.Status "D2: exit 1 -> fail"
Assert-True  ($l.Fatal) "D2: exit 1 -> fatal"

$l = Test-HermesSeamLiveness -ExitCode 2
Assert-Equal "fail" $l.Status "D3: exit 2 -> fail"
Assert-True  ($l.Fatal) "D3: exit 2 -> fatal"

# ============================================================================
Write-Host ""
Write-Host ("=" * 60)
if ($failures -gt 0) {
    Write-Host "$failures test(s) FAILED." -ForegroundColor Red
    exit 1
}
Write-Host "All tests passed." -ForegroundColor Green
exit 0
