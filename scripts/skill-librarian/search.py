#!/usr/bin/env python3
"""Search the Hermes skill index (BM25 via SQLite FTS5).

Usage: python search.py "query terms" [top_k]

Returns ranked matches as: name, truncated description, and the absolute SKILL.md
path. The agent loads a skill by read_file-ing that path -- the catalog never
enters context wholesale. Stdlib only.

Migrated from AIOS/AIOS/scripts/skill-librarian/ (2026-07-27) — no AIOS dependency.
"""
import os
import re
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))  # scripts/skill-librarian -> repo root
DB = os.path.join(REPO_ROOT, "data", "skill-librarian", "index.sqlite")


def main():
    if len(sys.argv) < 2:
        print('usage: python search.py "query terms" [top_k]')
        return
    q = sys.argv[1]
    k = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    tokens = re.findall(r"[A-Za-z0-9]+", q)
    if not tokens:
        print("No query terms.")
        return
    if not os.path.exists(DB):
        print(f"Index missing at {DB}. Run indexer.py first.")
        return
    match = " OR ".join(t + "*" for t in tokens)
    con = sqlite3.connect(DB)
    rows = con.execute(
        "SELECT name, description, path, bm25(skills) FROM skills "
        "WHERE skills MATCH ? ORDER BY bm25(skills) LIMIT ?",
        (match, k),
    ).fetchall()
    if not rows:
        print("No matches. Retry with different/broader keywords.")
        return
    for name, desc, path, score in rows:
        d = (desc or "(no description)")[:220]
        print(f"* {name}  [{-score:.1f}]\n    {d}\n    SKILL: {path}")


main()
