import { $connection } from '@/store/session'

import type { DesignGenerationKind } from './design-generation'
import { buildDesignKanbanCard } from './design-handoff'

// Hermes Workbench — Design Studio "Send to Kanban" handoff (additive sibling
// of "Send to code agent", design-handoff.ts). Where the code-agent handoff
// opens a fresh chat session seeded with the design, THIS handoff creates a
// Kanban card on the user's multi-agent board so the work lands with the dev
// team and gets picked up by the right orchestrator.
//
// TRANSPORT: a plain renderer→gateway HTTP POST to the EXISTING kanban plugin
// endpoint (`POST /api/plugins/kanban/tasks`, plugins/kanban/dashboard/
// plugin_api.py::create_task). No new IPC channel and no backend change — the
// same renderer→gateway call the Kanban page already makes to load the plugin
// (apps/desktop/src/app/kanban/index.tsx's `fetchJSON`). We read the live
// `$connection` (baseUrl + token) from `@/store/session` and authenticate with
// the `Authorization: Bearer <token>` header, exactly like that `fetchJSON`
// does — the dashboard's HTTP routes accept the session bearer token. We build
// the URL inline (base + '/api/plugins/kanban/tasks') rather than importing
// index.tsx's local `kanbanUrl` (importing from an app-page module would be
// invasive, and that helper is a trivial `base + path` concat that carries no
// auth — the auth lives in the header, which we replicate here).
//
// FAIL CLOSED: if `$connection` is null (gateway not connected) we throw
// before any card is built — no silent no-op, no half-formed card.

// The multi-agent dev orchestrator profile a design→code card is assigned to.
// This MUST be a real, existing profile: the kanban backend leaves a card with
// an unknown assignee sitting in `ready` forever (never dispatched). Named as
// a constant so it is easy to find and retarget if the orchestrator profile is
// ever renamed. Confirmed to exist.
export const DESIGN_KANBAN_ASSIGNEE = 'fable-orchestrator'

// Scope the card to the user's real project directory. `"dir"` runs the task
// in the existing project (works whether or not it is a git repo) rather than
// the `create_task` default of `"scratch"` (a throwaway workspace) — a
// design→code task must run against the real project. `"worktree"` would
// isolate in a git worktree but REQUIRES the workspace to be a git repo, so it
// is the more fragile default; `"dir"` is preferred here.
const DESIGN_KANBAN_WORKSPACE_KIND = 'dir'

const DEFAULT_GATEWAY_BASE = 'http://127.0.0.1:9120'

export interface SendDesignToKanbanArgs {
  workspaceRoot: string
  requirementId: string
  kind: DesignGenerationKind
  content: string
}

/**
 * Creates a Kanban card for a generated design artifact and returns the new
 * card id on success.
 *
 * Throws with a clear message on: no gateway connection, a network failure, or
 * a non-2xx response. The payload building (title/body) is delegated to the
 * pure, unit-tested `buildDesignKanbanCard`; this function only reads the
 * connection, adds the assignee + workspace scoping, and performs the POST.
 */
export async function sendDesignToKanban(args: SendDesignToKanbanArgs): Promise<string> {
  const connection = $connection.get()

  // Fail closed: gateway not connected → clear error, no card.
  if (!connection) {
    throw new Error('Not connected to the Hermes gateway — connect first, then send to Kanban.')
  }

  const { title, body } = buildDesignKanbanCard(args.kind, args.requirementId, args.content)

  const payload = {
    title,
    body,
    assignee: DESIGN_KANBAN_ASSIGNEE,
    workspace_kind: DESIGN_KANBAN_WORKSPACE_KIND,
    workspace_path: args.workspaceRoot
  }

  const base = connection.baseUrl || DEFAULT_GATEWAY_BASE
  const url = `${base}/api/plugins/kanban/tasks`

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  if (connection.token) {
    headers.Authorization = `Bearer ${connection.token}`
  }

  let res: Response

  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) })
  } catch (err) {
    throw new Error(`Could not reach the Hermes gateway: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')

    throw new Error(`Kanban rejected the card (HTTP ${res.status})${detail ? `: ${detail}` : ''}`)
  }

  const data = (await res.json().catch(() => null)) as { task?: { id?: string } } | null

  // A 2xx response with no usable card id is an ERROR, not an empty string —
  // returning '' here would let the caller write an empty backlink and report
  // false success. The card either has a real id or this throws; never ''.
  const cardId = data?.task?.id

  if (typeof cardId !== 'string' || !cardId.trim()) {
    throw new Error('Kanban accepted the card but returned no card id — cannot link it back to the requirement.')
  }

  return cardId
}

// ---------------------------------------------------------------------------
// Live linked-card status (Kanban traceability — live status). The READ side
// of the handoff: after a "Send to Kanban" the requirement's linked-cards list
// shows each card's LIVE status so the user can watch the orchestrator build
// from inside the Workbench. Same transport as the POST above — a plain
// renderer→gateway GET reusing `$connection` (baseUrl + token) + Bearer header.
// No new IPC channel, no backend change: `GET /api/plugins/kanban/tasks/:id`
// already exists (plugins/kanban/dashboard/plugin_api.py::get_task).
// ---------------------------------------------------------------------------

/**
 * A live linked Kanban card's status, trimmed to the fields the Workbench
 * actually renders. Shape mirrors the REAL `_task_dict` (asdict(Task)) top-
 * level fields — `id`, `status` (one of triage/todo/scheduled/ready/running/
 * blocked/review/done/archived), and the optional `title`/`assignee`.
 */
export interface KanbanCardStatus {
  id: string
  status: string
  title?: string
  assignee?: string
}

/** Badge variants this module maps statuses onto (subset of the Badge component's). */
export type KanbanStatusBadgeVariant = 'default' | 'muted' | 'warn' | 'destructive' | 'outline'

// Terminal = the card will not change again on its own, so polling can stop.
// Deliberately ONLY done + archived. `blocked` and `review` are NOT terminal:
// a blocked card can be auto-unblocked (the kanban cron flips blocked→ready)
// and a review card can advance to done, so we keep polling to catch that.
const KANBAN_TERMINAL_STATUSES = new Set(['done', 'archived'])

/** True when a card's status is final and no further polling is warranted. */
export function isTerminalKanbanStatus(status: string): boolean {
  return KANBAN_TERMINAL_STATUSES.has(status)
}

/**
 * Maps a backend status to a Badge variant. Pure + total: any unknown/future
 * status degrades to a neutral `outline` rather than throwing.
 */
export function kanbanStatusBadgeVariant(status: string): KanbanStatusBadgeVariant {
  switch (status) {
    case 'done':
      return 'default'

    case 'blocked':
      return 'destructive'

    case 'running':

    case 'review':
      return 'warn'

    case 'archived':
      return 'muted'

    case 'triage':

    case 'todo':

    case 'scheduled':

    case 'ready':
      return 'outline'

    default:
      return 'outline'
  }
}

/**
 * Reads ONE linked Kanban card's live status from the gateway.
 *
 * Fail-closed / never-throws: returns `null` on every failure path (no
 * `$connection`, network error, non-2xx, unparseable body, or a response whose
 * shape doesn't carry a usable `task.status`). The caller renders the card id
 * with an "unavailable" note in that case — a gateway hiccup or an odd card
 * shape must never crash the panel.
 *
 * The response is the `GET /tasks/:id` ENVELOPE — `{ task: {...}, comments,
 * events, ... }` — so the status lives under `data.task`, not at the top level.
 * We read only the fields we render and validate each is a string before use;
 * we never `.map()` over anything here.
 */
export async function getKanbanCard(cardId: string): Promise<KanbanCardStatus | null> {
  const connection = $connection.get()

  // Gateway not connected → no status (caller shows "gateway not connected").
  if (!connection) {
    return null
  }

  const base = connection.baseUrl || DEFAULT_GATEWAY_BASE
  const url = `${base}/api/plugins/kanban/tasks/${encodeURIComponent(cardId)}`

  const headers: Record<string, string> = {}

  if (connection.token) {
    headers.Authorization = `Bearer ${connection.token}`
  }

  let res: Response

  try {
    res = await fetch(url, { method: 'GET', headers })
  } catch {
    // Network failure (gateway down, DNS, etc.) — degrade, don't throw.
    return null
  }

  if (!res.ok) {
    return null
  }

  const data = (await res.json().catch(() => null)) as { task?: Record<string, unknown> } | null
  const task = data?.task

  // Defensive: the body must be the expected envelope with an object `task`.
  if (!task || typeof task !== 'object') {
    return null
  }

  // `status` is the only load-bearing field — without it there is nothing to
  // show, so treat a missing/non-string status as "unavailable".
  const status = typeof task.status === 'string' && task.status.trim() ? task.status : null

  if (!status) {
    return null
  }

  const id = typeof task.id === 'string' && task.id.trim() ? task.id : cardId
  const title = typeof task.title === 'string' && task.title.trim() ? task.title : undefined
  const assignee = typeof task.assignee === 'string' && task.assignee.trim() ? task.assignee : undefined

  return { id, status, title, assignee }
}
