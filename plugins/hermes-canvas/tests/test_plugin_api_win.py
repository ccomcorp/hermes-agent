import importlib.util
from pathlib import Path

PLUGIN = Path(__file__).parents[1] / "dashboard" / "plugin_api.py"

def _load():
    spec = importlib.util.spec_from_file_location("canvas_plugin_api", PLUGIN)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod

def test_terminate_uses_taskkill_on_windows(monkeypatch):
    mod = _load()
    calls = {}
    class FakeProc:
        pid = 4321
        def poll(self): return None
        def wait(self, timeout=None): return 0
    monkeypatch.setattr(mod.sys, "platform", "win32", raising=False)
    def fake_run(args, **kw):
        calls["args"] = args
        class R: returncode = 0
        return R()
    monkeypatch.setattr(mod.subprocess, "run", fake_run)
    mod._terminate_proc(FakeProc())
    assert calls["args"][0] == "taskkill" and "/T" in calls["args"] and "/F" in calls["args"]
    assert "4321" in calls["args"]
