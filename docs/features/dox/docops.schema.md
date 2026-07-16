# `docops.yml` schema + closeout cascade defaults

> **Status:** D0 SPEC (design). The `docops.yml` marker is **optional**. When
> absent, DOX falls back to header/structural detection ([`README.md` §5](README.md))
> and the mode defaults below. When present, `docops.yml` is authoritative and
> overrides the defaults for that project.

`docops.yml` lives at a project's root. It is the explicit, structured DOX
marker: it declares the project **mode**, which **layers** are active, and any
**cascade overrides**. It is parsed by the Hermes-native engine in `agent/dox/`
(YAML, stdlib-parseable, no AIOS). All keys are optional; a bare `docops.yml`
(even empty) is a valid "DOX on, use defaults" marker.

---

## 1. Schema

```yaml
# docops.yml — Hermes DOX project marker (all keys optional)

version: 1                       # schema version (int). Default: 1.

mode: code                       # code | ops | hybrid. Default: inferred (see §2).

layers:                          # which layers are active. Default: per-mode (§3).
  contract: true                 # AGENTS.md hierarchy: read-before-edit / update-after-change
  ledger: true                   # dox/CHANGELOG.md + ADRs + session log
  publish: false                 # multi-format packs + LIVE-STATUS + Canvas

contract:
  root: AGENTS.md                # root contract file. Default: AGENTS.md
  # Directories whose child-index tables the engine reconciles (Tier A auto-fix).
  # Each entry names a dir and the glob of files its AGENTS.md index must cover.
  index:
    - dir: .                     # project root
      glob: "*/"                 # child directories
    # - { dir: agent, glob: "*.py" }

ledger:
  changelog: dox/CHANGELOG.md    # ledger file. Default: dox/CHANGELOG.md
  adr_dir: dox/adr               # ADR directory. Default: dox/adr
  session_log: dox/session-log.md
  size_limit_words: 1500         # Tier B soft-block threshold for the changelog.
                                 # 0 disables the size gate. Default: 1500.

publish:
  # Report-pack tree root. Packs are <root>/<category>/<type>/<cadence>/<period>/<REPORT-ID>/
  reports_root: reports
  live_status: LIVE-STATUS.md    # workstream scoreboard (ops). Default: LIVE-STATUS.md
  checklist: null                # optional checklist file to append a row to.
  canvas_dir: reports/_canvas    # Canvas pointer dir; index.html only, no package.json.
  html: derived                  # derived | primary. Default: derived (md is SoT).
  manifest: MANIFEST.json        # per-pack manifest filename. Default: MANIFEST.json

cascade:                         # override the closeout cascade (§4). Default: per-mode.
  # Ordered list of steps. Each: { step: <name>, auto: <bool> }.
  # auto=true → runtime performs it deterministically; auto=false → agent is prompted.
  # Omit `cascade` entirely to use the per-mode defaults in §4.
  steps: []

forbidden_paths:                 # extra path substrings to fail the no-AIOS check on.
  - AIOS/                        # always implied; listed for clarity.

secrets:
  redact: true                   # publish renderer redacts secrets from output. Default: true.
```

### Field notes

- **`mode`** picks the default `layers` and `cascade`. Explicit `layers` /
  `cascade` override the mode defaults.
- **`contract.index[]`** drives Tier A auto-reconciliation: for each `{dir,
  glob}`, the engine ensures that dir's `AGENTS.md` child-index table has a row
  for every file matching `glob` (adding stub rows, dropping vanished rows,
  preserving human descriptions verbatim). A dir with an index entry but **no**
  managed marker in its `AGENTS.md` is itself drift (prevents silent bypass by
  deleting the marker).
- **`ledger.size_limit_words`** is the Tier B gate (soft-block, escapable via the
  in-file `<!-- dox-allow-oversize: <reason> -->` pragma).
- **`publish.html`** must be `derived` unless the project genuinely maintains
  HTML by hand; `derived` enforces markdown-as-source-of-truth (ADR D2).
- **`canvas_dir`** contents: `index.html` only. No `package.json` (the Hermes
  static server injects any overlay; a pack must not carry a build).
- **`forbidden_paths`** augments the built-in no-AIOS enforcement; `AIOS/` and
  the AIOS `.cjs`/package tokens from [`README.md` §7](README.md) are always
  checked regardless.

---

## 2. Mode inference (when `mode` is absent)

If `mode` is not set in `docops.yml` (or `docops.yml` is absent but another
marker triggered DOX), infer:

| Signal present | Inferred mode |
|----------------|---------------|
| `reports/` pack tree OR `LIVE-STATUS.md` OR `docs/standards/DOCUMENT-MANAGEMENT.md` | `ops` |
| `dox/CHANGELOG.md` / `dox/adr/` and no ops signals | `code` |
| Both code and ops signals | `hybrid` |
| Only a DOX-headed `AGENTS.md` | `code` |

Inference is a default only; an explicit `mode` always wins.

---

## 3. Default active layers by mode

| Mode | contract | ledger | publish |
|------|:--------:|:------:|:-------:|
| `code`   | ✅ | ✅ | ❌ |
| `ops`    | ✅ | ✅ | ✅ |
| `hybrid` | ✅ | ✅ | ✅ |

`ops` and `hybrid` differ in cascade emphasis (§4), not in which layers are on.

---

## 4. Closeout cascade defaults

The cascade is the ordered set of steps DOX runs on a meaningful change. `auto`
steps are done by the runtime deterministically; prompted steps nudge the agent
to author content (DOX never fabricates prose). These are **defaults**; a project
overrides them via `cascade.steps` in `docops.yml`.

### 4.1 Code project (default)

| # | Step | auto? | Layer | Notes |
|---|------|:-----:|-------|-------|
| 1 | `read_contract` | — | Contract | Walk root→target `AGENTS.md` before edit (agent behavior, via skill). |
| 2 | `update_nearest_agents_md` | prompted | Contract | Agent updates the closest owning `AGENTS.md` to reflect the change. |
| 3 | `reconcile_child_index` | **auto** | Contract | Engine reconciles child-index tables (Tier A). |
| 4 | `append_ledger` | prompted | Ledger | Agent appends CHANGELOG / ADR / session-log entry. |
| 5 | `size_gate` | **auto** (soft-block) | Ledger | Tier B: warn+record if changelog over `size_limit_words`; escapable on record. |

### 4.2 Ops project (default)

Changelog alone is **insufficient** for ops/security workstreams. Canonical
cascade: **Change → LIVE-STATUS → checklist → session-log → progress pack**.

| # | Step | auto? | Layer | Notes |
|---|------|:-----:|-------|-------|
| 1 | `read_contract` | — | Contract | Read contract + the workstream `LIVE-STATUS.md`. |
| 2 | `update_live_status` | prompted | Publish | Agent updates current-truth scoreboard. |
| 3 | `update_checklist` | prompted | Publish | Agent updates the wave/task checklist row (if `checklist` set). |
| 4 | `append_session_log` | prompted | Ledger | Audit entry. |
| 5 | `append_ledger` | prompted | Ledger | Ledger line **only if** the change is a durable program/tool change. |
| 6 | `render_html` | **auto** | Publish | Engine re-renders the human pack HTML from markdown (`html: derived`). |
| 7 | `refresh_manifest` | **auto** | Publish | Engine refreshes `MANIFEST.json` keys. |
| 8 | `update_canvas_pointer` | **auto** | Publish | Engine points `canvas_dir/index.html` at the latest pack (index.html only). |
| 9 | `size_gate` | **auto** (soft-block) | Ledger | Tier B on any size-governed markdown. |

### 4.3 Hybrid project (default)

The union of §4.1 and §4.2, de-duplicated, ordered contract → ledger → publish.
Steps fire only for the layers/markers actually present (e.g. `render_html` is
skipped if there is no `reports/` pack).

---

## 5. Report-pack layout (Publish layer)

Productized from observed ops practice (reimplemented, not imported):

```
<reports_root>/<category>/<type>/<cadence>/<period>/<REPORT-ID>/
  report.md            # source of truth (agent-authored)
  report.html          # derived from report.md by the engine
  report.data.json     # optional structured data (large CSVs live in data/, never here)
  MANIFEST.json        # pack integrity: files, checksums, generated-at, source md path
<canvas_dir>/
  index.html           # pointer to the latest pack; NO package.json
data/
  raw/  derived/       # bulk data plane, never inside a pack
```

Integrity rules: `MANIFEST.json` lists each file + a checksum + the source
markdown path + `generated_at`; `report.html` must be regenerable from
`report.md` (round-trip: re-render must be byte-stable modulo timestamps); no
secrets in any rendered file (`secrets.redact`).

---

## 6. Enforcement tiers (recap)

| Tier | Applies to | Behavior |
|------|-----------|----------|
| **A** | index reconciliation, HTML render, MANIFEST/canvas pointer | Auto-fix, re-stage, continue. Never blocks. |
| **B** | changelog / doc size over limit | Warn loudly + record; escapable on record via `<!-- dox-allow-oversize: <reason> -->`. Never silent bypass. |
| **C** | corruption/safety (e.g. encoding) | Hard block. **DOX drift is never Tier C.** |

See [`ADR-001` §D7](ADR-001-hermes-native-dox.md) for rationale.
