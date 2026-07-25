"""Tests for explicit model/complexity overrides on ``hermes kanban create``."""

from __future__ import annotations

from pathlib import Path

import pytest

from hermes_cli import kanban as kc
from hermes_cli import kanban_db as kb


VALID_MODEL = "anthropic/claude-sonnet-4.5"


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


@pytest.fixture
def model_catalog(monkeypatch):
    from hermes_cli import models

    monkeypatch.setattr(models, "model_ids", lambda *, force_refresh=False: [VALID_MODEL])

    def validate_requested_model(model_name, provider, **_kwargs):
        if model_name == VALID_MODEL:
            return {"accepted": True, "persist": True, "recognized": True, "message": None}
        return {
            "accepted": False,
            "persist": False,
            "recognized": False,
            "message": f"Model `{model_name}` was not found in the test catalog.",
        }

    monkeypatch.setattr(models, "validate_requested_model", validate_requested_model)


def _task_rows():
    with kb.connect() as conn:
        return conn.execute("SELECT * FROM tasks ORDER BY created_at, id").fetchall()


def test_create_model_flag_stores_valid_model_override(kanban_home, model_catalog):
    out = kc.run_slash(f"create 'model task' --assignee auto --model {VALID_MODEL}")

    assert "Created" in out
    rows = _task_rows()
    assert len(rows) == 1
    assert rows[0]["model_override"] == VALID_MODEL


def test_create_model_flag_rejects_unknown_model_before_card_insert(kanban_home, model_catalog):
    out = kc.run_slash("create 'bad model task' --model gtp-5-super")

    assert "unknown --model" in out
    assert "gtp-5-super" in out
    assert _task_rows() == []


def test_create_model_flag_fail_soft_accepts_custom_catalog_failure(kanban_home, monkeypatch):
    from hermes_cli import models

    monkeypatch.setattr(models, "model_ids", lambda *, force_refresh=False: (_ for _ in ()).throw(RuntimeError("catalog down")))
    monkeypatch.setattr(
        models,
        "validate_requested_model",
        lambda model_name, provider, **_kwargs: {
            "accepted": False,
            "persist": True,
            "recognized": False,
            "message": "could not reach this custom endpoint's model listing",
        },
    )

    out = kc.run_slash("create 'custom model task' --model custom:local:qwen-local")

    assert "Created" in out
    assert "--model warning" in out
    rows = _task_rows()
    assert len(rows) == 1
    assert rows[0]["model_override"] == "custom:local:qwen-local"


def test_create_complexity_flag_stores_explicit_tier_when_column_exists(kanban_home):
    out = kc.run_slash("create 'expert task' --assignee auto --complexity expert")

    assert "Created" in out
    rows = _task_rows()
    assert len(rows) == 1
    assert rows[0]["complexity_override"] == "expert"


def test_create_complexity_flag_rejects_unknown_tier_before_card_insert(kanban_home):
    out = kc.run_slash("create 'bad tier task' --complexity impossible")

    assert "invalid choice" in out
    assert "impossible" in out
    assert _task_rows() == []


def test_create_without_override_flags_preserves_existing_behavior(kanban_home, model_catalog):
    out = kc.run_slash("create 'ordinary task' --assignee dev-agent")

    assert "Created" in out
    rows = _task_rows()
    assert len(rows) == 1
    assert rows[0]["model_override"] is None
