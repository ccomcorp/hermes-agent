from __future__ import annotations

from pathlib import Path


FORBIDDEN_TOKENS = (
    "AIOS/",
    "dox-index.cjs",
    "dox-check.cjs",
    "dox-shape.cjs",
    "_envelope.cjs",
    "dox-advisories.cjs",
    "dox-inject.cjs",
    "packages/constraints",
    "packages/journal",
    "gbrain",
)


DOX_SOURCE_ROOTS = ("agent/dox", "hermes_cli/dox.py", "skills/devops/hermes-dox")


def test_dox_backend_has_no_forbidden_runtime_coupling():
    repo = Path(__file__).resolve().parents[2]
    hits: list[tuple[str, str]] = []

    for root_name in DOX_SOURCE_ROOTS:
        root = repo / root_name
        paths = [root] if root.is_file() else sorted(root.rglob("*.py"))
        for path in paths:
            text = path.read_text(encoding="utf-8")
            for token in FORBIDDEN_TOKENS:
                if token in text:
                    hits.append((path.relative_to(repo).as_posix(), token))

    assert hits == []
