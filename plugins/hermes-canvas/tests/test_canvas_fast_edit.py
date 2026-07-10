import importlib.util
from pathlib import Path

PLUGIN = Path(__file__).parents[1] / "dashboard" / "plugin_api.py"

def _load():
    spec = importlib.util.spec_from_file_location("canvas_plugin_api", PLUGIN)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod

def test_detect_auth_error_true_on_401_signature():
    mod = _load()
    lines = ["some log", "HTTP 401: No valid authentication credentials provided"]
    assert mod._detect_auth_error(lines) is True

def test_detect_auth_error_true_on_authentication_failed():
    mod = _load()
    assert mod._detect_auth_error(["Anthropic 401 - authentication failed."]) is True

def test_detect_auth_error_false_on_millis_1401():
    mod = _load()
    assert mod._detect_auth_error(["request took 1401ms", "ok"]) is False

def test_detect_auth_error_false_on_empty():
    mod = _load()
    assert mod._detect_auth_error([]) is False
