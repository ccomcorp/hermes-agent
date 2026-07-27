#!/usr/bin/env node
'use strict';

// session-end-hook.cjs -- THIN binding for the agnostic session-summary primitive
// (session-summary.cjs). This file only: read the SessionEnd/on_session_end stdin
// payload -> derive the session id + project root -> call reconcileSession().
//
// Fully FAIL-OPEN: a backstop failure must never disrupt session end. Reads one JSON
// object from stdin, writes "{}", ALWAYS exits 0. Side-effecting only (the primitive
// appends one journal line); emits no systemMessage. Pure Node stdlib, ASCII-only.
//
// Ported from AIOS/AIOS packages/constraints/hooks/session-end.cjs (2026-07-27):
// now passes `root: req.cwd` through to reconcileSession() so the journal entry
// lands in the SESSION'S OWN project (previously this always resolved to the AIOS
// repo's own journal, regardless of which project the session was actually in).

const path = require('path');

// Session id precedence: explicit session_id, else derive from the transcript
// filename, else empty (-> primitive no-ops).
function deriveSessionId(req) {
  if (req && typeof req.session_id === 'string' && req.session_id) return req.session_id;
  if (req && typeof req.transcript_path === 'string' && req.transcript_path) {
    let b = path.basename(req.transcript_path);
    if (b.toLowerCase().endsWith('.jsonl')) b = b.slice(0, -('.jsonl'.length));
    if (b) return 'sess-' + b;
  }
  return '';
}

function main() {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (c) { data += c; });
  process.stdin.on('end', function () {
    try {
      const req = JSON.parse(data || '{}');
      const sessionId = deriveSessionId(req);
      const root = (req && typeof req.cwd === 'string' && req.cwd) ? req.cwd : process.cwd();
      if (sessionId) {
        const primitive = require(path.resolve(__dirname, 'session-summary.cjs'));
        primitive.reconcileSession({ sessionId: sessionId, root: root, actor: 'hermes-runtime', parentSessionId: (req && req.parent_session_id) || '' });
      }
    } catch (e) {
      // Fail-open: the session-end backstop must never throw on session end.
    }
    try { process.stdout.write('{}'); } catch (e2) {}
    process.exit(0);
  });
  process.stdin.on('error', function () {
    try { process.stdout.write('{}'); } catch (e) {}
    process.exit(0);
  });
}

main();
