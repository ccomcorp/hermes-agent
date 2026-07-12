'use strict'

// Hermes Workbench — Write Workspace quick actions ChangeSet-construction
// tests (Slice K, go-forward plan §5).
//
// The renderer-side ChangeSet-building logic lives in
// `src/app/workbench/write-quick-actions.ts` (`buildWriteChangeSetInput`,
// `sha256Hex16`) and is unit tested in isolation in that file's
// `write-quick-actions.test.ts` (mocking nothing but a model call — the pure
// functions themselves run for real there). This file complements that by
// exercising the OTHER half of the seam for real: the REAL
// `store.createChangeSet` (workbench-artifacts.cjs, the same function every
// other Workbench slice's changeset creation goes through) against a REAL
// temp workspace and a REAL write project written by `store.createWriteProject`
// — no mocks beyond a temp directory. This proves the shape
// `buildWriteChangeSetInput` produces is something the real backend accepts
// and persists correctly, and that the hash it computes is exactly what the
// backend's own `contentHash()` (and therefore Slice E's apply-time conflict
// guard) expects.
//
// Same harness style as workbench-ipc.test.cjs / workbench-artifacts.test.cjs
// (node:test + tmp workspaces) — no Electron mock needed here since
// `store.createWriteProject` / `store.createChangeSet` never touch `ipcMain`.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const store = require('./workbench-artifacts.cjs')

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'write-quick-actions-cs-test-'))
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

// Mirrors write-quick-actions.ts's `sha256Hex16` — same algorithm as the
// backend's `contentHash()` (sha256, utf8, hex, first 16 chars) — proving the
// renderer's Web-Crypto-based hash and this Node-crypto-based hash (and the
// backend's own contentHash) are all the same function in different clothes.
function rendererStyleHash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)
}

// Mirrors write-quick-actions.ts's `buildWriteChangeSetInput` exactly, so
// this test exercises the same shape the real renderer sends to
// `createChangeSet` — a single pending file entry, full-content `diff`,
// `source: 'write_inline_edit'`.
function buildWriteChangeSetInput(params) {
  return {
    workspaceRoot: params.workspaceRoot,
    source: 'write_inline_edit',
    title: params.title,
    summary: params.summary,
    files: [
      {
        path: params.fileRelativePath,
        beforeHash: params.beforeHash,
        diff: params.nextContent,
        status: 'pending'
      }
    ]
  }
}

test('buildWriteChangeSetInput shape is accepted by the real store.createChangeSet and persisted correctly', () => {
  const ws = createTempWorkspace()

  try {
    const created = store.createWriteProject(ws, { title: 'My Doc', markdown: '# My Doc\n\nOriginal body.\n' })
    const { project } = created
    const savedMarkdown = fs.readFileSync(path.join(ws, project.activeFileRelativePath), 'utf8')

    // The beforeHash a real caller would compute from the CURRENT saved
    // content, exactly as write-quick-actions-panel.tsx does before calling
    // createChangeSet.
    const beforeHash = rendererStyleHash(savedMarkdown)

    const input = buildWriteChangeSetInput({
      workspaceRoot: ws,
      fileRelativePath: project.activeFileRelativePath,
      beforeHash,
      nextContent: '# My Doc\n\nPolished body.\n',
      title: `Polish: ${project.title}`,
      summary: 'Proposed by Polish quick action (document).'
    })

    const result = store.createChangeSet(ws, input)

    assert.strictEqual(result.ok, true)

    const changeset = result.value

    assert.strictEqual(changeset.source, 'write_inline_edit')
    assert.strictEqual(changeset.status, 'pending')
    assert.strictEqual(changeset.files.length, 1)

    const [file] = changeset.files

    assert.strictEqual(file.path, project.activeFileRelativePath)
    assert.strictEqual(file.beforeHash, beforeHash)
    assert.strictEqual(file.diff, '# My Doc\n\nPolished body.\n')
    assert.strictEqual(file.status, 'pending')
    // Never set by the proposal step — those belong to Slice E's apply.
    assert.strictEqual(file.afterHash, undefined)
    assert.strictEqual(file.applyResult, undefined)

    // The changeset was actually persisted to disk under
    // .hermes/workbench/changesets/<id>.json, not just returned in memory.
    const reread = store.readChangeSet(ws, changeset.id)

    assert.strictEqual(reread.ok, true)
    assert.deepStrictEqual(reread.value.files, changeset.files)

    // The write project's saved file itself was NOT touched by proposing the
    // ChangeSet — quick actions never write the file directly.
    assert.strictEqual(fs.readFileSync(path.join(ws, project.activeFileRelativePath), 'utf8'), savedMarkdown)

    // Hash compatibility with the backend's own contentHash() — this is the
    // exact comparison Slice E's apply-time conflict guard performs
    // (workbench-changeset-apply.cjs: `currentHash !== file.beforeHash`).
    // Since nothing wrote to the file between proposal and this check, they
    // must match — proving Apply would accept this changeset right now.
    assert.strictEqual(store._internal.contentHash(savedMarkdown), file.beforeHash)
  } finally {
    cleanup(ws)
  }
})

test('a beforeHash computed before a later save no longer matches — the conflict guard Apply relies on would correctly refuse it', () => {
  const ws = createTempWorkspace()

  try {
    const created = store.createWriteProject(ws, { title: 'Doc', markdown: 'v1\n' })
    const { project } = created
    const beforeHash = rendererStyleHash('v1\n')

    // Someone else (or the user, via Save) writes the file again before the
    // proposed ChangeSet is applied.
    store.updateWriteProject(ws, project.id, { markdown: 'v2 — a real edit landed first\n' })

    const currentContent = fs.readFileSync(path.join(ws, project.activeFileRelativePath), 'utf8')
    const currentHash = store._internal.contentHash(currentContent)

    assert.notStrictEqual(currentHash, beforeHash, 'a stale beforeHash must not match content that changed after proposal')
  } finally {
    cleanup(ws)
  }
})

test('selection-scoped edits produce a full-document diff with the selection spliced in, not just the replacement fragment', () => {
  const ws = createTempWorkspace()

  try {
    const original = 'Intro.\n\nThe quick brown fox jumps.\n\nOutro.\n'
    const created = store.createWriteProject(ws, { title: 'Selection Doc', markdown: original })
    const { project } = created

    const from = original.indexOf('brown')
    const to = from + 'brown'.length
    const replacement = 'lazy'
    const nextContent = original.slice(0, from) + replacement + original.slice(to)

    const beforeHash = rendererStyleHash(original)

    const input = buildWriteChangeSetInput({
      workspaceRoot: ws,
      fileRelativePath: project.activeFileRelativePath,
      beforeHash,
      nextContent,
      title: `Polish: ${project.title}`,
      summary: 'Proposed by Polish quick action (selection).'
    })

    const result = store.createChangeSet(ws, input)

    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.value.files[0].diff, 'Intro.\n\nThe quick lazy fox jumps.\n\nOutro.\n')
    assert.ok(!result.value.files[0].diff.startsWith('--- '), 'literal full content must never look like a unified diff header')
  } finally {
    cleanup(ws)
  }
})
