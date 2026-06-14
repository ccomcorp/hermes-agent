# AGENTS.md — composite memory provider (chassis-side)

> Hand-maintained dir guide. This is **hermes-agent**, NOT AIOS — it is outside the AIOS
> DOX index (the AIOS root index does not scan this repo) and needs no index registration.
> The portable core it binds (the experience-store + composite-provider engines) lives in
> the sibling AIOS checkout and is unit-tested there; nothing here re-implements it.

The chassis-side binding of the AIOS experience-store composite (M1). It puts the two
AIOS packages (`experience-store`, `composite-provider`) on `sys.path`, subclasses the
real `CompositeMemoryProvider`, and exposes it to the chassis plugin loader. Activated by
`memory.provider: composite` in `config.yaml` — the package merely existing does not
register anything; the config key does.

## Files

- **`provider.py`** — `HermesCompositeProvider(CompositeMemoryProvider)`, the dev-instance
  subclass. Adds:
  - **fork-append seam** (`record_fork_lesson`): writes deliberately-reviewed,
    fork-authored lessons (`source='reviewed'`, `migrated=False`) — the AC1-eligible band.
    `sync_turn` deliberately does NO store append (dev-instance corpus is authored-only).
  - **D4-A prefetch** (`prefetch` + `confirm_prefetch_consumed`): session-start recall that
    marks the receipt consumed only AFTER the chassis confirms the block reached the
    dispatched prompt — an assembled-but-dropped block never counts toward circulation.
  - **D3b recall** (`recall_for` + `confirm_consumed`): pre-delegation knowledge-gate recall;
    always emits a receipt (a miss writes `kind='miss'` — never silent).
  - **brain staging** (`brain_stage` 0/1/2): stage 1 = observe (`sync_turn` fires a
    fire-and-forget observation, capturing the `observation_id` for pairing) + recall;
    stage 2 = the paired reward leg in `handle_tool_call`, SUBMITTED to a background worker
    (off the turn thread, R4), outcome-gated, C3-preserving, with one-shot observation pop.
  - **`brain_health()`**: an honest, deterministic snapshot of the reward leg
    (`disabled`/`observe-only`/`pending`/`live`/`degraded`/`fail`) plus local and
    brain-authoritative dW totals — no hardcoded label.
  - `build_provider(hermes_home)`: env-staged constructor (see Activation below).

- **`brain_http.py`** — `HttpBrainClient`, the blocking-HTTP `BrainClient` adapter (stdlib
  `urllib` only, no new dependency, `close()` is a no-op). Speaks the NeuroLinked brain
  HTTP contract, best-effort with a single attempt and a ~2.5s timeout (a slow/offline
  brain degrades, never stalls a turn):
  - `GET /api/claude/recall` — cache-only recall (`prefetch`); items clamped to
    `recall_limit` and `max_item_chars` before reaching context; brain scores squashed
    so they never outrank the store's authoritative 1.0 band.
  - `POST /api/claude/observe` — returns the brain `observation_id` (UUID string, not the
    int rowid; the feedback endpoint 422s on an int) for paired reward.
  - `POST /api/claude/feedback` — `reward`; sends the SIGNED `outcome` float (failures
    punish) plus `was_helpful`. `ok` ONLY for a paired HTTP-200 with non-zero dW; the
    legacy no-id path / dW=0 / 422-stale are `degraded`; transport error is `fail`.
  - `GET /api/claude/summary` (`brain_dW_total`) — authoritative running dW total.
  - `GET /api/brain/learning-delta` (`learning_delta`) — diagnostic snapshot (no dW total).
  - `GET /api/claude/status` (`ping`) — liveness, logged at build.

- **`__init__.py`** — plugin entry point. `register(ctx)` builds the provider over the
  active `HERMES_HOME` and calls `ctx.register_memory_provider`.

- **`tests/`** — `test_brain_http.py`, `test_brain_http_live.py` (gated live `.31` checks),
  `test_brain_staging.py`, `conftest.py`.

## Activation (M1 brain add-on)

Staged via env, read by `build_provider` at gateway startup (a **full relaunch** is
required to change stage). Requires `memory.provider: composite` — with the default
provider the brain leg is never constructed regardless of env.

- `HERMES_BRAIN_STAGE` = `0` (off, default — live agent byte-for-byte unchanged) /
  `1` (observe + recall) / `2` (+ backgrounded paired reward, the learning leg).
  Garbage clamps to `0`.
- `HERMES_BRAIN_URL` overrides the endpoint (default `http://1.1.11.31:8000`).
- `AIOS_PACKAGES_DIR` overrides the sibling-checkout path to the two AIOS packages.
- Canonical instance home: `HERMES_HOME=I:\PROJECTS\AIOS\hermes-home` (where
  `experience.db` lives) — NOT the stale `%LOCALAPPDATA%\hermes` home.

Stage 1 verified live 2026-06-13 on the canonical desktop. Full design lives AIOS-side in
`docs/architecture/SPEC-m1-experience-store.md`; operator quick-reference in the AIOS root
`AGENTS.md` ("Brain activation (M1 add-on)") and `docs/architecture/REF-brain-activation-settings.md`.
