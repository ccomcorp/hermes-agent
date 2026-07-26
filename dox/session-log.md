# Session Log

## 2026-07-26 — Kanban C+D Slice 3 routing report

- **Contract:** advanced-elicited the smallest operator-facing report defined by the committed C+D spec: `hermes kanban routing-report [--json]`, inheriting board scope and remaining read-only. It includes only `assigned` events whose decoded payload has `source=kanban.complexity_routing`; malformed/non-dict/non-routing events are skipped.
- **Implementation:** added Python-side event aggregation with stable `total`, `by_route_reason`, `by_assignee`, `by_tier`, and `by_model` keys; human output reveals aggregates only, never raw titles, payloads, rationales, confidence, or event IDs. JSON1 is deliberately not required.
- **Review correction:** initial fixtures and consumer used a guessed `reason` key. Source trace through `_resolve_complexity_route` proved the persisted producer uses `route_reason`; fixtures and consumer were corrected and a missing-key bucket test added before acceptance.
- **Verification:** independent adversarial review **PASS**; focused C+D CLI/routing/config suite **86 passed**; Ruff, `py_compile`, and diff check green; isolated main-process empty-board smoke returned the expected human and JSON zero-state. The only smoke preamble is the pre-existing SQLite WAL-reset advisory.

## 2026-07-25 — Engineering-loop missed-spec-gate stop-work policy

- **Trigger:** the user correctly identified that DYADOMORPH specification work had entered implementation without the mandatory advanced-elicitation gate being applied consistently.
- **Correction:** the live engineering-loop skill now states that frozen, inherited, and partially implemented specifications are not grandfathered. If a missed gate is discovered after ACT begins, the orchestrator must stop or park implementation, preserve current edits, run independent fresh-context elicitation, verify external claims at source, reconcile the spec/ADR/eval set, and commit the design before resuming.
- **Verification:** confirmed the running Desktop resolves to `D:\HeicH\hermes-agent`; `git diff --check` passed; Hermes DOX status remained active in hybrid mode with contract/ledger/publish layers present and no drift before the ledger update.

## 2026-07-25 — Kanban C+D deterministic overrides Slice 1

- **Goal:** resume Kanban C+D implementation from the committed work spec, first closing deterministic override gaps before any brain-learned model-selection work.
- **Fix:** added real `tasks.complexity_override` schema/migration/read support; explicit `complexity_override` on `assignee=auto` now maps directly through `kanban.complexity_routing.map` and skips the classifier; invalid stored tiers fall back safely with an assigned-event reason. Explicit `model_override` on `assignee=auto` now routes to `complexity_routing.explicit_model_profile`/fallback without invoking the classifier and preserves the pinned model. `default_to_trigger:true` now opts unassigned cards into the trigger sentinel before `kanban.default_assignee` can bypass C+D, while explicit assignees are never rerouted.
- **Safety:** classifier-suggested optional `model` strings are now validated before storage/spawn. Invalid suggestions are dropped while the profile route still proceeds, and the assigned event records `model_rejected` / `model_reject_reason` for operator diagnosis.
- **Config:** `kanban.complexity_routing` defaults/validation now include `explicit_model_profile` and `default_to_trigger`; `auxiliary.dispatch_classifier` now includes the same `reasoning_effort` key as the decomposer task so auxiliary-task defaults remain structurally aligned.
- **Gates:** RED targeted tests failed for missing schema, classifier bypass, and validation; adversarial review then caught the initially-dead `default_to_trigger` knob; GREEN focused Slice 1 suite `34 passed`; `py_compile hermes_cli/kanban_db.py hermes_cli/kanban.py hermes_cli/config.py` passed; Ruff on edited files passed; `git diff --check` passed.

## 2026-07-24 — Non-primary agent-context memory fence

- **Goal:** continue development by finishing the in-flight lifecycle-context slice that prevents non-primary agents from writing ordinary user memories.
- **Fix:** added `agent_context` to `AIAgent`/`init_agent`, validated `primary|cron|subagent|flush`, propagated the exact context into `MemoryManager.initialize_all`, wired cron jobs to `cron`, delegated children to `subagent`, and background-review/curator forks to `flush` while retaining `skip_memory=True`. Follow-up repair made the composite health package resolver honor `AIOS_PACKAGES_DIR` so AC-PX5 loop self-check remains active after the D:\HeicH chassis relocation.
- **Fence:** `agent.tool_executor` now blocks direct `memory` tool calls in every non-primary context on both sequential and concurrent tool-call paths before `MEMORY.md`/`USER.md` changes or provider notifications can occur; the composite provider skips `on_memory_write` mirroring when not primary.
- **Gates:** focused lifecycle/fence tests `54 passed`; provider/composite focused suite `123 passed / 1 skipped`; broader memory/delegate/background-review/cron cluster `496 passed`; Ruff on changed files passed (one pre-existing invalid-noqa warning in `run_agent.py`).

## 2026-07-24 — Kanban C+D / brain model-selection status spec

- **Question:** review pending Kanban complexity/delegation routing and brain-learned model selection, then commit the resulting implementation spec.
- **Finding:** in-chat specialist routing is complete, but Kanban C+D remains partial: `default_assignee: dev-agent` can bypass the `auto` sentinel, `--complexity` lacks live schema/read support, explicit `--model` still runs classifier on `assignee=auto`, classifier-suggested models need validation, and routing telemetry needs a report surface.
- **Brain-learning state:** no dedicated `(features, model, outcome)` store or model-performance corpus exists; NeuroLinked recall did not return a model-selection policy. Learned model selection is therefore deferred until C+D emits structured features and typed outcomes.
- **Artifact:** `docs/plans/2026-07-22-kanban-cd-brain-model-selection-work-spec.md`, committed as `c594e6dfb`.
- **Gates:** focused Kanban C+D tests `26 passed`; spec content guard and secret scan passed; DOX status/check rerun with drift none.

## 2026-07-24 — Clarify cancellation is not Skip

- **Symptom:** pressing Stop while a Desktop clarify card was pending made the question look skipped and made an ongoing requirements interview appear to have lost its prior Q&A progress.
- **Root cause:** `tui_gateway.server._clear_pending()` released every blocking prompt with `""`; `clarify_tool` correctly interpreted that value as Skip, so the backend result could not tell explicit Skip from turn-level `session.interrupt`. The renderer therefore had no cancellation state to show.
- **Fix:** introduced an identity-only cancellation control value in `tools/clarify_gateway.py`; scoped it to `clarify.request` in `_clear_pending` while preserving empty responses for secret/sudo/terminal prompts; translated it to JSON `status:"cancelled"`; added Desktop parsing, copy, and cancelled-card rendering; retained backward compatibility for old payloads without status. Reply/cancel resolution is now atomic and first-wins.
- **Review:** adversarial review traced Desktop/TUI, messaging-gateway, and CLI surfaces and judged the core sentinel boundary sound. Follow-up hardened terminal-resolution concurrency and corrected callback/blocking type contracts. A late-arriving review result exposed one stale messaging-callback comment that still described session cancellation as an empty timeout/Skip response; the comment now records that `CANCEL_SENTINEL` passes through unchanged to `clarify_tool`.
- **Gates:** Python clarify/gateway/protocol cluster **226 passed**; Desktop clarify/store/i18n **40 passed**; Desktop typecheck PASS; Ruff PASS; focused ESLint 0 errors / 12 pre-existing `document` warnings; `npm run build --workspace apps/desktop` plus `assert-dist-built` PASS; diff check PASS.
- **Ship state:** source fixed, tested, and compiled into `apps/desktop/dist`. The packaged running Desktop still needs its phase-2 pack/restart before the new card state is live.

## 2026-07-23 — Desktop left-panel route mounts after upstream merge

- **Symptom:** multiple visible left-panel entries and Settings → Plugins were inert after the upstream Desktop shell/routing merge.
- **Source-doc check:** `apps/desktop/AGENTS.md` confirms the renderer owns navigation/routes and that code wins if docs drift; `apps/desktop/README.md` says React owns Desktop routes/panes/interaction state; `website/docs/developer-guide/desktop-plugin-sdk.md` states a full-page route must be paired with sidebar navigation to be reachable. That matches the bug class: visible navigation without a mounted route/surface is incomplete wiring, not a backend problem.
- **Root cause:** route constants and sidebar rows survived the merge, but the new `ChatRoutesSurface` did not mount all built-in pages; `ContribWiring` had a `docopsOpen` overlay state with no `<DocOpsView />` renderer; `route-tile.tsx` only knew a subset of built-in routes for split panes.
- **Fix:** restored lazy mounts for Models, Kanban, Canvas, Channels, Pairing, Webhooks, Plugins, Files, Workbench, System, Config, Logs; rendered DocOps overlay; added split-pane route renderers; updated the `session-actions-menu` test mock for upstream project-store exports.
- **Follow-up root cause:** full Desktop check exposed real Windows portability gaps in Electron tests/source helpers, not in the sidebar patch: POSIX fixture paths were passing through native Windows `path`, ControlMaster tests silently ran in Windows no-mux mode, a POSIX symlink-security assertion ran on Windows, a file-mode assertion assumed POSIX permissions, and one real-git worktree test needed a Windows timeout budget.
- **Follow-up fix:** made path-sensitive helpers/tests platform-explicit (`path.posix`/`path.win32`), forced mux-mode tests to pass `mux: true`, gated POSIX-only permission/symlink assertions on non-Windows, and raised the real-git worktree timeout.
- **Gates:** touched-file ESLint green; desktop typecheck green; focused UI tests 6/6; full Desktop UI suite 2074 passed / 1 skipped; targeted Electron regression set 112/112; full app test stage 2775 passed / 4 skipped; desktop build/assert-dist green; `dox status/check` active with drift none. Remaining `npm run check --workspace apps/desktop` failure is package output lock only: this Hermes Desktop instance is running from `apps/desktop/release/win-unpacked`, so electron-builder cannot unlink `v8_context_snapshot.bin` until Desktop is closed.
- **Learning:** after any Desktop shell/routing merge, verify every visible built-in nav item across four points together: route constant, sidebar row, mounted workspace/overlay surface, and split-pane route renderer.

## 2026-07-22 — Kanban worker-lifecycle Windows portability (understand-first)

- User: "look into the kanban" (2 uncommitted files in the working tree, no DOX provenance) → then "go to the root of the cause, understand what the code is supposed to do before making any changes."
- **Method:** A/B'd the full kanban suites with `git stash` — clean tree 17 fail, uncommitted-as-is 12 fail. `comm` diff of the two failure sets revealed the changes fixed 6 tests but the 12→ vs 17 was misleading: change #2 (`_terminate_reclaimed_worker` blunt pre-`kill` early-return) **traded** a fix for a regression — it fixed nothing net and broke `test_stale_claim_reclaimed` (skipped the defensive SIGTERM the reclaim contract `06f24351c` requires).
- **Root cause (understood via git blame, not guessed):** `os.kill(missing_pid)` raises `ProcessLookupError` on POSIX but generic `OSError` on Windows. Commit `35e7ca03d` ("treat already-gone worker as terminated, not survived") solved the dead-worker-deferred-forever bug via a `ProcessLookupError` branch — which **never fires on Windows**. The uncommitted early-return was a blunt workaround that violated the SIGTERM contract.
- **Fix:** removed the early-return; instead the `OSError` branch consults the cross-platform `_pid_alive` probe and sets `terminated=True` only when the worker is genuinely gone. Satisfies BOTH `test_stale_claim_reclaimed` (SIGTERM still fires) AND `test_dispatch_once_integrates_stale_detection` (Windows dead-PID via real `os.kill`).
- Changes #1 (`_classify_worker_exit` raw-form decoder) and #3 (`list_profiles_on_disk` `~/.hermes` fallback) verified sound + necessary (each maps to a test that fails without it); test tweak = `.as_posix()` slash-agnostic filename compare.
- **Gates:** 387 passed / 1 skipped; 11 remaining failures are unrelated pre-existing Windows gaps (git-worktree, `resolve_hermes_argv` PATH shim, POSIX-only `reap_worker_zombies`), zero net-new vs clean tree. ruff clean. Commit `8b53cd5b7`.
- **Lesson:** a failure-count that holds steady can hide a fix-for-regression trade. Always `comm`-diff the actual failure *sets*, not just counts, and A/B against the pre-change tree.

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
