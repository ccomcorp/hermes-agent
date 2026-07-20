# Session Log

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
