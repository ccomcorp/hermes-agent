# LIVE-STATUS — hermes-agent

**Mode:** hybrid  
**Root:** `D:\HeicH\hermes-agent`  
**Home:** `D:\HeicH\hermes-home`  
**Updated:** 2026-07-26 (Kanban C+D Slices 1–3 source-fixed/tested; non-primary memory fence source-fixed/tested; Desktop backend/LSP recovery source-fixed/tested; clarify cancellation/Skip semantics fixed, tested, and built; packaged Desktop pack/restart pending)
**Updated:** 2026-07-26 — WAL checkpoint close-path fix landed; Python venv resolution hardened; LSP diagnostic latch verified. All focused gates green (Python 41/41 + Desktop 24/24). Desktop repackaged; restart pending.

## Scoreboard

| Area | Status | Notes |
|------|--------|--------|
| Cutover HeicH | **PASS** | Desktop live on D: path; stamp e19a76010 |
| DocOps hybrid | **PASS** | active; drift cleared |
| DocOps Desktop panel | **FIXED (source)** | Hosted in Panel/OverlayView; theme tokens; needs Desktop rebuild to ship |
| Desktop left-panel routing | **FIXED (source + built)** | Visible built-in sidebar rows now have route constants + mounted workspace/overlay surfaces + split-pane renderers; restart Desktop to load |
| Clarify cancellation semantics | **FIXED (source + built)** | Stop/session.interrupt now produces `cancelled`, never Skip; first reply/cancel wins atomically; Python 226 + Desktop 40 focused tests and production build passed; pack/restart pending |
| Desktop Windows checks | **TESTS GREEN / PACKAGE LOCKED** | `npm run check` now passes typecheck + all app tests (2775/4 skipped); `test:desktop:all` package step hits EBUSY because this live Desktop is running from `apps/desktop/release/win-unpacked` |
| Desktop blank workspace / LSP logs | **SOURCE FIXED / RESTART PENDING** | Backend resolves the actual `.venv` interpreter instead of an unconfigured system Python; unsupported TypeScript pull diagnostics latch off after `-32601`. Desktop typecheck + 49 focused LSP tests green; package/restart still required. |
| SQLite WAL checkpoint I/O error | **FIXED (source)** | `SessionDB.close()` skips TRUNCATE checkpoint for SQLite 3.51.0–3.51.2 (WAL-reset bug); commit-path keeps PASSIVE. 16 focused tests green. Desktop repackaged; restart pending. |
| Composite + experience | **PASS** | 357 lessons; AIOS_PACKAGES_DIR wired |
| Non-primary memory fence | **SOURCE FIXED** | cron/subagent/flush agents carry explicit lifecycle context; direct `memory` writes fenced before MEMORY/USER/provider mutation; focused gates green |
| NeuroLinked | **PASS** | connected ADOLESCENT |
| QMD + gbrain | **PASS** | dual vault retrieval OK |
| MCP suite | **PASS** | all 6 servers enabled |
| Outcome-signal bind | **PASS** | unit tests green |
| CodeGraph | **PASS** | re-init 4650 files / 123667 nodes |
| Open Notebook | **PASS** | :5055 healthy |
| Delegation routes + Route Advisor | **SOURCE FIXED** | Routes live; route_advisor B1 lane-by-type + verify nudge committed source; runtime config opted in; restart gateway/Desktop to load |
| Kanban C+D + brain model selection | **SLICES 1–3 SOURCE FIXED** | Deterministic overrides and default-assignee compatibility routes are tested; `routing-report [--json]` now exposes C+D `assigned`-event aggregates (route reason, assignee, tier, optional model) without leaking raw payloads. Brain-learned selection remains deferred pending a route/outcome corpus. |
| Upstream/main merge | **LOCAL PASS** | Branch `merge/upstream-main-test-20260723-005006`; conflicts resolved; adversarial B1 dashboard-backup duplicate `-o` blocker fixed with regression; local gates green; push/promote still pending explicit final review/approval |

## Maintenance

Same-work-unit DocOps on every change. Cascade: CHANGELOG / session-log / LIVE-STATUS / extract-approach.

## Commands

```powershell
powershell -File D:\HeicH\launch-hermes.ps1 desktop
D:\HeicH\hermes-agent\.venv\Scripts\hermes-real.exe dox status --root D:\HeicH\hermes-agent
```

Full diag report: `H:/WSpace-Hermes/hermes-projects/docs/hermes-agent/reports/system-diagnostics-HeicH-2026-07-16.md`
