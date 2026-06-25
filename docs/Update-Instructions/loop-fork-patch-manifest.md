# Carried Fork-Patch Manifest — the AIOS self-learning loop

**Purpose:** this fork (`ccomcorp/hermes-agent`, branch `aios`) carries a small, deliberate delta on top of upstream NousResearch `hermes-agent` that wires the AIOS self-learning loop (the experience-store composite). It is **carried, upstream-offered, NOT upstream-gated** (see `aios/docs/architecture/spec-loop-plugin-extraction/`). After any upstream merge, this manifest tells you exactly what to preserve and how to verify it.

Pair with [`loop-liveness-gate.md`](loop-liveness-gate.md): run loop-liveness after every merge; a fingerprint failure means a seam below moved.

## Chassis-core delta (the part that must survive an upstream merge)
All four seam call-sites carry a `# AIOS-LOOP-SEAM:<id>` sentinel — the static tripwire. If an upstream refactor moves/renames a host function, re-home the seam and restore its sentinel.

| File | What the delta adds | Seam sentinel |
|---|---|---|
| `agent/memory_provider.py` | 4 OPTIONAL no-op ABC hooks: `confirm_prefetch_consumed`, `on_background_review(lesson_candidates,*,session_id)`, `recall_for_delegation(goal,*,session_id)->(block,rid)`, `confirm_consumed(rid)`. Backward-compat: providers implementing none are unaffected. | — |
| `agent/memory_manager.py` | Capability-guarded fan-out for the 4 hooks; `LoopHookSignatureError` + `_binds_loop_hook` (signature-mismatch fail-loud); `initialize_all` threads `memory_manager=self` into `provider.initialize()` and **re-raises `LoopWiringError`** (matched by class name — no import dep on the plugin). | — |
| `agent/background_review.py` | Chassis extracts lessons (kept) then calls `manager.on_background_review(candidates,...)` (neutral shape) instead of a `get_provider("composite")` lookup. | `background-review-write` |
| `tools/delegate_tool.py` | `_apply_predelegation_recall` dispatches via `manager.recall_for_delegation(...)`; confirm via `manager.confirm_consumed(...)`. The ~15-line per-task orchestration (map, `context=` inject, confirm-after-build) is retained — provider-agnostic. | `delegation-recall`, `delegation-confirm` |
| `agent/conversation_loop.py` | `inject_turn_context` calls `mm.confirm_prefetch_consumed(...)` (the consume-at-injection seam). | `injection-confirm` |
| `hermes_cli/main.py` | Safe-update refuse-guard: pure helper `_safe_update_blocked(project_root, env)` (case/separator-robust chassis-path compare + `HERMES_SAFE_UPDATE_OK` falsy check) + a tiny early-return at the top of `cmd_update` that calls it and refuses (exit 1, pointer to `Invoke-HermesSafeUpdate.ps1`) when run as a bare `hermes update` inside the AIOS chassis. The orchestrator's `HERMES_SAFE_UPDATE_OK=1` is the passthrough; any non-chassis install and every non-`update` command are unaffected. Spec: `aios/docs/architecture/SPEC-safe-update-interception.md` §2 Option B + AC-SI5. | `AIOS-SAFE-UPDATE-GUARD` |

**Invariant:** zero `"composite"` hard-strings in `agent/` or `tools/` (AC-PX2). All provider dispatch is generic fan-out.

### Changelog
- **2026-06-15** — Added the `# AIOS-SAFE-UPDATE-GUARD` row above (`hermes_cli/main.py`). In-chassis refuse-guard (SPEC-safe-update-interception v2, Option B floor). The guard sentinel wraps both the helper and its call-site; on an upstream merge that moves `cmd_update`, re-home the call-site and restore the sentinel. Test: `tests/hermes_cli/test_cmd_update_safe_guard.py` (opts out of the autouse `HERMES_SAFE_UPDATE_OK` passthrough fixture added to `tests/hermes_cli/conftest.py`; marker `aios_safe_guard` registered in `pyproject.toml`). Cross-repo: the orchestrator/launcher that must set `HERMES_SAFE_UPDATE_OK` lives in the AIOS repo (`aios/scripts/update-guard/`).

## Plugin-side (ships with the plugin; not upstream's concern)
`plugins/memory/composite/{provider.py, loop_guard.py}` (the `HermesCompositeProvider` + the boot wiring assertion / seam fingerprint / `loop_self_check`), `scripts/{synthetic_week_ac1.py, loop_liveness.py}`, `.github/workflows/loop-liveness.yml`.

## Post-upstream-merge procedure
1. Merge upstream LOCALLY (per the local-is-source-of-truth model — never pull onto the canonical tree; merge then push).
2. Run `python scripts/loop_liveness.py` (forces `synthetic_week_ac1 --fingerprint`). Exit 0 = the 4 sentinels resolve AND AC1 circulation > 0.
3. If the fingerprint reports a missing sentinel, the named seam moved in the merge — re-apply that row's delta at the new call-site and restore its `# AIOS-LOOP-SEAM:<id>` sentinel, then re-run.
4. Boot the dev instance once: the composite's `initialize()` refuses to load (`LoopWiringError`) if the wiring is incomplete — a loud, early signal that a delta row was lost.

## Why carried, not upstreamed (yet)
The 2 neutral hooks (`on_background_review`, `recall_for_delegation`) are upstream-offerable; until/unless NousResearch adopts them, this carried patch is the steady state. No functionality is blocked on a third party (spec §4). Re-offer opportunistically; if declined within the chosen window, this manifest IS the permanent home.
