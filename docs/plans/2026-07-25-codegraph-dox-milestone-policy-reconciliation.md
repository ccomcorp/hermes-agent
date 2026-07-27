# CodeGraph/DOX/milestone policy — advanced-elicitation reconciliation

**Date:** 2026-07-25  
**Reviewed artifact:** `docs/plans/2026-07-25-codegraph-dox-milestone-policy-spec.md`  
**Wave:** independent execution-surface, lifecycle-safety, and enforceability reviews

## Evidence

Durable reviewer outputs:

- `docs/reviews/2026-07-25-codegraph-dox-policy/execution-surface.json`
- `docs/reviews/2026-07-25-codegraph-dox-policy/safety-lifecycle.json`
- `docs/reviews/2026-07-25-codegraph-dox-policy/enforceability.json`

The reviewers were fresh-context, read-only workers. Their original verdicts were two `CHANGES_REQUIRED` and one `BLOCKED`.

## Reconciliation

| Finding | Severity | Resolution in revised specification | Closure |
|---|---:|---|---|
| Surface S1 — undefined code-tool gate | High | Defines “code-capable” as repository-bound access to any shell/file read/search/write tool; adds positive and negative fixtures. | Closed pending re-review |
| Surface S2 — child policy inheritance discretionary | High | Adds a dispatcher-built, versioned `ProjectPolicyEnvelope` with root and policy hashes; missing/mismatched envelope blocks child code work. | Closed pending re-review |
| Surface S3 — no child/Kanban closeout tests | Medium | Adds primary, delegated, and Kanban DOX and commit-closeout evaluations. | Closed pending re-review |
| Surface S4 — inherited MCP wrong-root risk | Medium | Requires exact `projectPath` equality with resolved child/worktree root; mismatches reject or rebind. | Closed pending re-review |
| Lifecycle F1 — no staleness algorithm | High | Replaces subjective staleness checks with bounded `codegraph init .` refresh before first structural query and after material code changes. | Closed pending re-review |
| Lifecycle F2 — commit/degraded-gate deadlock | High | Adds bounded retries and terminal `parked` state with blocking-gate inventory and user report. | Closed pending re-review |
| Lifecycle F3 — copied child policy can drift | Medium | Uses one canonical versioned guidance constant plus dispatch-time project-policy hashes; no independent long-lived prose copy. | Closed pending re-review |
| Lifecycle F4 — unguarded initialization | Medium | Adds timeout, retry cap, writable-root and free-space gates, structured fallback, and no-loop requirement. | Closed pending re-review |
| Enforceability F1 — prompt prose presented as enforcement | Blocker | Narrows and names v1 correctly: structural prompt delivery plus real tool-event receipts, hard completion checks only where engineering-loop/Kanban hooks exist, and an explicit shell/manual boundary. Universal host interception is not claimed. | Reconciled scope decision; pending re-review |
| Enforceability F2 — DOX discovery/identity undefined | Blocker | Defines root resolution, opt-in predicate, malformed-config behavior, receipt schema, and project-policy envelope identity. | Closed pending re-review |
| Enforceability F3 — milestone predicate undecidable | Blocker | Adds a milestone record/state machine, allowed staged paths, gate receipts, accepted review IDs, deterministic baseline `is_safe_to_commit`, optional project content scan, and one engineering-loop commit boundary. | Closed pending re-review |
| Enforceability F4 — prompt-only evals | Blocker | Replaces prompt-only checks with an execution-surface matrix using ordered real tool/command event traces and adversarial fixtures. | Closed pending re-review |

## Source checks used in reconciliation

- `agent/system_prompt.py::build_system_prompt_parts` is the common stable-prompt assembly path and already gates guidance using loaded tools/context.
- `tools/delegate_tool.py::_build_child_system_prompt` receives `workspace_path` but currently does not load project policy; it is the child envelope seam.
- `plugins/engineering_loop/git_commit.py::commit` already routes through `is_safe_to_commit`; the revised spec extends this existing boundary rather than inventing an unrelated commit path.
- `is_safe_to_commit` is a staged-filename/path safety check, not a full content secret scanner. The revised spec states that limitation explicitly.

These claims were traced through the repository CodeGraph before source-specific inspection.

## Decision

No runtime or worker change is authorized yet. The revised policy specification requires a fresh artifact-only re-review. If approved, it may land as a standalone design milestone before implementation cards are created. This policy work does not unblock the separate DYADOMORPH Gate 0 design gate.
