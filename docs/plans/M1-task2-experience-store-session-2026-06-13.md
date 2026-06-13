# Session work record — M1 Task 2 (experience-store composite integration), dev instance

**Date:** 2026-06-13
**Repo / branch:** `I:/PROJECTS/AIOS/hermes-agent` @ `aios`
**Scope:** dev-instance WIRING for M1 Task 2 (binding the AIOS `CompositeMemoryProvider` +
`experience-store` into the hermes-agent chassis). Resolves pre-binding **BLOCKERS #2, #4,
#6, #5** from the handoff.
**Authoritative handoff:** `I:/PROJECTS/AIOS/aios/docs/guides/HANDOFF-M1-devinstance-and-neurolinked.md`
**Build/test boundary (AIOS_RULE):** the composite/experience-store/health **engines** live in
the AIOS repo (committed + unit-tested) and were **NOT modified** this session (`git status` in
the aios repo confirmed clean by an independent audit agent). All changes here are dev-instance
wiring only.

---

## 0. TL;DR / status

| Blocker | Sev | What it was | Status |
|---|---|---|---|
| #2 | 5 | Fork write leg unbuilt → AC1 numerator structurally 0 | ✅ Built (fork→composite append path + plugin) |
| #4 | 4 | No AC1 measurement harness | ✅ Built (synthetic-week replay + CI gate + independent oracle) |
| #6 | 3 | `experience_signal`/`experience_forget` tool-name collision risk | ✅ Verified clean + pinned by test |
| #5 | 3 | `sync_turn` appends every turn → FTS pollution | ✅ Gated (no raw-turn append; skip non-primary) |

**Tests:** 18/18 dev-instance composite/AC1/background-review tests pass; collection of the full
`tests/run_agent/` tree is clean (1632 collected, no import breakage). Synthetic-week harness:
`AC1 PASS` (`circulation=3`, independent oracle agrees).

**Two structural truths gate "AC1 demonstrably > 0 in the LIVE agent" — both OUTSIDE these four
fixes and both already on the handoff's radar:**
1. **The config flip is intentionally not done.** `memory.provider` is `neurolinked` in every live
   config; until it is `composite`, the fork→store path no-ops by design (the handoff gates the flip
   on all Sev-5/Sev-4 blockers).
2. **The recall→hit-receipt half of AC1 is not yet wired in the real runtime.** These fixes write the
   numerator's source data (fork-authored `migrated=0` lessons). The recall site that turns them into
   consumed hits is the session-start `prefetch` (fires once registered) + the **C2 pre-delegation
   hook (separate, unbuilt unit)**. The synthetic harness exercises recall via direct `comp.prefetch`.

Plus the **Sev-2 #8 caveat**: `consumed` currently means "prefetch returned text," not "the model
used it" — an AC1-**definition** limit inherited from the AIOS composite, not fixable in dev-instance
wiring.

---

## 1. Initial request

> "Read `…/HANDOFF-M1-devinstance-and-neurolinked.md`. Start with Task 2 BLOCKER #2 — wire
> `agent/background_review.py`'s fork to write fork-authored lessons through the
> composite/experience-store so AC1's numerator stops being zero."

Subsequent turns: `proceed` → BLOCKER #4; `proceed` → #6 then #5; then *"evaluate fixes using
/advanced-elicitation"*; then this document request.

**AC1 (the acceptance bar), receipt-based:** circulation = count of **distinct `migrated=0`** lesson
refs that appear in a `consumed=1, kind='hit'` receipt. Seed/migrated reads do **not** count; misses
must write `recall_miss` receipts (never silent). AC1 is receipt-based, never a raw count.

---

## 2. Architecture established (verified at source)

- **`store.circulation()`** (`aios/.../experience-store/store.py:413-438`) counts distinct `migrated=0`
  refs in `consumed=1 AND kind='hit'` receipts; migrated exclusion is SQL-enforced (`:435`).
- **The fork** (`agent/background_review.py`) builds `review_agent` with `skip_memory=True`, so it has
  **no provider of its own**; it rebinds the *builtin* MEMORY.md store and never touched the composite
  — the root of the zero numerator.
- **The seam:** `_run_review_in_thread(agent, …)` receives the **parent** agent; the parent (when
  `memory.provider: composite`) holds `agent._memory_manager.get_provider("composite")`. The append
  must route through the parent's composite.
- **`MemoryProvider` ABC is SYNC** (`agent/memory_provider.py`); `MemoryManager` enforces one external
  provider, routes tools by name, runs `sync_turn`/`queue_prefetch` on a single `mem-sync` worker and
  `prefetch`/`handle_tool_call` on the turn thread (`agent/memory_manager.py`).
- **Tool-call arguments are JSON strings** in `_session_messages` (`conversation_loop.py:3563-3573`
  json.dumps dict/list args before persist; `transports/anthropic.py:124`; `types.py:37`).
- **The store is thread-safe** (`store.py`: `check_same_thread=False` + re-entrant lock; every
  connection-touching method `@_synchronized`).

---

## 3. Work completed (per blocker)

### BLOCKER #2 — fork → composite append path

**New `plugins/memory/composite/provider.py`**
- Puts the AIOS `composite-provider` + `experience-store` dirs on `sys.path` (sibling-relative:
  `parents[3].parent/aios/packages/memory`, env-overridable `AIOS_PACKAGES_DIR`). When the chassis is
  on the path, `composite_provider.py` binds the REAL `agent.memory_provider.MemoryProvider`.
- `HermesCompositeProvider(CompositeMemoryProvider)` adds `record_fork_lesson(lesson, *, provenance,
  task_type='workflow', tags, source='reviewed')` → `store.append({…, "migrated": False})`
  (AC1-eligible band). Caps lesson text at 2000 chars.
- `build_provider(hermes_home)` → `ExperienceStore(db_path=f"{hermes_home}/experience.db")`,
  `brain=None`, `vault=None`, `owns_brain=False` (brain leg correctly reports `degraded` for M1;
  `owns_brain=False` so shutdown never closes a client it didn't create).

**New `plugins/memory/composite/__init__.py`** — `register(ctx)` builds the provider over
`get_hermes_home()` and calls `ctx.register_memory_provider`. Documents the gating note (do NOT flip
`memory.provider: composite` until blockers resolved).

**`agent/background_review.py`** — three additions, wired into `_run_review_in_thread` after the
action-summary block:
- `_lesson_from_tool_call(tool_name, args, result)` — maps a successful `memory`/`skill_manage` tool
  call to a lesson dict; memory→`workflow`, skill→`implementation-pattern`; skips removals; **skips
  staged (uncommitted) writes** (added post-review, see §4).
- `extract_fork_authored_lessons(review_messages, prior_snapshot)` — pairs NEW successful tool results
  (by `tool_call_id`, skipping ids already in `prior_snapshot`) with the originating assistant
  `tool_calls` args.
- `record_fork_authored_lessons(agent, review_messages, prior_snapshot)` — reaches
  `agent._memory_manager.get_provider("composite")`, calls `record_fork_lesson` with
  `provenance=f"fork:background_review:{session_id}"`; **no-op** when no composite is registered.

**Decision (user):** mirror **both** skill and memory writes (tagged distinctly), `source='reviewed'`
(distinct from the noisy `sync_turn` `source='auto'`), so memory-only review passes still feed AC1.

**Tests:** `tests/run_agent/test_background_review_fork_append.py` — extraction scope/skip rules + the
AC1 proof (append → recall → `mark_consumed` → `circulation() >= 1`).

### BLOCKER #4 — AC1 measurement harness

**New `scripts/synthetic_week_ac1.py`** — runnable replay that drives the **real** loop:
`record_fork_authored_lessons` (fork→store) → `comp.prefetch` (recall + receipt + `mark_consumed`) →
`ExperienceHealth.circulation_report()`. Distinct-vocabulary fork lessons + a `migrated=True` seed
(negative control) + a no-match miss query. `check_ac1` asserts `circulation == exactly 3` **while the
migrated seed is also consumed** (proves migrated exclusion), `recall_misses>=1`, `WRITE_ONLY_MEMORY`
flag off. Exit-code contract (0 = AC1 holds). Includes an **independent SQL oracle** (added post-review)
that recomputes circulation from raw `receipts`/`lessons` rows, bypassing `aggregate()`/`circulation()`.

**Why a new harness vs the AIOS realdata test:** the AIOS test pre-seeds the store and never exercises
the fork write leg — the exact blind spot that produced "15 lessons, 0 reads." This drives the fork path.

**Tests:** `tests/run_agent/test_synthetic_week_ac1.py` mirrors as a CI gate (4 tests).

### BLOCKER #6 — tool-name collision

`experience_signal`/`experience_forget` are **not** in `toolsets._HERMES_CORE_TOOLS` (verified), so
`MemoryManager.add_provider` won't silently drop them. **`tests/run_agent/test_composite_tool_registration.py`**
adds the composite to a real `MemoryManager` and asserts both tools route (`has_tool`) and appear in
`get_all_tool_schemas()`.

### BLOCKER #5 — `sync_turn` corpus pollution

**Decision (user): stop raw-turn appends entirely.** `HermesCompositeProvider` overrides:
- `initialize` — captures `agent_context` (documented as a currently-latent guard, see §4).
- `sync_turn` — **no store append at all** (brain-observe only); skips entirely when
  `agent_context != 'primary'`. `on_delegation` still appends (delegation observations kept).

Result: the store corpus is deliberately-authored lessons only (fork review + delegation), eliminating
the FTS pollution at the source and keeping AC1's `migrated=0` band pure.

**Tests:** `tests/run_agent/test_composite_sync_turn_gate.py` (4 tests: primary no-append, non-primary
skip, delegation still appends, fork-author still lands).

---

## 4. Adversarial evaluation (`/advanced-elicitation`) and corrections

Four parallel independent agents (Dependency Chain, Boundary Testing, Self-Consistency, Assumption
Surfacing), each source-citing against the running code. Independence caveat: all shared the orchestrator
O-R problem framing, so framing-level convergence is weaker than independent framing.

### Convergent findings
- **C1 [Sev5, evidence ×2] — Correct but DORMANT.** No config sets `memory.provider: composite` (live
  `…/AppData/Local/hermes/config.yaml:437` = `neurolinked`; repo `hermes-home/config.yaml:353` =
  `neurolinked`; all profiles); **no `experience.db` exists** → zero writes ever. Not a code defect —
  the documented, deliberate gate. Sharpens the claim to "built + gated," never "live today."
- **C2 [Sev2, reasoning ×2] — `consumed` ≡ "prefetch returned," not "model used it"** (handoff's own
  open Sev-2 #8; `composite_provider.py` `mark_consumed`). AC1-as-measured is gameable; an
  AC1-**definition** limit inherited from AIOS. My earlier "holds end-to-end" was an overstatement.
- **C3 [Sev4, ×3] — Silent-failure family:** configured-but-unavailable provider → `logger.debug`;
  missing sibling `aios` → swallowed ImportError; `sys.path.insert(0,…)` flat-module shadowing (latent).
- **C4 [evidence ×2] — `arguments` ARE JSON strings → my biggest worry FALSIFIED-AS-A-RISK.** The
  dict-args/`json.loads`-throws/silent-zero hypothesis does not occur in this runtime.

### Divergent findings
- Boundary F2 [Sev3] — staged (uncommitted, `memory.write_approval`) writes mirrored → store/disk divergence.
- Boundary F6 [Sev3] — `discover_memory_providers()` constructs the composite during CLI listing →
  creates `experience.db`+wal+shm even when composite isn't active.
- Assumption F2 [Sev4] — `agent_context` hardcoded `"primary"` (`agent_init.py:1150`) → the #5
  non-primary skip is dead code (mitigated: `sync_turn` appends nothing regardless).
- Self-Consistency F3/F4 [Sev3] — no independent oracle (producer & grader shared `aggregate()`);
  `circulation==3` over-fits disjoint vocabulary.
- Assumption F8 [Sev3] — the recall→hit half of AC1 is not wired in the real runtime.
- Boundary F5 / Assumption F7 — brain-observe per turn lacks backpressure (Task-3); per-profile DB scope.

### Corrections APPLIED this session (post-review)
1. **`agent_init.py:1190`** — `logger.debug` → `logger.warning` when an explicitly configured provider
   fails to load (addresses C3 silent-degrade; benefits all providers).
2. **`background_review.py` `_lesson_from_tool_call`** — skip `result.get("staged")` writes (Boundary F2).
3. **`provider.py` `initialize`** — documented the `agent_context` guard as currently latent (Assumption F2).
4. **`synthetic_week_ac1.py`** — corrected the docstring's scope claims (C2 honesty) **and** added an
   independent SQL oracle cross-checked in `check_ac1` (Self-Consistency F3).

### Deferred (with reasons)
- Discovery `experience.db` side-effect (Boundary F6) — clean fix needs lazy store construction; low
  frequency (only `hermes memory list`).
- Recall→hit wiring (Assumption F8) — the C2 pre-delegation hook is a separate unbuilt unit; session-start
  prefetch fires once registered.
- `consumed` injection-confirmation callback (C2 / Sev-2 #8) — needs a chassis change, out of scope.
- brain-observe backpressure (Boundary F5) — Task 3 (brain=None today).
- overlap-vocabulary fixture (Self-Consistency F4) — robustness nicety; the new oracle de-risks the count.

---

## 5. File manifest

**Created**
- `plugins/memory/composite/__init__.py`
- `plugins/memory/composite/provider.py`
- `scripts/synthetic_week_ac1.py`
- `tests/run_agent/test_background_review_fork_append.py`
- `tests/run_agent/test_synthetic_week_ac1.py`
- `tests/run_agent/test_composite_tool_registration.py`
- `tests/run_agent/test_composite_sync_turn_gate.py`
- `docs/plans/M1-task2-experience-store-session-2026-06-13.md` (this file)

**Modified**
- `agent/background_review.py` — `_FORK_LESSON_TOOLS`, `_lesson_from_tool_call` (incl. staged-skip),
  `extract_fork_authored_lessons`, `record_fork_authored_lessons`; wired into `_run_review_in_thread`;
  `__all__` updated.
- `agent/agent_init.py` — configured-but-unavailable provider now warns (was debug).

**Not modified (boundary):** anything under `I:/PROJECTS/AIOS/aios` (engines). Config (`memory.provider`)
deliberately **not** flipped.

---

## 6. How to verify

```bash
# AC1 replay (exit 0 = holds):
python scripts/synthetic_week_ac1.py

# Dev-instance test set for this work:
python -m pytest \
  tests/run_agent/test_background_review_fork_append.py \
  tests/run_agent/test_synthetic_week_ac1.py \
  tests/run_agent/test_composite_tool_registration.py \
  tests/run_agent/test_composite_sync_turn_gate.py \
  tests/run_agent/test_background_review.py -q
```
Tests `skipif` the sibling AIOS packages are not importable (set `AIOS_PACKAGES_DIR` to override the
sibling-path default).

---

## 7. Next steps (recommended order, before the config flip)

1. **C2 pre-delegation recall hook** — build the knowledge-gate site that calls
   `comp._recall(query, call_site="pre-delegation")`, so the recall→hit half of AC1 fires in the real
   runtime (Assumption F8).
2. **Discovery side-effect** — make composite availability cheap (lazy store) so CLI listing doesn't
   create `experience.db` (Boundary F6).
3. **Then** land the remaining handoff items (Sev-2 #7 health-view surfacing of `last_reward_dW_total`;
   #8 injection-confirmation for `consumed`), flip `memory.provider: composite`, and run AC1 + AC6 live
   in the dev instance.
4. **Task 3** (separate, user-owned .31 brain): the NeuroLinked `dW=0` truthy-guard fix, after which the
   composite brain leg can move `degraded → live`.
