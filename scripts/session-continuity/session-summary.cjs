#!/usr/bin/env node
'use strict';

/*
 * session-summary.cjs -- AGNOSTIC session-end reconciler.
 *
 * This is the runtime-agnostic primitive, not a binding. It takes a sessionId
 * and a project root, reads that project's journal, and appends exactly one
 * canonical `session-summary` entry carrying a `summary` plus a
 * `changelog.maintained` reconciliation in constraint_events. It is callable
 * as a CLI or via require() -- so the caller invokes it from its own session
 * lifecycle unchanged. The thin, replaceable binding is session-end-hook.cjs.
 *
 * BACKSTOP semantics: a session that did work but never recorded a `session-summary`
 * (the agent forgot, or /save-checkpoint was skipped) gets one written automatically
 * at session end -- the journal's "every session produces a summary" discipline
 * enforced by the runtime, not by agent goodwill. Idempotent: if a `session-summary`
 * already exists for the session it is a no-op (unless --force).
 *
 * CHANGELOG reconciliation: if the session modified source files (under
 * agent/scripts/apps/plugins/gateway/hermes_cli/tools) without touching any
 * CHANGELOG.md, the summary entry records a `changelog.maintained` constraint_event
 * with status `warn` (durable, in the journal -- better than an ephemeral
 * end-of-session message); `pass` when a source change was paired with a
 * CHANGELOG touch.
 *
 * On-disk shape (ts, project_id, session_id, parent_session_id, actor, action_class,
 * targets, artifacts, constraint_events, decisions, [summary]) -- `summary` LAST,
 * present only here. UTF-8 no-BOM, LF, single line. Pure Node stdlib, ASCII-only source.
 *
 * Ported from AIOS/AIOS packages/journal/session-summary.cjs (2026-07-27):
 *   - `root` is now REQUIRED (opts.root / --root), resolved by the caller from the
 *     session's own cwd, instead of defaulting to this script's own repo location.
 *     The AIOS original silently defaulted to `repoRootFromHere()` (the AIOS repo
 *     itself), so every session-end reconciliation for a hermes-agent session was
 *     writing into AIOS's journal, not hermes-agent's -- a real bug, fixed by this port.
 *   - The optional `doxCheck` opt-in (AIOS's own scripts/dox-check.cjs gate) has been
 *     dropped: hermes-agent has its own native DOX engine (agent/dox/, hermes_cli/dox.py)
 *     and does not depend on the AIOS dox-check tool.
 *
 * USAGE
 *    node scripts/session-continuity/session-summary.cjs --session <id> --root <dir>
 *                                              [--parent <id>] [--force] [--dry-run]
 *    const { reconcileSession } = require('.../session-continuity/session-summary.cjs')
 */

const fs = require('fs');
const path = require('path');

// First path segment that marks editable source (a change here expects a changelog touch).
const SOURCE_TOPS = ['agent', 'scripts', 'apps', 'plugins', 'gateway', 'hermes_cli', 'tools'];

function journalPaths(root) {
  const dir = path.join(root, 'data', 'telemetry');
  return { dir, file: path.join(dir, 'journal.jsonl') };
}

function readSessionEntries(file, sessionId) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch (e) { continue; }
    if (obj && obj.session_id === sessionId) out.push(obj);
  }
  return out;
}

function relOfTarget(t) {
  const rel = (typeof t === 'string') ? t : (t && typeof t.path === 'string' ? t.path : '');
  return rel.replace(/\\/g, '/');
}
function topSeg(rel) { return rel.split('/').filter(Boolean)[0] || ''; }
function isSourceTarget(rel) { return SOURCE_TOPS.indexOf(topSeg(rel)) !== -1; }
function isChangelogTarget(rel) { return /(^|\/)changelog\.md$/i.test(rel); }

function nowTs() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function jsonLine(obj) { return JSON.stringify(obj).replace(/[\r\n]/g, ''); }

// Canonical session-summary entry; `summary` appended LAST (matches on-disk convention).
function buildEntry(o) {
  const entry = {
    ts: o.ts,
    project_id: o.projectId,
    session_id: o.sessionId,
    parent_session_id: o.parentSessionId || '',
    actor: o.actor,
    action_class: 'session-summary',
    targets: o.targets || [],
    artifacts: [],
    constraint_events: o.constraintEvents || [],
    decisions: o.decisions || []
  };
  if (o.summary) entry.summary = o.summary;
  return entry;
}

/**
 * reconcileSession(opts) -> { wrote, reason, sessionId, entry? }
 *   opts: { sessionId (req), root (req), parentSessionId?, actor?, projectId?, ts?, force?, dryRun? }
 */
function reconcileSession(opts) {
  opts = opts || {};
  const sessionId = opts.sessionId || '';
  if (!sessionId) return { wrote: false, reason: 'no-session-id' };
  if (!opts.root) return { wrote: false, reason: 'no-root' };

  const root = path.resolve(opts.root);
  const actor = opts.actor || 'hermes-runtime';
  const projectId = opts.projectId || path.basename(root);
  const ts = opts.ts || nowTs();
  const { dir, file } = journalPaths(root);

  const entries = readSessionEntries(file, sessionId);
  if (!opts.force && entries.some((e) => e.action_class === 'session-summary')) {
    return { wrote: false, reason: 'already-summarized', sessionId };
  }
  if (entries.length === 0) {
    return { wrote: false, reason: 'no-activity', sessionId };
  }

  let created = 0, modified = 0, sourceChanged = false, changelogTouched = false;
  const targetSet = new Set();
  for (const e of entries) {
    if (e.action_class === 'file-create') created++;
    else if (e.action_class === 'file-modify') modified++;
    const tgs = Array.isArray(e.targets) ? e.targets : [];
    const isEdit = (e.action_class === 'file-create' || e.action_class === 'file-modify');
    for (const t of tgs) {
      const rel = relOfTarget(t);
      if (!rel) continue;
      targetSet.add(rel);
      if (isEdit && isSourceTarget(rel)) sourceChanged = true;
      if (isEdit && isChangelogTarget(rel)) changelogTouched = true;
    }
  }
  const distinct = targetSet.size;

  const constraintEvents = [];
  if (sourceChanged && !changelogTouched) {
    constraintEvents.push({ constraint: 'changelog.maintained', status: 'warn', detail: 'source files changed this session with no CHANGELOG.md touch -- add a [Unreleased] entry' });
  } else if (sourceChanged && changelogTouched) {
    constraintEvents.push({ constraint: 'changelog.maintained', status: 'pass', detail: 'source change paired with a CHANGELOG.md touch this session' });
  }

  const clNote = sourceChanged ? (changelogTouched ? 'changelog touched' : 'CHANGELOG NOT touched') : 'no source changes';
  const summary = 'Session backstop: ' + entries.length + ' journal event(s); ' + created + ' created, ' + modified + ' modified across ' + distinct + ' path(s); ' + clNote + '.';

  const entry = buildEntry({ ts, projectId, sessionId, parentSessionId: opts.parentSessionId, actor, targets: [], constraintEvents, decisions: [], summary });

  if (opts.dryRun) return { wrote: false, reason: 'dry-run', sessionId, entry };

  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  fs.appendFileSync(file, jsonLine(entry) + '\n', 'utf8');
  return { wrote: true, reason: 'appended', sessionId, entry };
}

module.exports = { reconcileSession };

/* ---- CLI (agnostic; fail-loud on bad args) -------------- */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session') opts.sessionId = argv[++i];
    else if (a === '--root') opts.root = argv[++i];
    else if (a === '--parent') opts.parentSessionId = argv[++i];
    else if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write('usage: node session-summary.cjs --session <id> --root <dir> [--parent <id>] [--force] [--dry-run]\n');
      process.exit(0);
    } else { process.stderr.write('session-summary: error: unknown argument: ' + a + '\n'); process.exit(2); }
  }
  if (!opts.sessionId) { process.stderr.write('session-summary: error: --session <id> is required\n'); process.exit(2); }
  if (!opts.root) { process.stderr.write('session-summary: error: --root <dir> is required\n'); process.exit(2); }
  const res = reconcileSession(opts);
  process.stdout.write(JSON.stringify(res) + '\n');
  process.exit(0);
}
