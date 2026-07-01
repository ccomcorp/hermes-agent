# `/update-hermes` Improvement Specification
**Generated**: 2026-06-30 via Advanced Elicitation (4 parallel agents: AAR, Pre-Mortem, FME, DCA)  
**Scope**: `Invoke-HermesSafeUpdate.ps1`, `Test-HermesPostUpdate.ps1`, `Invoke-HermesPreflight.ps1`, `/update-hermes` SKILL.md  
**Target repo**: `I:\PROJECTS\AIOS\hermes-agent` (branch `aios`)

---

## Convergence Summary

| ID | Finding | Methods | Convergence | Severity | Priority |
|----|---------|---------|-------------|----------|----------|
| C1 | npm workspace reconciliation absent from orchestrator | AAR, Pre-Mortem, FME, DCA | 3 (cap) | 4 | **12** |
| C2 | Silent no-op when HEAD == origin/aios but upstream ahead | AAR, Pre-Mortem, FME, DCA | 3 (cap) | 4 | **12** |
| C4 | Seam baseline hardcoded/unenforced at orchestrator level | AAR, Pre-Mortem, FME, DCA | 3 (cap) | 4 | **12** |
| C3 | venv path bug — checks `\venv\` not `\.venv\` (active defect) | AAR, Pre-Mortem, FME, DCA | 3 (cap) | 3 | **9** |
| C5 | No post-update SHA verification | AAR, Pre-Mortem, FME, DCA | 3 (cap) | 3 | **9** |
| C6 | `check-update-need.py` not wired; proactive alerting absent | AAR, Pre-Mortem, FME, DCA | 3 (cap) | 2 | **6** |

Priority formula: `min(convergence, 3) × severity`. Severity scale: 1=cosmetic, 2=degraded UX, 3=functional bug, 4=data loss/silent regression, 5=catastrophic.

---

## Ranked Specification

### SPEC-1 — npm Workspace Reconciliation (Priority 12) `APPLY`

**All 4 methods independently required this.**  
**Root cause** (DCA 5-Why): npm install was added to SKILL.md Phase 4 as a compensating layer when it belonged in the orchestrator. The two backup timestamps on direct orchestrator invocations (June 15, June 24) confirm that the script path is the primary invocation — the skill layer is bypassed. Historical evidence: the 972-commit upstream merge left vite and electron missing from root `node_modules`.

**Insert in `Invoke-HermesSafeUpdate.ps1` as Step 3.5**, after `$env:HERMES_SAFE_UPDATE_OK` is cleared and before `Test-HermesPostUpdate.ps1`:

```powershell
Write-Host "`n==== STEP 3.5/4: NPM WORKSPACE RECONCILE ===================" -ForegroundColor Cyan

# Node 22 guard (ABORT — not warn — if Node 22 absent; Node 24 breaks Electron build)
$Node22Path = "$env:LOCALAPPDATA\hermes\tools\node22\node-v22.19.0-win-x64"
$node22Exe  = Join-Path $Node22Path "node.exe"
if (-not (Test-Path $node22Exe)) {
    Write-Host "  [FAIL] Node 22 not found at $node22Exe" -ForegroundColor Red
    Write-Host "  npm install requires Node 22 (system default is Node 24, which breaks Electron)."
    exit 3
}
$nodeVersion = (& $node22Exe --version 2>$null).Trim()
if ($nodeVersion -notmatch '^v22\.') {
    Write-Host "  [FAIL] Expected Node v22.x at $node22Exe, found: $nodeVersion" -ForegroundColor Red
    exit 3
}

# Run npm install from repo root with Node 22 in PATH prefix
$NpmCmd = "C:\Program Files\nodejs\npm.cmd"
if (-not (Test-Path $NpmCmd)) {
    $NpmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue)?.Source
}
if (-not $NpmCmd) {
    Write-Host "  [FAIL] npm.cmd not found." -ForegroundColor Red
    exit 3
}
$env:PATH = "$Node22Path;$env:PATH"
& $NpmCmd install --no-audit --no-fund --prefix $RepoRoot
$npm_exit = $LASTEXITCODE
$env:PATH = $env:PATH.Replace("$Node22Path;", "")  # restore PATH

if ($npm_exit -ne 0) {
    Write-Host ("  [FAIL] npm install exited {0}. Frontend deps not reconciled." -f $npm_exit) -ForegroundColor Red
    Write-Host "  Common fix: Remove-Item $RepoRoot\node_modules -Recurse -Force, then re-run."
    Write-Host "  Rollback: restore from $backupDir"
    exit 3
}
Write-Host "  [PASS] npm workspace install complete (Node $nodeVersion)" -ForegroundColor Green
```

**Ordering constraint**: Must run AFTER Step 3 (`hermes update` mutates `package.json`). Must run BEFORE Step 3.6 and Step 4 (which validate npm artifact state).

**Interaction — Gap1-Mode3**: The Node 22 guard here is ABORT (not warn), intentionally stricter than the existing warn-only check in `Test-HermesPostUpdate.ps1`. Running npm install on Node 24 produces artifacts that break the Electron build silently.

---

### SPEC-2 — Silent No-Op Detection (Priority 12) `APPLY`

**All 4 methods independently required this.** Multiple prior sessions burned by this trap.  
**Root cause** (DCA): `Invoke-HermesPreflight.ps1` fetches only `origin`, never `upstream`. `git rev-list HEAD..origin/aios == 0` is treated as "nothing to do" without checking `upstream/main`. The historical trap: running the safe-update, seeing exit 0, and considering the system current — while upstream/main diverges daily.

**Insert in `Invoke-HermesSafeUpdate.ps1` as Step 0.5**, before Step 1 (Preflight):

```powershell
Write-Host "==== STEP 0.5/4: DUAL-GAP DIAGNOSE =========================" -ForegroundColor Cyan

git -C $RepoRoot fetch origin --quiet 2>$null
git -C $RepoRoot fetch upstream --quiet 2>$null   # soft-fail if remote absent

$behind_origin   = (git -C $RepoRoot rev-list --count "HEAD..origin/$Branch" 2>$null).Trim()
$behind_upstream = (git -C $RepoRoot rev-list --count "origin/$Branch..upstream/main" 2>$null).Trim()

$bo = if ($behind_origin   -match '^\d+$') { [int]$behind_origin }   else { -1 }
$bu = if ($behind_upstream -match '^\d+$') { [int]$behind_upstream } else { -1 }

if ($bo -eq 0 -and $bu -eq 0) {
    Write-Host "  [INFO] Already fully current with origin/aios AND upstream/main. Nothing to do." -ForegroundColor Green
    exit 0
}

if ($bo -eq 0 -and $bu -gt 0) {
    Write-Host "" 
    Write-Host "  [ABORT] NO-OP DETECTED" -ForegroundColor Red
    Write-Host ("  HEAD is already at origin/{0} (0 commits behind)." -f $Branch)
    Write-Host ("  upstream/main is {0} commit(s) ahead — hermes update CANNOT close that gap." -f $bu) -ForegroundColor Yellow
    Write-Host "  Action required: Manual Upstream Merge (Phase 3B)."
    Write-Host "  Runbook: hermes-home/skills/devops/hermes-fork-maintenance/references/upstream-merge-runbook.md"
    Write-Host "  Diagnostic: python check-update-need.py"
    if (-not $Force) { exit 4 }  # exit 4 = routing error (wrong tool, use manual merge)
    Write-Host "  -Force set: proceeding anyway (update will be a no-op for the git step)." -ForegroundColor DarkGray
}

if ($bu -gt 0 -and $bo -gt 0) {
    Write-Host ("  [WARN] Also {0} commits behind upstream/main. Run manual merge after this fork sync." -f $bu) -ForegroundColor Yellow
    # List seam files in upstream diff for awareness
    $seamFiles = git -C $RepoRoot diff --name-only "HEAD..upstream/main" -- "agent/*.py" "tools/*.py" "plugins/**/*.py" 2>$null
    if ($seamFiles) {
        Write-Host "  Upstream changes touch seam-carrying files — manual seam verification required after merge:" -ForegroundColor Yellow
        $seamFiles | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
    }
}

Write-Host ("  origin/{0}: {1} commit(s) behind" -f $Branch, $bo) -ForegroundColor Cyan
Write-Host ("  upstream/main: {0} commit(s) ahead of origin/{1}" -f $bu, $Branch) -ForegroundColor Cyan
```

**Exit code contract**:
- `exit 0` = already current (both gaps = 0)
- `exit 4` = routing error (origin current, upstream ahead → wrong tool)
- Continues = `behind_origin > 0` (valid update target)

**Conflict resolution — exit code**: AAR and FME both specify exit 4 for the routing-error case; Pre-Mortem used exit 1. Exit 4 adopted (distinct semantic: not failure, not success, "wrong tool").

---

### SPEC-3 — Seam Baseline Enforcement (Priority 12) `APPLY`

**All 4 methods agree; the SKILL.md literal "18 across 8 files on 2026-06-30" is structurally stale.**  
**Root cause**: Seam validation placed in prose documentation rather than a machine-readable committed baseline. Baseline drift is structurally inevitable as seams are added. Worst mode (FME Gap3-Mode2): upstream merge auto-resolves conflict in a seam file, drops sentinel, count stays the same if another seam was added — masked compound failure.

**Two-part fix:**

**Part A — Create committed baseline file** (addresses FME recommendation, survives branch operations):

```json
// docs/Update-Instructions/seam-baseline.json
{
  "count": 18,
  "files": 8,
  "file_list": [
    "agent/background_review.py",
    "agent/conversation_loop.py",
    ".github/workflows/loop-liveness.yml",
    "docs/Update-Instructions/loop-fork-patch-manifest.md",
    "docs/Update-Instructions/loop-liveness-gate.md",
    "plugins/memory/composite/loop_guard.py",
    "plugins/memory/composite/tests/test_loop_guard.py",
    "tools/delegate_tool.py"
  ],
  "updated": "2026-06-30",
  "note": "Update this file whenever a seam is intentionally added or removed. Never auto-generate."
}
```

**Part B — Insert in `Invoke-HermesSafeUpdate.ps1` as Step 3.6**, between Step 3.5 and Step 3.7:

```powershell
Write-Host "`n==== STEP 3.6/4: SEAM-COUNT-VERIFY =========================" -ForegroundColor Cyan

# Capture PRE-update baseline (from Step 1 — moved here for clarity, actually captured at Step 1)
# $seam_baseline is set at Step 1 (see Step 1 amendment below)

$seam_post_raw = git -C $RepoRoot grep -c "AIOS-LOOP-SEAM" -- "*.py" "*.yml" "*.md" 2>$null
$seam_post = ($seam_post_raw | ForEach-Object {
    if ($_ -match ':(\d+)$') { [int]$Matches[1] } else { 0 }
} | Measure-Object -Sum).Sum
$seam_post_files = ($seam_post_raw | Where-Object { $_ -match ':\d+$' }).Count

if ($seam_post -lt $seam_baseline) {
    Write-Host ("  [FATAL] SEAM REGRESSION: {0} sentinels pre-update, {1} post-update." -f $seam_baseline, $seam_post) -ForegroundColor Red
    Write-Host "  A seam was removed or overwritten. DO NOT PROCEED."
    Write-Host "  Inspect: git diff HEAD~1 HEAD -- '*.py' '*.yml' '*.md'"
    Write-Host "  Rollback: git checkout aios && git reset --hard <backup-sha>"
    exit 3
} elseif ($seam_post -gt $seam_baseline) {
    Write-Host ("  [WARN] Seam count grew: {0} → {1} (new seam added — update seam-baseline.json if intentional)" -f $seam_baseline, $seam_post) -ForegroundColor Yellow
} else {
    Write-Host ("  [PASS] Seam count stable: {0} occurrences across {1} files" -f $seam_post, $seam_post_files) -ForegroundColor Green
}
```

**Step 1 amendment** — add seam baseline capture after Preflight returns:

```powershell
# Capture seam baseline BEFORE the update (in Step 1 block, after Invoke-HermesPreflight.ps1)
$seam_pre_raw = git -C $RepoRoot grep -c "AIOS-LOOP-SEAM" -- "*.py" "*.yml" "*.md" 2>$null
$seam_baseline = ($seam_pre_raw | ForEach-Object {
    if ($_ -match ':(\d+)$') { [int]$Matches[1] } else { 0 }
} | Measure-Object -Sum).Sum
Write-Host ("  Seam baseline (pre-update): {0} occurrences" -f $seam_baseline) -ForegroundColor DarkGray
```

**SKILL.md Phase 0 amendment**: Replace the literal in acceptance_criteria:  
**Before**: `"baseline was **18 across 8 files** on 2026-06-30, and grows as the fork adds seams"`  
**After**: `"count == SEAM_BASELINE — the live value measured in Phase 1 via git grep -c. The literal 18 is OBSOLETE. Source of truth: docs/Update-Instructions/seam-baseline.json"`

**Conflict resolution — baseline storage**: Pre-Mortem proposed runtime-written `.aios-seam-baseline.json`. FME proposed committed `seam-baseline.json`. DCA used a runtime variable. **Adopted**: committed file (FME) for the minimum-expected floor, runtime pre-update measurement (DCA Step 1 capture) for regression detection within a run. Runtime-written file auto-updates and can drift silently; committed file requires intentional update.

---

### SPEC-4 — venv Path Hotfix (Priority 9) `APPLY IMMEDIATELY`

**All 4 methods independently identified this as an active defect** (not a spec item — a bug).  
`Test-HermesPostUpdate.ps1` line 131 checks `$RepoRoot\venv\Scripts\python.exe`. The AIOS venv is at `.venv\Scripts\python.exe`. This means the Python health check has been silently failing on every run on this install.

**Fix in `Test-HermesPostUpdate.ps1` line 131**:

```powershell
# Before:
$pythonExe = "$RepoRoot\venv\Scripts\python.exe"

# After:
$pythonExe = if (Test-Path "$RepoRoot\.venv\Scripts\python.exe") {
    "$RepoRoot\.venv\Scripts\python.exe"
} elseif (Test-Path "$RepoRoot\venv\Scripts\python.exe") {
    "$RepoRoot\venv\Scripts\python.exe"
} else {
    $null
}
if (-not $pythonExe) {
    Check-Fail "Python venv not found at .venv\Scripts\ or venv\Scripts\" "No Python venv"
    return
}
```

This is a **hotfix** — ship separately and immediately, not bundled with the spec items above.

---

### SPEC-5 — SHA Verification (Priority 9) `APPLY`

**All 4 methods agree.** Catches: `hermes update` exits 0 but git operations silently failed; editable-install `.pth` drift after mutation (DCA Gap4-Mode3).

**Insert in `Invoke-HermesSafeUpdate.ps1` as Step 3.7**, between Step 3.6 and Step 4:

```powershell
Write-Host "`n==== STEP 3.7/4: SHA-VERIFY ================================" -ForegroundColor Cyan

$expected_sha = (git -C $RepoRoot rev-parse "origin/$Branch" 2>$null).Trim()
$actual_sha   = (git -C $RepoRoot rev-parse HEAD 2>$null).Trim()

if (-not $expected_sha -or -not $actual_sha) {
    Write-Host "  [WARN] Could not retrieve SHA for comparison." -ForegroundColor Yellow
} elseif ($actual_sha -ne $expected_sha) {
    Write-Host "  [FAIL] SHA MISMATCH:" -ForegroundColor Red
    Write-Host ("  HEAD is at {0}" -f $actual_sha.Substring(0, 12)) -ForegroundColor Red
    Write-Host ("  origin/{0} is at {1}" -f $Branch, $expected_sha.Substring(0, 12)) -ForegroundColor Red
    Write-Host "  hermes update did not advance HEAD to origin/$Branch."
    Write-Host "  Inspect: git log --oneline -5"
    exit 3
} else {
    Write-Host ("  [PASS] HEAD == origin/{0} @ {1}" -f $Branch, $actual_sha.Substring(0, 12)) -ForegroundColor Green
}
```

**Note on Gap4-Mode2** (FME): SHA verification catches the case where `hermes update` *didn't* advance HEAD. It does NOT catch the case where HEAD correctly matches origin/aios but upstream/main has diverged — that is covered by SPEC-2 (Step 0.5). Both gates are required together for full coverage.

**SKILL.md Phase 6 amendment**: Add after `hermes --version`:
```python
# SHA gate
expected = subprocess.run(["git", "rev-parse", f"origin/{branch}"], ...).stdout.strip()
actual   = subprocess.run(["git", "rev-parse", "HEAD"], ...).stdout.strip()
assert actual == expected, f"SHA mismatch: HEAD={actual[:12]} expected={expected[:12]}"
engineering_loop_record_feedback(command="sha-verify", exit_code=0, output=f"HEAD=={actual[:12]}")
```

---

### SPEC-6 — Proactive Upstream Drift Alerting (Priority 6) `DEFER`

**All 4 methods agree this is needed.** Deferred because:  
1. `check-update-need.py` does not currently exist on disk (FME finding — confirmed). Must be created before it can be scheduled.  
2. SPEC-2 (Step 0.5) partially closes the reactive gap by surfacing upstream drift at update time.  
3. Scheduling under Task Scheduler with git credentials (FME Gap5-Mode2) requires user-context setup.

**When to implement**: After SPEC-1 through SPEC-5 are stable. Dependencies: working `check-update-need.py` script.

**Requirements for `check-update-need.py`** (to create from scratch):
- Fetch both remotes; compare `upstream/main` SHA to `origin/aios` SHA
- Output: commit count behind, file list (names only), seam-file intersection count
- Exit 0 if fully current, exit 1 if behind origin, exit 2 if behind upstream, exit 3 if both
- Accept `--notify` flag: write `I:\PROJECTS\AIOS\hermes-home\alerts\upstream-drift.json` with `{detected_at, behind_upstream, behind_origin}`
- Must remain read-only — no write operations to working tree

**Scheduling target**: Windows Task Scheduler, user context (not SYSTEM), daily, logged to `update-guard-reports\check-YYYYMMDD.log`. Session-init hook in hermes-home reads `upstream-drift.json` if age < 7 days and surfaces alert.

---

## Divergent Insights (Single-Method Findings)

### D1 — Node 22 explicit path required (FME unique finding)
System Node default is `v24.13.1`. Node 22 lives at `$env:LOCALAPPDATA\hermes\tools\node22\node-v22.19.0-win-x64`. SPEC-1 above adopts this path. If this path changes, update the `$Node22Path` variable.

### D2 — Backup stdout fragility (DCA unique finding)
`$backupDir` is captured via `Select-Object -Last 1` on `Backup-HermesRepo.ps1` stdout. If the script emits a trailing status line, `$backupDir` is wrong and all rollback instructions will reference an incorrect path. **Recommendation**: Backup script should write the path to a dedicated channel (e.g., stdout only; all status to stderr). Low priority — raise when touching Backup-HermesRepo.ps1 for other reasons.

### D3 — CI/local seam check parity (DCA unique finding)
`.github/workflows/loop-liveness.yml` already runs AIOS seam checks in CI. The local update flow's SPEC-3 (Step 3.6) uses a count-based check. For deeper parity, SPEC-3 should also invoke `scripts/loop_liveness.py` (which checks seam liveness, not just count). **Recommendation**: Add as a secondary check in `Test-HermesPostUpdate.ps1` Phase 6 equivalent.

### D4 — check-update-need.py does not exist (FME unique finding)
All prior documentation and memory entries reference this file as existing. FME explicitly checked and found it is not on disk. It is a planned artifact. SPEC-6 defers it but must create it, not configure an existing file.

### D5 — Seam file intersection in upstream diff (FME + DCA compound)
SPEC-2 (Step 0.5) already implements this: when `$bo > 0 && $bu > 0`, the script lists seam-carrying files found in the upstream diff. Adopted.

---

## Conflicts Resolved

| Conflict | Methods | Resolution |
|----------|---------|------------|
| Seam baseline storage location | Pre-Mortem (runtime JSON), FME (committed file), DCA (runtime var) | Committed file (FME) for minimum floor + runtime capture (DCA) for regression detection |
| Exit code for upstream-only divergence | AAR/FME (exit 4), Pre-Mortem (exit 1) | Exit 4 adopted — distinct semantic (routing error, not failure) |
| Node guard severity | FME (ABORT on v24 in npm step), current code (WARN) | ABORT adopted in SPEC-1; current WARN in health check unchanged for backward compat |

---

## Revised Orchestrator Execution Graph

```
[ENTRY]
  → Step 0.5: DUAL-GAP-DIAGNOSE       [NEW]  exit 0|4|continue
  → Step 1:   PREFLIGHT + seam-capture [+seam baseline measurement]  exit 0|2|3
  → Step 2:   BACKUP                  [unchanged]
  → Step 3:   HERMES UPDATE           [unchanged]  → $uc
  → Step 3.5: NPM-WORKSPACE-RECONCILE [NEW]  exit 3 on fail
  → Step 3.6: SEAM-COUNT-VERIFY       [NEW]  exit 3 on regression
  → Step 3.7: SHA-VERIFY              [NEW]  exit 3 on mismatch
  → Step 4:   TEST-HERMES-POST-UPDATE [+venv fix]  → $vc; exit 2 overrides $uc
[EXIT: $uc unless $vc==2]
```

Data flows (no circular dependencies):
- `Step 0.5` → `$behind_origin, $behind_upstream` → used in Step 4 summary report
- `Step 1` → `$seam_baseline` → Step 3.6 comparison
- `Step 2` → `$backupDir` → error message references in all 3.x steps
- `Step 3` → mutated working tree → Steps 3.5/3.6/3.7/4 validate
- `Step 3.5` → synchronized `node_modules` → Step 4 npm presence checks

---

## Apply / Defer / Discard

| ID | Finding | Decision | Reason |
|----|---------|----------|--------|
| C3-HOTFIX | venv path bug | **Apply immediately** | Active defect; Python health check always failing |
| C1 (SPEC-1) | npm workspace reconciliation | **Apply** | Priority 12; has caused real outage |
| C2 (SPEC-2) | Silent no-op detection | **Apply** | Priority 12; recurring multi-session trap |
| C4 (SPEC-3) | Seam baseline enforcement | **Apply** | Priority 12; highest-severity silent failure mode |
| C5 (SPEC-5) | SHA verification | **Apply** | Priority 9; low cost, high catch value |
| C6 (SPEC-6) | Proactive alerting | **Defer** | Script doesn't exist; SPEC-2 covers reactive gap |
| D1 | Node 22 path | **Apply** (part of SPEC-1) | Adopted in npm step |
| D2 | Backup stdout fragility | **Defer** | Low impact; fix opportunistically |
| D3 | CI/local seam parity | **Defer** | Nice-to-have; SPEC-3 count check is sufficient |
| D4 | check-update-need.py creation | **Apply as part of SPEC-6** | Must create from scratch |

---

## What This Means (Non-Technical)

The Hermes update system has a good safety structure — it backs up before making changes, blocks dangerous bare updates, and runs health checks afterward. But the health checks were designed for the Python engine only, and the system has grown to include a JavaScript frontend and custom AIOS learning-loop hooks that the checks don't cover.

**What could go wrong if left unchanged**: Running an update could silently leave the frontend in a broken state (happened once already), silently skip the actual upstream changes while reporting success (has happened multiple times), or silently overwrite a learning-loop hook during a merge and only show behavioral degradation in AI responses weeks later.

**What the spec improves**: Four targeted additions to the update script — each one catches a different class of silent failure:

1. **npm install step**: Makes the frontend always consistent after an update. One missed step has already broken the desktop app; this makes it automatic.
2. **Upstream drift check**: Before doing anything, the script will now detect "you're trying to update using the wrong tool" and redirect you to the correct procedure.
3. **Seam count check**: After every update, the script verifies the AIOS learning-loop hooks are all still present. A merge can accidentally remove one; this catches it immediately rather than weeks later.
4. **SHA check**: Verifies the update actually advanced the codebase to the target version, not just reported success and left things unchanged.

**Plus an immediate bug fix**: The Python health check has been misconfigured and silently failing on every run. Fixing one path string restores it.

After these changes, a failed update will be caught immediately in the same run, not days later when behavior changes or the app won't launch.

---

## Implementation Order

1. **Hotfix (now)**: venv path bug in `Test-HermesPostUpdate.ps1:131`
2. **Phase 1**: SPEC-1 (npm step 3.5) + SPEC-2 (dual-gap step 0.5) — these two together eliminate the two most-burned gaps
3. **Phase 2**: SPEC-3 (seam baseline — create `seam-baseline.json` + add step 3.6) + SPEC-5 (SHA step 3.7) + SKILL.md amendments
4. **Phase 3** (future): SPEC-6 (create `check-update-need.py` + scheduling)

---

*Elicitation methods: After-Action Review, Pre-Mortem Analysis, Failure Mode Enumeration, Dependency Chain Analysis*  
*All four agents ran independently on identical source files with no shared context.*
