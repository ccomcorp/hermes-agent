"""Regression tests for the agent-init "Unknown toolsets" warning.

MCP servers attach during ``discover_mcp_tools`` under the canonical toolset
name ``mcp-<server>`` (tools/mcp_tool.py). The pre-discovery validation in
HermesCLI.__init__ must therefore accept both the bare server name and its
``mcp-``-prefixed form. Regression: a kanban worker spawned with the
platform_toolsets entry ``mcp-codegraph`` (matching the configured
``mcp_servers.codegraph``) printed ``Warning: Unknown toolsets: mcp-codegraph``.
"""

from cli import _unknown_toolsets_pre_discovery

MCP_SERVERS = {"codegraph", "qmd", "gbrain", "open-notebook", "neurolinked-brain"}


def test_mcp_prefixed_canonical_name_accepted():
    # The reported bug: canonical mcp-<server> form warned pre-discovery.
    assert _unknown_toolsets_pre_discovery(["mcp-codegraph"], MCP_SERVERS) == []


def test_all_configured_mcp_forms_accepted():
    toolsets = ["mcp-qmd", "mcp-gbrain", "mcp-open-notebook", "neurolinked-brain"]
    assert _unknown_toolsets_pre_discovery(toolsets, MCP_SERVERS) == []


def test_bare_server_name_still_accepted():
    assert _unknown_toolsets_pre_discovery(["codegraph"], MCP_SERVERS) == []


def test_builtin_toolset_accepted_via_validate_toolset():
    assert _unknown_toolsets_pre_discovery(["terminal", "web"], MCP_SERVERS) == []


def test_genuinely_unknown_names_still_flagged():
    assert _unknown_toolsets_pre_discovery(
        ["mcp-nosuchserver", "bogus", "mcp-"], MCP_SERVERS
    ) == ["mcp-nosuchserver", "bogus", "mcp-"]


def test_mcp_prefix_does_not_whitelist_unconfigured_servers():
    # mcp-<name> only validates when <name> is actually in mcp_servers.
    assert _unknown_toolsets_pre_discovery(["mcp-context7"], set()) == ["mcp-context7"]


def test_empty_and_none_inputs():
    assert _unknown_toolsets_pre_discovery([], MCP_SERVERS) == []
    assert _unknown_toolsets_pre_discovery(None, MCP_SERVERS) == []
