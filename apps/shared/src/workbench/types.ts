// Hermes Workbench shared types.
//
// These contracts are the single source of truth for Workbench artifact shapes
// shared between the Electron main process, the desktop renderer, and (future)
// remote backends. They contain no runtime behavior and no secrets.

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

export const HERMES_WORKBENCH_DIR = '.hermes/workbench'
export const HERMES_REQUIREMENTS_DIR = '.hermes/workbench/requirements'
export const HERMES_PLANS_DIR = '.hermes/workbench/plans'
export const HERMES_CHANGESETS_DIR = '.hermes/workbench/changesets'
export const HERMES_WRITE_DIR = '.hermes/workbench/write'
export const HERMES_WORKFLOWS_DIR = '.hermes/workbench/workflows'
export const HERMES_MANIFEST_PATH = '.hermes/workbench/manifest.json'

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type WorkbenchResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; code?: string }

// ---------------------------------------------------------------------------
// Requirement Unit
// ---------------------------------------------------------------------------

export type WorkbenchRequirementStatus =
  | 'draft'
  | 'clarified'
  | 'planned'
  | 'in_progress'
  | 'implemented'
  | 'reviewed'
  | 'verified'
  | 'archived'

export interface WorkbenchRequirement {
  id: string
  title: string
  workspaceRoot: string
  relativeDir: string
  draftRelativePath: string
  traceRelativePath: string
  status: WorkbenchRequirementStatus
  createdAt: string
  updatedAt: string
  contentHash: string
}

export interface WorkbenchRequirementTrace {
  version: 1
  requirementId: string
  title: string
  status: WorkbenchRequirementStatus
  createdAt: string
  updatedAt: string
  linkedPlanIds: string[]
  linkedChangeSetIds: string[]
  linkedPrototypeIds: string[]
  linkedDesignArtifactIds: string[]
  linkedWriteArtifactIds: string[]
  history: WorkbenchTraceEntry[]
}

export interface WorkbenchTraceEntry {
  id: string
  at: string
  actor: 'user' | 'agent' | 'system'
  kind:
    | 'created'
    | 'renamed'
    | 'updated'
    | 'status_changed'
    | 'plan_linked'
    | 'changeset_linked'
    | 'prototype_linked'
    | 'design_linked'
    | 'write_linked'
    | 'verified'
  summary: string
  metadata?: Record<string, unknown>
}

export interface CreateWorkbenchRequirementRequest {
  workspaceRoot: string
  title: string
  markdown?: string
  source?: 'user' | 'chat' | 'import'
  sourceSessionId?: string
}

export interface CreateWorkbenchRequirementResponse {
  requirement: WorkbenchRequirement
  trace: WorkbenchRequirementTrace
}

export interface UpdateWorkbenchRequirementRequest {
  workspaceRoot: string
  requirementId: string
  markdown: string
  title?: string
  status?: WorkbenchRequirementStatus
}

// ---------------------------------------------------------------------------
// Workbench Plan
// ---------------------------------------------------------------------------

export type WorkbenchPlanOperation = 'draft' | 'refine'

export interface WorkbenchPlan {
  id: string
  title: string
  workspaceRoot: string
  relativePath: string
  requirementId?: string
  sourceRequest?: string
  operation: WorkbenchPlanOperation
  createdAt: string
  updatedAt: string
  savedAt: string
  contentHash: string
  byteSize: number
  version: number
  // Set on refined plans: the id of the prior version this plan supersedes.
  // Absent on the first ("draft") version. Refine never overwrites history.
  supersedesPlanId?: string
}

export interface CreateWorkbenchPlanRequest {
  workspaceRoot: string
  markdown: string
  title?: string
  sourceRequest?: string
  operation: WorkbenchPlanOperation
  requirementId?: string
  planId?: string
  planRelativePath?: string
}

export interface CreateWorkbenchPlanResponse {
  plan: WorkbenchPlan
  summary: string
}

// ---------------------------------------------------------------------------
// ChangeSet
// ---------------------------------------------------------------------------

export type WorkbenchChangeSetStatus =
  | 'pending'
  | 'partially_accepted'
  | 'accepted'
  | 'rejected'
  | 'applied'
  | 'archived'

export type WorkbenchChangeSource =
  | 'agent'
  | 'plan_implementation'
  | 'design_implementation'
  | 'write_inline_edit'
  | 'workflow'
  | 'manual'

export interface WorkbenchChangeSet {
  id: string
  workspaceRoot: string
  source: WorkbenchChangeSource
  requirementId?: string
  planId?: string
  workflowRunId?: string
  title: string
  summary: string
  status: WorkbenchChangeSetStatus
  createdAt: string
  updatedAt: string
  files: WorkbenchChangedFile[]
  approvals: WorkbenchApprovalRecord[]
}

export interface WorkbenchChangedFile {
  path: string
  beforeHash?: string
  afterHash?: string
  diff?: string
  status: 'pending' | 'accepted' | 'rejected' | 'applied'
  language?: string
  binary?: boolean
}

export interface WorkbenchApprovalRecord {
  id: string
  kind: 'user' | 'system' | 'approval_service'
  decision: 'approved' | 'denied' | 'timed_out'
  at: string
  reason?: string
}

export interface CreateWorkbenchChangeSetRequest {
  workspaceRoot: string
  source: WorkbenchChangeSource
  title: string
  summary: string
  requirementId?: string
  planId?: string
  files: WorkbenchChangedFile[]
}

// ---------------------------------------------------------------------------
// Design Studio
// ---------------------------------------------------------------------------

export interface WorkbenchDesignSettings {
  enabled: boolean
  defaultViewport: 'mobile' | 'tablet' | 'desktop'
  designSystemPreset:
    | 'none'
    | 'shadcn'
    | 'radix'
    | 'material'
    | 'ios'
    | 'fluent'
    | 'ant'
    | 'chakra'
    | 'carbon'
    | 'polaris'
    | 'bootstrap'
    | 'geist'
    | 'brutalism'
    | 'editorial'
  brandColor?: string
  tone: string[]
  radius?: 'sharp' | 'soft' | 'rounded' | 'pill'
  density?: 'compact' | 'cozy' | 'spacious'
  fontStyle?: 'system' | 'geometric' | 'humanist' | 'serif' | 'mono'
  stackHint?: string
  sandboxHtmlPreview: boolean
}

export interface WorkbenchDesignArtifact {
  id: string
  requirementId: string
  workspaceRoot: string
  kind: 'brief' | 'design_system' | 'prototype' | 'quality_report'
  relativePath: string
  createdAt: string
  contentHash: string
}

// ---------------------------------------------------------------------------
// Write Workspace
// ---------------------------------------------------------------------------

export interface WorkbenchWriteProject {
  id: string
  workspaceRoot: string
  title: string
  rootRelativeDir: string
  activeFileRelativePath?: string
  createdAt: string
  updatedAt: string
}

export interface WorkbenchWriteInlineEditRequest {
  workspaceRoot: string
  fileRelativePath: string
  instruction: string
  original: string
  prefix: string
  suffix: string
  selection: {
    from: number
    to: number
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
  }
  context: {
    language: string
    selectedText: string
    previousLine: string
    previousNonEmptyLine: string
    nextLine: string
  }
  recentEdits?: WorkbenchWriteRecentEdit[]
}

export interface WorkbenchWriteRecentEdit {
  source: 'user' | 'inline_edit'
  ageMs: number
  fileRelativePath: string
  from: number
  to: number
  deletedText: string
  insertedText: string
  instruction?: string
}

// ---------------------------------------------------------------------------
// Retrieval snippet
// ---------------------------------------------------------------------------

export interface WorkbenchRetrievalSnippet {
  path: string
  title: string
  text: string
  score: number
  keywords: string[]
  location:
    | { kind: 'text'; lineStart: number; lineEnd: number }
    | { kind: 'pdf'; pageStart: number; pageEnd: number }
}

// ---------------------------------------------------------------------------
// Workflow Designer
// ---------------------------------------------------------------------------

export type WorkbenchWorkflowNodeKind =
  | 'manual_trigger'
  | 'schedule_trigger'
  | 'webhook_trigger'
  | 'ai_agent'
  | 'human_approval'
  | 'condition'
  | 'http_request'
  | 'code'
  | 'delay'
  | 'loop'
  | 'subworkflow'
  | 'output'

export interface WorkbenchWorkflow {
  id: string
  title: string
  workspaceRoot: string
  enabled: boolean
  nodes: WorkbenchWorkflowNode[]
  edges: WorkbenchWorkflowEdge[]
  createdAt: string
  updatedAt: string
}

export interface WorkbenchWorkflowNode {
  id: string
  type: WorkbenchWorkflowNodeKind
  name: string
  position: { x: number; y: number }
  config: Record<string, unknown>
  disabled?: boolean
}

export interface WorkbenchWorkflowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

// ---------------------------------------------------------------------------
// Workbench events
// ---------------------------------------------------------------------------

export interface WorkbenchEvent {
  id: string
  seq: number
  kind: WorkbenchEventKind
  workspaceRoot: string
  at: string
  payload: Record<string, unknown>
}

export type WorkbenchEventKind =
  | 'workbench.ready'
  | 'requirement.created'
  | 'requirement.updated'
  | 'plan.created'
  | 'plan.refined'
  | 'changeset.created'
  | 'changeset.updated'
  | 'design.brief.created'
  | 'design.prototype.created'
  | 'write.inline_edit.proposed'
  | 'write.export.created'
  | 'workflow.run.started'
  | 'workflow.run.completed'
  | 'approval.requested'
  | 'approval.resolved'
  | 'error'

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface WorkbenchManifest {
  version: 1
  createdAt: string
  updatedAt: string
  requirements: WorkbenchManifestEntry[]
  plans: WorkbenchManifestEntry[]
  changesets: WorkbenchManifestEntry[]
  designs: WorkbenchManifestEntry[]
  writeProjects: WorkbenchManifestEntry[]
  workflows: WorkbenchManifestEntry[]
}

export interface WorkbenchManifestEntry {
  id: string
  title: string
  relativePath: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// IPC channel names
// ---------------------------------------------------------------------------

export const WORKBENCH_IPC_CHANNELS = {
  requirementsList: 'hermes:workbench:requirements:list',
  requirementsCreate: 'hermes:workbench:requirements:create',
  requirementsRead: 'hermes:workbench:requirements:read',
  requirementsUpdate: 'hermes:workbench:requirements:update',
  plansList: 'hermes:workbench:plans:list',
  plansCreate: 'hermes:workbench:plans:create',
  plansRead: 'hermes:workbench:plans:read',
  plansUpdate: 'hermes:workbench:plans:update',
  changesetsList: 'hermes:workbench:changesets:list',
  changesetsCreate: 'hermes:workbench:changesets:create',
  changesetsRead: 'hermes:workbench:changesets:read',
  changesetsUpdate: 'hermes:workbench:changesets:update',
  event: 'hermes:workbench:event'
} as const
