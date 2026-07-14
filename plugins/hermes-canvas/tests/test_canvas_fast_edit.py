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

def test_sync_requires_explicit_worktree_no_mtime_fallback(tmp_path, monkeypatch):
    mod = _load()
    # a stale worktree exists; a direct project edit must NOT be reverted when we
    # call sync with worktree_path=None (fallback must be a no-op now).
    proj = tmp_path / "proj"; (proj / ".worktrees" / "old" / "src").mkdir(parents=True)
    (proj / "src").mkdir(parents=True)
    (proj / ".worktrees" / "old" / "src" / "App.jsx").write_text("STALE", encoding="utf-8")
    (proj / "src" / "App.jsx").write_text("FRESH", encoding="utf-8")
    monkeypatch.setattr(mod, "_which", lambda c: None)  # skip git commit path
    mod._sync_worktree_changes(proj, None)  # None must be a no-op, not mtime-latest
    assert (proj / "src" / "App.jsx").read_text(encoding="utf-8") == "FRESH"

def test_prune_worktree_removes_dir(tmp_path):
    mod = _load()
    wt = tmp_path / ".worktrees" / "job1"; wt.mkdir(parents=True)
    (wt / "f.txt").write_text("x", encoding="utf-8")
    mod._prune_worktree(wt)
    assert not wt.exists()

def test_phase_running_editing():
    mod = _load()
    assert mod._compute_phase({"running": True, "applied": False}) == "editing"

def test_phase_running_applied():
    mod = _load()
    assert mod._compute_phase({"running": True, "applied": True}) == "applied"

def test_phase_done_ok():
    mod = _load()
    assert mod._compute_phase({"running": False, "applied": True, "exit_code": 0}) == "done_ok"

def test_phase_done_failed_nonzero():
    mod = _load()
    assert mod._compute_phase({"running": False, "applied": True, "exit_code": 1}) == "done_failed"

def test_phase_done_failed_when_never_applied():
    mod = _load()
    assert mod._compute_phase({"running": False, "applied": False, "exit_code": 0}) == "done_failed"

def test_detect_auth_error_false_on_stackframe():
    mod = _load()
    assert mod._detect_auth_error(["    at webpack://app/bundle.js:401:15"]) is False
    # existing positive still holds via "http 401" + credentials phrase
    assert mod._detect_auth_error(["HTTP 401: No valid authentication credentials provided"]) is True

def test_sync_returns_change_flag(tmp_path, monkeypatch):
    mod = _load()
    proj = tmp_path / "proj"
    (proj / ".worktrees" / "w1" / "src").mkdir(parents=True)
    (proj / "src").mkdir(parents=True)
    (proj / ".worktrees" / "w1" / "src" / "App.jsx").write_text("EDITED", encoding="utf-8")
    monkeypatch.setattr(mod, "_which", lambda c: "git")  # truthy so the commit path runs
    monkeypatch.setattr(mod, "_commit_if_changed", lambda p: True)
    assert mod._sync_worktree_changes(proj, proj / ".worktrees" / "w1") is True
    monkeypatch.setattr(mod, "_commit_if_changed", lambda p: False)
    assert mod._sync_worktree_changes(proj, proj / ".worktrees" / "w1") is False
    assert mod._sync_worktree_changes(proj, None) is False

# --- loose-ends coverage (fix/canvas-loose-ends) ---

def test_list_source_files_excludes_skip_dirs(tmp_path):
    # A source file buried in an excluded dir (node_modules) must NOT be listed,
    # so the unique-text resolver can't accidentally target a dependency file.
    mod = _load()
    proj = _mkproject(tmp_path, {
        "src/App.jsx": "export default () => <p>real source</p>",
        "node_modules/pkg/index.jsx": "export default () => <p>real source</p>",
        "dist/bundle.js": "console.log('built')",
    })
    names = {str(p.relative_to(proj)).replace("\\", "/") for p in mod._list_source_files(proj)}
    assert "src/App.jsx" in names
    assert "node_modules/pkg/index.jsx" not in names
    assert "dist/bundle.js" not in names

def test_resolve_via_attr_when_no_text_trusts_attr(tmp_path):
    # No text to verify against -> the hermes_file attr is the only signal and is
    # trusted without a content read (the _contains no-text short-circuit).
    mod = _load()
    proj = _mkproject(tmp_path, SRC_EXTS_FIXTURE)
    el = {"text": "", "hermesAttributes": {"file": "index.html"}}
    r = mod._resolve_target_file(proj, el)
    assert r is not None and r["rel_path"] == "index.html" and r["source"] == "hermes_file"

def test_build_edit_prompt_marks_unreadable_file(tmp_path):
    # If the resolved path can't be read, the prompt must surface an honest marker
    # instead of an empty body (a directory read raises -> exercises the except path).
    mod = _load()
    unreadable = tmp_path / "adir"
    unreadable.mkdir()
    resolved = {"rel_path": "adir", "abs_path": str(unreadable), "source": "hermes_file"}
    p = mod._build_edit_prompt("edit it", resolved, {"text": "x"}, [])
    assert "could not be read" in p
    assert "PATH: adir" in p
