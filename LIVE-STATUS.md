# LIVE-STATUS — hermes-agent

**Mode:** hybrid (contract + ledger + publish)  
**DOX:** active via `docops.yml`  
**Updated:** 2026-07-16  
**Root:** `I:/PROJECTS/AIOS/hermes-agent` (pending relocation — see open items)

## Scoreboard

| Area | Status | Notes |
|------|--------|--------|
| DocOps markers | **green** | hybrid init; check drift none |
| Self-improvement loop | **documented** | AGENTS.md core section |
| Outcome reward Desktop bind | **code landed (WT)** | restart Desktop to load |
| Composite + AIOS packages | **sibling-coupled** | default path under AIOS; override `AIOS_PACKAGES_DIR` |
| **Chassis location** | **still under AIOS tree** | investigation done; cutover not started |
| GitHub independence | **already** | origin=`ccomcorp/hermes-agent`, upstream=NousResearch |

## Maintenance rule (binding)

Any **development, change, or enhancement** on this repo must update DocOps in the **same work unit**:

1. **Contract** — walk `AGENTS.md` before edit  
2. **Ledger** — CHANGELOG / session-log / ADR  
3. **Publish** — LIVE-STATUS when status changes  
4. **Learning** — extract-approach on non-trivial solves  

## Open / next

| Item | Status | Note |
|------|--------|------|
| Chassis relocation | **investigated** | Plan: `H:/WSpace-Hermes/hermes-projects/docs/hermes-agent/plans/chassis-relocation-investigation-2026-07-16.md` |
| Commit WIP (DOX + outcome-signal + AGENTS) | open | before any move |
| Choose NEW_PATH | **blocked on user** | e.g. `I:\PROJECTS\hermes-agent` |
| Keep hermes-home path | recommend yes | only rewire HERMES_HOME if moving home |
| AIOS_PACKAGES_DIR after move | required | do not assume sibling layout |

## Relocation decision (2026-07-16)

- **Do not** create a brand-new GitHub repo (origin already independent).  
- **Do** push existing fork → clone/move to NEW_PATH → rewire pins → recreate venv/npm → cutover.  
- Hard coupling: launch-dev-hermes, update-guard defaults, kanban workdir, desktop project path, **composite AIOS packages**.

## Commands

```bash
hermes dox status --root I:/PROJECTS/AIOS/hermes-agent
hermes dox check  --root I:/PROJECTS/AIOS/hermes-agent
```
