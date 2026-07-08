# Local Code Map — Hermes Workbench Refactor

Verified against AIOS fork at `I:\PROJECTS\AIOS\hermes-agent` on `feature/hermes-workbench-foundation`.

## Repository structure (verified)

| Component | Path | Notes |
|---|---|---|
| Desktop app | `apps/desktop/` | Electron + Vite + React + TypeScript |
| Shared package | `apps/shared/` | `@hermes/shared`, exports from `src/index.ts` |
| Electron main | `apps/desktop/electron/main.cjs` | 7716 lines, 85 `ipcMain.handle` calls |
| Preload | `apps/desktop/electron/preload.cjs` | `contextBridge.exposeInMainWorld('hermesDesktop', ...)` |
| Renderer source | `apps/desktop/src/` | React app |
| Routes | `apps/desktop/src/app/routes.ts` | `APP_ROUTES` array, `AppView` type |
| Stores | `apps/desktop/src/store/` | Feature-owned `.ts` files (jotai-style atoms) |
| Lib | `apps/desktop/src/lib/` | API clients, utilities |
| Global types | `apps/desktop/src/global.d.ts` | `window.hermesDesktop` type declarations |
| Tests | `apps/desktop/src/**/*.test.ts` | Vitest-style alongside source |
| Electron tests | `apps/desktop/electron/*.test.cjs` | Node-style tests alongside source |
| Skills | `skills/` | SKILL.md format, categorized by dir |
| CLI | `cli.py` | Hermes CLI |

## Key patterns verified

### IPC convention
- Channel naming: `hermes:<feature>:<action>` (e.g. `hermes:git:review:list`)
- Preload exposes nested namespaces (e.g. `hermesDesktop.git.review.list(...)`)
- IPC handlers registered in `main.cjs` or extracted to `*.cjs` modules
- `global.d.ts` declares the `window.hermesDesktop` type surface

### Route convention
- `routes.ts` exports route constants + `APP_ROUTES` array
- `AppView` union type controls the view switch
- Routes rendered by `desktop-controller.tsx`

### Store convention
- Feature-owned `.ts` files in `src/store/`
- Atoms + actions co-located
- Test files alongside source (`*.test.ts`)

### Shared package
- `apps/shared/src/index.ts` re-exports public API
- Currently only exports gateway/websocket types
- No validation library (no Zod); hand-written validators used

### Test commands
- `npx tsc -p . --noEmit` — typecheck (passes clean on baseline)
- `eslint src/ electron/` — lint
- No unified test runner config found; tests are `.test.ts` alongside source

## Upstream path divergences

| Plan suggestion | Actual path |
|---|---|
| `apps/shared/src/workbench/` | Will create — matches existing `src/` pattern |
| `apps/desktop/electron/workbench-artifacts.cjs` | Will create — matches existing `*.cjs` pattern |
| `apps/desktop/electron/workbench-ipc.cjs` | Will create |
| `apps/desktop/src/app/workbench/` | Will create — matches existing `src/app/` pattern |
| `apps/desktop/src/store/workbench/` | Will create — matches existing `src/store/` pattern |
| `apps/desktop/src/lib/workbench/` | Will create — matches existing `src/lib/` pattern |
| `skills/software-development/workbench-requirements/` | Will create |

## First milestone files to modify

1. `apps/shared/src/workbench/types.ts` (new)
2. `apps/shared/src/workbench/paths.ts` (new)
3. `apps/shared/src/workbench/validators.ts` (new)
4. `apps/shared/src/index.ts` (modify — add exports)
5. `apps/desktop/electron/workbench-artifacts.cjs` (new)
6. `apps/desktop/electron/workbench-ipc.cjs` (new)
7. `apps/desktop/electron/preload.cjs` (modify — add workbench namespace)
8. `apps/desktop/src/global.d.ts` (modify — add workbench types)
9. `apps/desktop/src/app/routes.ts` (modify — add workbench route)
10. `apps/desktop/electron/main.cjs` (modify — register IPC module)
