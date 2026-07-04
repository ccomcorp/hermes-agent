import importlib.util
from pathlib import Path

import pytest

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


def test_validate_path_scoped_to_projects_root(monkeypatch, tmp_path):
    mod = _load()
    root = tmp_path / "canvas-projects"; root.mkdir()
    monkeypatch.setenv("HERMES_CANVAS_PROJECTS_ROOT", str(root))
    inside = root / "p1"; inside.mkdir()
    assert mod._validate_path(str(inside)) == inside.resolve()
    with pytest.raises(Exception):
        mod._validate_path(str(tmp_path / "outside"))


def test_resolve_hermes_bin_prefers_env_override(monkeypatch, tmp_path):
    mod = _load()
    fake = tmp_path / "hermes-real.exe"; fake.write_text("")
    monkeypatch.setenv("HERMES_CANVAS_HERMES_BIN", str(fake))
    assert mod._resolve_hermes_bin() == str(fake)

def test_resolve_hermes_bin_uses_interpreter_adjacent(monkeypatch, tmp_path):
    mod = _load()
    monkeypatch.delenv("HERMES_CANVAS_HERMES_BIN", raising=False)
    scripts = tmp_path / "Scripts"; scripts.mkdir()
    (scripts / "hermes-real.exe").write_text("")
    monkeypatch.setattr(mod.sys, "executable", str(scripts / "python.exe"))
    assert mod._resolve_hermes_bin() == str(scripts / "hermes-real.exe")


def test_projects_dir_matches_validate_root(monkeypatch, tmp_path):
    mod = _load()
    root = tmp_path / "cr"; monkeypatch.setenv("HERMES_CANVAS_PROJECTS_ROOT", str(root))
    # default projects dir must live under the same root _validate_path enforces
    pd = mod._projects_dir()
    assert pd == root.resolve() or pd.is_relative_to(root.resolve())
