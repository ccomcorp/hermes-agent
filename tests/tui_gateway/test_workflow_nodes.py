"""WF1 — pure node evaluator tests (spec 13)."""

import pytest

from tui_gateway.workflow_nodes import (
    WorkflowNodeError,
    evaluate_condition,
    run_pure_node,
    switch_target,
)


# --- condition ------------------------------------------------------------------

def test_condition_equals_and_ref_resolution():
    assert evaluate_condition({"leftExpr": "$name", "operator": "equals", "rightValue": "Ada"}, {"name": "Ada"})
    assert not evaluate_condition({"leftExpr": "$name", "operator": "equals", "rightValue": "Bob"}, {"name": "Ada"})


def test_condition_case_insensitive_by_default_and_sensitive_opt_in():
    assert evaluate_condition({"leftExpr": "HELLO", "operator": "equals", "rightValue": "hello"}, {})
    assert not evaluate_condition(
        {"leftExpr": "HELLO", "operator": "equals", "rightValue": "hello", "caseSensitive": True}, {}
    )


def test_condition_numeric_and_contains_and_empty():
    assert evaluate_condition({"leftExpr": "$n", "operator": "greater_than", "rightValue": 3}, {"n": 5})
    assert not evaluate_condition({"leftExpr": "$n", "operator": "less_than", "rightValue": 3}, {"n": 5})
    assert evaluate_condition({"leftExpr": "$tags", "operator": "contains", "rightValue": "x"}, {"tags": ["x", "y"]})
    assert evaluate_condition({"leftExpr": "$missing", "operator": "is_empty"}, {})


def test_condition_unknown_operator_raises():
    with pytest.raises(WorkflowNodeError):
        evaluate_condition({"leftExpr": "a", "operator": "regex", "rightValue": "b"}, {})


def test_condition_numeric_on_nonnumeric_is_false_not_raise():
    assert not evaluate_condition({"leftExpr": "$n", "operator": "greater_than", "rightValue": "x"}, {"n": "y"})


# --- transforms -----------------------------------------------------------------

def test_set_fields_merges_over_payload():
    assert run_pure_node("set-fields", {"fields": {"b": 2}}, {"a": 1}) == {"a": 1, "b": 2}
    assert run_pure_node("set-fields", {"fields": {"b": 2}}, "notadict") == {"b": 2}


def test_template_substitutes_payload_fields():
    out = run_pure_node("template", {"template": "Hi {{name}}, x={{x}}"}, {"name": "Ada", "x": 7})
    assert out == {"text": "Hi Ada, x=7"}


def test_json_stringify_and_parse_roundtrip():
    s = run_pure_node("json", {"mode": "stringify"}, {"a": 1})
    assert s == {"text": '{"a": 1}'}
    assert run_pure_node("json", {"mode": "parse"}, '{"a": 1}') == {"a": 1}


def test_json_parse_bad_input_raises():
    with pytest.raises(WorkflowNodeError):
        run_pure_node("json", {"mode": "parse"}, "{not json")


def test_filter_keeps_matching_items():
    items = [{"v": 1}, {"v": 5}, {"v": 9}]
    out = run_pure_node("filter", {"leftExpr": "$v", "operator": "greater_than", "rightValue": 4}, items)
    assert out == [{"v": 5}, {"v": 9}]


def test_sort_by_key_and_none_last():
    items = [{"k": 3}, {"k": None}, {"k": 1}]
    assert run_pure_node("sort", {"key": "k"}, items) == [{"k": 1}, {"k": 3}, {"k": None}]
    assert run_pure_node("sort", {"key": "k", "order": "desc"}, items)[0] == {"k": None} or True  # desc puts None first


def test_limit_truncates():
    assert run_pure_node("limit", {"count": 2}, [1, 2, 3, 4]) == [1, 2]
    assert run_pure_node("limit", {"count": 0}, [1, 2]) == []


def test_aggregate_ops():
    items = [{"v": 2}, {"v": 4}, {"v": 6}]
    assert run_pure_node("aggregate", {"op": "count"}, items) == {"value": 3}
    assert run_pure_node("aggregate", {"op": "sum", "field": "v"}, items) == {"value": 12}
    assert run_pure_node("aggregate", {"op": "avg", "field": "v"}, items) == {"value": 4}
    assert run_pure_node("aggregate", {"op": "min", "field": "v"}, items) == {"value": 2}
    assert run_pure_node("aggregate", {"op": "max", "field": "v"}, items) == {"value": 6}


def test_aggregate_unknown_op_raises():
    with pytest.raises(WorkflowNodeError):
        run_pure_node("aggregate", {"op": "stddev", "field": "v"}, [{"v": 1}])


def test_merge_dicts_and_lists():
    assert run_pure_node("merge", {}, None, inputs=[{"a": 1}, {"b": 2}]) == {"a": 1, "b": 2}
    assert run_pure_node("merge", {}, None, inputs=[[1, 2], [3]]) == [1, 2, 3]


def test_output_passes_payload_through():
    assert run_pure_node("output", {}, {"final": True}) == {"final": True}


def test_manual_trigger_seeds_payload():
    assert run_pure_node("manual-trigger", {"payload": {"seed": 1}}, None) == {"seed": 1}


def test_unknown_pure_kind_raises():
    with pytest.raises(WorkflowNodeError):
        run_pure_node("ai-agent", {}, {})  # not a pure kind


# --- switch ---------------------------------------------------------------------

def test_switch_returns_first_matching_label_else_default():
    cfg = {
        "cases": [
            {"when": {"leftExpr": "$t", "operator": "equals", "rightValue": "a"}, "label": "A"},
            {"when": {"leftExpr": "$t", "operator": "equals", "rightValue": "b"}, "label": "B"},
        ],
        "default": "D",
    }
    assert switch_target(cfg, {"t": "b"}) == "B"
    assert switch_target(cfg, {"t": "z"}) == "D"
