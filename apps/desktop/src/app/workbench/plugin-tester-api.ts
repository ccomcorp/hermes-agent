// Plugin Tester API — typed client over `window.hermesDesktop.workbench.pluginTester.*`.
//
// Every method returns the backend's normalized `WorkbenchIpcResult<T>`
// envelope UNCHANGED (see apps/desktop/src/global.d.ts and the handler-side
// `normalize()` in electron/workbench-ipc.cjs — every workbench IPC channel
// already returns exactly one `{ ok, value }` / `{ ok: false, message, code }`
// shape). Callers read `.ok` themselves rather than this file throwing or
// unwrapping, so a component can show partial-failure state (e.g. "list
// loaded, execute failed") without a try/catch around every call.
//
// No component may call `window.hermesDesktop.workbench.pluginTester` directly.
import type {
  PluginTesterCollection,
  PluginTesterCollectionManifestEntry,
  PluginTesterEnvironment,
  PluginTesterEnvironmentManifestEntry,
  PluginTesterExecuteResult,
  PluginTesterHistoryEntry,
  PluginTesterHistoryManifestEntry,
  PluginTesterRequest
} from '@hermes/shared'

import type { WorkbenchIpcResult } from '@/global'

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export function executeRequest(
  workspaceRoot: string,
  request: PluginTesterRequest,
  environmentId?: string,
  collectionId?: string
): Promise<WorkbenchIpcResult<PluginTesterExecuteResult>> {
  return window.hermesDesktop.workbench.pluginTester.execute({
    workspaceRoot,
    request,
    environmentId,
    collectionId
  })
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export function listCollections(
  workspaceRoot: string
): Promise<WorkbenchIpcResult<PluginTesterCollectionManifestEntry[]>> {
  return window.hermesDesktop.workbench.pluginTester.collections.list({ workspaceRoot })
}

export function createCollection(
  workspaceRoot: string,
  name: string,
  description: string,
  requests: PluginTesterRequest[]
): Promise<WorkbenchIpcResult<PluginTesterCollection>> {
  return window.hermesDesktop.workbench.pluginTester.collections.create({
    workspaceRoot,
    name,
    description,
    requests
  })
}

export function readCollection(
  workspaceRoot: string,
  collectionId: string
): Promise<WorkbenchIpcResult<PluginTesterCollection>> {
  return window.hermesDesktop.workbench.pluginTester.collections.read({ workspaceRoot, collectionId })
}

export function updateCollection(
  workspaceRoot: string,
  collectionId: string,
  name: string,
  description: string,
  requests: PluginTesterRequest[]
): Promise<WorkbenchIpcResult<PluginTesterCollection>> {
  return window.hermesDesktop.workbench.pluginTester.collections.update({
    workspaceRoot,
    collectionId,
    name,
    description,
    requests
  })
}

export function deleteCollection(
  workspaceRoot: string,
  collectionId: string
): Promise<WorkbenchIpcResult<void>> {
  return window.hermesDesktop.workbench.pluginTester.collections.delete({ workspaceRoot, collectionId })
}

// ---------------------------------------------------------------------------
// History
//
// No `createHistoryEntry` — execute() auto-records history server-side (see
// preload.cjs: `history:create` is an internal-consumer channel, never
// exposed here).
// ---------------------------------------------------------------------------

export function listHistory(
  workspaceRoot: string,
  collectionId?: string
  // Paginated shape { entries, total } — matches the backend store.listHistory
  // return (workbench-plugin-tester-store.cjs) and the IPC test's
  // `.value.entries` assertion. This was previously mis-typed as a bare
  // `PluginTesterHistoryManifestEntry[]`; the underlying `<any>` IPC result
  // silently accepted the wrong annotation, so callers read res.value as an
  // array and crashed at runtime ("s.map is not a function").
): Promise<WorkbenchIpcResult<{ entries: PluginTesterHistoryManifestEntry[]; total: number }>> {
  return window.hermesDesktop.workbench.pluginTester.history.list({ workspaceRoot, collectionId })
}

export function readHistoryEntry(
  workspaceRoot: string,
  historyId: string
): Promise<WorkbenchIpcResult<PluginTesterHistoryEntry>> {
  return window.hermesDesktop.workbench.pluginTester.history.read({ workspaceRoot, historyId })
}

export function deleteHistoryEntry(
  workspaceRoot: string,
  historyId: string
): Promise<WorkbenchIpcResult<void>> {
  return window.hermesDesktop.workbench.pluginTester.history.delete({ workspaceRoot, historyId })
}

export function clearHistory(
  workspaceRoot: string,
  collectionId?: string
): Promise<WorkbenchIpcResult<void>> {
  return window.hermesDesktop.workbench.pluginTester.history.clear({ workspaceRoot, collectionId })
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export function listEnvironments(
  workspaceRoot: string
): Promise<WorkbenchIpcResult<PluginTesterEnvironmentManifestEntry[]>> {
  return window.hermesDesktop.workbench.pluginTester.environments.list({ workspaceRoot })
}

export function createEnvironment(
  workspaceRoot: string,
  name: string,
  variables: Record<string, string>
): Promise<WorkbenchIpcResult<PluginTesterEnvironment>> {
  return window.hermesDesktop.workbench.pluginTester.environments.create({
    workspaceRoot,
    name,
    variables
  })
}

export function readEnvironment(
  workspaceRoot: string,
  environmentId: string
): Promise<WorkbenchIpcResult<PluginTesterEnvironment>> {
  return window.hermesDesktop.workbench.pluginTester.environments.read({ workspaceRoot, environmentId })
}

export function updateEnvironment(
  workspaceRoot: string,
  environmentId: string,
  name: string,
  variables: Record<string, string>
): Promise<WorkbenchIpcResult<PluginTesterEnvironment>> {
  return window.hermesDesktop.workbench.pluginTester.environments.update({
    workspaceRoot,
    environmentId,
    name,
    variables
  })
}

export function deleteEnvironment(
  workspaceRoot: string,
  environmentId: string
): Promise<WorkbenchIpcResult<void>> {
  return window.hermesDesktop.workbench.pluginTester.environments.delete({ workspaceRoot, environmentId })
}
