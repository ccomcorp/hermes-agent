# ADR-001: Hermes-native DOX (three layers, markdown source of truth, no AIOS)

- **Status:** Accepted (D0 design). Supersedes any prior AIOS-coupled DOX design.
- **Date:** 2026-07-15
- **Deciders:** Hermes-agent maintainers (per user lock 2026-07-15)
- **Context files:** this ADR is the binding decision; [`README.md`](README.md)
  is the product overview; [`docops.schema.md`](docops.schema.md) and
  [`acceptance-criteria.md`](acceptance-criteria.md) are the contracts.

---

## Context

Hermes projects independently evolved three documentation practices:

- **Contract** — an `AGENTS.md` hierarchy giving agents local, precise context
  (upstream `agent0ai/dox` formalizes this as "read before edit, update after
  change").
- **Ledger** — a project-local `dox/CHANGELOG.md` + ADRs + session log for
  durable history (as practiced in app repos).
- **Publish** — multi-format report packs (`.md` + `.html` + `MANIFEST.json`) and
  a Canvas surface, plus a `LIVE-STATUS` cascade (as practiced in ops/Azure/Teams
  projects).

Hermes-agent already **reads** context files (startup: `agent/prompt_builder.py`;
progressive: `agent/subdirectory_hints.py`; cron `workdir` injection). It does
**not** maintain them or run a multi-format closeout. An earlier DOX experiment
was built on the AIOS platform (`packages/constraints/hooks/*.cjs`,
`scripts/dox-*.cjs`) and coupled to AIOS paths, Claude-Code hook envelopes, and
gbrain.

**User lock (2026-07-15):** DOX must be a self-contained `hermes-agent` feature
that works in a clone with no AIOS present, shipped across skill + CLI + desktop
with multi-format publish. It may reimplement AIOS/upstream ideas but must not
import AIOS.

## Decision

We build **Hermes-native DOX** as a self-contained feature of `hermes-agent`
with the following binding decisions.

### D1 — Three layers, one feature

DOX is a single feature spanning three composable layers: **Contract**,
**Ledger**, **Publish**. A project opts into any subset via markers (see D6). The
layers share one marker schema, one CLI, one skill, and one desktop panel.

### D2 — Markdown is the source of truth; HTML is derived

Agents read and write **markdown**. Human-facing **HTML** (and any Canvas
surface) is *rendered from* that markdown by a deterministic Hermes-native
renderer. HTML is never a second hand-edited source. The sole exception: a pack a
project explicitly declares HTML-primary in `docops.yml`. Rationale: agents
reason better over structured markdown than HTML soup; a single source prevents
the two-sources-of-truth drift class.

### D3 — Self-contained; no AIOS (hard boundary)

DOX has **zero** AIOS runtime coupling. It must import, require, call, or
path-reference **nothing** outside the `hermes-agent` tree + `HERMES_HOME`. The
forbidden-deps list in [`README.md` §7](README.md) is authoritative and is
enforced by a D4 test fixture. Ideas may be reimplemented in Hermes-native
Python/TS; artifacts may not be linked. gbrain is never on a required path.

### D4 — Reimplement ideas, Hermes-native transports

The valuable ideas from the AIOS/Claude-Code DOX experiment are reimplemented
against **Hermes-native** mechanisms:

- **Marker-based index reconciliation** → a Hermes-native Python engine in
  `agent/dox/` (not `dox-index.cjs`).
- **Record-then-inject advisory surfacing** → reuse Hermes' existing
  non-cache-breaking injection transports (the `subdirectory_hints`-style
  tool-result injection, and/or a `pre_llm_call` context injection that Hermes
  already supports), **not** the Claude-Code `systemMessage` /
  `hookSpecificOutput` shapes.
- **Tiered enforcement** → implemented in the Hermes CLI/engine, not AIOS hooks.

### D5 — Footprint: CLI + skill first, no new core model tool

Per the root Contribution Rubric's Footprint Ladder, DOX is delivered as a **CLI
command + bundled skill** (rung 2) plus a desktop panel — **not** as a new core
model tool. The agent invokes `hermes dox …` via the existing `terminal` tool,
guided by the bundled skill. This keeps the model tool schema (paid on every API
call) unchanged. A DOX model tool is explicitly rejected for D0–D4.

### D6 — Marker-driven activation with a `docops.yml` seam

Activation is opt-in via project markers, precedence: `docops.yml` (explicit,
structured) → DOX-headed `AGENTS.md` → structural signals. `docops.yml` is the
forward-looking structured seam (schema: [`docops.schema.md`](docops.schema.md))
that declares mode and overrides cascade defaults. Absent any marker, DOX is
inert and the existing read path is untouched.

### D7 — Tiered enforcement (never a hard stop on real work)

Three tiers, reimplemented Hermes-native:

- **Tier A — auto-fix, never block:** mechanical drift (AGENTS.md child-index
  reconciliation, MANIFEST keys, HTML re-render). The engine fixes it and the
  work continues. A deterministic fix never stops a human/agent.
- **Tier B — soft-block with a logged, in-band escape:** judgment-required issues
  (e.g. changelog over the size limit → needs a semantic shard). Warns loudly,
  records it, and is escapable **on the record** via an in-file pragma
  (e.g. `<!-- dox-allow-oversize: <reason> -->`), never silently off the record.
- **Tier C — hard block:** reserved for the corruption/safety class only (e.g. an
  encoding gate). **DOX drift is never Tier C.**

### D8 — Cache-safety is a first-class invariant

DOX must never break per-conversation prompt caching. It must not rebuild the
system prompt, reload memory, or swap toolsets mid-conversation. All agent-facing
reminders travel on the existing non-cache-breaking channels (tool-result
injection / `pre_llm_call` context). Full HTML is never injected into the system
prompt.

## Consequences

**Positive**

- Works in any `hermes-agent` clone with no AIOS; clone-safe by construction.
- No model-tool footprint; no per-call cost increase.
- One markdown source of truth eliminates the md/html drift class.
- Tiered enforcement keeps DocOps from blocking legitimate work (the failure mode
  that killed the AIOS advisory-only tier).
- The `docops.yml` seam makes code/ops/hybrid behavior explicit and per-project.

**Negative / costs**

- Reimplementing the index engine and HTML renderer in Python is real work (vs
  reusing the existing `.cjs`), accepted as the price of the no-AIOS boundary.
- The deterministic markdown→HTML renderer is a new component to maintain.
- Marker detection + cascade config is new surface area (mitigated by shipping
  sensible code/ops defaults).

**Neutral**

- The bundled skill remains the agent's behavioral contract; the CLI is the
  deterministic engine. Both are versioned in-tree.

## Alternatives considered

1. **Port the AIOS `.cjs` DOX engine into hermes-agent.** Rejected: violates the
   no-AIOS boundary and the clone-safe requirement; ports Claude-Code envelope
   assumptions; carries Node hook coupling. We reimplement instead.
2. **Ship DOX as a new core model tool.** Rejected by the Footprint Ladder — it
   would tax every API call for a capability the `terminal` + a skill already
   reach.
3. **HTML as a co-equal source of truth.** Rejected: reintroduces the
   two-sources drift class the feature exists to kill.
4. **Auto-write doc prose.** Rejected: DOX prompts, it does not fabricate
   narrative content; only mechanical artifacts are runtime-authored.
5. **System-prompt injection of the DOX protocol.** Rejected as the default: any
   mid-conversation system-prompt mutation breaks caching. The protocol lives in
   the bundled skill; reminders use non-cache-breaking transports.

## Compliance / enforcement

- A D4 test fixture greps the DOX source tree (`agent/dox/`,
  `skills/devops/hermes-dox/`, `apps/desktop/src/app/docops/`) for the forbidden
  tokens in [`README.md` §7](README.md) and fails on any hit.
- Acceptance criteria per surface are in
  [`acceptance-criteria.md`](acceptance-criteria.md).
