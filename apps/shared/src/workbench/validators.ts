// Hermes Workbench validators.
//
// Validate artifact requests at every boundary — IPC handlers, backend APIs,
// and UI actions should all pass through these before filesystem writes.

import type {
  CreateWorkbenchRequirementRequest,
  UpdateWorkbenchRequirementRequest,
  CreateWorkbenchPlanRequest,
  CreateWorkbenchChangeSetRequest,
  WorkbenchRequirementStatus,
  WorkbenchChangeSetStatus,
  WorkbenchChangeSource,
  WorkbenchPlanOperation
} from './types'
import { isSafeWorkbenchRelativePath } from './paths'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TITLE_LENGTH = 500
const MAX_MARKDOWN_LENGTH = 1_000_000 // 1 MB
const MAX_SOURCE_REQUEST_LENGTH = 10_000
const MAX_SUMMARY_LENGTH = 5_000
const MAX_FILES_PER_CHANGESET = 500
const MAX_INSTRUCTION_LENGTH = 5_000
const MAX_FILE_PATH_LENGTH = 1_000

const VALID_REQUIREMENT_STATUSES: readonly WorkbenchRequirementStatus[] = [
  'draft', 'clarified', 'planned', 'in_progress',
  'implemented', 'reviewed', 'verified', 'archived'
]

const VALID_CHANGESET_STATUSES: readonly WorkbenchChangeSetStatus[] = [
  'pending', 'partially_accepted', 'accepted', 'rejected', 'applied', 'archived'
]

const VALID_CHANGE_SOURCES: readonly WorkbenchChangeSource[] = [
  'agent', 'plan_implementation', 'design_implementation',
  'write_inline_edit', 'workflow', 'manual'
]

const VALID_PLAN_OPERATIONS: readonly WorkbenchPlanOperation[] = ['draft', 'refine']

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { ok: true }
  | { ok: false; message: string; code?: string }

function ok(): ValidationResult {
  return { ok: true }
}

function fail(message: string, code?: string): ValidationResult {
  return { ok: false, message, code }
}

// ---------------------------------------------------------------------------
// Shared field validators
// ---------------------------------------------------------------------------

function validateWorkspaceRoot(value: string): ValidationResult {
  if (!value || typeof value !== 'string') {
    return fail('workspaceRoot is required', 'MISSING_WORKSPACE_ROOT')
  }
  if (value.length > MAX_FILE_PATH_LENGTH) {
    return fail('workspaceRoot is too long', 'WORKSPACE_ROOT_TOO_LONG')
  }
  return ok()
}

function validateTitle(value: string): ValidationResult {
  if (!value || typeof value !== 'string' || !value.trim()) {
    return fail('title is required', 'MISSING_TITLE')
  }
  if (value.length > MAX_TITLE_LENGTH) {
    return fail('title is too long', 'TITLE_TOO_LONG')
  }
  return ok()
}

function validateMarkdown(value: string | undefined, required: boolean): ValidationResult {
  if (required && (!value || !value.trim())) {
    return fail('markdown is required', 'MISSING_MARKDOWN')
  }
  if (value && value.length > MAX_MARKDOWN_LENGTH) {
    return fail('markdown exceeds size limit', 'MARKDOWN_TOO_LARGE')
  }
  return ok()
}

// ---------------------------------------------------------------------------
// Requirement validators
// ---------------------------------------------------------------------------

export function validateCreateRequirementRequest(
  input: CreateWorkbenchRequirementRequest
): ValidationResult {
  const rootCheck = validateWorkspaceRoot(input.workspaceRoot)
  if (!rootCheck.ok) return rootCheck

  const titleCheck = validateTitle(input.title)
  if (!titleCheck.ok) return titleCheck

  const mdCheck = validateMarkdown(input.markdown, false)
  if (!mdCheck.ok) return mdCheck

  if (input.source && !['user', 'chat', 'import'].includes(input.source)) {
    return fail('invalid source', 'INVALID_SOURCE')
  }

  if (input.sourceSessionId && input.sourceSessionId.length > MAX_TITLE_LENGTH) {
    return fail('sourceSessionId is too long', 'SOURCE_SESSION_ID_TOO_LONG')
  }

  return ok()
}

export function validateUpdateRequirementRequest(
  input: UpdateWorkbenchRequirementRequest
): ValidationResult {
  const rootCheck = validateWorkspaceRoot(input.workspaceRoot)
  if (!rootCheck.ok) return rootCheck

  if (!input.requirementId || !input.requirementId.trim()) {
    return fail('requirementId is required', 'MISSING_REQUIREMENT_ID')
  }

  const mdCheck = validateMarkdown(input.markdown, true)
  if (!mdCheck.ok) return mdCheck

  if (input.title) {
    const titleCheck = validateTitle(input.title)
    if (!titleCheck.ok) return titleCheck
  }

  if (input.status && !VALID_REQUIREMENT_STATUSES.includes(input.status)) {
    return fail('invalid requirement status', 'INVALID_STATUS')
  }

  return ok()
}

// ---------------------------------------------------------------------------
// Plan validators
// ---------------------------------------------------------------------------

export function validateCreatePlanRequest(
  input: CreateWorkbenchPlanRequest
): ValidationResult {
  const rootCheck = validateWorkspaceRoot(input.workspaceRoot)
  if (!rootCheck.ok) return rootCheck

  const mdCheck = validateMarkdown(input.markdown, true)
  if (!mdCheck.ok) return mdCheck

  if (input.title) {
    const titleCheck = validateTitle(input.title)
    if (!titleCheck.ok) return titleCheck
  }

  if (input.sourceRequest && input.sourceRequest.length > MAX_SOURCE_REQUEST_LENGTH) {
    return fail('sourceRequest is too long', 'SOURCE_REQUEST_TOO_LONG')
  }

  if (!VALID_PLAN_OPERATIONS.includes(input.operation)) {
    return fail('invalid plan operation', 'INVALID_OPERATION')
  }

  if (input.requirementId && !input.requirementId.trim()) {
    return fail('requirementId must not be empty if provided', 'EMPTY_REQUIREMENT_ID')
  }

  if (input.planRelativePath && !isSafeWorkbenchRelativePath(input.planRelativePath)) {
    return fail('planRelativePath is not a safe workbench path', 'UNSAFE_PATH')
  }

  return ok()
}

// ---------------------------------------------------------------------------
// ChangeSet validators
// ---------------------------------------------------------------------------

export function validateCreateChangeSetRequest(
  input: CreateWorkbenchChangeSetRequest
): ValidationResult {
  const rootCheck = validateWorkspaceRoot(input.workspaceRoot)
  if (!rootCheck.ok) return rootCheck

  const titleCheck = validateTitle(input.title)
  if (!titleCheck.ok) return titleCheck

  if (input.summary && input.summary.length > MAX_SUMMARY_LENGTH) {
    return fail('summary is too long', 'SUMMARY_TOO_LONG')
  }

  if (!VALID_CHANGE_SOURCES.includes(input.source)) {
    return fail('invalid change source', 'INVALID_SOURCE')
  }

  if (!input.files || !Array.isArray(input.files)) {
    return fail('files is required and must be an array', 'MISSING_FILES')
  }

  if (input.files.length > MAX_FILES_PER_CHANGESET) {
    return fail('too many files in changeset', 'TOO_MANY_FILES')
  }

  if (input.files.length === 0) {
    return fail('changeset must contain at least one file', 'EMPTY_CHANGESET')
  }

  for (const file of input.files) {
    if (!file.path || typeof file.path !== 'string') {
      return fail('file.path is required', 'MISSING_FILE_PATH')
    }
    if (file.path.length > MAX_FILE_PATH_LENGTH) {
      return fail('file.path is too long', 'FILE_PATH_TOO_LONG')
    }
    if (file.diff && file.diff.length > MAX_MARKDOWN_LENGTH) {
      return fail('file.diff exceeds size limit', 'DIFF_TOO_LARGE')
    }
  }

  if (input.requirementId && !input.requirementId.trim()) {
    return fail('requirementId must not be empty if provided', 'EMPTY_REQUIREMENT_ID')
  }

  if (input.planId && !input.planId.trim()) {
    return fail('planId must not be empty if provided', 'EMPTY_PLAN_ID')
  }

  return ok()
}
