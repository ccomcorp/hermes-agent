# hermes-canvas (AIOS chassis plugin)

A dashboard plugin that adds a **Canvas** tab (live frontend creation studio) to the Hermes
web dashboard and desktop app. Vendored from upstream and maintained as additive AIOS fork delta
on branch `aios`.

## Provenance

- Upstream: [tonbistudio/hermes-canvas](https://github.com/tonbistudio/hermes-canvas)
- Pinned commit: `af907de7a779e6630ebd1b0781e9e7d702c624f9` (v0.1.8, branch `master`)
- Imported pristine in commit `addb0ae2`; the AIOS delta is every commit after it (below).

## AIOS delta (why this is not upstream-identical)

The upstream plugin is unix-first and targets the fork's *gated* auth mode. These committed edits
make it work on the AIOS Windows-first host in the default *loopback* dashboard mode:

| Fix | Commit | What |
|---|---|---|
| **F1 auth shim** | `61f4e3ed` | `dist/index.js` uses raw `fetch()` and omits the `X-Hermes-Session-Token` header the fork gates `/api/plugins/*` on in loopback mode → 401. A prepended shim wraps `window.fetch` to inject it for canvas's own API base. (No frontend source ships upstream, so this is a bundle-level shim, not a rebuild.) |
| **F2b Windows tree-kill** | `621b7ce5` | `os.killpg` is POSIX-only; on Windows the old fallback killed only the `npm.cmd` shim and leaked the real `node.exe` + port. `_terminate_proc` now uses `taskkill /PID <pid> /T /F` on win32. |
| **F6 path scope** | `21584241` | `_validate_path` admitted all of `Path.home()`; scoped to `HERMES_CANVAS_PROJECTS_ROOT` (or `<HERMES_HOME>/canvas-projects`) because `/agent/prompt` runs an autonomous agent on the path. |
| **Agent-binary pin** | `3e8f24e5` | `/agent/prompt` resolved `hermes` via bare PATH (could hit a different install). `_resolve_hermes_bin()` prefers `HERMES_CANVAS_HERMES_BIN`, then a launcher next to `sys.executable` (the venv serving the dashboard), then PATH — pinning agent-edit to the I-drive Hermes. |

Tests for the Python edits: `tests/test_plugin_api_win.py` (run with the chassis venv pytest — 4 tests).

## Configuration (env)

- `HERMES_CANVAS_PROJECTS_ROOT` — root that canvas projects must live under (default `<HERMES_HOME>/canvas-projects`).
- `HERMES_CANVAS_HERMES_BIN` — explicit path to the hermes CLI for agent-edit (else auto-resolved to the dashboard's own venv).

## Enable + deploy

Bundled chassis plugins are discovered by directory layout. To surface the Canvas tab:
1. Ensure `hermes-canvas` is enabled (add to `plugins.enabled` in `hermes-home/config.yaml` if bundled plugins are opt-in in this build).
2. Launch/relaunch the dev dashboard via `AIOS\scripts\launch-dev-hermes.ps1` (pins `HERMES_HOME` to the I-drive home and activates the chassis venv).
3. Verify: `GET /api/dashboard/plugins` lists `hermes-canvas` with `has_api: true`; the Canvas tab appears after Sessions in both web and desktop.

## Durability across updates

- **Fork Sync** (`hermes update --branch aios`) resets to `origin/aios`; this plugin survives once its commits are **pushed to `origin/aios`**. Unpushed commits do NOT survive a hard reset — push after review.
- **Upstream Merge**: this dir touches zero upstream-shared files, so it rides merges with no conflict surface. After a merge, re-check the dashboard SDK: the F1 shim depends on `window.__HERMES_SESSION_TOKEN__` + the `X-Hermes-Session-Token` header and `window.__HERMES_PLUGIN_SDK__` v1.1.0 (`web/src/plugins/sdk.d.ts`). If the SDK bumps, re-verify.
- **Upstream canvas bump**: re-import from a new pinned SHA and re-apply the four edits above.

## Security notes

- **Opaque bundle (F3):** `dist/index.js` is a pre-built, minified upstream blob (no source ships). It runs on the dashboard origin with `__HERMES_PLUGIN_SDK__` access. It has not been line-reviewed — treat as trusted third-party code. The backend `plugin_api.py` WAS reviewed (no import-time network/eval/exfiltration).
- **Autonomous agent-edit:** `/agent/prompt` runs `hermes chat ... --yolo --ignore-rules --ignore-user-config --worktree` — approval-bypassing, file+terminal tools — bounded to `HERMES_CANVAS_PROJECTS_ROOT`. Set `HERMES_CANVAS_PROJECTS_ROOT` to a dedicated dir; consider disabling the endpoint if not needed.
