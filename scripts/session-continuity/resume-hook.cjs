#!/usr/bin/env node
'use strict';

/*
 * resume-hook.cjs -- THIN binding for the session-continuity primitive. Speaks
 * the hermes-agent shell-hook wire protocol (agent/shell_hooks.py): JSON envelope
 * on stdin ({hook_event_name, session_id, cwd, extra}); on stdout, {"context": "..."}
 * is injected into the model call.
 *
 * EVENT = pre_llm_call. (Verified at source: shell_hooks._parse_response only honors
 * {"context": ...} for pre_llm_call; on_session_start stdout is ignored.) We inject
 * the prior per-project checkpoint as a compact "[RESUME]" block so the new session
 * continues with fluency (resume is the first action). To make it a once-per-session
 * FIRST action -- not a per-turn re-inject -- a marker file keyed by the NEW
 * session_id is written on first fire; subsequent calls no-op.
 *
 * Inject ONLY when the identity cross-check passes. Identity mismatch or no checkpoint
 * => silent no-op (still marks the session so we do not re-check every turn). Stale
 * (past TTL) => injected but flagged "confirm before trusting".
 *
 * FAIL-OPEN: any error prints nothing and exits 0 -- a checkpoint adapter must never
 * break or slow a turn. ASCII-only, pure Node stdlib.
 *
 * Ported from AIOS/AIOS packages/session/hooks/hermes-resume-hook.cjs (2026-07-27).
 *
 * Wire into hermes config.yaml (hooks is a DICT keyed by event; set
 * hooks_auto_accept: true so a non-TTY/script launch registers without a prompt):
 *   hooks:
 *     pre_llm_call:
 *       - command: node D:/HeicH/hermes-agent/scripts/session-continuity/resume-hook.cjs
 *   hooks_auto_accept: true
 */

const fs = require('fs');
const path = require('path');
const cp = require('./checkpoint-store.cjs');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}
function sanitize(s) { return String(s || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'nosession'; }

function digest(checkpoint, stale) {
  const id = checkpoint.identity || {};
  const p = checkpoint.payload || {};
  const lines = [];
  lines.push('[RESUME] Continuing project ' + (id.project_id || '?') + (stale ? ' (STALE checkpoint -- confirm before trusting)' : ''));
  if (p.task) lines.push('Task: ' + String(p.task));
  if (p.phase) lines.push('Phase: ' + String(p.phase));
  if (Array.isArray(p.status) && p.status.length) {
    lines.push('Status:');
    for (const s of p.status.slice(0, 12)) lines.push('  - ' + (typeof s === 'string' ? s : JSON.stringify(s)));
  }
  if (Array.isArray(p.decisions) && p.decisions.length) {
    lines.push('Key decisions:');
    for (const d of p.decisions.slice(0, 8)) lines.push('  - ' + (typeof d === 'string' ? d : (d.decision || JSON.stringify(d))));
  }
  if (Array.isArray(p.files_modified) && p.files_modified.length) {
    lines.push('Files in flight: ' + p.files_modified.map(function (f) { return typeof f === 'string' ? f : (f.path || ''); }).filter(Boolean).slice(0, 15).join(', '));
  }
  if (p.next || p.context) lines.push('Next: ' + String(p.next || p.context));
  if (p.auto) lines.push('(auto-backstop checkpoint -- mechanical, not agent-authored)');
  lines.push('Saved: ' + (id.ts || '?') + ' (session ' + (id.session_id || '?') + ')');
  return lines.join('\n');
}

// PURE classifier: turn a resumeCheckpoint() result into a logged outcome + an
// inject decision. An identity REFUSAL (a checkpoint exists but belongs to another
// project/path) is logged as something categorically different from "no checkpoint
// here" -- the two must never be conflated, because a refusal is a contamination
// signal worth noticing, while no-checkpoint is benign.
// Returns { outcome, inject, log }.
function classifyResume(res) {
  res = res || {};
  if (res.found && res.identityOk && res.checkpoint) {
    if (res.stale) {
      return { outcome: 'stale', inject: true, log: '[RESUME] adopted STALE checkpoint -- confirm before trusting' };
    }
    return { outcome: 'ok', inject: true, log: '[RESUME] adopted checkpoint' };
  }
  if (res.found && !res.identityOk) {
    return { outcome: 'identity-refusal', inject: false, log: '[RESUME] REFUSED: checkpoint identity mismatch (cross-project/path contamination guard)' };
  }
  return { outcome: 'no-checkpoint', inject: false, log: '[RESUME] no checkpoint for this project' };
}

function main() {
  let payload = {};
  const raw = readStdin();
  if (raw) { try { payload = JSON.parse(raw); } catch (e) { payload = {}; } }
  const cwd = payload.cwd || process.env.TERMINAL_CWD || process.cwd();
  const sessionId = payload.session_id || '';

  // No stable session id yet (e.g. the first pre_llm_call before the id is assigned):
  // do NOT write a persistent marker. sanitize('') collapses to one shared 'nosession'
  // key that, once written, would permanently suppress resume for every future empty-id
  // session in this project store (no TTL, no cleanup). No-op now; the first turn that
  // carries a real session id performs the once-per-session injection.
  if (!sessionId) { process.stdout.write('{}\n'); return; }

  // Once-per-session guard: marker keyed by the NEW session id, in this project's store dir.
  const dir = cp.storeDirFor({ cwd: cwd });
  const marker = path.join(dir, '.resumed-' + sanitize(sessionId));
  try { if (fs.existsSync(marker)) { process.stdout.write('{}\n'); return; } } catch (e) {}
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(marker, new Date().toISOString() + '\n', 'utf8'); } catch (e) {}

  const res = cp.resumeCheckpoint({ cwd: cwd });
  const verdict = classifyResume(res);
  if (!verdict.inject) { process.stdout.write('{}\n'); return; }
  process.stdout.write(JSON.stringify({ context: digest(res.checkpoint, verdict.outcome === 'stale') }) + '\n');
}

module.exports = { classifyResume: classifyResume, digest: digest };

// CLI / hook entrypoint only -- guarded so `require()` imports the pure functions
// WITHOUT running main() or exiting the process.
if (require.main === module) {
  try { main(); } catch (e) { process.stdout.write('{}\n'); }
  process.exit(0);
}
