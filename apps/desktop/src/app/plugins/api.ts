/**
 * Plugins REST surface for the desktop app. Mirrors the request pattern in
 * `src/hermes.ts` (every call routes through `window.hermesDesktop.api<T>`), so
 * these calls reach the connected backend exactly like every other feature.
 * Types are declared locally so the feature stays self-contained and never
 * touches the shared `types/hermes`.
 *
 * Functional parity with the dashboard's PluginsPage (web/src/lib/api.ts):
 *   GET    /api/dashboard/plugins/hub                         -> hub (rows + providers + orphans)
 *   GET    /api/dashboard/plugins/rescan                      -> rescan disk + reload manifests
 *   POST   /api/dashboard/agent-plugins/install               -> install from identifier
 *   POST   /api/dashboard/agent-plugins/:name/enable          -> enable runtime
 *   POST   /api/dashboard/agent-plugins/:name/disable         -> disable runtime
 *   POST   /api/dashboard/agent-plugins/:name/update          -> git pull update
 *   DELETE /api/dashboard/agent-plugins/:name                 -> remove
 *   PUT    /api/dashboard/plugin-providers                    -> set memory/context providers
 *   POST   /api/dashboard/plugins/:name/visibility            -> hide/show in sidebar
 */

// Plugin names can contain a slash (owner/repo); encode each segment so the
// path stays valid without double-encoding the separator.
function pluginPath(name: string): string {
  return name
    .split('/')
    .map(encodeURIComponent)
    .join('/')
}

export interface PluginManifest {
  name: string
  label: string
  description: string
  icon: string
  version: string
  tab: {
    path: string
    position?: string
    override?: string
    hidden?: boolean
  }
  slots?: string[]
  entry: string
  css?: null | string
  has_api: boolean
  source: string
}

export type PluginRuntimeStatus = 'disabled' | 'enabled' | 'inactive'

export interface HubAgentPluginRow {
  name: string
  version: string
  description: string
  source: string
  runtime_status: PluginRuntimeStatus
  has_dashboard_manifest: boolean
  dashboard_manifest: null | PluginManifest
  path: string
  can_remove: boolean
  can_update_git: boolean
  auth_required: boolean
  auth_command: string
  user_hidden: boolean
}

export interface PluginProviderOption {
  name: string
  description: string
}

export interface PluginsHubProviders {
  memory_provider: string
  memory_options: PluginProviderOption[]
  context_engine: string
  context_options: PluginProviderOption[]
}

export interface PluginsHubResponse {
  plugins: HubAgentPluginRow[]
  orphan_dashboard_plugins: PluginManifest[]
  providers: PluginsHubProviders
}

export interface AgentPluginInstallRequest {
  identifier: string
  force?: boolean
  enable?: boolean
}

export interface AgentPluginInstallResponse {
  ok: boolean
  plugin_name?: string
  warnings?: string[]
  missing_env?: string[]
  after_install_path?: null | string
  enabled?: boolean
  error?: string
}

export interface AgentPluginUpdateResponse {
  ok: boolean
  name?: string
  output?: string
  unchanged?: boolean
  error?: string
}

export interface PluginProvidersPutRequest {
  memory_provider?: string
  context_engine?: string
}

export interface RescanResponse {
  ok: boolean
  count: number
}

export function getPluginsHub(): Promise<PluginsHubResponse> {
  return window.hermesDesktop.api<PluginsHubResponse>({
    path: '/api/dashboard/plugins/hub'
  })
}

export function rescanPlugins(): Promise<RescanResponse> {
  return window.hermesDesktop.api<RescanResponse>({
    path: '/api/dashboard/plugins/rescan'
  })
}

export function installAgentPlugin(body: AgentPluginInstallRequest): Promise<AgentPluginInstallResponse> {
  return window.hermesDesktop.api<AgentPluginInstallResponse>({
    path: '/api/dashboard/agent-plugins/install',
    method: 'POST',
    body
  })
}

export function enableAgentPlugin(name: string): Promise<{ ok: boolean; name: string; unchanged?: boolean }> {
  return window.hermesDesktop.api<{ ok: boolean; name: string; unchanged?: boolean }>({
    path: `/api/dashboard/agent-plugins/${pluginPath(name)}/enable`,
    method: 'POST'
  })
}

export function disableAgentPlugin(name: string): Promise<{ ok: boolean; name: string; unchanged?: boolean }> {
  return window.hermesDesktop.api<{ ok: boolean; name: string; unchanged?: boolean }>({
    path: `/api/dashboard/agent-plugins/${pluginPath(name)}/disable`,
    method: 'POST'
  })
}

export function updateAgentPlugin(name: string): Promise<AgentPluginUpdateResponse> {
  return window.hermesDesktop.api<AgentPluginUpdateResponse>({
    path: `/api/dashboard/agent-plugins/${pluginPath(name)}/update`,
    method: 'POST'
  })
}

export function removeAgentPlugin(name: string): Promise<{ ok: boolean; name: string }> {
  return window.hermesDesktop.api<{ ok: boolean; name: string }>({
    path: `/api/dashboard/agent-plugins/${pluginPath(name)}`,
    method: 'DELETE'
  })
}

export function savePluginProviders(body: PluginProvidersPutRequest): Promise<{ ok: boolean }> {
  return window.hermesDesktop.api<{ ok: boolean }>({
    path: '/api/dashboard/plugin-providers',
    method: 'PUT',
    body
  })
}

export function setPluginVisibility(
  name: string,
  hidden: boolean
): Promise<{ ok: boolean; name: string; hidden: boolean }> {
  return window.hermesDesktop.api<{ ok: boolean; name: string; hidden: boolean }>({
    path: `/api/dashboard/plugins/${pluginPath(name)}/visibility`,
    method: 'POST',
    body: { hidden }
  })
}
