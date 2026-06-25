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
3. DECIDE  → engineering_loop_update(phase="decide", hypothesis="...")
4. ACT     → Run terminal commands, write files, run tests
5. FEEDBACK → engineering_loop_record_feedback(command=..., exit_code=...)
6. GATES   → engineering_loop_run_gate(all_gates=true)
7. REVIEW  → engineering_loop_request_review()
8. CHECK   → engineering_loop_check_termination()
9. COMMIT  → engineering_loop_commit()
10. TRACE  → engineering_loop_export_trace()
```

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
