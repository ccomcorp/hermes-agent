// Workbench API — typed client over `window.hermesDesktop.workbench.*`.
//
// Every method returns the backend's normalized `WorkbenchIpcResult<T>`
// envelope UNCHANGED (see apps/desktop/src/global.d.ts and the handler-side
// `normalize()` in electron/workbench-ipc.cjs — every workbench IPC channel
// already returns exactly one `{ ok, value }` / `{ ok: false, message, code }`
// shape). Callers read `.ok` themselves rather than this file throwing or
// unwrapping, so a component can show partial-failure state (e.g. "list
// loaded, create failed") without a try/catch around every call.
//
// No component may call `window.hermesDesktop.workbench` directly, and no
// component may construct a raw filesystem path — every call here takes a
// workspace root plus a requirement id, never a path.
import type {
  WorkbenchChangeSet,
  WorkbenchChangeSetStatus,
  WorkbenchDesignSettings,
  WorkbenchManifestEntry,
  WorkbenchPlan,
  WorkbenchRequirement,
  WorkbenchRequirementStatus,
  WorkbenchRequirementTrace,
  WorkbenchWorkflow,
  WorkbenchWorkflowEdge,
  WorkbenchWorkflowNode,
  WorkbenchWriteExportFormat,
  WorkbenchWriteProject,
  WorkbenchWriteRecentEdit
} from '@hermes/shared'

import type { WorkbenchIpcResult } from '@/global'

export interface WorkbenchRequirementDetail {
  id: string
  markdown: string
  trace: WorkbenchRequirementTrace | null
  draftRelativePath: string
  traceRelativePath: string
}

export interface WorkbenchRequirementUpdateResult {
  id: string
  title?: string
  status?: WorkbenchRequirementStatus
  contentHash: string
  updatedAt: string
}

export interface CreateWorkbenchRequirementInput {
  workspaceRoot: string
  title: string
  markdown?: string
  source?: 'chat' | 'import' | 'user'
}

export interface UpdateWorkbenchRequirementInput {
  workspaceRoot: string
  requirementId: string
  markdown: string
  title?: string
  status?: WorkbenchRequirementStatus
}

// `requirements:list` returns the manifest rows (id/title/relativePath/
// updatedAt) — NOT the full WorkbenchRequirement — see workbench-artifacts.cjs
// `listRequirements()`, which returns `manifest.requirements` as-is. The
// ambient type for this channel is `WorkbenchIpcResult<any>` (global.d.ts); this
// wrapper narrows it to the shape the backend actually returns instead of
// leaving `any` for callers.
export function listRequirements(workspaceRoot: string): Promise<WorkbenchIpcResult<WorkbenchManifestEntry[]>> {
  return window.hermesDesktop.workbench.requirements.list({ workspaceRoot })
}

export function createRequirement(
  input: CreateWorkbenchRequirementInput
): Promise<WorkbenchIpcResult<{ requirement: WorkbenchRequirement; trace: WorkbenchRequirementTrace }>> {
  return window.hermesDesktop.workbench.requirements.create(input)
}

export function readRequirement(
  workspaceRoot: string,
  requirementId: string
): Promise<WorkbenchIpcResult<WorkbenchRequirementDetail>> {
  return window.hermesDesktop.workbench.requirements.read({ workspaceRoot, requirementId })
}

export function updateRequirement(
  input: UpdateWorkbenchRequirementInput
): Promise<WorkbenchIpcResult<WorkbenchRequirementUpdateResult>> {
  return window.hermesDesktop.workbench.requirements.update(input)
}

// ---------------------------------------------------------------------------
// Plans (Slice C)
//
// `plans:list` does not filter server-side even when a requirementId is
// passed (see workbench-artifacts.cjs `listPlans` — it's a TODO there) and the
// manifest-entry shape it returns has no requirementId field (go-forward plan
// §3.6). "Plans linked to this requirement" is derived in store.ts by
// cross-referencing the open requirement's trace.linkedPlanIds against the
// full list this returns, not by trusting server-side filtering.
// ---------------------------------------------------------------------------

export interface WorkbenchPlanDetail {
  id: string
  markdown: string
  relativePath: string
  contentHash: string
  byteSize: number
  savedAt: string
  version: number
  supersedesPlanId?: string
}

export interface CreateWorkbenchPlanInput {
  workspaceRoot: string
  markdown: string
  title?: string
  sourceRequest?: string
  requirementId?: string
}

// Refine keeps history (locked decision §3.2): this is never an overwrite. The
// backend writes a NEW plan version file linked to `planId` via
// `supersedesPlanId` and returns that new version's id/version in the result —
// callers must treat the response `plan.id` as the new "current" plan, not the
// one they passed in.
export interface RefineWorkbenchPlanInput {
  workspaceRoot: string
  planId: string
  markdown: string
  title?: string
  sourceRequest?: string
  requirementId?: string
}

export function listPlans(
  workspaceRoot: string,
  requirementId?: string
): Promise<WorkbenchIpcResult<WorkbenchManifestEntry[]>> {
  return window.hermesDesktop.workbench.plans.list({ workspaceRoot, requirementId })
}

// `operation: 'draft'` is fixed here — this function only ever creates a first
// version. It is a pure file write: no command, tool call, or implementation
// action is triggered by creating a plan.
export function createPlan(
  input: CreateWorkbenchPlanInput
): Promise<WorkbenchIpcResult<{ plan: WorkbenchPlan; summary: string }>> {
  return window.hermesDesktop.workbench.plans.create({ ...input, operation: 'draft' })
}

export function readPlan(workspaceRoot: string, planId: string): Promise<WorkbenchIpcResult<WorkbenchPlanDetail>> {
  return window.hermesDesktop.workbench.plans.read({ workspaceRoot, planId })
}

// Also a pure file write — routes to the versioned `plans:update` channel,
// never to any run/execute API.
export function refinePlan(
  input: RefineWorkbenchPlanInput
): Promise<WorkbenchIpcResult<{ plan: WorkbenchPlan; summary: string }>> {
  return window.hermesDesktop.workbench.plans.update({ ...input, operation: 'refine' })
}

// ---------------------------------------------------------------------------
// ChangeSets (Slice D — review/status ONLY, see go-forward plan §5 Slice D)
//
// `changesets:list` is workspace-wide — the channel takes only `workspaceRoot`
// (see global.d.ts; there is no requirementId param the way `plans:list` has
// one) and returns manifest-entry rows exactly like requirements/plans
// (workbench-artifacts.cjs `listChangeSets` reads `manifest.changesets`
// as-is). Unlike plans, `createChangeSet` never records a link back into the
// source requirement's trace.json — there is no changeset equivalent of
// `linkPlanToRequirement` — so `trace.linkedChangeSetIds` is never populated
// today and there is nothing to derive a "changesets linked to this
// requirement" view from. This panel therefore lists every changeset in the
// workspace, matching how Plans behaves today per the go-forward plan's own
// fallback guidance.
//
// No function here ever calls a file-write/git/terminal/execute API.
// `updateChangeSetStatus` ONLY flips the changeset's own status JSON under
// `.hermes/workbench/changesets/<id>.json` — it must never be used to apply
// the changeset's file patches to the user's real project. That is Slice E,
// explicitly out of scope for this slice.
// ---------------------------------------------------------------------------

export interface UpdateChangeSetStatusInput {
  workspaceRoot: string
  changesetId: string
  statusPatch: {
    status?: WorkbenchChangeSetStatus
    fileUpdates?: { path: string; status: 'accepted' | 'applied' | 'pending' | 'rejected' }[]
    approval?: {
      kind: 'approval_service' | 'system' | 'user'
      decision: 'approved' | 'denied' | 'timed_out'
      reason?: string
    }
  }
}

export function listChangeSets(workspaceRoot: string): Promise<WorkbenchIpcResult<WorkbenchManifestEntry[]>> {
  return window.hermesDesktop.workbench.changesets.list({ workspaceRoot })
}

export function readChangeSet(
  workspaceRoot: string,
  changesetId: string
): Promise<WorkbenchIpcResult<WorkbenchChangeSet>> {
  return window.hermesDesktop.workbench.changesets.read({ workspaceRoot, changesetId })
}

// Status-transition ONLY — see the module-level comment above. This is the
// one and only write this slice performs against a ChangeSet.
export function updateChangeSetStatus(
  input: UpdateChangeSetStatusInput
): Promise<WorkbenchIpcResult<WorkbenchChangeSet>> {
  return window.hermesDesktop.workbench.changesets.update(input)
}

// ---------------------------------------------------------------------------
// ChangeSets — Apply + Commit (Slice E, go-forward plan §5 Slice E).
//
// Apply is a SEPARATE, ADDITIONAL action from accept/reject above — it is
// only valid once a changeset is already `accepted`, and it is the first
// Workbench write that reaches the user's REAL project files. Commit is a
// further separate, explicit action; it is never called by `applyChangeSet`.
// ---------------------------------------------------------------------------

export interface ApplyChangeSetInput {
  workspaceRoot: string
  changesetId: string
}

export function applyChangeSet(input: ApplyChangeSetInput): Promise<WorkbenchIpcResult<WorkbenchChangeSet>> {
  return window.hermesDesktop.workbench.changesets.apply(input)
}

export interface CommitChangeSetInput {
  workspaceRoot: string
  changesetId: string
  message?: string
}

export interface CommitChangeSetResult {
  committed: boolean
  files: string[]
  message: string
}

export function commitChangeSet(
  input: CommitChangeSetInput
): Promise<WorkbenchIpcResult<CommitChangeSetResult>> {
  return window.hermesDesktop.workbench.changesets.commit(input)
}

// Git-repo detection deliberately reuses the EXISTING coding-rail git surface
// (`window.hermesDesktop.git.repoStatus`, already wired for the review pane)
// instead of adding a new "is this a repo" IPC channel — `repoStatus` already
// resolves to `null` for a non-repo/remote backend (see git-review-ops.cjs
// `repoStatus`). Used to gate the Commit button's visibility.
export async function isWorkspaceGitRepo(workspaceRoot: string): Promise<boolean> {
  const repoStatus = window.hermesDesktop.git?.repoStatus

  if (!repoStatus) {
    return false
  }

  const status = await repoStatus(workspaceRoot)

  return status !== null
}

// ---------------------------------------------------------------------------
// Design Studio — SETTINGS only (Slice F, go-forward plan §5).
//
// There is exactly ONE WorkbenchDesignSettings document per workspace, so
// unlike requirements/plans/changesets there is no list/create pair — just
// read the current settings (the backend returns sensible defaults when none
// have been saved yet, see workbench-artifacts.cjs `readDesignSettings`) and
// write the whole object back.
//
// No function here calls any design-generation, prototype-preview, or
// changeset-apply API — those are Slice G/H/I, out of scope for this slice.
// ---------------------------------------------------------------------------

export function readDesignSettings(workspaceRoot: string): Promise<WorkbenchIpcResult<WorkbenchDesignSettings>> {
  return window.hermesDesktop.workbench.design.settings.read({ workspaceRoot })
}

export function writeDesignSettings(
  workspaceRoot: string,
  settings: WorkbenchDesignSettings
): Promise<WorkbenchIpcResult<WorkbenchDesignSettings>> {
  return window.hermesDesktop.workbench.design.settings.write({ workspaceRoot, settings })
}

// ---------------------------------------------------------------------------
// Write Workspace — CRUD only (Slice J, go-forward plan §5).
//
// A write project is a single markdown document + metadata (same shape as a
// Requirement — see requirements above), not a multi-file tree. No function
// here calls any AI-rewrite (quick actions / selection-aware inline edit),
// retrieval, or export API — those are Slice K/L, explicitly out of scope.
// ---------------------------------------------------------------------------

export interface WorkbenchWriteProjectDetail {
  id: string
  title: string
  markdown: string
  rootRelativeDir: string
  activeFileRelativePath?: string
  createdAt: string
  updatedAt: string
  recentEdits: WorkbenchWriteRecentEdit[]
}

export interface CreateWorkbenchWriteProjectInput {
  workspaceRoot: string
  title: string
  markdown?: string
}

export interface UpdateWorkbenchWriteProjectInput {
  workspaceRoot: string
  writeProjectId: string
  markdown: string
  title?: string
}

export function listWriteProjects(workspaceRoot: string): Promise<WorkbenchIpcResult<WorkbenchManifestEntry[]>> {
  return window.hermesDesktop.workbench.write.list({ workspaceRoot })
}

export function createWriteProject(
  input: CreateWorkbenchWriteProjectInput
): Promise<WorkbenchIpcResult<{ project: WorkbenchWriteProject }>> {
  return window.hermesDesktop.workbench.write.create(input)
}

export function readWriteProject(
  workspaceRoot: string,
  writeProjectId: string
): Promise<WorkbenchIpcResult<WorkbenchWriteProjectDetail>> {
  return window.hermesDesktop.workbench.write.read({ workspaceRoot, writeProjectId })
}

export function updateWriteProject(
  input: UpdateWorkbenchWriteProjectInput
): Promise<WorkbenchIpcResult<{ id: string; title?: string; contentHash: string; updatedAt: string }>> {
  return window.hermesDesktop.workbench.write.update(input)
}

// ---------------------------------------------------------------------------
// Write Workspace — export (Slice L, go-forward plan §5).
//
// `html` must already be a complete, standalone HTML document — this file
// never renders markdown itself (see write-export.tsx, which reuses the same
// renderer CompactMarkdown uses). The main process never constructs the
// target path: it always comes from the OS save dialog, so `canceled: true`
// in the response means the user dismissed that dialog, not an error.
// ---------------------------------------------------------------------------

export interface ExportWorkbenchWriteProjectInput {
  workspaceRoot: string
  writeProjectId: string
  format: WorkbenchWriteExportFormat
  title: string
  html: string
}

export interface WorkbenchWriteExportResult {
  canceled: boolean
  path?: string
  format?: WorkbenchWriteExportFormat
  exportedAt?: string
}

export function exportWriteProject(
  input: ExportWorkbenchWriteProjectInput
): Promise<WorkbenchIpcResult<WorkbenchWriteExportResult>> {
  return window.hermesDesktop.workbench.write.export(input)
}

// ---------------------------------------------------------------------------
// Workflow Designer — AUTHORING ONLY (Slice M, go-forward plan §5).
//
// A WorkbenchWorkflow is a document + metadata (the whole graph: nodes +
// edges), the same structural model as a Requirement/Write project — a list
// of workflows per workspace, CRUD only. No function here ever calls a
// run/execute/model/skill/agent API: creating, reading, or saving a workflow
// is a pure JSON document write, never an interpretation of any node's
// `config`. There is no "run workflow" function in this file or anywhere in
// this slice.
// ---------------------------------------------------------------------------

export interface CreateWorkbenchWorkflowInput {
  workspaceRoot: string
  title: string
  nodes?: WorkbenchWorkflowNode[]
  edges?: WorkbenchWorkflowEdge[]
  enabled?: boolean
}

export interface UpdateWorkbenchWorkflowInput {
  workspaceRoot: string
  workflowId: string
  nodes: WorkbenchWorkflowNode[]
  edges: WorkbenchWorkflowEdge[]
  title?: string
  enabled?: boolean
}

export interface UpdateWorkbenchWorkflowResult {
  id: string
  title: string
  enabled: boolean
  contentHash: string
  updatedAt: string
}

export function listWorkflows(workspaceRoot: string): Promise<WorkbenchIpcResult<WorkbenchManifestEntry[]>> {
  return window.hermesDesktop.workbench.workflow.list({ workspaceRoot })
}

export function createWorkflow(
  input: CreateWorkbenchWorkflowInput
): Promise<WorkbenchIpcResult<{ workflow: WorkbenchWorkflow }>> {
  return window.hermesDesktop.workbench.workflow.create(input)
}

export function readWorkflow(
  workspaceRoot: string,
  workflowId: string
): Promise<WorkbenchIpcResult<WorkbenchWorkflow>> {
  return window.hermesDesktop.workbench.workflow.read({ workspaceRoot, workflowId })
}

export function updateWorkflow(
  input: UpdateWorkbenchWorkflowInput
): Promise<WorkbenchIpcResult<UpdateWorkbenchWorkflowResult>> {
  return window.hermesDesktop.workbench.workflow.update(input)
}
