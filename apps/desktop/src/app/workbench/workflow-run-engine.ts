/**
 * Workflow Designer — Slice N (go-forward plan §5, Slice M/N split). The FIRST
 * execution capability in this codebase for a Workbench Workflow graph.
 *
 * Scope, non-negotiable (see the risk-elicitation gate that preceded this
 * slice):
 *  - This module NEVER calls a model/skill/agent/HTTP/terminal/git/cron/
 *    child_process API. It is pure, synchronous, in-memory graph traversal
 *    over data already loaded in the renderer.
 *  - Condition evaluation is structured field-comparison ONLY — a fixed
 *    operator enum switched over plain string/value comparison. No `eval`,
 *    no `new Function`, no `vm`, no dynamic property access on
 *    attacker/user-controlled strings.
 *  - Only 3 node kinds are ever interpreted: `manual_trigger`, `condition`,
 *    `output` — the only 3 kinds the Workflow Designer UI (workflow-panel.tsx)
 *    can author. If a saved graph contains any of the other 9 declared
 *    `WorkbenchWorkflowNodeKind` values, `runWorkflow` REFUSES to run it
 *    (status `refused_unsupported_node`) rather than attempting to interpret
 *    an unknown kind.
 *  - Bounded, always: a hard step cap (`maxSteps`, clamped 1–100, default
 *    `DEFAULT_MAX_STEPS`) AND a cycle guard (classic DFS white/gray/black
 *    coloring) that halts the instant a node reappears on the current
 *    traversal path, mirroring Kun's own `maxIterations` + stop-condition
 *    pattern documented in `docs/workflow-loop.md`. A user wiring a cycle
 *    (e.g. hand-editing saved JSON to point an edge back upstream — the
 *    authoring UI does not offer a source handle on Output, but nothing here
 *    trusts that) gets a clear `halted_cycle` result instead of a hang.
 *  - No side effects. `runWorkflow` reads `nodes`/`edges` and returns a
 *    result value; it does not write to disk, IPC, or any store. The Output
 *    node's "received value" in the result is display-only, ephemeral UI
 *    state owned by the caller (workflow-panel.tsx) — this module has no
 *    opinion on how long that state lives.
 *
 * Design decision — what a Condition node compares (documented per the task
 * brief, since there is no real data source yet): `leftExpr` is a plain
 * literal string the user typed on the node (not a reference into any
 * upstream payload), compared against the literal `rightValue` the user
 * typed. This is the simplest possible "first cut" comparison — exactly the
 * static-string-vs-static-string shape the go-forward brief calls out as
 * acceptable before any real data source exists.
 *
 * Design decision — branching: the Condition node UI (see `ConditionNode` in
 * workflow-panel.tsx) has exactly one source handle, so a condition can only
 * fan OUT to zero or more downstream nodes, not branch into a distinct
 * "true path" / "false path" via separate handles. Given that shape, a
 * condition evaluating to `true` continues traversal along every outgoing
 * edge (pass-through); evaluating to `false` is a dead end for this
 * traversal — nothing downstream of it is reached. This keeps the UI/engine
 * contract honest about what's actually wired, without inventing two-handle
 * branching semantics the authoring UI doesn't have.
 */
import type { WorkbenchWorkflowEdge, WorkbenchWorkflowNode, WorkbenchWorkflowNodeKind } from '@hermes/shared'

// ---------------------------------------------------------------------------
// Structured condition config — REPLACES the old free-text `config.expression`
// shape shipped in Slice M. Never evaluated as code; every operator below is a
// plain data comparison.
// ---------------------------------------------------------------------------

export const CONDITION_OPERATORS = ['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'is_empty'] as const

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number]

export interface ConditionNodeConfig {
  leftExpr?: string
  operator?: ConditionOperator
  rightValue?: string
  caseSensitive?: boolean
}

function isConditionOperator(value: unknown): value is ConditionOperator {
  return typeof value === 'string' && (CONDITION_OPERATORS as readonly string[]).includes(value)
}

/** Reads the structured condition fields out of a node's `config`, ignoring
 * any unrelated keys (including a legacy `expression` string from Slice M —
 * that field is never read here, so old saved workflows load without error,
 * they just evaluate as "not configured"). */
export function readConditionConfig(config: Record<string, unknown>): ConditionNodeConfig {
  return {
    caseSensitive: config.caseSensitive === true,
    leftExpr: typeof config.leftExpr === 'string' ? config.leftExpr : undefined,
    operator: isConditionOperator(config.operator) ? config.operator : undefined,
    rightValue: typeof config.rightValue === 'string' ? config.rightValue : undefined
  }
}

export interface ConditionEvaluation {
  result: boolean
  configured: boolean
  note: string
}

/** Plain field-comparison switch over a fixed operator enum. No `eval`, no
 * `new Function`, no dynamic property access — every branch is a literal
 * string/number comparison between two already-known strings. */
export function evaluateCondition(config: Record<string, unknown>): ConditionEvaluation {
  const { caseSensitive, leftExpr, operator, rightValue } = readConditionConfig(config)

  if (leftExpr === undefined || operator === undefined) {
    return { configured: false, note: 'no comparison configured yet', result: false }
  }

  const right = rightValue ?? ''

  if (operator === 'is_empty') {
    return { configured: true, note: `is_empty("${leftExpr}")`, result: leftExpr.trim().length === 0 }
  }

  const left = caseSensitive ? leftExpr : leftExpr.toLowerCase()
  const rightCompare = caseSensitive ? right : right.toLowerCase()

  switch (operator) {
    case 'equals':
      return { configured: true, note: `"${leftExpr}" equals "${right}"`, result: left === rightCompare }

    case 'not_equals':
      return { configured: true, note: `"${leftExpr}" not_equals "${right}"`, result: left !== rightCompare }

    case 'contains':
      return { configured: true, note: `"${leftExpr}" contains "${right}"`, result: left.includes(rightCompare) }

    case 'greater_than':
    case 'less_than': {
      const leftNum = Number(leftExpr)
      const rightNum = Number(right)

      if (Number.isNaN(leftNum) || Number.isNaN(rightNum)) {
        return { configured: true, note: `"${leftExpr}" ${operator} "${right}" — not both numeric, treated as false`, result: false }
      }

      const result = operator === 'greater_than' ? leftNum > rightNum : leftNum < rightNum

      return { configured: true, note: `${leftNum} ${operator} ${rightNum}`, result }
    }

    default:
      return { configured: false, note: 'unrecognized operator', result: false }
  }
}

// ---------------------------------------------------------------------------
// Run engine
// ---------------------------------------------------------------------------

/** The only node kinds this engine ever interprets — the same 3 kinds the
 * authoring UI can create. Anything else present in a graph causes an
 * immediate refusal (see `runWorkflow`), never a best-effort interpretation. */
const EXECUTABLE_KINDS = new Set<WorkbenchWorkflowNodeKind>(['manual_trigger', 'condition', 'output'])

export const MIN_MAX_STEPS = 1
export const MAX_MAX_STEPS = 100
/** Sensible default step cap, mirroring Kun's own `maxIterations` default
 * order of magnitude (docs/workflow-loop.md) for a first cut with no real
 * data source and small authored graphs. */
export const DEFAULT_MAX_STEPS = 10

export type RunOutcomeStatus = 'completed' | 'halted_cycle' | 'halted_max_steps' | 'nothing_to_run' | 'refused_unsupported_node'

export interface RunStepRecord {
  nodeId: string
  kind: WorkbenchWorkflowNodeKind
  name: string
  detail: string
}

export interface RunOutputRecord {
  nodeId: string
  name: string
  receivedValue: string
}

export interface RunWorkflowResult {
  status: RunOutcomeStatus
  message: string
  maxSteps: number
  steps: RunStepRecord[]
  outputs: RunOutputRecord[]
}

export interface RunWorkflowOptions {
  /** Clamped to [MIN_MAX_STEPS, MAX_MAX_STEPS]; defaults to DEFAULT_MAX_STEPS. */
  maxSteps?: number
}

function clampMaxSteps(requested: number | undefined): number {
  const value = requested ?? DEFAULT_MAX_STEPS

  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_STEPS
  }

  return Math.min(MAX_MAX_STEPS, Math.max(MIN_MAX_STEPS, Math.trunc(value)))
}

type NodeColor = 'black' | 'gray'

// Escapes the recursive traversal the instant a halt condition is hit,
// unwinding through every pending recursive `visit` call in one step. Using
// an exception (rather than a shared mutable "halted" flag read back after
// the fact) sidesteps a real TypeScript limitation: control-flow narrowing
// does not track assignments made inside a nested closure, so a `let halted
// = null` reassigned from within `visit` cannot be soundly narrowed back to
// non-null by the caller. Throwing/catching a typed value has no such
// limitation and reads as a normal "abort the search" idiom.
class WorkflowRunHalted extends Error {
  readonly runStatus: 'halted_cycle' | 'halted_max_steps'

  constructor(runStatus: 'halted_cycle' | 'halted_max_steps', message: string) {
    super(message)
    this.name = 'WorkflowRunHalted'
    this.runStatus = runStatus
  }
}

/** Runs a WorkbenchWorkflow graph, starting from every `manual_trigger` node,
 * following edges, evaluating `condition` nodes via structured comparison
 * (see `evaluateCondition`), and recording what reaches each `output` node.
 * Pure and synchronous — no IPC, no disk, no network, no side effects. */
export function runWorkflow(nodes: WorkbenchWorkflowNode[], edges: WorkbenchWorkflowEdge[], options?: RunWorkflowOptions): RunWorkflowResult {
  const maxSteps = clampMaxSteps(options?.maxSteps)

  const unsupportedKinds = [...new Set(nodes.filter(node => !EXECUTABLE_KINDS.has(node.type)).map(node => node.type))]

  if (unsupportedKinds.length > 0) {
    return {
      maxSteps,
      message: `Run refused: workflow contains unsupported node kind(s): ${unsupportedKinds.join(', ')}.`,
      outputs: [],
      status: 'refused_unsupported_node',
      steps: []
    }
  }

  const nodesById = new Map(nodes.map(node => [node.id, node]))
  const edgesBySource = new Map<string, WorkbenchWorkflowEdge[]>()

  for (const edge of edges) {
    const list = edgesBySource.get(edge.source) ?? []

    list.push(edge)
    edgesBySource.set(edge.source, list)
  }

  const triggers = nodes.filter(node => node.type === 'manual_trigger')

  if (triggers.length === 0) {
    return { maxSteps, message: 'Nothing to run: this workflow has no trigger node.', outputs: [], status: 'nothing_to_run', steps: [] }
  }

  const steps: RunStepRecord[] = []
  const outputs: RunOutputRecord[] = []
  const colors = new Map<string, NodeColor>()
  let stepCount = 0

  // Classic DFS white/gray/black cycle detection: a node currently "gray" is
  // on the active traversal path — reappearing there is a genuine back-edge
  // (a cycle), not legitimate fan-in. A node already "black" was fully
  // processed by an earlier branch/trigger and is simply skipped (fan-in is
  // not an error). Bounded by `maxSteps` checked before every new node; both
  // halt conditions throw `WorkflowRunHalted`, unwinding the recursion in one
  // step (see the class docstring for why this is not a shared mutable flag).
  function visit(nodeId: string): void {
    if (colors.get(nodeId) === 'black') {
      return
    }

    if (colors.get(nodeId) === 'gray') {
      throw new WorkflowRunHalted('halted_cycle', `Run stopped: cycle detected in workflow graph at node "${nodesById.get(nodeId)?.name ?? nodeId}".`)
    }

    if (stepCount >= maxSteps) {
      throw new WorkflowRunHalted('halted_max_steps', `Run stopped: max steps reached (${maxSteps}).`)
    }

    const node = nodesById.get(nodeId)

    if (!node) {
      return
    }

    colors.set(nodeId, 'gray')
    stepCount += 1

    const outgoing = edgesBySource.get(nodeId) ?? []

    if (node.type === 'manual_trigger') {
      steps.push({ detail: 'trigger fired', kind: node.type, name: node.name, nodeId })

      for (const edge of outgoing) {
        visit(edge.target)
      }
    } else if (node.type === 'condition') {
      const evaluation = evaluateCondition(node.config ?? {})

      steps.push({
        detail: evaluation.configured ? `evaluated ${evaluation.result ? 'true' : 'false'}: ${evaluation.note}` : evaluation.note,
        kind: node.type,
        name: node.name,
        nodeId
      })

      if (evaluation.result) {
        for (const edge of outgoing) {
          visit(edge.target)
        }
      }
      // false (or unconfigured) is a dead end for this traversal path — see
      // the module-level "Design decision — branching" note.
    } else if (node.type === 'output') {
      const label = typeof node.config?.label === 'string' && node.config.label.trim() ? node.config.label.trim() : node.name
      const receivedValue = `Reached "${label}"`

      steps.push({ detail: 'output reached', kind: node.type, name: node.name, nodeId })
      outputs.push({ name: node.name, nodeId, receivedValue })
      // Output is terminal by design (see module docstring) — its own
      // outgoing edges, if any exist in malformed/hand-edited data, are
      // never followed.
    }

    colors.set(nodeId, 'black')
  }

  try {
    for (const trigger of triggers) {
      visit(trigger.id)
    }
  } catch (err) {
    if (err instanceof WorkflowRunHalted) {
      return { maxSteps, message: err.message, outputs, status: err.runStatus, steps }
    }

    throw err
  }

  return {
    maxSteps,
    message: outputs.length > 0 ? 'completed' : 'completed: no output node was reached',
    outputs,
    status: 'completed',
    steps
  }
}
