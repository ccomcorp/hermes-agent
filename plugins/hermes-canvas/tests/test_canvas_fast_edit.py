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

SRC_EXTS_FIXTURE = {
    "index.html": '<h1 data-hermes-file="index.html">Welcome Home</h1>',
    "src/App.jsx": 'export default () => <p>A unique paragraph here</p>',
    "src/Other.jsx": 'export default () => <p>duplicate text</p>',
    "src/Dupe.jsx": 'export default () => <p>duplicate text</p>',
}

def _mkproject(tmp_path, files):
    for rel, content in files.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    return tmp_path

def test_resolve_via_hermes_file_attr(tmp_path):
    mod = _load()
    proj = _mkproject(tmp_path, SRC_EXTS_FIXTURE)
    el = {"text": "Welcome Home", "hermesAttributes": {"file": "index.html"}}
    r = mod._resolve_target_file(proj, el)
    assert r is not None and r["rel_path"] == "index.html" and r["source"] == "hermes_file"

def test_resolve_via_unique_text(tmp_path):
    mod = _load()
    proj = _mkproject(tmp_path, SRC_EXTS_FIXTURE)
    el = {"text": "A unique paragraph here", "hermesAttributes": {}}
    r = mod._resolve_target_file(proj, el)
    assert r is not None and r["rel_path"].replace("\\", "/") == "src/App.jsx" and r["source"] == "unique_text"

def test_resolve_ambiguous_text_returns_none(tmp_path):
    mod = _load()
    proj = _mkproject(tmp_path, SRC_EXTS_FIXTURE)
    el = {"text": "duplicate text", "hermesAttributes": {}}
    assert mod._resolve_target_file(proj, el) is None

def test_resolve_wrong_file_guard(tmp_path):
    # attr points at a file that does NOT contain the element text -> reject
    mod = _load()
    proj = _mkproject(tmp_path, SRC_EXTS_FIXTURE)
    el = {"text": "text that appears nowhere", "hermesAttributes": {"file": "index.html"}}
    assert mod._resolve_target_file(proj, el) is None

def test_resolve_rejects_traversal(tmp_path):
    mod = _load()
    proj = _mkproject(tmp_path, SRC_EXTS_FIXTURE)
    el = {"text": "x", "hermesAttributes": {"file": "../../etc/passwd"}}
    assert mod._resolve_target_file(proj, el) is None

def test_list_source_files_rescans_new_file(tmp_path):
    mod = _load()
    proj = _mkproject(tmp_path, SRC_EXTS_FIXTURE)
    before = {p.name for p in mod._list_source_files(proj)}
    (proj / "src" / "New.tsx").write_text("<span>brand new</span>", encoding="utf-8")
    after = {p.name for p in mod._list_source_files(proj)}
    assert "New.tsx" in after and "New.tsx" not in before

def test_resolve_none_when_no_element(tmp_path):
    mod = _load()
    proj = _mkproject(tmp_path, SRC_EXTS_FIXTURE)
    assert mod._resolve_target_file(proj, None) is None

def test_build_edit_prompt_direct_when_resolved(tmp_path):
    mod = _load()
    resolved = {"rel_path": "index.html", "abs_path": str(tmp_path / "index.html"), "source": "hermes_file"}
    (tmp_path / "index.html").write_text("<h1>Hi</h1>", encoding="utf-8")
    p = mod._build_edit_prompt("make it Hello", resolved, {"text": "Hi"}, [])
    assert "index.html" in p                 # resolved file path named
    assert "Edit THIS file" in p             # direct-edit framing
    assert "check the files first" not in p.lower()  # exploration directive dropped
    assert "make it Hello" in p              # user request injected
    assert "<h1>Hi</h1>" in p                # resolved file contents injected
    assert "check the files first" not in p.lower()
    assert "Edit THIS file" in p

def test_build_edit_prompt_hint_when_unresolved():
    mod = _load()
    p = mod._build_edit_prompt("do X", None, None, ["a.jsx", "b.css"])
    assert "a.jsx" in p and "b.css" in p
    assert "Edit THIS file" not in p
