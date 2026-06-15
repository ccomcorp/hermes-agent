"""Tests for loop classifier (loop_classifier.py)."""

from __future__ import annotations

from plugins.engineering_loop.loop_classifier import classify_loop
from plugins.engineering_loop.schemas import LoopType


class TestLoopClassification:
    """Classify engineering work as deterministic, non-deterministic, or hybrid."""

    def test_classify_deterministic_from_tests(self):
        """Tasks mentioning tests are deterministic."""
        result = classify_loop(
            "Write unit tests for the auth module",
            ["All tests pass", "Coverage > 80%"],
            ["tests/test_auth.py"],
        )
        assert result == LoopType.DETERMINISTIC

    def test_classify_deterministic_from_build(self):
        """Tasks mentioning build/compile/lint are deterministic."""
        result = classify_loop(
            "Fix the build pipeline and lint errors",
            ["Build succeeds", "No lint warnings"],
            [],
        )
        assert result == LoopType.DETERMINISTIC

    def test_classify_deterministic_from_refactor(self):
        """Refactoring tasks are deterministic."""
        result = classify_loop(
            "Refactor the database layer",
            ["All existing tests pass"],
            ["src/db.py"],
        )
        assert result == LoopType.DETERMINISTIC

    def test_classify_non_deterministic_from_ui(self):
        """UI/UX tasks are non-deterministic."""
        result = classify_loop(
            "Improve the landing page design and UX",
            ["Looks modern", "Responsive layout"],
            ["src/styles.css"],
        )
        assert result == LoopType.NON_DETERMINISTIC

    def test_classify_non_deterministic_from_visual(self):
        """Visual/animation tasks are non-deterministic."""
        result = classify_loop(
            "Polish the dashboard animations and transitions",
            ["Smooth interactions"],
            ["src/animations.ts"],
        )
        assert result == LoopType.NON_DETERMINISTIC

    def test_classify_hybrid_from_both_signals(self):
        """Tasks with both test and UI signals are hybrid."""
        result = classify_loop(
            "Build a responsive form component with validation and tests",
            ["Form validates correctly", "Looks good on mobile", "Tests pass"],
            ["src/Form.tsx", "src/Form.css", "tests/Form.test.tsx"],
        )
        assert result == LoopType.HYBRID

    def test_classify_default_hybrid(self):
        """Unclear tasks default to hybrid."""
        result = classify_loop(
            "Update the dependency versions",
            [],
            [],
        )
        assert result == LoopType.HYBRID

    def test_css_file_detected(self):
        """CSS files signal non-deterministic even if goal is vague."""
        result = classify_loop(
            "Make it work",
            [],
            ["styles/main.css"],
        )
        assert result == LoopType.NON_DETERMINISTIC

    def test_test_file_detected(self):
        """Test files signal deterministic."""
        result = classify_loop(
            "Make it work",
            [],
            ["tests/test_main.py"],
        )
        assert result == LoopType.DETERMINISTIC
