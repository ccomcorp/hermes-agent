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
export const HERMES_DESIGNS_DIR = '.hermes/workbench/designs'
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
  // Kanban cards created from this requirement's designs via "Send to Kanban"
  // (Workbench → card backlink). Recorded best-effort AFTER the card is
  // confirmed created on the board; a card is never lost if this link fails.
  // Older traces written before this field existed may omit it on disk — read
  // defensively (`?? []`) and the backend link fn guards for a missing array.
  linkedKanbanCardIds: string[]
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
    | 'kanban_linked'
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
  // Slice E (ChangeSet Apply, go-forward plan §5 Slice E) — populated ONLY
  // after an Apply attempt touches this file; absent before Apply ever runs,
  // and never written by Accept/Reject (Slice D), which only ever changes
  // `status` via a pure status transition. 'applied' mirrors
  // `status === 'applied'`; 'conflict' means the mandatory beforeHash safety
  // check refused to overwrite the file; 'error' means patch application
  // itself failed (e.g. `git apply` rejected the diff, or a binary file was
  // encountered); 'skipped' means there was no diff to apply.
  applyResult?: 'applied' | 'conflict' | 'error' | 'skipped'
  applyMessage?: string
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
// ChangeSet — Apply + Commit (Slice E, go-forward plan §5 Slice E)
//
// Apply is a SEPARATE, additional action from Accept/Reject (Slice D, which
// remains a pure status transition — see changeset-panel.tsx's reviewNote
// copy, unchanged by this slice). Apply requires the changeset to already be
// in `accepted` status and writes real files under `workspaceRoot`; Commit is
// a further separate, explicit action that stages+commits only the files
// this changeset applied, never triggered automatically by Apply.
// ---------------------------------------------------------------------------

export interface ApplyWorkbenchChangeSetRequest {
  workspaceRoot: string
  changesetId: string
}

export interface ApplyWorkbenchChangeSetResponse {
  changeset: WorkbenchChangeSet
}

export interface CommitWorkbenchChangeSetRequest {
  workspaceRoot: string
  changesetId: string
  // Optional user-edited commit message; falls back to the changeset's title.
  message?: string
}

export interface CommitWorkbenchChangeSetResponse {
  committed: boolean
  files: string[]
  message: string
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

// Design SETTINGS only (Slice F, go-forward plan §5). There is exactly one
// WorkbenchDesignSettings document per workspace (unlike requirements/plans/
// changesets, which are lists) — read/write it as a whole object, not a
// partial patch. This intentionally does not touch WorkbenchDesignArtifact
// (briefs/prototypes/quality reports): generating those is Slice G/H/I, out
// of scope here.
export interface WriteWorkbenchDesignSettingsRequest {
  workspaceRoot: string
  settings: WorkbenchDesignSettings
}

export interface WriteWorkbenchDesignSettingsResponse {
  settings: WorkbenchDesignSettings
}

// ---------------------------------------------------------------------------
// Design Studio — artifact generation (Slice G, go-forward plan §5 Slice G)
//
// Unlike settings above (a singleton), a WorkbenchDesignArtifact is a list —
// every generation call creates a BRAND-NEW artifact under
// `.hermes/workbench/designs/<requirementId>/`; it never overwrites a prior
// one (same non-destructive principle as Plan refine, simpler here: no
// supersedes-chain, just an ever-growing list per requirement). Structurally
// permissive of all four declared `kind`s (matching WorkbenchDesignArtifact
// above), though this slice only ships generation UI for 'brief'/'prototype'.
// ---------------------------------------------------------------------------

export interface CreateWorkbenchDesignArtifactRequest {
  workspaceRoot: string
  requirementId: string
  kind: WorkbenchDesignArtifact['kind']
  content: string
}

export interface CreateWorkbenchDesignArtifactResponse {
  artifact: WorkbenchDesignArtifact
}

// The read/detail shape: the full WorkbenchDesignArtifact record plus its
// persisted text content (Markdown for 'brief'/'design_system'/
// 'quality_report', an HTML document STRING for 'prototype' — never parsed or
// rendered as a live document by anything that consumes this type).
export interface WorkbenchDesignArtifactDetail extends WorkbenchDesignArtifact {
  content: string
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
// Plugin Tester
// ---------------------------------------------------------------------------

export interface PluginTesterAuth {
  type: 'none' | 'bearer' | 'basic' | 'apikey'
  token?: string
  username?: string
  password?: string
  key?: string
  value?: string
  addTo?: 'header' | 'query'
}

export interface PluginTesterRequest {
  method: string
  url: string
  headers?: Record<string, string>
  params?: Record<string, string> | Array<{ key: string; value: string }>
  body?: string
  contentType?: string
  auth?: PluginTesterAuth
  timeout?: number
}

export interface PluginTesterResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  cookies: Array<{
    name: string
    value: string
    attributes: Record<string, string | true>
  }>
  size: number
}

export interface PluginTesterTimingTrace {
  step: string
  duration: number
  timing?: {
    dns: number
    connect: number
    ttfb: number
    download: number
    total: number
  }
}

export interface PluginTesterExecuteResult {
  response: PluginTesterResponse
  trace: PluginTesterTimingTrace[]
}

export interface PluginTesterCollection {
  id: string
  name: string
  description: string
  requests: PluginTesterRequest[]
  createdAt: string
  updatedAt: string
}

export interface PluginTesterCollectionManifestEntry {
  id: string
  name: string
  description: string
  requestCount: number
  relativePath: string
  updatedAt: string
}

export interface PluginTesterHistoryEntry {
  id: string
  request: PluginTesterRequest
  response: PluginTesterResponse | null
  trace: PluginTesterTimingTrace[]
  collectionId?: string
  createdAt: string
}

export interface PluginTesterHistoryManifestEntry {
  id: string
  url: string
  method: string
  status: number
  duration: number
  collectionId?: string
  relativePath: string
  createdAt: string
}

export interface PluginTesterEnvironment {
  id: string
  name: string
  variables: Record<string, string>
  createdAt: string
  updatedAt: string
}

export interface PluginTesterEnvironmentManifestEntry {
  id: string
  name: string
  variableCount: number
  relativePath: string
  updatedAt: string
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
  // Records a Kanban card id into the requirement trace's linkedKanbanCardIds
  // (Workbench → card backlink for the "Send to Kanban" design handoff).
  requirementsLinkKanbanCard: 'hermes:workbench:requirements:link-kanban-card',
  plansList: 'hermes:workbench:plans:list',
  plansCreate: 'hermes:workbench:plans:create',
  plansRead: 'hermes:workbench:plans:read',
  plansUpdate: 'hermes:workbench:plans:update',
  changesetsList: 'hermes:workbench:changesets:list',
  changesetsCreate: 'hermes:workbench:changesets:create',
  changesetsRead: 'hermes:workbench:changesets:read',
  changesetsUpdate: 'hermes:workbench:changesets:update',
  // Slice E — apply a changeset's file diffs to the REAL workspace, and a
  // separate, explicit git commit of exactly the files that got applied.
  changesetsApply: 'hermes:workbench:changesets:apply',
  changesetsCommit: 'hermes:workbench:changesets:commit',
  designSettingsRead: 'hermes:workbench:design:settings:read',
  designSettingsWrite: 'hermes:workbench:design:settings:write',
  // Design artifact generation (Slice G) — creates a brand-new
  // WorkbenchDesignArtifact (brief/prototype in this slice) per call; never
  // overwrites a prior one. No generation/model-invocation logic lives on the
  // IPC/main-process side — these three channels are pure artifact-store CRUD,
  // the same shape as requirements/plans/etc above.
  designArtifactsCreate: 'hermes:workbench:design:artifacts:create',
  designArtifactsList: 'hermes:workbench:design:artifacts:list',
  designArtifactsRead: 'hermes:workbench:design:artifacts:read',
  writeProjectsList: 'hermes:workbench:write:list',
  writeProjectsCreate: 'hermes:workbench:write:create',
  writeProjectsRead: 'hermes:workbench:write:read',
  writeProjectsUpdate: 'hermes:workbench:write:update',
  // Write Workspace export (Slice L) — HTML/PDF/DOCX/PNG, saved only to a
  // user-chosen path from the OS save dialog.
  writeProjectsExport: 'hermes:workbench:write:export',
  // Workflow Designer — AUTHORING ONLY (Slice M, go-forward plan §5). No
  // run/execute channel exists here or anywhere in this slice.
  workflowsList: 'hermes:workbench:workflows:list',
  workflowsCreate: 'hermes:workbench:workflows:create',
  workflowsRead: 'hermes:workbench:workflows:read',
  workflowsUpdate: 'hermes:workbench:workflows:update',
  // Plugin Tester — HTTP request executor + persistence (Slice N).
  // Executes real HTTP requests via the main process and persists
  // collections, history, and environments under .hermes/workbench/plugin-tester/.
  pluginTesterExecute: 'hermes:workbench:plugin-tester:execute',
  pluginTesterCollectionsList: 'hermes:workbench:plugin-tester:collections:list',
  pluginTesterCollectionsCreate: 'hermes:workbench:plugin-tester:collections:create',
  pluginTesterCollectionsRead: 'hermes:workbench:plugin-tester:collections:read',
  pluginTesterCollectionsUpdate: 'hermes:workbench:plugin-tester:collections:update',
  pluginTesterCollectionsDelete: 'hermes:workbench:plugin-tester:collections:delete',
  pluginTesterHistoryList: 'hermes:workbench:plugin-tester:history:list',
  pluginTesterHistoryRead: 'hermes:workbench:plugin-tester:history:read',
  pluginTesterHistoryDelete: 'hermes:workbench:plugin-tester:history:delete',
  pluginTesterHistoryClear: 'hermes:workbench:plugin-tester:history:clear',
  pluginTesterHistoryCreate: 'hermes:workbench:plugin-tester:history:create',
  pluginTesterEnvironmentsList: 'hermes:workbench:plugin-tester:environments:list',
  pluginTesterEnvironmentsCreate: 'hermes:workbench:plugin-tester:environments:create',
  pluginTesterEnvironmentsRead: 'hermes:workbench:plugin-tester:environments:read',
  pluginTesterEnvironmentsUpdate: 'hermes:workbench:plugin-tester:environments:update',
  pluginTesterEnvironmentsDelete: 'hermes:workbench:plugin-tester:environments:delete',
  event: 'hermes:workbench:event'
} as const
