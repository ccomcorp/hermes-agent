/**
 * Pairing API — DM pairing codes (list / approve / revoke / clear-pending).
 *
 * Mirrors the desktop request pattern in `src/hermes.ts`: every call goes
 * through `window.hermesDesktop.api<T>({ path, method?, body? })`, which routes
 * the REST call to the connected backend. Types are declared locally so this
 * feature stays self-contained and does not touch the shared `types/hermes`.
 */

export interface PairingUser {
  platform: string
  user_id: string
  user_name?: string
  /** Present on pending requests; required to approve. */
  code?: string
  age_minutes?: number
}

export interface PairingResponse {
  pending: PairingUser[]
  approved: PairingUser[]
}

export interface ClearPendingResponse {
  ok: boolean
  cleared: number
}

export function getPairing(): Promise<PairingResponse> {
  return window.hermesDesktop.api<PairingResponse>({
    path: '/api/pairing'
  })
}

export function approvePairing(platform: string, code: string): Promise<{ ok: boolean; user: PairingUser }> {
  return window.hermesDesktop.api<{ ok: boolean; user: PairingUser }>({
    path: '/api/pairing/approve',
    method: 'POST',
    body: { platform, code }
  })
}

export function revokePairing(platform: string, userId: string): Promise<{ ok: boolean }> {
  return window.hermesDesktop.api<{ ok: boolean }>({
    path: '/api/pairing/revoke',
    method: 'POST',
    body: { platform, user_id: userId }
  })
}

export function clearPendingPairing(): Promise<ClearPendingResponse> {
  return window.hermesDesktop.api<ClearPendingResponse>({
    path: '/api/pairing/clear-pending',
    method: 'POST'
  })
}
