import type { WorkbenchWorkflowEdge, WorkbenchWorkflowNode } from '@hermes/shared'

import { $gateway } from '@/store/gateway'
import { $activeSessionId } from '@/store/session'

// Gateway-backed workflow execution client — the JSON-RPC path to the Python
// `tui_gateway` WF0/WF2/WF3 spine (`workflow.run` / `workflow.dryRun`), distinct
// from the pure, in-memory preview engine in
// app/workbench/workflow-run-engine.ts. Mirrors lib/oneshot.ts: a thin wrapper
// over the live `$gateway` that never touches Electron IPC.
//
// The authoring graph (React Flow / persisted `WorkbenchWorkflow`) and the graph
// the Python engine walks have DIFFERENT shapes; `toEngineGraph` is the required
// translation (see its doc). Nothing here interprets a node's config — it is
// carried through verbatim to the guarded server executors.

/** Node shape the Python engine indexes (tui_gateway/workflow_runtime.py:_index). */
export interface EngineGraphNode {
  id: string
  kind: string
  config: Record<string, unknown>
}

/** Edge shape the Python engine walks (`from`/`to`, optional routing `label`). */
export interface EngineGraphEdge {
  from: string
  to: string
  label?: string
}

export interface EngineGraph {
  nodes: EngineGraphNode[]
  edges: EngineGraphEdge[]
}

/**
 * One streamed run event — the `payload` of a gateway `workflow.run.event`
 * notification, produced by the engine's inner `_emit`
 * (tui_gateway/workflow_runtime.py:64-67). `status` on a step is `'ok'` or
 * `'denied'` (with a `reason`); a failed run carries `error`.
 */
export interface WorkflowRunEvent {
  type: 'workflow.run.started' | 'workflow.run.step' | 'workflow.run.completed' | 'workflow.run.failed'
  runId: string
  workflowId: string
  nodeId: null | string
  seq: number
  kind?: string
  status?: string
  reason?: string
  error?: string
  steps?: number
  origin?: string
}

/** Final result of `workflow.run` / `workflow.dryRun` (run_graph's return). */
export interface WorkflowRunResult {
  runId: string
  status: 'completed' | 'failed' | 'halted'
  steps: number
  outputs: Record<string, unknown>
  events: WorkflowRunEvent[]
  error: null | string
}

export interface WorkflowRunOptions {
  workflowId?: string
  /** Launching session (defaults to the active one); the gateway routes run
   *  events back on this id and derives the workspace root from its cwd. */
  sessionId?: null | string
  /** Side-effecting kinds pre-approved for a LIVE run (AllowlistSink). Anything
   *  not listed fails closed. Ignored by dryRun. */
  approvedKinds?: string[]
  httpAllowlist?: string[]
  allowCodeNode?: boolean
  origin?: string
  maxSteps?: number
  signal?: AbortSignal
}

// TS authoring kind (underscore) -> engine kind (hyphen). Verified: every one of
// the 12 WorkbenchWorkflowNodeKind values maps 1:1 by replacing '_' with '-'
// onto a kind the WF0 guard recognises — PURE_KINDS (manual-trigger/condition/
// loop/output), the approval kinds (ai-agent/human-approval/…), or the narrowly
// gated http-request / code (tui_gateway/workflow_guard.py).
function toEngineKind(tsKind: string): string {
  return tsKind.replace(/_/g, '-')
}

/**
 * Translate the authoring graph into the shape the Python engine walks:
 *   node.type -> node.kind (+ hyphenate),  edge.source/target -> edge.from/to.
 * A React Flow `sourceHandle` (e.g. a condition true/false branch) becomes the
 * engine's edge `label`; absent, the engine follows all out-edges when a
 * condition is truthy (workflow_runtime.py:118-124). Disabled nodes are dropped.
 */
export function toEngineGraph(nodes: WorkbenchWorkflowNode[], edges: WorkbenchWorkflowEdge[]): EngineGraph {
  return {
    edges: edges.map(edge => ({
      from: edge.source,
      to: edge.target,
      ...(edge.sourceHandle ? { label: edge.sourceHandle } : {})
    })),
    nodes: nodes
      .filter(node => !node.disabled)
      .map(node => ({ config: node.config ?? {}, id: node.id, kind: toEngineKind(node.type) }))
  }
}

function gatewayOrThrow() {
  const gateway = $gateway.get()

  if (!gateway) {
    throw new Error('Gateway not connected')
  }

  return gateway
}

function resolveSessionId(opts: WorkflowRunOptions): null | string {
  return opts.sessionId === undefined ? $activeSessionId.get() : opts.sessionId
}

// A live run may take up to the engine's 300s step/time budget; keep the
// request open comfortably past that so a slow run isn't aborted client-side.
const RUN_TIMEOUT_MS = 330_000

/**
 * LIVE run: dispatches every node through the WF0 guard (inescapable budget +
 * policy). Side-effecting kinds only run if their kind is in `approvedKinds`
 * (an AllowlistSink); anything else fails closed. Streams `workflow.run.event`s
 * to the launching session — pair with `onWorkflowRunEvent` for live progress.
 */
export async function runWorkflowRemote(graph: EngineGraph, opts: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
  const gateway = gatewayOrThrow()

  return gateway.request<WorkflowRunResult>(
    'workflow.run',
    {
      allow_code_node: opts.allowCodeNode,
      approved_kinds: opts.approvedKinds,
      graph,
      http_allowlist: opts.httpAllowlist,
      max_steps: opts.maxSteps,
      origin: opts.origin,
      session_id: resolveSessionId(opts) ?? undefined,
      workflow_id: opts.workflowId
    },
    RUN_TIMEOUT_MS,
    opts.signal
  )
}

/**
 * DRY run: traces the WHOLE graph with NO side effects and NO approval prompts —
 * side-effecting kinds report as `{__dry__, wouldRun}` markers. Safe to call
 * without pre-approving anything.
 */
export async function dryRunWorkflowRemote(graph: EngineGraph, opts: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
  const gateway = gatewayOrThrow()

  return gateway.request<WorkflowRunResult>(
    'workflow.dryRun',
    {
      graph,
      max_steps: opts.maxSteps,
      origin: opts.origin,
      session_id: resolveSessionId(opts) ?? undefined,
      workflow_id: opts.workflowId
    },
    undefined,
    opts.signal
  )
}

/**
 * Subscribe to a run's progress stream. The gateway echoes every run event back
 * on the launching session, so events are filtered by that session id. Returns
 * an unsubscribe function (no-op when the gateway is offline).
 */
export function onWorkflowRunEvent(sessionId: null | string, handler: (event: WorkflowRunEvent) => void): () => void {
  const gateway = $gateway.get()

  if (!gateway) {
    return () => {}
  }

  return gateway.on<WorkflowRunEvent>('workflow.run.event', event => {
    // The gateway stamps each run event with the launching session id; ignore
    // events for other sessions when we know ours.
    if (sessionId && event.session_id && event.session_id !== sessionId) {
      return
    }

    if (event.payload) {
      handler(event.payload)
    }
  })
}
