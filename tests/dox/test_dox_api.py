from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

# web_server initializes a few module-level paths at import time. The canonical
# autouse HERMES_HOME fixture has not run during collection yet, and the test
# runner intentionally starts with a clean env, so seed a collection-safe home.
os.environ.setdefault("HERMES_HOME", str(Path(tempfile.gettempdir()) / "hermes-test-import-home"))

from hermes_cli import web_server

pytest.importorskip("starlette.testclient")
from starlette.testclient import TestClient


@pytest.fixture
def client():
    previous = getattr(web_server.app.state, "auth_required", None)
    web_server.app.state.auth_required = False
    test_client = TestClient(web_server.app)
    test_client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    try:
        yield test_client
    finally:
        if previous is None:
            try:
                delattr(web_server.app.state, "auth_required")
            except AttributeError:
                pass
        else:
            web_server.app.state.auth_required = previous


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_status_inactive_for_bare_directory(client, tmp_path):
    """A directory with no markers returns active:false."""
    body = client.get("/api/dox/status", params={"path": str(tmp_path)}).json()

    assert body["active"] is False
    assert body["mode"] is None
    assert body["layers"] == {"contract": False, "ledger": False, "publish": False}
    assert body["markers"] == {
        "docops_yml": False,
        "agents_md_header": False,
        "structural": [],
    }
    assert body["drift"] == []
    assert body["pending_advisories"] == 0
    assert body["last_publish"] is None


def test_status_active_with_docops_yml(client, tmp_path):
    """A project with docops.yml and mode:code reports active:true."""
    _write(tmp_path / "docops.yml", "version: 1\nmode: code\n")
    _write(tmp_path / "AGENTS.md", "# Project\n<!-- hermes-dox -->\n")
    _write(tmp_path / "dox" / "CHANGELOG.md", "# Changelog\n")

    body = client.get("/api/dox/status", params={"path": str(tmp_path)}).json()

    assert body["active"] is True
    assert body["mode"] == "code"
    assert body["layers"] == {"contract": True, "ledger": True, "publish": False}
    assert body["markers"]["docops_yml"] is True
    assert body["markers"]["agents_md_header"] is True
    assert body["markers"]["structural"] == ["dox/", "dox/CHANGELOG.md"]


def test_status_defaults_to_cwd(client):
    """Omitted path returns status for the current working directory (calls without error)."""
    body = client.get("/api/dox/status").json()

    # The server cwd is some project root — we just assert the shape is correct
    assert "active" in body
    assert "mode" in body
    assert "layers" in body
    assert "markers" in body
    assert "drift" in body
    assert "pending_advisories" in body
    assert "last_publish" in body
