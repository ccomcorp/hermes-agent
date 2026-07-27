#!/usr/bin/env python3
"""Skill Librarian indexer (Hermes).

Walks Hermes skill roots, parses SKILL.md frontmatter, builds a SQLite FTS5 index
so the full catalog never has to sit in the model context.

Usage: python indexer.py [--fresh-within SECONDS]

Stdlib only. RECURSIVE walk (Hermes skills nest by category:
skills/<category>/<skill>/SKILL.md), unlike the flat Claude layout.
Dedupes by resolved real path (collapsing junctions/symlinks) and by name|description.

Migrated from AIOS/AIOS/scripts/skill-librarian/ (2026-07-27) — ROOTS repointed at
the post-cutover D:\\HeicH\\hermes-home layout; no AIOS dependency.
"""
import os
import re
import sqlite3
import sys
import time

# Hermes skill roots. Edit to match the active HERMES_HOME / profile.
# Loading is by file path (the librarian read_files the SKILL.md), so any skill
# indexed here is usable on demand even if it is not in Hermes's auto-loaded index.
ROOTS = [
    r"D:\HeicH\hermes-home\skills",
    r"D:\HeicH\hermes-home\profiles\hermes-neo\skills",
]

EXCLUDE_DIRS = {
    "node_modules", ".git", ".venv", "references", "scripts", "tests",
    "assets", "templates", "workflows", "_loose-backup", "__pycache__",
}

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))  # scripts/skill-librarian -> repo root
DB = os.path.join(REPO_ROOT, "data", "skill-librarian", "index.sqlite")


def parse_frontmatter(text):
    m = re.match(r"﻿?\s*---\s*\n(.*?)\n---", text, re.S)
    fm = m.group(1) if m else ""

    def field(key):
        mm = re.search(rf"^{key}:\s*(.*?)(?=\n[A-Za-z_-]+:|\Z)", fm, re.S | re.M)
        if not mm:
            return ""
        val = " ".join(ln.strip() for ln in mm.group(1).splitlines())
        return val.strip().strip('"').strip("'").strip()

    return field("name"), field("description")


def collect():
    seen, rows = set(), []
    for root in ROOTS:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
            if "SKILL.md" not in filenames:
                continue
            sk = os.path.join(dirpath, "SKILL.md")
            try:
                with open(sk, encoding="utf-8", errors="replace") as f:
                    text = f.read(65536)
            except OSError:
                continue
            folder = os.path.basename(dirpath)
            name, desc = parse_frontmatter(text)
            ident = ((name or folder) + "|" + desc).lower()
            if ident in seen:
                continue
            seen.add(ident)
            rows.append((name or folder, desc, folder, os.path.realpath(sk), root))
    return rows


def build(rows):
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    tmp = DB + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    con = sqlite3.connect(tmp)
    con.executescript(
        "CREATE VIRTUAL TABLE skills USING fts5("
        "name, description, folder, path UNINDEXED, root UNINDEXED);"
    )
    con.executemany("INSERT INTO skills VALUES (?,?,?,?,?)", rows)
    con.commit()
    con.close()
    if os.path.exists(DB):
        os.remove(DB)
    os.rename(tmp, DB)


if __name__ == "__main__":
    if "--fresh-within" in sys.argv:
        secs = int(sys.argv[sys.argv.index("--fresh-within") + 1])
        if os.path.exists(DB) and time.time() - os.path.getmtime(DB) < secs:
            sys.exit(0)
    rows = collect()
    build(rows)
    print(f"Indexed {len(rows)} skills -> {DB}")
