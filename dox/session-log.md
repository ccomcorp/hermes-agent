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
