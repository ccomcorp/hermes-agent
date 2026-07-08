'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const store = require('./workbench-artifacts.cjs')
const { applyChangeSet, commitChangeSet } = require('./workbench-changeset-apply.cjs')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-apply-test-'))
}

function createTempGitRepo() {
  const dir = createTempWorkspace()
  const git = (...args) => execFileSync('git', args, { cwd: dir })
  git('init', '--quiet')
  // Deterministic identity/newline handling so `git apply`/`git commit` never
  // depend on the host machine's global git config.
  git('config', 'user.email', 'workbench-test@example.com')
  git('config', 'user.name', 'Workbench Test')
  git('config', 'core.autocrlf', 'false')
  return dir
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* ignore */ }
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}

function readFile(dir, relPath) {
  return fs.readFileSync(path.join(dir, relPath), 'utf8')
}

function hashOf(content) {
  return store._internal.contentHash(content)
}

// Builds a changeset directly via the store (bypassing IPC/UI entirely, as
// the task calls for) and immediately transitions it to 'accepted' via
// Slice D's own existing status-transition mechanism — this is legitimate
// test setup, not a new production path.
function createAcceptedChangeSet(ws, files) {
  const created = store.createChangeSet(ws, {
    files,
    source: 'manual',
    summary: 'Test changeset',
    title: 'Test ChangeSet'
  })
  assert.strictEqual(created.ok, true)

  const accepted = store.updateChangeSetStatus(ws, created.value.id, { status: 'accepted' })
  assert.strictEqual(accepted.ok, true)

  return accepted.value
}

const UNIFIED_DIFF = [
  '--- a/foo.txt',
  '+++ b/foo.txt',
  '@@ -1,1 +1,1 @@',
  '-hello',
  '+hello world',
  ''
].join('\n')

// ---------------------------------------------------------------------------
// Clean apply (unified diff, real git repo)
// ---------------------------------------------------------------------------

test('applyChangeSet applies a clean unified diff to a real file and marks it applied', async () => {
  const ws = createTempGitRepo()
  try {
    writeFile(ws, 'foo.txt', 'hello\n')
    const beforeHash = hashOf('hello\n')

    const changeset = createAcceptedChangeSet(ws, [
      { beforeHash, diff: UNIFIED_DIFF, path: 'foo.txt', status: 'pending' }
    ])

    const result = await applyChangeSet(ws, changeset.id, {})

    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.value.status, 'applied')
    assert.strictEqual(result.value.files[0].status, 'applied')
    assert.strictEqual(result.value.files[0].applyResult, 'applied')

    // The REAL on-disk file changed, not just the changeset's own metadata.
    assert.strictEqual(readFile(ws, 'foo.txt'), 'hello world\n')

    // Persisted back to the changeset JSON on disk too.
    const reread = store.readChangeSet(ws, changeset.id)
    assert.strictEqual(reread.value.status, 'applied')
  } finally {
    cleanup(ws)
  }
})

test('applyChangeSet supports literal full-file-content diffs (non-unified fallback) for new files', async () => {
  const ws = createTempGitRepo()
  try {
    const changeset = createAcceptedChangeSet(ws, [
      { diff: '# Brand new file\n', path: 'new-file.md', status: 'pending' }
    ])

    const result = await applyChangeSet(ws, changeset.id, {})

    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.value.status, 'applied')
    assert.strictEqual(readFile(ws, 'new-file.md'), '# Brand new file\n')
  } finally {
    cleanup(ws)
  }
})

test('applyChangeSet writes literal content even when the workspace is not a git repo', async () => {
  const ws = createTempWorkspace()
  try {
    const changeset = createAcceptedChangeSet(ws, [
      { diff: 'plain content\n', path: 'note.txt', status: 'pending' }
    ])

    const result = await applyChangeSet(ws, changeset.id, {})

    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.value.files[0].applyResult, 'applied')
    assert.strictEqual(readFile(ws, 'note.txt'), 'plain content\n')
  } finally {
    cleanup(ws)
  }
})

test('applyChangeSet refuses a unified diff when the workspace is not a git repo', async () => {
  const ws = createTempWorkspace()
  try {
    writeFile(ws, 'foo.txt', 'hello\n')
    const beforeHash = hashOf('hello\n')

    const changeset = createAcceptedChangeSet(ws, [
      { beforeHash, diff: UNIFIED_DIFF, path: 'foo.txt', status: 'pending' }
    ])

    const result = await applyChangeSet(ws, changeset.id, {})

    assert.strictEqual(result.ok, true)
    assert.notStrictEqual(result.value.files[0].status, 'applied')
    assert.strictEqual(result.value.files[0].applyResult, 'error')
    // Real file is untouched.
    assert.strictEqual(readFile(ws, 'foo.txt'), 'hello\n')
  } finally {
    cleanup(ws)
  }
})

// ---------------------------------------------------------------------------
// CRITICAL: the beforeHash conflict guard
// ---------------------------------------------------------------------------

test('applyChangeSet refuses to overwrite a file that changed on disk since the ChangeSet was proposed', async () => {
  const ws = createTempGitRepo()
  try {
    writeFile(ws, 'foo.txt', 'hello\n')
    const beforeHash = hashOf('hello\n')

    // Simulate someone else's edit AFTER the changeset's beforeHash was
    // computed but BEFORE apply runs.
    writeFile(ws, 'foo.txt', 'someone else edited this\n')

    const changeset = createAcceptedChangeSet(ws, [
      { beforeHash, diff: UNIFIED_DIFF, path: 'foo.txt', status: 'pending' }
    ])

    const result = await applyChangeSet(ws, changeset.id, {})

    assert.strictEqual(result.ok, true)
    // The file must be refused, not applied.
    assert.notStrictEqual(result.value.files[0].status, 'applied')
    assert.strictEqual(result.value.files[0].applyResult, 'conflict')
    assert.ok(/hash mismatch/i.test(result.value.files[0].applyMessage))

    // Changeset-level status stays 'accepted' — nothing succeeded.
    assert.strictEqual(result.value.status, 'accepted')

    // The REAL file content must be UNCHANGED from the diverged edit — never
    // overwritten with either the original or the patched content.
    assert.strictEqual(readFile(ws, 'foo.txt'), 'someone else edited this\n')
  } finally {
    cleanup(ws)
  }
})

test('applyChangeSet treats an existing file with no recorded beforeHash as a conflict (fail closed)', async () => {
  const ws = createTempGitRepo()
  try {
    writeFile(ws, 'foo.txt', 'hello\n')

    // No beforeHash recorded at all — there is no baseline to prove the file
    // hasn't diverged, so this must fail closed rather than overwrite.
    const changeset = createAcceptedChangeSet(ws, [
      { diff: UNIFIED_DIFF, path: 'foo.txt', status: 'pending' }
    ])

    const result = await applyChangeSet(ws, changeset.id, {})

    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.value.files[0].applyResult, 'conflict')
    assert.strictEqual(readFile(ws, 'foo.txt'), 'hello\n')
  } finally {
    cleanup(ws)
  }
})

// ---------------------------------------------------------------------------
// Path traversal
// ---------------------------------------------------------------------------

test('applyChangeSet refuses a path-traversal file.path and writes nothing outside the workspace', async () => {
  const ws = createTempGitRepo()
  try {
    const changeset = createAcceptedChangeSet(ws, [
      { diff: 'malicious content\n', path: '../../../etc/passwd', status: 'pending' }
    ])

    const result = await applyChangeSet(ws, changeset.id, {})

    assert.strictEqual(result.ok, true)
    assert.notStrictEqual(result.value.files[0].status, 'applied')
    assert.strictEqual(result.value.files[0].applyResult, 'conflict')
    assert.ok(/escapes the workspace/i.test(result.value.files[0].applyMessage))

    // Nothing was created inside the workspace as a side effect of the
    // traversal attempt (e.g. no stray `etc` directory).
    assert.strictEqual(fs.existsSync(path.join(ws, 'etc')), false)
    // And the resolved-outside path (relative to the workspace parent) was
    // never written either.
    assert.strictEqual(fs.existsSync(path.join(ws, '..', '..', '..', 'etc', 'passwd')), false)
  } finally {
    cleanup(ws)
  }
})

// ---------------------------------------------------------------------------
// Apply gate: only 'accepted' changesets
// ---------------------------------------------------------------------------

test('applyChangeSet refuses a changeset that is not in accepted status', async () => {
  const ws = createTempGitRepo()
  try {
    writeFile(ws, 'foo.txt', 'hello\n')
    const beforeHash = hashOf('hello\n')

    // Deliberately left 'pending' — never transitioned to accepted.
    const created = store.createChangeSet(ws, {
      files: [{ beforeHash, diff: UNIFIED_DIFF, path: 'foo.txt', status: 'pending' }],
      source: 'manual',
      summary: '',
      title: 'Not accepted'
    })
    assert.strictEqual(created.ok, true)
    assert.strictEqual(created.value.status, 'pending')

    const result = await applyChangeSet(ws, created.value.id, {})

    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'NOT_ACCEPTED')
    // Nothing was written.
    assert.strictEqual(readFile(ws, 'foo.txt'), 'hello\n')
  } finally {
    cleanup(ws)
  }
})

test('applyChangeSet fails closed on a missing changeset', async () => {
  const ws = createTempGitRepo()
  try {
    const result = await applyChangeSet(ws, 'does-not-exist', {})
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'NOT_FOUND')
  } finally {
    cleanup(ws)
  }
})

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

test('commitChangeSet stages and commits only the files this changeset applied', async () => {
  const ws = createTempGitRepo()
  try {
    writeFile(ws, 'foo.txt', 'hello\n')
    execFileSync('git', ['add', '-A'], { cwd: ws })
    execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: ws })

    const beforeHash = hashOf('hello\n')
    const changeset = createAcceptedChangeSet(ws, [
      { beforeHash, diff: UNIFIED_DIFF, path: 'foo.txt', status: 'pending' }
    ])

    const applyResult = await applyChangeSet(ws, changeset.id, {})
    assert.strictEqual(applyResult.ok, true)
    assert.strictEqual(applyResult.value.status, 'applied')

    // An UNRELATED file exists on disk, outside the changeset, untracked.
    writeFile(ws, 'unrelated.txt', 'not part of this changeset\n')

    const commitResult = await commitChangeSet(ws, changeset.id, {})

    assert.strictEqual(commitResult.ok, true)
    assert.strictEqual(commitResult.value.committed, true)
    assert.deepStrictEqual(commitResult.value.files, ['foo.txt'])

    const committedFiles = execFileSync('git', ['show', '--stat', '--pretty=format:', 'HEAD'], { cwd: ws })
      .toString('utf8')
    assert.ok(committedFiles.includes('foo.txt'))
    assert.ok(!committedFiles.includes('unrelated.txt'))

    // The unrelated file must still be untracked/uncommitted afterward.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: ws }).toString('utf8')
    assert.ok(status.includes('unrelated.txt'))
  } finally {
    cleanup(ws)
  }
})

test('commitChangeSet is refused when the workspace is not a git repository', async () => {
  const ws = createTempWorkspace()
  try {
    const changeset = createAcceptedChangeSet(ws, [
      { diff: 'plain content\n', path: 'note.txt', status: 'pending' }
    ])

    const applyResult = await applyChangeSet(ws, changeset.id, {})
    assert.strictEqual(applyResult.ok, true)
    assert.strictEqual(applyResult.value.files[0].status, 'applied')

    const commitResult = await commitChangeSet(ws, changeset.id, {})

    assert.strictEqual(commitResult.ok, false)
    assert.strictEqual(commitResult.code, 'NOT_A_REPO')
  } finally {
    cleanup(ws)
  }
})

test('commitChangeSet refuses when nothing has been applied yet', async () => {
  const ws = createTempGitRepo()
  try {
    writeFile(ws, 'foo.txt', 'hello\n')
    const beforeHash = hashOf('hello\n')
    const changeset = createAcceptedChangeSet(ws, [
      { beforeHash, diff: UNIFIED_DIFF, path: 'foo.txt', status: 'pending' }
    ])

    // Deliberately never applied.
    const commitResult = await commitChangeSet(ws, changeset.id, {})

    assert.strictEqual(commitResult.ok, false)
    assert.strictEqual(commitResult.code, 'NOTHING_TO_COMMIT')
  } finally {
    cleanup(ws)
  }
})
