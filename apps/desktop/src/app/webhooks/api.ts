// Webhooks REST surface for the desktop app. Mirrors the request pattern in
// `src/hermes.ts` (window.hermesDesktop.api, profile-scoped where applicable) so
// these calls route through Electron main exactly like every other feature.
//
// Functional parity with the dashboard's WebhooksPage (web/src/lib/api.ts):
//   GET    /api/webhooks                  → list subscriptions + platform state
//   POST   /api/webhooks                  → create (returns one-time secret)
//   DELETE /api/webhooks/:name            → delete a subscription
//   PUT    /api/webhooks/:name/enabled    → toggle enabled

export interface WebhookRoute {
  name: string
  description: string
  events: string[]
  deliver: string
  deliver_only: boolean
  prompt: string
  skills: string[]
  created_at: null | string
  url: string
  secret_set: boolean
  enabled: boolean
}

export interface WebhooksResponse {
  enabled: boolean
  base_url: string
  subscriptions: WebhookRoute[]
}

export interface WebhookCreatePayload {
  name: string
  description?: string
  events?: string[]
  prompt?: string
  skills?: string[]
  deliver?: string
  deliver_only?: boolean
  deliver_chat_id?: string
}

// POST /api/webhooks returns the new route plus the secret, which the backend
// surfaces exactly once — the UI must copy it before the dialog closes.
export type WebhookCreated = WebhookRoute & { secret: string }

export function listWebhooks(): Promise<WebhooksResponse> {
  return window.hermesDesktop.api<WebhooksResponse>({
    path: '/api/webhooks'
  })
}

export function createWebhook(body: WebhookCreatePayload): Promise<WebhookCreated> {
  return window.hermesDesktop.api<WebhookCreated>({
    path: '/api/webhooks',
    method: 'POST',
    body
  })
}

export function deleteWebhook(name: string): Promise<{ ok: boolean }> {
  return window.hermesDesktop.api<{ ok: boolean }>({
    path: `/api/webhooks/${encodeURIComponent(name)}`,
    method: 'DELETE'
  })
}

export function setWebhookEnabled(
  name: string,
  enabled: boolean
): Promise<{ ok: boolean; name: string; enabled: boolean }> {
  return window.hermesDesktop.api<{ ok: boolean; name: string; enabled: boolean }>({
    path: `/api/webhooks/${encodeURIComponent(name)}/enabled`,
    method: 'PUT',
    body: { enabled }
  })
}
