import { $connection } from '@/store/session'

// Hermes Workbench — "Open in Canvas" handoff (Phase 0 of the Workbench⇄Kanban⇄Canvas
// pipeline; see docs/plans/canvas-integration/SPEC-canvas-full-function.md).
//
// After the orchestrator builds a page into the PROJECT dir, this hands that dir to
// the existing Canvas plugin so the user lands in its select-to-edit studio (click an
// element in the live preview → the agent gets its exact fingerprint + source file →
// precise edits). We do NOT rebuild any UI here — Canvas already ships that loop.
//
// TRANSPORT: a plain renderer→gateway HTTP POST to the EXISTING Canvas plugin endpoints
// (`/api/plugins/hermes-canvas/project/open` + `/dev/start`), reusing the live
// `$connection` (baseUrl + Bearer token) exactly like design-kanban.ts's Send-to-Kanban.
// No new IPC, no dependency on the Canvas host's fetch shim (we use an ABSOLUTE URL +
// the Authorization header, which the gateway accepts from any panel).
//
// CONSTRAINT (fail closed): Canvas 400s any project path NOT under
// HERMES_CANVAS_PROJECTS_ROOT — the launcher pins that to the Workbench projects root.

const DEFAULT_GATEWAY_BASE = 'http://127.0.0.1:9120'

async function canvasPost(path: string, body: unknown): Promise<Response> {
  const connection = $connection.get()

  if (!connection) {
    throw new Error('Not connected to the Hermes gateway — connect first, then open in Canvas.')
  }

  const base = connection.baseUrl || DEFAULT_GATEWAY_BASE
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  if (connection.token) {
    headers.Authorization = `Bearer ${connection.token}`
  }

  return fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
}

/**
 * Open a project directory in the Canvas studio: load it, then best-effort start its
 * dev server so the live preview is ready when the user lands on the Canvas tab.
 *
 * Throws with a clear message on: no gateway connection, network failure, or a non-2xx
 * from `project/open` (e.g. HTTP 400 when the path is outside HERMES_CANVAS_PROJECTS_ROOT,
 * or the dir has neither package.json nor index.html). The dev-server start is
 * best-effort — Canvas exposes a manual Start control, so a dev failure is NOT fatal.
 */
export async function openInCanvas(projectPath: string): Promise<void> {
  let res: Response

  try {
    res = await canvasPost('/api/plugins/hermes-canvas/project/open', { projectPath })
  } catch (err) {
    throw new Error(`Could not reach the Hermes gateway: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')

    throw new Error(`Canvas could not open the project (HTTP ${res.status})${detail ? `: ${detail}` : ''}`)
  }

  // Best-effort dev-server start so the preview is live on arrival. Never fatal.
  try {
    await canvasPost('/api/plugins/hermes-canvas/dev/start', { projectPath })
  } catch {
    // Canvas has a manual Start control; a dev-start hiccup must not fail the handoff.
  }
}
