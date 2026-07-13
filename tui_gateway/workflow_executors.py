"""WF3 — side-effecting node executors (spec 13).

**R1 closure via RESTRICTION, not per-call gating.** The `ai-agent` node delegates
to a child agent with web/file/terminal/code toolsets STRIPPED, so the child
physically cannot bypass the guard (the elicitation found no per-tool interception
seam in `delegate_task`; restricting the child's toolset is the sound alternative).
Raw egress/write/shell are SEPARATE gated nodes (`http-request`/`code`), each
policy-checked at `guard.dispatch` (http_allowlist / allow_code_node) before its
executor runs.

Backends are injectable (``delegate_fn`` / ``fetch_fn`` / ``exec_fn``) so the
executors are unit-testable without a live agent/provider. The default adapters
lazily wire to the real chassis; their exact signatures are verified during live
integration (marked below).
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from tui_gateway.workflow_guard import RunContext, WorkflowGuard

# An ai-agent workflow node's child is a REASONING/generation agent only. The
# chassis restricts a child by ALLOWLIST (delegate_task intersects the requested
# per-task ``toolsets`` with the parent's — tools/delegate_tool.py:1121), so R1 is
# closed by naming the ONLY toolset the child may have: ``safe``, a registered
# toolset whose tool list is empty (verified: TOOLSETS["safe"] == []). The child
# therefore gets zero tools — it can reason, but cannot egress/write/shell/run code
# — whether or not the parent carries ``safe`` (the intersection is empty either
# way). This is the live-verified equivalent of "strip every side-effecting toolset".
AI_NODE_ALLOWED_TOOLSETS = ("safe",)


class ExecutorError(Exception):
    """A node executor received invalid config."""


# --------------------------------------------------------------------------- executors

def ai_agent_executor(node: dict, ctx: RunContext, *, delegate_fn: Optional[Callable] = None) -> dict:
    cfg = node.get("config") or {}
    prompt = str(cfg.get("prompt", "")).strip()
    if not prompt:
        raise ExecutorError("ai-agent node requires a 'prompt'")
    # An agent is needed to delegate from. Manual origin can borrow the session's;
    # cron/webhook/hook has none, so the engine must supply headless_agent — else
    # fail CLOSED (never crash on a missing parent agent) (F5).
    agent = ctx.headless_agent
    if agent is None and ctx.origin != "manual":
        return {"__denied__": True,
                "reason": f"ai-agent node has no agent for non-interactive origin '{ctx.origin}'"}
    fn = delegate_fn or _default_delegate
    text = fn(prompt=prompt, agent=agent, allowed_toolsets=list(AI_NODE_ALLOWED_TOOLSETS), run_ctx=ctx)
    return {"text": text}


def http_executor(node: dict, ctx: RunContext, *, fetch_fn: Optional[Callable] = None) -> dict:
    # Already policy-gated at dispatch (guard checks the URL host vs http_allowlist).
    cfg = node.get("config") or {}
    url = str(cfg.get("url", ""))
    if not url:
        raise ExecutorError("http-request node requires a 'url'")
    fn = fetch_fn or _default_fetch
    return fn(url=url, method=str(cfg.get("method", "GET")).upper(),
              headers=cfg.get("headers"), body=cfg.get("body"))


def code_executor(node: dict, ctx: RunContext, *, exec_fn: Optional[Callable] = None) -> dict:
    # Already gated at dispatch (allow_code_node); executor sandboxes.
    cfg = node.get("config") or {}
    code = str(cfg.get("code", ""))
    if not code:
        raise ExecutorError("code node requires 'code'")
    fn = exec_fn or _default_exec
    return fn(code=code, run_ctx=ctx)


def register_executors(
    guard: WorkflowGuard, *,
    delegate_fn: Optional[Callable] = None,
    fetch_fn: Optional[Callable] = None,
    exec_fn: Optional[Callable] = None,
) -> None:
    guard.register("ai-agent", lambda n, c: ai_agent_executor(n, c, delegate_fn=delegate_fn))
    guard.register("http-request", lambda n, c: http_executor(n, c, fetch_fn=fetch_fn))
    guard.register("code", lambda n, c: code_executor(n, c, exec_fn=exec_fn))


# --------------------------------------------------------------------------- default chassis adapters
# Signatures verified live against the merged chassis (2026-07-13):
#   delegate_task(goal, context, tasks, max_iterations, role, background, parent_agent)
#     -> toolset control is per-task ONLY (single-mode `goal` omits toolsets at
#        delegate_tool.py:2515), so the batch `tasks=[{...}]` form is required.
#   web_extract_tool(urls: List, format=None, char_limit=None) -> ASYNC, returns str.
#   execute_code(code: str, task_id=None, enabled_tools=None) -> str (sync).
# The signature-lock test in tests/tui_gateway/test_workflow_executors.py fails if
# any of these drift.

def _default_delegate(*, prompt: str, agent: Any, allowed_toolsets: list, run_ctx: RunContext) -> str:
    from tools.delegate_tool import delegate_task  # lazy import
    # Restrict the child by ALLOWLIST (the chassis intersects per-task `toolsets`
    # with the parent). `allowed_toolsets` = ("safe",) => an empty toolset => the
    # child has NO tools and cannot bypass the guard (R1). `role="leaf"` also blocks
    # recursive delegation. delegate_task returns a JSON string (results array).
    return delegate_task(
        tasks=[{"goal": prompt, "toolsets": list(allowed_toolsets), "role": "leaf"}],
        parent_agent=agent,
    )


def _default_fetch(*, url: str, method: str, headers: Any, body: Any) -> dict:
    import asyncio

    from tools.web_tools import web_extract_tool  # lazy import (async)
    # web_extract_tool is a coroutine; run it on a fresh loop from this sync
    # executor. If ever called from within a running loop, fall back to a thread.
    coro = web_extract_tool(urls=[url])
    try:
        content = asyncio.run(coro)
    except RuntimeError:  # already inside an event loop
        import concurrent.futures

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            content = pool.submit(lambda: asyncio.run(web_extract_tool(urls=[url]))).result()
    return {"url": url, "content": content}


def _default_exec(*, code: str, run_ctx: RunContext) -> dict:
    from tools.code_execution_tool import execute_code  # lazy import
    return {"result": execute_code(code)}
