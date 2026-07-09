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

// ---------------------------------------------------------------------------
// Design artifact generation storage (Slice G)
// ---------------------------------------------------------------------------

test('createDesignArtifact writes a brief as markdown and links the requirement trace', () => {
  const ws = createTempWorkspace()
  try {
    const { requirement } = store.createRequirement(ws, { title: 'Onboarding flow' })

    const result = store.createDesignArtifact(ws, {
      requirementId: requirement.id,
      kind: 'brief',
      content: '# Design brief\n\nTarget users: new signups.'
    })

    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.value.kind, 'brief')
    assert.strictEqual(result.value.requirementId, requirement.id)
    assert.ok(result.value.id)
    assert.ok(result.value.contentHash)
    assert.ok(result.value.relativePath.endsWith('.md'))

    const fullPath = path.join(ws, result.value.relativePath)
    assert.ok(fs.existsSync(fullPath))
    assert.ok(fs.readFileSync(fullPath, 'utf8').includes('Design brief'))

    // Sidecar carries the full record.
    const metaPath = fullPath.replace(/\.md$/, '.meta.json')
    assert.ok(fs.existsSync(metaPath))
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    assert.strictEqual(meta.id, result.value.id)
    assert.strictEqual(meta.kind, 'brief')

    // Trace linkage.
    const traceRes = store.readRequirement(ws, requirement.id)
    assert.strictEqual(traceRes.ok, true)
    assert.ok(traceRes.value.trace.linkedDesignArtifactIds.includes(result.value.id))
    assert.ok(traceRes.value.trace.history.some((h) => h.kind === 'design_linked'))
  } finally {
    cleanup(ws)
  }
})

test('createDesignArtifact writes a prototype as .html', () => {
  const ws = createTempWorkspace()
  try {
    const { requirement } = store.createRequirement(ws, { title: 'Prototype target' })

    const result = store.createDesignArtifact(ws, {
      requirementId: requirement.id,
      kind: 'prototype',
      content: '<!doctype html><html><head></head><body>Hi</body></html>'
    })

    assert.strictEqual(result.ok, true)
    assert.ok(result.value.relativePath.endsWith('.html'))
    assert.ok(fs.existsSync(path.join(ws, result.value.relativePath)))
  } finally {
    cleanup(ws)
  }
})

test('createDesignArtifact rejects an invalid kind and missing content', () => {
  const ws = createTempWorkspace()
  try {
    const { requirement } = store.createRequirement(ws, { title: 'Validation target' })

    const badKind = store.createDesignArtifact(ws, { requirementId: requirement.id, kind: 'bogus', content: 'x' })
    assert.strictEqual(badKind.ok, false)
    assert.strictEqual(badKind.code, 'INVALID_KIND')

    const badContent = store.createDesignArtifact(ws, { requirementId: requirement.id, kind: 'brief', content: '   ' })
    assert.strictEqual(badContent.ok, false)
    assert.strictEqual(badContent.code, 'MISSING_CONTENT')

    const badReq = store.createDesignArtifact(ws, { requirementId: '', kind: 'brief', content: 'x' })
    assert.strictEqual(badReq.ok, false)
    assert.strictEqual(badReq.code, 'MISSING_REQUIREMENT_ID')
  } finally {
    cleanup(ws)
  }
})

test('createDesignArtifact never overwrites a prior artifact — each call creates a new one', () => {
  const ws = createTempWorkspace()
  try {
    const { requirement } = store.createRequirement(ws, { title: 'Ever-growing list' })

    const first = store.createDesignArtifact(ws, { requirementId: requirement.id, kind: 'brief', content: 'v1' })
    const second = store.createDesignArtifact(ws, { requirementId: requirement.id, kind: 'brief', content: 'v2' })

    assert.notStrictEqual(first.value.id, second.value.id)
    assert.ok(fs.existsSync(path.join(ws, first.value.relativePath)))
    assert.ok(fs.existsSync(path.join(ws, second.value.relativePath)))
    assert.strictEqual(fs.readFileSync(path.join(ws, first.value.relativePath), 'utf8'), 'v1')
    assert.strictEqual(fs.readFileSync(path.join(ws, second.value.relativePath), 'utf8'), 'v2')

    const listed = store.listDesignArtifacts(ws, requirement.id)
    assert.strictEqual(listed.ok, true)
    assert.strictEqual(listed.value.length, 2)
  } finally {
    cleanup(ws)
  }
})

test('listDesignArtifacts returns [] for a requirement with none yet, and requires a requirementId', () => {
  const ws = createTempWorkspace()
  try {
    const { requirement } = store.createRequirement(ws, { title: 'Empty list target' })

    const empty = store.listDesignArtifacts(ws, requirement.id)
    assert.strictEqual(empty.ok, true)
    assert.deepStrictEqual(empty.value, [])

    const missingReq = store.listDesignArtifacts(ws, '')
    assert.strictEqual(missingReq.ok, false)
    assert.strictEqual(missingReq.code, 'MISSING_REQUIREMENT_ID')
  } finally {
    cleanup(ws)
  }
})

test('listDesignArtifacts orders newest first', () => {
  const ws = createTempWorkspace()
  try {
    const { requirement } = store.createRequirement(ws, { title: 'Order target' })

    const older = store.createDesignArtifact(ws, { requirementId: requirement.id, kind: 'brief', content: 'older' })
    // Force distinct createdAt ordering deterministically rather than relying on timing.
    const metaPath = path.join(ws, older.value.relativePath.replace(/\.md$/, '.meta.json'))
    const olderMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    olderMeta.createdAt = '2020-01-01T00:00:00.000Z'
    fs.writeFileSync(metaPath, JSON.stringify(olderMeta, null, 2))

    const newer = store.createDesignArtifact(ws, { requirementId: requirement.id, kind: 'prototype', content: '<html></html>' })

    const listed = store.listDesignArtifacts(ws, requirement.id)
    assert.strictEqual(listed.ok, true)
    assert.strictEqual(listed.value[0].id, newer.value.id)
    assert.strictEqual(listed.value[1].id, older.value.id)
  } finally {
    cleanup(ws)
  }
})

test('readDesignArtifact returns the artifact content by id alone (no requirementId needed)', () => {
  const ws = createTempWorkspace()
  try {
    const { requirement } = store.createRequirement(ws, { title: 'Read target' })
    const created = store.createDesignArtifact(ws, {
      requirementId: requirement.id,
      kind: 'prototype',
      content: '<!doctype html><html><body>Proto</body></html>'
    })

    const result = store.readDesignArtifact(ws, created.value.id)
    assert.strictEqual(result.ok, true)
    assert.strictEqual(result.value.id, created.value.id)
    assert.strictEqual(result.value.kind, 'prototype')
    assert.strictEqual(result.value.requirementId, requirement.id)
    assert.ok(result.value.content.includes('Proto'))
  } finally {
    cleanup(ws)
  }
})

test('readDesignArtifact returns NOT_FOUND for an unknown artifact id', () => {
  const ws = createTempWorkspace()
  try {
    const result = store.readDesignArtifact(ws, 'design-does-not-exist')
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.code, 'NOT_FOUND')
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

// ---------------------------------------------------------------------------
// Write Workspace — CRUD only (Slice J)
// ---------------------------------------------------------------------------

test('createWriteProject creates document + metadata files and manifest entry', () => {
  const ws = createTempWorkspace()
  try {
    const { project } = store.createWriteProject(ws, {
      title: 'Test Write Project',
      markdown: '# Test\n\nContent here'
    })

    assert.ok(project.id)
    assert.strictEqual(project.title, 'Test Write Project')
    assert.ok(project.rootRelativeDir)
    assert.ok(project.activeFileRelativePath)

    const docPath = path.join(ws, project.activeFileRelativePath)
    assert.ok(fs.existsSync(docPath))
    const doc = fs.readFileSync(docPath, 'utf8')
    assert.ok(doc.includes('# Test'))

    const metaPath = path.join(ws, project.rootRelativeDir, 'project.json')
    assert.ok(fs.existsSync(metaPath))

    const manifest = store.readManifest(ws)
    assert.strictEqual(manifest.writeProjects.length, 1)
    assert.strictEqual(manifest.writeProjects[0].id, project.id)
  } finally {
    cleanup(ws)
  }
})

test('createWriteProject uses default markdown when none provided', () => {
  const ws = createTempWorkspace()
  try {
    const { project } = store.createWriteProject(ws, { title: 'Default Content' })

    const docPath = path.join(ws, project.activeFileRelativePath)
    const doc = fs.readFileSync(docPath, 'utf8')
    assert.ok(doc.includes('# Default Content'))
  } finally {
    cleanup(ws)
  }
})

test('readWriteProject returns the document content and empty recent edits', () => {
  const ws = createTempWorkspace()
  try {
    const { project } = store.createWriteProject(ws, { title: 'Read Test', markdown: '# Read Me' })

    const result = store.readWriteProject(ws, project.id)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.ok(result.value.markdown.includes('# Read Me'))
      assert.deepStrictEqual(result.value.recentEdits, [])
    }
  } finally {
    cleanup(ws)
  }
})

test('readWriteProject returns NOT_FOUND for a missing project', () => {
  const ws = createTempWorkspace()
  try {
    const result = store.readWriteProject(ws, 'nonexistent')
    assert.strictEqual(result.ok, false)
    if (!result.ok) assert.strictEqual(result.code, 'NOT_FOUND')
  } finally {
    cleanup(ws)
  }
})

test('updateWriteProject persists new content and records a passive recent-edit entry', () => {
  const ws = createTempWorkspace()
  try {
    const { project } = store.createWriteProject(ws, { title: 'Update Test', markdown: '# Original' })

    const updateResult = store.updateWriteProject(ws, project.id, { markdown: '# Updated content' })
    assert.strictEqual(updateResult.ok, true)
    if (updateResult.ok) {
      assert.ok(updateResult.value.contentHash)
    }

    const readResult = store.readWriteProject(ws, project.id)
    assert.strictEqual(readResult.ok, true)
    if (readResult.ok) {
      assert.ok(readResult.value.markdown.includes('# Updated content'))
      assert.strictEqual(readResult.value.recentEdits.length, 1)
      assert.strictEqual(readResult.value.recentEdits[0].source, 'user')
      assert.ok(readResult.value.recentEdits[0].ageMs >= 0)
      assert.ok(readResult.value.recentEdits[0].insertedText.includes('Updated content'))
    }

    // Manifest entry refreshed, not duplicated.
    const manifest = store.readManifest(ws)
    assert.strictEqual(manifest.writeProjects.length, 1)
  } finally {
    cleanup(ws)
  }
})

test('updateWriteProject caps recent edits history at 20 entries', () => {
  const ws = createTempWorkspace()
  try {
    const { project } = store.createWriteProject(ws, { title: 'History Cap Test', markdown: '# v0' })

    for (let i = 1; i <= 25; i += 1) {
      store.updateWriteProject(ws, project.id, { markdown: `# v${i}` })
    }

    const readResult = store.readWriteProject(ws, project.id)
    assert.strictEqual(readResult.ok, true)
    if (readResult.ok) {
      assert.strictEqual(readResult.value.recentEdits.length, 20)
    }
  } finally {
    cleanup(ws)
  }
})

test('updateWriteProject returns NOT_FOUND for a missing project', () => {
  const ws = createTempWorkspace()
  try {
    const result = store.updateWriteProject(ws, 'nonexistent', { markdown: '# x' })
    assert.strictEqual(result.ok, false)
    if (!result.ok) assert.strictEqual(result.code, 'NOT_FOUND')
  } finally {
    cleanup(ws)
  }
})

test('listWriteProjects returns manifest rows', () => {
  const ws = createTempWorkspace()
  try {
    store.createWriteProject(ws, { title: 'Write A' })
    store.createWriteProject(ws, { title: 'Write B' })

    const result = store.listWriteProjects(ws)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.value.length, 2)
    }
  } finally {
    cleanup(ws)
  }
})

// ---------------------------------------------------------------------------
// Workflow Designer — AUTHORING ONLY (Slice M)
// ---------------------------------------------------------------------------

test('createWorkflow creates a JSON document and manifest entry', () => {
  const ws = createTempWorkspace()
  try {
    const { workflow } = store.createWorkflow(ws, {
      title: 'Test Workflow',
      nodes: [{ id: 'n1', type: 'manual_trigger', name: 'Trigger', position: { x: 0, y: 0 }, config: {} }],
      edges: []
    })

    assert.ok(workflow.id)
    assert.strictEqual(workflow.title, 'Test Workflow')
    assert.strictEqual(workflow.enabled, true)
    assert.strictEqual(workflow.nodes.length, 1)

    const filePath = path.join(ws, '.hermes', 'workbench', 'workflows', `${workflow.id}.json`)
    assert.ok(fs.existsSync(filePath))

    const manifest = store.readManifest(ws)
    assert.strictEqual(manifest.workflows.length, 1)
    assert.strictEqual(manifest.workflows[0].id, workflow.id)
  } finally {
    cleanup(ws)
  }
})

test('createWorkflow defaults to empty nodes/edges and enabled true', () => {
  const ws = createTempWorkspace()
  try {
    const { workflow } = store.createWorkflow(ws, { title: 'Empty Workflow' })

    assert.deepStrictEqual(workflow.nodes, [])
    assert.deepStrictEqual(workflow.edges, [])
    assert.strictEqual(workflow.enabled, true)
  } finally {
    cleanup(ws)
  }
})

test('readWorkflow returns the workflow document', () => {
  const ws = createTempWorkspace()
  try {
    const { workflow } = store.createWorkflow(ws, { title: 'Read Test' })

    const result = store.readWorkflow(ws, workflow.id)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.value.title, 'Read Test')
    }
  } finally {
    cleanup(ws)
  }
})

test('readWorkflow returns NOT_FOUND for a missing workflow', () => {
  const ws = createTempWorkspace()
  try {
    const result = store.readWorkflow(ws, 'nonexistent')
    assert.strictEqual(result.ok, false)
    if (!result.ok) assert.strictEqual(result.code, 'NOT_FOUND')
  } finally {
    cleanup(ws)
  }
})

test('updateWorkflow persists new nodes/edges and title', () => {
  const ws = createTempWorkspace()
  try {
    const { workflow } = store.createWorkflow(ws, { title: 'Update Test' })

    const nodes = [
      { id: 'n1', type: 'manual_trigger', name: 'Trigger', position: { x: 0, y: 0 }, config: {} },
      { id: 'n2', type: 'output', name: 'Output', position: { x: 200, y: 0 }, config: { label: 'Done' } }
    ]
    const edges = [{ id: 'e1', source: 'n1', target: 'n2' }]

    const updateResult = store.updateWorkflow(ws, workflow.id, { title: 'Renamed', nodes, edges })
    assert.strictEqual(updateResult.ok, true)
    if (updateResult.ok) {
      assert.strictEqual(updateResult.value.title, 'Renamed')
      assert.ok(updateResult.value.contentHash)
    }

    const readResult = store.readWorkflow(ws, workflow.id)
    assert.strictEqual(readResult.ok, true)
    if (readResult.ok) {
      assert.strictEqual(readResult.value.title, 'Renamed')
      assert.strictEqual(readResult.value.nodes.length, 2)
      assert.strictEqual(readResult.value.edges.length, 1)
    }

    // Manifest entry refreshed, not duplicated.
    const manifest = store.readManifest(ws)
    assert.strictEqual(manifest.workflows.length, 1)
    assert.strictEqual(manifest.workflows[0].title, 'Renamed')
  } finally {
    cleanup(ws)
  }
})

test('updateWorkflow returns NOT_FOUND for a missing workflow', () => {
  const ws = createTempWorkspace()
  try {
    const result = store.updateWorkflow(ws, 'nonexistent', { nodes: [], edges: [] })
    assert.strictEqual(result.ok, false)
    if (!result.ok) assert.strictEqual(result.code, 'NOT_FOUND')
  } finally {
    cleanup(ws)
  }
})

test('listWorkflows returns manifest rows', () => {
  const ws = createTempWorkspace()
  try {
    store.createWorkflow(ws, { title: 'Workflow A' })
    store.createWorkflow(ws, { title: 'Workflow B' })

    const result = store.listWorkflows(ws)
    assert.strictEqual(result.ok, true)
    if (result.ok) {
      assert.strictEqual(result.value.length, 2)
    }
  } finally {
    cleanup(ws)
  }
})
