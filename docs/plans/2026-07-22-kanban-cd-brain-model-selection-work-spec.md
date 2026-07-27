# Spec: finish Kanban C+D and defer brain-learned model selection correctly

**Date:** 2026-07-22
**Repo inspected:** `D:/HeicH/hermes-agent`
**Prior spec:** `H:/WSpace-Hermes/hermes-projects/H-CIC/specs/2026-07-21-llm-classifier-brain-routing-spec.md`
**Status:** implementation spec, source-grounded

## 1. Current verdict

In-chat specialist routing is complete, but **Kanban C+D is only partially complete**, and **brain-learned model selection is not implemented**.

The existing code has real C+D scaffolding:

- `kanban.complexity_routing` exists in bundled config, default disabled, with `mode`, `trigger_assignee`, confidence, timeout, tick budget, map, and fallback keys (`hermes_cli/config.py:2793-2815`).
- `auxiliary.dispatch_classifier` exists as an auxiliary model task (`hermes_cli/config.py:1681-1692`).
- Config validation covers `kanban.complexity_routing` shape and profile map fields (`hermes_cli/config.py:5499-5611`).
- Dispatcher loads a per-tick complexity-routing snapshot and creates `_ClassifierTickState` when enabled (`hermes_cli/kanban_db.py:7806-7818`).
- Dispatcher applies complexity routing before profile spawnability checks (`hermes_cli/kanban_db.py:7961-7968`).
- Classifier prompt/call/cache/fallback path exists (`hermes_cli/kanban_db.py:7249-7647`).
- Classifier cache table exists in fresh schema and legacy migration (`hermes_cli/kanban_db.py:1205-1209`, `hermes_cli/kanban_db.py:2011-2018`).
- Worker spawn passes `-m <task.model_override>` when present (`hermes_cli/kanban_db.py:8580-8581`).
- `kanban create --model` validates and stores a model override (`hermes_cli/kanban.py:136-181`, `hermes_cli/kanban.py:184-210`, `hermes_cli/kanban.py:414-419`, `hermes_cli/kanban.py:1427-1469`).
- Focused C+D tests pass now: `tests/hermes_cli/test_kanban_complexity_routing.py`, `test_kanban_create_flags.py`, and `test_config_classifier_routing.py` ran **26 passed** on 2026-07-22.

But the implementation does **not** satisfy the prior C+D spec yet because several high-impact seams remain incomplete.

## 2. Live board/config evidence

Live runtime config from `load_config()` on 2026-07-22:

```text
kanban.default_assignee = dev-agent
kanban.dispatch_in_gateway = True
kanban.max_in_progress = 3
kanban.complexity_routing.enabled = True
kanban.complexity_routing.trigger_assignee = auto
kanban.complexity_routing.mode = classifier
auxiliary.dispatch_classifier = deepseek/deepseek-v4-pro, timeout 10s
```

Live board query on 2026-07-22:

```text
status counts:
  done: 7
  running: 1
ready/running/blocked/review tasks:
  t_9bfc03cb [running] assignee=dev-agent model=None title=K8 — Integration verification (seed: Trading + Coding)
has complexity_override: False
classifier_cache rows: 0
kanban diagnostics: []
```

Implications:

- The live board is not currently backlogged; there is one running card and no diagnostics.
- The runtime is opted into classifier routing, but no live classifier corpus exists yet (`classifier_cache` empty).
- The tasks table does **not** have `complexity_override`, so `--complexity` cannot be used on the live board.
- `default_assignee: dev-agent` still causes unassigned ready cards to be assigned to `dev-agent` before the C+D trigger can see `auto`.

## 3. Gaps to close before calling Kanban C+D complete

### Gap A — `default_assignee: dev-agent` bypasses C+D for unassigned normal cards

**Source path:** `_dispatch_once_locked` normalizes `default_assignee`, verifies it as a real profile, and for unassigned ready rows writes that profile into `tasks.assignee` (`hermes_cli/kanban_db.py:7898-7959`). Only after that does it call `_apply_complexity_route_if_needed` (`hermes_cli/kanban_db.py:7961-7968`). `_apply_complexity_route_if_needed` only triggers when the assignee equals `kanban.complexity_routing.trigger_assignee` (`hermes_cli/kanban_db.py:7659-7662`).

With the current runtime:

```yaml
kanban:
  default_assignee: dev-agent
  complexity_routing:
    enabled: true
    trigger_assignee: auto
```

an unassigned card becomes `dev-agent`, not `auto`, so C+D never runs for that card.

**Required work:** choose and implement one of these, in order of preference:

1. **Low-code operational path:** stop relying on `default_assignee` for routed work. Set `kanban.default_assignee: ""` and make card-creation/decomposition surfaces assign the sentinel explicitly: `assignee=auto` for cards intended for C+D.
2. **Safer product path:** add explicit config `kanban.complexity_routing.default_to_trigger: true` or equivalent, and when enabled treat an unassigned ready card as the trigger sentinel before applying `default_assignee`. This must be gated so old installs keep current behavior.

**Acceptance tests:**

- Unassigned ready card + C+D enabled + `default_to_trigger:true` routes through classifier/map and never lands on `dev-agent` by default.
- Unassigned ready card + C+D disabled preserves current `default_assignee` behavior.
- Existing explicit assignee `dev-agent` is never rerouted.

### Gap B — explicit `--complexity` is a CLI flag without schema support on real boards

`kanban create` exposes `--complexity` (`hermes_cli/kanban.py:414-419`) and `_store_create_overrides()` can write `complexity_override` only if the column already exists (`hermes_cli/kanban.py:184-210`, `hermes_cli/kanban.py:1433-1441`). But current schema lacks the column (`hermes_cli/kanban_db.py:1120-1180` shows `model_override` but no `complexity_override`), migrations do not add it (`hermes_cli/kanban_db.py:1920-2018` adds `model_override`, `goal_*`, `session_id`, block fields, and cache, but no `complexity_override`), and the live board confirms `has complexity_override: False`.

Also, `_resolve_complexity_route()` does not read `complexity_override` anywhere; it only supports `tier-only` as fallback-to-fallback and classifier mode (`hermes_cli/kanban_db.py:7557-7647`).

**Required work:**

- Add `complexity_override TEXT` to fresh schema and additive migration.
- Add `complexity_override` to `Task` dataclass/from-row if it needs to appear in CLI/API; otherwise at minimum read it directly from the row in routing.
- In `_resolve_complexity_route()`, before classifier mode, if row has a valid `complexity_override`, map `tier -> profile` using `snapshot["map"]`, set route payload `route_reason: explicit_complexity:<tier>`, and skip auxiliary classifier entirely.
- Update `_classifier_cache_key()` only if explicit complexity should invalidate cache; simplest is to skip cache/classifier when explicit tier exists, so no cache change required.

**Acceptance tests:**

- Fresh DB contains `tasks.complexity_override`.
- Legacy DB gains `tasks.complexity_override` on `init_db()` / connect migration.
- `kanban create --assignee auto --complexity expert` persists the tier without test-only `ALTER TABLE`.
- Dispatch of `assignee=auto, complexity_override=expert` routes to `map.expert` and makes zero aux calls.
- Invalid stored tier falls back safely and records an event reason.

### Gap C — explicit `--model` does not skip classifier for `assignee=auto`

The prior spec says explicit model should win and skip classifier. Current behavior validates/stores `model_override`, and spawn passes `-m`, but `_apply_complexity_route_if_needed()` still invokes `_resolve_complexity_route()` for every `assignee=auto` row, regardless of `model_override` (`hermes_cli/kanban_db.py:7650-7691`). The current update uses `COALESCE(NULLIF(model_override,''), ?)` so a classifier-suggested model will not overwrite an existing task model (`hermes_cli/kanban_db.py:7677-7684`), and the test confirms that (`tests/hermes_cli/test_kanban_complexity_routing.py:429-457`). That preserves the model string, but it does not skip the classifier call.

**Required work:** decide the base profile for explicit-model auto cards, then implement it. Recommended minimal config:

```yaml
kanban:
  complexity_routing:
    explicit_model_profile: advisor   # default fallback if absent
```

Routing rule:

1. If `assignee == trigger_assignee` and `model_override` is non-empty, set assignee to `explicit_model_profile` if configured and valid, otherwise `fallback`.
2. Append event payload: `source: kanban.complexity_routing`, `route_reason: explicit_model`, `assignee`, `model`.
3. Do **not** call the classifier.
4. Preserve explicit `model_override`.

**Acceptance tests:**

- `kanban create --assignee auto --model VALID_MODEL` dispatches with `(assignee=explicit_model_profile/fallback, model_override=VALID_MODEL)` and zero aux calls.
- Invalid configured `explicit_model_profile` fails config validation or falls back to `fallback` with warning/event.
- Existing explicit assignee + `--model` remains untouched and spawns as that assignee with `-m`.

### Gap D — classifier-returned optional `model` is not validated before storing/spawning

The prior spec required model validation for classifier optional `model` because `task.model_override` flows straight to worker `-m` (`hermes_cli/kanban_db.py:8580-8581`). Current `_resolve_classifier_result()` accepts any non-empty `parsed["model"]` and includes it in the route payload (`hermes_cli/kanban_db.py:7521-7553`). `_apply_complexity_route_if_needed()` then writes it to `tasks.model_override` when no existing model is set (`hermes_cli/kanban_db.py:7677-7684`).

**Required work:** add dispatch-side validation for classifier-suggested model strings.

Recommended helper:

- Reuse `hermes_cli.models.parse_model_input()` and `validate_requested_model()` like `kanban create --model` does (`hermes_cli/kanban.py:143-181`).
- Accept only when validation says accepted + persist.
- If validation fails, keep the profile route, drop only the model override, and record `model_rejected` / `model_reject_reason` in the assigned event.
- If model catalog/provider lookup is down, fail open by dropping classifier model override rather than crash-looping a worker.

**Acceptance tests:**

- Classifier returns valid model -> stored/spawned.
- Classifier returns typo model -> profile route still spawns, model_override remains NULL, event records rejection.
- Existing task model_override still wins over classifier model.

### Gap E — production telemetry exists as events, but there is no explicit report surface

Routing appends an `assigned` event with `route_payload` (`hermes_cli/kanban_db.py:7690`). That payload already contains source, route reason, tier/confidence/rationale/model/assignee when available (`hermes_cli/kanban_db.py:7514-7553`, `hermes_cli/kanban_db.py:7644-7647`). This is enough for an initial production corpus, but operators need a supported way to inspect it.

**Required work:** add a low-footprint report command or diagnostics block, not a new daemon.

Recommended command:

```bash
hermes kanban routing-report --since 7d --json
```

It should aggregate from `task_events.kind='assigned'` with `payload.source='kanban.complexity_routing'`:

- cards routed by reason: explicit_model, explicit_complexity, classifier:<tier>, classifier_low_confidence_fallback, classifier_error_fallback, classifier_budget_fallback, classifier_breaker_fallback
- fallback rate
- classifier call count estimate: non-cache classifier reasons + malformed/error reasons
- model overrides accepted/rejected
- resulting assignee distribution

**Acceptance tests:**

- Report returns empty cleanly on boards with no events.
- Report counts classifier/fallback/explicit routes correctly from seeded events.
- No secrets printed; model names are OK, API keys/base URLs are not.

## 4. Brain-learned model selection: defer, do not shortcut

### Current evidence

The prior spec already cut brain-in-loop from v1 (§4 and §9). Fresh inspection confirms this is still correct:

- Code search found no dedicated learned model-selection implementation, model-performance table, or `(features, model, outcome)` store.
- Existing learning paths are generic self-improvement, not model-choice fitness:
  - `plugins/engineering_loop/tools.py` emits outcome signals (`experience_signal`) from real tool/test outcomes.
  - `plugins/memory/composite/provider.py` bridges `experience_signal` to brain reward when properly paired.
  - NeuroLinked reports 5,467 knowledge entries and a full 1,000-pattern memory store, but recall for `model selection routing delegation kanban classifier outcome model performance` returned 0 results.
  - NeuroLinked `brain_learned` returned broad co-activation groups, not a model-performance policy.
- Live C+D has no production corpus yet (`classifier_cache rows: 0`, no current route report surface).

### Phase 2 is not ready to implement

Do **not** wire free-text brain recall into classifier prompts as "learned model selection." It would be a semantic similarity shortcut, not model-fitness learning. The prior spec's critique still holds: model fitness depends on structured features such as complexity, domain/task type, token/file scale, repo context, provider failure modes, and outcome attribution, not just text similarity.

### Required Phase-2 prep work after C+D is stable

Only after C+D has real production events should Phase 2 start. The Phase-2 spec must include:

1. **Feature extractor**
   - Inputs: card title/body, explicit tier if present, workspace kind, repo/project, skills, parent count, estimated token length, likely file/code/research/front-end/debug/planning tags, assigned profile, selected model.
   - Output: stable JSON feature vector, versioned.

2. **Queryable model-outcome store**
   - New SQLite table, not free-text brain notes.
   - Minimum columns: `id`, `created_at`, `task_id`, `feature_version`, `features_json`, `chosen_profile`, `chosen_model`, `route_reason`, `classifier_confidence`, `terminal_status`, `outcome_kind`, `outcome_score`, `duration_s`, `attempt_count`, `human_override`, `notes`.
   - Must support feature-similarity queries later.

3. **Typed outcome attribution**
   - Distinguish at least:
     - `model_fit_positive`
     - `model_fit_negative`
     - `spec_bad`
     - `dependency_blocked`
     - `tooling_or_auth_failure`
     - `quota_or_rate_limit`
     - `test_failure_after_valid_work`
     - `unknown`
   - Flat success/failure is too noisy for model learning.

4. **Reward discipline**
   - Continue using the existing self-improvement / NeuroLinked observe-reward path.
   - No parallel reward daemon.
   - No mass-positive reward at authoring.
   - Only reward model-choice lessons when a real typed outcome supports the attribution.

5. **Policy gate**
   - Learned policy begins in `log` mode: predict a profile/model but do not alter routing.
   - Promote to `suggest` mode only after retrospective accuracy beats the current classifier/fallback baseline.
   - Promote to `route` mode only after explicit approval and tests.

## 5. Implementation slices

### Slice 1 — finish C+D deterministic overrides

Files:

- `hermes_cli/kanban_db.py`
- `hermes_cli/kanban.py`
- `hermes_cli/config.py`
- `tests/hermes_cli/test_kanban_complexity_routing.py`
- `tests/hermes_cli/test_kanban_create_flags.py`
- `tests/hermes_cli/test_config_classifier_routing.py`

Work:

1. Add `complexity_override` schema + migration + read path.
2. Implement explicit complexity route before classifier.
3. Implement explicit model route before classifier.
4. Add classifier model validation before storing optional model.
5. Add config validation for any new `explicit_model_profile` / `default_to_trigger` key.

Gates:

```bash
python -m pytest \
  tests/hermes_cli/test_kanban_complexity_routing.py \
  tests/hermes_cli/test_kanban_create_flags.py \
  tests/hermes_cli/test_config_classifier_routing.py -q
python -m py_compile hermes_cli/kanban_db.py hermes_cli/kanban.py hermes_cli/config.py
```

### Slice 2 — remove live bypass / opt cards into auto correctly

Work:

1. Decide operational policy: either disable `default_assignee` or implement `default_to_trigger`.
2. Update runtime config only after code support is clear.
3. Create a dry-run card in a scratch board to prove unassigned or `auto` cards route through C+D.

Gates:

```bash
hermes kanban --board <scratch> create 'C+D smoke: classify simple card' --assignee auto --initial-status ready --json
hermes kanban --board <scratch> daemon --once --dry-run --json   # or equivalent dispatch-once harness if available
```

Acceptance: event payload shows `source=kanban.complexity_routing`; spawned/claimed assignee is not the sentinel `auto`; no `dev-agent` bypass unless classifier/map chose it.

### Slice 3 — routing report

Work:

1. Add `hermes kanban routing-report` reading assigned-event payloads.
2. Add JSON and human output.
3. Add tests with seeded events.

Gate:

```bash
python -m pytest tests/hermes_cli/test_kanban_complexity_routing.py -q
```

### Slice 4 — Phase-2 learned model-selection design only

Work:

1. Write a separate Phase-2 spec after at least a small C+D corpus exists.
2. Include feature schema, outcome table, attribution taxonomy, and log-mode policy.
3. Run adversarial review before implementation.

Non-goals for Slice 4:

- No model-choice reward loop yet.
- No NeuroLinked free-text recall in classifier prompt.
- No automatic model-routing policy change.

## 6. Definition of done

Kanban C+D is complete when all of these are true:

- `assignee=auto` cards never reach profile spawnability as `auto`.
- Unassigned normal cards either intentionally stay unassigned or intentionally enter C+D; they do not silently bypass to `dev-agent` when C+D is expected.
- `--complexity` works on fresh and legacy boards without manual schema edits.
- `--complexity` and `--model` skip the classifier where specified.
- Classifier errors, malformed JSON, low confidence, timeout, budget exhaustion, and invalid optional models all fail open to a real profile without crash loops.
- Routing decisions are visible via assigned-event payloads and `routing-report`.
- Focused C+D tests pass.
- One live scratch-board dispatch proves the runtime path.

Brain-learned model selection is complete only later, when:

- C+D has a route/outcome corpus.
- A feature-vector model-outcome store exists.
- Typed outcome attribution exists.
- A learned policy beats the baseline in `log` mode.
- User explicitly approves moving from log/suggest to route.
