---
name: engineering-loop
description: Engineering Loop Harness — Observe → Decide → Act → Capture Feedback → Check Termination. Provides structured engineering-loop supervision for software development tasks: verification gates, failure classification, stuck detection, adversarial review, and safe commit workflow.
version: 0.1.0
author: NousResearch
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [engineering, devops, testing, review, commit]
---

# Engineering Loop Harness

The Engineering Loop Harness wraps Hermes Agent's existing AIAgent loop with structured engineering-loop supervision: **Observe → Decide → Act → Capture Feedback → Check Termination**.

## When to Use

Use this harness when you're doing software development work and want:
- Structured verification gates (format, lint, typecheck, test, build)
- Automatic failure classification and stuck detection
- Non-interactive command enforcement (CI=true, timeouts)
- Adversarial code review by a different model
- Safe commit workflow with secret/cache detection
- Trace export for self-evolution

## How to Enable

Add `engineering_loop` to your `plugins.enabled` list:

```bash
hermes config set plugins.enabled '["engineering_loop"]'
```

Then restart your session. The harness activates on next turn.

## Tools

When active, the harness registers 10 tools:

| Tool | Description |
|------|-------------|
| `engineering_loop_start` | Initialize a new run with goal and acceptance criteria |
| `engineering_loop_status` | View current run status (gates, failures, review, commit) |
| `engineering_loop_update` | Update run phase, hypothesis, changed files |
| `engineering_loop_record_feedback` | Log structured feedback from command execution |
| `engineering_loop_run_gate` | Execute verification gates |
| `engineering_loop_monitor_app` | Manage dev server lifecycle |
| `engineering_loop_request_review` | Generate adversarial review prompt |
| `engineering_loop_check_termination` | Evaluate if run meets completion criteria |
| `engineering_loop_commit` | Safely commit changes |
| `engineering_loop_export_trace` | Export trace for self-evolution |

## Workflow

```
1. START  → engineering_loop_start(goal="...", acceptance_criteria=["..."])
2. OBSERVE → Read files, inspect git, check existing tests
   2a. CODEGRAPH-GATE (MANDATORY for code): use the repository CodeGraph first for
       symbol discovery, definitions, references, callers/callees, control flow, and
       blast radius before reading or editing implementation files. If `.codegraph/`
       is absent, initialize it. Treat verbatim graph-returned source as already read;
       use text search only for docs/non-code or a recorded graph limitation/failure.
3. DECIDE  → engineering_loop_update(phase="decide", hypothesis="...")
   3a. SPEC-GATE (MANDATORY when the slice writes/changes a spec, plan, schema, or design):
       auto-run ADVANCE-ELICITATION before implementation — dispatch independent
       fresh-context adversarial reviewers (distinct lenses; different model/family),
       reconcile findings, and only proceed to ACT once BLOCKERs are resolved.
       No spec reaches implementation un-reviewed.
       If a skipped spec gate is discovered after ACT has begun, STOP/PARK the
       implementation immediately, preserve the working tree, run the missing
       elicitation, reconcile and commit the design, then resume from that approved spec.
   3b. DOX-INIT (MANDATORY when developing/writing): ensure the project's DOX ledger is
       initialized (`hermes dox init` if no `docops.yml`/`dox/`) BEFORE producing artifacts,
       so work is documented as it progresses — never as a follow-up.
4. ACT     → Run terminal commands, write files, run tests
5. FEEDBACK → engineering_loop_record_feedback(command=..., exit_code=...)
6. GATES   → engineering_loop_run_gate(all_gates=true)
7. REVIEW  → engineering_loop_request_review()
8. CHECK   → engineering_loop_check_termination()
   8a. DOX-SYNC (MANDATORY): the slice's DOX ledger edits (CHANGELOG under Unreleased,
       dated session/execution-log entry, new ADR if a durable decision was made) exist
       and match the repo's ledger format. Termination is NOT met if DOX drifted.
9. COMMIT  → engineering_loop_commit()   # DOX edits ride in the SAME commit as the code
10. TRACE  → engineering_loop_export_trace()
```

## Mandatory policy (structural — do not rely on being reminded)

These are non-optional parts of the loop, enforced at the steps above:

1. **Advance-elicitation before implementation.** Any spec/plan/schema/design artifact is auto-evaluated by independent fresh-context adversarial reviewers (verify, validate, minimize gaps + dependency/interdependency issues + errors) BEFORE code is written or delegated. Reconcile into an elicitation log; resolve BLOCKERs first. (Step 3a.)
   **No grandfathering:** frozen, inherited, or already-partially-implemented specs are not exempt. Discovery of a missed gate is a stop-work condition until the spec is elicited, reconciled, versioned, and linked to testable evals.
2. **CodeGraph-first code search.** Initialize and use the repository CodeGraph before implementation discovery or edits. Text search is a fallback for documentation/non-code or a documented graph limitation, not the default. (Step 2a.)
3. **DOX kept in-sync per slice.** When developing or writing, the DOX ledger (Contract + Ledger + Publish: `docops.yml`, `dox/CHANGELOG.md`, `dox/adr/`, session/execution-log, and LIVE-STATUS/report packs for ops work) is initialized up front (3b) and updated in the SAME commit as the work it describes (8a/9). Deferring DOX IS how drift happens — do not defer. Match the repo's existing ledger format exactly; never fabricate gate results/commit hashes/verdicts.
4. **Orchestrator delegates; verifies at source.** Non-trivial build work is delegated through the routing harness (kanban/`delegate_task`), then personally verified at source before "done." Worker/board self-reports are not evidence.

## State Storage

Run state is stored in `.hermes/engineering-loop/` at your project root:
- `state.json` — Current run state
- `events.jsonl` — Append-only event log
- `verification.json` — Gate results
- `reviewer-feedback.json` — Adversarial review
- `logs/` — Captured command output
- `artifacts/` — Traces and other artifacts

## Pitfalls

- **Not persistent memory**: The harness stores state in files, NOT in Hermes MEMORY.md. Don't confuse run state with persistent memory.
- **Opt-in only**: The harness does nothing unless explicitly enabled. Verify with `engineering_loop_status` that it's active.
- **Non-interactive enforced**: Terminal commands are monitored. Interactive commands (vim, less, htop) are blocked.
- **Reviewer must differ**: Adversarial review requires a DIFFERENT model or agent. The harness detects same-model review and warns.
- **Hook failures non-fatal**: All hooks catch exceptions internally. The main agent loop continues even if harness hooks fail.

## Integration with Existing Systems

- **Memory (MEMORY.md)**: Never used for transient task progress
- **Skills**: The harness may suggest skill improvements via trace export; these feed the existing background-review pipeline
- **Kanban**: Harness runs alongside Kanban worker lifecycle — state is separate from Kanban task state
- **Prompt caching**: Context injection via `pre_llm_call` hook preserves cached system prompt tiers
- **Delegation**: Reviewer routing uses existing `delegate_task` with different model requirement
