# Loop-liveness gate — the post-upstream-merge tripwire (AC-PX6)

**Status:** Reference (2026-06-14). Companion to the canonical safe-update runbook
(`aios/docs/Update-Instructions/safe-update-runbook.md`, §2 Step 5 verification gates). This is
the **continuous regression** that re-proves the self-improvement loop after every chassis bump
— directly closing the Pre-Mortem Sev-5 silent-rot finding (spec-loop-plugin-extraction §8).

---

## Why this gate exists

The extracted loop lives across four chassis call-sites ("seams") that the composite plugin
drives through generic `MemoryManager` fan-out:

| Seam id | File | Role |
|---|---|---|
| `background-review-write` | `agent/background_review.py` | fork-authored lessons enter the store (write leg) |
| `delegation-recall` | `tools/delegate_tool.py` | pre-delegation knowledge-gate recall (read leg) |
| `delegation-confirm` | `tools/delegate_tool.py` | mark the recall consumed once injected (consume leg) |
| `injection-confirm` | `agent/conversation_loop.py` | confirm prefetched memory reached the prompt (consume leg) |

A god-file refactor or a mis-applied upstream merge can silently MOVE or DROP one of these,
leaving the loop **wired but dead** — the predecessor's "15 lessons, zero reads" death. Three
tripwires catch it (static → boot → runtime); this gate is the static+behavioral one run on
every merge.

## The gate — run after EVERY upstream merge

In the worktree (the merge target), against its own venv, **before promoting to live**:

```powershell
# loop-liveness: real fork->store->recall->consume loop circulates (circulation>0)
#                AND the AC-PX5 #1 seam sentinels still resolve.
$env:PYTHONIOENCODING = "utf-8"
$env:HERMES_HOME = "I:\PROJECTS\AIOS\hermes-home"   # or a TEST home
python scripts\loop_liveness.py
#   (equivalently: python scripts\synthetic_week_ac1.py --fingerprint)
```

**Gate:** exit code **0**. A **non-zero exit = the loop seams moved (or circulation broke) —
fix before proceeding.** The script names which sentinel is missing (`AIOS-LOOP-SEAM:<id>`) so
re-homing is mechanical: move the loop call to the new upstream seam and re-plant the
`# AIOS-LOOP-SEAM:<id>` comment beside it. The expected id set lives in
`plugins/memory/composite/loop_guard.py:SEAM_SITES`.

This slots into the canonical runbook's **Step 5 (backend gates)**, alongside the composite
test suite:

```powershell
python -m pytest plugins/memory/composite/tests   # incl. test_loop_guard / test_loop_self_check / test_loop_boot_live
python scripts\loop_liveness.py                    # AC-PX6 loop-liveness + seam fingerprint
```

## The other two tripwires (context)

- **Boot (AC-PX5 #2):** `HermesCompositeProvider.initialize()` calls `assert_loop_wired(...)`.
  If the `MemoryManager` fan-out dispatch is missing OR a seam sentinel is gone, it raises
  `LoopWiringError` and `MemoryManager.initialize_all` **re-raises it** (refuse-to-boot) — the
  live agent will not start a silently-dead loop. (A correct boot never raises; covered by
  `test_loop_boot_live.py`.)
- **Runtime (AC-PX5 #3):** the composite's `loop_self_check()` runs at session-end; K
  consecutive write-only checks (circulation 0 with a corpus above the floor) emit a
  `logger.ERROR` and flip `loop_health()["status"]` to `write-only-alarm`.
- **Signature (AC-PX5 #4):** a provider that exposes a loop hook with the WRONG signature
  raises `LoopHookSignatureError` from the fan-out (half-ported provider) — distinct from a
  provider that simply doesn't implement it (clean skip).

## CI

`.github/workflows/loop-liveness.yml` runs `scripts/loop_liveness.py`, **path-filtered** on the
seam files + the composite plugin, so a PR touching a seam re-proves the loop. The local
post-merge gate above is the primary control (AIOS_RULE_3 favors in-loop checks); CI is the
backstop for PRs.
