# LIVE-STATUS — hermes-agent

**Mode:** hybrid  
**Root:** `D:\HeicH\hermes-agent`  
**Home:** `D:\HeicH\hermes-home`  
**Updated:** 2026-07-20 (Delegation routes skills closeout HS-4)

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
| Delegation routes (skills) | **PASS** | HS-4 closeout 2026-07-20; hermes-model-routing v1.1.0 + hermes-team-routing v1.0.1 |

## Maintenance

Same-work-unit DocOps on every change. Cascade: CHANGELOG / session-log / LIVE-STATUS / extract-approach.

## Commands

```powershell
powershell -File D:\HeicH\launch-hermes.ps1 desktop
D:\HeicH\hermes-agent\.venv\Scripts\hermes-real.exe dox status --root D:\HeicH\hermes-agent
```

Full diag report: `H:/WSpace-Hermes/hermes-projects/docs/hermes-agent/reports/system-diagnostics-HeicH-2026-07-16.md`
