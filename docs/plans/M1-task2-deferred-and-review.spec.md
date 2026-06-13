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
- ⏸️ **D4 Option A + D3b — DEFERRED with gate-backed rationale (recommend a separate scoped change):**
  The elicitation reframed both. D3b (pre-delegation hook) is the C2 knowledge-gate *feature*, NOT
  an AC1 prerequisite — D3a proved AC1 moves via the built `prefetch`. D4 Option A (defer
  `mark_consumed` to a post-injection `confirm_consumed`) is, per First-Principles, a *marginally
  better proxy* (injected ≠ read), and per Pre-Mortem/Assumption it requires a NEW call site in
  `conversation_loop.py` that runs for **ALL** providers (builtin/honcho), capability-guarded —
  i.e. a shared-chassis change shipped for a feature that is **dormant** until the config flip.
  Recommendation: build D3b + D4-A as a dedicated, separately-reviewed change (with the integration
  test driving a *dropped* injection), not folded into this close-out — the risk/payoff while
  dormant does not justify bundling them with the low-risk remediations above.

### Implementation order (autonomous)
1. R-batch (R1, R2, R4, R9, R3, R8, R5+R5+, R6+R6b) — low-risk cleanup + guards, TDD where it adds signal.
2. D1 (defer construction + connect-Mock acceptance).
3. D2 (overlap + tombstone fixture).
4. D3a (AC1-demonstrable test — proves AC1 with the built prefetch).
5. D4 (Option B rename + Option A defer/confirm + capability-guard + integration test).
6. D3b (C2 pre-delegation hook, sharing D4's confirm path).
Verify after each; AIOS `git status` stays clean throughout.
