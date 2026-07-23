# Changelog — hermes-agent DocOps ledger

Keep entries short. Detailed pre-hotfix ledger entries from this active update cycle were archived to `dox/archive/CHANGELOG-2026-07-16-to-2026-07-23-pre-routing-hotfix.md` after the ledger crossed its DocOps word budget.

## Unreleased

### Desktop / routing

- **2026-07-23** — Fixed the post-upstream-merge Desktop left-panel route-mount regression. Visible built-in routes now have complete wiring across route constant, sidebar row, mounted workspace/overlay surface, and split-pane renderer. Restored mounts for Models, Kanban, Canvas, Channels, Pairing, Webhooks, Plugins, Files, Workbench, System, Config, Logs, and DocOps; updated the `session-actions-menu` test mock for upstream project-store exports. Source docs checked: `apps/desktop/AGENTS.md`, `apps/desktop/README.md`, and `website/docs/developer-guide/desktop-plugin-sdk.md`. Gates: touched-file ESLint green; Desktop typecheck green; focused UI tests **6 passed**; full Desktop UI suite **2074 passed / 1 skipped**; Desktop build/assert-dist green.
- **2026-07-23** — Resolved the Windows/Electron test failures surfaced by full Desktop check: made path-sensitive helpers/tests platform-explicit (`path.posix`/`path.win32`), forced ControlMaster tests into mux mode on Windows, skipped POSIX-only symlink permission assertions on Windows, and lengthened a slow real-git worktree test. `npm run check --workspace apps/desktop` now passes typecheck and all app tests (**2775 passed / 4 skipped**); remaining failure is package output lock (`EBUSY`) because the live Desktop process is running from `apps/desktop/release/win-unpacked`.

### Tooling / guardrails

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
