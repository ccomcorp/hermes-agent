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
- **2026-07-17** — DocOps target resolution fix: panel opened to wrong/uninitialized location when a project was selected. Backend `status_project`/`check_project` gained `search_parents` (walk up to nearest `docops.yml`); `/api/dox/status` + `/api/dox/check` pass it so a subfolder cwd (or a Windows junction like `Azure-Infrastructure` → `Microsoft-O365-Azure/plans/azure-alpha-remediation`) resolves to the real initialized root. Status payload returns resolved `root`. Desktop `DocOpsView` targets active project's primary workspace path (fallback: live cwd) instead of raw `$currentCwd`. Files: `agent/dox/core.py`, `hermes_cli/web_server.py`, `apps/desktop/src/app/docops/index.tsx`, `apps/desktop/src/types/hermes.ts`, `tests/dox/test_dox_core.py`, `apps/desktop/src/app/docops/index.test.tsx`. Gates: 29 dox py green, 20 docops UI tests green, backend edits lint-clean. (Same change first landed in the `I:` clone as `60009591a`; ported here to the live `D:` chassis.)

### Core product rules (docs)

- **2026-07-16** — Self-improvement loop recorded as **core functionality** in `AGENTS.md` (What Hermes Is + dedicated section). Recursive learning circulation: author → recall → outcome reward. Enhance existing composite/background_review/outcome path only — no parallel mass-reward daemon.

### Memory / learning chassis (working tree)

- **2026-07-16** — Desktop/gateway outcome-signal fix: task-local `push_active_agent` in `AIAgent._execute_tool_calls`; engineering_loop `_emit_outcome_signal` uses it; active harness auto-signals test-like terminal exit codes. Verified: composite tests 112 passed + 1 skipped.

### Operator home (hermes-home, not this git tree)

- MEMORY/USER consolidated; QMD MCP re-enabled; gbrain skill narrative reconciled; dream cycle script import+`--dir` (see hermes-home cron `dbb156f78f80`).
- **2026-07-17** — cli: fix spurious `Unknown toolsets: mcp-<server>` init warning — pre-discovery validation now accepts the canonical `mcp-<server>` toolset form for configured `mcp_servers` (`_unknown_toolsets_pre_discovery`, cli.py; 7 regression tests in tests/hermes_cli/test_toolset_init_warning.py).
- **2026-07-20** — Delegation routes skills update: `hermes-model-routing` v1.1.0 (Named delegation routes — config shape, route param usage, precedence chain, credential-hygiene rule, effect timing table, live-probe recipe, routing policy + orchestration guidance, Route Advisor plugin). `hermes-team-routing` v1.0.1 (Delegation routes cross-reference section — profile vs route decision matrix, when NOT to use routes). Kanban HS-4 (t_a6ecfe10) closeout.
