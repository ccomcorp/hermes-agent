"""Regression tests for git_commit.py — safe staging checks."""

from __future__ import annotations

import subprocess
from pathlib import Path

from plugins.engineering_loop.git_commit import (
    is_safe_to_commit,
    _get_staged_files,
    _BLOCKED_PATTERNS,
    commit,
)


class TestStagedFiles:
    """is_safe_to_commit only inspects staged files, not the whole working tree."""

    def test_no_staged_files_returns_false(self, temp_project: Path):
        """With nothing staged, is_safe_to_commit returns False."""
        ok, reason = is_safe_to_commit(temp_project)
        assert ok is False
        assert "No staged" in reason

    def test_safe_staged_file_passes(self, temp_project: Path):
        """A clean file staged for commit passes the safety check."""
        safe_file = temp_project / "src" / "module.py"
        safe_file.parent.mkdir(exist_ok=True)
        safe_file.write_text("def hello(): return 'world'")
        subprocess.run(["git", "add", "src/module.py"], cwd=str(temp_project), check=True)

        ok, reason = is_safe_to_commit(temp_project)
        assert ok is True, f"Expected safe, got: {reason}"

    def test_dangerous_staged_file_fails(self, temp_project: Path):
        """A .env file staged for commit is flagged as dangerous."""
        (temp_project / ".env").write_text("SECRET=abc")
        subprocess.run(["git", "add", ".env"], cwd=str(temp_project), check=True)

        ok, reason = is_safe_to_commit(temp_project)
        assert ok is False
        assert ".env" in reason

    def test_dirty_working_tree_not_inspected(self, temp_project: Path):
        """Files in the working tree (unstaged) do NOT block commit."""
        # Stage a safe file
        safe_file = temp_project / "src" / "module.py"
        safe_file.parent.mkdir(exist_ok=True)
        safe_file.write_text("def hello(): return 'world'")
        subprocess.run(["git", "add", "src/module.py"], cwd=str(temp_project), check=True)

        # Make a dirty dangerous file in the working tree (UNSTAGED)
        (temp_project / ".env").write_text("SECRET=abc")
        # Do NOT stage it

        ok, reason = is_safe_to_commit(temp_project)
        # Should pass — .env is unstaged, not inspected
        assert ok is True, (
            f"Expected safe (unstaged .env not inspected), got: {reason}"
        )

    def test_get_staged_files_only_returns_staged(self, temp_project: Path):
        """_get_staged_files returns ONLY staged files, ignoring dirty tree."""
        # Stage a clean file
        (temp_project / "src").mkdir(exist_ok=True)
        staged_file = temp_project / "src" / "lib.py"
        staged_file.write_text("x=1")
        subprocess.run(["git", "add", "src/lib.py"], cwd=str(temp_project), check=True)

        # Create an unstaged dirty file
        (temp_project / "untracked.py").write_text("print(1)")

        ok, files, err = _get_staged_files(temp_project)
        assert ok is True
        assert "src/lib.py" in files
        assert "untracked.py" not in files, "Unstaged files must not appear"

    def test_deleted_file_not_inspected(self, temp_project: Path):
        """Deleted files (D in diff-filter) are excluded from inspection."""
        # Create then stage then delete a .log file
        (temp_project / "output.log").write_text("log content")
        subprocess.run(["git", "add", "output.log"], cwd=str(temp_project), check=True)
        subprocess.run(["git", "commit", "-m", "add log"], cwd=str(temp_project), check=True)

        # Now delete and stage the deletion
        (temp_project / "output.log").unlink()
        subprocess.run(["git", "add", "output.log"], cwd=str(temp_project), check=True)

        # _get_staged_files with --diff-filter=ACMR excludes D (Deleted)
        ok, files, err = _get_staged_files(temp_project)
        assert ok is True
        assert "output.log" not in files, (
            "Deleted files must be excluded (--diff-filter=ACMR excludes D)"
        )


class TestGitCommit:
    """End-to-end commit workflow with safety gates."""

    def test_commit_fails_without_staged_changes(self, temp_project: Path):
        """commit() fails when nothing is staged."""
        ok, msg = commit(temp_project, "test: empty commit")
        assert ok is False
        assert msg != ""

    def test_commit_fails_with_dangerous_file(self, temp_project: Path):
        """commit() fails when a dangerous file is staged."""
        (temp_project / ".env").write_text("SECRET=abc")
        subprocess.run(["git", "add", ".env"], cwd=str(temp_project), check=True)

        ok, msg = commit(temp_project, "test: leak secrets")
        assert ok is False
        assert ".env" in msg or "Dangerous" in msg

    def test_commit_succeeds_with_safe_changes(self, temp_project: Path):
        """commit() succeeds with clean staged files."""
        (temp_project / "src").mkdir(exist_ok=True)
        safe = temp_project / "src" / "hello.py"
        safe.write_text("print('hello')")
        subprocess.run(["git", "add", "src/hello.py"], cwd=str(temp_project), check=True)

        ok, result = commit(temp_project, "test: safe commit")
        assert ok is True
        assert len(result) >= 7  # commit hash
