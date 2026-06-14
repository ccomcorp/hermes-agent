/**
 * Channels API — gateway messaging-channel configuration (slack / telegram /
 * discord / etc.) plus the Telegram QR/deep-link pairing flow.
 *
 * Functional spec: web `src/pages/ChannelsPage.tsx` + the methods it calls in
 * web `src/lib/api.ts` (getMessagingPlatforms, updateMessagingPlatform,
 * testMessagingPlatform, start/status/apply/cancelTelegramOnboarding,
 * restartGateway, getActionStatus).
 *
 * Mirrors the desktop request pattern in `src/hermes.ts`: every call goes
 * through `window.hermesDesktop.api<T>({ path, method?, body? })`, which routes
 * the REST call to the connected backend. Types are declared locally so this
 * feature stays self-contained and does not touch the shared `types/hermes`.
 */

export interface MessagingPlatformEnvVar {
  key: string
  required: boolean
  is_set: boolean
  redacted_value: string | null
  description: string
  prompt: string
  url: string | null
  is_password: boolean
  advanced: boolean
}

export interface MessagingHomeChannel {
  platform: string
  chat_id: string
  name: string
  thread_id?: string
}

export interface MessagingPlatform {
  id: string
  name: string
  description: string
  docs_url: string
  enabled: boolean
  configured: boolean
  gateway_running: boolean
  /**
   * One of: connected | disabled | not_configured | pending_restart |
   * gateway_stopped | disconnected | fatal — plus any runtime string the
   * gateway reports.
   */
  state: string
  error_code: string | null
  error_message: string | null
  updated_at: string | null
  home_channel: MessagingHomeChannel | null
  env_vars: MessagingPlatformEnvVar[]
}

export interface MessagingPlatformsResponse {
  platforms: MessagingPlatform[]
}

export interface MessagingPlatformUpdate {
  enabled?: boolean
  env?: Record<string, string>
  clear_env?: string[]
}

export interface MessagingPlatformTestResult {
  ok: boolean
  state: string
  message: string
}

export interface TelegramOnboardingStartResponse {
  pairing_id: string
  suggested_username: string
  deep_link: string
  qr_payload: string
  expires_at: string
}

export type TelegramOnboardingStatusResponse =
  | { status: 'waiting'; expires_at: string }
  | {
      status: 'ready'
      bot_username: string
      owner_user_id?: string
      expires_at: string
    }

export interface TelegramOnboardingApplyResponse {
  ok: boolean
  platform: 'telegram'
  bot_username?: string
  needs_restart: boolean
  restart_started?: boolean
  restart_action?: string
  restart_pid?: number | null
  restart_error?: string
}

export interface ActionResponse {
  ok: boolean
  action?: string
  pid?: number | null
  detail?: string
}

export interface ActionStatusResponse {
  running: boolean
  exit_code: number | null
  lines?: string[]
}

export function getMessagingPlatforms(): Promise<MessagingPlatformsResponse> {
  return window.hermesDesktop.api<MessagingPlatformsResponse>({
    path: '/api/messaging/platforms'
  })
}

export function updateMessagingPlatform(
  platformId: string,
  body: MessagingPlatformUpdate
): Promise<{ ok: boolean; platform: string }> {
  return window.hermesDesktop.api<{ ok: boolean; platform: string }>({
    path: `/api/messaging/platforms/${encodeURIComponent(platformId)}`,
    method: 'PUT',
    body
  })
}

export function testMessagingPlatform(platformId: string): Promise<MessagingPlatformTestResult> {
  return window.hermesDesktop.api<MessagingPlatformTestResult>({
    path: `/api/messaging/platforms/${encodeURIComponent(platformId)}/test`,
    method: 'POST'
  })
}

export function startTelegramOnboarding(body: { bot_name?: string }): Promise<TelegramOnboardingStartResponse> {
  return window.hermesDesktop.api<TelegramOnboardingStartResponse>({
    path: '/api/messaging/telegram/onboarding/start',
    method: 'POST',
    body
  })
}

export function getTelegramOnboardingStatus(pairingId: string): Promise<TelegramOnboardingStatusResponse> {
  return window.hermesDesktop.api<TelegramOnboardingStatusResponse>({
    path: `/api/messaging/telegram/onboarding/${encodeURIComponent(pairingId)}`
  })
}

export function applyTelegramOnboarding(
  pairingId: string,
  body: { allowed_user_ids: string[] }
): Promise<TelegramOnboardingApplyResponse> {
  return window.hermesDesktop.api<TelegramOnboardingApplyResponse>({
    path: `/api/messaging/telegram/onboarding/${encodeURIComponent(pairingId)}/apply`,
    method: 'POST',
    body
  })
}

export function cancelTelegramOnboarding(pairingId: string): Promise<{ ok: boolean }> {
  return window.hermesDesktop.api<{ ok: boolean }>({
    path: `/api/messaging/telegram/onboarding/${encodeURIComponent(pairingId)}`,
    method: 'DELETE'
  })
}

export function restartGateway(): Promise<ActionResponse> {
  return window.hermesDesktop.api<ActionResponse>({
    path: '/api/gateway/restart',
    method: 'POST'
  })
}

export function getActionStatus(name: string, lines = 200): Promise<ActionStatusResponse> {
  return window.hermesDesktop.api<ActionStatusResponse>({
    path: `/api/actions/${encodeURIComponent(name)}/status?lines=${Math.max(1, lines)}`
  })
}
