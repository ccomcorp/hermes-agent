# Hermes DOX — DocOps for Living Documentation

> **Status:** D0 SPEC (design). Not yet implemented. This directory is the
> source of truth for the Hermes-native DOX feature: what it is, why it is
> built this way, its interface contracts, and the acceptance criteria the
> three product surfaces (backend/CLI, agent loop, desktop) must meet.

Hermes DOX ("DocOps") is a **self-contained** feature of `hermes-agent` that
keeps a project's documentation *alive* — read before edit, updated after
change, and republished to human-facing surfaces on closeout. It unifies three
things Hermes projects already do informally into one product: a **Contract**
layer (AGENTS.md hierarchy), a **Ledger** layer (changelog / ADRs / session
log), and a **Publish** layer (multi-format report packs + Canvas).

This document is the product overview. The companion files are:

| File | Purpose |
|------|---------|
| [`ADR-001-hermes-native-dox.md`](ADR-001-hermes-native-dox.md) | The binding architecture decision: three layers, markdown source of truth, HTML derived, **no AIOS dependency**. |
| [`docops.schema.md`](docops.schema.md) | The `docops.yml` project-marker schema + closeout cascade defaults for code vs ops projects. |
| [`acceptance-criteria.md`](acceptance-criteria.md) | Per-surface acceptance criteria (backend/CLI, agent loop, desktop) + verification steps. |

---

## 1. Hard product boundary (user directive, 2026-07-15)

These constraints are **not negotiable** and govern every downstream slice:

1. **Hermes DOX is independent of AIOS.** It is implemented and shipped only
   inside the `hermes-agent` git tree (Python agent + `apps/desktop`). It must
   run in a clone of `hermes-agent` that has **no AIOS present at all**.
2. **No AIOS imports or soft-deps.** DOX must not import, `require`, call, shell
   out to, or path-reference any AIOS package, `dox-*.cjs` script, AIOS hook, or
   AIOS directory. Ideas from prior AIOS DOX experiments (and from upstream
   `agent0ai/dox`) **may be reimplemented** in Hermes-native Python/TS; they may
   never be linked as a runtime dependency. See the forbidden-deps list in §7.
3. **Ship the FULL product across three surfaces:** a bundled **skill**, a
   **CLI** (`hermes dox …`), and a **Desktop DocOps/health UI**. All three, plus
   **multi-format publish** (markdown → HTML → optional Canvas pointer), are in
   scope for the feature as a whole (sequenced across D1–D4, not all in D0).
4. **State vs code split.** Runtime state (caches, pending-advisory sinks,
   telemetry) lives under `HERMES_HOME` and is profile-scoped via
   `get_hermes_home()`. Product code + the bundled skill + these docs live in the
   `hermes-agent` git tree.

---

## 2. What DOX means here — the three layers

DOX is one feature spanning three layers. A project may use one, two, or all
three; the closeout cascade (§4) selects which fire based on project markers.

| Layer | Purpose | Typical artifacts | Who authors |
|-------|---------|-------------------|-------------|
| **Contract** | Give the agent precise, local context; "walk before edit, update after change." | Root + child `AGENTS.md`, `docops.yml`, project standards | Agent (prompted), human |
| **Ledger** | Durable history + decisions for audit and future context. | `dox/CHANGELOG.md`, ADRs, session log | Agent (prompted) |
| **Publish** | Keep human-facing surfaces current. | Report packs (`.md` + derived `.html` + `MANIFEST.json`), `LIVE-STATUS.md`, Canvas `index.html` pointer | Agent (prompted); HTML derived deterministically |

**The gap Hermes DOX closes.** Hermes already *reads* context files at startup
(`agent/prompt_builder.py`) and progressively discovers subdirectory `AGENTS.md`
during a session (`agent/subdirectory_hints.py`). What it does **not** do today
is *maintain* them (create/update after a change) or run a multi-format closeout.
DOX is the maintain-and-publish loop layered on top of the existing read path —
it never replaces or duplicates the reader.

---

## 3. Design principles

1. **Markdown is the source of truth for agents; HTML is derived for humans.**
   The agent reads and writes markdown. HTML (and any Canvas surface) is
   *rendered from* markdown by a deterministic renderer — never hand-edited as a
   parallel source. The single exception is a pack explicitly declared
   HTML-primary.
2. **DOX prompts; it does not fabricate prose.** The runtime detects drift and
   *records/injects a reminder* so the agent updates the doc. It never
   auto-writes narrative Purpose/Ownership prose. Deterministic, mechanical work
   (index reconciliation, HTML render, MANIFEST keys, size checks) *is* done by
   the runtime; judgment work (what an entry says, how to shard) is left to the
   agent/human.
3. **Tiered enforcement — auto-fix cheap, soft-block on judgment, never hard-stop
   real work.** (See ADR §5.) A mechanical drift is auto-fixed and the turn
   continues; a judgment-required issue (e.g. an oversize changelog) warns loudly
   and is recorded but is escapable on the record — never silently via
   `--no-verify`.
4. **Cache-safe & prompt-budget-safe.** DOX must not break per-conversation
   prompt caching: it never rebuilds the system prompt or swaps toolsets
   mid-conversation. Reminders reach the agent via the existing non-cache-breaking
   channels (tool-result injection like the current subdirectory hints, or a
   `pre_llm_call`-style context injection), **never** by mutating the cached
   system prefix. Full HTML is never loaded into the system prompt.
5. **Clone-safe / self-contained.** Every code path degrades cleanly when AIOS,
   gbrain, or any optional dependency is absent. DOX functions with only
   `hermes-agent` + `HERMES_HOME`.
6. **Secrets never in rendered docs.** The publish renderer must not emit
   credentials/tokens/PII into `.md` or `.html` output; the ledger/telemetry must
   not persist secrets.

---

## 4. Closeout cascade (overview)

On a meaningful change, DOX runs a **closeout cascade** whose steps depend on the
project's mode (detected from markers — §5). The full defaults live in
[`docops.schema.md`](docops.schema.md); the shape is:

- **Code project** (default): `read contract → edit → update nearest AGENTS.md →
  reconcile child index → append ledger (CHANGELOG / ADR / session log)`.
- **Ops project**: changelog alone is insufficient. Cascade adds the publish arm:
  `change → LIVE-STATUS → checklist row → session-log entry → ledger line (if
  durable) → HTML republish from markdown → Canvas pointer`.
- **Hybrid**: union of both, gated per-marker.

Each step is either **auto** (runtime does it: index reconcile, HTML render) or
**prompted** (agent authors it: ledger prose, LIVE-STATUS narrative).

---

## 5. Project markers (detect DocOps mode)

DOX activates only for projects that opt in. Detection precedence:

1. **`docops.yml`** at project root — the explicit, structured marker (schema in
   [`docops.schema.md`](docops.schema.md)). Highest precedence; declares mode
   (`code` / `ops` / `hybrid`) and overrides cascade defaults.
2. **`AGENTS.md` with a DOX header** — a lightweight opt-in for Contract-layer
   projects without a full `docops.yml`.
3. **Structural signals** — presence of `dox/`, `LIVE-STATUS.md`,
   `docs/standards/DOCUMENT-MANAGEMENT.md`, or a `reports/` pack tree. These
   *suggest* a mode when `docops.yml` is absent; they never override an explicit
   marker.

No marker ⇒ DOX is inert (Hermes' existing read-only context loading is
unaffected).

---

## 6. Surfaces (delivery sequence)

DOX ships across three surfaces, sequenced on the `hermes-dox` board as
`D0 Spec → D1 backend/CLI → (D2 agent ∥ D3 desktop) → D4 docs/fixtures`:

| Surface | Where | Direction |
|---------|-------|-----------|
| **CLI / library** | `agent/dox/` (Python) + `hermes dox` subcommand | `hermes dox init | check | status | publish` — the deterministic engine (marker detection, index reconcile, HTML render, size gate). Zero model-tool footprint (Footprint Ladder rung 2). |
| **Agent loop** | Bundled skill `skills/devops/hermes-dox/` + optional non-cache-breaking reminder injection reusing the existing hint transport | The read-before-edit / update-after-change protocol + closeout prompting. Reuses `subdirectory_hints`-style injection; **no system-prompt rebuild**. |
| **Desktop** | New `apps/desktop/src/app/docops/` feature panel | A DocOps/health view: per-project DOX status (markers, drift, pending advisories, last publish), driven by the `hermes dox status` JSON contract over the existing gateway/CLI bridge. No AIOS. |
| **Docs/fixtures** | `website/docs/...` + `tests/` fixtures | User-facing docs + zero-AIOS-path test fixtures. |

---

## 7. Forbidden dependencies (explicit)

DOX code — Python, TS, or the bundled skill — **MUST NOT** reference any of the
following. This list is enforced by a test fixture in D4 (grep the DOX source
tree for these tokens and fail on any hit):

- Any path containing `AIOS/` or resolving into an AIOS checkout.
- `dox-index.cjs`, `dox-check.cjs`, `dox-shape.cjs`, `dox-advisories.cjs`,
  `dox-inject.cjs`, `_envelope.cjs`, or any `*.cjs` DOX hook from AIOS
  `packages/constraints/` or `scripts/`.
- AIOS packages: `packages/constraints`, `packages/journal`,
  `packages/session/checkpoint-store.cjs`, `packages/memory/*`, or any
  `require()`/import that resolves outside the `hermes-agent` tree.
- `gbrain` as a **required** path — DocOps must function with gbrain absent.
- Claude-Code-only hook envelope shapes as a runtime contract (e.g. relying on
  `tool_response` / `hookSpecificOutput`); Hermes-native hook contracts only.

Reimplementing an *idea* (tiered enforcement, marker-based index reconciliation,
record-then-inject advisory surfacing) in Hermes-native code is allowed and
expected. Linking, importing, or shelling to the AIOS artifacts above is not.

---

## 8. Out of scope (D0 and the feature)

- Porting AIOS `dox-index.cjs` / `_envelope.cjs` (or any `.cjs`) into
  `hermes-agent`. DOX is reimplemented, not ported.
- Auto-writing narrative Purpose/Ownership/CHANGELOG prose.
- Loading full HTML into the system prompt.
- Requiring gbrain (or any AIOS service) for DocOps to function.
- Any change that rebuilds the system prompt or swaps toolsets
  mid-conversation (cache-breaking).
