# Document Management (Hermes DOX — hybrid)

Hermes-native DocOps for **this repo only** (not AIOS DOX engines).  
Markdown is source of truth for agents; HTML under `reports/` is derived for humans/Canvas unless a pack says otherwise.

## Modes

`docops.yml` is **hybrid**: contract + ledger + publish.

| Layer | Artifacts | When to touch |
|-------|-----------|----------------|
| **Contract** | Root/child `AGENTS.md`, this file | Before edit: walk; after structure change: update indexes |
| **Ledger** | `dox/CHANGELOG.md`, `dox/adr/`, `dox/session-log.md` | Every durable change / decision / session of work |
| **Publish** | `LIVE-STATUS.md`, `reports/`, Canvas under `reports/_canvas` | When operational truth or human pack changes |

## Binding rule for all development

**Any change, enhancement, or development work on hermes-agent must keep DocOps current in the same work unit.** Incomplete doc maintenance = unfinished work (same class as Learning Law / extract-approach).

Minimum cascade:

1. Edit code or product docs  
2. Update `dox/session-log.md` (session)  
3. Update `dox/CHANGELOG.md` if the change is durable  
4. Update `LIVE-STATUS.md` if status/scoreboard moved  
5. ADR under `dox/adr/` for non-obvious decisions  
6. Non-trivial solve → `extract-approach` before done  
7. Prefer same commit (or same PR) for code + DocOps lines  

## Commands

```bash
hermes dox status --root .
hermes dox check  --root .
hermes dox closeout --root .   # ordered cascade dry-run
```

## Canvas / reports

- Static Canvas folders: **`index.html` only — no `package.json`** (preserves Select Element overlay).  
- Report packs should include `MANIFEST.json` when publishing ops-style packs.

## Non-goals

- Calling AIOS DOX packages or hooks  
- Auto-writing empty narrative fluff  
- Replacing git history with the ledger (ledger is for agents/humans; git remains VCS)  
