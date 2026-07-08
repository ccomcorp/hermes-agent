'use strict'

// Hermes Workbench IPC handler tests.
//
// Same harness style as workbench-artifacts.test.cjs (node:test + tmp
// workspaces). Because the handlers register through Electron's `ipcMain`, we
// intercept `require('electron')` with a fake ipcMain that just captures the
// handler functions by channel, then invoke them directly. This lets us test
// the real registration + validation + normalization path with no Electron
// runtime.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const Module = require('node:module')

// ---------------------------------------------------------------------------
// Mock electron BEFORE requiring the handler module
// ---------------------------------------------------------------------------

const handlers = new Map()
const fakeIpcMain = {
  handle(channel, fn) {
    handlers.set(channel, fn)
  }
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { ipcMain: fakeIpcMain }
  return originalLoad.apply(this, arguments)
}

const { registerWorkbenchIpc } = require('./workbench-ipc.cjs')

// Restore immediately — the store (fs/path/crypto only) and everything else
// must load normally, and this mock must not leak to sibling test files.
Module._load = originalLoad

registerWorkbenchIpc()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CH = {
  reqList: 'hermes:workbench:requirements:list',
  reqCreate: 'hermes:workbench:requirements:create',
  reqRead: 'hermes:workbench:requirements:read',
  reqUpdate: 'hermes:workbench:requirements:update',
  planList: 'hermes:workbench:plans:list',
  planCreate: 'hermes:workbench:plans:create',
  planRead: 'hermes:workbench:plans:read',
  planUpdate: 'hermes:workbench:plans:update',
  csList: 'hermes:workbench:changesets:list',
  csCreate: 'hermes:workbench:changesets:create',
  csRead: 'hermes:workbench:changesets:read',
  designRead: 'hermes:workbench:design:settings:read',
  designWrite: 'hermes:workbench:design:settings:write',
  writeList: 'hermes:workbench:write:list',
  writeCreate: 'hermes:workbench:write:create',
  writeRead: 'hermes:workbench:write:read',
  writeUpdate: 'hermes:workbench:write:update',
  wfList: 'hermes:workbench:workflows:list',
  wfCreate: 'hermes:workbench:workflows:create',
  wfRead: 'hermes:workbench:workflows:read',
  wfUpdate: 'hermes:workbench:workflows:update'
}

function invoke(channel, payload) {
  const fn = handlers.get(channel)
  if (!fn) throw new Error('No handler registered for ' + channel)
  return fn({}, payload)
}

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-ipc-test-'))
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* ignore */ }
}

// A response is normalized iff it is a plain WorkbenchResult:
// { ok, value? , message?, code? } — and its `value` is NOT itself an envelope
// (guards against double-wrapping).
function assertNormalized(res) {
  assert.strictEqual(typeof res, 'object', 'result must be an object')
  assert.strictEqual(typeof res.ok, 'boolean', 'result.ok must be a boolean')
  if (res.ok) {
    assert.ok('value' in res, 'ok result must carry a value')
    if (res.value && typeof res.value === 'object') {
      assert.notStrictEqual(res.value.ok, true, 'value must not itself be a WorkbenchResult envelope')
    }
  } else {
    assert.strictEqual(typeof res.message, 'string', 'error result must carry a message')
    assert.ok(res.code, 'error result must carry a code')
  }
}

// ---------------------------------------------------------------------------
// (a) Handler success paths — normalized shape
// ---------------------------------------------------------------------------

test('handlers are registered for every workbench channel', () => {
  for (const channel of Object.values(CH)) {
    assert.ok(handlers.has(channel), 'missing handler: ' + channel)
  }
})

test('requirements create/read/list/update return normalized shape', () => {
  const ws = createTempWorkspace()
  try {
    const created = invoke(CH.reqCreate, {
      workspaceRoot: ws,
      title: 'Add settings export',
      markdown: '# Add settings export\n'
    })
    assertNormalized(created)
    assert.strictEqual(created.ok, true)
    assert.ok(created.value.requirement.id)
    assert.ok(created.value.trace)

    const id = created.value.requirement.id

    const read = invoke(CH.reqRead, { workspaceRoot: ws, requirementId: id })
    assertNormalized(read)
    assert.strictEqual(read.ok, true)
    assert.ok(read.value.markdown.includes('Add settings export'))

    const list = invoke(CH.reqList, { workspaceRoot: ws })
    assertNormalized(list)
    assert.strictEqual(list.ok, true)
    assert.strictEqual(list.value.length, 1)

    const updated = invoke(CH.reqUpdate, {
      workspaceRoot: ws,
      requirementId: id,
      markdown: '# Updated\n',
      status: 'clarified'
    })
    assertNormalized(updated)
    assert.strictEqual(updated.ok, true)
    assert.strictEqual(updated.value.status, 'clarified')
  } finally {
    cleanup(ws)
  }
})

test('plans create/read/list return normalized shape', () => {
  const ws = createTempWorkspace()
  try {
    const created = invoke(CH.planCreate, {
      workspaceRoot: ws,
      title: 'Implementation Plan',
      markdown: '# Plan v1\n',
      operation: 'draft'
    })
    assertNormalized(created)
    assert.strictEqual(created.ok, true)
    assert.ok(created.value.plan.id)
    assert.strictEqual(created.value.plan.version, 1)

    const read = invoke(CH.planRead, { workspaceRoot: ws, planId: created.value.plan.id })
    assertNormalized(read)
    assert.strictEqual(read.ok, true)
    assert.ok(read.value.markdown.includes('Plan v1'))

    const list = invoke(CH.planList, { workspaceRoot: ws })
    assertNormalized(list)
    assert.strictEqual(list.ok, true)
    assert.strictEqual(list.value.length, 1)
  } finally {
    cleanup(ws)
  }
})

test('design settings read returns defaults, write persists them', () => {
  const ws = createTempWorkspace()
  try {
    const initial = invoke(CH.designRead, { workspaceRoot: ws })
    assertNormalized(initial)
    assert.strictEqual(initial.ok, true)
    assert.strictEqual(initial.value.designSystemPreset, 'none')
    assert.strictEqual(initial.value.defaultViewport, 'desktop')

    const written = invoke(CH.designWrite, {
      workspaceRoot: ws,
      settings: {
        enabled: true,
        defaultViewport: 'mobile',
        designSystemPreset: 'shadcn',
        brandColor: '#112233',
        tone: ['bold'],
        radius: 'pill',
        density: 'compact',
        fontStyle: 'mono',
        stackHint: 'react native',
        sandboxHtmlPreview: false
      }
    })
    assertNormalized(written)
    assert.strictEqual(written.ok, true)
    assert.strictEqual(written.value.designSystemPreset, 'shadcn')

    const reread = invoke(CH.designRead, { workspaceRoot: ws })
    assert.strictEqual(reread.ok, true)
    assert.strictEqual(reread.value.defaultViewport, 'mobile')
    assert.strictEqual(reread.value.brandColor, '#112233')
  } finally {
    cleanup(ws)
  }
})

test('design settings write is rejected with structured errors on invalid payloads', () => {
  const ws = createTempWorkspace()
  try {
    const nullPayload = invoke(CH.designWrite, null)
    assertNormalized(nullPayload)
    assert.strictEqual(nullPayload.ok, false)
    assert.strictEqual(nullPayload.code, 'INVALID_PAYLOAD')

    const missingSettings = invoke(CH.designWrite, { workspaceRoot: ws })
    assert.strictEqual(missingSettings.ok, false)
    assert.strictEqual(missingSettings.code, 'MISSING_SETTINGS')

    const badPreset = invoke(CH.designWrite, {
      workspaceRoot: ws,
      settings: {
        enabled: true,
        defaultViewport: 'desktop',
        designSystemPreset: 'bogus-preset',
        tone: [],
        sandboxHtmlPreview: true
      }
    })
    assert.strictEqual(badPreset.ok, false)
    assert.strictEqual(badPreset.code, 'INVALID_PRESET')

    const badViewport = invoke(CH.designWrite, {
      workspaceRoot: ws,
      settings: {
        enabled: true,
        defaultViewport: 'ultrawide',
        designSystemPreset: 'none',
        tone: [],
        sandboxHtmlPreview: true
      }
    })
    assert.strictEqual(badViewport.ok, false)
    assert.strictEqual(badViewport.code, 'INVALID_VIEWPORT')

    // Nothing should have been written to disk by any of the rejected calls.
    const settingsPath = path.join(ws, '.hermes', 'workbench', 'designs', 'settings.json')
    assert.ok(!fs.existsSync(settingsPath))
  } finally {
    cleanup(ws)
  }
})

test('changesets create/read/list return normalized shape', () => {
  const ws = createTempWorkspace()
  try {
    const created = invoke(CH.csCreate, {
      workspaceRoot: ws,
      source: 'agent',
      title: 'Some changes',
      summary: 'changes',
      files: [{ path: 'src/index.ts', status: 'pending' }]
    })
    assertNormalized(created)
    assert.strictEqual(created.ok, true)
    assert.strictEqual(created.value.status, 'pending')

    const read = invoke(CH.csRead, { workspaceRoot: ws, changesetId: created.value.id })
    assertNormalized(read)
    assert.strictEqual(read.ok, true)
    assert.strictEqual(read.value.id, created.value.id)

    const list = invoke(CH.csList, { workspaceRoot: ws })
    assertNormalized(list)
    assert.strictEqual(list.ok, true)
    assert.strictEqual(list.value.length, 1)
  } finally {
    cleanup(ws)
  }
})

test('write projects create/read/list/update return normalized shape', () => {
  const ws = createTempWorkspace()
  try {
    const created = invoke(CH.writeCreate, {
      workspaceRoot: ws,
      title: 'Blog draft',
      markdown: '# Blog draft\n'
    })
    assertNormalized(created)
    assert.strictEqual(created.ok, true)
    assert.ok(created.value.project.id)

    const id = created.value.project.id

    const read = invoke(CH.writeRead, { workspaceRoot: ws, writeProjectId: id })
    assertNormalized(read)
    assert.strictEqual(read.ok, true)
    assert.ok(read.value.markdown.includes('Blog draft'))
    assert.deepStrictEqual(read.value.recentEdits, [])

    const list = invoke(CH.writeList, { workspaceRoot: ws })
    assertNormalized(list)
    assert.strictEqual(list.ok, true)
    assert.strictEqual(list.value.length, 1)

    const updated = invoke(CH.writeUpdate, {
      workspaceRoot: ws,
      writeProjectId: id,
      markdown: '# Updated draft\n',
      title: 'Renamed draft'
    })
    assertNormalized(updated)
    assert.strictEqual(updated.ok, true)
    assert.strictEqual(updated.value.title, 'Renamed draft')

    const reread = invoke(CH.writeRead, { workspaceRoot: ws, writeProjectId: id })
    assert.strictEqual(reread.ok, true)
    assert.ok(reread.value.markdown.includes('Updated draft'))
    assert.strictEqual(reread.value.recentEdits.length, 1)
  } finally {
    cleanup(ws)
  }
})

test('write project handlers are rejected with structured errors on invalid payloads', () => {
  const ws = createTempWorkspace()
  try {
    const nullPayload = invoke(CH.writeCreate, null)
    assertNormalized(nullPayload)
    assert.strictEqual(nullPayload.ok, false)
    assert.strictEqual(nullPayload.code, 'INVALID_PAYLOAD')

    const noTitle = invoke(CH.writeCreate, { workspaceRoot: ws })
    assert.strictEqual(noTitle.ok, false)
    assert.strictEqual(noTitle.code, 'MISSING_TITLE')

    const noId = invoke(CH.writeUpdate, { workspaceRoot: ws, markdown: '# x' })
    assert.strictEqual(noId.ok, false)
    assert.strictEqual(noId.code, 'MISSING_WRITE_PROJECT_ID')

    const noMd = invoke(CH.writeUpdate, { workspaceRoot: ws, writeProjectId: 'anything' })
    assert.strictEqual(noMd.ok, false)
    assert.strictEqual(noMd.code, 'MISSING_MARKDOWN')

    const missingRead = invoke(CH.writeRead, { workspaceRoot: ws, writeProjectId: 'nonexistent' })
    assert.strictEqual(missingRead.ok, false)
    assert.strictEqual(missingRead.code, 'NOT_FOUND')
  } finally {
    cleanup(ws)
  }
})

// ---------------------------------------------------------------------------
// (a) Workflow Designer — AUTHORING ONLY (Slice M)
// ---------------------------------------------------------------------------

test('workflows create/read/list/update return normalized shape', () => {
  const ws = createTempWorkspace()
  try {
    const created = invoke(CH.wfCreate, {
      workspaceRoot: ws,
      title: 'My Workflow',
      nodes: [{ id: 'n1', type: 'manual_trigger', name: 'Trigger', position: { x: 0, y: 0 }, config: {} }],
      edges: []
    })
    assertNormalized(created)
    assert.strictEqual(created.ok, true)
    assert.ok(created.value.workflow.id)
    assert.strictEqual(created.value.workflow.nodes.length, 1)

    const id = created.value.workflow.id

    const read = invoke(CH.wfRead, { workspaceRoot: ws, workflowId: id })
    assertNormalized(read)
    assert.strictEqual(read.ok, true)
    assert.strictEqual(read.value.title, 'My Workflow')

    const list = invoke(CH.wfList, { workspaceRoot: ws })
    assertNormalized(list)
    assert.strictEqual(list.ok, true)
    assert.strictEqual(list.value.length, 1)

    const nodes = [
      { id: 'n1', type: 'manual_trigger', name: 'Trigger', position: { x: 0, y: 0 }, config: {} },
      { id: 'n2', type: 'condition', name: 'Condition', position: { x: 200, y: 0 }, config: { expression: 'x == 1' } },
      { id: 'n3', type: 'output', name: 'Output', position: { x: 400, y: 0 }, config: {} }
    ]
    const edges = [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' }
    ]

    const updated = invoke(CH.wfUpdate, { workspaceRoot: ws, workflowId: id, title: 'Renamed', nodes, edges })
    assertNormalized(updated)
    assert.strictEqual(updated.ok, true)
    assert.strictEqual(updated.value.title, 'Renamed')

    const reread = invoke(CH.wfRead, { workspaceRoot: ws, workflowId: id })
    assert.strictEqual(reread.ok, true)
    assert.strictEqual(reread.value.nodes.length, 3)
    assert.strictEqual(reread.value.edges.length, 2)
  } finally {
    cleanup(ws)
  }
})

test('workflow handlers accept all 12 declared node kinds (backend stays permissive)', () => {
  const ws = createTempWorkspace()
  try {
    const kinds = [
      'manual_trigger', 'schedule_trigger', 'webhook_trigger', 'ai_agent',
      'human_approval', 'condition', 'http_request', 'code', 'delay', 'loop',
      'subworkflow', 'output'
    ]
    const nodes = kinds.map((kind, i) => ({
      id: `n${i}`,
      type: kind,
      name: kind,
      position: { x: i * 10, y: 0 },
      config: {}
    }))

    const created = invoke(CH.wfCreate, { workspaceRoot: ws, title: 'All Kinds', nodes, edges: [] })
    assertNormalized(created)
    assert.strictEqual(created.ok, true)
    assert.strictEqual(created.value.workflow.nodes.length, kinds.length)
  } finally {
    cleanup(ws)
  }
})

test('workflow handlers are rejected with structured errors on invalid payloads', () => {
  const ws = createTempWorkspace()
  try {
    const nullPayload = invoke(CH.wfCreate, null)
    assertNormalized(nullPayload)
    assert.strictEqual(nullPayload.ok, false)
    assert.strictEqual(nullPayload.code, 'INVALID_PAYLOAD')

    const noTitle = invoke(CH.wfCreate, { workspaceRoot: ws })
    assert.strictEqual(noTitle.ok, false)
    assert.strictEqual(noTitle.code, 'MISSING_TITLE')

    const badNodeType = invoke(CH.wfCreate, {
      workspaceRoot: ws,
      title: 'x',
      nodes: [{ id: 'n1', type: 'not_a_real_kind', name: 'x', position: { x: 0, y: 0 }, config: {} }]
    })
    assert.strictEqual(badNodeType.ok, false)
    assert.strictEqual(badNodeType.code, 'INVALID_NODE_TYPE')

    const badPosition = invoke(CH.wfCreate, {
      workspaceRoot: ws,
      title: 'x',
      nodes: [{ id: 'n1', type: 'output', name: 'x', position: { x: 'nope', y: 0 }, config: {} }]
    })
    assert.strictEqual(badPosition.ok, false)
    assert.strictEqual(badPosition.code, 'INVALID_NODE_POSITION')

    const edgeToUnknownNode = invoke(CH.wfCreate, {
      workspaceRoot: ws,
      title: 'x',
      nodes: [{ id: 'n1', type: 'output', name: 'x', position: { x: 0, y: 0 }, config: {} }],
      edges: [{ id: 'e1', source: 'n1', target: 'ghost' }]
    })
    assert.strictEqual(edgeToUnknownNode.ok, false)
    assert.strictEqual(edgeToUnknownNode.code, 'EDGE_UNKNOWN_NODE')

    const tooManyNodes = invoke(CH.wfCreate, {
      workspaceRoot: ws,
      title: 'x',
      nodes: Array.from({ length: 501 }, (_, i) => ({
        id: `n${i}`,
        type: 'output',
        name: 'x',
        position: { x: 0, y: 0 },
        config: {}
      }))
    })
    assert.strictEqual(tooManyNodes.ok, false)
    assert.strictEqual(tooManyNodes.code, 'TOO_MANY_NODES')

    const noWorkflowId = invoke(CH.wfUpdate, { workspaceRoot: ws, nodes: [], edges: [] })
    assert.strictEqual(noWorkflowId.ok, false)
    assert.strictEqual(noWorkflowId.code, 'MISSING_WORKFLOW_ID')

    const missingRead = invoke(CH.wfRead, { workspaceRoot: ws, workflowId: 'nonexistent' })
    assert.strictEqual(missingRead.ok, false)
    assert.strictEqual(missingRead.code, 'NOT_FOUND')
  } finally {
    cleanup(ws)
  }
})

// ---------------------------------------------------------------------------
// (a) Versioned refine keeps the prior version
// ---------------------------------------------------------------------------

test('plans:update refine writes a new version and keeps the prior one', () => {
  const ws = createTempWorkspace()
  try {
    const req = invoke(CH.reqCreate, { workspaceRoot: ws, title: 'Refine Target' })
    const reqId = req.value.requirement.id

    const draft = invoke(CH.planCreate, {
      workspaceRoot: ws,
      title: 'Feature Plan',
      markdown: '# Plan v1 contents\n',
      operation: 'draft',
      requirementId: reqId
    })
    const priorPlan = draft.value.plan
    assert.strictEqual(priorPlan.version, 1)

    const refined = invoke(CH.planUpdate, {
      workspaceRoot: ws,
      planId: priorPlan.id,
      markdown: '# Plan v2 refined contents\n',
      operation: 'refine',
      requirementId: reqId
    })
    assertNormalized(refined)
    assert.strictEqual(refined.ok, true)

    const newPlan = refined.value.plan
    assert.notStrictEqual(newPlan.id, priorPlan.id)
    assert.strictEqual(newPlan.version, 2)
    assert.strictEqual(newPlan.supersedesPlanId, priorPlan.id)

    // Both version files exist on disk — history is never overwritten.
    const priorFull = path.join(ws, priorPlan.relativePath)
    const newFull = path.join(ws, newPlan.relativePath)
    assert.ok(fs.existsSync(priorFull), 'prior plan file must survive refine')
    assert.ok(fs.existsSync(newFull), 'new plan version file must exist')
    assert.ok(fs.readFileSync(priorFull, 'utf8').includes('Plan v1 contents'))
    assert.ok(fs.readFileSync(newFull, 'utf8').includes('Plan v2 refined contents'))

    // The sidecar carries the supersedes link on disk.
    const metaFull = path.join(ws, newPlan.relativePath.replace(/\.md$/, '.meta.json'))
    assert.ok(fs.existsSync(metaFull), 'refine must write a meta sidecar')
    const meta = JSON.parse(fs.readFileSync(metaFull, 'utf8'))
    assert.strictEqual(meta.supersedesPlanId, priorPlan.id)
    assert.strictEqual(meta.version, 2)

    // Requirement trace records both plan ids.
    const traceRead = invoke(CH.reqRead, { workspaceRoot: ws, requirementId: reqId })
    assert.ok(traceRead.value.trace.linkedPlanIds.includes(priorPlan.id))
    assert.ok(traceRead.value.trace.linkedPlanIds.includes(newPlan.id))
    const linkEntry = traceRead.value.trace.history.find(
      (h) => h.kind === 'plan_linked' && h.metadata && h.metadata.supersedesPlanId === priorPlan.id
    )
    assert.ok(linkEntry, 'trace must record the supersedes link')

    // A third refine walks the version chain from disk to v3.
    const refined3 = invoke(CH.planUpdate, {
      workspaceRoot: ws,
      planId: newPlan.id,
      markdown: '# Plan v3\n',
      operation: 'refine'
    })
    assert.strictEqual(refined3.value.plan.version, 3)
    assert.strictEqual(refined3.value.plan.supersedesPlanId, newPlan.id)
  } finally {
    cleanup(ws)
  }
})

// ---------------------------------------------------------------------------
// (b) Invalid payloads => structured error (never a throw)
// ---------------------------------------------------------------------------

test('invalid payloads return structured errors, not throws', () => {
  const ws = createTempWorkspace()
  try {
    // null payload
    const nullPayload = invoke(CH.reqCreate, null)
    assertNormalized(nullPayload)
    assert.strictEqual(nullPayload.ok, false)
    assert.strictEqual(nullPayload.code, 'INVALID_PAYLOAD')

    // missing title
    const noTitle = invoke(CH.reqCreate, { workspaceRoot: ws })
    assert.strictEqual(noTitle.ok, false)
    assert.strictEqual(noTitle.code, 'MISSING_TITLE')

    // invalid requirement source
    const badSource = invoke(CH.reqCreate, { workspaceRoot: ws, title: 'x', source: 'bogus' })
    assert.strictEqual(badSource.ok, false)
    assert.strictEqual(badSource.code, 'INVALID_SOURCE')

    // invalid plan operation
    const badOp = invoke(CH.planCreate, { workspaceRoot: ws, markdown: '# x', operation: 'nope' })
    assert.strictEqual(badOp.ok, false)
    assert.strictEqual(badOp.code, 'INVALID_OPERATION')

    // plan create with no markdown
    const noMd = invoke(CH.planCreate, { workspaceRoot: ws, operation: 'draft' })
    assert.strictEqual(noMd.ok, false)
    assert.strictEqual(noMd.code, 'MISSING_MARKDOWN')

    // changeset with empty files
    const emptyCs = invoke(CH.csCreate, {
      workspaceRoot: ws,
      title: 'x',
      summary: '',
      source: 'agent',
      files: []
    })
    assert.strictEqual(emptyCs.ok, false)
    assert.strictEqual(emptyCs.code, 'EMPTY_CHANGESET')

    // refine without planId
    const noPlanId = invoke(CH.planUpdate, { workspaceRoot: ws, markdown: '# x' })
    assert.strictEqual(noPlanId.ok, false)
    assert.strictEqual(noPlanId.code, 'MISSING_PLAN_ID')
  } finally {
    cleanup(ws)
  }
})

// ---------------------------------------------------------------------------
// (c) Security denial paths (REQUIRED by the plan)
// ---------------------------------------------------------------------------

test('missing workspace root fails closed on every entry point', () => {
  for (const channel of [
    CH.reqList, CH.reqCreate, CH.planList, CH.planCreate, CH.csList, CH.csCreate, CH.planUpdate,
    CH.designRead, CH.designWrite, CH.writeList, CH.writeCreate, CH.writeRead, CH.writeUpdate,
    CH.wfList, CH.wfCreate, CH.wfRead, CH.wfUpdate
  ]) {
    const res = invoke(channel, {})
    assertNormalized(res)
    assert.strictEqual(res.ok, false, channel + ' must fail on missing workspaceRoot')
    assert.strictEqual(res.code, 'MISSING_WORKSPACE_ROOT', channel + ' should report MISSING_WORKSPACE_ROOT')
  }
})

test('a refine with a traversal planRelativePath is refused', () => {
  const ws = createTempWorkspace()
  try {
    const res = invoke(CH.planUpdate, {
      workspaceRoot: ws,
      planId: 'some-plan',
      planRelativePath: '../../../../evil.md',
      markdown: '# evil\n',
      operation: 'refine'
    })
    assertNormalized(res)
    assert.strictEqual(res.ok, false)
    assert.strictEqual(res.code, 'UNSAFE_PATH')

    // Nothing was written outside the workspace root.
    assert.ok(!fs.existsSync(path.resolve(ws, '..', '..', '..', '..', 'evil.md')))
  } finally {
    cleanup(ws)
  }
})

test('a write with a traversal identifier stays contained under the workspace', () => {
  const ws = createTempWorkspace()
  try {
    // A malicious title cannot escape .hermes/workbench: it is sanitized into a
    // safe id, so the artifact is written inside the workspace, not above it.
    const res = invoke(CH.reqCreate, { workspaceRoot: ws, title: '../../../etc/passwd' })
    assertNormalized(res)
    assert.strictEqual(res.ok, true)

    const relDir = res.value.requirement.relativeDir
    assert.ok(relDir.startsWith('.hermes/workbench/requirements/'), 'artifact must live under the workbench dir')
    assert.ok(!relDir.includes('..'), 'artifact path must contain no traversal segments')

    const draftFull = path.resolve(ws, res.value.requirement.draftRelativePath)
    assert.ok(draftFull.startsWith(path.resolve(ws) + path.sep), 'resolved write path must be inside the workspace')
    assert.ok(fs.existsSync(draftFull))

    // No file escaped one level up out of the workspace root.
    assert.ok(!fs.existsSync(path.resolve(ws, '..', 'etc', 'passwd')))
  } finally {
    cleanup(ws)
  }
})

test('reading a traversal requirement id fails closed (NOT_FOUND, no escape)', () => {
  const ws = createTempWorkspace()
  try {
    const res = invoke(CH.reqRead, { workspaceRoot: ws, requirementId: '../../../../etc/passwd' })
    assertNormalized(res)
    assert.strictEqual(res.ok, false)
    assert.strictEqual(res.code, 'NOT_FOUND')
  } finally {
    cleanup(ws)
  }
})
