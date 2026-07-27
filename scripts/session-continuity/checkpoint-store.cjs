#!/usr/bin/env node
'use strict';

/*
 * checkpoint-store.cjs -- AGNOSTIC session-continuity primitive.
 *
 * This is the runtime-agnostic core, not a Claude or Hermes binding. It owns
 * three things and nothing else: per-project storage, the identity envelope,
 * and the resume-time identity cross-check + TTL. The CHECKPOINT CONTENT
 * (task/phase/status/decisions/gotchas/files/context) is an OPAQUE payload
 * authored by the calling agent -- the primitive never interprets it. The
 * thin wire-protocol adapters live beside this file (resume-hook.cjs,
 * autosave-hook.cjs); the hermes runner / any other caller calls
 * save()/resume() directly or via the CLI, unchanged.
 *
 * WHAT IT GUARANTEES (each rule is a learned lesson):
 *   1. Checkpoints are PER-PROJECT, never global. project_id is derived from
 *      the session's working directory (the only identity signal hermes-agent
 *      exposes -- runtime_cwd.py). Store: {storeRoot}/{project_id}/, latest.json pointer.
 *   2. resume() CROSS-CHECKS IDENTITY (stored cwd vs current cwd) before adopting
 *      a checkpoint and REFUSES on mismatch -- a cross-project contamination guard.
 *      Stale checkpoints (> ttlHours) are returned but flagged stale:true -- a HINT
 *      needing confirmation, not truth.
 *   3. The identity envelope {project_id, cwd, session_id, parent_session_id, ts}
 *      stamps every checkpoint.
 *
 * STORE ROOT resolution (first match wins): opts.storeRoot -> env
 * HERMES_CHECKPOINT_ROOT -> default {cwd}/data/checkpoints.
 * Each project_id gets its own subdir under the store root.
 *
 * Pure Node stdlib, ASCII-only source, UTF-8 no-BOM, LF. CLI- or require()-callable.
 *
 * Ported from AIOS/AIOS packages/session/checkpoint-store.cjs (2026-07-27) -- zero
 * AIOS dependency; env var renamed AIOS_CHECKPOINT_ROOT -> HERMES_CHECKPOINT_ROOT.
 *
 * USAGE
 *   node scripts/session-continuity/checkpoint-store.cjs save   --cwd <dir> --session <id>
 *        [--parent <id>] [--payload-file <json>] [--payload <json>]
 *        [--store-root <dir>] [--actor <name>]
 *   node scripts/session-continuity/checkpoint-store.cjs resume --cwd <dir>
 *        [--store-root <dir>] [--ttl-hours <n>]
 *   node scripts/session-continuity/checkpoint-store.cjs project-id --cwd <dir>
 *   const { saveCheckpoint, resumeCheckpoint, projectIdFromCwd } = require('.../checkpoint-store.cjs')
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 'hermes.checkpoint.v1';
const DEFAULT_TTL_HOURS = 24;
// Windows (and macOS default) filesystems are case-insensitive: D:\HeicH\hermes-agent
// and d:\heich\hermes-agent are the SAME directory. Fold identity comparisons on these
// platforms so one project never splits into two identities over path casing.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function nowTs() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function tsForFile(ts) { return ts.replace(/[:.]/g, '-').replace(/Z$/, ''); }

// Normalize a cwd to a stable canonical form: realpath when possible, then
// resolve; lowercase the Windows drive letter so D:\ and d:\ agree.
function canonicalCwd(cwd) {
  let p = cwd;
  // realpathSync.native resolves to the TRUE on-disk casing on case-insensitive
  // filesystems, so a mis-cased input canonicalizes to the same string as the
  // real path. Fall back progressively when the path does not exist yet
  // (.native -> realpath -> resolve).
  try { p = fs.realpathSync.native(cwd); }
  catch (e1) {
    try { p = fs.realpathSync(cwd); }
    catch (e2) { p = path.resolve(cwd); }
  }
  p = p.replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:/.test(p)) p = p.charAt(0).toLowerCase() + p.slice(1);
  return p;
}

// project_id = <basename>-<sha1(canonicalCwd)[:8]>: human-readable + collision-safe.
function projectIdFromCwd(cwd) {
  const canon = canonicalCwd(cwd);
  const base = (path.basename(canon) || 'root').replace(/[^A-Za-z0-9._-]/g, '-');
  const hash = crypto.createHash('sha1').update(canon).digest('hex').slice(0, 8);
  return base + '-' + hash;
}

function resolveStoreRoot(opts) {
  if (opts && opts.storeRoot) return path.resolve(opts.storeRoot);
  if (process.env.HERMES_CHECKPOINT_ROOT) return path.resolve(process.env.HERMES_CHECKPOINT_ROOT);
  return path.join(path.resolve(opts && opts.cwd ? opts.cwd : '.'), 'data', 'checkpoints');
}

function storeDirFor(opts) {
  return path.join(resolveStoreRoot(opts), projectIdFromCwd(opts.cwd));
}

function latestPath(dir) { return path.join(dir, 'latest.json'); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

/**
 * saveCheckpoint(opts) -> { wrote, path, latest, projectId, reason }
 *   opts: { cwd (req), sessionId (req), parentSessionId?, payload (req, opaque object),
 *           storeRoot?, actor?, ts?, dryRun? }
 */
function saveCheckpoint(opts) {
  opts = opts || {};
  if (!opts.cwd) return { wrote: false, reason: 'no-cwd' };
  if (!opts.sessionId) return { wrote: false, reason: 'no-session-id' };
  if (opts.payload === undefined || opts.payload === null) return { wrote: false, reason: 'no-payload' };

  const ts = opts.ts || nowTs();
  const projectId = projectIdFromCwd(opts.cwd);
  const dir = storeDirFor(opts);

  const record = {
    schema: SCHEMA,
    identity: {
      project_id: projectId,
      cwd: canonicalCwd(opts.cwd),
      session_id: opts.sessionId,
      parent_session_id: opts.parentSessionId || '',
      ts: ts,
      actor: opts.actor || 'hermes-runtime'
    },
    payload: opts.payload
  };

  const fileName = 'checkpoint-' + tsForFile(ts) + '.json';
  const filePath = path.join(dir, fileName);
  if (opts.dryRun) return { wrote: false, reason: 'dry-run', path: filePath, projectId, record };

  fs.mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(record, null, 2) + '\n';
  // Atomic-ish: write the timestamped file, then point latest.json at it (tmp->rename).
  fs.writeFileSync(filePath, text, 'utf8');
  const latest = latestPath(dir);
  const tmp = latest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({ checkpointFile: fileName }, record), null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, latest);
  return { wrote: true, reason: 'saved', path: filePath, latest: latest, projectId: projectId };
}

/**
 * resumeCheckpoint(opts) -> { found, checkpoint?, projectId, identityOk, stale, ageHours?, reason }
 *   opts: { cwd (req), storeRoot?, ttlHours?, nowTs? }
 * Identity mismatch -> found:true, identityOk:false, reason:'identity-mismatch' (REFUSE: do not adopt).
 * Stale            -> found:true, identityOk:true,  stale:true (HINT: confirm before trusting).
 */
function resumeCheckpoint(opts) {
  opts = opts || {};
  if (!opts.cwd) return { found: false, reason: 'no-cwd' };

  const projectId = projectIdFromCwd(opts.cwd);
  const dir = storeDirFor(opts);
  const record = readJson(latestPath(dir));
  if (!record) return { found: false, projectId: projectId, reason: 'no-checkpoint' };

  const ident = record.identity || {};
  const currentCanon = canonicalCwd(opts.cwd);
  // On case-insensitive filesystems, compare identity case-insensitively so a
  // checkpoint saved under one path casing still adopts when resumed under another.
  const eqId = CASE_INSENSITIVE_FS
    ? String(ident.project_id || '').toLowerCase() === projectId.toLowerCase()
    : ident.project_id === projectId;
  const eqCwd = CASE_INSENSITIVE_FS
    ? String(ident.cwd || '').toLowerCase() === currentCanon.toLowerCase()
    : ident.cwd === currentCanon;
  const identityOk = eqId && eqCwd;
  if (!identityOk) {
    return { found: true, projectId: projectId, identityOk: false, stale: false,
             reason: 'identity-mismatch',
             detail: 'checkpoint belongs to ' + (ident.project_id || '?') + ' (' + (ident.cwd || '?') + '); current is ' + projectId + ' (' + currentCanon + ')' };
  }

  const ttlHours = (typeof opts.ttlHours === 'number') ? opts.ttlHours : DEFAULT_TTL_HOURS;
  const savedMs = Date.parse(ident.ts || '');
  const nowMs = Date.parse(opts.nowTs || nowTs());
  const ageHours = (isFinite(savedMs) && isFinite(nowMs)) ? (nowMs - savedMs) / 3600000 : null;
  const stale = (ageHours !== null) && (ageHours > ttlHours);

  return { found: true, projectId: projectId, identityOk: true, stale: stale,
           ageHours: ageHours, reason: stale ? 'stale' : 'ok', checkpoint: record };
}

module.exports = { saveCheckpoint, resumeCheckpoint, projectIdFromCwd, storeDirFor, canonicalCwd, SCHEMA };

/* ---- CLI (agnostic; fail-loud on bad args) ---- */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opts = {};
  let payloadInline = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--session') opts.sessionId = argv[++i];
    else if (a === '--parent') opts.parentSessionId = argv[++i];
    else if (a === '--store-root') opts.storeRoot = argv[++i];
    else if (a === '--actor') opts.actor = argv[++i];
    else if (a === '--ttl-hours') opts.ttlHours = Number(argv[++i]);
    else if (a === '--payload') payloadInline = argv[++i];
    else if (a === '--payload-file') { try { payloadInline = fs.readFileSync(argv[++i], 'utf8'); } catch (e) { process.stderr.write('checkpoint-store: cannot read --payload-file\n'); process.exit(2); } }
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '-h' || a === '--help') { process.stdout.write('usage: checkpoint-store.cjs <save|resume|project-id> --cwd <dir> [...]\n'); process.exit(0); }
    else { process.stderr.write('checkpoint-store: error: unknown argument: ' + a + '\n'); process.exit(2); }
  }

  if (cmd === 'project-id') {
    if (!opts.cwd) { process.stderr.write('checkpoint-store: error: --cwd is required\n'); process.exit(2); }
    process.stdout.write(projectIdFromCwd(opts.cwd) + '\n');
    process.exit(0);
  } else if (cmd === 'save') {
    if (!opts.cwd || !opts.sessionId) { process.stderr.write('checkpoint-store: error: save needs --cwd and --session\n'); process.exit(2); }
    if (payloadInline !== null) { try { opts.payload = JSON.parse(payloadInline); } catch (e) { process.stderr.write('checkpoint-store: error: --payload is not valid JSON\n'); process.exit(2); } }
    else opts.payload = {};
    const res = saveCheckpoint(opts);
    process.stdout.write(JSON.stringify(res) + '\n');
    process.exit(res.wrote || res.reason === 'dry-run' ? 0 : 1);
  } else if (cmd === 'resume') {
    if (!opts.cwd) { process.stderr.write('checkpoint-store: error: resume needs --cwd\n'); process.exit(2); }
    const res = resumeCheckpoint(opts);
    process.stdout.write(JSON.stringify(res) + '\n');
    process.exit(0);
  } else {
    process.stderr.write('checkpoint-store: error: first arg must be save | resume | project-id\n');
    process.exit(2);
  }
}
