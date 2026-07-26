# Changelog — hermes-agent DocOps ledger

Keep entries short. Detailed pre-hotfix ledger entries from this active update cycle were archived to `dox/archive/CHANGELOG-2026-07-16-to-2026-07-23-pre-routing-hotfix.md` after the ledger crossed its DocOps word budget.

## Unreleased

### Desktop / routing

- **2026-07-26** — Fixed stuck-forever composer queue drain: when a background queue drain exhausts `MAX_AUTO_DRAIN_ATTEMPTS`, the entry is now removed from localStorage instead of retrying on every app restart forever. Previously only a notification was shown but the entry was never cleaned up, so each restart reset the in-memory failure counter and the toast would re-fire. One-line fix in `use-background-queue-drain.ts`: call `removeQueuedPrompt()` after the terminal notification. Gates: typecheck green, `use-background-queue-drain.test.tsx` 6/6 passed.
- **2026-07-24** — Fixed pending-clarify cancellation semantics across the Desktop/TUI and messaging bridges. `session.interrupt` now resolves clarify prompts with an identity-only internal cancellation value instead of the empty-string Skip value; `clarify_tool` emits explicit `answered` / `skipped` / `cancelled` status; Desktop renders Cancelled distinctly and suppresses late-answer choices. First terminal resolution is atomic, so a reply and cancellation cannot overwrite one another. Adversarial follow-up confirmed the sentinel boundary and in-lock first-wins update; corrected the last stale gateway callback comment so it no longer claims cancellation is an empty timeout/Skip response. Focused gates: Python clarify/gateway/protocol **226 passed**; Desktop UI **40 passed**; TypeScript, Ruff, and Desktop production build green; focused ESLint 0 errors (12 existing test warnings).
- **2026-07-23** — Fixed the post-upstream-merge Desktop left-panel route-mount regression. Visible built-in routes now have complete wiring across route constant, sidebar row, mounted workspace/overlay surface, and split-pane renderer. Restored mounts for Models, Kanban, Canvas, Channels, Pairing, Webhooks, Plugins, Files, Workbench, System, Config, Logs, and DocOps; updated the `session-actions-menu` test mock for upstream project-store exports. Source docs checked: `apps/desktop/AGENTS.md`, `apps/desktop/README.md`, and `website/docs/developer-guide/desktop-plugin-sdk.md`. Gates: touched-file ESLint green; Desktop typecheck green; focused UI tests **6 passed**; full Desktop UI suite **2074 passed / 1 skipped**; Desktop build/assert-dist green.
- **2026-07-23** — Resolved the Windows/Electron test failures surfaced by full Desktop check: made path-sensitive helpers/tests platform-explicit (`path.posix`/`path.win32`), forced ControlMaster tests into mux mode on Windows, skipped POSIX-only symlink permission assertions on Windows, and lengthened a slow real-git worktree test. `npm run check --workspace apps/desktop` now passes typecheck and all app tests (**2775 passed / 4 skipped**); remaining failure is package output lock (`EBUSY`) because the live Desktop process is running from `apps/desktop/release/win-unpacked`.

### Tooling / guardrails

- **2026-07-26** — Completed Kanban C+D Slice 3: added the read-only `hermes kanban routing-report [--json]` over persisted C+D `assigned` events. It aggregates route reason, resolved assignee, tier, and optional model while excluding non-routing/malformed payloads and raw task data. A producer→consumer review caught and fixed the `route_reason` field contract before commit. Focused C+D gates: **86 passed**; Ruff, `py_compile`, diff check, and empty-board smoke green.
- **2026-07-25** — Advanced-elicited the proposed universal CodeGraph/DOX/milestone policy through independent execution-surface, lifecycle-safety, and enforceability lenses. Reconciled 12 findings by defining deterministic refresh/root binding and bounded fallback receipts; versioned project-policy envelopes for delegated/Kanban work; per-surface DOX receipts; a parked/validated/committed milestone state machine; and the explicit v1 boundary that ordinary shell/manual Git is instruction-and-audit governed rather than universally host-intercepted. Runtime implementation remains blocked pending fresh re-review.
- **2026-07-25** — Made CodeGraph the mandatory first code-search/comprehension path in the engineering loop: initialize the repository graph when absent, inspect symbols/flows/blast radius before edits, and use text search only for docs/non-code or a recorded graph limitation.
- **2026-07-25** — Strengthened the engineering-loop specification gate after a live DYADOMORPH workstream entered implementation without its mandatory advanced-elicitation pass. Frozen, inherited, and partially implemented specs are no longer implicitly grandfathered: discovering a skipped gate now requires stop/park, preserved edits, independent elicitation, source verification, reconciled specs/ADRs/evals, and a committed design slice before implementation resumes.
- **2026-07-25** — Implemented Kanban C+D deterministic overrides Slice 1. Fresh/legacy boards now have `tasks.complexity_override`; explicit complexity tiers and explicit model pins on `assignee=auto` route deterministically without invoking the classifier; `default_to_trigger:true` opts unassigned cards into C+D before `kanban.default_assignee` can bypass it; classifier-suggested optional models are validated before storage/spawn and rejected suggestions are logged without blocking the profile route. Focused Slice 1 tests **34 passed**; `py_compile`, Ruff, and diff check green.
- **2026-07-24** — Added lifecycle `agent_context` wiring and a central non-primary memory-write fence: cron/subagent/flush agents now carry explicit context into memory providers, and direct `memory` tool writes from those contexts are blocked before `MEMORY.md`/`USER.md` or provider mirrors can mutate.
- **2026-07-24** — Added the source-grounded Kanban C+D completion spec at `docs/plans/2026-07-22-kanban-cd-brain-model-selection-work-spec.md` (`c594e6dfb`). The spec records that in-chat delegation routes are complete, Kanban classifier routing remains partial, and brain-learned model selection stays deferred until C+D produces a structured route/outcome corpus.
- **2026-07-23** — Upstream/main merge landed locally with AIOS/local seams preserved; follow-up fixed duplicate dashboard backup `-o` flag in `/api/ops/backup`. Detailed gate evidence and conflict notes are in the archive file above.
- **2026-07-22** — Kanban worker-lifecycle Windows portability committed as `8b53cd5b7`; fixed raw exit-status decoding, Windows dead-PID reclaim handling, and `~/.hermes` profile fallback. Detailed A/B failure-set analysis is in the archive.
- **2026-07-21** — Fixed cron-session env leak into interactive approval checks by replacing process-global `HERMES_CRON_SESSION` with task-local context.
- **2026-07-21** — Fixed tool-loop guardrail false positives so truthful negatives such as `not_found` no longer count as repeated tool failures.
- **2026-07-21** — Route Advisor gained lane-by-type routing nudges and verification nudges; runtime config opted in.

### Desktop / voice

- **2026-07-22** — Slash-command popover now works mid-message by detecting the last slash token at a command boundary while preserving path/URL/ratio guards.
- **2026-07-16** — Voice conversation hardening fixed cancel-during-speak re-arm races and added spoken-reply guard tests.

### DocOps

- **2026-07-16** — Initialized Hermes-native hybrid DocOps on the chassis root: `docops.yml`, `dox/`, `LIVE-STATUS.md`, standards doc, and DOX marker in `AGENTS.md`.
- **2026-07-16/17** — Desktop DocOps panel made shell-respecting and theme-safe, then fixed to resolve initialized project roots through backend parent-walk plus Desktop project targeting.

### Operator / layout

- **2026-07-16** — Chassis cut over to `D:\HeicH\hermes-agent` with `D:\HeicH\hermes-home`; launch/update paths rewired and system diagnostics recorded.
