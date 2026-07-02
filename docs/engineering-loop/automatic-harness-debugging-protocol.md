# Automatic Harness Debugging Protocol

## Status
Draft implementation protocol

## Purpose

When the engineering-loop harness, tool wrappers, or agent orchestration tools fail, Hermes must not keep working as if the harness is healthy. The failure itself becomes a first-class debugging task.

## Trigger conditions

Launch this protocol whenever any of the following occur:

- A harness tool raises an exception or returns a tool error.
- A harness run becomes stuck active and blocks a new run.
- A status, review, gate, commit, or termination tool reports inconsistent state.
- A warning indicates review/gate/commit evidence was not recorded.
- The agent falls back to manual gates because the harness is unavailable.

## Required response

1. Capture the exact error string, tool name, inputs, cwd, session id if available, and active run id if available.
2. Classify the failure as harness/tooling, environment, project gate, reviewer, or user-input required.
3. Build a tight regression loop that reproduces the tool failure.
4. Write the failing test first.
5. Fix the root cause in the harness, not only the current project state.
6. Run focused gates.
7. Record the lesson in the appropriate place:
   - tests for regression prevention
   - DOX/changelog for user-visible development history
   - skill update for reusable procedure
   - memory only for stable user/environment facts

## Current known failure classes

Persisted engineering-loop reviewer state may store reviewer status as a string such as `"PASS"`. On reload, code that assumes `ReviewerStatus` enum and accesses `.value` can crash with:

```text
AttributeError: 'str' object has no attribute 'value'
```

The repair pattern is to normalize persisted enum-like strings at state load boundaries and add regression tests using realistic saved JSON.

### Session/tool cache drift

Hook state and tool-handler state must be reset together at session boundaries. A run can be closed on disk but still appear active if the tool module keeps a process-local cached `StateManager` or `EngineeringRunState`.

The repair pattern is:

- expose a small tool-state reset seam,
- call it from the plugin `on_session_start` hook,
- make integration tests isolate cwd/HERMES_HOME, and
- close ignored `.hermes/engineering-loop` test artifacts instead of relying on a clean checkout.

### No discovered gates leave termination blocked

`engineering_loop_run_gate(all_gates=true)` must not return an empty successful result without recording verification evidence. For diagnostic/no-code work where no project gates are discoverable, record an optional passing `gate-discovery` result with `required=false`.

Gate results must preserve requiredness so termination can distinguish failed required gates from optional/skipped evidence. Termination checks should tolerate older persisted gate results by treating missing `required` as `true`.

Operational note: Hermes Desktop must be restarted or the plugin reloaded before source changes to tool handlers affect the live `engineering_loop_*` tools in the current process.

## Completion criteria

A harness repair is complete only when:

- The exact failure has a regression test.
- The regression test failed before the fix and passes after.
- Focused harness tests pass.
- The agent records if broader test failures are pre-existing or introduced.
- The fix is independently reviewed before commit.
