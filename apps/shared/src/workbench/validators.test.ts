import { describe, it, expect } from 'vitest'
import {
  validateCreateRequirementRequest,
  validateUpdateRequirementRequest,
  validateCreatePlanRequest,
  validateCreateChangeSetRequest
} from './validators'
import type {
  CreateWorkbenchRequirementRequest,
  UpdateWorkbenchRequirementRequest,
  CreateWorkbenchPlanRequest,
  CreateWorkbenchChangeSetRequest
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
