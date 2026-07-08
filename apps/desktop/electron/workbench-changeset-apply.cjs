'use strict'

// Hermes Workbench — ChangeSet Apply + Commit (Slice E, go-forward plan §5
// Slice E). This is the FIRST Workbench slice that writes to the user's REAL
// project files — everything before this (Slices A-D/F/J/M/N) only ever
// wrote inside the sandboxed `.hermes/workbench/` tree.
//
// Scope, carried over verbatim from the go-forward plan / Slice D's own
// deferral note:
//   - Apply is a SEPARATE, ADDITIONAL action from Accept/Reject (Slice D).
//     It never changes how a changeset becomes `accepted`, and it does not
//     touch Slice D's `updateChangeSetStatus` status-transition-only path.
//   - Apply requires the changeset to already be in `accepted` status.
//   - Commit is a further separate, explicit action — never auto-triggered
//     by Apply.
//
// Patch application mechanism (the risk-elicitation exercise ahead of this
// slice found `git-review-ops.cjs` is real but belongs to a DIFFERENT
// feature — its `gitFor()` helper, including the packaged-build vendored
// `simple-git` fallback require(), is genuinely reusable; nothing else in
// that file is):
//   - A unified-diff-shaped `file.diff` is applied via the real `git apply`
//     (through `gitFor()`), which requires the workspace to actually be a
//     git repository (`git.checkIsRepo()`).
//   - A `file.diff` that is NOT unified-diff-shaped is treated as the file's
//     complete literal content and written directly. This is the fallback
//     for (a) a workspace that isn't a git repo at all, and (b) any
//     changeset producer that populates `diff` with full file content
//     instead of a real patch — the simplest, actually-testable case, per
//     the go-forward plan's own guidance. This is a judgment call: a human
//     should confirm real changeset producers will only ever emit one of
//     these two shapes, not some third format.
//
// The single most important guard in this file: before writing ANY existing
// file, its current on-disk content hash must match `file.beforeHash`, or
// the write is refused (marked a conflict) and processing continues with the
// other files. This closes the risk this project's own pre-implementation
// risk analysis flagged — a changeset must never silently clobber real work
// the user did after the changeset was proposed.
//
// Path safety reuses the EXACT SAME primitives every other Workbench write
// uses (`resolveWorkspacePath` / `isSafeRelativePath` from
// workbench-artifacts.cjs's `_internal`) — nothing here re-implements path
// containment.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const store = require('./workbench-artifacts.cjs')
const { gitFor } = require('./git-review-ops.cjs')

const { resolveWorkspacePath, isSafeRelativePath, contentHash, atomicWriteFile } = store._internal

// ---------------------------------------------------------------------------
// Diff-format detection
// ---------------------------------------------------------------------------

// A conservative unified-diff sniff: real unified diffs from `git diff`/
// `diff -u` always carry one of these markers. Anything else (e.g. plain
// full-file content) is treated as literal content, never as a patch to
// parse — we never hand-roll unified-diff parsing.
function isUnifiedDiffText(diff) {
  const text = String(diff || '').trimStart()
  return text.startsWith('diff --git ') || text.startsWith('--- ') || /^@@ /m.test(text)
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function isGitRepository(workspaceRoot, gitBin) {
  try {
    return await gitFor(workspaceRoot, gitBin).checkIsRepo()
  } catch {
    return false
  }
}

// Applies one unified diff via the real `git apply` (never a hand-rolled
// unified-diff parser). Writes the diff to a temp file so `git apply` can
// read it as a normal patch file argument, then cleans it up.
async function applyUnifiedDiffToRepo(workspaceRoot, diffText, gitBin) {
  const tmpPath = path.join(
    os.tmpdir(),
    `hermes-workbench-apply-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.patch`
  )
  fs.writeFileSync(tmpPath, diffText, 'utf8')
  try {
    await gitFor(workspaceRoot, gitBin).raw(['apply', '--whitespace=nowarn', tmpPath])
  } finally {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

async function applyChangeSet(workspaceRoot, changesetId, options = {}) {
  const gitBin = options.gitBin

  if (!workspaceRoot || typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
    return { ok: false, message: 'workspaceRoot is required', code: 'MISSING_WORKSPACE_ROOT' }
  }

  const csResult = store.readChangeSet(workspaceRoot, changesetId)
  if (!csResult.ok) return csResult

  const changeset = csResult.value

  // Fail closed: apply is only ever allowed once Slice D's own accept flow
  // has already put the changeset in `accepted` status.
  if (changeset.status !== 'accepted') {
    return {
      ok: false,
      message: 'ChangeSet must be in "accepted" status before it can be applied',
      code: 'NOT_ACCEPTED'
    }
  }

  const isRepo = await isGitRepository(workspaceRoot, gitBin)

  let appliedCount = 0
  let eligibleCount = 0

  for (const file of changeset.files) {
    // Already applied (e.g. a prior partial apply) — leave alone, not
    // reprocessed.
    if (file.status === 'applied') {
      continue
    }

    if (!file.diff || !file.diff.trim()) {
      file.applyResult = 'skipped'
      file.applyMessage = 'No diff to apply'
      continue
    }

    eligibleCount++

    // THE single most important guard in this slice: refuse any path that
    // would resolve outside workspaceRoot. Never write it, and continue with
    // the rest of the changeset rather than aborting everything.
    if (!isSafeRelativePath(file.path)) {
      file.applyResult = 'conflict'
      file.applyMessage = 'Refused: path escapes the workspace'
      continue
    }

    const targetPath = resolveWorkspacePath(workspaceRoot, file.path)
    const exists = fs.existsSync(targetPath)

    if (exists) {
      let currentContent
      try {
        currentContent = fs.readFileSync(targetPath, 'utf8')
      } catch (err) {
        file.applyResult = 'error'
        file.applyMessage = 'Failed to read current file content: ' + err.message
        continue
      }

      const currentHash = contentHash(currentContent)

      // CRITICAL SAFETY CHECK (non-negotiable, runs before every write to an
      // existing file): the file's current on-disk hash must match
      // `beforeHash`, or this file is refused as a conflict rather than
      // silently overwritten. Absence of `beforeHash` on a file that already
      // exists is treated the same as a mismatch — there is no baseline to
      // prove the file hasn't diverged since the changeset was proposed, so
      // this fails closed rather than blindly clobbering real work.
      if (!file.beforeHash || currentHash !== file.beforeHash) {
        file.applyResult = 'conflict'
        file.applyMessage = file.beforeHash
          ? 'File changed on disk since this ChangeSet was proposed (hash mismatch) — not applied'
          : 'File already exists and this ChangeSet recorded no baseline hash — not applied'
        continue
      }
    }

    if (file.binary) {
      // Binary diffs aren't meaningfully textual — out of scope for this
      // slice's patch mechanism (explicit, flagged decision; see the Slice E
      // return notes).
      file.applyResult = 'error'
      file.applyMessage = 'Binary file apply is not supported in this slice'
      continue
    }

    const unified = isUnifiedDiffText(file.diff)

    try {
      if (unified) {
        if (!isRepo) {
          file.applyResult = 'error'
          file.applyMessage = 'Cannot apply a unified diff: workspace is not a git repository'
          continue
        }
        await applyUnifiedDiffToRepo(workspaceRoot, file.diff, gitBin)
      } else {
        // Literal full-file-content fallback — no unified-diff parsing
        // involved. Covers both a non-repo workspace and a changeset
        // producer that populates `diff` with complete file content.
        fs.mkdirSync(path.dirname(targetPath), { recursive: true })
        atomicWriteFile(targetPath, file.diff)
      }

      file.status = 'applied'
      file.applyResult = 'applied'
      delete file.applyMessage
      appliedCount++
    } catch (err) {
      file.applyResult = 'error'
      file.applyMessage = 'Apply failed: ' + (err && err.message ? err.message : String(err))
    }
  }

  if (eligibleCount > 0) {
    if (appliedCount === eligibleCount) {
      changeset.status = 'applied'
    } else if (appliedCount > 0) {
      changeset.status = 'partially_accepted'
    }
    // else: nothing succeeded — leave status as 'accepted', unchanged.
  }

  changeset.updatedAt = new Date().toISOString()

  return store.writeChangeSet(workspaceRoot, changeset)
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

// Stages and commits EXACTLY the files this changeset applied (never
// `git add -A`). Only available when the workspace is a real git repo — the
// caller (IPC handler) is expected to have already fail-closed on missing
// workspaceRoot/changesetId; this function still re-validates before doing
// anything destructive.
async function commitChangeSet(workspaceRoot, changesetId, options = {}) {
  const gitBin = options.gitBin
  const requestedMessage = options.message

  if (!workspaceRoot || typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
    return { ok: false, message: 'workspaceRoot is required', code: 'MISSING_WORKSPACE_ROOT' }
  }

  const csResult = store.readChangeSet(workspaceRoot, changesetId)
  if (!csResult.ok) return csResult

  const changeset = csResult.value
  const appliedFiles = changeset.files.filter((f) => f.status === 'applied')

  if (appliedFiles.length === 0) {
    return { ok: false, message: 'No applied files to commit', code: 'NOTHING_TO_COMMIT' }
  }

  const isRepo = await isGitRepository(workspaceRoot, gitBin)
  if (!isRepo) {
    return { ok: false, message: 'Workspace is not a git repository', code: 'NOT_A_REPO' }
  }

  const git = gitFor(workspaceRoot, gitBin)
  const relativePaths = appliedFiles.map((f) => f.path)

  try {
    // Stage exactly the applied files — never `git add -A`.
    await git.raw(['add', '--', ...relativePaths])
  } catch (err) {
    return { ok: false, message: 'Failed to stage changeset files: ' + err.message, code: 'STAGE_FAILED' }
  }

  const commitMessage =
    (requestedMessage && requestedMessage.trim()) || changeset.title || `ChangeSet ${changeset.id}`

  try {
    // Passing the pathspec after the message restricts the commit to these
    // paths' staged content even if something else was already staged in the
    // repo — this is what makes "stage+commit only these files" true instead
    // of merely "we ran `add` on these files".
    await git.commit(commitMessage, relativePaths)
  } catch (err) {
    return { ok: false, message: 'Failed to commit: ' + err.message, code: 'COMMIT_FAILED' }
  }

  return { ok: true, value: { committed: true, files: relativePaths, message: commitMessage } }
}

module.exports = {
  applyChangeSet,
  commitChangeSet,
  isGitRepository,
  // Exposed for testing.
  _internal: {
    isUnifiedDiffText
  }
}
