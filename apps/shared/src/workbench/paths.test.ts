import { describe, expect, it } from 'vitest'

import {
  buildChangeSetRelativePath,
  buildPlanRelativePath,
  buildRequirementDraftRelativePath,
  buildRequirementRelativeDir,
  buildRequirementTraceRelativePath,
  buildWriteProjectDocumentRelativePath,
  buildWriteProjectMetaRelativePath,
  buildWriteProjectRelativeDir,
  isSafeWorkbenchRelativePath,
  normalizeWorkbenchRelativePath,
  resolveWorkbenchPath,
  sanitizeId
} from './paths'

describe('normalizeWorkbenchRelativePath', () => {
  it('normalizes backslashes to forward slashes', () => {
    expect(normalizeWorkbenchRelativePath('a\\b\\c')).toBe('a/b/c')
  })

  it('strips leading ./ and /', () => {
    expect(normalizeWorkbenchRelativePath('./a/b')).toBe('a/b')
    expect(normalizeWorkbenchRelativePath('/a/b')).toBe('a/b')
    // Only a single leading `./` prefix is stripped (not recursively).
    expect(normalizeWorkbenchRelativePath('././a')).toBe('./a')
  })

  it('collapses duplicate slashes', () => {
    expect(normalizeWorkbenchRelativePath('a//b///c')).toBe('a/b/c')
  })

  it('strips trailing slash', () => {
    expect(normalizeWorkbenchRelativePath('a/b/')).toBe('a/b')
  })

  it('normalizes plan-doc example fragments', () => {
    // ./.hermes/workbench/plans/x.md -> normalized
    expect(normalizeWorkbenchRelativePath('./.hermes/workbench/plans/x.md')).toBe(
      '.hermes/workbench/plans/x.md'
    )
    // .hermes\workbench\plans\x.md -> normalized (Windows separators)
    expect(normalizeWorkbenchRelativePath('.hermes\\workbench\\plans\\x.md')).toBe(
      '.hermes/workbench/plans/x.md'
    )
    // .hermes/workbench/requirements//x -> normalized (duplicate slash collapsed)
    expect(normalizeWorkbenchRelativePath('.hermes/workbench/requirements//x')).toBe(
      '.hermes/workbench/requirements/x'
    )
  })

  it('returns empty string for empty/whitespace input', () => {
    expect(normalizeWorkbenchRelativePath('')).toBe('')
    expect(normalizeWorkbenchRelativePath('   ')).toBe('')
    expect(normalizeWorkbenchRelativePath(null as unknown as string)).toBe('')
  })
})

describe('isSafeWorkbenchRelativePath', () => {
  it('accepts normal relative paths', () => {
    expect(isSafeWorkbenchRelativePath('requirements/abc/requirement.md')).toBe(true)
    expect(isSafeWorkbenchRelativePath('plans/my-plan.md')).toBe(true)
  })

  it('accepts paths with backslash separators', () => {
    expect(isSafeWorkbenchRelativePath('requirements\\abc\\requirement.md')).toBe(true)
  })

  it('rejects path traversal with ..', () => {
    expect(isSafeWorkbenchRelativePath('../etc/passwd')).toBe(false)
    expect(isSafeWorkbenchRelativePath('a/../../b')).toBe(false)
    // Any `..` segment is rejected outright (security doc: "Reject `..`
    // segments after normalization"), even when it would resolve within root.
    expect(isSafeWorkbenchRelativePath('a/../b')).toBe(false)
  })

  it('rejects absolute paths', () => {
    expect(isSafeWorkbenchRelativePath('C:/Users/test')).toBe(false)
    expect(isSafeWorkbenchRelativePath('\\\\server\\share')).toBe(false)
  })

  it('rejects empty strings', () => {
    expect(isSafeWorkbenchRelativePath('')).toBe(false)
    expect(isSafeWorkbenchRelativePath('   ')).toBe(false)
  })

  it('accepts workbench-relative artifact paths', () => {
    expect(
      isSafeWorkbenchRelativePath('.hermes/workbench/requirements/abc/requirement.md')
    ).toBe(true)
    expect(isSafeWorkbenchRelativePath('./.hermes/workbench/plans/x.md')).toBe(true)
    expect(isSafeWorkbenchRelativePath('.hermes\\workbench\\plans\\x.md')).toBe(true)
  })

  it('rejects traversal that escapes the workbench root', () => {
    expect(isSafeWorkbenchRelativePath('../secret')).toBe(false)
    expect(isSafeWorkbenchRelativePath('.hermes/workbench/../../.env')).toBe(false)
  })

  it('rejects Windows absolute paths written with backslashes', () => {
    expect(isSafeWorkbenchRelativePath('C:\\Users\\x\\.env')).toBe(false)
  })

  it('rejects POSIX-absolute input outright instead of silently containing it', () => {
    // normalizeWorkbenchRelativePath('/etc/passwd') strips the leading `/`
    // and would otherwise yield the "contained" relative path 'etc/passwd'.
    // Fail-closed: absolute input must be rejected, not rewritten.
    expect(isSafeWorkbenchRelativePath('/etc/passwd')).toBe(false)
    expect(isSafeWorkbenchRelativePath('/absolute/but/nested')).toBe(false)
  })
})

describe('buildRequirementRelativeDir', () => {
  it('builds correct path', () => {
    expect(buildRequirementRelativeDir('req-001')).toBe('.hermes/workbench/requirements/req-001')
  })

  it('sanitizes the ID', () => {
    expect(buildRequirementRelativeDir('REQ 001!')).toBe('.hermes/workbench/requirements/req-001')
  })
})

describe('buildRequirementDraftRelativePath', () => {
  it('builds correct path', () => {
    expect(buildRequirementDraftRelativePath('req-001')).toBe(
      '.hermes/workbench/requirements/req-001/requirement.md'
    )
  })
})

describe('buildRequirementTraceRelativePath', () => {
  it('builds correct path', () => {
    expect(buildRequirementTraceRelativePath('req-001')).toBe(
      '.hermes/workbench/requirements/req-001/trace.json'
    )
  })
})

describe('buildPlanRelativePath', () => {
  it('builds correct path', () => {
    expect(buildPlanRelativePath('plan-001')).toBe('.hermes/workbench/plans/plan-001.md')
  })
})

describe('buildChangeSetRelativePath', () => {
  it('builds correct path', () => {
    expect(buildChangeSetRelativePath('cs-001')).toBe('.hermes/workbench/changesets/cs-001.json')
  })
})

describe('sanitizeId', () => {
  it('lowercases and replaces unsafe chars', () => {
    expect(sanitizeId('My Req 001!')).toBe('my-req-001')
  })

  it('collapses multiple hyphens', () => {
    expect(sanitizeId('a---b')).toBe('a-b')
  })

  it('strips leading/trailing hyphens', () => {
    expect(sanitizeId('--a--')).toBe('a')
  })

  it('handles empty input', () => {
    expect(sanitizeId('')).toBe('')
  })
})

describe('resolveWorkbenchPath', () => {
  it('joins workspace root and relative path', () => {
    expect(resolveWorkbenchPath('C:/proj', 'requirements/abc/requirement.md')).toBe(
      'C:/proj/requirements/abc/requirement.md'
    )
  })

  it('handles trailing slash in workspace root', () => {
    expect(resolveWorkbenchPath('C:/proj/', 'requirements/abc')).toBe(
      'C:/proj/requirements/abc'
    )
  })

  it('normalizes backslashes in workspace root', () => {
    expect(resolveWorkbenchPath('C:\\proj', 'a/b')).toBe('C:/proj/a/b')
  })
})

describe('Write Workspace path builders', () => {
  it('builds the relative dir', () => {
    expect(buildWriteProjectRelativeDir('My Doc')).toBe('.hermes/workbench/write/my-doc')
  })

  it('builds the document path', () => {
    expect(buildWriteProjectDocumentRelativePath('My Doc')).toBe('.hermes/workbench/write/my-doc/document.md')
  })

  it('builds the metadata sidecar path', () => {
    expect(buildWriteProjectMetaRelativePath('My Doc')).toBe('.hermes/workbench/write/my-doc/project.json')
  })
})
