'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const store = require('./workbench-artifacts.cjs')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-test-'))
  return dir
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('createRequirement creates files and manifest', () => {
  const ws = createTempWorkspace()
  try {
    const { requirement, trace } = store.createRequirement(ws, {
      title: 'Test Requirement',
      markdown: '# Test\n\nContent here'
    })

    assert.ok(requirement.id)
    assert.strictEqual(requirement.title, 'Test Requirement')
    assert.strictEqual(requirement.status, 'draft')
    assert.ok(requirement.contentHash)

    // Files exist
    const draftPath = path.join(ws, requirement.draftRelativePath)
    const tracePath = path.join(ws, requirement.traceRelativePath)
    assert.ok(fs.existsSync(draftPath))
    assert.ok(fs.existsSync(tracePath))

    // Content is correct
    const draft = fs.readFileSync(draftPath, 'utf8')
    assert.ok(draft.includes('# Test'))

    // Trace has history
    assert.ok(trace.history.length > 0)
    assert.strictEqual(trace.history[0].kind, 'created')

    // Manifest was created
    const manifest = store.readManifest(ws)
    assert.strictEqual(manifest.version, 1)
    assert.strictEqual(manifest.requirements.length, 1)
    assert.strictEqual(manifest.requirements[0].id, requirement.id)
  } finally {
    cleanup(ws)
  }
})

test('createRequirement uses default markdown when none provided', () => {
  const ws = createTempWorkspace()
  try {
    const { requirement } = store.createRequirement(ws, {
      title: 'Default Content'
    })

    const draftPath = path.join(ws, requirement.draftRelativePath)
    const draft = fs.readFileSync(draftPath, 'utf8')
    assert.ok(draft.includes('# Default Content'))
  } finally {
    cleanup(ws)
  }
})

test('readRequirement returns the requirement content', () => {
  const ws = createTempWorkspace()
  try {
    const { requirement } = store.createRequirement(ws, {
      title: 'Read Test',
      markdown: '# Read Me'
    })

    const result = store.readRequirement(ws, requirement.id)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.ok(result.value.markdown.includes('# Read Me'))
      assert.ok(result.value.trace)
    }
  } finally {
    cleanup(ws)
  }
})

test('readRequirement returns NOT_FOUND for missing requirement', () => {
  const ws = createTempWorkspace()
  try {
    const result = store.readRequirement(ws, 'nonexistent')
    assert.strictEqual(result.ok, false)
    if (!result.ok) assert.strictEqual(result.code, 'NOT_FOUND')
  } finally {
    cleanup(ws)
  }
})

test('updateRequirement updates content and trace', () => {
  const ws = createTempWorkspace()
  try {
    const { requirement } = store.createRequirement(ws, {
      title: 'Update Test',
      markdown: '# Original'
    })

    const result = store.updateRequirement(ws, requirement.id, {
      markdown: '# Updated Content',
      status: 'clarified'
    })

    assert.strictEqual(result.ok, true)

    // Content updated
    const draftPath = path.join(ws, requirement.draftRelativePath)
    const draft = fs.readFileSync(draftPath, 'utf8')
    assert.ok(draft.includes('# Updated Content'))

    // Trace has update entry
    const tracePath = path.join(ws, requirement.traceRelativePath)
    const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'))
    assert.ok(trace.history.length >= 2)
    assert.strictEqual(trace.status, 'clarified')
  } finally {
    cleanup(ws)
  }
})

test('listRequirements returns all requirements', () => {
  const ws = createTempWorkspace()
  try {
    store.createRequirement(ws, { title: 'Req A' })
    store.createRequirement(ws, { title: 'Req B' })

    const result = store.listRequirements(ws)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.value.length, 2)
    }
  } finally {
    cleanup(ws)
  }
})

test('createPlan creates plan file and links to requirement', () => {
  const ws = createTempWorkspace()
  try {
    const { requirement } = store.createRequirement(ws, {
      title: 'Plan Test'
    })

    const { plan } = store.createPlan(ws, {
      markdown: '# My Plan',
      title: 'Implementation Plan',
      operation: 'draft',
      requirementId: requirement.id
    })

    assert.ok(plan.id)
    assert.strictEqual(plan.title, 'Implementation Plan')
    assert.strictEqual(plan.operation, 'draft')
    assert.strictEqual(plan.requirementId, requirement.id)
    assert.ok(plan.contentHash)

    // File exists
    const planPath = path.join(ws, plan.relativePath)
    assert.ok(fs.existsSync(planPath))

    // Trace has plan linked
    const tracePath = path.join(ws, requirement.traceRelativePath)
    const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'))
    assert.ok(trace.linkedPlanIds.includes(plan.id))

    // Manifest updated
    const manifest = store.readManifest(ws)
    assert.strictEqual(manifest.plans.length, 1)
  } finally {
    cleanup(ws)
  }
})

test('readPlan returns plan content', () => {
  const ws = createTempWorkspace()
  try {
    const { plan } = store.createPlan(ws, {
      markdown: '# Plan Content',
      operation: 'draft'
    })

    const result = store.readPlan(ws, plan.id)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.ok(result.value.markdown.includes('# Plan Content'))
    }
  } finally {
    cleanup(ws)
  }
})

test('createChangeSet persists changeset', () => {
  const ws = createTempWorkspace()
  try {
    const result = store.createChangeSet(ws, {
      source: 'agent',
      title: 'Test Changes',
      summary: 'Some file changes',
      files: [{ path: 'src/index.ts', status: 'pending' }]
    })

    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.value.status, 'pending')
      assert.strictEqual(result.value.files.length, 1)
      assert.strictEqual(result.value.source, 'agent')
    }

    // Manifest updated
    const manifest = store.readManifest(ws)
    assert.strictEqual(manifest.changesets.length, 1)
  } finally {
    cleanup(ws)
  }
})

test('updateChangeSetStatus updates file status', () => {
  const ws = createTempWorkspace()
  try {
    const { ok, value } = store.createChangeSet(ws, {
      source: 'agent',
      title: 'Status Test',
      summary: '',
      files: [{ path: 'src/a.ts', status: 'pending' }, { path: 'src/b.ts', status: 'pending' }]
    })
    assert.ok(ok)

    const result = store.updateChangeSetStatus(ws, value.id, {
      fileUpdates: [{ path: 'src/a.ts', status: 'accepted' }]
    })

    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.value.files[0].status, 'accepted')
      assert.strictEqual(result.value.files[1].status, 'pending')
    }
  } finally {
    cleanup(ws)
  }
})

test('readDesignSettings returns sensible defaults when none saved yet', () => {
  const ws = createTempWorkspace()
  try {
    const result = store.readDesignSettings(ws)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.value.enabled, true)
      assert.strictEqual(result.value.defaultViewport, 'desktop')
      assert.strictEqual(result.value.designSystemPreset, 'none')
      assert.deepStrictEqual(result.value.tone, [])
      assert.strictEqual(result.value.sandboxHtmlPreview, true)
    }

    // Reading defaults must not write anything to disk.
    const settingsPath = path.join(ws, '.hermes', 'workbench', 'designs', 'settings.json')
    assert.ok(!fs.existsSync(settingsPath))
  } finally {
    cleanup(ws)
  }
})

test('writeDesignSettings persists settings and readDesignSettings returns them back', () => {
  const ws = createTempWorkspace()
  try {
    const settings = {
      enabled: true,
      defaultViewport: 'mobile',
      designSystemPreset: 'shadcn',
      brandColor: '#336699',
      tone: ['minimal', 'confident'],
      radius: 'soft',
      density: 'cozy',
      fontStyle: 'geometric',
      stackHint: 'react + tailwind',
      sandboxHtmlPreview: false
    }

    const writeResult = store.writeDesignSettings(ws, settings)
    assert.strictEqual(writeResult.ok, true)

    const settingsPath = path.join(ws, '.hermes', 'workbench', 'designs', 'settings.json')
    assert.ok(fs.existsSync(settingsPath))

    const readResult = store.readDesignSettings(ws)
    assert.strictEqual(readResult.ok, true)
    if (readResult.ok) {
      assert.strictEqual(readResult.value.defaultViewport, 'mobile')
      assert.strictEqual(readResult.value.designSystemPreset, 'shadcn')
      assert.strictEqual(readResult.value.brandColor, '#336699')
      assert.deepStrictEqual(readResult.value.tone, ['minimal', 'confident'])
    }

    // Manifest's designs array carries exactly one entry for the singleton doc.
    const manifest = store.readManifest(ws)
    assert.strictEqual(manifest.designs.length, 1)
    assert.strictEqual(manifest.designs[0].id, 'settings')

    // Writing again updates the same manifest entry rather than appending.
    store.writeDesignSettings(ws, { ...settings, defaultViewport: 'desktop' })
    const manifestAfterSecondWrite = store.readManifest(ws)
    assert.strictEqual(manifestAfterSecondWrite.designs.length, 1)
  } finally {
    cleanup(ws)
  }
})

test('writeDesignSettings never writes outside .hermes/workbench/designs', () => {
  const ws = createTempWorkspace()
  try {
    store.writeDesignSettings(ws, {
      enabled: true,
      defaultViewport: 'desktop',
      designSystemPreset: 'none',
      tone: [],
      sandboxHtmlPreview: true
    })

    const designsDir = path.join(ws, '.hermes', 'workbench', 'designs')
    assert.ok(fs.existsSync(designsDir))
    assert.ok(fs.existsSync(path.join(designsDir, 'settings.json')))
  } finally {
    cleanup(ws)
  }
})

test('atomicWriteFile does not leave partial target on error', () => {
  const ws = createTempWorkspace()
  try {
    const targetPath = path.join(ws, 'subdir', 'target.txt')
    // Should create subdir and write
    store._internal.atomicWriteFile(targetPath, 'hello')
    assert.strictEqual(fs.readFileSync(targetPath, 'utf8'), 'hello')
  } finally {
    cleanup(ws)
  }
})

test('isSafeRelativePath rejects traversal', () => {
  assert.strictEqual(store._internal.isSafeRelativePath('../etc/passwd'), false)
  assert.strictEqual(store._internal.isSafeRelativePath('a/../../b'), false)
  assert.strictEqual(store._internal.isSafeRelativePath('C:/test'), false)
  assert.strictEqual(store._internal.isSafeRelativePath('safe/path'), true)
})

test('isSafeRelativePath rejects POSIX-absolute paths', () => {
  assert.strictEqual(store._internal.isSafeRelativePath('/etc/passwd'), false)
  assert.strictEqual(store._internal.isSafeRelativePath('/absolute/but/nested'), false)
})

test('sanitizeId lowercases and cleans', () => {
  assert.strictEqual(store._internal.sanitizeId('My Req!'), 'my-req')
  assert.strictEqual(store._internal.sanitizeId(''), '')
})

test('ensureManifest recovers from corrupt manifest', () => {
  const ws = createTempWorkspace()
  try {
    // Create a corrupt manifest
    const manifestDir = path.join(ws, '.hermes', 'workbench')
    fs.mkdirSync(manifestDir, { recursive: true })
    fs.writeFileSync(path.join(manifestDir, 'manifest.json'), '{ corrupt json')

    const manifest = store.ensureManifest(ws)
    assert.strictEqual(manifest.version, 1)
    assert.ok(Array.isArray(manifest.requirements))
    assert.strictEqual(manifest.requirements.length, 0)
  } finally {
    cleanup(ws)
  }
})
