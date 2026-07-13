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

# An ai-agent workflow node's child is a REASONING/generation agent only. Every
# side-effecting toolset is stripped so the child cannot egress/write/shell (R1).
AI_NODE_BLOCKED_TOOLSETS = (
    "web", "file", "terminal", "code_execution", "browser", "computer_use", "mcp",
)


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
    text = fn(prompt=prompt, agent=agent, blocked_toolsets=list(AI_NODE_BLOCKED_TOOLSETS), run_ctx=ctx)
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
# (thin; exact signatures verified during live integration — see spec 13 Risk 1)

def _default_delegate(*, prompt: str, agent: Any, blocked_toolsets: list, run_ctx: RunContext) -> str:
    from tools.delegate_tool import delegate_task  # lazy import
    # delegate_task honors DELEGATE_BLOCKED_TOOLS + parent-toolset intersection; the
    # restricted set keeps the child from calling web/file/terminal (R1 by restriction).
    return delegate_task(task=prompt, parent_agent=agent, blocked_toolsets=list(blocked_toolsets))


def _default_fetch(*, url: str, method: str, headers: Any, body: Any) -> dict:
    from tools.web_tools import web_extract  # lazy import
    return {"url": url, "content": web_extract(urls=[url])}


def _default_exec(*, code: str, run_ctx: RunContext) -> dict:
    from tools.code_execution_tool import execute_code  # lazy import
    return {"result": execute_code(code)}
