# Session Log

## 2026-07-22 — Slash popover mid-message fix

- User: `/` popup only appears at position 0 of the chat box; typing `/` mid-message shows no command list, so commands can't be combined while composing.
- Root cause: `SLASH_TRIGGER_RE` in `apps/desktop/src/app/chat/composer/text-utils.ts` was `^...$` anchored — deliberate old behavior ("slash commands only execute at the beginning of a message"), now stale vs. desired UX.
- Fix: `lastSlashTokenStart()` scans for the last `/` at a token boundary (start-of-text or after whitespace); command grammar matched from there. Path/ratio/URL guards preserved. Tests updated + extended (14/14). Commit `e3d42c85e`.
- Gates: touched-file tsc + eslint clean; composer-suite `document is not defined` failures proven pre-existing via `git stash` A/B.
- **Ship:** requires Desktop rebuild (REPO ROOT npm install → build/pack, stop Desktop first).

## 2026-07-16 — Chassis relocation investigation

- User: finalize AIOS build phase; move hermes-agent to new directory; proposed new GH repo → push → clone.
- **Finding:** origin already `ccomcorp/hermes-agent` (independent). Better = relocate checkout of existing fork + rewire paths; not a second GitHub remote.
- **Critical pins:** launch-dev-hermes `$Chassis`, update-guard defaults, HERMES_DESKTOP_HERMES_ROOT, kanban engineering workdir, desktop project path, **AIOS_PACKAGES_DIR** for composite when sibling layout breaks.
- **hermes-home:** keep separate; do not fold into chassis git.
- Plan written: `H:/WSpace-Hermes/hermes-projects/docs/hermes-agent/plans/chassis-relocation-investigation-2026-07-16.md`
- Cutover **not executed** — blocked on NEW_PATH + WIP commit.

## 2026-07-16 — DOX hybrid init + self-improvement standing rule

- **Root:** `I:/PROJECTS/AIOS/hermes-agent`
- **Action:** `hermes dox init --mode hybrid` (user chose hybrid mid-init)
- **Status after:** `active: true`, layers contract/ledger/publish all true, `dox check` drift none
- **Also this session stream:** memory stack verification; MEMORY consolidation; gbrain skill reconcile; QMD MCP on; dream script fix; recursive self-improvement documented as core; chassis outcome-signal Desktop bind
- **Closeout expectation:** keep LIVE-STATUS/CHANGELOG updated on further hermes-agent edits; commit DocOps + AGENTS self-improvement section when packaging a release commit

## 2026-07-16 — Cutover to D:\HeicH

- Chassis at D:\HeicH\hermes-agent @ e19a76010
- hermes-home copied to D:\HeicH\hermes-home
- launch + update-guard rewired; AIOS_PACKAGES_DIR set
- Desktop cutover still requires user stop/repack/relaunch

## 2026-07-16 — Full system diagnostics post-HeicH cutover

- Desktop confirmed on D:\HeicH paths (Hermes.exe + hermes-real).
- All critical systems PASS (see reports/system-diagnostics-HeicH-2026-07-16.md).
- CodeGraph re-indexed on new path (123,667 nodes).
- Legacy I:\PROJECTS\AIOS\hermes-* retained as backup only.

## 2026-07-16 — DocOps side panel full-window + theme fix

- **Symptom:** Selecting DocOps from left nav took over the entire Desktop window (no shell/sidebar respect); not Editorial theme; looked non-functional; required app restart to recover.
- **Root cause:** `DocOpsView` registered as overlay route (`OVERLAY_VIEWS` includes `docops`) but did **not** wrap in shared `Panel`/`OverlayView` chrome (unlike Agents/Cron/Profiles/Starmap). Bare `h-full` content rendered without fixed inset card → full-window paint. Palette used frozen dark-theme greens/reds (`text-green-300`, `bg-green-900/*`) instead of semantic/`PanelPill` tokens.
- **Fix:** Rewrite `apps/desktop/src/app/docops/index.tsx` to host in `Panel` (Esc/backdrop/close), `PanelHeader`/`PanelEmpty`/`PanelPill`/`PanelMeta`/`PanelAction`, theme-safe tokens, Refresh + Run Check actions. Tests 18/18 green; typecheck clean.
- **Ship:** Desktop rebuild+restart required for the running app to show the fix.

## 2026-07-17 — Fix: spurious "Unknown toolsets: mcp-*" warning at agent init

- **Symptom:** Every spawned agent (kanban workers, CLI sessions) with `mcp-codegraph` in `platform_toolsets` printed `Warning: Unknown toolsets: mcp-codegraph` despite a correctly configured `mcp_servers.codegraph`.
- **Root cause:** `HermesCLI.__init__` pre-discovery validation whitelisted only *bare* `mcp_servers` key names, but `discover_mcp_tools` registers MCP toolsets under the canonical `mcp-<server>` form (tools/mcp_tool.py `toolset_name = f"mcp-{name}"`). The canonical form therefore always failed pre-discovery validation.
- **Fix:** Extracted `_unknown_toolsets_pre_discovery()` in cli.py — accepts bare server names AND the `mcp-`-prefixed canonical form when `<server>` is configured. Regression tests in `tests/hermes_cli/test_toolset_init_warning.py` (7/7 green).
- **Verified:** new tests 7/7; `test_toolsets.py` + `test_mcp_dynamic_discovery.py` — 3 failures in TestMessageHandler confirmed PRE-EXISTING (identical on pristine tree via git stash); diff LF-clean (21+/2-).
- **Ship:** New spawns load fixed code from disk; running gateway/Desktop keep old image until process restart.

## 2026-07-20 — Delegation routes skills closeout (HS-4)

- **Task:** Kanban HS-4 (t_a6ecfe10) — routing policy skills + DOX closeout. Parents HS-1 (t_b8cea341, core fork), HS-2 (t_db33106a, Desktop panel), HS-3 (t_fcf3e741, route_advisor plugin) all complete.
- **hermes-model-routing v1.1.0:** Hard truth #2 updated for fork capability (grep probe). Replaced brief fork notice with full Named delegation routes section: config shape (A1), route param usage incl. batch, precedence chain, credential-hygiene rule (R1-B1), effect timing table (R2-B2 corrected), live-probe verification recipe. Added Routing policy (orchestration guidance — plan on main → implement route=coding → review route=review → verify on main) and Relationship to hermes-team-routing comparison table.
- **hermes-team-routing v1.0.1:** Added related_skills → hermes-model-routing. New "Delegation routes (same-chat model lanes)" section: profile vs route decision matrix, how routes work (config + delegate_task usage), when NOT to use routes (four anti-patterns).
- **DOX:** CHANGELOG entry, session-log entry, LIVE-STATUS scoreboard row.
- **No chassis changes** — skills-only update to hermes-home.

## 2026-07-21 — Tool-loop guardrail truthful-negative fix + two-instance contention

- User: investigate `same_tool_failure_halt` via systematic debugging; find root cause and remediate.
- **Root cause (code):** the broad content classifier (mirror of `display._detect_tool_failure`) counted *truthful negatives* — process `not_found`, read_file `File not found` — as failures into the args-blind same-tool counter, so legitimate diagnostics against absent/degraded state marched to halt. Fix: new `tool_result_is_truthful_negative` predicate in `agent/tool_result_classification.py`; `after_call` skips the same-tool increment for negatives. Exact-signature counter stays broad (identical-args repetition of any failure type still blocks); genuine failure streaks neither incremented nor reset by negatives. 4 regression tests in `tests/agent/test_tool_guardrails.py`; guardrails + runtime + classification 30/30 green.
- **Root cause (operational — why so many failures existed to count):** TWO Hermes desktop instances + TWO `serve` backends running concurrently (started 2026-07-21 09:14:11/13) sharing one HERMES_HOME/profile → `gateway_state.json` write contention (WinError 5 in errors.log), ws write stalls >10s ("frame left in flight"), process-registry `not_found`, wedged terminal output, and wedged calls landing MULTIPLE times (triple-applied patch in a CCOM-Email test file; 5 duplicate sweep runs). Log evidence: `tui_gateway.ws: ws write slow (loop stalled >10.0s)`; desktop.log `[hermes] [boot] Restarting desktop connection`.
- **Open item:** `same_tool_args_drift_warning` code observed in-session exists nowhere in chassis source (Python/TS) or git history — suspected outer-harness detector, not editable from this tree.
- **Operational recommendation (user decision, not executed here):** run concurrent sessions under distinct profiles (isolated state) or accept the contention; do not kill the other session's processes from this side.
- Restart of the desktop required for the guardrail fix to go live.

## 2026-07-21 — Cron-flag leak into interactive approvals (execute_code blocked mid-session)

- User: investigate why cron-mode jobs were getting blocked; `execute_code` was blocked by a cron-mode guard.
- **Symptom:** `execute_code` succeeded ~4× this session, then blocked once with the `cron_mode: deny` message ("cron jobs run without a user present"). Live process env showed `HERMES_CRON_SESSION=1` AND `HERMES_INTERACTIVE=1` at once — impossible for one legitimate session.
- **Root cause:** `cron/scheduler.py::run_job` set process-global `os.environ["HERMES_CRON_SESSION"]="1"` (set 1×, never popped). The scheduler runs IN-PROCESS with the gateway (`InProcessCronScheduler`), so a cron tick (`2cce921364b5` AV-Calibration, 09:27) poisoned the shared process; every later interactive `execute_code` hit `check_execute_code_guard`'s cron-deny branch (`tools/approval.py:3121`).
- **Fix:** context-local token instead of process-global env. Added `_hermes_cron_ctx` ContextVar + `set/reset_hermes_cron_context` + `_is_cron_session()` (ctx-first, env fallback) — mirrors `_hermes_interactive_ctx`, which fixed the same race (GHSA-96vc-wcxf-jjff). Converted 4 readers (approval.py 282/2214/2741/3162); `run_job` binds a token + resets in `finally` (belt-and-suspenders atop the `copy_context()` boundary that already discards it).
- **Rejected:** `cron_mode: approve` (the guard's own suggestion) — masks the leak by disabling the guard for genuine cron runs too.
- **Verified:** `scripts/run_tests.sh` cron-approval + execute_code cluster 57/57; focused pytest incl. new `TestCronContextIsolation` 70/70; `test_approval.py` 2 failed/310 passed = PRE-EXISTING `TestDetectDangerousRm` (proven identical on pristine tree via git stash), 0 new. Diffs LF-clean.
- **Ship:** desktop/gateway restart required to load the fix AND flush the already-poisoned `os.environ` in the running process.

## 2026-07-21 — Route Advisor B1 lane-by-type + verification nudge

- User: make same-chat work default to delegated specialist lanes by complexity/task type, without Kanban and without pretending the main chat model can swap under prompt caching.
- **Reviewer finding accepted:** existing route_advisor signals were too coarse (`code_complexity`, `math_complexity`, `reasoning_depth`, `context_size`, `tool_calling`, `domain_specificity`) to distinguish debugging/frontend/research/architecture. Locked spec v1.1 to add minimal intent detectors instead of faking lane choice from coarse buckets.
- **Fix:** `plugins/route_advisor/signals.py` now emits `debugging_intent`, `frontend_intent`, `research_intent`, and `architecture_intent`; `plugins/route_advisor/__init__.py` chooses only configured lanes (`frontend`, `research`, explicit architecture→`planning`/`thinking`, debugging, math→`thinking`, code/tooling→`coding`, fallback `coding`). `lane_by_type:false` preserves legacy coding-only nudge.
- **Verification nudge:** opt-in `verify_nudge` detects recent `delegate_task` history and nudges independent validation via `critic`/`source-checker`/`review`; bundled defaults keep it false for token cost, live runtime config opts it true per user request.
- **Runtime config:** `D:/HeicH/hermes-home/config.yaml` now has `route_advisor.mode: nudge`, `min_level: moderate`, `lane_by_type: true`, `verify_nudge: true`, `verify_min_level: moderate` (backup `config.yaml.bak-route-advisor-b1-20260721`). Restart required for running gateway sessions.
- **Verified:** focused route_advisor suite 12/12 green; `py_compile` on touched Python files green; config validation/drift 22/22 green. Broader `tests/hermes_cli/test_config.py` remains 2-red on unrelated defaults (`get_hermes_home` AppData path, voice `spoken_max_chars` 5000 vs expected 600). Live probe confirmed debugging→`debugging`, frontend→`frontend`, research→`research`, architecture→`planning`, post-delegation verify→`critic`.
