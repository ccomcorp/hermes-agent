import { describe, it, expect } from 'vitest'
import {
  validateCreateRequirementRequest,
  validateUpdateRequirementRequest,
  validateCreatePlanRequest,
  validateCreateChangeSetRequest,
  validateWriteDesignSettingsRequest
} from './validators'
import type {
  CreateWorkbenchRequirementRequest,
  UpdateWorkbenchRequirementRequest,
  CreateWorkbenchPlanRequest,
  CreateWorkbenchChangeSetRequest,
  WriteWorkbenchDesignSettingsRequest
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
