# Hermes Agent Update Instructions

**Canonical update runbook for the AIOS fork of Hermes Agent.**
This is a forked/customized installation (`ccomcorp/hermes-agent`, branch `aios`)
that carries 26+ deliberate patches (the AIOS self-learning loop) on top of
upstream `NousResearch/hermes-agent`. Updates work differently here than on a
stock install — read this document before running anything.

**Use this document in conjunction with the `hermes-fork-maintenance` skill.**
The skill (`skill_view(name='hermes-fork-maintenance')`) provides the same
procedures with additional context, worked examples, and reference files. This
document is the standalone reference; the skill is the interactive guide. When
they disagree, the skill's reference files have the more recent worked examples.

---

## Table of Contents

1. [The Golden Rule](#1-the-golden-rule)
2. [Environment](#2-environment)
3. [Step 0: Diagnose — ALWAYS RUN FIRST](#3-step-0-diagnose--always-run-first)
4. [Step 1: Safe Update (sync with fork)](#4-step-1-safe-update-sync-with-fork)
4A. [**FULL Frontend + Backend Safe Update (end-to-end)**](#4a-full-frontend--backend-safe-update-end-to-end)
5. [Step 2: Upstream Merge (bring in NousResearch changes)](#5-step-2-upstream-merge-bring-in-nousresearch-changes)
6. [Step 3: Desktop App Rebuild (frontend, standalone)](#6-step-3-desktop-app-rebuild-frontend-standalone)
7. [Step 4: Promote aios → main (ship to main branch)](#7-step-4-promote-aios--main-ship-to-main-branch)
8. [Post-Update Validation Checklist](#8-post-update-validation-checklist)
9. [The Seam Files](#9-the-seam-files-custom-delta-that-must-survive-merges)
10. [Pitfalls and Known Issues](#10-pitfalls-and-known-issues)
11. [Reference Documents](#11-reference-documents)

---

## 1. The Golden Rule

> **NEVER run bare `hermes update`.**

This fork has an in-chassis refuse-guard (`hermes_cli/main.py`, sentinel
`AIOS-SAFE-UPDATE-GUARD`) that blocks bare `hermes update`. The guard exists
because `hermes update` runs `git reset --hard + git clean -fd`, which would
**destroy the 26+ custom commits** on the `aios` branch.

The guard refuses unless `HERMES_SAFE_UPDATE_OK=1` is set — which only the
safe-update orchestrator (`Invoke-HermesSafeUpdate.ps1`) does.

**Always use `Invoke-HermesSafeUpdate.ps1` instead.** Never try to work around
the refuse-guard.

---

## 2. Environment

### The three directories (verified at source 2026-06-30 — do NOT conflate them)

The installation spans three directories with distinct roles. "Backend" and
"frontend" are **not** separate repos — both live inside `hermes-agent`.

| Dir | Path | Role | Git? | Update path |
|-----|------|------|------|-------------|
| **AIOS** | `I:\PROJECTS\AIOS\AIOS` | **Integration / orchestration repo.** Owns the update-guard scripts (`scripts\update-guard\`), the runbooks (`docs\Update-Instructions\`, `docs\guides\`), and `scripts\launch-dev-hermes.ps1`. origin=`ccomcorp/AIOS`, **no upstream**. | ✅ | normal git; this repo *drives* the chassis update |
| **hermes-agent** | `I:\PROJECTS\AIOS\hermes-agent` | **The fork CHASSIS — carries BOTH backend (Python) AND frontend (`apps/desktop/` Electron) in ONE repo.** origin=`ccomcorp/hermes-agent` branch `aios` + upstream=`NousResearch`. | ✅ | fork-sync OR upstream-merge |
| **hermes-home** | `I:\PROJECTS\AIOS\hermes-home` | **Runtime state only** (`HERMES_HOME`): `config.yaml`, `skills/`, `memories/`, `kanban.db`, `experience.db`, `auth.json`. **NOT a git repo.** | ❌ | never git-updated; backed up as state snapshots |

> **Framing correction:** the *backend* is the Python chassis (`agent/`, `tools/`,
> `hermes_cli/`, `plugins/`); the *frontend* is `apps/desktop/` — an npm
> **workspace** that installs from the repo root. Both are in `hermes-agent`, on
> branch `aios`. AIOS is the integration repo, NOT the chassis (the launch
> script pins `$Chassis = I:\PROJECTS\AIOS\hermes-agent`).

### Key paths and values

| Component | Path / Value |
|-----------|-------------|
| Fork repo (origin) | `ccomcorp/hermes-agent` (GitHub) |
| Upstream | `NousResearch/hermes-agent` (GitHub) |
| Branch | `aios` (the launcher REFUSES any other branch) |
| Chassis root | `I:\PROJECTS\AIOS\hermes-agent` |
| Hermes home (`HERMES_HOME`) | `I:\PROJECTS\AIOS\hermes-home` (NOT `~/.hermes`) |
| Frontend (desktop) | `apps\desktop\` (Electron; npm workspace) |
| Safe-update scripts (source) | `I:\PROJECTS\AIOS\AIOS\scripts\update-guard\` |
| Safe-update scripts (installed) | `hermes-agent\.venv\Scripts\` (shadow-installed copy) |
| Gateway port | **9120** (the Electron window connects here) |
| Desktop build/launch logs | `%TEMP%\hermes-desktop.out.log` + `.err.log` |
| Packaged desktop output | `apps\desktop\release\win-unpacked\Hermes.exe` (~214 MB) |
| Launch script | `AIOS\scripts\launch-dev-hermes.ps1` |
| Desktop rebuild runbook | `AIOS\docs\guides\RUNBOOK-custom-desktop-rebuild.md` |
| Fork-patch manifest | `docs/Update-Instructions/loop-fork-patch-manifest.md` |
| Loop-liveness gate | `docs/Update-Instructions/loop-liveness-gate.md` |

### Safe-update script inventory (all in `.venv\Scripts\`)

| Script | Purpose | Modifies? |
|--------|---------|-----------|
| `Invoke-HermesSafeUpdate.ps1` | 4-step orchestrator: pre-flight → backup → update → verify | Yes (via hermes update) |
| `Invoke-HermesPreflight.ps1` | Read-only fetch + risk report | No |
| `Backup-HermesRepo.ps1` | Source + patch snapshot to recoverable directory | Yes (creates backup) |
| `Test-HermesPostUpdate.ps1` | Health check: Node, Python, desktop dist, gateway | No |
| `Resolve-HermesRealExe.ps1` | Resolves `hermes-real.exe` (post-shadow) vs `hermes.exe` (pre-shadow) | No |
| `Get-HermesShimRoute.ps1` | Pure dispatch decision for the hermes shim | No |
| `hermes-shim.ps1` | The venv `hermes` shadow that routes `hermes update` to the safe-update orchestrator | N/A |

---

## 3. Step 0: Diagnose — ALWAYS RUN FIRST

**This step is mandatory.** Before recommending or running any update,
determine where the gap is. Previous sessions ran the safe-update procedure
repeatedly without checking whether it could actually help, resulting in no-op
"successes" that changed nothing while the real gap (to upstream) went
unaddressed.

### The two remotes

| Remote | URL | What it is |
|--------|-----|------------|
| `origin` | `https://github.com/ccomcorp/hermes-agent.git` | The fork (carries AIOS-specific commits on branch `aios`) |
| `upstream` | `https://github.com/NousResearch/hermes-agent.git` | The original project (main branch) |

### How `hermes update --branch aios` works internally

Source: `hermes_cli/main.py`

1. `PROJECT_ROOT` resolves to the repo root from the package install location,
   **not** from the shell's current directory. CWD doesn't matter.
2. The update runs `git pull --ff-only origin aios`. If ff-only fails (diverged),
   falls back to `git reset --hard origin/aios` — **destructive**.
3. Syntax guard validates critical-path files post-pull; rolls back on failure.
4. The AIOS refuse-guard blocks the command unless `HERMES_SAFE_UPDATE_OK=1` is set.

**Key:** step 2 only touches `origin/aios`. It never fetches or merges from
`upstream`. If local HEAD == origin/aios HEAD, `git pull --ff-only` is a no-op
and the entire update does nothing.

### Diagnostic commands

Run from the repo root. If the `terminal` tool can't resolve the Windows path,
use `execute_code` with `subprocess.run(..., cwd=repo)`:

```bash
cd I:\PROJECTS\AIOS\hermes-agent
git fetch origin
git fetch upstream

# How far behind the fork (origin/aios)?
git rev-list --count HEAD..origin/aios

# How far is the fork behind upstream?
git rev-list --count origin/aios..upstream/main
```

Or run the diagnostic script:

```bash
python I:\PROJECTS\AIOS\hermes-home\skills\devops\hermes-fork-maintenance\scripts\check-update-need.py
```

### Decision tree

| Behind `origin/aios` | Behind `upstream/main` | Action |
|---|---|---|
| > 0 | any | Run **Safe Update** (Step 1) — closes the fork gap |
| 0 | > 0 | Safe Update is a **NO-OP**. It will report success and change nothing. You need the **Upstream Merge** (Step 2). **This is the trap that caused multiple failed update attempts.** |
| 0 | 0 | Already up to date. No action needed. |

> **Critical trap:** when local is already synced with `origin/aios` (0 commits
> behind), the safe-update procedure is a **silent no-op** — it reports success
> and changes nothing. If the user says "updates aren't working" or "we're still
> behind," the first thing to check is whether the gap is to upstream, not origin.

---

## 4. Step 1: Safe Update (sync with fork)

**When:** you are behind `origin/aios` (>0 commits). This pulls new commits
from the fork, reinstalls dependencies, migrates config, and restarts the gateway.

**When NOT to use:** if you're 0 behind origin but >0 behind upstream, this is a
no-op. Use Step 2 (Upstream Merge) instead.

### Run the 4-step orchestrator

```powershell
powershell -ExecutionPolicy Bypass -File "I:\PROJECTS\AIOS\hermes-agent\.venv\Scripts\Invoke-HermesSafeUpdate.ps1"
```

**Parameters:**
- `-Force` — skip the at-risk confirmation prompt (use when pre-flight is known safe)
- `-FullBundle` — create a complete git bundle backup (default is a fast `-NoBundle` snapshot)
- `-Branch <name>` — override the branch (default: `aios`)

### What the orchestrator does (automatically, in order)

| Step | Script | What happens | Exit codes |
|------|--------|-------------|------------|
| 1/4: Pre-flight | `Invoke-HermesPreflight.ps1` | Read-only fetch + risk report. Checks for local edits at risk, conflict-risk files, commit count behind. | 0=safe, 2=at-risk, 3=error |
| 2/4: Backup | `Backup-HermesRepo.ps1` | Creates timestamped backup: git bundle (all refs), tracked-changes patch, stash patches, worktree file mirror. **Aborts if backup fails.** | — |
| 3/4: Update | `hermes-real.exe update --branch aios` | Sets `HERMES_SAFE_UPDATE_OK=1` (bypasses refuse-guard), pulls origin/aios, reinstalls deps, migrates config, restarts gateway. Clears env var after. | 0=success |
| 4/4: Verify | `Test-HermesPostUpdate.ps1` | Health check: Node.js toolchain, Python imports, desktop dist freshness, gateway running. | 0=all pass, 2=broken |

### What the backup contains

The backup directory (`I:\PROJECTS\AIOS\update-guard-backups\<timestamp>-pre-update\`) includes:

- `hermes-agent.bundle` — full git history of ALL refs (+ refs/stash) [when `-FullBundle`]
- `tracked-changes.patch` — `git diff HEAD` (reapply with `git apply`)
- `stash-0.patch` — any existing stashes, exported
- `worktree\` — file mirror of the repo (excludes node_modules, venv, .git, dist)
- `manifest.txt` / `status.txt` — HEAD sha, branch, and `git status` snapshot

**Reapplying local edits after an update:**
```bash
git -C "I:\PROJECTS\AIOS\hermes-agent" apply --3way "<backup-dir>\tracked-changes.patch"
# Restore untracked files by copying from <backup-dir>\worktree\
```

### Pre-flight report

Pre-flight reports are saved to:
`I:\PROJECTS\AIOS\update-guard-reports\preflight-<timestamp>.txt`

---


## 4A. FULL Frontend + Backend Safe Update (end-to-end)

**Use this when the user asks for a "full update" of both the backend and the
desktop frontend.** It sequences the backend safe-update, the frontend rebuild,
and every validation gate into one ordered runbook. Both halves live in the
`hermes-agent` chassis on branch `aios` — this is one repo, updated in two
phases (Python backend, then Electron frontend), with a shared verification pass.

> **Golden rules that apply throughout:**
> - NEVER bare `hermes update` (refuse-guard protects the custom delta).
> - NEVER `npm ci` while the desktop/gateway is running (Windows file lock →
>   corrupted `node_modules`). Use `npm install` (in-place reconcile).
> - Branch MUST stay `aios` (the launcher refuses any other branch).
> - Local is canonical — never `git pull`/reset from origin to "fix" a break.

### Phase 0 — Diagnose (ALWAYS FIRST)

Determine whether the gap is to the fork (`origin/aios`) or to upstream
(`NousResearch/main`). This decides whether Phase 1 is the **Safe Update** or
the **Upstream Merge**.

```bash
cd I:\PROJECTS\AIOS\hermes-agent
git fetch origin && git fetch upstream
git rev-list --count HEAD..origin/aios          # behind the fork
git rev-list --count origin/aios..upstream/main # behind upstream
```

| Behind origin/aios | Behind upstream | Phase 1 becomes |
|---|---|---|
| > 0 | any | **Safe Update** (§4 / Phase 1 below) |
| 0 | > 0 | **Upstream Merge** (§5) — safe-update would be a NO-OP |
| 0 | 0 | Backend already current → skip to Phase 2 (frontend) only if a rebuild is needed |

Also record the seam baseline NOW (you'll re-check it after any merge):
```bash
git grep -c "AIOS-LOOP-SEAM" -- '*.py' '*.yml' '*.md'   # sum = live baseline (18 as of 2026-06-30)
git grep -c "AIOS-SAFE-UPDATE-GUARD" -- hermes_cli/main.py
```

### Phase 1 — Backend update (Python chassis)

**Stop the desktop app first** (a running gateway holds file handles into the
venv and `node_modules`; both phases mutate those trees):

```powershell
# Close the Hermes desktop window, then confirm the gateway port is free:
Get-NetTCPConnection -LocalPort 9120 -State Listen -ErrorAction SilentlyContinue   # expect: nothing
Get-Process -Name Hermes -ErrorAction SilentlyContinue                            # expect: nothing
```

Then run the orchestrator (prefer the AIOS source-of-truth copy):

```powershell
powershell -ExecutionPolicy Bypass -File `
  "I:\PROJECTS\AIOS\AIOS\scripts\update-guard\Invoke-HermesSafeUpdate.ps1" -Force
```

This runs pre-flight → backup → `hermes update --branch aios` (deps reinstall,
config migrate) → post-update health check. See §4 for the per-step table.

**If Phase 0 said "Upstream Merge" instead:** do §5 in full here (throwaway
branch, resolve conflicts, re-verify seams, reconcile deps, gates, promote),
THEN continue to Phase 2. The upstream merge already covers the Python dep sync;
the frontend rebuild below is still required.

### Phase 2 — Frontend rebuild (Electron desktop)

The desktop is an npm **workspace** — dependencies install from the **repo
root**, not `apps/desktop`. A backend update that changed `package.json` /
`package-lock.json`, or any change under `apps/desktop/src/`, requires this.

```powershell
# 1. Reconcile dependencies from the REPO ROOT (in-place; NOT npm ci).
cd I:\PROJECTS\AIOS\hermes-agent
npm install                     # restores/updates packages; needs network for Electron binary

# 2. Rebuild + pack the GUI (produces release\win-unpacked\Hermes.exe).
cd apps\desktop
npm run pack                    # tsc -b + vite build + electron-builder --dir
```

**Build pipeline (what `npm run pack` / `hermes desktop` runs):**
`assert-root-install → write-build-stamp → stage-native-deps → tsc -b →
vite build → assert-dist-built → electron-builder --dir` →
`apps\desktop\release\win-unpacked\Hermes.exe`.

**If the Electron binary download is blocked** (transient network / asleep
machine — log shows *"the Electron download from GitHub looks blocked"*):
```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
npm run pack        # retry
```

**Frontend failure modes** (read `%TEMP%\hermes-desktop.err.log` first — the
authoritative build log, NOT `hermes-home\logs\agent.log`):

| Symptom in TEMP log | Cause | Fix |
|---|---|---|
| `tsc` *"Cannot find module"* across `@assistant-ui/*`, `@tanstack/*`, `@tabler/icons-react`, `@xterm/*` | Corrupted/partial `node_modules` (interrupted install; `TAR_ENTRY_ERROR ENOENT`) | Re-run `npm install` from repo root |
| `electron-builder` *"Electron download … blocked"* / `✗ Desktop GUI build failed` | Electron binary not cached + download blocked | Set `ELECTRON_MIRROR` (above), retry |
| `npm ci` … `ENOTEMPTY: rmdir … node_modules\...` | Windows file lock — gateway/desktop still running | Close desktop; use `npm install`, never `npm ci` |
| Window opens but looks **plain/standard** | `config.yaml` `display.theme` not a real skin | Set `display.theme: editorial` in `hermes-home\config.yaml`, relaunch |
| Custom surfaces (kanban/config/logs/models) missing | Wrong branch / reverted delta | `git branch --show-current` must be `aios` |

### Phase 3 — Relaunch

```powershell
& 'C:\Users\LogosOne\Desktop\Hermes Desktop (Editorial).bat'
#   append  debug  to watch it build visibly
```

`hermes desktop` rebuilds on every launch if the working tree changed — commit
or stash stray `apps/desktop` edits to avoid surprise rebuilds.

### Phase 4 — Verify BOTH halves (all gates green)

```powershell
$env:PYTHONIOENCODING = "utf-8"
$env:HERMES_HOME = "I:\PROJECTS\AIOS\hermes-home"

# --- Backend ---
git -C I:\PROJECTS\AIOS\hermes-agent status --short          # clean / expected only
python I:\PROJECTS\AIOS\hermes-agent\scripts\loop_liveness.py   # exit 0 = seams intact + AC1 OK
python -m pytest plugins\memory\composite\tests               # memory wiring (LoopWiringError guard)
git grep -c "AIOS-LOOP-SEAM" -- '*.py' '*.yml' '*.md'          # sum == Phase-0 baseline

# --- Frontend ---
Test-Path "I:\PROJECTS\AIOS\hermes-agent\apps\desktop\release\win-unpacked\Hermes.exe"  # True
Get-NetTCPConnection -LocalPort 9120 -State Listen             # gateway listening
Get-Process -Name Hermes                                       # window process(es) up
```

**PASS =** backend tree clean · `loop_liveness.py` exit 0 · seam count matches
baseline · composite tests green · `Hermes.exe` exists · gateway on 9120 ·
window shows the custom surfaces (kanban/config/logs/models) in the Editorial
theme · no `LoopWiringError` on boot.

### Full-update quick checklist

1. ☐ Phase 0: `git fetch` both; diagnose gap; record seam baseline
2. ☐ Stop desktop (port 9120 free, no `Hermes` process)
3. ☐ Phase 1: backend safe-update (or upstream merge if gap is upstream)
4. ☐ Phase 2: `npm install` (repo root) → `npm run pack` (apps/desktop)
5. ☐ Phase 3: relaunch via the `.bat`
6. ☐ Phase 4: backend gates + frontend gates all green
7. ☐ Commit any AIOS-side runbook/script changes

---

## 5. Step 2: Upstream Merge (bring in NousResearch changes)

**When:** you are behind `upstream/main` (>0 commits) and already synced with
`origin/aios`. This is **manual and deliberate** — never automated.

**This is the procedure that actually closes the gap when `hermes update` says
"already up to date" but `hermes --version` still shows "commits behind."**

Per the fork-patch manifest: "merge upstream LOCALLY, never pull onto the
canonical tree; merge then push."

A detailed worked example (1,495-commit gap, all gates green) is in the skill's
`references/upstream-merge-runbook.md`.

### Step 0 — Pre-merge conflict analysis (decide scope before touching anything)

Compute the fork's *actual* customization footprint and cross-reference it
against the upstream gap. Most upstream commits touch files the fork never
customized → they merge clean. Only commits touching SHARED files can conflict.

```bash
MB=$(git merge-base aios upstream/main)
git diff --name-only "$MB..aios"                 # fork's customized files
git ls-tree -r --name-only upstream/main         # files that exist upstream
# SHARED = intersection = the real conflict surface
```

Key insight: when the fork's edits to shared files are **additive** (insertions,
~0 deletions — the seam/hook pattern), git 3-way auto-merges almost all of them.
A 1,495-commit gap with 174 potential-conflict commits collapsed to **4
actually-conflicting files** in practice.

### Step 1 — Backup (two layers)

```bash
git branch backup/aios-pre-upstream-merge-$(date +%Y%m%d-%H%M%S) aios
git bundle create /path/OUTSIDE/repo/aios-<ts>.bundle aios   # keep bundle OUT of the repo tree
```

Push the backup branch to origin too, as a remote safety net.

### Step 2 — Throwaway merge branch + inspect conflicts WITHOUT committing

```bash
git checkout -b merge/upstream-main-test aios
git merge --no-commit --no-ff upstream/main      # pauses on conflict; nothing committed yet
git diff --name-only --diff-filter=U             # the REAL conflict set
```

### Step 3 — Resolve conflicts by class

- **Additive code conflicts** (both sides added different code at the same
  anchor, no overlap): keep BOTH. Strip the `<<<<<<<`, `=======`, `>>>>>>>`
  marker lines, keep all content. Verify with `py_compile`.
- **Generated lockfiles** (`package-lock.json`, `uv.lock`): NEVER hand-merge.
  `git checkout --theirs -- package-lock.json`, then regenerate from the merged
  `package.json` (see Step 5).
- **Real logic collisions**: rare with the additive seam pattern; resolve by
  hand keeping the fork seam + upstream fix.

### Step 4 — Verify seam sentinels survived, then commit the merge

Auto-merge can silently drop a seam if upstream changed code right next to it.
Confirm the count matches the pre-merge baseline (use `git grep`, not a
filesystem walk):

```bash
git grep -c "AIOS-LOOP-SEAM" -- '*.py' '*.yml' '*.md'   # total must equal pre-merge baseline
git grep -c "AIOS-SAFE-UPDATE-GUARD" -- hermes_cli/main.py
```

Then `git add` the resolved files and `git commit` the merge.

### Step 5 — Reconcile dependencies (the step that actually breaks builds)

A large merge brings NEW dependencies (both Python and npm). The merge alone
does NOT install them — imports/typecheck will fail with `ModuleNotFoundError` /
`Cannot find module` until you sync. **This is expected, not a regression.**

```bash
# Python: sync venv to merged pyproject
uv pip install -e . --python .venv/Scripts/python.exe

# Frontend: it's an npm WORKSPACE — install from the REPO ROOT, not apps/desktop
"C:\Program Files\nodejs\npm.cmd" install --no-audit --no-fund     # hoists new deps
```

After dep sync, re-run the import smoke test / typecheck — the failures clear.

### Step 6 — Run ALL gates on the merge branch (verify before promoting)

Run every gate; promote `aios` ONLY if all pass:

```powershell
$env:PYTHONIOENCODING="utf-8"
$env:HERMES_HOME="I:\PROJECTS\AIOS\hermes-home"

python scripts\loop_liveness.py                         # exit 0 = seams intact + AC1 circulation OK
python -m pytest plugins\memory\composite\tests         # memory wiring (LoopWiringError guard)
python -m hermes_cli.main --version                     # CLI boots; version bumped
```

Plus: import smoke test of the chassis modules; frontend `npm run typecheck`
then `npm run build` (must produce `dist/index.html` + pass postbuild assertion).

**Distinguish merge regressions from pre-existing failures.** If a test fails,
check the SAME test against the pre-merge backup branch (via a detached
`git worktree add` at the backup SHA) before treating it as a regression.

### Step 7 — Promote and push (only after all gates green)

```bash
git checkout aios
git merge --ff-only merge/upstream-main-test    # aios is ancestor → clean fast-forward
git push origin aios
```

Rollback if anything misbehaves:
`git checkout aios && git reset --hard backup/aios-pre-upstream-merge-<ts>`

---

## 6. Step 3: Desktop App Rebuild (frontend, standalone)

**When:** after any change under `apps/desktop/src/` or `apps/desktop/electron/`,
after a backend update that bumped `package.json`/`package-lock.json`, or when
the desktop won't open / opens blank / looks like the plain upstream UI.
(For a *combined* backend+frontend update, use §4A instead — this section is the
frontend half in isolation.)

Authoritative deep-dive: `AIOS\docs\guides\RUNBOOK-custom-desktop-rebuild.md`
(diagnosis cheat-sheet + every failure mode).

### The rebuild (the procedure that works)

```powershell
# 0. STOP the running desktop first — a live gateway holds file handles into
#    node_modules; mutating it while running corrupts the tree (ENOTEMPTY).
Get-NetTCPConnection -LocalPort 9120 -State Listen -ErrorAction SilentlyContinue  # expect nothing

# 1. Reconcile dependencies from the REPO ROOT (in-place; NOT npm ci).
cd I:\PROJECTS\AIOS\hermes-agent
npm install                     # restores missing packages; needs network for Electron binary

# 2. Rebuild + pack the GUI.
cd apps\desktop
npm run pack                    # tsc -b + vite build + electron-builder --dir

# 3. Relaunch.
& 'C:\Users\LogosOne\Desktop\Hermes Desktop (Editorial).bat'
```

### Build pipeline (`npm run pack` / `hermes desktop`)

`assert-root-install → write-build-stamp → stage-native-deps → tsc -b →
vite build → assert-dist-built → electron-builder --dir` →
`apps\desktop\release\win-unpacked\Hermes.exe` (~214 MB). Gateway port **9120**.

### Why `npm install`, NOT `npm ci`

`npm ci` deletes `node_modules` wholesale before reinstalling. On Windows a
running gateway holds handles into that tree and the delete fails `ENOTEMPTY`,
leaving it *worse*. `npm install` reconciles in place. Always stop the desktop
before either.

### Electron download blocked

If `electron-builder` reports the download is blocked:
```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
npm run pack
```

### Logs and verification

- **Build/launch logs:** `%TEMP%\hermes-desktop.err.log` + `.out.log` (NOT
  `hermes-home\logs\agent.log`, which only has runtime turns). Read the `.err`
  first when a build fails.
- **Verify:** `Test-Path ...\release\win-unpacked\Hermes.exe` (True) ·
  `Get-NetTCPConnection -LocalPort 9120 -State Listen` · `Get-Process -Name Hermes`
  · window shows kanban/config/logs/models surfaces in the Editorial theme.

### Other useful commands

| Command | Purpose |
|---------|---------|
| `npm run pack` | Full build + electron-builder `--dir` → `win-unpacked\Hermes.exe` |
| `npm run build` | tsc + vite build only (no electron packaging) |
| `npm run dev` | Dev mode with HMR (concurrent Vite renderer + Electron) |
| `npm run typecheck` | Quick type check without emitting |
| `npm run dist:win` | Produce a Windows distributable installer |

### npm on this host

`npm` isn't reliably on PATH for `subprocess`/bash. Use the full path
`"C:\Program Files\nodejs\npm.cmd"` with `subprocess.run(..., shell=True)`. The
desktop is an npm workspace (`workspaces: apps/*, ui-tui, web`) so deps hoist
to root — run `npm install` from the repo root, never from `apps/desktop`.

---

## 7. Step 4: Promote aios → main (ship to main branch)

**When:** the user says "promote", "aios → main", or "ship to main". This is a
**different operation** from the Upstream Merge. Upstream Merge brings
NousResearch changes *into* `aios*. **Promotion** publishes the already-verified
`aios` work *onto* `main` (origin = `ccomcorp/hermes-agent`).

**It is an outward-facing remote push — verify EVERYTHING reversible first,
then confirm the exact push commands with the user before executing.**

A detailed worked example is in the skill's
`references/aios-main-promotion-runbook.md`.

### Step 0 — Diagnose the real gap (do NOT assume)

```bash
git fetch origin
git rev-parse --short aios origin/aios main origin/main   # are local feature commits even pushed?
git rev-list --count main..aios                            # how far main is behind aios
git merge-base --is-ancestor main aios; echo $?            # 0 = ff-able, non-0 = needs a merge commit
git rev-list --count aios..main                            # commits on main NOT in aios (prior promote-merges)
```

Common reality: your local feature commits are **not yet on `origin/aios`**
(so promotion is really TWO pushes), and `main` is NOT an ancestor of `aios`
(prior `"Merge branch 'aios' into main"` commits sit on main) → promotion
needs a **`--no-ff` merge commit**, not a fast-forward.

### Step 1 — Prove the merge is clean in a THROWAWAY worktree

The running dev app imports from the checked-out tree — do NOT `git checkout
main` on the live working dir to test. Use a detached worktree:

```bash
git worktree add --quiet /path/_promote_dryrun_wt main
git -C /path/_promote_dryrun_wt merge --no-commit --no-ff aios
git -C /path/_promote_dryrun_wt diff --name-only --diff-filter=U   # conflict set (expect none)
# DECISIVE CHECK: does merged-main == aios exactly?
git -C /path/_promote_dryrun_wt diff --stat aios                   # empty == IDENTICAL == safe
git -C /path/_promote_dryrun_wt merge --abort
git worktree remove --force /path/_promote_dryrun_wt
```

If `diff --stat aios` is empty, the merge result equals `aios` tree-for-tree —
the cleanest possible promotion.

### Step 2 — Run the gates on `aios` (verify before any push)

```bash
python scripts/loop_liveness.py                    # AC1 PASS + seams intact
python -m pytest plugins/memory/composite/tests    # memory wiring
python -m hermes_cli.main --version                # CLI boots; prints local HEAD + carried-commit count
```

### Step 3 — Execute (only after gates green + user confirms). Three pushes:

```bash
TS=$(date +%Y%m%d-%H%M%S)
# (a) BACKUP safety net, local + remote
git branch backup/aios-pre-main-promote-$TS aios
git push origin backup/aios-pre-main-promote-$TS
# (b) push the feature commits to origin/aios (fast-forward)
git push origin aios
# (c) promote to main with a merge commit, push, RESTORE aios
git checkout main
git merge --no-ff aios -m "Merge branch 'aios' into main: <what shipped>"
git diff --stat aios            # re-confirm IDENTICAL post-merge
git push origin main
git checkout aios               # CRITICAL: restore the branch the dev app loads from
```

### Step 4 — Verify at the REMOTE source (not local self-report)

```bash
git ls-remote origin refs/heads/main refs/heads/aios   # reads GitHub directly
git log -1 --format='%h parents=%p' <new-main-sha>      # parents = old-main + aios tip
```

Rollback: `git checkout aios && git reset --hard backup/aios-pre-main-promote-<ts>`
(and force-push if already pushed).

---

## 8. Post-Update Validation Checklist

After any update (Safe Update or Upstream Merge), verify:

1. **`git status --short`** — tree should be clean or only show expected changes
2. **`hermes --version`** — version bumped as expected; shows local HEAD + carried commits
3. **`python scripts/loop_liveness.py`** — seam sentinels + AC1 circulation (mandatory after upstream merge; optional after safe-update)
4. **Gateway running** — check via desktop app or `hermes gateway status`
5. **Desktop app boots** — without `LoopWiringError`
6. **Desktop dist fresh** — `dist/index.html` exists and is newer than source (run `npm run build` if not)

### Loop-liveness gate (detailed)

```powershell
$env:PYTHONIOENCODING = "utf-8"
$env:HERMES_HOME = "I:\PROJECTS\AIOS\hermes-home"
python scripts\loop_liveness.py
```

**Gate:** exit code **0** = pass. Non-zero = a seam moved or circulation broke.
The script names which sentinel is missing so re-homing is mechanical.

Additional verification:
```powershell
python -m pytest plugins\memory\composite\tests    # composite test suite
```

The composite's `initialize()` also refuses to boot (`LoopWiringError`) if
wiring is incomplete — a loud early signal that a delta row was lost.

---

## 9. The Seam Files (custom delta that must survive merges)

The AIOS self-learning loop is carried as a deliberate delta across the chassis.
Each call-site carries a `# AIOS-LOOP-SEAM:<id>` sentinel comment. If an upstream
merge moves a function, the sentinel moves with it or gets lost — the
loop-liveness gate catches this.

> **Verified baseline (2026-06-30): 18 `AIOS-LOOP-SEAM` sentinels across 8 files**
> (measured with `git grep -c "AIOS-LOOP-SEAM" -- '*.py' '*.yml' '*.md'`), plus
> **3 `AIOS-SAFE-UPDATE-GUARD`** in `hermes_cli/main.py`. **RE-MEASURE the count
> live before every merge** — it grows as the fork adds seams. Do NOT hardcode
> an old number. The 8 files: `.github/workflows/loop-liveness.yml` (3),
> `agent/background_review.py` (1), `agent/conversation_loop.py` (1),
> `docs/Update-Instructions/loop-fork-patch-manifest.md` (2),
> `docs/Update-Instructions/loop-liveness-gate.md` (2),
> `plugins/memory/composite/loop_guard.py` (5),
> `plugins/memory/composite/tests/test_loop_guard.py` (2),
> `tools/delegate_tool.py` (2).

The table below lists the core chassis delta (the semantic seams the loop
depends on); the full sentinel inventory is in `references/seam-map.md`.

| File | What the delta adds | Seam Sentinel |
|------|-------------------|---------------|
| `agent/memory_provider.py` | 4 OPTIONAL no-op ABC hooks: `confirm_prefetch_consumed`, `on_background_review`, `recall_for_delegation`, `confirm_consumed` | — |
| `agent/memory_manager.py` | Capability-guarded fan-out for the 4 hooks; `LoopWiringError` re-raise | — |
| `agent/background_review.py` | Chassis calls `manager.on_background_review(candidates,...)` instead of a `get_provider("composite")` lookup | `AIOS-LOOP-SEAM:background-review-write` |
| `tools/delegate_tool.py` | `_apply_predelegation_recall` dispatch + confirm orchestration | `AIOS-LOOP-SEAM:delegation-recall`, `AIOS-LOOP-SEAM:delegation-confirm` |
| `agent/conversation_loop.py` | `inject_turn_context` calls `mm.confirm_prefetch_consumed(...)` | `AIOS-LOOP-SEAM:injection-confirm` |
| `hermes_cli/main.py` | Safe-update refuse-guard: `_safe_update_blocked` helper + early-return in `cmd_update` | `AIOS-LOOP-SEAM:AIOS-SAFE-UPDATE-GUARD` |

**Invariant:** zero `"composite"` hard-strings in `agent/` or `tools/`. All
provider dispatch is generic fan-out.

Full table with data-flow diagram: see the skill's `references/seam-map.md`
and `docs/Update-Instructions/loop-fork-patch-manifest.md`.

---

## 10. Pitfalls and Known Issues

### Critical

- **Bare `hermes update` is blocked for a reason.** The refuse-guard protects
  26+ custom commits from `git reset --hard`. Use `Invoke-HermesSafeUpdate.ps1`.

- **`hermes update --branch aios` only syncs origin/aios.** It does NOT merge
  upstream changes. Upstream sync is a separate manual step (Step 2). When local
  is already synced with origin/aios (0 behind), the safe-update is a **silent
  no-op** — it reports success and changes nothing. Always run the diagnostic
  (Step 0) before recommending any update path.

- **`Resolve-HermesRealExe.ps1` must exist in `.venv\Scripts\`.** The
  orchestrator dot-sources it to find `hermes-real.exe` (post-shadow rename).
  If missing, Step 3 silently fails with "hermes.exe not found." The resolver
  prefers `hermes-real.exe` and falls back to `hermes.exe`.

- **The 6 seam files are the entire custom delta.** If an upstream merge moves
  a function, the sentinel comment moves with it or gets lost. The
  loop-liveness gate catches this — always run it post-merge.

### Operational

- **`-FullBundle` is a parameter on `Invoke-HermesSafeUpdate.ps1`, not on
  `Backup-HermesRepo.ps1`.** The backup script has no `-FullBundle` switch —
  it always creates a full backup unless `-NoBundle` is passed. The orchestrator
  passes `-NoBundle` by default; `-FullBundle` overrides that.

- **Desktop app changes require a rebuild.** Source changes under
  `apps/desktop/src/` are not picked up by the running app. Run `npm run build`
  then restart.

- **A merge does NOT install new dependencies.** Both Python
  (`uv pip install -e .`) and npm (`npm install` from the REPO ROOT — it's a
  workspace) must run after a merge. `ModuleNotFoundError` / `Cannot find
  module 'X'` post-merge means a new declared dep isn't installed yet; it is
  EXPECTED, not a regression.

- **Generated lockfiles never get hand-merged.** On a `package-lock.json` /
  `uv.lock` conflict, take `--theirs` (upstream) and regenerate from the merged
  manifest.

- **Verify seams with `git grep`, not a filesystem walk.** `os.walk` over the
  repo can hit transient read races and falsely report a present seam file as
  missing. `git grep -c "AIOS-LOOP-SEAM"` is fast and authoritative.

### Windows / tooling

- **Windows path handling.** The terminal tool runs through bash (git-bash/MSYS),
  not PowerShell. The safe-update scripts are PowerShell — invoke them via
  `powershell -ExecutionPolicy Bypass -File ...`. For git commands in bash, use
  forward slashes: `/i/PROJECTS/AIOS/hermes-agent`.

- **The terminal tool may fail if the session working directory doesn't exist.**
  If `terminal` returns `cd: <path>: No such file or directory`, use
  `execute_code` with `subprocess.run(..., cwd=repo)` as a workaround.

- **`read_file` and `search_files` do not resolve the `I:` drive** on this host.
  Use `execute_code` + `subprocess.run([...], cwd=repo)` with git's own tooling
  (`git show`, `git grep`, `git ls-files`) for repo inspection.

- **npm isn't reliably on PATH.** Use the full path
  `"C:\Program Files\nodejs\npm.cmd"` with `subprocess.run(..., shell=True)`.

### Upstream merge estimation

- **A large upstream gap looks scarier than it is — measure before estimating.**
  A 1,495-commit gap collapsed to 4 actually-conflicting files because the
  fork's edits are additive (seams/hooks, ~0 deletions). Run the Step-0
  conflict analysis to get the REAL conflict surface instead of guessing from
  the commit count. Do NOT batch-split the merge preemptively; a single
  `git merge --no-commit` reveals the true scope.

---

## 11. Reference Documents

### In the repo (`docs/Update-Instructions/`)

| Document | What it covers |
|----------|---------------|
| `loop-fork-patch-manifest.md` | The carried delta manifest — authoritative for what must survive merges |
| `loop-liveness-gate.md` | Post-merge verification gate details (AC-PX6) |
| `upstream-gap-digest.md` | What's in the upstream gap (commits by type/subsystem) |
| `upstream-merge-feasibility.md` | What's safe to pull (tiered conflict analysis) |

### In the skill (`hermes-fork-maintenance`)

| Reference | What it covers |
|-----------|---------------|
| `references/seam-map.md` | Full seam table with data-flow diagram |
| `references/update-diagnostic.md` | Decision tree with worked example |
| `references/upstream-merge-runbook.md` | Full upstream merge worked example (1,495 commits) |
| `references/aios-main-promotion-runbook.md` | aios → main promotion worked example |
| `scripts/check-update-need.py` | Automated diagnostic probe |

### Other

| Document | What it covers |
|----------|---------------|
| `website/docs/getting-started/updating.md` | Official upstream update flow (general reference only — describes upstream behavior, not this fork's customizations) |
| `AGENTS.md` | Project conventions and rules (byte-identical to upstream — do not edit) |

---

## Workflow Preference: Local Docs First

**Always check the local documentation in the repo before fetching online docs.**
This installation is customized — the online docs at
`hermes-agent.nousresearch.com` describe the upstream behavior, not the fork's
customizations. Only consult online docs for upstream context that the local
docs reference but don't duplicate.

---

*Last updated: 2026-06-24. Maintained in conjunction with the `hermes-fork-maintenance` skill.*
