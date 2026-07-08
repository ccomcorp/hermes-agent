import { describe, it, expect } from 'vitest'
import {
  validateCreateRequirementRequest,
  validateUpdateRequirementRequest,
  validateCreatePlanRequest,
  validateCreateChangeSetRequest,
  validateWriteDesignSettingsRequest,
  validateCreateWriteProjectRequest,
  validateUpdateWriteProjectRequest,
  validateCreateWorkflowRequest,
  validateUpdateWorkflowRequest
} from './validators'
import type {
  CreateWorkbenchRequirementRequest,
  UpdateWorkbenchRequirementRequest,
  CreateWorkbenchPlanRequest,
  CreateWorkbenchChangeSetRequest,
  WriteWorkbenchDesignSettingsRequest,
  CreateWorkbenchWriteProjectRequest,
  UpdateWorkbenchWriteProjectRequest,
  CreateWorkbenchWorkflowRequest,
  UpdateWorkbenchWorkflowRequest,
  WorkbenchWorkflowNode
} from './types'

// ---------------------------------------------------------------------------
// Requirement validators
// ---------------------------------------------------------------------------

describe('validateCreateRequirementRequest', () => {
  const valid: CreateWorkbenchRequirementRequest = {
    workspaceRoot: 'C:/proj',
    title: 'My Requirement'
  }

  it('accepts a valid request', () => {
    expect(validateCreateRequirementRequest(valid)).toEqual({ ok: true })
  })

  it('accepts optional markdown', () => {
    expect(validateCreateRequirementRequest({ ...valid, markdown: '# Some content' })).toEqual({ ok: true })
  })

  it('rejects missing workspaceRoot', () => {
    const result = validateCreateRequirementRequest({ ...valid, workspaceRoot: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MISSING_WORKSPACE_ROOT')
  })

  it('rejects missing title', () => {
    const result = validateCreateRequirementRequest({ ...valid, title: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MISSING_TITLE')
  })

  it('rejects title that is only whitespace', () => {
    const result = validateCreateRequirementRequest({ ...valid, title: '   ' })
    expect(result.ok).toBe(false)
  })

  it('rejects invalid source', () => {
    const result = validateCreateRequirementRequest({ ...valid, source: 'invalid' as never })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_SOURCE')
  })

  it('rejects an oversized title', () => {
    const result = validateCreateRequirementRequest({ ...valid, title: 'a'.repeat(501) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('TITLE_TOO_LONG')
  })

  it('rejects oversized markdown', () => {
    const result = validateCreateRequirementRequest({ ...valid, markdown: 'a'.repeat(1_000_001) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MARKDOWN_TOO_LARGE')
  })
})

describe('validateUpdateRequirementRequest', () => {
  const valid: UpdateWorkbenchRequirementRequest = {
    workspaceRoot: 'C:/proj',
    requirementId: 'req-001',
    markdown: '# Updated content'
  }

  it('accepts a valid request', () => {
    expect(validateUpdateRequirementRequest(valid)).toEqual({ ok: true })
  })

  it('rejects missing requirementId', () => {
    const result = validateUpdateRequirementRequest({ ...valid, requirementId: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MISSING_REQUIREMENT_ID')
  })

  it('rejects missing markdown', () => {
    const result = validateUpdateRequirementRequest({ ...valid, markdown: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MISSING_MARKDOWN')
  })

  it('rejects invalid status', () => {
    const result = validateUpdateRequirementRequest({
      ...valid,
      status: 'invalid' as never
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_STATUS')
  })
})

// ---------------------------------------------------------------------------
// Plan validators
// ---------------------------------------------------------------------------

describe('validateCreatePlanRequest', () => {
  const valid: CreateWorkbenchPlanRequest = {
    workspaceRoot: 'C:/proj',
    markdown: '# My Plan',
    operation: 'draft'
  }

  it('accepts a valid request', () => {
    expect(validateCreatePlanRequest(valid)).toEqual({ ok: true })
  })

  it('rejects missing markdown', () => {
    const result = validateCreatePlanRequest({ ...valid, markdown: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MISSING_MARKDOWN')
  })

  it('rejects invalid operation', () => {
    const result = validateCreatePlanRequest({ ...valid, operation: 'invalid' as never })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_OPERATION')
  })

  it('rejects unsafe planRelativePath', () => {
    const result = validateCreatePlanRequest({
      ...valid,
      planRelativePath: '../escape.md'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('UNSAFE_PATH')
  })
})

// ---------------------------------------------------------------------------
// ChangeSet validators
// ---------------------------------------------------------------------------

describe('validateCreateChangeSetRequest', () => {
  const valid: CreateWorkbenchChangeSetRequest = {
    workspaceRoot: 'C:/proj',
    source: 'agent',
    title: 'My ChangeSet',
    summary: 'Some changes',
    files: [{ path: 'src/index.ts', status: 'pending' }]
  }

  it('accepts a valid request', () => {
    expect(validateCreateChangeSetRequest(valid)).toEqual({ ok: true })
  })

  it('rejects missing files array', () => {
    const result = validateCreateChangeSetRequest({ ...valid, files: undefined as never })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MISSING_FILES')
  })

  it('rejects empty files array', () => {
    const result = validateCreateChangeSetRequest({ ...valid, files: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('EMPTY_CHANGESET')
  })

  it('rejects invalid source', () => {
    const result = validateCreateChangeSetRequest({ ...valid, source: 'invalid' as never })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_SOURCE')
  })

  it('rejects missing file path', () => {
    const result = validateCreateChangeSetRequest({
      ...valid,
      files: [{ path: '', status: 'pending' }]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MISSING_FILE_PATH')
  })
})

// ---------------------------------------------------------------------------
// Design settings validators
// ---------------------------------------------------------------------------

describe('validateWriteDesignSettingsRequest', () => {
  const valid: WriteWorkbenchDesignSettingsRequest = {
    workspaceRoot: 'C:/proj',
    settings: {
      enabled: true,
      defaultViewport: 'desktop',
      designSystemPreset: 'none',
      tone: ['minimal', 'confident'],
      brandColor: '#336699',
      radius: 'soft',
      density: 'cozy',
      fontStyle: 'geometric',
      stackHint: 'react + tailwind',
      sandboxHtmlPreview: true
    }
  }

  it('accepts a valid request', () => {
    expect(validateWriteDesignSettingsRequest(valid)).toEqual({ ok: true })
  })

  it('accepts a request with only required fields', () => {
    const result = validateWriteDesignSettingsRequest({
      workspaceRoot: 'C:/proj',
      settings: {
        enabled: false,
        defaultViewport: 'mobile',
        designSystemPreset: 'shadcn',
        tone: [],
        sandboxHtmlPreview: false
      }
    })
    expect(result.ok).toBe(true)
  })

  it('rejects missing workspaceRoot', () => {
    const result = validateWriteDesignSettingsRequest({ ...valid, workspaceRoot: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MISSING_WORKSPACE_ROOT')
  })

  it('rejects a missing settings object', () => {
    const result = validateWriteDesignSettingsRequest({
      workspaceRoot: 'C:/proj',
      settings: undefined as never
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MISSING_SETTINGS')
  })

  it('rejects a non-boolean enabled flag', () => {
    const result = validateWriteDesignSettingsRequest({
      ...valid,
      settings: { ...valid.settings, enabled: 'yes' as never }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_ENABLED')
  })

  it('rejects an invalid defaultViewport', () => {
    const result = validateWriteDesignSettingsRequest({
      ...valid,
      settings: { ...valid.settings, defaultViewport: 'ultrawide' as never }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_VIEWPORT')
  })

  it('rejects an invalid designSystemPreset', () => {
    const result = validateWriteDesignSettingsRequest({
      ...valid,
      settings: { ...valid.settings, designSystemPreset: 'bogus' as never }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_PRESET')
  })

  it('rejects an oversized brandColor', () => {
    const result = validateWriteDesignSettingsRequest({
      ...valid,
      settings: { ...valid.settings, brandColor: 'a'.repeat(65) }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_BRAND_COLOR')
  })

  it('rejects a non-array tone', () => {
    const result = validateWriteDesignSettingsRequest({
      ...valid,
      settings: { ...valid.settings, tone: 'minimal' as never }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_TONE')
  })

  it('rejects too many tone entries', () => {
    const result = validateWriteDesignSettingsRequest({
      ...valid,
      settings: { ...valid.settings, tone: Array.from({ length: 21 }, (_, i) => `tone-${i}`) }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_TONE')
  })

  it('rejects an invalid radius', () => {
    const result = validateWriteDesignSettingsRequest({
      ...valid,
      settings: { ...valid.settings, radius: 'square' as never }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_RADIUS')
  })

  it('rejects an invalid density', () => {
    const result = validateWriteDesignSettingsRequest({
      ...valid,
      settings: { ...valid.settings, density: 'roomy' as never }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_DENSITY')
  })

  it('rejects an invalid fontStyle', () => {
    const result = validateWriteDesignSettingsRequest({
      ...valid,
      settings: { ...valid.settings, fontStyle: 'comic-sans' as never }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_FONT_STYLE')
  })

  it('rejects an oversized stackHint', () => {
    const result = validateWriteDesignSettingsRequest({
      ...valid,
      settings: { ...valid.settings, stackHint: 'a'.repeat(201) }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_STACK_HINT')
  })

  it('rejects a non-boolean sandboxHtmlPreview flag', () => {
    const result = validateWriteDesignSettingsRequest({
      ...valid,
      settings: { ...valid.settings, sandboxHtmlPreview: 'true' as never }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_SANDBOX_FLAG')
  })
})

// ---------------------------------------------------------------------------
// Write Workspace validators (Slice J)
// ---------------------------------------------------------------------------

describe('validateCreateWriteProjectRequest', () => {
  const valid: CreateWorkbenchWriteProjectRequest = {
    workspaceRoot: 'C:/proj',
    title: 'My Write Project'
  }

  it('accepts a valid request', () => {
    expect(validateCreateWriteProjectRequest(valid)).toEqual({ ok: true })
  })

  it('accepts optional markdown', () => {
    expect(validateCreateWriteProjectRequest({ ...valid, markdown: '# Some content' })).toEqual({ ok: true })
  })

  it('rejects missing workspaceRoot', () => {
    const result = validateCreateWriteProjectRequest({ ...valid, workspaceRoot: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MISSING_WORKSPACE_ROOT')
  })

  it('rejects missing title', () => {
    const result = validateCreateWriteProjectRequest({ ...valid, title: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MISSING_TITLE')
  })

  it('rejects title that is only whitespace', () => {
    const result = validateCreateWriteProjectRequest({ ...valid, title: '   ' })
    expect(result.ok).toBe(false)
  })

  it('rejects an oversized title', () => {
    const result = validateCreateWriteProjectRequest({ ...valid, title: 'a'.repeat(501) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('TITLE_TOO_LONG')
  })

  it('rejects oversized markdown', () => {
    const result = validateCreateWriteProjectRequest({ ...valid, markdown: 'a'.repeat(1_000_001) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MARKDOWN_TOO_LARGE')
  })
})

describe('validateUpdateWriteProjectRequest', () => {
  const valid: UpdateWorkbenchWriteProjectRequest = {
    workspaceRoot: 'C:/proj',
    writeProjectId: 'write-001',
    markdown: '# Updated content'
  }

  it('accepts a valid request', () => {
    expect(validateUpdateWriteProjectRequest(valid)).toEqual({ ok: true })
  })

  it('rejects missing writeProjectId', () => {
    const result = validateUpdateWriteProjectRequest({ ...valid, writeProjectId: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MISSING_WRITE_PROJECT_ID')
  })

  it('rejects missing markdown', () => {
    const result = validateUpdateWriteProjectRequest({ ...valid, markdown: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MISSING_MARKDOWN')
  })

  it('rejects an oversized title', () => {
    const result = validateUpdateWriteProjectRequest({ ...valid, title: 'a'.repeat(501) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('TITLE_TOO_LONG')
  })
})

// ---------------------------------------------------------------------------
// Workflow Designer validators (Slice M — AUTHORING ONLY)
//
// These validators must stay PERMISSIVE of all 12 declared
// WorkbenchWorkflowNodeKind values (the UI-side restriction to 3 creatable
// kinds is enforced only in the node palette, not here) while still failing
// closed on malformed nodes/edges and absurdly large graphs.
// ---------------------------------------------------------------------------

const ALL_NODE_KINDS: WorkbenchWorkflowNode['type'][] = [
  'manual_trigger', 'schedule_trigger', 'webhook_trigger', 'ai_agent',
  'human_approval', 'condition', 'http_request', 'code', 'delay', 'loop',
  'subworkflow', 'output'
]

function makeNode(overrides: Partial<WorkbenchWorkflowNode> = {}): WorkbenchWorkflowNode {
  return {
    id: 'n1',
    type: 'manual_trigger',
    name: 'Trigger',
    position: { x: 0, y: 0 },
    config: {},
    ...overrides
  }
}

describe('validateCreateWorkflowRequest', () => {
  const valid: CreateWorkbenchWorkflowRequest = {
    workspaceRoot: 'C:/proj',
    title: 'My Workflow'
  }

  it('accepts a valid request with no nodes/edges', () => {
    expect(validateCreateWorkflowRequest(valid)).toEqual({ ok: true })
  })

  it('accepts every declared node kind (backend stays permissive)', () => {
    for (const kind of ALL_NODE_KINDS) {
      const result = validateCreateWorkflowRequest({
        ...valid,
        nodes: [makeNode({ type: kind })]
      })
      expect(result.ok, `kind ${kind} should be accepted`).toBe(true)
    }
  })

  it('rejects missing workspaceRoot', () => {
    const result = validateCreateWorkflowRequest({ ...valid, workspaceRoot: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MISSING_WORKSPACE_ROOT')
  })

  it('rejects missing title', () => {
    const result = validateCreateWorkflowRequest({ ...valid, title: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MISSING_TITLE')
  })

  it('rejects an invalid node type', () => {
    const result = validateCreateWorkflowRequest({
      ...valid,
      nodes: [makeNode({ type: 'not_a_real_kind' as never })]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_NODE_TYPE')
  })

  it('rejects a node missing a name', () => {
    const result = validateCreateWorkflowRequest({
      ...valid,
      nodes: [makeNode({ name: '' })]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_NODE_NAME')
  })

  it('rejects a node with a non-numeric position', () => {
    const result = validateCreateWorkflowRequest({
      ...valid,
      nodes: [makeNode({ position: { x: 'nope', y: 0 } as never })]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_NODE_POSITION')
  })

  it('rejects oversized node.config', () => {
    const result = validateCreateWorkflowRequest({
      ...valid,
      nodes: [makeNode({ config: { blob: 'a'.repeat(50_001) } })]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NODE_CONFIG_TOO_LARGE')
  })

  it('rejects more than 500 nodes', () => {
    const result = validateCreateWorkflowRequest({
      ...valid,
      nodes: Array.from({ length: 501 }, (_, i) => makeNode({ id: `n${i}` }))
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('TOO_MANY_NODES')
  })

  it('rejects an edge referencing an unknown node', () => {
    const result = validateCreateWorkflowRequest({
      ...valid,
      nodes: [makeNode({ id: 'n1' })],
      edges: [{ id: 'e1', source: 'n1', target: 'ghost' }]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('EDGE_UNKNOWN_NODE')
  })

  it('accepts a valid edge between two declared nodes', () => {
    const result = validateCreateWorkflowRequest({
      ...valid,
      nodes: [makeNode({ id: 'n1' }), makeNode({ id: 'n2', type: 'output' })],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }]
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a non-boolean enabled flag', () => {
    const result = validateCreateWorkflowRequest({ ...valid, enabled: 'yes' as never })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_ENABLED')
  })
})

describe('validateUpdateWorkflowRequest', () => {
  const valid: UpdateWorkbenchWorkflowRequest = {
    workspaceRoot: 'C:/proj',
    workflowId: 'wf-001',
    nodes: [makeNode()],
    edges: []
  }

  it('accepts a valid request', () => {
    expect(validateUpdateWorkflowRequest(valid)).toEqual({ ok: true })
  })

  it('rejects missing workflowId', () => {
    const result = validateUpdateWorkflowRequest({ ...valid, workflowId: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('MISSING_WORKFLOW_ID')
  })

  it('rejects nodes that are not an array', () => {
    const result = validateUpdateWorkflowRequest({ ...valid, nodes: undefined as never })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INVALID_NODES')
  })

  it('rejects too many edges', () => {
    const nodes = [makeNode({ id: 'n1' }), makeNode({ id: 'n2', type: 'output' })]
    const result = validateUpdateWorkflowRequest({
      ...valid,
      nodes,
      edges: Array.from({ length: 2001 }, (_, i) => ({ id: `e${i}`, source: 'n1', target: 'n2' }))
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('TOO_MANY_EDGES')
  })
})
