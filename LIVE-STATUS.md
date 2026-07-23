# LIVE-STATUS — hermes-agent

**Mode:** hybrid  
**Root:** `D:\HeicH\hermes-agent`  
**Home:** `D:\HeicH\hermes-home`  
**Updated:** 2026-07-23 (upstream/main merge blocker fixed + verified locally)

## Scoreboard

| Area | Status | Notes |
|------|--------|--------|
| Cutover HeicH | **PASS** | Desktop live on D: path; stamp e19a76010 |
| DocOps hybrid | **PASS** | active; drift cleared |
| DocOps Desktop panel | **FIXED (source)** | Hosted in Panel/OverlayView; theme tokens; needs Desktop rebuild to ship |
| Composite + experience | **PASS** | 357 lessons; AIOS_PACKAGES_DIR wired |
| NeuroLinked | **PASS** | connected ADOLESCENT |
| QMD + gbrain | **PASS** | dual vault retrieval OK |
| MCP suite | **PASS** | all 6 servers enabled |
| Outcome-signal bind | **PASS** | unit tests green |
| CodeGraph | **PASS** | re-init 4650 files / 123667 nodes |
| Open Notebook | **PASS** | :5055 healthy |
| Delegation routes + Route Advisor | **SOURCE FIXED** | Routes live; route_advisor B1 lane-by-type + verify nudge committed source; runtime config opted in; restart gateway/Desktop to load |
| Upstream/main merge | **LOCAL PASS** | Branch `merge/upstream-main-test-20260723-005006`; conflicts resolved; adversarial B1 dashboard-backup duplicate `-o` blocker fixed with regression; local gates green; push/promote still pending explicit final review/approval |

## Maintenance

Same-work-unit DocOps on every change. Cascade: CHANGELOG / session-log / LIVE-STATUS / extract-approach.

## Commands

```powershell
powershell -File D:\HeicH\launch-hermes.ps1 desktop
D:\HeicH\hermes-agent\.venv\Scripts\hermes-real.exe dox status --root D:\HeicH\hermes-agent
```

Full diag report: `H:/WSpace-Hermes/hermes-projects/docs/hermes-agent/reports/system-diagnostics-HeicH-2026-07-16.md`
