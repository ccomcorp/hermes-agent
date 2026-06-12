/**
 * System API — host/system health and operations.
 *
 * Functional spec: web `src/pages/SystemPage.tsx` + `src/lib/api.ts`.
 *
 * Mirrors the desktop request pattern in `src/hermes.ts`: every call routes
 * through `window.hermesDesktop.api<T>({ path, method?, body? })` to the
 * connected backend. Types are declared locally so this feature stays
 * self-contained and does NOT touch the shared `types/hermes` module.
 */

// ── Shared response shapes ───────────────────────────────────────────────

export interface ActionResponse {
  name: string
  ok: boolean
  pid: number | null
  error?: string
  message?: string
  update_command?: string
}

export interface ActionStatusResponse {
  exit_code: number | null
  lines: string[]
  name: string
  pid: number | null
  running: boolean
}

export interface PlatformStatus {
  error_code?: string
  error_message?: string
  state: string
  updated_at: string
}

export interface StatusResponse {
  active_sessions: number
  config_path: string
  config_version: number
  env_path: string
  gateway_exit_reason: string | null
  gateway_health_url: string | null
  gateway_pid: number | null
  gateway_platforms: Record<string, PlatformStatus>
  gateway_running: boolean
  gateway_state: string | null
  gateway_updated_at: string | null
  hermes_home: string
  latest_config_version: number
  release_date: string
  version: string
}

export interface SystemStats {
  os: string
  os_release: string
  os_version: string
  platform: string
  arch: string
  hostname: string
  python_version: string
  python_impl: string
  hermes_version: string
  cpu_count: number | null
  psutil: boolean
  cpu_percent?: number
  load_avg?: number[]
  uptime_seconds?: number
  memory?: { total: number; available: number; used: number; percent: number }
  disk?: { total: number; used: number; free: number; percent: number }
  process?: { pid: number; rss: number; create_time: number; num_threads: number }
}

export interface MemoryProviderInfo {
  name: string
  description: string
  configured: boolean
}

export interface MemoryStatus {
  active: string
  providers: MemoryProviderInfo[]
  builtin_files: { memory: number; user: number }
}

export interface CredentialPoolEntry {
  index: number
  id: string | null
  label: string | null
  auth_type: string | null
  source: string | null
  priority: number
  last_status: string | null
  request_count: number
  token_preview: string
  has_refresh: boolean
}

export interface CredentialPoolProvider {
  provider: string
  entries: CredentialPoolEntry[]
}

export interface CheckpointSession {
  session: string
  files: number
  bytes: number
}

export interface CheckpointsResponse {
  sessions: CheckpointSession[]
  total_bytes: number
}

export interface HookEntry {
  event: string
  matcher: string | null
  command: string | null
  timeout: number | null
  allowed: boolean
  approved_at?: string | null
  executable?: boolean
}

export interface HooksResponse {
  hooks: HookEntry[]
  valid_events: string[]
}

export interface HookCreate {
  event: string
  command: string
  matcher?: string
  timeout?: number
  approve?: boolean
}

export interface UpdateCheckResponse {
  install_method: string
  current_version: string
  // commits behind: >=1 known count, 0 up to date, -1 behind by unknown
  // count (nix/pypi), or null when the check could not run.
  behind: number | null
  update_available: boolean
  can_apply: boolean
  update_command: string
  message: string | null
}

export interface CuratorStatus {
  enabled: boolean
  paused: boolean
  interval_hours: number | null
  last_run_at: string | null
  min_idle_hours: number | null
  stale_after_days: number | null
  archive_after_days: number | null
}

export interface PortalFeature {
  label: string
  state: string
}

export interface PortalStatus {
  logged_in: boolean
  portal_url: string | null
  inference_url: string | null
  provider: string
  subscription_url: string
  features: PortalFeature[]
}

export interface DebugShareResponse {
  ok: boolean
  // label -> paste URL, e.g. { Report: "https://paste.rs/abc", "agent.log": "..." }
  urls: Record<string, string>
  // "label: error" strings for optional full-log uploads that failed.
  failures: string[]
  redacted: boolean
  auto_delete_seconds: number
}

// ── Status / stats / health ──────────────────────────────────────────────

export function getStatus(): Promise<StatusResponse> {
  return window.hermesDesktop.api<StatusResponse>({ path: '/api/status' })
}

export function getSystemStats(): Promise<SystemStats> {
  return window.hermesDesktop.api<SystemStats>({ path: '/api/system/stats' })
}

export function getMemory(): Promise<MemoryStatus> {
  return window.hermesDesktop.api<MemoryStatus>({ path: '/api/memory' })
}

export function resetMemory(target: 'all' | 'memory' | 'user'): Promise<{ ok: boolean; deleted: string[] }> {
  return window.hermesDesktop.api<{ ok: boolean; deleted: string[] }>({
    path: '/api/memory/reset',
    method: 'POST',
    body: { target }
  })
}

// ── Credential pool ───────────────────────────────────────────────────────

export async function getCredentialPool(): Promise<CredentialPoolProvider[]> {
  const result = await window.hermesDesktop.api<{ providers: CredentialPoolProvider[] }>({
    path: '/api/credentials/pool'
  })

  return result.providers ?? []
}

export function addCredentialPoolEntry(
  provider: string,
  apiKey: string,
  label?: string
): Promise<{ ok: boolean; provider: string; count: number }> {
  return window.hermesDesktop.api<{ ok: boolean; provider: string; count: number }>({
    path: '/api/credentials/pool',
    method: 'POST',
    body: { provider, api_key: apiKey, label }
  })
}

export function removeCredentialPoolEntry(
  provider: string,
  index: number
): Promise<{ ok: boolean; provider: string; count: number }> {
  return window.hermesDesktop.api<{ ok: boolean; provider: string; count: number }>({
    path: `/api/credentials/pool/${encodeURIComponent(provider)}/${index}`,
    method: 'DELETE'
  })
}

// ── Gateway lifecycle ──────────────────────────────────────────────────────

export function startGateway(): Promise<ActionResponse> {
  return window.hermesDesktop.api<ActionResponse>({ path: '/api/gateway/start', method: 'POST' })
}

export function stopGateway(): Promise<ActionResponse> {
  return window.hermesDesktop.api<ActionResponse>({ path: '/api/gateway/stop', method: 'POST' })
}

export function restartGateway(): Promise<ActionResponse> {
  return window.hermesDesktop.api<ActionResponse>({ path: '/api/gateway/restart', method: 'POST' })
}

// ── Curator ────────────────────────────────────────────────────────────────

export function getCurator(): Promise<CuratorStatus> {
  return window.hermesDesktop.api<CuratorStatus>({ path: '/api/curator' })
}

export function setCuratorPaused(paused: boolean): Promise<{ ok: boolean; paused: boolean }> {
  return window.hermesDesktop.api<{ ok: boolean; paused: boolean }>({
    path: '/api/curator/paused',
    method: 'PUT',
    body: { paused }
  })
}

export function runCurator(): Promise<ActionResponse> {
  return window.hermesDesktop.api<ActionResponse>({ path: '/api/curator/run', method: 'POST' })
}

// ── Portal ─────────────────────────────────────────────────────────────────

export function getPortal(): Promise<PortalStatus> {
  return window.hermesDesktop.api<PortalStatus>({ path: '/api/portal' })
}

// ── Checkpoints ──────────────────────────────────────────────────────────────

export function getCheckpoints(): Promise<CheckpointsResponse> {
  return window.hermesDesktop.api<CheckpointsResponse>({ path: '/api/ops/checkpoints' })
}

export function pruneCheckpoints(): Promise<ActionResponse> {
  return window.hermesDesktop.api<ActionResponse>({ path: '/api/ops/checkpoints/prune', method: 'POST' })
}

// ── Shell hooks ──────────────────────────────────────────────────────────────

export function getHooks(): Promise<HooksResponse> {
  return window.hermesDesktop.api<HooksResponse>({ path: '/api/ops/hooks' })
}

export function createHook(
  body: HookCreate
): Promise<{ ok: boolean; event: string; command: string; approved: boolean }> {
  return window.hermesDesktop.api<{ ok: boolean; event: string; command: string; approved: boolean }>({
    path: '/api/ops/hooks',
    method: 'POST',
    body
  })
}

export function deleteHook(event: string, command: string): Promise<{ ok: boolean }> {
  return window.hermesDesktop.api<{ ok: boolean }>({
    path: '/api/ops/hooks',
    method: 'DELETE',
    body: { event, command }
  })
}

// ── Operations (backgrounded actions) ─────────────────────────────────────────

export function runDoctor(): Promise<ActionResponse> {
  return window.hermesDesktop.api<ActionResponse>({ path: '/api/ops/doctor', method: 'POST' })
}

export function runSecurityAudit(): Promise<ActionResponse> {
  return window.hermesDesktop.api<ActionResponse>({ path: '/api/ops/security-audit', method: 'POST' })
}

export function runBackup(output?: string): Promise<ActionResponse> {
  return window.hermesDesktop.api<ActionResponse>({
    path: '/api/ops/backup',
    method: 'POST',
    body: { output }
  })
}

export function runImport(archive: string): Promise<ActionResponse> {
  return window.hermesDesktop.api<ActionResponse>({
    path: '/api/ops/import',
    method: 'POST',
    body: { archive }
  })
}

export function updateSkillsFromHub(): Promise<ActionResponse> {
  return window.hermesDesktop.api<ActionResponse>({ path: '/api/skills/hub/update', method: 'POST' })
}

export function runPromptSize(): Promise<ActionResponse> {
  return window.hermesDesktop.api<ActionResponse>({ path: '/api/ops/prompt-size', method: 'POST' })
}

export function runDump(): Promise<ActionResponse> {
  return window.hermesDesktop.api<ActionResponse>({ path: '/api/ops/dump', method: 'POST' })
}

export function runConfigMigrate(): Promise<ActionResponse> {
  return window.hermesDesktop.api<ActionResponse>({ path: '/api/ops/config-migrate', method: 'POST' })
}

export function runDebugShare(opts?: { redact?: boolean; lines?: number }): Promise<DebugShareResponse> {
  return window.hermesDesktop.api<DebugShareResponse>({
    path: '/api/ops/debug-share',
    method: 'POST',
    body: { redact: opts?.redact ?? true, lines: opts?.lines ?? 200 }
  })
}

// ── Update check / apply ───────────────────────────────────────────────────────

export function checkHermesUpdate(force = false): Promise<UpdateCheckResponse> {
  return window.hermesDesktop.api<UpdateCheckResponse>({
    path: `/api/hermes/update/check${force ? '?force=true' : ''}`
  })
}

export function updateHermes(): Promise<ActionResponse> {
  return window.hermesDesktop.api<ActionResponse>({ path: '/api/hermes/update', method: 'POST' })
}

// ── Action log polling (shared by all spawn-based ops) ──────────────────────────

export function getActionStatus(name: string, lines = 400): Promise<ActionStatusResponse> {
  return window.hermesDesktop.api<ActionStatusResponse>({
    path: `/api/actions/${encodeURIComponent(name)}/status?lines=${Math.max(1, lines)}`
  })
}
