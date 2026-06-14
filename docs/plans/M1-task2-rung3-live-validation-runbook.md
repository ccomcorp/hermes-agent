# Rung-3 live validation run-book — M1 Task 2 experience-store composite

**Goal:** prove the experience-store composite works **in a running Hermes agent** — the one thing
component + integration tests cannot prove. Rungs 1 (unit) and 2 (real-chassis-seam integration)
are green; this is rung 3.

**What rung 3 proves:** AC1 live — a **fork-authored** lesson, written by the background-review fork
in one session, is **recalled into a consumed context** in a later session (circulation > 0).

**What it does NOT prove (honest caveat):** that the model *acted on* the recalled lesson. "Consumed"
means "the recalled block was injected into the dispatched prompt," not "the model read/used it"
(the Sev-2 #8 semantics; a behavioural signal is future work). The **brain leg stays `degraded`/absent**
(brain=None) and **#7 (`last_reward_dW_total`) + AC6** remain BLOCKED-ON-TASK-3.

**Reversible:** flipping the config back to `neurolinked` fully restores prior behaviour; the
experience.db is harmless to leave or delete.

---

## 0. Preconditions
- On branch `feat/m1-experience-store` (has both M1 commits).
- The sibling AIOS checkout is importable (default sibling path, or set `AIOS_PACKAGES_DIR`). Confirm:
  `python -c "import plugins.memory.composite.provider as p; print('ok', p.build_provider.__name__)"`
- Baseline the store (should report none yet):
  `python scripts/inspect_experience_health.py`  → expect "no experience.db … not active".

## 1. Flip the switch
Set `memory.provider: composite` in the ACTIVE config. The live config is:
`%LOCALAPPDATA%\hermes\config.yaml` (currently `memory.provider: neurolinked`). The repo
`hermes-home/config.yaml` mirrors it for repo-home runs.
- Change `memory.provider` from `neurolinked` to `composite` (prefer `hermes config set memory.provider composite`
  if available, else edit the YAML).
- The NeuroLinked **MCP server** (`mcp_servers.neurolinked-brain`) stays enabled — it is a separate
  surface (agent-called tools), unaffected by the memory.provider key.

## 2. Activate + sanity-check
Start a fresh Hermes session (CLI/TUI). On startup, confirm:
- A log line **"Memory provider 'composite' activated"** (agent_init). 
- **NO** WARNING "Memory provider 'composite' is configured but not found or not available" — if you see
  it, the AIOS packages aren't importable (R8); fix `AIOS_PACKAGES_DIR` and restart.
- The model has the `experience_signal` / `experience_forget` tools (e.g. `hermes tools` / the schema).
- `experience.db` now exists under HERMES_HOME (created at provider `initialize`).

## 3. AC1 demonstration (two-session loop)
**Session A — author a fork lesson.** Have a short conversation that gives the background-review fork
something durable to save — e.g. state a clear, reusable preference ("when you write Python, always add
type hints") or walk through a non-trivial technique. End the turn(s) so the post-turn background review
runs. (If the review decides "Nothing to save", no lesson is authored — repeat with a clearer signal.)
- Inspect: `python scripts/inspect_experience_health.py`
  - Expect `fork_authored >= 1` (a `migrated=0` lesson now exists), `circulation` likely still **0**
    (authored but not yet recalled into a consumed context).

**Session B — recall it (NEW session).** Start a **fresh** session (`/new` or a new invocation) and ask
something whose wording overlaps the lesson ("how should you write Python here?"). The session-start
prefetch should recall the lesson and inject it; the chassis then confirms consumption.
- Inspect again:
  - **AC1 PASS = `circulation >= 1`** and the `WRITE_ONLY_MEMORY` flag is **off**.
  - `recall_hits` increased; a no-match query would add a `recall_miss` (never silent).

## 4. AC6 sanity (vacuous this build)
The composite has `brain=None`, so it does NOT front the NeuroLinked MCP server. Confirm the NeuroLinked
MCP recall tools still return what they did before (unchanged) — that is AC6, trivially satisfied here.
A *real* AC6 assertion (composite fronting NeuroLinked) belongs to Task 3.

## 5. Silent-failure signals to watch (the guards added this work)
- WARNING `configured but not found or not available` → composite failed to load (R8). 
- WARNING `extracted N fork lesson(s) but wrote 0 — store rejected every append` → version skew between
  this chassis and the AIOS store (R6): AC1 will not move; investigate `task_type`/`source` validity.
- INFO `fork tool writes seen but 0 mapped to lessons` → the fork wrote memory/skills but none mapped
  to a lesson (all staged/removals, or a mapping regression) (R6b).
- The composite's per-backend ack reports the brain/vault legs as `skipped`/`degraded` (brain=None) —
  expected, not an error.

## 6. Rollback
Set `memory.provider` back to `neurolinked` (or remove the key) and restart. Optionally delete
`%LOCALAPPDATA%\hermes\experience.db*` (db/-wal/-shm). No other state changes.

## 7. Pass / fail summary
| Check | Pass condition |
|---|---|
| Activation | "composite activated" log; no "not available" WARNING; `experience.db` created |
| AC1 | after the two-session loop, `inspect_experience_health.py` shows `circulation >= 1`, `WRITE_ONLY_MEMORY` off |
| No silent failure | none of the R6/R6b/R8 WARNING/INFO signals fire unexpectedly |
| AC6 | NeuroLinked MCP recall unchanged (vacuous under brain=None) |
| Brain leg | reports `degraded`/`skipped` (expected until Task 3) |

If AC1 does not move after a genuine author→recall loop, run the inspector and check the §5 signals; the
most likely causes are (a) the fork said "Nothing to save" (no `migrated=0` lesson written), or (b) the
session-B query did not lexically overlap the lesson (FTS miss — try wording closer to the lesson text).
