# Changelog — hermes-agent DocOps ledger

Keep entries short. Shard or archive if approaching the ledger word budget in `docops.yml`.

## Unreleased

### Desktop / voice

- **2026-07-16** — P2a Voice conversation hardening: fixed cancel-during-speak race in `use-voice-conversation.ts` (`cancelledRef` guards re-arm after `end()`). Added 14 Vitest unit tests across `use-voice-conversation.test.tsx` (4 race-condition tests: cancel-end during speak, status transitions, re-arm after cancel) and `use-auto-speak-replies.test.tsx` (10 tests: spoken_reply fallback, hold-until-idle, conversation-inactive guard, empty/null reply, dedupe). EVAL-VDP-006 (package audit): confirmed zero HuggingFace/transformers/S2S dependencies in desktop.

### Operator / layout

- **2026-07-16** — Chassis relocation investigation: GitHub origin already independent (`ccomcorp/hermes-agent`). Prefer clone/move existing fork to NEW_PATH + rewire path pins (`launch-dev-hermes`, update-guard, kanban workdir, `AIOS_PACKAGES_DIR` for composite). Do **not** create a second GitHub repo. Plan: `H:/WSpace-Hermes/hermes-projects/docs/hermes-agent/plans/chassis-relocation-investigation-2026-07-16.md`. Cutover pending user NEW_PATH + WIP commit.

### DocOps

- **2026-07-16** — `hermes dox init --mode hybrid` on chassis root. Layers: contract + ledger + publish. Markers: `docops.yml`, `dox/`, LIVE-STATUS, `docs/standards/DOCUMENT-MANAGEMENT.md`, `<!-- hermes-dox -->` on `AGENTS.md`. **Rule:** all development/changes must maintain DocOps (contract walk, ledger, LIVE-STATUS when status moves).
- **2026-07-16** — Desktop DocOps panel: wrap in `Panel`/`OverlayView` (stop full-window takeover), switch to theme tokens/`PanelPill` (Editorial/Slate-safe), restore dismiss (Esc/X/backdrop) + Refresh/Run Check. Files: `apps/desktop/src/app/docops/index.tsx`, `index.test.tsx`. Gate: typecheck + 18 docops UI tests.

### Core product rules (docs)

- **2026-07-16** — Self-improvement loop recorded as **core functionality** in `AGENTS.md` (What Hermes Is + dedicated section). Recursive learning circulation: author → recall → outcome reward. Enhance existing composite/background_review/outcome path only — no parallel mass-reward daemon.

### Memory / learning chassis (working tree)

- **2026-07-16** — Desktop/gateway outcome-signal fix: task-local `push_active_agent` in `AIAgent._execute_tool_calls`; engineering_loop `_emit_outcome_signal` uses it; active harness auto-signals test-like terminal exit codes. Verified: composite tests 112 passed + 1 skipped.

### Operator home (hermes-home, not this git tree)

- MEMORY/USER consolidated; QMD MCP re-enabled; gbrain skill narrative reconciled; dream cycle script import+`--dir` (see hermes-home cron `dbb156f78f80`).
