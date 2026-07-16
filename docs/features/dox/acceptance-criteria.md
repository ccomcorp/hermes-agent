# Acceptance criteria — Hermes DOX (per surface)

> **Status:** D0 SPEC (design). These are the criteria each downstream slice
> (D1–D4) must meet before it counts as done. They are the "done when" contract
> for the backend/CLI, the agent loop, and the desktop surfaces, plus the
> cross-cutting no-AIOS and cache-safety gates.

Legend: each criterion is **testable**. "Verify" names the concrete check. All
tests run via `scripts/run_tests.sh` against a temp `HERMES_HOME` (no writes to
the real `~/.hermes`), with **zero AIOS paths** in fixtures.

---

## 0. Cross-cutting gates (all surfaces)

- **AC-X1 — No AIOS coupling.** A test greps the DOX source tree (`agent/dox/`,
  `skills/devops/hermes-dox/`, `apps/desktop/src/app/docops/`) for the forbidden
  tokens in [`README.md` §7](README.md) (`AIOS/`, `dox-index.cjs`,
  `dox-check.cjs`, `dox-shape.cjs`, `_envelope.cjs`, `dox-advisories.cjs`,
  `dox-inject.cjs`, AIOS `packages/*`, required `gbrain`) and **fails on any
  hit**. Verify: `scripts/run_tests.sh tests/dox/test_no_aios_deps.py`.
- **AC-X2 — Clone-safe.** DOX imports and the CLI run with AIOS absent from
  `sys.path` / the filesystem. Verify: import `agent.dox` and run
  `hermes dox status` in a temp dir with no AIOS present; exit 0.
- **AC-X3 — Cache-safety.** No DOX code path rebuilds the system prompt, reloads
  memory, or swaps toolsets mid-conversation. Verify: a test asserts DOX
  reminders travel only via the sanctioned non-cache-breaking transports
  (tool-result injection / `pre_llm_call` context) and that the cached
  system-prompt prefix is byte-identical before/after a DOX reminder fires.
- **AC-X4 — Secrets never rendered.** The publish renderer redacts
  secrets/tokens/PII from `.md`/`.html` output and DOX telemetry stores no
  secrets. Verify: render a pack whose source contains a fake token; assert it is
  absent from the HTML output and any telemetry sink.
- **AC-X5 — Marker-gated activation.** With no `docops.yml` / DOX header /
  structural signal, DOX is inert and existing context-file loading is
  unchanged. Verify: `hermes dox status` in a bare repo reports "inactive"; the
  startup context loader behavior is unchanged.

---

## 1. Backend / CLI (`agent/dox/` + `hermes dox`) — D1

The deterministic engine. Footprint Ladder rung 2 (CLI + skill), **no new core
model tool**.

- **AC-B1 — `hermes dox init`.** Scaffolds a `docops.yml` (with inferred `mode`)
  and, for the chosen layers, seeds `dox/CHANGELOG.md` / managed AGENTS.md index
  markers / a `reports/` skeleton. Idempotent (re-run is byte-stable). Verify:
  `hermes dox init` twice → identical tree; `docops.yml` validates against
  [`docops.schema.md`](docops.schema.md).
- **AC-B2 — `hermes dox check`.** Runs all deterministic checks and reports drift
  by tier. Exit code encodes tier: `0` clean/Tier-A-autofixed, non-zero on an
  unescaped Tier B, distinct code on malformed marker / IO (fail-loud). Verify:
  fixtures for (a) missing child-index row, (b) oversize changelog, (c) malformed
  marker each produce the right tier + exit code.
- **AC-B3 — `hermes dox check --write` (Tier A auto-fix).** Reconciles child
  indexes idempotently, **preserving human descriptions verbatim**; adds stub
  rows for undocumented files; drops rows for vanished files. Verify: reproduce
  the "file added without an index row" case → `--write` fixes it; re-run is
  byte-identical.
- **AC-B4 — Marker detection precedence.** `docops.yml` > DOX-headed `AGENTS.md`
  > structural signals; mode inference matches [`docops.schema.md` §2](docops.schema.md).
  Verify: unit tests over each precedence/inference row.
- **AC-B5 — Size gate (Tier B).** Changelog over `size_limit_words` soft-blocks
  (non-zero exit in `check`), records the finding, and is escapable **only** via
  the in-file `<!-- dox-allow-oversize: <reason> -->` pragma — never a silent
  bypass. Verify: oversize → fail; with pragma → pass + logged.
- **AC-B6 — `hermes dox publish`.** Renders `report.html` from `report.md`
  deterministically, refreshes `MANIFEST.json` (files + checksums + source path +
  `generated_at`), and updates `canvas_dir/index.html` (index.html only, no
  `package.json`). Re-render is byte-stable modulo timestamps. Verify: render →
  assert HTML derived, MANIFEST keys present, canvas dir has only `index.html`.
- **AC-B7 — `hermes dox status` JSON contract.** Emits a stable, documented JSON
  shape (see §4 — consumed by desktop): `{ active, mode, layers, markers,
  drift: [{tier, path, kind}], pending_advisories, last_publish }`. Verify: schema
  test on the emitted JSON.
- **AC-B8 — Profile-scoped state.** All runtime state (pending-advisory sink,
  telemetry) resolves under `get_hermes_home()`, never a hardcoded `~/.hermes`.
  Verify: run under a non-default profile; assert state lands in the profile dir.

---

## 2. Agent loop (bundled skill + reminder injection) — D2

- **AC-A1 — Bundled skill present & valid.** `skills/devops/hermes-dox/SKILL.md`
  ships in-tree, description ≤ 60 chars, references native Hermes tools
  (`terminal` for `hermes dox`, `read_file`, `patch`) — no raw shell utilities as
  the headline surface. Verify: skill frontmatter/description length test; skill
  loads via `skill_view`.
- **AC-A2 — Read-before-edit protocol.** With the skill loaded in a DOX project,
  the agent walks root→target `AGENTS.md` before editing. Verify: a scripted
  session asserts the contract files were read prior to the first edit.
- **AC-A3 — Update-after-change prompting (record-then-inject).** After a
  meaningful edit, DOX records a pending advisory and the agent is nudged on its
  next turn via a **non-cache-breaking** transport; the advisory is **drained
  once** (no nag-loop). Verify: edit → advisory recorded → next turn injects the
  reminder → drained (second turn does not re-inject).
- **AC-A4 — Closeout cascade runs per mode.** In a `code` project the cascade
  matches [`docops.schema.md` §4.1](docops.schema.md); in an `ops` project it
  matches §4.2 (LIVE-STATUS → checklist → session-log → HTML pack). Verify:
  per-mode cascade tests assert the auto steps ran and the prompted steps were
  surfaced.
- **AC-A5 — No prose fabrication.** DOX never auto-writes narrative
  Purpose/Ownership/CHANGELOG prose; only mechanical artifacts (indexes, HTML,
  MANIFEST) are runtime-authored. Verify: a change with no agent authoring leaves
  prose fields untouched while indexes reconcile.

---

## 3. Desktop (`apps/desktop/src/app/docops/`) — D3

A DocOps/health panel, consistent with `apps/desktop/AGENTS.md` (feature-owned
state; backend is authoritative; renderer caches). No AIOS.

- **AC-D1 — DocOps panel renders `hermes dox status`.** A new `docops/` feature
  panel shows, per project: active/inactive, mode, active layers, marker
  presence, drift list (by tier), pending advisories, and last publish time —
  driven by the AC-B7 JSON contract over the existing gateway/CLI bridge (no new
  AIOS path). Verify: renderer test with a mocked `dox status` payload asserts all
  fields display.
- **AC-D2 — Backend is authoritative.** The panel treats its data as a cache of
  backend truth: merges (not clobbers) on refresh, guards against out-of-order
  responses, and surfaces a failed refresh non-destructively (per
  `apps/desktop/AGENTS.md`). Verify: out-of-order refresh test; stale response
  does not overwrite newer state.
- **AC-D3 — Health signal.** Drift and unescaped Tier-B findings render as a
  clear health indicator (e.g. ok / attention / blocked) mapped from the status
  JSON. Verify: table-driven test mapping status payloads → health states.
- **AC-D4 — No agent reimplementation.** The panel calls the backend for all DOX
  logic; it does not reimplement marker detection, index reconciliation, or HTML
  rendering in React. Verify: code review + a test asserting the panel makes the
  `dox status` call rather than parsing project files itself.
- **AC-D5 — Actions route to the CLI.** Any panel action (e.g. "reconcile now",
  "publish") invokes the corresponding `hermes dox` command via the bridge; the
  panel reflects the result after an authoritative refresh. Verify: action test
  asserts the correct command dispatch + post-action refresh.

---

## 4. `hermes dox status` JSON contract (shared)

The stable interface between the CLI (AC-B7) and the desktop panel (AC-D1). D1
freezes this shape; D3 consumes it.

```json
{
  "active": true,
  "mode": "ops",
  "layers": { "contract": true, "ledger": true, "publish": true },
  "markers": {
    "docops_yml": true,
    "agents_md_header": false,
    "structural": ["reports/", "LIVE-STATUS.md"]
  },
  "drift": [
    { "tier": "A", "path": "agent/AGENTS.md", "kind": "child_index_stale" },
    { "tier": "B", "path": "dox/CHANGELOG.md", "kind": "size_over_limit", "escaped": false }
  ],
  "pending_advisories": 2,
  "last_publish": { "pack": "reports/ops/status/daily/2026-07-15/RPT-001", "at": "2026-07-15T22:00:00Z" }
}
```

Contract rules: additive-only within `version: 1`; `tier` ∈ `{A,B,C}`; `drift[]`
empty ⇒ healthy; unknown fields ignored by consumers (forward-compat).

---

## 5. Delivery sequence & "done when"

Board `hermes-dox`: `D0 Spec → D1 backend/CLI → (D2 agent ∥ D3 desktop) → D4 docs/fixtures`.

- **D0 (this spec) done when:** these four docs are committed under
  `hermes-agent/docs/features/dox/`; acceptance criteria listed for backend,
  agent loop, and desktop; forbidden-deps list explicit; out-of-scope stated.
- **D1 done when:** AC-B1..B8 + AC-X1..X5 pass.
- **D2 done when:** AC-A1..A5 pass (depends on D1).
- **D3 done when:** AC-D1..D5 pass (depends on D1's status contract).
- **D4 done when:** `website/docs` user docs published + zero-AIOS-path fixtures
  land + AC-X1 enforced in CI-parity test run.

**Out of scope (all slices):** AIOS port, any `.cjs` DOX artifact, gbrain-required
path, auto-writing narrative prose, loading full HTML into the system prompt,
any mid-conversation cache-breaking change.
