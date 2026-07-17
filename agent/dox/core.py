from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from hermes_constants import get_hermes_home
from agent.dox.advisory import pending_advisory_count

_SCHEMA_VERSION = 1
_MODES = {"code", "ops", "hybrid"}
_DEFAULT_LAYERS: dict[str | None, dict[str, bool]] = {
    None: {"contract": False, "ledger": False, "publish": False},
    "code": {"contract": True, "ledger": True, "publish": False},
    "ops": {"contract": True, "ledger": True, "publish": True},
    "hybrid": {"contract": True, "ledger": True, "publish": True},
}
_STRUCTURAL_SIGNALS = (
    ("dox/", lambda root: (root / "dox").is_dir()),
    ("dox/CHANGELOG.md", lambda root: (root / "dox" / "CHANGELOG.md").is_file()),
    ("dox/adr/", lambda root: (root / "dox" / "adr").is_dir()),
    ("reports/", lambda root: (root / "reports").is_dir()),
    ("LIVE-STATUS.md", lambda root: (root / "LIVE-STATUS.md").is_file()),
    (
        "docs/standards/DOCUMENT-MANAGEMENT.md",
        lambda root: (root / "docs" / "standards" / "DOCUMENT-MANAGEMENT.md").is_file(),
    ),
)
_OPS_SIGNALS = {
    "reports/",
    "LIVE-STATUS.md",
    "docs/standards/DOCUMENT-MANAGEMENT.md",
}
_CODE_SIGNALS = {"dox/", "dox/CHANGELOG.md", "dox/adr/"}
_HEADER_RE = re.compile(r"(?:<!--\s*hermes-dox\s*-->|\bHermes\s+DOX\b|\bDOX\s*:\s*enabled\b)", re.I)
_INDEX_START_RE = re.compile(r"<!--\s*hermes-dox:index-start(?:\s+glob=\"(?P<glob>[^\"]+)\")?\s*-->")
_INDEX_END_RE = re.compile(r"<!--\s*hermes-dox:index-end\s*-->")
_OVERSIZE_RE = re.compile(r"<!--\s*dox-allow-oversize\s*:\s*(?P<reason>[^>]+?)\s*-->", re.I)


class DoxError(Exception):
    """Fail-loud DOX error for malformed markers or I/O failures."""

    def __init__(self, message: str, *, exit_code: int = 3) -> None:
        super().__init__(message)
        self.exit_code = exit_code


@dataclass(frozen=True)
class DoxFinding:
    tier: str
    path: str
    kind: str
    message: str = ""
    escaped: bool = False

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {"tier": self.tier, "path": self.path, "kind": self.kind}
        if self.escaped:
            data["escaped"] = True
        if self.message:
            data["message"] = self.message
        return data


@dataclass(frozen=True)
class DoxReport:
    status: dict[str, Any]
    findings: list[DoxFinding]
    exit_code: int

    def to_dict(self) -> dict[str, Any]:
        payload = dict(self.status)
        payload["drift"] = [finding.to_dict() for finding in self.findings]
        payload["exit_code"] = self.exit_code
        return payload


def _root(path: str | Path) -> Path:
    return Path(path).expanduser().resolve()


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise DoxError(f"{path}: expected UTF-8 text") from exc
    except OSError as exc:
        raise DoxError(f"{path}: {exc}") from exc


def _write_if_changed(path: Path, text: str) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    old = path.read_text(encoding="utf-8") if path.exists() else None
    if old == text:
        return False
    path.write_text(text, encoding="utf-8", newline="\n")
    return True


def _load_docops(root: Path) -> dict[str, Any]:
    path = root / "docops.yml"
    if not path.exists():
        return {}
    try:
        loaded = yaml.load(_read_text(path), Loader=getattr(yaml, "CSafeLoader", None) or yaml.SafeLoader)
    except yaml.YAMLError as exc:
        raise DoxError(f"docops.yml: malformed YAML: {exc}") from exc
    if loaded is None:
        return {}
    if not isinstance(loaded, dict):
        raise DoxError("docops.yml: top-level value must be a mapping")
    version = loaded.get("version", _SCHEMA_VERSION)
    if version != _SCHEMA_VERSION:
        raise DoxError(f"docops.yml: unsupported version {version!r}")
    mode = loaded.get("mode")
    if mode is not None and mode not in _MODES:
        raise DoxError(f"docops.yml: mode must be one of {sorted(_MODES)}")
    return loaded


def _has_agents_header(root: Path) -> bool:
    agents = root / "AGENTS.md"
    if not agents.exists():
        return False
    head = "\n".join(_read_text(agents).splitlines()[:25])
    return bool(_HEADER_RE.search(head))


def _structural_markers(root: Path) -> list[str]:
    return [name for name, predicate in _STRUCTURAL_SIGNALS if predicate(root)]


def _infer_mode(*, explicit: str | None, docops: bool, agents_header: bool, structural: list[str]) -> str | None:
    if explicit:
        return explicit
    if not (docops or agents_header or structural):
        return None
    has_ops = any(signal in _OPS_SIGNALS for signal in structural)
    has_code = agents_header or any(signal in _CODE_SIGNALS for signal in structural)
    if has_ops and has_code:
        return "hybrid"
    if has_ops:
        return "ops"
    return "code"


def _layers_for(mode: str | None, config: dict[str, Any]) -> dict[str, bool]:
    layers = dict(_DEFAULT_LAYERS[mode])
    configured = config.get("layers")
    if isinstance(configured, dict):
        for key in ("contract", "ledger", "publish"):
            if key in configured:
                layers[key] = bool(configured[key])
    return layers


def _settings(config: dict[str, Any]) -> dict[str, Any]:
    contract = config.get("contract") if isinstance(config.get("contract"), dict) else {}
    ledger = config.get("ledger") if isinstance(config.get("ledger"), dict) else {}
    publish = config.get("publish") if isinstance(config.get("publish"), dict) else {}
    return {
        "contract_root": contract.get("root", "AGENTS.md"),
        "contract_index": contract.get("index", []),
        "changelog": ledger.get("changelog", "dox/CHANGELOG.md"),
        "size_limit_words": int(ledger.get("size_limit_words", 1500) or 0),
        "reports_root": publish.get("reports_root", "reports"),
        "live_status": publish.get("live_status", "LIVE-STATUS.md"),
        "checklist": publish.get("checklist"),
        "canvas_dir": publish.get("canvas_dir", "reports/_canvas"),
        "manifest": publish.get("manifest", "MANIFEST.json"),
    }


def _pending_advisory_count() -> int:
    path = get_hermes_home() / "dox" / "pending_advisories.jsonl"
    if not path.exists():
        return 0
    try:
        return sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line.strip())
    except OSError:
        return 0


def _last_publish() -> dict[str, Any] | None:
    path = get_hermes_home() / "dox" / "last_publish.json"
    if not path.exists():
        return None
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return loaded if isinstance(loaded, dict) else None


def _resolve_marker_root(start: Path, *, search_parents: bool) -> Path:
    """Resolve the DOX project root for *start*.

    When ``search_parents`` is False (the default) the caller's directory is
    used verbatim — this preserves the exact-directory semantics that
    ``init``/``check`` and every existing test rely on.

    When True, walk upward from *start* to the filesystem root and return the
    nearest ancestor that carries the explicit ``docops.yml`` marker. This is
    what lets a session whose cwd is a *subfolder* of an initialized project
    (e.g. ``…/project/plans/workstream``) still resolve to the project that was
    actually ``dox init``-ed. When no ancestor is initialized, *start* is
    returned unchanged so status simply reports ``active: false``.
    """
    if not search_parents:
        return start
    for candidate in (start, *start.parents):
        if (candidate / "docops.yml").exists():
            return candidate
    return start


def status_project(root: str | Path = ".", *, search_parents: bool = False) -> dict[str, Any]:
    project_root = _resolve_marker_root(_root(root), search_parents=search_parents)
    config = _load_docops(project_root)
    docops_marker = (project_root / "docops.yml").exists()
    agents_header = _has_agents_header(project_root)
    structural = _structural_markers(project_root)
    mode = _infer_mode(
        explicit=config.get("mode"),
        docops=docops_marker,
        agents_header=agents_header,
        structural=structural,
    )
    active = mode is not None
    return {
        "active": active,
        "mode": mode,
        "root": str(project_root),
        "layers": _layers_for(mode, config),
        "markers": {
            "docops_yml": docops_marker,
            "agents_md_header": agents_header,
            "structural": structural,
        },
        "drift": [],
        "pending_advisories": pending_advisory_count(),
        "last_publish": _last_publish(),
    }


def _rel(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def _configured_indexes(config: dict[str, Any]) -> list[dict[str, str]]:
    raw = _settings(config)["contract_index"]
    if not raw:
        return []
    if not isinstance(raw, list):
        raise DoxError("docops.yml: contract.index must be a list")
    indexes: list[dict[str, str]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise DoxError("docops.yml: each contract.index entry must be a mapping")
        dir_name = str(item.get("dir", "."))
        glob = str(item.get("glob", "*/"))
        indexes.append({"dir": dir_name, "glob": glob})
    return indexes


def _find_index_block(text: str, path: Path, default_glob: str) -> tuple[int, int, str, str] | None:
    starts = list(_INDEX_START_RE.finditer(text))
    ends = list(_INDEX_END_RE.finditer(text))
    if len(starts) != len(ends):
        raise DoxError(f"{path}: malformed DOX index marker")
    if not starts:
        return None
    if len(starts) > 1:
        raise DoxError(f"{path}: only one DOX index block is supported")
    start, end = starts[0], ends[0]
    if end.start() < start.end():
        raise DoxError(f"{path}: malformed DOX index marker ordering")
    glob = start.group("glob") or default_glob
    return start.start(), end.end(), glob, text[start.end():end.start()]


def _parse_rows(block: str) -> dict[str, str]:
    rows: dict[str, str] = {}
    for line in block.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or "---" in stripped or "Path" in stripped:
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if len(cells) >= 2 and cells[0]:
            rows[cells[0]] = cells[1]
    return rows


def _expected_entries(directory: Path, glob: str) -> list[str]:
    entries: list[str] = []
    for path in directory.glob(glob):
        if path.name == "AGENTS.md":
            continue
        if path.name.startswith("."):
            continue
        if glob.endswith("/") and not path.is_dir():
            continue
        entries.append(path.name + ("/" if path.is_dir() and glob.endswith("/") else ""))
    return sorted(set(entries))


def _render_index_block(glob: str, rows: dict[str, str], expected: list[str]) -> str:
    rendered = [
        f"<!-- hermes-dox:index-start glob=\"{glob}\" -->",
        "| Path | Description |",
        "| --- | --- |",
    ]
    for entry in expected:
        rendered.append(f"| {entry} | {rows.get(entry, 'TODO: describe')} |")
    rendered.append("<!-- hermes-dox:index-end -->")
    return "\n".join(rendered)


def _check_indexes(root: Path, config: dict[str, Any], *, write: bool) -> list[DoxFinding]:
    findings: list[DoxFinding] = []
    for item in _configured_indexes(config):
        directory = (root / item["dir"]).resolve()
        agents = directory / "AGENTS.md"
        if not agents.exists():
            findings.append(DoxFinding("A", _rel(agents, root), "agents_missing"))
            if write:
                expected = _expected_entries(directory, item["glob"]) if directory.exists() else []
                content = "# Directory contract\n\n" + _render_index_block(item["glob"], {}, expected) + "\n"
                _write_if_changed(agents, content)
            continue
        text = _read_text(agents)
        block = _find_index_block(text, agents, item["glob"])
        if block is None:
            findings.append(DoxFinding("A", _rel(agents, root), "child_index_missing_marker"))
            if write:
                expected = _expected_entries(directory, item["glob"])
                suffix = "" if text.endswith("\n") else "\n"
                _write_if_changed(agents, text + suffix + "\n" + _render_index_block(item["glob"], {}, expected) + "\n")
            continue
        start, end, glob, block_text = block
        rows = _parse_rows(block_text)
        expected = _expected_entries(directory, glob)
        if sorted(rows) != expected:
            findings.append(DoxFinding("A", _rel(agents, root), "child_index_stale"))
            if write:
                replacement = _render_index_block(glob, rows, expected)
                _write_if_changed(agents, text[:start] + replacement + text[end:])
    return findings


def _validate_agent_markers(root: Path) -> None:
    for agents in root.rglob("AGENTS.md"):
        text = _read_text(agents)
        _find_index_block(text, agents, "*/")


def _word_count(text: str) -> int:
    return len(re.findall(r"\b\S+\b", text))


def _check_size_gate(root: Path, config: dict[str, Any]) -> list[DoxFinding]:
    settings = _settings(config)
    limit = settings["size_limit_words"]
    if limit <= 0:
        return []
    changelog = root / settings["changelog"]
    if not changelog.exists():
        return []
    text = _read_text(changelog)
    count = _word_count(text)
    if count <= limit:
        return []
    escaped = bool(_OVERSIZE_RE.search(text))
    return [
        DoxFinding(
            "B",
            _rel(changelog, root),
            "size_over_limit",
            f"{count} words exceeds limit {limit}",
            escaped=escaped,
        )
    ]


def _check_publish(root: Path, config: dict[str, Any]) -> list[DoxFinding]:
    settings = _settings(config)
    findings: list[DoxFinding] = []
    reports_root = root / settings["reports_root"]
    if reports_root.exists():
        manifest_name = settings["manifest"]
        for report in reports_root.rglob("report.md"):
            pack = report.parent
            if not (pack / "report.html").exists():
                findings.append(DoxFinding("A", _rel(pack / "report.html", root), "report_html_missing"))
            if not (pack / manifest_name).exists():
                findings.append(DoxFinding("A", _rel(pack / manifest_name, root), "manifest_missing"))
    checklist = settings["checklist"]
    if checklist and not (root / checklist).exists():
        findings.append(DoxFinding("A", str(checklist), "checklist_missing"))
    canvas_dir = root / settings["canvas_dir"]
    if (canvas_dir / "package.json").exists():
        findings.append(DoxFinding("A", _rel(canvas_dir / "package.json", root), "canvas_package_json_present"))
    return findings


def _exit_code(findings: list[DoxFinding]) -> int:
    if any(f.tier == "B" and not f.escaped for f in findings):
        return 2
    return 0


def check_project(root: str | Path = ".", *, write: bool = False, search_parents: bool = False) -> DoxReport:
    project_root = _resolve_marker_root(_root(root), search_parents=search_parents)
    status = status_project(project_root)
    if not status["active"]:
        return DoxReport(status=status, findings=[], exit_code=0)
    config = _load_docops(project_root)
    findings: list[DoxFinding] = []
    layers = status["layers"]
    if layers.get("contract"):
        _validate_agent_markers(project_root)
        findings.extend(_check_indexes(project_root, config, write=write))
    if layers.get("ledger"):
        findings.extend(_check_size_gate(project_root, config))
    if layers.get("publish"):
        findings.extend(_check_publish(project_root, config))
    status = dict(status)
    status["drift"] = [finding.to_dict() for finding in findings]
    return DoxReport(status=status, findings=findings, exit_code=_exit_code(findings))


def _docops_yaml(mode: str, layers: dict[str, bool]) -> str:
    return (
        "version: 1\n"
        f"mode: {mode}\n"
        "layers:\n"
        f"  contract: {str(layers['contract']).lower()}\n"
        f"  ledger: {str(layers['ledger']).lower()}\n"
        f"  publish: {str(layers['publish']).lower()}\n"
        "contract:\n"
        "  root: AGENTS.md\n"
        "  index:\n"
        "    - dir: .\n"
        "      glob: \"*/\"\n"
        "ledger:\n"
        "  changelog: dox/CHANGELOG.md\n"
        "  adr_dir: dox/adr\n"
        "  session_log: dox/session-log.md\n"
        "  size_limit_words: 1500\n"
        "publish:\n"
        "  reports_root: reports\n"
        "  live_status: LIVE-STATUS.md\n"
        "  checklist: null\n"
        "  canvas_dir: reports/_canvas\n"
        "  html: derived\n"
        "  manifest: MANIFEST.json\n"
    )


def _document_management_md() -> str:
    return (
        "# Document Management\n\n"
        "Hermes DOX keeps markdown as the source of truth for this project.\n\n"
        "- Update `LIVE-STATUS.md` for current operational truth.\n"
        "- Add durable decisions or history to `dox/CHANGELOG.md`, `dox/adr/`, or `dox/session-log.md`.\n"
        "- Treat files under `reports/` as publish artifacts; HTML is derived from markdown unless `docops.yml` says otherwise.\n"
    )


def _ensure_agents(root: Path, mode: str) -> None:
    agents = root / "AGENTS.md"
    index = _render_index_block("*/", {}, _expected_entries(root, "*/"))
    if not agents.exists():
        _write_if_changed(agents, f"# Project contract\n\n<!-- hermes-dox -->\n\n{index}\n")
        return
    text = _read_text(agents)
    changed = text
    if not _HEADER_RE.search("\n".join(text.splitlines()[:25])):
        changed = "<!-- hermes-dox -->\n" + changed
    if _find_index_block(changed, agents, "*/") is None:
        suffix = "" if changed.endswith("\n") else "\n"
        changed = changed + suffix + "\n" + index + "\n"
    _write_if_changed(agents, changed)


def init_project(root: str | Path = ".", *, mode: str | None = None) -> dict[str, Any]:
    project_root = _root(root)
    project_root.mkdir(parents=True, exist_ok=True)
    existing = status_project(project_root)
    resolved_mode = mode or existing["mode"] or "code"
    if resolved_mode not in _MODES:
        raise DoxError(f"mode must be one of {sorted(_MODES)}")
    layers = dict(_DEFAULT_LAYERS[resolved_mode])
    _write_if_changed(project_root / "docops.yml", _docops_yaml(resolved_mode, layers))
    if layers["ledger"]:
        _write_if_changed(project_root / "dox" / "CHANGELOG.md", "# Changelog\n")
        (project_root / "dox" / "adr").mkdir(parents=True, exist_ok=True)
        _write_if_changed(project_root / "dox" / "session-log.md", "# Session Log\n")
    if layers["publish"]:
        (project_root / "reports").mkdir(parents=True, exist_ok=True)
        _write_if_changed(project_root / "LIVE-STATUS.md", "# Live Status\n")
        _write_if_changed(
            project_root / "docs" / "standards" / "DOCUMENT-MANAGEMENT.md",
            _document_management_md(),
        )
        _write_if_changed(project_root / "reports" / "_canvas" / "index.html", "<!doctype html>\n<title>DOX Canvas</title>\n")
    if layers["contract"]:
        _ensure_agents(project_root, resolved_mode)
    return {
        "root": str(project_root),
        "mode": resolved_mode,
        "layers": layers,
        "initialized_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }
