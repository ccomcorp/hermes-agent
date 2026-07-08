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
  WorkbenchManifestEntry,
  WorkbenchRequirement,
  WorkbenchRequirementStatus,
  WorkbenchRequirementTrace
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
