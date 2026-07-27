"""Construction-path test: every scheduler-created AIAgent is wired to
lifecycle context ``cron`` while retaining ``skip_memory=True`` and the
existing provider/model/toolset resolution.

This captures the real kwargs passed to ``AIAgent(...)`` inside
``cron.scheduler.run_job`` — not a mock of the constructor's signature, but
the actual call site.  It proves three invariants that the M0-3c card
requires:

1. ``agent_context="cron"`` is present (the lifecycle-context fence).
2. ``skip_memory=True`` is present (ordinary user-memory writes suppressed).
3. Existing provider/model wiring is unchanged: the ``model``, ``provider``,
   ``api_key``, ``base_url``, and ``api_mode`` kwargs flow through from the
   runtime resolution exactly as before.

The test does NOT run the agent loop: ``AIAgent`` is replaced with a fake
whose ``run_conversation`` returns a valid result dict immediately, so
``run_job`` completes its post-construction path and returns normally.
"""
from unittest.mock import patch, MagicMock

import pytest


# ── Helpers ────────────────────────────────────────────────────────────────────

class _FakeAgent:
    """Stand-in for AIAgent that records its construction kwargs and returns
    a valid result from run_conversation so run_job's post-construction
    path completes without actually calling a model."""

    constructed_kwargs = None

    def __init__(self, **kwargs):
        _FakeAgent.constructed_kwargs = kwargs

    def run_conversation(self, prompt, **kw):
        return {
            "final_response": "[SILENT]",
            "messages": [],
            "failed": False,
            "completed": True,
            "turn_exit_reason": "",
        }

    def get_activity_summary(self):
        return {"seconds_since_activity": 0.0}

    def interrupt(self, reason=""):
        pass

    def close(self):
        pass

    @staticmethod
    def _format_turn_completion_explanation(reason):
        return ""


def _make_minimal_job():
    """A job dict that reaches the LLM path (not no_agent, not wake-gated)."""
    return {
        "id": "test-agent-context",
        "name": "test-agent-context",
        "prompt": "test prompt",
        "model": "test-model-123",
        "provider": "test-provider",
        "schedule": "30m",
    }


@pytest.fixture
def _captured(monkeypatch):
    """Patch the heavy dependencies so run_job reaches the AIAgent
    construction site and returns immediately."""
    # Reset the capture before each test.
    _FakeAgent.constructed_kwargs = None

    # Patch AIAgent at its source so the local import inside run_job picks
    # up the fake.
    monkeypatch.setattr("run_agent.AIAgent", _FakeAgent)

    # Bypass prompt injection scanner + skill loading.
    monkeypatch.setattr(
        "cron.scheduler._build_job_prompt",
        lambda job, prerun_script=None: "test prompt body",
    )

    # Bypass delivery-target resolution (no gateway adapters in a test).
    monkeypatch.setattr(
        "cron.scheduler._resolve_delivery_target", lambda job: None
    )

    # Bypass origin resolution.
    monkeypatch.setattr("cron.scheduler._resolve_origin", lambda job: None)

    # Bypass .env reload + secret-source cache reset.
    monkeypatch.setattr(
        "hermes_cli.env_loader.load_hermes_dotenv", lambda **kw: None
    )
    monkeypatch.setattr(
        "hermes_cli.env_loader.reset_secret_source_cache", lambda: None
    )

    # Bypass managed-scope overlay (fail-open no-op).
    monkeypatch.setattr(
        "hermes_cli.managed_scope.apply_managed_overlay", lambda cfg: cfg
    )

    # Bypass MCP discovery (no MCP servers in a test).
    monkeypatch.setattr(
        "tools.mcp_tool.discover_mcp_tools", lambda: []
    )

    # Bypass credential-pool loading.
    monkeypatch.setattr(
        "agent.credential_pool.load_pool",
        lambda provider: MagicMock(has_credentials=lambda: False, entries=lambda: []),
    )

    # Provide a fake runtime resolution so the provider/model/api_key/base_url
    # wiring is exercised without touching real credentials.
    _fake_runtime = {
        "provider": "test-provider",
        "api_key": "fake-key",
        "base_url": "https://fake.example.com/v1",
        "api_mode": "chat_completions",
        "requested_provider": "test-provider",
        "command": None,
        "args": None,
    }
    monkeypatch.setattr(
        "hermes_cli.runtime_provider.resolve_runtime_provider",
        lambda **kw: _fake_runtime,
    )

    # Bypass SessionDB construction (returns a no-op mock).
    _fake_session_db = MagicMock()
    _fake_session_db.set_session_title = MagicMock()
    monkeypatch.setattr("hermes_state.SessionDB", lambda: _fake_session_db)

    # Bypass mark_job_run / save_job_output / advance_next_run so we don't
    # touch the real cron job store.
    monkeypatch.setattr("cron.scheduler.mark_job_run", lambda *a, **kw: None)
    monkeypatch.setattr("cron.scheduler.save_job_output", lambda *a, **kw: None)
    monkeypatch.setattr("cron.scheduler.advance_next_run", lambda *a, **kw: None)

    # Bypass execution-record helpers.
    monkeypatch.setattr("cron.scheduler.create_execution", lambda *a, **kw: None)
    monkeypatch.setattr("cron.scheduler.mark_execution_running", lambda *a, **kw: None)
    monkeypatch.setattr("cron.scheduler.finish_execution", lambda *a, **kw: None)

    # Bypass the credential-exfil guard.
    monkeypatch.setattr("cron.scheduler._guard_job_credential_exfil", lambda job: None)

    return _FakeAgent


# ── Tests ──────────────────────────────────────────────────────────────────────

def test_cron_agent_constructed_with_agent_context_cron(_captured):
    """The AIAgent constructed inside run_job receives agent_context='cron'."""
    import cron.scheduler as sched

    job = _make_minimal_job()
    sched.run_job(job)

    kw = _captured.constructed_kwargs
    assert kw is not None, "AIAgent was never constructed — run_job did not reach the LLM path"
    assert kw.get("agent_context") == "cron"


def test_cron_agent_retains_skip_memory_true(_captured):
    """skip_memory=True is preserved (ordinary user-memory writes suppressed)."""
    import cron.scheduler as sched

    job = _make_minimal_job()
    sched.run_job(job)

    kw = _captured.constructed_kwargs
    assert kw is not None, "AIAgent was never constructed"
    assert kw.get("skip_memory") is True


def test_cron_agent_provider_model_wiring_unchanged(_captured):
    """Existing provider/model wiring flows through unchanged: the runtime-
    resolved provider, api_key, base_url, and api_mode reach AIAgent kwargs
    exactly as they did before agent_context was added."""
    import cron.scheduler as sched

    job = _make_minimal_job()
    sched.run_job(job)

    kw = _captured.constructed_kwargs
    assert kw is not None, "AIAgent was never constructed"

    # model flows from job['model'] (or config/env) — we set it on the job.
    assert kw.get("model") == "test-model-123"
    # provider/api_key/base_url/api_mode flow from resolve_runtime_provider.
    assert kw.get("provider") == "test-provider"
    assert kw.get("api_key") == "fake-key"
    assert kw.get("base_url") == "https://fake.example.com/v1"
    assert kw.get("api_mode") == "chat_completions"


def test_cron_agent_platform_is_cron(_captured):
    """The platform kwarg is 'cron' — the agent knows its execution context."""
    import cron.scheduler as sched

    job = _make_minimal_job()
    sched.run_job(job)

    kw = _captured.constructed_kwargs
    assert kw is not None, "AIAgent was never constructed"
    assert kw.get("platform") == "cron"
