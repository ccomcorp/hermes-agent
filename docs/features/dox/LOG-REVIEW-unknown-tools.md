# Kanban / tool log review — unknown tools & engineering_loop failures

**Date:** 2026-07-16  
**Board:** engineering (Hermes DOX workers)

## Symptoms in DOX worker logs

| Log signal | Where | Severity |
|------------|--------|----------|
| `[Tool handler returned unsupported result type...]` on every `engineering_loop_start` | `logs/t_8f7b54d1`, `t_13a99b64`, `t_30ab590b`, `t_dee06cba` | **Broken harness** (silent fail) |
| `Warning: Unknown toolsets: mcp-codegraph` | Same workers at process start | Noise / missing MCP in worker spawn |
| Historical: `Unknown toolsets: engineering_loop` | Older kanban logs | Plugin not enabled for that profile |
| Historical: `_handle_start() got unexpected keyword argument 'task_id'` | `logs/errors.log.2` (June) | Fixed later via `_adapt_handler` |
| `kanban_comment` → `task_id is required` | `t_13a99b64` once | Worker API misuse, then retried OK |

## Root cause #1 (primary) — engineering_loop result contract

**Registry contract** (`tools/registry.py` `_normalize_handler_result`):

- Allowed: `str`, or multimodal `dict` with `_multimodal: true` + `content: list`
- Anything else → error string with `error_type: tool_result_contract`

**Plugin handlers** (`plugins/engineering_loop/tools.py`):

- Return plain `Dict[str, Any]` (e.g. `{"ok": True, "run_id": ...}`)
- `_adapt_handler` fixed **kwargs/task_id** dispatch but **did not JSON-serialize** return values

**Effect:** Every `engineering_loop_*` call from kanban workers showed as failed “unsupported result type” even when the underlying start logic ran. Workers noted “engineering_loop tool calls failed with tool_result_contract” and continued without a real harness.

### Fix applied (2026-07-16)

In `_adapt_handler`, wrap returns with `_normalize_result` that `json.dumps` dict/list results.

**Verified live:**

```text
engineering_loop_start → str {"ok": true, "run_id": "erun-...", ...}
engineering_loop_status → str {"ok": true, ...}
```

**Note:** Running kanban workers already in-flight keep the old process image until reclaim/restart. Next spawn of workers picks up the fixed plugin code from disk.

## Root cause #2 — Unknown toolsets: mcp-codegraph

`profiles/dev-agent/config.yaml` includes `mcp-codegraph` in `platform_toolsets` (cli/kanban paths).

Kanban workers often start with a reduced MCP attach path → Hermes prints:

```text
Warning: Unknown toolsets: mcp-codegraph
```

This is **not** “unknown tool” at dispatch for a named tool call; it is **toolset name not resolved** at session start. Non-fatal if worker does not need CodeGraph, or if MCP later attaches.

**Mitigation options (config, not required for DOX):**

1. Remove `mcp-codegraph` from kanban-specific platform_toolsets for worker profiles, **or**
2. Ensure kanban spawn inherits MCP config that registers the `codegraph` server so the toolset materializes.

## Root cause #3 (historical) — task_id kwargs

Fixed by `_adapt_handler` using `inspect.signature` and dropping undeclared kwargs. No longer the DOX failure mode.

## Recommendations

1. **Keep the json.dumps adapter** (landed in working tree on `plugins/engineering_loop/tools.py`).
2. **Reclaim/restart long-running workers** that started before the fix if they still need engineering_loop.
3. Optionally add a unit test that `registry.dispatch("engineering_loop_start", …)` returns a `str` that `json.loads`.
4. Quiet MCP warning for kanban workers by not advertising `mcp-codegraph` unless MCP is wired for that profile spawn.

## Not the same as “Unknown tool: X”

`Unknown tool: name` = tool not registered in registry.  
Current DOX logs show **toolset** warnings and **result contract** errors — tools *were* registered for engineering_loop, but results were rejected.
