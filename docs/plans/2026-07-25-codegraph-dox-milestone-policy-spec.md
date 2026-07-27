# CodeGraph-first, project-wide DOX, and validated milestone commit policy

- **Status:** Proposed; no runtime prompt or worker behavior change is authorized until advanced elicitation is reconciled and this design slice is committed.
- **Date:** 2026-07-25
- **Scope:** Hermes primary/profile agents, delegated children, Kanban workers, project context files, and the engineering-loop milestone boundary.

## Problem

The current engineering-loop skill can state CodeGraph-first locally, but that does not guarantee the policy reaches every execution surface:

- delegated children use a focused ephemeral prompt and set `skip_context_files=True`;
- Kanban workers receive separate `KANBAN_GUIDANCE`;
- profile agents may run outside a repository context or without a CodeGraph MCP tool loaded;
- project DOX instructions live in `AGENTS.md` and must reach agents whose working directory is the project;
- commits need a validated milestone boundary, not an arbitrary end-of-turn or file-save trigger.

A policy that appears in only one skill or one project file is therefore incomplete.

## Enforcement model and non-goals

This is a mandatory **agent execution policy** with structural prompt delivery and tool-event auditability. Version 1 does not claim to be an operating-system sandbox: arbitrary shell text searches and manual/user Git commits cannot be reliably intercepted at every transport. The implementation must not call prompt presence “hard enforcement.” It must instead:

1. deliver one canonical policy block to every code-capable Hermes execution surface;
2. bind delegated/Kanban work to an exact repository and project-policy identity;
3. make compliance observable from real tool-call events and command receipts rather than assistant prose;
4. fail engineering-loop/Kanban completion when their available completion validator lacks required receipts; and
5. state explicitly when an ordinary profile/chat session has guidance plus audit evidence but no host-level completion blocker.

Hard interception of arbitrary terminal commands is deferred. It requires a separate source-verified tool-host design and is not needed to make CodeGraph-first the governing agent instruction now. No automatic commit mechanism is authorized.

## Required behavior

### P1 — Deterministic CodeGraph-first protocol

“Code-capable” means an agent has any shell, file-read, file-search, or file-mutation tool and its resolved working directory is inside a repository. For code discovery, comprehension, or change-impact analysis, every primary/profile agent, delegated child, and Kanban worker must:

1. resolve the repository root (`git rev-parse --show-toplevel` when Git is present; otherwise the explicit workspace root) and normalize it to an absolute path;
2. before the first structural query in a task, refresh that exact root with `codegraph init .` from the root when the CLI is available; cap each attempt at 180 seconds, retry at most once only for a classified transient failure, and never loop;
3. when initialization would create `.codegraph/`, first require a writable root and at least 1 GiB free on the target volume; otherwise emit the bounded fallback receipt below;
4. call `mcp__codegraph__codegraph_explore` with `projectPath` exactly equal to the resolved root; an inherited tool bound to another root is invalid and must be rebound/reinitialized or treated as unavailable;
5. treat verbatim source returned by CodeGraph as already read;
6. use text search without a fallback receipt only for documentation/non-code artifacts; and
7. after material code changes, refresh the graph before later blast-radius, caller/callee, or review queries.

A CodeGraph failure permits bounded text fallback only after a structured receipt records: task/session ID, absolute repository root, UTC timestamp, intended structural query, attempted tool/command, failure class (`unavailable | timeout | stale_or_wrong_root | unsupported_query | permission | capacity | corrupt`), attempt count, and the bounded fallback scope. The tool event or command result is the evidence; assistant prose alone is not.

### P2 — Structural execution-surface coverage

- Define one versioned `ENGINEERING_PROJECT_POLICY_GUIDANCE` constant and inject it from `agent/system_prompt.py` whenever the session is code-capable. Do not maintain independent prose copies.
- The delegate dispatcher resolves the child workspace before construction and passes a versioned `ProjectPolicyEnvelope` containing repository root, guidance version/hash, root `AGENTS.md` hash when present, and DOX identity when enabled. `_build_child_system_prompt` renders that envelope for leaf and orchestrator roles. A missing or root-mismatched envelope blocks code work, not unrelated prose/research work.
- Kanban dispatch resolves the task worktree and passes the same envelope. `$HERMES_KANBAN_WORKSPACE`, envelope root, and CodeGraph `projectPath` must agree.
- Repository `AGENTS.md` remains the project-specific contract and may strengthen, but not weaken, this policy. Project text is loaded at dispatch time and bound by hash; it is not copied into another long-lived constant that can silently drift.
- The exact MCP tool is preferred. If it is not loaded, the agent may discover it through the tool registry. CLI-only use is allowed only when it can provide equivalent root-bound initialization/query evidence; otherwise use the structured fallback receipt.

### P3 — Deterministic project-wide DOX

Repository root is resolved as in P1. DOX is enabled when root `docops.yml` exists and `hermes dox status --root <repo>` recognizes it. Missing configuration means DOX is not enabled; malformed, ambiguous, or nonzero status is a blocking configuration failure, never a silent opt-out.

For each meaningful specification, implementation, migration, or operational slice in a DOX-enabled repository:

1. load root `AGENTS.md`, `docops.yml`, and the DOX guidance resolved by Hermes at prompt/dispatch time;
2. let the installed `hermes dox` implementation resolve configured ledgers and ownership; update the nearest owning AGENTS/index only when structure or ownership changed;
3. update the configured changelog and session/execution ledger in the same validated slice;
4. run `hermes dox status --root <repo>` and `hermes dox check --root <repo>` before completion; and
5. include DOX files in the same milestone commit when a commit is authorized.

Each DOX receipt records repository root, Hermes version, SHA-256 of `docops.yml`, exact command, exit status, and stdout/stderr digest. Children and Kanban workers receive the resolved DOX identity in their `ProjectPolicyEnvelope`; they do not rely on stale reproduced prose. No agent may fabricate receipts, gate results, commit hashes, or operational status.

### P4 — Validated milestone state and commits

A milestone record is created for every agent-issued milestone commit. It contains: milestone ID; repository root; allowed staged-path set; required test/build/lint/type commands and their exit-status/output digests; accepted review/elicitation artifact IDs; DOX receipts when enabled; the result of `plugins.engineering_loop.git_commit.is_safe_to_commit`; any project-declared staged-content secret-scan command and receipt; commit message; and state. The existing `_BLOCKED_PATTERNS` list in `git_commit.py` is the authoritative baseline path-deny rule. This policy does not mislabel that filename/path check as a full content scanner.

States are `working -> parked | validated -> committed`. A milestone becomes `validated` only when every declared gate passes, staged paths exactly match the allowlist, the baseline safety check passes, and any project-declared staged-content scanner passes. Only a validated record authorizes the engineering-loop commit helper to issue `git commit`. Raw terminal `git commit` is prohibited for an agent-owned engineering milestone but remains outside universal host interception in v1. The record does not authorize push, merge, or history rewrite. A turn/worker/timer ending never authorizes a commit.

If a transient gate fails, retry at most twice total. A structural failure or exhausted transient retry moves the milestone to `parked`, preserves the work, records the blocking-gate inventory, and reports the blocker to the user. It must not loop, fabricate success, or commit partial work. A validated milestone should be committed promptly before unrelated work accumulates, subject to the project contract and user authorization.

Version 1 governs agent-issued commits through instruction plus audited command/tool events. It does not claim to block a user or external process from invoking Git directly.

## Injection and validation seams

1. `agent/prompt_builder.py` / `agent/system_prompt.py`
   - define and inject the one canonical guidance block for code-capable repository sessions;
   - retain Kanban-specific lifecycle wording, but import the canonical policy identity instead of duplicating prose.
2. `tools/delegate_tool.py:_build_child_system_prompt`
   - require and render `ProjectPolicyEnvelope` for repository-bound code work;
   - validate workspace/root/policy hashes at construction time.
3. `plugins/engineering_loop`
   - retain the CodeGraph/DOX/milestone gates;
   - validate tool-event order and receipts before declaring an engineering-loop task complete.
   - extend the existing `git_commit.commit` boundary to require a validated milestone record while preserving `is_safe_to_commit` as the baseline staged-path check.
4. Kanban completion
   - validate workspace-bound CodeGraph and DOX receipts plus milestone state before marking a code task complete.
5. Project roots
   - keep `.codegraph/` as derived local state and use root `AGENTS.md` plus `docops.yml` as canonical project policy inputs.

## Normative evaluation matrix

Every behavioral fixture captures the real ordered tool/command event trace, not only rendered prompt text.

- **EVAL-CG-01 — prompt delivery:** primary/profile, delegated leaf, delegated orchestrator, and Kanban fixtures all receive the same guidance version/hash when code-capable; a non-repository prose fixture does not.
- **EVAL-CG-02 — first-path ordering:** each code surface refreshes the exact root and calls CodeGraph before code-oriented text search; a docs-only search is exempt.
- **EVAL-CG-03 — bounded fallback:** missing MCP/CLI, timeout, corrupt index, permission, and unsupported-query fixtures emit the structured receipt before bounded text fallback; silent fallback fails.
- **EVAL-CG-04 — post-edit freshness:** material code mutation followed by blast-radius review requires a second refresh; a stale graph result cannot satisfy completion.
- **EVAL-CG-05 — root binding:** parent index root, child worktree, and Kanban worktree mismatch cases are rejected or rebound before query.
- **EVAL-CG-06 — init guards:** timeout is enforced, retry is capped, insufficient disk/unwritable root skips initialization with a receipt, and no case loops.
- **EVAL-DOX-01 — primary closeout:** enabled fixture records valid status/check receipts and required ledger changes; missing/nonzero/malformed evidence blocks completion.
- **EVAL-DOX-02 — delegated closeout:** child receives the exact project-policy envelope and cannot satisfy engineering-loop completion with stale/missing DOX identity or receipt.
- **EVAL-DOX-03 — Kanban closeout:** worker completion is rejected when worktree identity, ledger update, or DOX receipt is absent.
- **EVAL-COMMIT-01 — state machine:** untested, unreviewed, secret-containing, unrelated-staged, or missing-DOX fixtures remain working/parked; a fully scoped fixture alone reaches validated then committed.
- **EVAL-COMMIT-02 — no end trigger:** turn, child, Kanban worker, timeout, and process termination do not auto-commit.
- **EVAL-COMMIT-03 — degraded gates:** structural failure or two exhausted transient attempts parks once with a complete blocker inventory and no commit/loop.
- **EVAL-COMMIT-04 — bypass boundary:** ordinary shell/user Git remains outside host-level v1 enforcement and is reported as such; engineering-loop/Kanban completion still rejects absent receipts.

## Elicitation finding reconciliation

- Execution-surface S1-S4: closed by explicit code-capable definition, structural policy envelopes, per-surface closeout evals, and exact root binding.
- Lifecycle F1-F4: closed by refresh-before-query, bounded retries/parking, canonical versioned guidance/envelopes, and initialization guards.
- Enforceability F1-F4: the spec no longer overclaims a universal sandbox; it defines trusted event/command receipts and hard completion validation where hooks exist, deterministic DOX/milestone records, and an explicit shell/manual-Git boundary.

## Rollback

Revert the prompt/envelope/validator changes and their tests. Existing `.codegraph/` indexes, DOX ledgers, and parked milestone records remain derived/documentary state and need not be deleted. No repository history rewrite is authorized.
