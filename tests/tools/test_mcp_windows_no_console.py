"""Windows MCP stdio: no cmd.exe console flash for npx/codegraph shims."""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

from tools import mcp_tool


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only shim rewrite")
def test_windows_stdio_bypass_rewrites_npx_cmd_to_node(tmp_path: Path):
    node = tmp_path / "node.exe"
    node.write_bytes(b"MZ")
    npx_cmd = tmp_path / "npx.CMD"
    npx_cmd.write_text("@echo off\n", encoding="utf-8")
    npx_cli = tmp_path / "node_modules" / "npm" / "bin" / "npx-cli.js"
    npx_cli.parent.mkdir(parents=True)
    npx_cli.write_text("// npx", encoding="utf-8")

    cmd, args = mcp_tool._windows_stdio_bypass_cmd_shim(
        str(npx_cmd), ["-y", "@upstash/context7-mcp"]
    )
    assert Path(cmd) == node
    assert args[0] == str(npx_cli)
    assert args[1:] == ["-y", "@upstash/context7-mcp"]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only shim rewrite")
def test_windows_stdio_bypass_rewrites_codegraph_cmd_to_node(tmp_path: Path):
    node = tmp_path / "node.exe"
    node.write_bytes(b"MZ")
    cg = tmp_path / "codegraph.cmd"
    cg.write_text("@echo off\n", encoding="utf-8")
    shim = (
        tmp_path
        / "node_modules"
        / "@colbymchenry"
        / "codegraph"
        / "npm-shim.js"
    )
    shim.parent.mkdir(parents=True)
    shim.write_text("// codegraph", encoding="utf-8")

    cmd, args = mcp_tool._windows_stdio_bypass_cmd_shim(
        str(cg), ["serve", "--mcp"]
    )
    assert Path(cmd) == node
    assert args == [str(shim), "serve", "--mcp"]


def test_windows_stdio_bypass_noop_when_not_windows(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(mcp_tool.sys, "platform", "linux")
    cmd, args = mcp_tool._windows_stdio_bypass_cmd_shim(
        str(tmp_path / "npx.cmd"), ["-y", "pkg"]
    )
    assert cmd.endswith("npx.cmd")
    assert args == ["-y", "pkg"]


def test_windows_stdio_bypass_noop_without_sibling_node(tmp_path: Path, monkeypatch):
    if sys.platform != "win32":
        monkeypatch.setattr(mcp_tool.sys, "platform", "win32")
    npx_cmd = tmp_path / "npx.cmd"
    npx_cmd.write_text("@echo off\n", encoding="utf-8")
    # no node.exe beside it
    cmd, args = mcp_tool._windows_stdio_bypass_cmd_shim(str(npx_cmd), ["-y", "x"])
    assert Path(cmd) == npx_cmd
    assert args == ["-y", "x"]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only patch")
def test_ensure_mcp_windows_no_console_patch_replaces_create(monkeypatch):
    monkeypatch.setattr(mcp_tool, "_mcp_windows_no_console_patched", False)

    util_mod = types.ModuleType("mcp.os.win32.utilities")

    def _orig(*_a, **_k):
        raise AssertionError("original create should be replaced")

    util_mod.create_windows_process = _orig
    util_mod._create_job_object = lambda: None
    util_mod._create_windows_fallback_process = lambda *a, **k: "fallback"
    util_mod._maybe_assign_process_to_job = lambda *a, **k: None
    util_mod.win32api = None

    win32_mod = types.ModuleType("mcp.os.win32")
    win32_mod.utilities = util_mod
    os_mod = types.ModuleType("mcp.os")
    os_mod.win32 = win32_mod
    mcp_mod = types.ModuleType("mcp")
    mcp_mod.os = os_mod

    monkeypatch.setitem(sys.modules, "mcp", mcp_mod)
    monkeypatch.setitem(sys.modules, "mcp.os", os_mod)
    monkeypatch.setitem(sys.modules, "mcp.os.win32", win32_mod)
    monkeypatch.setitem(sys.modules, "mcp.os.win32.utilities", util_mod)

    mcp_tool._ensure_mcp_windows_no_console_patch()
    assert mcp_tool._mcp_windows_no_console_patched is True
    assert util_mod.create_windows_process.__name__ == "_create_windows_process_no_console"

    # second call is no-op (idempotent)
    first = util_mod.create_windows_process
    mcp_tool._ensure_mcp_windows_no_console_patch()
    assert util_mod.create_windows_process is first
