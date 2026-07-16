---
name: hermes-dox
description: Hermes DOX read/update/closeout protocol
version: 0.1.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [dox, docops, documentation, closeout]
    related_skills: [hermes-agent-contributing]
---

# Hermes DOX

Use this skill when a project contains a `docops.yml` marker, an `AGENTS.md` headed with `<!-- hermes-dox -->`, `Hermes DOX`, or `DOX: enabled`, or structural DocOps signals such as `dox/`, `LIVE-STATUS.md`, or `reports/`.

DOX is a Hermes-native documentation loop: read the contract before editing, update documentation after meaningful change, and run the closeout cascade for the project's detected mode. The deterministic engine is reached through the existing `terminal` tool with `hermes dox ...`; narrative documentation remains agent/human-authored.

## Protocol

1. Detect the project mode with `terminal`:
   - `hermes dox status` when you need machine-readable status; status emits JSON by default.
   - `hermes dox check` when a human-readable drift check is enough.
2. Before editing code or docs, use `read_file` to walk the relevant contract chain:
   - root `AGENTS.md` / `docops.yml` if present.
   - each nearer `AGENTS.md` from the root toward the target path.
   - for ops workstreams, also read `LIVE-STATUS.md` when present.
3. Make the scoped change using the normal repo tools. Use `patch` for targeted edits to existing files; do not replace whole files unless that is the smallest safe change.
4. After a meaningful change, update the nearest owning `AGENTS.md` if the contract, directory ownership, commands, or project map changed.
5. Run the deterministic gate with `terminal`:
   - `hermes dox check` to report drift.
   - `hermes dox check --write` when Tier-A mechanical drift can be reconciled.
6. Close out by surfacing the prompted cascade items. DOX must not fabricate narrative prose silently; write ledger/status text only when you can state the real change and evidence.

## Closeout cascade

For `code` projects:
- confirm contract files were read before edit.
- update nearest `AGENTS.md` when behavior or directory ownership changed.
- run child-index reconciliation with `hermes dox check --write` when configured.
- append or prompt for the durable ledger entry when the change warrants one.
- report any Tier-B size/advisory finding and whether it is escaped on record.

For `ops` projects:
- read contract plus `LIVE-STATUS.md`.
- update `LIVE-STATUS.md` and checklist rows when current truth changed.
- append the session log.
- append the durable ledger only for durable program/tool changes.
- let the engine render HTML, refresh `MANIFEST.json`, and update canvas pointers when those publish markers exist.

For `hybrid` projects, run the union of the code and ops cascades, de-duplicated and limited to active layers.

## Guardrails

- Keep markdown as the source of truth. Do not hand-edit derived HTML unless the project explicitly declares HTML-primary.
- Do not add a DOX model tool; use `terminal`, `read_file`, and `patch`.
- Do not auto-write narrative Purpose, Ownership, CHANGELOG, LIVE-STATUS, or ADR prose without real evidence from the change.
- Keep runtime state under `HERMES_HOME`; keep product code and this bundled skill in the repo.
