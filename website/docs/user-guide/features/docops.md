---
title: "DocOps (DOX)"
sidebar_label: "DocOps (DOX)"
sidebar_position: 26
---

# DocOps (DOX)

Hermes DocOps, or DOX, is a project-local documentation discipline for keeping agent-facing contracts and human-facing status pages current. A DOX project opts in with `docops.yml`, a DOX marker in `AGENTS.md`, or existing documentation structure such as `dox/`, `LIVE-STATUS.md`, or `reports/`.

DOX is self-contained in Hermes Agent. It does not require any separate platform checkout, hook package, or external DocOps scripts.

## What DOX manages

DOX has three layers. You can use one layer or all three depending on the project mode.

| Layer | Purpose | Typical files |
| --- | --- | --- |
| Contract | Agent instructions that must be read before edits and updated after meaningful changes. | `AGENTS.md`, child `AGENTS.md` files, `docops.yml` |
| Ledger | Durable history, decisions, and session notes. | `dox/CHANGELOG.md`, `dox/adr/`, `dox/session-log.md` |
| Publish | Human-facing operational status and report packs. | `LIVE-STATUS.md`, `docs/standards/DOCUMENT-MANAGEMENT.md`, `reports/`, `reports/_canvas/index.html` |

## Project modes

`hermes dox init` accepts three modes:

| Mode | Use when | Active layers |
| --- | --- | --- |
| `code` | A normal code repository needs agent contracts plus a changelog/ADR ledger. | Contract, Ledger |
| `ops` | An operations or research workstream needs current status plus report packs. | Contract, Ledger, Publish |
| `hybrid` | A repository has both code and operational reporting responsibilities. | Contract, Ledger, Publish |

If you omit `--mode`, Hermes reuses the existing mode when one is already detected, otherwise it defaults to `code`.

## Initialize a project

From the project root:

```bash
hermes dox init --mode code
```

For an operations workstream:

```bash
hermes dox init --mode ops
```

The command is idempotent. Running it again preserves the same skeleton files unless the mode or existing project structure changes.

A `code` project gets:

```text
docops.yml
AGENTS.md
dox/CHANGELOG.md
dox/adr/
dox/session-log.md
```

An `ops` or `hybrid` project also gets:

```text
LIVE-STATUS.md
docs/standards/DOCUMENT-MANAGEMENT.md
reports/
reports/_canvas/index.html
```

## Check a project

Run checks without changing files:

```bash
hermes dox check --json
```

Run checks and apply deterministic Tier-A fixes, such as reconciling managed child-index tables:

```bash
hermes dox check --write --json
```

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Clean, or only non-blocking/escaped findings. |
| `2` | Unescaped Tier-B issue, such as an oversized changelog needing a documented decision to shard or permit it. |
| `3` | Malformed marker, invalid `docops.yml`, unreadable text, or another fail-loud input problem. |

## View status for desktop or scripts

`hermes dox status` prints the stable JSON contract consumed by the desktop DocOps panel:

```bash
hermes dox status --root /path/to/project
```

The payload includes:

```json
{
  "active": true,
  "mode": "ops",
  "layers": { "contract": true, "ledger": true, "publish": true },
  "markers": {
    "docops_yml": true,
    "agents_md_header": true,
    "structural": ["dox/", "dox/CHANGELOG.md", "reports/", "LIVE-STATUS.md"]
  },
  "drift": [],
  "pending_advisories": 0,
  "last_publish": null
}
```

Unknown fields should be ignored by scripts so future Hermes versions can add data without breaking consumers.

## Closeout checklist

Use the dry-run closeout view to see what the agent should do before calling a change complete:

```bash
hermes dox closeout --dry-run --mode ops
```

For code projects, the default cascade emphasizes contract and ledger maintenance: read the contract, update the nearest `AGENTS.md`, reconcile indexes, append ledger entries, then run the size gate.

For ops projects, the default cascade adds publish-oriented steps: update `LIVE-STATUS.md`, update any checklist, append `dox/session-log.md`, refresh report artifacts, update the canvas pointer, then run the size gate.

## Good operating pattern

1. Read the relevant root-to-target `AGENTS.md` chain before editing.
2. Make the smallest meaningful code or document change.
3. Run `hermes dox check --write --json` when DOX is active.
4. Author prompted prose yourself: status notes, changelog lines, ADRs, and session-log entries are not fabricated by the runtime.
5. Use `hermes dox closeout --dry-run` to confirm the project-specific closeout expectations.

DOX handles deterministic maintenance; humans and agents still write the judgment-heavy narrative.