# Hermes DOX — context-safe task breakdown (engineering board)

**Date:** 2026-07-15  
**Why:** Mega-cards (D2 agent + D3 desktop) bloat worker context (~30–40 min sessions, multi-subsystem, full AGENTS.md already huge). Workers degrade when one card = entire surface.

**Rule:** One card = one subsystem seam, ≤~5 files, 3–5 AC bullets, focused test command only. No full-suite in worker briefs unless a dedicated “gate” card.

---

## Already done (do not re-implement)

| Slice | Status | Artifacts |
|-------|--------|-----------|
| D0 Spec | done | `docs/features/dox/*` |
| D1 Backend/CLI | done (uncommitted tree) | `agent/dox/`, `hermes_cli/dox.py`, tests |
| D2.0 Skill + DOX-header protocol inject | **in tree, review-blocked mega-card** | `skills/devops/hermes-dox/`, `prompt_builder.py`, `subdirectory_hints.py`, integration tests |

---

## Mega-cards (parked — never re-dispatch)

| ID | Title | Action |
|----|-------|--------|
| `t_30ab590b` | D2 Agent mega | **blocked** — split |
| `t_5d004b18` | D3 Desktop mega | **blocked** — split |
| `t_357ea37b` | Epic | blocked tracker |

---

## New small cards (S/M only)

### Agent residual (after D2.0)

| Key | Title | Assignee | Scope | AC | Verify |
|-----|-------|----------|-------|----|--------|
| **D2.1** | Commit/review gate for D2.0 inject already on disk | `dev-agent` | Review-only or tiny fix; **no new features** | Protocol inject present; skill loads; no AIOS tokens | `scripts/run_tests.sh tests/dox/test_dox_agent_integration.py tests/dox/test_no_aios_deps.py -q` |
| **D2.2** | Pending-advisory record + drain (AC-A3 only) | `dev-agent` | Advisory sink under `get_hermes_home()` + inject once via existing non-cache-breaking path | Edit records advisory; next turn injects once; second turn drained | Focused tests only in `tests/dox/test_dox_advisory.py` |
| **D2.3** | Closeout cascade checklist helper (AC-A4, report-only) | `dev-agent` | Pure function: mode → ordered closeout steps; optional CLI `hermes dox closeout --dry-run` if tiny | code vs ops step lists match schema §4 | Unit tests only |

Skip full AC-A2 scripted multi-turn session in D2.1 — treat skill text as sufficient for MVP unless product demands later.

### Desktop (replace mega D3)

| Key | Title | Assignee | Scope | AC | Verify |
|-----|-------|----------|-------|----|--------|
| **D3.1** | Web API: GET dox status for cwd/project | `desktop-backend-expert` | `hermes_cli/web_server.py` (+ types if needed) calls `agent.dox` status JSON; **no React** | Endpoint returns AC-B7 shape; inactive project → active:false | API/unit test or scripted client |
| **D3.2** | DocOps panel shell (mock data) | `desktop-frontend-expert` | `apps/desktop/src/app/docops/*` route + panel UI only; mock status prop | Renders active/mode/layers/markers/drift/health | Component test with mock |
| **D3.3** | Wire panel → real status API (AC-D1/D2/D3) | `desktop-frontend-expert` | Fetch/merge/out-of-order guard; health mapping | Uses backend; stale response ignored | Renderer tests with mocked fetch |
| **D3.4** | Panel actions: check/reconcile via bridge (AC-D5) | `desktop-frontend-expert` | One action path (e.g. “Run check”) → bridge → refresh | No DOX logic reimplemented in React | Action test |
| **D3.5** | Desktop build smoke + Canvas rule note in panel docs | `desktop-frontend-expert` | `npm run build` for desktop workspace; short note in panel about static canvas | Build green; no AIOS imports in `app/docops` | Build command + grep |

**Order:** D3.1 → D3.2 → D3.3 → D3.4 → D3.5 (D3.2 can start after D3.1 contracts the JSON; if mock-first, D3.2 parallel with D3.1 is OK).

**Concurrency:** max **1** desktop-frontend worker on docops at a time (shared files). D3.1 backend can run solo before frontend.

### D4 (keep one card but slim body)

| Key | Title | Depends |
|-----|-------|---------|
| **D4** | Docs + fixtures + clone-smoke | All D2.x done that we ship + D3.5 |

Body must say: do **not** re-read entire D0–D3 history; only touch website docs + fixtures.

### Optional later (not now)

- D1 residual: full `hermes dox publish` HTML render (AC-B6) as **D1.pub** separate card  
- Full multi-turn AC-A2 session harness  

---

## Worker brief template (paste into every small card)

```
HARD LIMITS:
- Touch ONLY the files listed in this card.
- Do NOT open or rewrite unrelated desktop routes, memory plugins, or AGENTS.md bulk.
- Do NOT run the full test suite — only the Verify command on this card.
- Stop when AC met; if blocked on design, block with needs_input (one paragraph).
- No AIOS imports. Workspace: I:/PROJECTS/AIOS/hermes-agent
- If context feels large, stop and split further rather than thrash.
```

---

## Link graph

```
D1 done
  ├─ D2.1 (review D2.0) ──► D2.2 ──► D2.3 ──┐
  └─ D3.1 ──► D3.2 ──► D3.3 ──► D3.4 ──► D3.5 ─┴─► D4
```

Epic stays blocked tracker.
