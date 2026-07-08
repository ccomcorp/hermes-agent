// Hermes Workbench path helpers.
//
// Workbench artifacts are workspace-relative project files. Keep all writes
// under .hermes/workbench unless the user explicitly chose an external save
// path. These functions centralize path normalization so security bugs don't
// come from duplicated normalization logic across UI and backend.

import {
  HERMES_REQUIREMENTS_DIR,
  HERMES_PLANS_DIR,
  HERMES_CHANGESETS_DIR
} from './types'

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a workbench-relative path fragment.
 *
 * - Converts backslashes to forward slashes (Windows safety)
 * - Strips leading `./` and `/`
 * - Collapses duplicate slashes
 * - Rejects `..` traversal
 * - Returns empty string for empty/whitespace input
 */
export function normalizeWorkbenchRelativePath(value: string): string {
  if (!value || typeof value !== 'string') return ''

  let path = value.trim()

  // Convert backslashes to forward slashes
  path = path.replace(/\\/g, '/')

  // Strip leading `./` and `/`
  path = path.replace(/^\.\/+/, '')
  path = path.replace(/^\/+/, '')

  // Collapse duplicate slashes
  path = path.replace(/\/{2,}/g, '/')

  // Strip trailing slash (unless it's the root)
  path = path.replace(/\/$/, '')

  return path
}

/**
 * Check whether a relative path is safe for workbench artifact storage.
 *
 * Rejects:
 * - Absolute paths (Windows drive letters, POSIX leading `/`, UNC `\\`)
 * - Path traversal (`..` segments)
 * - Empty strings
 */
export function isSafeWorkbenchRelativePath(value: string): boolean {
  if (!value || typeof value !== 'string') return false

  const normalized = normalizeWorkbenchRelativePath(value)

  if (!normalized) return false

  // Reject absolute paths (Windows drive letter or UNC)
  if (/^[a-zA-Z]:/.test(value)) return false
  if (value.startsWith('\\\\')) return false

  // Reject POSIX-absolute paths (leading `/`) on the ORIGINAL input.
  // normalizeWorkbenchRelativePath() strips a leading `/` to make the
  // result relative (needed for legitimate relative-path normalization,
  // e.g. `./x` or duplicate slashes), but that means absolute input like
  // `/etc/passwd` would otherwise be silently rewritten into a "safe"
  // relative path instead of being rejected. Fail closed: absolute input
  // is invalid input, not something to coerce into relative.
  if (/^\/+/.test(value.trim())) return false

  // Reject path traversal — check both the original and normalized
  const segments = normalized.split('/')
  if (segments.includes('..')) return false

  // Reject paths that resolve above root after normalization
  let depth = 0
  for (const seg of segments) {
    if (seg === '..') depth--
    else if (seg !== '.') depth++
    if (depth < 0) return false
  }

  return true
}

// ---------------------------------------------------------------------------
// Requirement path builders
// ---------------------------------------------------------------------------

export function buildRequirementRelativeDir(requirementId: string): string {
  const safeId = sanitizeId(requirementId)
  return `${HERMES_REQUIREMENTS_DIR}/${safeId}`
}

export function buildRequirementDraftRelativePath(requirementId: string): string {
  const safeId = sanitizeId(requirementId)
  return `${HERMES_REQUIREMENTS_DIR}/${safeId}/requirement.md`
}

export function buildRequirementTraceRelativePath(requirementId: string): string {
  const safeId = sanitizeId(requirementId)
  return `${HERMES_REQUIREMENTS_DIR}/${safeId}/trace.json`
}

// ---------------------------------------------------------------------------
// Plan path builders
// ---------------------------------------------------------------------------

export function buildPlanRelativePath(planSlugOrId: string): string {
  const safeId = sanitizeId(planSlugOrId)
  return `${HERMES_PLANS_DIR}/${safeId}.md`
}

// ---------------------------------------------------------------------------
// ChangeSet path builders
// ---------------------------------------------------------------------------

export function buildChangeSetRelativePath(changesetId: string): string {
  const safeId = sanitizeId(changesetId)
  return `${HERMES_CHANGESETS_DIR}/${safeId}.json`
}

// ---------------------------------------------------------------------------
// ID sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize an artifact ID for safe use in file paths.
 * Allows alphanumeric, hyphens, underscores. Trims and lowercases.
 */
export function sanitizeId(id: string): string {
  if (!id || typeof id !== 'string') return ''
  return id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ---------------------------------------------------------------------------
// Full path resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a workspace root + relative path into a full path.
 * Does NOT do filesystem operations — just string joining.
 */
export function resolveWorkbenchPath(workspaceRoot: string, relativePath: string): string {
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '')
  const rel = normalizeWorkbenchRelativePath(relativePath)
  return `${root}/${rel}`
}
