# SPEC — M1 Task 2 deferred items (D1–D4) + code-review remediations (R*)

**Status:** DRAFT — pending `/advanced-elicitation` gate before implementation.
**Repo:** `I:/PROJECTS/AIOS/hermes-agent` @ `aios`. **Boundary:** the AIOS engine
(`I:/PROJECTS/AIOS/aios`) is read-only — no edits there; all work is dev-instance wiring.
**Predecessor context:** `docs/plans/M1-task2-experience-store-session-2026-06-13.md` (§4 deferred list).
**Methodology:** workflow-skeleton. This spec is the eval; ELICITATION interrogates it before code.

## Goal

Close the gap between "fork-authored lessons are *written*" (built this session) and "AC1 is
*demonstrable in the real runtime*," and remediate the validated code-review findings — without
touching the AIOS engine and without flipping `memory.provider: composite` (still gated).

---

## R* — Code-review remediations (validation input: this session's `/code-review` + `/advanced-elicitation`)

### R1 — Harness oracle must faithfully mirror `circulation()`'s filter
**Problem:** `scripts/synthetic_week_ac1.py` oracle filters `migrated=0 AND tombstoned=0`, but the
AIOS `store.circulation()` (store.py:434) filters only `migrated=0` (no tombstoned clause). They
coincide only because the synthetic week tombstones nothing → the oracle is not a faithful
cross-check and would diverge if a forgotten fork lesson appeared in a consumed hit.
**Change:** drop `AND tombstoned = 0` from the oracle so it matches `circulation()` exactly.
**Acceptance:** oracle == `circulation()` for a corpus that includes a tombstoned fork lesson which
sits in a consumed hit receipt (add to D2's overlap fixture).

### R2 — Stop overclaiming oracle independence
**Problem:** the harness docstring says the oracle means "producer and grader don't share one code
path," but the oracle shares `circulation()`'s *algorithm* (it re-derives the same two-step). It
catches arithmetic divergence, not a wrong *definition* of "consumed" (Sev-2 #8).
**Change:** reword to "independent re-derivation of the SAME definition (catches a shared-table/JOIN
bug, NOT a wrong consumption semantic — see D4)." Cross-reference D4.
**Acceptance:** docstring no longer claims path-independence; references D4 for the semantic gap.

### R3 — Cover the `staged`-skip branch with a test
**Problem:** `_lesson_from_tool_call`'s `if result.get("staged"): return None` (added this session)
has zero test coverage.
**Change:** add a test in `test_background_review_fork_append.py`: a successful-but-staged
`memory`/`skill_manage` result yields **no** lesson; a committed one yields a lesson.
**Acceptance:** test fails if the staged guard is removed/inverted.

### R4 — Single magic number for the lesson cap
**Problem:** `_LESSON_MAX_CHARS = 2000` (provider.py) is duplicated as a literal `2000` in
`sync_turn`'s brain-observe slice; the constant's comment claims they "match" but the code doesn't
enforce it.
**Change:** reference `_LESSON_MAX_CHARS` in the `sync_turn` slice.
**Acceptance:** changing the constant changes both sites; no literal `2000` in `sync_turn`.

### R5 — De-duplicate the prior-skip + success-scan walker
**Problem:** `extract_fork_authored_lessons` re-implements the prior-snapshot tool_call_id skip +
successful-`role=='tool'` scan that `summarize_background_review_actions` already does — and the
summarizer additionally handles tool messages WITHOUT a `tool_call_id` (content-equality fallback),
which `extract` does not. Drift risk.
**Change:** extract a shared helper `_iter_new_successful_tool_results(review_messages, prior_snapshot)`
yielding `(tool_call_id, parsed_dict)` for NEW successful tool results; both callers use it. Decide
(elicitation) whether `extract` should also gain the id-less fallback or deliberately require ids.
**Acceptance:** one definition of "new successful tool result"; existing background_review tests stay green.

### R6 — Loud signal when lessons are extracted but none are written (version-skew invisibility)
**Problem:** if the AIOS store ever rejects `task_type='implementation-pattern'` or `source='reviewed'`
(version skew), EVERY skill fork-lesson append raises → caught per-lesson → logged WARNING →
`written=0`, but the review summary still prints success → AC1 silently 0.
**Change:** in `record_fork_authored_lessons`, if `len(lessons) > 0 and written == 0`, log a single
**WARNING** ("extracted N fork lessons but wrote 0 — store rejected all; AC1 will not move").
**Acceptance:** with a store stub that rejects every append, the warning fires and is asserted by a test.

### R7 (carry-over, document-only) — Skip-if-AIOS-absent makes the AC1 gate inert without the sibling repo
**Problem:** every composite/AC1 test `skipif` when the AIOS packages aren't importable → on CI
without the sibling checkout the AC1 gate silently skips (false green).
**Change:** NO code change here (can't fix portability of a sibling-repo dependency in-test). Document
in the spec + session record that **at least one CI lane MUST have the AIOS checkout** or the gate is
meaningless. Track as an ops item.
**Acceptance:** documented; flagged to the user. (Not a code deliverable.)

### R8 — Import/path robustness with an actionable failure (correctness finder CF1+CF2)
**Problem:** `provider.py` does top-level `from store import …` after a sibling-relative
`sys.path` insert guarded by `if _d.is_dir()`. If the AIOS checkout is absent, or hermes-agent is
nested one level deeper / symlinked, `parents[3].parent` mis-resolves, the insert silently no-ops,
and line ~67 raises a bare `ModuleNotFoundError` with no hint that `AIOS_PACKAGES_DIR` is the fix →
the whole composite plugin dies opaquely.
**Change:** after resolving the path, if the expected AIOS dirs are not found, raise/log a CLEAR
error naming `AIOS_PACKAGES_DIR` and the expected sibling layout. Decide in elicitation: fail-loud
(import error with a helpful message) vs. degrade — but the message MUST be actionable.
**Acceptance:** with the AIOS dir absent, loading the composite produces an error string that names
`AIOS_PACKAGES_DIR` and the expected path (asserted by a test that monkeypatches the path away).

### R9 — `sync_turn` ack must not claim absent legs (correctness finder CF5)
**Problem:** `sync_turn` hardcodes `ack["vault"]="ok"` even though `vault=None` for M1 — the ack
reports a healthy vault leg that was never constructed, the same silent-degradation the agent_init
warning eliminates, reintroduced one layer down.
**Change:** report each leg by actual presence — `vault: "ok" if self._vault is not None else "skipped"`
(and confirm the brain leg already reflects None correctly).
**Acceptance:** with `vault=None`/`brain=None`, the ack reflects absence (no false "ok").

### R5+ — Extract must be id-strict; drop dead memory `new_string` (correctness finder CF3+CF4)
**Problem:** (CF4) if a backend emits empty/duplicate `tool_call` ids, `prior_ids` drops falsy ids
(`if not tcid: continue`), so a stale id-less write can be re-mirrored as fresh. (CF3) the memory
branch's `… or args.get("new_string")` is dead (memory never uses `new_string`).
**Change:** in `extract_fork_authored_lessons`, skip falsy/empty `tool_call_id` outright (an id-less
tool call cannot be safely deduped against prior → never mirror it). Remove the dead `new_string`
fallback from the memory branch. Fold into the R5 shared-helper decision.
**Acceptance:** a tool result with empty/`None` id yields no lesson (test); memory branch no longer
references `new_string`.

---

## D1 — Discovery must not construct (or leak) the experience store

**Problem (validated by cross-file tracer):** `register(ctx)` → `build_provider()` →
`ExperienceStore(db_path)` runs during the **read-only discovery probe** (`discover_memory_providers`
called from `hermes_cli/memory_setup.py`, `plugins_cmd.py`, `web_server.py` ×2), which:
1. creates `experience.db`(+wal+shm) in `HERMES_HOME` even when composite is NOT the active provider;
2. opens a sqlite connection that is **never closed** (probe never calls `shutdown()`) → leaked handle
   per probe (×2 per web page load) — on Windows an open handle can block file ops;
3. **double-constructs** on activation: probe builds store #1, `load_memory_provider` builds store #2 →
   two independent writer connections to one db → "database is locked" risk under concurrent
   fork-append + prefetch.

**Proposed change (to validate in elicitation):** make availability cheap and construction lazy:
- `is_available()` must not require a live store. The plugin should answer "available?" by checking the
  AIOS packages import (a cheap import check), NOT by opening sqlite.
- Defer `ExperienceStore` construction until the provider is actually initialized/used (e.g. build the
  store in `initialize()` or lazily on first store access), so a discovery probe constructs no db.
- Ensure exactly ONE store/connection exists for the active provider for process life.

**Open design questions (elicitation):**
- Where does lazy construction live — override `initialize()` to build the store, with a `_store`
  property that raises if used before initialize? Or a lazy-connecting store wrapper?
- `CompositeMemoryProvider.__init__` requires a `store` arg (AIOS, can't change). How do we give it a
  store object that doesn't open sqlite until used, without modifying AIOS? (Candidate: a thin
  lazy-proxy in the plugin that opens on first attribute access.)
- Does the loader (`_load_provider_from_dir`) cache the module so `register()` is called once, or per
  probe? Confirm the double-construction path precisely.

**Acceptance:**
- Running `discover_memory_providers()` with composite NOT active creates **no** `experience.db` and
  opens **no** sqlite connection (assert file absent + a connection counter/Mock).
- When composite IS active, exactly one `ExperienceStore`/connection is constructed across
  discover→load→initialize.
- `is_available()` returns True without constructing a store.

## D2 — Overlap-vocabulary fixture proving DISTINCT/dedup + tombstone semantics

**Problem (validated by altitude/test finder):** the current harness uses disjoint nonsense vocabulary
so each query hits exactly one lesson; `circulation == 3` is exact only by fixture construction. It
does not exercise: (a) one query hitting ≥2 fork lessons (DISTINCT dedup), (b) re-recall of an
already-consumed ref (no double-count), (c) a tombstoned fork lesson in a consumed hit (R1).

**Proposed change:** add a second fixture/run with deliberately OVERLAPPING vocabulary and assert the
DISTINCT semantics directly via the oracle + `circulation()`: e.g. a query that recalls two fork
lessons raises circulation by exactly 2; re-querying does not increment; a `forget()`-tombstoned fork
lesson behaves per `circulation()`'s real filter (R1).

**Acceptance:** a test where overlapping queries + a tombstone exercise dedup, no-double-count, and the
tombstone filter; oracle == `circulation()` throughout.

## D3 — C2 pre-delegation recall hook (the recall→hit half of AC1)

**Problem:** AC1 needs fork lessons RECALLED into a consumed hit in the real runtime. The write leg is
built; the only built recall site is session-start `prefetch` (fires once registered). The handoff's
SPEC C2 "knowledge-gate" pre-delegation recall hook **does not exist in the chassis** and must be built:
before a `delegate_task` dispatch, recall relevant experience lessons (call_site="pre-delegation") and
inject them so the subagent benefits — producing a `kind='hit'` receipt that, when consumed, feeds AC1.

**Proposed change (HEAVILY validate in elicitation — design-laden):**
- A recall entry point with `call_site="pre-delegation"`. The AIOS composite exposes only `prefetch`
  (hardcoded call_site="session-start"); add a dev-instance `recall_for(call_site, query)` on
  `HermesCompositeProvider` that calls `self._store.recall(query, call_site=call_site, limit=…)` and
  returns formatted context (reusing the base `_format_context`/merge where possible).
- A chassis hook at the delegation site (`tools/delegate_tool.py`) that, before dispatch, asks the
  parent's composite to recall against the delegation task text and injects the result into the
  subagent's context.
- Consumption semantics: mark the receipt consumed only when the recalled context is actually placed
  in the dispatched subagent prompt (ties into D4).

**Open design questions (elicitation):**
- Exact injection point in `delegate_tool.py` — where is the subagent's initial message/context built?
- Should pre-delegation recall reuse `prefetch`'s merge (store+warm cache) or be store-only? (Subagent
  context should be deterministic + fast → likely store-only recall.)
- How to reach the parent composite from the delegation site (same `agent._memory_manager` seam as the
  fork path)? Confirm the delegate tool runs on the parent with the manager available.
- Failure mode: recall miss → inject nothing (and a `recall_miss` receipt is written, never silent).
- Does this risk double-recall / receipt inflation with session-start prefetch? Keep call_sites distinct.

**Acceptance:**
- A delegation in a composite-active run produces a `call_site="pre-delegation"` receipt; a hit on a
  fork lesson that is then consumed increments `circulation()`; a miss writes `kind='miss'`.
- New unit/integration test drives a delegation through the hook and asserts the receipt + (on hit)
  circulation; no regression to existing delegate_task behavior when composite is absent (no-op).

## D4 — `mark_consumed` at the real injection site (Sev-2 #8 consumption semantics)

**Problem:** the AIOS composite's `prefetch` calls `mark_consumed` the instant it returns non-empty
text — "consumed" means "prefetch returned," not "the model used it." AC1 is gameable: a recall that is
never injected still counts. (AIOS-definition limit; can't change AIOS.)

**Proposed change (validate in elicitation — may be partially out of reach):**
- Investigate the chassis injection path: `memory_manager.prefetch_all` → `build_memory_context_block`
  → where the block is actually added to the outbound request (conversation_loop / chat helpers).
- Option A (dev-instance feasible): have `HermesCompositeProvider.prefetch` NOT mark consumed; instead
  return the receipt id alongside context (or stash it), and add a chassis call after the context is
  injected into the dispatched prompt that calls a new `confirm_consumed(receipt_id)`.
- Option B (if A is too invasive): document precisely that "consumed == injected-into-prompt" (not
  "read by model"), rename the guarantee in the health view, and leave the model-influence question to
  a later signal-based measure. The honest-naming fix, not a behavioral one.

**Open design questions (elicitation):**
- Can the dev instance defer `mark_consumed` without modifying the AIOS `prefetch` (which calls it
  inline)? The subclass can override `prefetch` to skip the inline mark and expose the receipt id.
- Is there a single chassis site where the memory-context block is provably injected into the request
  that just dispatched? If yes → Option A. If the block can be assembled-but-dropped → Option A is
  required for honesty.
- What does the health view (`experience_health`) need to surface so a regression is visible (#7/#8)?

**Acceptance:**
- Either (A) `mark_consumed` fires only after the recalled block is confirmed in the dispatched prompt
  (a test proves a recall that is assembled-but-not-injected does NOT mark consumed), OR (B) the
  semantics are renamed/documented end-to-end and the harness/health wording matches (no overclaim).

---

## Cross-cutting acceptance / invariants
- AIOS repo `git status` stays clean (no engine edits).
- `memory.provider` is NOT flipped to composite in this cycle.
- All new behavior degrades to a clean no-op when composite is not the registered provider.
- Full `tests/run_agent/` collection stays clean; the existing 18 dev-instance tests stay green;
  new tests added per R3, R6, D2, D3, D4.
- No silent failure: misses write receipts; extract-but-write-0 warns (R6); configured-but-unavailable
  warns (already done this session).

## Elicitation targets (what the gate must stress)
1. D1 lazy-store design without touching AIOS (`__init__` requires a store) — is the lazy-proxy sound,
   or does it just move the connection open? Does it break `is_available`/discovery contracts?
2. D3 injection point + reachability of the parent composite from `delegate_tool.py`; receipt/call_site
   collisions with session-start prefetch.
3. D4 feasibility of deferring `mark_consumed` from a subclass without AIOS edits; is Option A real or
   is B the honest answer?
4. R5 shared-helper extraction: does giving `extract` the id-less fallback change which lessons are
   mirrored (correctness), or should it stay id-strict?
5. Whether any of D1–D4 inadvertently require an AIOS edit (boundary violation) — flag early.

---

## POST-ELICITATION DECISIONS (gate output, 2026-06-13 — 4-agent /advanced-elicitation; BINDING)

**Boundary verdict: ZERO violations.** Every item is dev-instance-feasible via public store API
(`recall(call_site=…)`, `mark_consumed`, `append` are public) + editable chassis
(`conversation_loop.py`, `delegate_tool.py`, `memory_manager.py`, the plugin). No AIOS edit.

**D1 — REVISED: defer construction, do NOT build a lazy-proxy.** AIOS
`CompositeMemoryProvider.__init__/initialize/is_available` call no store method
(composite_provider.py:74-111) — the sqlite open is purely the plugin's eager `build_provider`.
- `is_available()` answers via a cheap AIOS-packages import check (no store construction).
- Build the `ExperienceStore` in the provider's `initialize()` (or first store access), NOT in
  `build_provider`/`register`. Memoize one provider/store per process (the loader re-runs
  `register()` per probe → confirmed double-construction).
- **Acceptance (de-tautologized):** PRIMARY assertion = a `sqlite3.connect` counter/Mock shows
  ZERO connections during `discover_memory_providers()` with composite inactive, and that
  `is_available()` opens nothing; SECONDARY = no `experience.db` file. Exactly one connection across
  discover→load→initialize when active.

**D2 — REVISED: fixture order + overlap.** Add an overlapping-vocabulary run AND a tombstone case;
the tombstone case MUST **recall+consume the hit BEFORE `forget()`** (recall filters `tombstoned=0`,
so tombstone-then-recall yields no hit). Assert oracle == `circulation()` including the post-tombstone
historical-receipt case (validates R1).

**D3 — SPLIT into D3a + D3b:**
- **D3a (AC1-demonstrable, READY, do first):** AC1>0 needs NO new hook — the built session-start
  `prefetch` already does recall→hit→`mark_consumed`. Deliverable = a test: register composite, seed a
  fork lesson (migrated=False), run `prefetch` on a matching query, assert `circulation()==1`. (This
  corrects the predecessor doc's claim that AC1 needs the C2 hook.)
- **D3b (C2 pre-delegation knowledge-gate, SEPARATE FEATURE):** add `recall_for(call_site, query)` to
  `HermesCompositeProvider` (calls `self._store.recall(query, call_site="pre-delegation", limit=…)`,
  returns the `(records, receipt)` tuple — note recall returns a 2-tuple). Add a PRE-DISPATCH hook in
  `delegate_tool.py` (before `_build_child_agent`; the existing `on_delegation` is POST-completion) that
  recalls against the delegation goal and folds the formatted block into the child's `context` arg
  (`_build_child_system_prompt`). The PARENT composite owns + consumes the receipt; the subagent
  (`skip_memory=True`, `memory` blocked) is a read-only beneficiary. **Guard:** no-op unless
  `manager.get_provider("composite")` exposes `recall_for`. Consumption ties to D4's confirm (mark only
  when the block reached the dispatched child prompt). Distinct `call_site="pre-delegation"` — circulation
  is DISTINCT-ref safe so no AC1 inflation, but `experience_health` should break receipts down by
  call_site so receipt-count inflation is visible.

**D4 — REVISED: do Option B unconditionally AND Option A (specified).**
- **Option B (honest naming, always):** "consumed" == "recalled block injected into the dispatched
  prompt", NEVER "read by the model". Fix health-view/harness wording (ties R2). The model-influence
  measure is explicitly deferred (signal-based, future).
- **Option A (real deferral, required because assemble-but-drop is real at conversation_loop.py:615-626):**
  `HermesCompositeProvider.prefetch` overrides the base to do `recall`→`self._merge_dedup`→
  `self._format_context` (REUSE the inherited helpers; do NOT re-implement) but **skip the inline
  `mark_consumed`**, stashing the receipt id (carrier: `TurnContext.ext_prefetch_receipt_id` or
  equivalent). A NEW `confirm_consumed(receipt_id)` is called in `conversation_loop.py` immediately
  AFTER `api_msg["content"]` is mutated (inside the successful-injection branch, ~:626) — never on
  prefetch-return.
- **Capability-guard (load-bearing):** the `confirm_consumed` call site runs for ALL providers; invoke
  only via `getattr(provider, "confirm_consumed", None)` → no-op for builtin/honcho.
- **Acceptance (de-tautologized):** an INTEGRATION test through the real `turn_context`→`conversation_loop`
  path: (i) a normal user-idx turn with str content → block injected → `confirm_consumed` fires →
  circulation increments; (ii) a turn where the injection guard is FALSE (e.g. non-str `_base`/non-user-idx)
  → block assembled-but-dropped → `confirm_consumed` does NOT fire → circulation does NOT move. No test
  may call `mark_consumed`/`confirm_consumed` directly to satisfy D3b/D4 — they share this one path.
- **Maintenance risk (recorded):** the `prefetch` override couples to AIOS prefetch internals — add a
  guard/test that detects upstream drift.

**R5/R5+ — RESOLVED toward id-strict.** Extract a shared `_iter_new_successful_tool_results(review_messages,
prior_snapshot) -> (tool_call_id, parsed)` for NEW successful `role=='tool'` results. The helper does NOT
centralize id policy: the EXTRACT caller stays id-strict (skip falsy ids — never mirror an un-dedupable
write); the SUMMARIZER caller keeps its content-equality fallback. Net change to the mirrored set = zero
(assert via existing background_review tests). Remove dead `new_string` from the memory branch.

**R6 + R6b.** R6 (extracted>0 & written==0 → WARNING) test must hit a REAL store with an invalid
task_type/source (version-skew path), not only a stub. R6b: when ≥1 NEW successful tool result was seen
but 0 mapped to lessons, log a DISTINCT INFO ("N tool results seen, 0 mapped") so a walker regression is
visible vs. a genuinely tool-less fork.

**R1, R2, R3, R4, R8, R9 — READY as written** (small, in-place). R7 doc-only.

### IMPLEMENTATION STATUS (2026-06-13)
- ✅ **DONE + tested:** R1, R2, R3, R4, R5/R5+, R6/R6b, R8, R9; **D1** (defer construction +
  cheap `is_available` + connect-Mock acceptance); **D2** (overlap dedup + tombstone, validates
  R1 oracle); **D3a** (AC1 proven via the built session-start `prefetch`, no hook). Files:
  `agent/background_review.py`, `agent/agent_init.py`, `plugins/memory/composite/provider.py`,
  `scripts/synthetic_week_ac1.py`, + tests `test_background_review_fork_append.py`,
  `test_composite_discovery_d1.py`, `test_ac1_prefetch_and_dedup.py`. 28 composite/AC1 tests +
  114 regression tests green; AIOS engine untouched.
- ✅ **D4 Option B (honest naming) DONE:** dev-instance docstrings + harness now state
  "consumed == recalled-block-injected, NOT read-by-model" (the model-influence measure is
  deferred). No dev-instance code claims "consumed = used".
- ✅ **D4 Option A + D3b — BUILT (round 2, 2026-06-13) to the REMEDIATION SPEC + ACs, after a
  post-implementation `/advanced-elicitation` gate (4 agents) caught the draft's defects.** Carrier =
  Option A (real `session_id` passed at `turn_context.py:372`; user-approved). Reconciled the draft to
  AC-R1..R7:
  - **AC-R1 / R2-1 / R2-6:** `prefetch_all` now receives the real `session_id`; stash key == confirm key.
  - **AC-R2 / R2-2:** D3b confirms AFTER successful child build (`delegate_tool.py` build loop), not at
    recall time → no over-count on build failure.
  - **AC-R3:** D4-A inject->confirm extracted to the testable `conversation_loop.inject_turn_context`;
    integration test `tests/run_agent/test_inject_turn_context.py` drives the REAL seam (injected→moves;
    assemble-but-drop→no move) via the live manager->provider path, no direct `confirm_*` call.
  - **AC-R4 / R2-7 / R2-6:** D3b hook extracted to `delegate_tool._apply_predelegation_recall` (no
    task_list mutation, no double-prepend); tested in `tests/tools/test_predelegation_recall.py`
    (augment, no-composite no-op, Mock-parent robustness).
  - **AC-R5 / R2-9:** `_pending_prefetch` freed on `on_session_switch`/`on_session_end`; per-turn
    overwrite bounds within a session.
  - **AC-R7 / R2-11 / R2-12:** semantic-fork note in `prefetch` docstring; this status reconciled.
  - **Residual (documented, not blocking):** R2-8 (recall under the store RLock + rerank on the
    delegation hot path) is AIOS-engine behavior (read-only) — accepted; pre-delegation recall is
    bounded (limit + one query/task). R2-10 (under-count via an alternate injection route) is latent
    and documented as a single-route invariant in `inject_turn_context`.
  - **STILL RUNG-2 ONLY:** all of the above is verified by component + real-chassis-seam tests, NOT a
    live agent run. The config flip + a live session (rung 3) remain the true end-to-end proof.
- ⛔ **#7 (surface `last_reward_dW_total`): BLOCKED-ON-TASK-3 + NEEDS-AIOS.** No reward path exists
  (brain=None) so there is nothing to surface, and the health-view surface lives in the read-only AIOS
  package. NOT doable this cycle; NOT a pre-flip item (it gates on the Task-3 brain adapter).
- ⛔ **AC6 (NeuroLinked recall byte-identical with composite in front): VACUOUS under brain=None** —
  the composite does not front the NeuroLinked MCP server in this build. Re-activate as a real
  assertion when the Task-3 brain adapter lands.

---

## ROUND-2 ELICITATION (post-implementation, 2026-06-13) — REMEDIATION SPEC (awaiting sign-off)

The D3b/D4-A draft was implemented THEN reviewed (wrong order). A 4-agent `/advanced-elicitation`
(Dependency-Chain, Failure-Mode, Knowledge-Gap, Pre-Mortem) found the issues below. The draft code is
UNCOMMITTED — treat it as a draft to reconcile against THIS spec after sign-off. **No further code until
acceptance criteria are signed off.**

### Meta-finding (why this matters)
The original POST-ELICITATION DECISIONS already prescribed (a) the carrier = `TurnContext.ext_prefetch_receipt_id`
and (b) an INTEGRATION test through `turn_context -> conversation_loop`. The draft deviated on BOTH —
provider-stash carrier + provider-level test only — and those exact deviations are findings R2-1 and R2-3/4.
Spec-first would have prevented them.

### Findings ledger (severity-ordered; convergence in parens)
- **R2-1 [Sev2, primary, Pre-Mortem+Failure-Mode] Session-key mismatch.** `turn_context.py:372` calls
  `prefetch_all(_query)` with NO `session_id` -> provider stashes under `self._session_id`; confirm
  (`conversation_loop.py:638`) uses the real `agent.session_id`. Gateway (shared cached composite) ->
  cross-session receipt corruption + AC1 reads 0. Root = the carrier spec-drift (R2-6).
- **R2-2 [Sev2, Failure-Mode] D3b confirm-before-build over-count.** `delegate_tool.py:2113` confirms the
  receipt BEFORE `_build_child_agent` (`:2141`); if the build raises (bad creds/model/toolset), the lesson
  is consumed but never dispatched -> AC1 over-count (the "looks like it worked" failure D4-A exists to
  prevent, re-introduced on the D3b path).
- **R2-3 [Sev2, Knowledge-Gap] D4-A acceptance unmet.** The chassis injection->confirm gate
  (`conversation_loop.py:615-640`) is covered by code-reading only; the existing test calls
  `confirm_prefetch_consumed` directly, which the D4 acceptance explicitly forbids. ZERO tests execute the
  real gate (esp. the assemble-but-drop case ii).
- **R2-4 [Sev2, Knowledge-Gap] D3b acceptance unmet.** The `delegate_tool.py` hook (context augmentation,
  capability-guard, miss-skip) has NO test. Provider primitives are tested, the hook is not.
- **R2-5 [Sev2, Knowledge-Gap] Flip-risk: real chain untested.** Tests inject a `:memory:` store; the real
  `prefetch_all -> conversation_loop confirm` chain and the on-disk lazy `initialize()` open are unexercised
  at the flip. Riskiest unexercised path.
- **R2-6 [Sev3, Knowledge-Gap] Carrier spec-drift.** Stash is on the provider dict (`provider.py:122/232/239`),
  not the spec's `TurnContext` carrier. Enabler of R2-1.
- **R2-7 [Sev3, Pre-Mortem] D3b in-place `task["context"]` mutation.** `delegate_tool.py:2111` mutates the
  caller's task dict -> double-prepend if the same `task_list` is reused/retried.
- **R2-8 [Sev3, Pre-Mortem] recall_for under the store RLock on the delegation hot path** (FTS + embedder
  rerank inside `store.recall`'s lock) -> latency / contention with mem-sync writes.
- **R2-9 [Sev4 bounded, Failure-Mode] Stash has no eviction / session-end cleanup.** Bounded by distinct
  session_ids (not per-turn), but grows monotonically over a long-lived gateway.
- **R2-10 [Sev3, Failure-Mode latent] Under-count via alternate injection route** (`_mem_injected` tracks
  only `_fenced`). Latent today; document the single-route invariant.
- **R2-11 [Sev3, Dependency-Chain] Semantic-fork doc gap.** Hermes `prefetch` defers consume; AIOS base
  self-consumes (and AIOS tests assert that). Document the divergence Hermes-side (no AIOS edit).
- **R2-12 [Sev3, Knowledge-Gap] Spec-status drift.** This spec marked D3b "DEFERRED" but it was built — reconcile.
- **#7 (last_reward_dW_total): [Sev3] BLOCKED-ON-TASK-3 + NEEDS-AIOS** — no reward path exists (brain=None),
  and the surface lives in read-only AIOS health. NOT doable this cycle; NOT pre-flip. Mark blocked.
- **AC6: [Sev4] vacuous under brain=None** (composite does not front the NeuroLinked MCP). Re-activate at Task-3.
- **FALSE ALARMS (no action):** every-turn regression (double-guarded); multi-call confirm (idempotent +
  DISTINCT dedup); lazy-store None-deref (init precedes turn); compression/branch re-inject.

### Contract / seam map (the cross-seam invariants that MUST hold — the part the draft skipped)
1. The prefetch STASH key and the confirm POP key MUST be the SAME identifier, sourced from the SAME place
   (the per-turn session id), so they never diverge across the single shared (gateway-cached) provider.
2. A receipt is consumed IFF its recalled block actually reached a DISPATCHED prompt — for D4-A (main turn)
   that is post-injection in `conversation_loop`; for D3b that is AFTER the child is successfully built.
3. The pre-delegation hook MUST NOT mutate the caller's task objects in a way that compounds on reuse.
4. Any new per-turn/per-session state MUST have a defined lifecycle (created where, freed where).
5. The chassis confirm call MUST be a clean no-op for non-composite providers (capability-guard) — verified.

### Acceptance criteria (sign-off targets; tests assert these BEFORE the code is considered done)
- **AC-R1 (session key):** in a simulated two-session shared-provider scenario, session A's confirm marks
  ONLY A's receipt and B's marks ONLY B's; with the fix, `circulation()` is deterministic. A test drives
  the REAL `prefetch_all(query, session_id=...)` -> confirm path (not a direct `confirm_*` call).
- **AC-R2 (D3b build-fail):** if `_build_child_agent` raises for a task whose pre-delegation recall hit, that
  lesson's receipt is NOT consumed (circulation does not move for the failed child).
- **AC-R3 (D4-A integration, both cases):** a `run_conversation`-level test: (i) a normal str/user-idx turn
  with a seeded fork lesson -> `circulation()` moves; (ii) a forced drop branch (non-str content /
  non-current-user-idx) -> `_mem_injected` False, NO confirm, `circulation()` does NOT move. No direct
  `confirm_*`/`mark_consumed` call in the test.
- **AC-R4 (D3b hook):** a delegation with a composite + seeded lesson augments the child `context` AND moves
  circulation (after build); a no-composite parent is a clean no-op leaving `context` unchanged.
- **AC-R5 (lifecycle):** `_pending_prefetch` is freed on session end / next-turn-for-session (no monotonic
  growth across a session's turns); a dropped/aborted turn leaves no orphaned mark.
- **AC-R6 (no-double-prepend):** re-running the hook over the same `task_list` does not prepend the block twice.
- **AC-R7 (docs/status):** the semantic-fork note exists Hermes-side; spec status reconciled (D3b = built);
  #7/AC6 marked BLOCKED-ON-TASK-3.

### OPEN DECISION (needs sign-off) — the R2-1/R2-6 carrier
- **Option A (minimal, recommended):** pass `session_id=agent.session_id` at `turn_context.py:372` so stash
  and confirm key on the SAME real session id; keep the provider dict; add session-end cleanup (R2-9). Correct
  for the real concurrency model (distinct session_ids); does NOT change the `prefetch_all` return contract.
- **Option B (spec-faithful):** carry the receipt id on `TurnContext` per turn (immune to any shared-state
  race). More invasive — the receipt id must travel from prefetch back onto the TurnContext and into
  conversation_loop; risks touching the manager/provider return contract used by all providers.

---

### Implementation order (autonomous)
1. R-batch (R1, R2, R4, R9, R3, R8, R5+R5+, R6+R6b) — low-risk cleanup + guards, TDD where it adds signal.
2. D1 (defer construction + connect-Mock acceptance).
3. D2 (overlap + tombstone fixture).
4. D3a (AC1-demonstrable test — proves AC1 with the built prefetch).
5. D4 (Option B rename + Option A defer/confirm + capability-guard + integration test).
6. D3b (C2 pre-delegation hook, sharing D4's confirm path).
Verify after each; AIOS `git status` stays clean throughout.
