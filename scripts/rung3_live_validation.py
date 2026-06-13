#!/usr/bin/env python3
"""Rung-3 headless validation: config-activated composite end-to-end through the REAL chassis.

Proves, WITHOUT a live LLM turn (deterministic, no API cost, isolated store):
  1. the ACTIVE config has memory.provider: composite (the flip);
  2. the REAL plugin loader + MemoryManager + initialize_all path (exactly what agent_init does)
     activates the composite over an ON-DISK store;
  3. a fork-authored lesson written via the REAL fork path (record_fork_authored_lessons) is
     RECALLED via the real prefetch_all and CONSUMED via the real conversation_loop seam
     (inject_turn_context) in a later session -> circulation > 0 (AC1 live);
  4. the assemble-but-drop case does NOT consume (AC1 not gameable).

What it does NOT cover: a real model-driven turn (the assistant text). That is the only
remaining manual step (see the run-book) — the memory loop itself is fully real here.

Uses a TEMP HERMES_HOME so the live store is untouched. Run: python scripts/rung3_live_validation.py
Exit 0 = AC1 PASS.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# Isolated store BEFORE importing any hermes module that reads HERMES_HOME.
_TMP_HOME = tempfile.mkdtemp(prefix="rung3-validation-")
os.environ["HERMES_HOME"] = _TMP_HOME

_REPO = Path(__file__).resolve().parents[1]
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))


def _active_config_provider() -> str:
    """Read memory.provider straight from the ACTIVE config file (proves the flip,
    independent of the temp HERMES_HOME used for the isolated store)."""
    import yaml
    from hermes_constants import get_hermes_home  # noqa: F401 (import sanity)

    # The real home is LOCALAPPDATA/hermes on Windows; read its config.yaml directly.
    home = Path(os.environ.get("LOCALAPPDATA", "")) / "hermes"
    cfg = home / "config.yaml"
    if not cfg.exists():
        return "<active config.yaml not found at %s>" % cfg
    with open(cfg, encoding="utf-8-sig") as fh:
        data = yaml.safe_load(fh) or {}
    return ((data.get("memory") or {}).get("provider")) or "<unset>"


def _review_messages():
    import json
    args = {"action": "add", "target": "user",
            "content": "When deploying the zarquon service, drain the wibble queue before restart."}
    return [
        {"role": "assistant", "tool_calls": [
            {"id": "c1", "function": {"name": "memory", "arguments": json.dumps(args)}}]},
        {"role": "tool", "tool_call_id": "c1",
         "content": json.dumps({"success": True, "message": "Entry added", "target": "user"})},
    ]


class _Agent:
    def __init__(self, manager, session_id):
        self._memory_manager = manager
        self.session_id = session_id


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    from plugins.memory import load_memory_provider
    from agent.memory_manager import MemoryManager
    from agent.background_review import record_fork_authored_lessons
    from agent.conversation_loop import inject_turn_context

    print("=== Rung-3 headless validation (config-activated composite, real chassis) ===")
    print(f"isolated HERMES_HOME: {_TMP_HOME}")

    # 1. the flip
    provider_name = _active_config_provider()
    print(f"[1] active config memory.provider = {provider_name!r}")
    if provider_name != "composite":
        print("    FAIL: config is not flipped to composite.")
        return 1

    # 2. real loader + manager + init (mirrors agent_init.py:1136-1187)
    prov = load_memory_provider(provider_name)
    if prov is None or not prov.is_available():
        print("    FAIL: load_memory_provider('composite') returned unavailable.")
        return 1
    mgr = MemoryManager()
    mgr.add_provider(prov)
    mgr.initialize_all(session_id="rung3-A", agent_context="primary", platform="cli")
    print(f"[2] provider loaded + initialized: name={prov.name!r}, "
          f"tools={sorted(mgr.get_all_tool_names())}")
    db = os.path.join(_TMP_HOME, "experience.db")
    print(f"    on-disk store created: {os.path.exists(db)}")

    # 3a. session A: author a fork lesson via the REAL fork path
    agent_a = _Agent(mgr, "rung3-A")
    written = record_fork_authored_lessons(agent_a, _review_messages(), [])
    store = prov._store
    print(f"[3a] fork authored {written} lesson(s); circulation now = {store.circulation()} "
          f"(authored, not yet recalled)")

    # 3b. session B (NEW): real prefetch -> real inject_turn_context -> confirm
    mgr.on_session_switch("rung3-B", parent_session_id="rung3-A")
    agent_b = _Agent(mgr, "rung3-B")
    ext = mgr.prefetch_all("zarquon deploy drain wibble queue", session_id="rung3-B")
    print(f"[3b] prefetch hit: {bool(ext)}; circulation before inject = {store.circulation()}")
    api_msg = {"role": "user", "content": "how do I deploy the zarquon service?"}
    injected = inject_turn_context(api_msg, ext, "", agent_b)
    circ = store.circulation()
    print(f"     injected={injected}; circulation after inject+confirm = {circ}")

    # 4. assemble-but-drop control: prefetch, but content is non-str -> never injected/consumed
    mgr.on_session_switch("rung3-C", parent_session_id="rung3-B")
    agent_c = _Agent(mgr, "rung3-C")
    ext2 = mgr.prefetch_all("zarquon deploy drain wibble queue", session_id="rung3-C")
    dropped_msg = {"role": "user", "content": [{"type": "text", "text": "x"}]}
    inj2 = inject_turn_context(dropped_msg, ext2, "", agent_c)
    circ2 = store.circulation()
    print(f"[4] drop-control: injected={inj2}; circulation unchanged = {circ2 == circ}")

    # verdict
    ok = (written >= 1 and bool(ext) and injected and circ >= 1 and inj2 is False and circ2 == circ)
    try:
        mgr.shutdown_all()
    except Exception:
        pass
    print()
    if ok:
        print("AC1 LIVE PASS: config-activated composite recalled a fork-authored lesson into a "
              "consumed context through the real chassis; the dropped recall did not count.")
        return 0
    print("AC1 LIVE FAIL: see the steps above.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
