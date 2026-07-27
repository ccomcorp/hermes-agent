#!/usr/bin/env node
'use strict';

/*
 * autosave-hook.cjs -- THIN binding: the zero-core PRESSURE BACKSTOP for the
 * session-continuity primitive. A pre-compaction save is non-negotiable, but the
 * chassis exposes no pre-compaction hook. So we ride the per-turn post_api_request
 * event (which carries token usage in its `extra` payload) and write a MECHANICAL
 * backstop checkpoint once context grows large -- thresholded BELOW the compaction
 * point so a handoff always exists before the chassis compacts. The rich,
 * agent-authored save is the /save-checkpoint skill; this is only the safety net
 * for sessions that never called it.
 *
 * EVENT = post_api_request. (Its stdout is ignored by shell_hooks._parse_response,
 * so this hook is pure side-effect.) Envelope on stdin: {session_id, cwd, extra:{usage,...}}.
 *
 * GATES (in order; the FIRST that skips short-circuits BEFORE any filesystem work):
 *   0. F6 EARLY GUARD: nothing-to-save. If usage is None/undefined/empty/blank (no
 *      real token signal) -- or there is no session id -- there is no meaningful
 *      checkpoint to write, so we skip immediately with a dedicated reason
 *      ('no-usage' / 'no-session'). This guard runs BEFORE the Gate-2 resume probe,
 *      so a usage=None turn never touches the disk and never emits a malformed/empty
 *      checkpoint. (It also avoids the per-turn fs cost on the common empty-usage turn.)
 *   1. Pressure: usage tokens >= HERMES_AUTOSAVE_TOKEN_THRESHOLD (default 40000).
 *   2. Throttle: the project's latest checkpoint is older than
 *      HERMES_AUTOSAVE_MIN_SECONDS (default 120) -- so we neither spam per-turn nor
 *      clobber a just-made rich save; once context keeps growing past the throttle,
 *      a fresh auto-backstop captures the newer state (most-recent-wins on resume).
 *
 * The decision is split into a pure, unit-testable decideAutosave(payload, opts) that
 * returns {write, reason, tokens}; main() only does the I/O around it.
 *
 * FAIL-OPEN: any error is swallowed; never break or slow a turn. ASCII-only stdlib.
 *
 * Ported from AIOS/AIOS packages/session/hooks/hermes-autosave-hook.cjs (2026-07-27):
 * env vars renamed AIOS_AUTOSAVE_* -> HERMES_AUTOSAVE_*.
 *
 * Wire into hermes config.yaml (hooks is a DICT keyed by event):
 *   hooks:
 *     post_api_request:
 *       - command: node D:/HeicH/hermes-agent/scripts/session-continuity/autosave-hook.cjs
 */

const fs = require('fs');
const cp = require('./checkpoint-store.cjs');

const TOKEN_THRESHOLD = Number(process.env.HERMES_AUTOSAVE_TOKEN_THRESHOLD || 40000);
const MIN_SECONDS = Number(process.env.HERMES_AUTOSAVE_MIN_SECONDS || 120);

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; } }

// Pull a "context size" proxy out of whatever usage shape the provider returned.
function contextTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const cand = [usage.prompt_tokens, usage.input_tokens, usage.context_tokens, usage.total_tokens,
    usage.prompt, usage.input];
  let max = 0;
  for (const c of cand) { const n = Number(c); if (isFinite(n) && n > max) max = n; }
  return max;
}

// PURE decision: given the turn payload and options, decide whether to write a
// backstop checkpoint and WHY. No I/O of its own -- the (optional) opts.resume probe
// is the only outside touch, and the early guards short-circuit BEFORE it is called.
// Returns { write, reason, tokens }. reasons: no-session | no-usage | below-threshold
// | throttled | write. opts: { tokenThreshold, minSeconds, resume(cwd) }.
function decideAutosave(payload, opts) {
  payload = payload || {};
  opts = opts || {};
  const threshold = (opts.tokenThreshold != null) ? opts.tokenThreshold : TOKEN_THRESHOLD;
  const minSeconds = (opts.minSeconds != null) ? opts.minSeconds : MIN_SECONDS;
  const extra = payload.extra || {};
  const tokens = contextTokens(extra.usage);
  const sessionId = payload.session_id || '';

  // Gate 0 (F6 EARLY GUARD): nothing meaningful to save. These return BEFORE the
  // resume probe so a usage=None turn never touches the disk and can never emit a
  // malformed/empty checkpoint.
  if (!sessionId) return { write: false, reason: 'no-session', tokens: tokens };
  if (tokens <= 0) return { write: false, reason: 'no-usage', tokens: tokens };

  // Gate 1: pressure.
  if (tokens < threshold) return { write: false, reason: 'below-threshold', tokens: tokens };

  // Gate 2: throttle -- consult the resume probe ONLY now (never on a Gate-0/1 skip).
  const probe = (typeof opts.resume === 'function') ? opts.resume : null;
  const cur = probe ? probe(payload.cwd) : null;
  if (cur && cur.found && cur.identityOk && typeof cur.ageHours === 'number' && (cur.ageHours * 3600) < minSeconds) {
    return { write: false, reason: 'throttled', tokens: tokens };
  }
  return { write: true, reason: 'write', tokens: tokens };
}

function main() {
  let payload = {};
  const raw = readStdin();
  if (raw) { try { payload = JSON.parse(raw); } catch (e) { return; } }
  const cwd = payload.cwd || process.env.TERMINAL_CWD || process.cwd();

  const decision = decideAutosave(payload, {
    tokenThreshold: TOKEN_THRESHOLD,
    minSeconds: MIN_SECONDS,
    resume: function () { return cp.resumeCheckpoint({ cwd: cwd }); }
  });
  if (!decision.write) return;

  const extra = payload.extra || {};
  cp.saveCheckpoint({
    cwd: cwd,
    sessionId: payload.session_id || '',
    parentSessionId: extra.parent_session_id || '',
    actor: 'hermes-autosave',
    payload: {
      auto: true,
      task: '(auto-backstop -- no agent-authored checkpoint this session)',
      phase: 'auto',
      tokens: decision.tokens,
      turn_id: extra.turn_id || null,
      status: ['<-- RESUME HERE (auto-backstop; mechanical, agent did not author this)'],
      note: 'pre-compaction safety save at context pressure (' + decision.tokens + ' tokens)'
    }
  });
}

module.exports = { decideAutosave: decideAutosave, contextTokens: contextTokens };

// CLI / hook entrypoint only -- guarded so `require()` (unit tests, other modules)
// imports the pure functions WITHOUT running main() or exiting the process.
if (require.main === module) {
  try { main(); } catch (e) { /* fail-open */ }
  process.exit(0);
}
