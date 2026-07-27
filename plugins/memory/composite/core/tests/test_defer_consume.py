"""#6 — opt-in defer-consume mode on the base CompositeMemoryProvider (M0-B1)."""

from plugins.memory.composite.core.tests.fake_store import FakeStore
from plugins.memory.composite.core import CompositeMemoryProvider


def _lesson(text):
    return {"lesson": text, "task_type": "workflow", "tags": ["t"],
            "provenance": "fork:test", "source": "auto"}


def test_default_mode_consumes_on_return():
    s = FakeStore(":memory:")
    s.append(_lesson("alpha lesson about caching"))
    c = CompositeMemoryProvider(s)
    c.initialize("s")
    ctx = c.prefetch("caching", session_id="s")
    assert "alpha lesson" in ctx.lower()
    assert s.circulation() == 1
    s.close()


def test_defer_mode_does_not_consume_until_confirm():
    s = FakeStore(":memory:")
    s.append(_lesson("beta lesson about locking"))
    c = CompositeMemoryProvider(s, consume_on_inject=True)
    c.initialize("s")
    ctx = c.prefetch("locking", session_id="s")
    assert "beta lesson" in ctx.lower()
    assert s.circulation() == 0
    assert c.confirm_prefetch_consumed("s") is True
    assert s.circulation() == 1
    assert c.confirm_prefetch_consumed("s") is False
    s.close()


def test_defer_mode_dropped_prefetch_never_counts():
    s = FakeStore(":memory:")
    s.append(_lesson("gamma lesson about threads"))
    c = CompositeMemoryProvider(s, consume_on_inject=True)
    c.initialize("s")
    c.prefetch("threads", session_id="s")
    assert s.circulation() == 0
    s.close()


def test_defer_mode_session_switch_and_end_clear_pending():
    s = FakeStore(":memory:")
    s.append(_lesson("delta lesson about queues"))
    c = CompositeMemoryProvider(s, consume_on_inject=True)
    c.initialize("s1")
    c.prefetch("queues", session_id="s1")
    c.on_session_switch("s2", parent_session_id="s1")
    assert c.confirm_prefetch_consumed("s1") is False
    c.prefetch("queues", session_id="s2")
    c.on_session_end([])
    assert c.confirm_prefetch_consumed("s2") is False
    assert s.circulation() == 0
    s.close()
