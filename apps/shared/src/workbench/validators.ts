// Hermes Workbench validators.
//
// Validate artifact requests at every boundary — IPC handlers, backend APIs,
// and UI actions should all pass through these before filesystem writes.

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
  WorkbenchRequirementStatus,
  WorkbenchChangeSetStatus,
  WorkbenchChangeSource,
  WorkbenchPlanOperation,
  WorkbenchDesignSettings,
  WorkbenchWorkflowNode,
  WorkbenchWorkflowNodeKind,
  WorkbenchWriteExportFormat,
  WorkbenchWriteExportRequest
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
const MAX_BRAND_COLOR_LENGTH = 64
const MAX_STACK_HINT_LENGTH = 200
const MAX_TONE_ITEMS = 20
const MAX_TONE_ITEM_LENGTH = 100

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

const VALID_VIEWPORTS: readonly WorkbenchDesignSettings['defaultViewport'][] = ['mobile', 'tablet', 'desktop']

const VALID_DESIGN_PRESETS: readonly WorkbenchDesignSettings['designSystemPreset'][] = [
  'none', 'shadcn', 'radix', 'material', 'ios', 'fluent', 'ant',
  'chakra', 'carbon', 'polaris', 'bootstrap', 'geist', 'brutalism', 'editorial'
]

const VALID_RADIUS_VALUES: readonly NonNullable<WorkbenchDesignSettings['radius']>[] = [
  'sharp', 'soft', 'rounded', 'pill'
]

const VALID_DENSITY_VALUES: readonly NonNullable<WorkbenchDesignSettings['density']>[] = [
  'compact', 'cozy', 'spacious'
]

const VALID_FONT_STYLE_VALUES: readonly NonNullable<WorkbenchDesignSettings['fontStyle']>[] = [
  'system', 'geometric', 'humanist', 'serif', 'mono'
]

// Workflow Designer (Slice M). The backend/validator layer stays PERMISSIVE of
// all 12 declared node kinds — the UI-side restriction to 3 creatable kinds
// (manual_trigger/condition/output) is enforced only in the node palette
// (workflow-panel.tsx), not here, since later slices will need to persist
// ai_agent/code/etc. nodes too. This validator never interprets `config`.
const VALID_WORKFLOW_NODE_KINDS: readonly WorkbenchWorkflowNodeKind[] = [
  'manual_trigger', 'schedule_trigger', 'webhook_trigger', 'ai_agent',
  'human_approval', 'condition', 'http_request', 'code', 'delay', 'loop',
  'subworkflow', 'output'
]

// 500 nodes is a generous ceiling for a hand-authored graph (no execution
// engine exists to make a larger graph useful yet); it exists only to reject
// pathological/malicious payloads, not to constrain real usage.
const MAX_WORKFLOW_NODES = 500
// Edges are naturally denser than nodes in a real graph (multiple connections
// per node); 2000 keeps headroom well above what 500 nodes could plausibly
// need while still rejecting absurd payloads.
const MAX_WORKFLOW_EDGES = 2000
const MAX_NODE_NAME_LENGTH = 200
// `config` is authoring-time-only data (e.g. a condition's expression text, an
// output's label) — capped like any other free-text field. It is NEVER
// evaluated/executed by any code in this slice.
const MAX_NODE_CONFIG_JSON_LENGTH = 50_000

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

// ---------------------------------------------------------------------------
// Design settings validators (Slice F — settings only, not artifacts)
// ---------------------------------------------------------------------------

export function validateWriteDesignSettingsRequest(
  input: WriteWorkbenchDesignSettingsRequest
): ValidationResult {
  const rootCheck = validateWorkspaceRoot(input.workspaceRoot)
  if (!rootCheck.ok) return rootCheck

  const settings = input.settings

  if (!settings || typeof settings !== 'object') {
    return fail('settings is required', 'MISSING_SETTINGS')
  }

  if (typeof settings.enabled !== 'boolean') {
    return fail('settings.enabled must be a boolean', 'INVALID_ENABLED')
  }

  if (!VALID_VIEWPORTS.includes(settings.defaultViewport)) {
    return fail('invalid defaultViewport', 'INVALID_VIEWPORT')
  }

  if (!VALID_DESIGN_PRESETS.includes(settings.designSystemPreset)) {
    return fail('invalid designSystemPreset', 'INVALID_PRESET')
  }

  if (settings.brandColor !== undefined) {
    if (typeof settings.brandColor !== 'string' || settings.brandColor.length > MAX_BRAND_COLOR_LENGTH) {
      return fail('brandColor is invalid', 'INVALID_BRAND_COLOR')
    }
  }

  if (!Array.isArray(settings.tone)) {
    return fail('tone must be an array', 'INVALID_TONE')
  }

  if (settings.tone.length > MAX_TONE_ITEMS) {
    return fail('too many tone entries', 'INVALID_TONE')
  }

  if (settings.tone.some(entry => typeof entry !== 'string' || entry.length > MAX_TONE_ITEM_LENGTH)) {
    return fail('tone entries must be short strings', 'INVALID_TONE')
  }

  if (settings.radius !== undefined && !VALID_RADIUS_VALUES.includes(settings.radius)) {
    return fail('invalid radius', 'INVALID_RADIUS')
  }

  if (settings.density !== undefined && !VALID_DENSITY_VALUES.includes(settings.density)) {
    return fail('invalid density', 'INVALID_DENSITY')
  }

  if (settings.fontStyle !== undefined && !VALID_FONT_STYLE_VALUES.includes(settings.fontStyle)) {
    return fail('invalid fontStyle', 'INVALID_FONT_STYLE')
  }

  if (settings.stackHint !== undefined) {
    if (typeof settings.stackHint !== 'string' || settings.stackHint.length > MAX_STACK_HINT_LENGTH) {
      return fail('stackHint is invalid', 'INVALID_STACK_HINT')
    }
  }

  if (typeof settings.sandboxHtmlPreview !== 'boolean') {
    return fail('settings.sandboxHtmlPreview must be a boolean', 'INVALID_SANDBOX_FLAG')
  }

  return ok()
}

// ---------------------------------------------------------------------------
// Write Workspace validators (Slice J — CRUD only, go-forward plan §5)
//
// A write project is a single markdown document + metadata, same shape and
// same field limits as a Requirement. No AI-rewrite/export/retrieval fields
// exist on these requests — that is Slice K/L, out of scope here.
// ---------------------------------------------------------------------------

export function validateCreateWriteProjectRequest(
  input: CreateWorkbenchWriteProjectRequest
): ValidationResult {
  const rootCheck = validateWorkspaceRoot(input.workspaceRoot)
  if (!rootCheck.ok) return rootCheck

  const titleCheck = validateTitle(input.title)
  if (!titleCheck.ok) return titleCheck

  const mdCheck = validateMarkdown(input.markdown, false)
  if (!mdCheck.ok) return mdCheck

  return ok()
}

export function validateUpdateWriteProjectRequest(
  input: UpdateWorkbenchWriteProjectRequest
): ValidationResult {
  const rootCheck = validateWorkspaceRoot(input.workspaceRoot)
  if (!rootCheck.ok) return rootCheck

  if (!input.writeProjectId || !input.writeProjectId.trim()) {
    return fail('writeProjectId is required', 'MISSING_WRITE_PROJECT_ID')
  }

  const mdCheck = validateMarkdown(input.markdown, true)
  if (!mdCheck.ok) return mdCheck

  if (input.title) {
    const titleCheck = validateTitle(input.title)
    if (!titleCheck.ok) return titleCheck
  }

  return ok()
}

// ---------------------------------------------------------------------------
// Write Workspace export validators (Slice L, go-forward plan §5)
//
// The export target path always comes from the OS save dialog — nothing here
// validates or constructs a filesystem path. `workspaceRoot`/`writeProjectId`
// get the same fail-closed checks every other request gets (defense in depth
// backing the UI's "no open write project -> no export action" rule); `html`
// is the already-rendered standalone document the renderer built.
// ---------------------------------------------------------------------------

const VALID_WRITE_EXPORT_FORMATS: readonly WorkbenchWriteExportFormat[] = ['html', 'pdf', 'docx', 'png']

// A rendered export document is markdown-derived HTML, not user-pasted raw
// text, so it can legitimately be a few times larger than MAX_MARKDOWN_LENGTH
// once tags/CSS are included — 5 MB is a generous ceiling that only exists to
// reject pathological/malicious payloads.
const MAX_EXPORT_HTML_LENGTH = 5_000_000

export function validateExportWriteProjectRequest(
  input: WorkbenchWriteExportRequest
): ValidationResult {
  const rootCheck = validateWorkspaceRoot(input.workspaceRoot)
  if (!rootCheck.ok) return rootCheck

  if (!input.writeProjectId || !input.writeProjectId.trim()) {
    return fail('writeProjectId is required', 'MISSING_WRITE_PROJECT_ID')
  }

  if (!input.format || !VALID_WRITE_EXPORT_FORMATS.includes(input.format)) {
    return fail('invalid export format', 'INVALID_FORMAT')
  }

  if (!input.html || typeof input.html !== 'string' || !input.html.trim()) {
    return fail('html is required', 'MISSING_HTML')
  }

  if (input.html.length > MAX_EXPORT_HTML_LENGTH) {
    return fail('html exceeds size limit', 'HTML_TOO_LARGE')
  }

  if (input.title) {
    const titleCheck = validateTitle(input.title)
    if (!titleCheck.ok) return titleCheck
  }

  return ok()
}

// ---------------------------------------------------------------------------
// Workflow Designer validators (Slice M — AUTHORING ONLY, go-forward plan §5)
//
// A WorkbenchWorkflow is a document + metadata, the same structural model as
// a Requirement/Write project. These validators never interpret, evaluate, or
// execute any node's `config` — they only bound its size like any other
// free-text field. Fail closed on missing workspace root, empty/oversized
// title, invalid node kinds, and absurdly large graphs.
// ---------------------------------------------------------------------------

function validateWorkflowNodes(nodes: unknown): ValidationResult {
  if (!Array.isArray(nodes)) {
    return fail('nodes must be an array', 'INVALID_NODES')
  }

  if (nodes.length > MAX_WORKFLOW_NODES) {
    return fail('too many nodes', 'TOO_MANY_NODES')
  }

  for (const node of nodes) {
    if (!node || typeof node !== 'object') {
      return fail('each node must be an object', 'INVALID_NODE')
    }

    const candidate = node as Partial<WorkbenchWorkflowNode>

    if (!candidate.id || typeof candidate.id !== 'string') {
      return fail('node.id is required', 'MISSING_NODE_ID')
    }

    if (!candidate.type || !VALID_WORKFLOW_NODE_KINDS.includes(candidate.type)) {
      return fail('invalid node type', 'INVALID_NODE_TYPE')
    }

    if (!candidate.name || typeof candidate.name !== 'string' || candidate.name.length > MAX_NODE_NAME_LENGTH) {
      return fail('node.name is required and must be a reasonable length', 'INVALID_NODE_NAME')
    }

    if (
      !candidate.position ||
      typeof candidate.position.x !== 'number' ||
      typeof candidate.position.y !== 'number'
    ) {
      return fail('node.position must have numeric x/y', 'INVALID_NODE_POSITION')
    }

    if (candidate.config !== undefined) {
      if (typeof candidate.config !== 'object' || candidate.config === null) {
        return fail('node.config must be an object', 'INVALID_NODE_CONFIG')
      }

      if (JSON.stringify(candidate.config).length > MAX_NODE_CONFIG_JSON_LENGTH) {
        return fail('node.config exceeds size limit', 'NODE_CONFIG_TOO_LARGE')
      }
    }
  }

  return ok()
}

function validateWorkflowEdges(edges: unknown, nodes: WorkbenchWorkflowNode[]): ValidationResult {
  if (!Array.isArray(edges)) {
    return fail('edges must be an array', 'INVALID_EDGES')
  }

  if (edges.length > MAX_WORKFLOW_EDGES) {
    return fail('too many edges', 'TOO_MANY_EDGES')
  }

  const nodeIds = new Set(nodes.map(node => node.id))

  for (const edge of edges) {
    if (!edge || typeof edge !== 'object') {
      return fail('each edge must be an object', 'INVALID_EDGE')
    }

    const candidate = edge as { id?: unknown; source?: unknown; target?: unknown }

    if (!candidate.id || typeof candidate.id !== 'string') {
      return fail('edge.id is required', 'MISSING_EDGE_ID')
    }

    if (!candidate.source || typeof candidate.source !== 'string' || !candidate.target || typeof candidate.target !== 'string') {
      return fail('edge.source and edge.target are required', 'INVALID_EDGE_ENDPOINTS')
    }

    if (!nodeIds.has(candidate.source) || !nodeIds.has(candidate.target)) {
      return fail('edge references an unknown node', 'EDGE_UNKNOWN_NODE')
    }
  }

  return ok()
}

export function validateCreateWorkflowRequest(
  input: CreateWorkbenchWorkflowRequest
): ValidationResult {
  const rootCheck = validateWorkspaceRoot(input.workspaceRoot)
  if (!rootCheck.ok) return rootCheck

  const titleCheck = validateTitle(input.title)
  if (!titleCheck.ok) return titleCheck

  const nodes = input.nodes ?? []
  const nodesCheck = validateWorkflowNodes(nodes)
  if (!nodesCheck.ok) return nodesCheck

  const edgesCheck = validateWorkflowEdges(input.edges ?? [], nodes)
  if (!edgesCheck.ok) return edgesCheck

  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return fail('enabled must be a boolean', 'INVALID_ENABLED')
  }

  return ok()
}

export function validateUpdateWorkflowRequest(
  input: UpdateWorkbenchWorkflowRequest
): ValidationResult {
  const rootCheck = validateWorkspaceRoot(input.workspaceRoot)
  if (!rootCheck.ok) return rootCheck

  if (!input.workflowId || !input.workflowId.trim()) {
    return fail('workflowId is required', 'MISSING_WORKFLOW_ID')
  }

  if (input.title) {
    const titleCheck = validateTitle(input.title)
    if (!titleCheck.ok) return titleCheck
  }

  const nodesCheck = validateWorkflowNodes(input.nodes)
  if (!nodesCheck.ok) return nodesCheck

  const edgesCheck = validateWorkflowEdges(input.edges, input.nodes)
  if (!edgesCheck.ok) return edgesCheck

  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return fail('enabled must be a boolean', 'INVALID_ENABLED')
  }

  return ok()
}
