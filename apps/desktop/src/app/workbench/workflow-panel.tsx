/**
 * Workflow Designer panel — Slice M (authoring, go-forward plan §5) + Slice N
 * (bounded manual Run — this is the first execution capability in the whole
 * Workbench feature, gated on a dedicated multi-method risk elicitation
 * before it was built; see workflow-run-engine.ts for the full rationale).
 *
 * A WorkbenchWorkflow is a graph (nodes + edges) that is created, saved,
 * loaded, and edited. The canvas is `@xyflow/react` (React Flow), the sourced
 * dependency choice documented in 00-go-forward-plan.md (Kun's own confirmed
 * `^12.11.0`).
 *
 * The node palette offers exactly 3 creatable kinds: Trigger (`manual_trigger`,
 * the entry point a Run starts from), Condition, and Output.
 * `WorkbenchWorkflowNodeKind` has 12 declared kinds in `@hermes/shared` — this
 * UI intentionally exposes only 3 of them; the other 9 (`ai_agent`, `code`,
 * `http_request`, `webhook_trigger`, `schedule_trigger`, `human_approval`,
 * `delay`, `loop`, `subworkflow`) are NOT offered here, even as disabled
 * stubs, and `runWorkflow` (workflow-run-engine.ts) refuses to run any saved
 * graph that somehow contains one of them. The backend validator stays
 * permissive of all 12 kinds (see apps/shared/src/workbench/validators.ts) —
 * this is a UI/engine-only restriction.
 *
 * Node/edge drag, connect, and delete all go through React Flow's own
 * `onNodesChange`/`onEdgesChange`/`onConnect` handlers plus `applyNodeChanges`/
 * `applyEdgeChanges`/`addEdge` — no hand-rolled graph math. A Condition node's
 * comparison is stored as STRUCTURED fields (`config.leftExpr`/`operator`/
 * `rightValue`/`caseSensitive` — see workflow-run-engine.ts) — this REPLACES
 * the old free-text `config.expression` shape shipped in Slice M; that field
 * is no longer written by this UI and is never read by the run engine (an
 * old saved workflow with only `config.expression` loads fine and simply
 * evaluates as "not configured yet", never as code). A display-only
 * placeholder is shown for `config.label` on an Output node.
 *
 * Running a workflow (`handleRun` in `WorkflowEditor`) only ever calls the
 * pure, synchronous, in-memory `runWorkflow` from workflow-run-engine.ts — no
 * model/skill/agent/HTTP/terminal/git/cron/child_process API is reachable
 * from this file. The Output node's "received value" is shown in an ephemeral
 * run-log dialog (`RunResultDialog`) that is local React state, cleared on
 * dialog close or the next Run — nothing from a run is ever written to disk.
 *
 * No raw filesystem path ever appears here — every call goes through a
 * workflow id plus the workspace root the shell already validated.
 */
import '@xyflow/react/dist/style.css'

import type { WorkbenchWorkflow, WorkbenchWorkflowEdge, WorkbenchWorkflowNode, WorkbenchWorkflowNodeKind } from '@hermes/shared'
import { HERMES_WORKFLOWS_DIR } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import type { Connection, Edge, EdgeChange, Node, NodeChange, NodeProps } from '@xyflow/react'
import { addEdge, applyEdgeChanges, applyNodeChanges, Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider } from '@xyflow/react'
import type * as React from 'react'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { dryRunWorkflowRemote, onWorkflowRunEvent, runWorkflowRemote, toEngineGraph, type WorkflowRunEvent, type WorkflowRunResult } from '@/lib/workflow-run'
import { notify, notifyError } from '@/store/notifications'
import { $activeSessionId } from '@/store/session'

import { ListColumn, MasterDetail } from '../master-detail'
import { PanelEmpty, PanelListRow } from '../overlays/panel'

import { createWorkflow, listWorkflows, readWorkflow, updateWorkflow } from './api'
import type { UpdateWorkbenchWorkflowResult } from './api'
import {
  $workbenchActiveWorkflowId,
  $workbenchWorkflows,
  $workbenchWorkflowsError,
  $workbenchWorkflowsLoading,
  patchWorkbenchWorkflowManifestEntry,
  setWorkbenchActiveWorkflowId,
  setWorkbenchWorkflows,
  setWorkbenchWorkflowsError,
  setWorkbenchWorkflowsLoading,
  upsertWorkbenchWorkflowManifestEntry
} from './store'
import { workbenchStrings as s } from './strings'
import { CONDITION_OPERATORS, readConditionConfig, runWorkflow } from './workflow-run-engine'
import type { RunWorkflowResult } from './workflow-run-engine'

// The 3 creatable kinds — see the module comment above for the full scope
// boundary on why the other 9 declared kinds are never offered here.
type CreatableNodeKind = 'condition' | 'manual_trigger' | 'output'

interface WorkflowNodeData extends Record<string, unknown> {
  config: Record<string, unknown>
  kind: WorkbenchWorkflowNodeKind
  name: string
}

type WorkflowNode = Node<WorkflowNodeData>

function newLocalId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

// Passes a per-node config-update callback down to custom node renderers
// without threading it through node `data` (which must stay a plain,
// serializable authoring-time payload — see WorkflowNodeData above).
const WorkflowNodeActionsContext = createContext<{
  updateNodeConfig: (id: string, patch: Record<string, unknown>) => void
}>({ updateNodeConfig: () => {} })

function TriggerNode({ data }: NodeProps<WorkflowNode>) {
  return (
    <div className="min-w-32 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) px-3 py-2 text-xs shadow-sm">
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        <Codicon name="play" size="0.75rem" />
        {data.name}
      </div>
      <Handle position={Position.Right} type="source" />
    </div>
  )
}

function OutputNode({ data }: NodeProps<WorkflowNode>) {
  const label = typeof data.config.label === 'string' ? data.config.label : ''

  return (
    <div className="min-w-32 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) px-3 py-2 text-xs shadow-sm">
      <Handle position={Position.Left} type="target" />
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        <Codicon name="symbol-event" size="0.75rem" />
        {data.name}
      </div>
      <div className="mt-1 truncate text-[0.65rem] text-muted-foreground/60">{label || s.workflow.outputLabelPlaceholder}</div>
    </div>
  )
}

// Structured comparison fields — REPLACES the old free-text `config.expression`
// input from Slice M (see the module docstring and workflow-run-engine.ts).
// An old saved node with only `config.expression` simply shows these fields
// empty/unset ("no comparison configured yet") rather than crashing.
function ConditionNode({ data, id }: NodeProps<WorkflowNode>) {
  const { updateNodeConfig } = useContext(WorkflowNodeActionsContext)
  const { caseSensitive, leftExpr, operator, rightValue } = readConditionConfig(data.config)

  return (
    <div className="min-w-56 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) px-3 py-2 text-xs shadow-sm">
      <Handle position={Position.Left} type="target" />
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        <Codicon name="git-branch" size="0.75rem" />
        {data.name}
      </div>

      <label className="nodrag mt-1.5 block text-[0.62rem] text-muted-foreground/60">
        {s.workflow.conditionLeftLabel}
        <input
          className="mt-0.5 w-full rounded border border-(--ui-stroke-tertiary) bg-transparent px-1.5 py-1 text-[0.68rem] text-foreground outline-none"
          onChange={event => updateNodeConfig(id, { leftExpr: event.target.value })}
          placeholder={s.workflow.conditionLeftPlaceholder}
          value={leftExpr ?? ''}
        />
      </label>

      <label className="nodrag mt-1.5 block text-[0.62rem] text-muted-foreground/60">
        {s.workflow.conditionOperatorLabel}
        <select
          className="mt-0.5 w-full rounded border border-(--ui-stroke-tertiary) bg-transparent px-1.5 py-1 text-[0.68rem] text-foreground outline-none"
          onChange={event => updateNodeConfig(id, { operator: event.target.value })}
          value={operator ?? ''}
        >
          <option disabled value="">
            {s.workflow.conditionOperatorPlaceholder}
          </option>
          {CONDITION_OPERATORS.map(op => (
            <option key={op} value={op}>
              {s.workflow.operatorNames[op] ?? op}
            </option>
          ))}
        </select>
      </label>

      {operator !== 'is_empty' && (
        <label className="nodrag mt-1.5 block text-[0.62rem] text-muted-foreground/60">
          {s.workflow.conditionRightLabel}
          <input
            className="mt-0.5 w-full rounded border border-(--ui-stroke-tertiary) bg-transparent px-1.5 py-1 text-[0.68rem] text-foreground outline-none"
            onChange={event => updateNodeConfig(id, { rightValue: event.target.value })}
            placeholder={s.workflow.conditionRightPlaceholder}
            value={rightValue ?? ''}
          />
        </label>
      )}

      <label className="nodrag mt-1.5 flex items-center gap-1 text-[0.62rem] text-muted-foreground/60">
        <input
          checked={caseSensitive ?? false}
          onChange={event => updateNodeConfig(id, { caseSensitive: event.target.checked })}
          type="checkbox"
        />
        {s.workflow.conditionCaseSensitiveLabel}
      </label>

      <Handle position={Position.Right} type="source" />
    </div>
  )
}

const NODE_TYPES = {
  condition: ConditionNode,
  manual_trigger: TriggerNode,
  output: OutputNode
}

function isCreatableKind(kind: string): kind is CreatableNodeKind {
  return kind === 'manual_trigger' || kind === 'condition' || kind === 'output'
}

function toFlowNodes(nodes: WorkbenchWorkflowNode[]): WorkflowNode[] {
  return nodes.map(node => ({
    data: { config: node.config ?? {}, kind: node.type, name: node.name },
    // Any node kind outside the 3 this UI creates (e.g. persisted by a future
    // slice) falls back to the Output renderer rather than crashing — this
    // slice never authors those kinds, but must not choke on loading them.
    id: node.id,
    position: node.position,
    type: isCreatableKind(node.type) ? node.type : 'output'
  }))
}

function toFlowEdges(edges: WorkbenchWorkflowEdge[]): Edge[] {
  return edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    targetHandle: edge.targetHandle
  }))
}

// Inverse of toFlowNodes/toFlowEdges — used by both Save (persist to disk)
// and Run (in-memory only, see workflow-run-engine.ts) so the two always
// agree on what the current canvas state actually is.
function fromFlowNodes(nodes: WorkflowNode[]): WorkbenchWorkflowNode[] {
  return nodes.map(node => ({ config: node.data.config, id: node.id, name: node.data.name, position: node.position, type: node.data.kind }))
}

function fromFlowEdges(edges: Edge[]): WorkbenchWorkflowEdge[] {
  return edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    target: edge.target,
    ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {})
  }))
}

const RUN_STATUS_ICON: Record<RunWorkflowResult['status'], string> = {
  completed: 'check',
  halted_cycle: 'warning',
  halted_max_steps: 'warning',
  nothing_to_run: 'circle-slash',
  refused_unsupported_node: 'error'
}

const REMOTE_STATUS_ICON: Record<WorkflowRunResult['status'], string> = {
  completed: 'check',
  failed: 'error',
  halted: 'warning'
}

interface WorkflowEditorProps {
  initial: WorkbenchWorkflow
  onSaved: (result: UpdateWorkbenchWorkflowResult) => void
  workspaceRoot: string
}

// The canvas + toolbar for one open workflow. Local, view-only state (nodes/
// edges/title/dirty) — matches how requirement-panel.tsx/write-panel.tsx keep
// their loaded detail local rather than global. Save is the ONLY write this
// component performs, and it persists the graph exactly as-is: no node's
// `config` is read, evaluated, or acted on beyond being carried through.
function WorkflowEditor({ initial, onSaved, workspaceRoot }: WorkflowEditorProps) {
  const [title, setTitle] = useState(initial.title)
  const [nodes, setNodes] = useState<WorkflowNode[]>(() => toFlowNodes(initial.nodes))
  const [edges, setEdges] = useState<Edge[]>(() => toFlowEdges(initial.edges))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  // Run result — transient, view-local state only (requirement 3 of Slice
  // N): never persisted, cleared whenever a new run starts or the dialog is
  // closed. See handleRun/RunResultDialog below.
  const [runResult, setRunResult] = useState<null | RunWorkflowResult>(null)
  const [runDialogOpen, setRunDialogOpen] = useState(false)
  // Gateway-backed run (lib/workflow-run.ts) — SEPARATE from the pure preview
  // run above. `remoteBusy` gates the buttons; `remoteEvents` is the streamed
  // progress; `remoteResult` is the final run_graph result. Ephemeral, like the
  // preview: reset on each launch and dialog close.
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [remoteBusy, setRemoteBusy] = useState<'dry' | 'idle' | 'run'>('idle')
  const [remoteEvents, setRemoteEvents] = useState<WorkflowRunEvent[]>([])
  const [remoteResult, setRemoteResult] = useState<null | WorkflowRunResult>(null)
  const remoteUnsub = useRef<(() => void) | null>(null)

  useEffect(() => {
    setTitle(initial.title)
    setNodes(toFlowNodes(initial.nodes))
    setEdges(toFlowEdges(initial.edges))
    setDirty(false)
  }, [initial])

  // Drop any live run-event subscription if the editor unmounts mid-run.
  useEffect(() => () => remoteUnsub.current?.(), [])

  const onNodesChange = useCallback((changes: NodeChange<WorkflowNode>[]) => {
    setNodes(current => applyNodeChanges(changes, current))
    setDirty(true)
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges(current => applyEdgeChanges(changes, current))
    setDirty(true)
  }, [])

  const onConnect = useCallback((connection: Connection) => {
    setEdges(current => addEdge({ ...connection, id: newLocalId('edge') }, current))
    setDirty(true)
  }, [])

  const updateNodeConfig = useCallback((id: string, patch: Record<string, unknown>) => {
    setNodes(current =>
      current.map(node => (node.id === id ? { ...node, data: { ...node.data, config: { ...node.data.config, ...patch } } } : node))
    )
    setDirty(true)
  }, [])

  const addNode = useCallback(
    (kind: CreatableNodeKind) => {
      const id = newLocalId('node')
      const position = { x: 120 + (nodes.length % 4) * 60, y: 100 + Math.floor(nodes.length / 4) * 120 }

      setNodes(current => [...current, { data: { config: {}, kind, name: s.workflow.nodeNames[kind] }, id, position, type: kind }])
      setDirty(true)
    },
    [nodes.length]
  )

  const handleTitleChange = useCallback((value: string) => {
    setTitle(value)
    setDirty(true)
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)

    try {
      const res = await updateWorkflow({
        edges: fromFlowEdges(edges),
        nodes: fromFlowNodes(nodes),
        title: title.trim() || initial.title,
        workflowId: initial.id,
        workspaceRoot
      })

      if (res.ok) {
        setDirty(false)
        onSaved(res.value)
        notify({ kind: 'success', message: '', title: s.workflow.saved })
      } else {
        notify({ kind: 'error', message: res.message, title: s.workflow.saveFailed })
      }
    } catch (err) {
      notifyError(err, s.workflow.saveFailed)
    } finally {
      setSaving(false)
    }
  }, [edges, initial.id, initial.title, nodes, onSaved, title, workspaceRoot])

  // Runs the CURRENT in-editor graph (including unsaved changes — testing a
  // workflow does not require saving it first) through the pure, synchronous,
  // in-memory engine in workflow-run-engine.ts. No IPC call is made; nothing
  // here can touch disk, network, or a real project file. Any new run first
  // clears the previous result (requirement 3 — ephemeral only).
  const handleRun = useCallback(() => {
    setRunResult(null)

    try {
      const result = runWorkflow(fromFlowNodes(nodes), fromFlowEdges(edges))

      setRunResult(result)
      setRunDialogOpen(true)
    } catch (err) {
      notifyError(err, s.workflow.runFailed)
    }
  }, [edges, nodes])

  const closeRunDialog = useCallback(() => {
    setRunDialogOpen(false)
    // Cleared on close, not just on the next run — requirement 3.
    setRunResult(null)
  }, [])

  // Dry run through the gateway (workflow.dryRun): traces the WHOLE current
  // in-editor graph server-side with NO side effects and NO approvals (would-run
  // markers), translated to the engine graph shape first.
  const handleDryRun = useCallback(async () => {
    setRemoteBusy('dry')
    setRemoteEvents([])
    setRemoteResult(null)
    setRemoteOpen(true)

    try {
      const result = await dryRunWorkflowRemote(toEngineGraph(fromFlowNodes(nodes), fromFlowEdges(edges)), { workflowId: initial.id })

      setRemoteResult(result)
      setRemoteEvents(result.events)
    } catch (err) {
      notifyError(err, s.workflow.remoteRunFailed)
      setRemoteOpen(false)
    } finally {
      setRemoteBusy('idle')
    }
  }, [edges, initial.id, nodes])

  // Live run through the gateway (workflow.run): every node dispatched through
  // the WF0 guard. Nothing is pre-approved here, so side-effecting kinds fail
  // closed — the UI's 3 creatable kinds are all pure, so an authored graph runs
  // cleanly; a graph loaded with side-effecting kinds surfaces per-node denials
  // in the streamed progress. Requires an active session (the gateway routes run
  // events back on it).
  const handleLiveRun = useCallback(async () => {
    const sessionId = $activeSessionId.get()

    if (!sessionId) {
      notify({ kind: 'error', message: s.workflow.remoteNoSession, title: s.workflow.remoteRunFailed })

      return
    }

    setRemoteBusy('run')
    setRemoteEvents([])
    setRemoteResult(null)
    setRemoteOpen(true)

    remoteUnsub.current?.()
    remoteUnsub.current = onWorkflowRunEvent(sessionId, event => {
      setRemoteEvents(current => [...current, event])
    })

    try {
      const result = await runWorkflowRemote(toEngineGraph(fromFlowNodes(nodes), fromFlowEdges(edges)), { sessionId, workflowId: initial.id })

      setRemoteResult(result)
    } catch (err) {
      notifyError(err, s.workflow.remoteRunFailed)
    } finally {
      remoteUnsub.current?.()
      remoteUnsub.current = null
      setRemoteBusy('idle')
    }
  }, [edges, initial.id, nodes])

  const closeRemoteDialog = useCallback(() => {
    remoteUnsub.current?.()
    remoteUnsub.current = null
    setRemoteOpen(false)
    setRemoteEvents([])
    setRemoteResult(null)
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={s.workflow.titleLabel}
          className="max-w-sm font-medium"
          onChange={event => handleTitleChange(event.target.value)}
          value={title}
        />
        {dirty && <span className="text-[0.65rem] text-muted-foreground/60">{s.workflow.unsavedHint}</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button onClick={() => addNode('manual_trigger')} size="sm" variant="outline">
            <Codicon name="play" size="0.8125rem" />
            {s.workflow.addTrigger}
          </Button>
          <Button onClick={() => addNode('condition')} size="sm" variant="outline">
            <Codicon name="git-branch" size="0.8125rem" />
            {s.workflow.addCondition}
          </Button>
          <Button onClick={() => addNode('output')} size="sm" variant="outline">
            <Codicon name="symbol-event" size="0.8125rem" />
            {s.workflow.addOutput}
          </Button>
          <Button onClick={handleRun} size="sm" variant="outline">
            <Codicon name="debug-start" size="0.8125rem" />
            {s.workflow.run}
          </Button>
          <Button disabled={remoteBusy !== 'idle'} onClick={() => void handleDryRun()} size="sm" variant="outline">
            <Codicon name={remoteBusy === 'dry' ? 'loading' : 'debug-step-over'} size="0.8125rem" spinning={remoteBusy === 'dry'} />
            {s.workflow.dryRun}
          </Button>
          <Button disabled={remoteBusy !== 'idle'} onClick={() => void handleLiveRun()} size="sm" variant="outline">
            <Codicon name={remoteBusy === 'run' ? 'loading' : 'run-all'} size="0.8125rem" spinning={remoteBusy === 'run'} />
            {s.workflow.liveRun}
          </Button>
          <Button disabled={saving || !dirty} onClick={() => void handleSave()} size="sm">
            <Codicon name={saving ? 'loading' : 'save'} size="0.875rem" spinning={saving} />
            {saving ? s.workflow.saving : s.workflow.save}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-(--ui-stroke-tertiary)">
        <WorkflowNodeActionsContext.Provider value={{ updateNodeConfig }}>
          <ReactFlow
            edges={edges}
            fitView
            nodes={nodes}
            nodeTypes={NODE_TYPES}
            onConnect={onConnect}
            onEdgesChange={onEdgesChange}
            onNodesChange={onNodesChange}
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </WorkflowNodeActionsContext.Provider>
      </div>

      <RunResultDialog onClose={closeRunDialog} open={runDialogOpen} result={runResult} />
      <RemoteRunDialog busy={remoteBusy} events={remoteEvents} onClose={closeRemoteDialog} open={remoteOpen} result={remoteResult} />
    </div>
  )
}

// Gateway-run dialog — live progress (streamed `workflow.run.event` payloads)
// plus the final run_graph result/status. Transient React state like
// RunResultDialog: cleared on close. Distinct from the pure-preview dialog above
// (this one reflects a real, guard-dispatched server run).
function RemoteRunDialog({
  busy,
  events,
  onClose,
  open,
  result
}: {
  busy: 'dry' | 'idle' | 'run'
  events: WorkflowRunEvent[]
  onClose: () => void
  open: boolean
  result: null | WorkflowRunResult
}) {
  return (
    <Dialog onOpenChange={next => !next && onClose()} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{s.workflow.remoteRunHeading}</DialogTitle>
          <DialogDescription>
            {busy !== 'idle' ? (
              <span className="flex items-center gap-1.5">
                <Codicon name="loading" size="0.8125rem" spinning />
                {busy === 'dry' ? s.workflow.remoteDryRunning : s.workflow.remoteRunning}
              </span>
            ) : result ? (
              <span className="flex items-center gap-1.5">
                <Codicon name={REMOTE_STATUS_ICON[result.status]} size="0.8125rem" />
                {result.status}
                {result.error ? ` — ${result.error}` : ''}
              </span>
            ) : (
              s.workflow.remoteDryHint
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-96 gap-3 overflow-y-auto text-xs">
          <div>
            <div className="mb-1 font-medium text-foreground">{s.workflow.remoteEventsHeading}</div>
            {events.length === 0 ? (
              <p className="text-muted-foreground/60">{s.workflow.remoteEventsEmpty}</p>
            ) : (
              <ol className="grid gap-1">
                {events.map((event, index) => (
                  <li className="rounded border border-(--ui-stroke-tertiary) px-2 py-1" key={`${event.seq}-${index}`}>
                    <span className="font-medium text-foreground">{event.type.replace('workflow.run.', '')}</span>
                    {event.nodeId ? <span className="text-muted-foreground/60"> · {event.nodeId}</span> : null}
                    {event.kind ? <span className="text-muted-foreground/60"> ({event.kind})</span> : null}
                    {event.status ? <span className="text-muted-foreground/60"> — {event.status}</span> : null}
                    {event.reason ? <span className="text-muted-foreground/60"> — {event.reason}</span> : null}
                    {event.error ? <span className="text-muted-foreground/60"> — {event.error}</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button onClick={onClose} variant="outline">
            {s.cancel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Ephemeral run-log dialog — requirement 3 of Slice N: shows what the run did
// (path taken, per-Output received value, completed vs halted) as transient
// React state only. Nothing here is written to disk; closing the dialog (or
// starting a new run) clears the underlying result in WorkflowEditor.
function RunResultDialog({ onClose, open, result }: { onClose: () => void; open: boolean; result: null | RunWorkflowResult }) {
  return (
    <Dialog onOpenChange={next => !next && onClose()} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{s.workflow.runResultHeading}</DialogTitle>
          <DialogDescription>
            {result ? (
              <span className="flex items-center gap-1.5">
                <Codicon name={RUN_STATUS_ICON[result.status]} size="0.8125rem" />
                {s.workflow.runStatusNames[result.status]}
                {' — '}
                {result.message}
              </span>
            ) : (
              s.workflow.runResultEmpty
            )}
          </DialogDescription>
        </DialogHeader>

        {result && (
          <div className="grid max-h-96 gap-3 overflow-y-auto text-xs">
            <div>
              <div className="mb-1 font-medium text-foreground">{s.workflow.runStepsHeading}</div>
              {result.steps.length === 0 ? (
                <p className="text-muted-foreground/60">{s.workflow.runStepsEmpty}</p>
              ) : (
                <ol className="grid gap-1">
                  {result.steps.map((step, index) => (
                    <li className="rounded border border-(--ui-stroke-tertiary) px-2 py-1" key={`${step.nodeId}-${index}`}>
                      <span className="font-medium text-foreground">{step.name}</span>
                      <span className="text-muted-foreground/60"> ({step.kind}) — {step.detail}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div>
              <div className="mb-1 font-medium text-foreground">{s.workflow.runOutputsHeading}</div>
              {result.outputs.length === 0 ? (
                <p className="text-muted-foreground/60">{s.workflow.runOutputsEmpty}</p>
              ) : (
                <ul className="grid gap-1">
                  {result.outputs.map(output => (
                    <li className="rounded border border-(--ui-stroke-tertiary) px-2 py-1" key={output.nodeId}>
                      <span className="font-medium text-foreground">{output.name}</span>
                      <span className="text-muted-foreground/60"> — {output.receivedValue}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button onClick={onClose} variant="outline">
            {s.cancel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface WorkflowPanelProps {
  workspaceRoot: string
}

export function WorkflowPanel({ workspaceRoot }: WorkflowPanelProps) {
  const workflows = useStore($workbenchWorkflows)
  const activeId = useStore($workbenchActiveWorkflowId)
  const listLoading = useStore($workbenchWorkflowsLoading)
  const listError = useStore($workbenchWorkflowsError)

  const [detail, setDetail] = useState<null | WorkbenchWorkflow>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [createTitle, setCreateTitle] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setWorkbenchWorkflowsLoading(true)
    setWorkbenchWorkflowsError(null)

    try {
      const res = await listWorkflows(workspaceRoot)

      if (res.ok) {
        setWorkbenchWorkflows(res.value)
      } else {
        setWorkbenchWorkflowsError(res.message)
        notify({ kind: 'error', message: res.message, title: s.workflow.loadFailed })
      }
    } catch (err) {
      notifyError(err, s.workflow.loadFailed)
    } finally {
      setWorkbenchWorkflowsLoading(false)
    }
  }, [workspaceRoot])

  useEffect(() => {
    setDetail(null)
    void load()
  }, [load])

  const openWorkflow = useCallback(
    async (workflowId: string) => {
      setWorkbenchActiveWorkflowId(workflowId)
      setDetailLoading(true)
      setDetail(null)

      try {
        const res = await readWorkflow(workspaceRoot, workflowId)

        if (res.ok) {
          setDetail(res.value)
        } else {
          notify({ kind: 'error', message: res.message, title: s.workflow.openFailed })
        }
      } catch (err) {
        notifyError(err, s.workflow.openFailed)
      } finally {
        setDetailLoading(false)
      }
    },
    [workspaceRoot]
  )

  const handleCreate = useCallback(async () => {
    const title = createTitle.trim()

    if (!title) {
      notify({ kind: 'error', message: s.workflow.titleLabel, title: s.workflow.createFailed })

      return
    }

    setCreating(true)

    try {
      const res = await createWorkflow({ title, workspaceRoot })

      if (res.ok) {
        const { workflow } = res.value

        upsertWorkbenchWorkflowManifestEntry({
          id: workflow.id,
          relativePath: `${HERMES_WORKFLOWS_DIR}/${workflow.id}.json`,
          title: workflow.title,
          updatedAt: workflow.updatedAt
        })
        setWorkbenchActiveWorkflowId(workflow.id)
        setDetail(workflow)
        notify({ kind: 'success', message: '', title: s.workflow.createdTitle(title) })
        setCreateOpen(false)
        setCreateTitle('')
        void load()
      } else {
        notify({ kind: 'error', message: res.message, title: s.workflow.createFailed })
      }
    } catch (err) {
      notifyError(err, s.workflow.createFailed)
    } finally {
      setCreating(false)
    }
  }, [createTitle, load, workspaceRoot])

  const handleSaved = useCallback((result: UpdateWorkbenchWorkflowResult) => {
    patchWorkbenchWorkflowManifestEntry(result.id, { title: result.title, updatedAt: result.updatedAt })
    setDetail(current => (current ? { ...current, enabled: result.enabled, title: result.title, updatedAt: result.updatedAt } : current))
  }, [])

  return (
    <>
      <MasterDetail>
        <ListColumn
          header={
            <div className="mb-1 flex h-6 shrink-0 items-center justify-between gap-2 pl-2 pr-1">
              <span className="text-[0.68rem] font-medium uppercase tracking-wide text-muted-foreground/60">{s.workflow.heading}</span>
              <Button
                aria-label={s.workflow.newWorkflow}
                className="size-5 text-muted-foreground/70 hover:bg-(--ui-control-active-background) hover:text-foreground"
                onClick={() => setCreateOpen(true)}
                size="icon"
                title={s.workflow.newWorkflow}
                variant="ghost"
              >
                <Codicon name="add" size="0.8125rem" />
              </Button>
            </div>
          }
        >
          {listLoading && workflows.length === 0 ? (
            <PageLoader label={s.workflow.loading} />
          ) : listError && workflows.length === 0 ? (
            <PanelEmpty description={listError} icon="error" title={s.workflow.loadFailed} />
          ) : workflows.length === 0 ? (
            <PanelEmpty
              action={
                <Button onClick={() => setCreateOpen(true)} size="sm" variant="outline">
                  {s.workflow.newWorkflow}
                </Button>
              }
              description={s.workflow.emptyDesc}
              icon="inbox"
              title={s.workflow.emptyTitle}
            />
          ) : (
            workflows.map(entry => (
              <PanelListRow
                active={entry.id === activeId}
                key={entry.id}
                meta={new Date(entry.updatedAt).toLocaleDateString()}
                onSelect={() => void openWorkflow(entry.id)}
                rowKey={entry.id}
                title={entry.title}
              />
            ))
          )}
        </ListColumn>

        <main className="flex min-h-0 flex-col overflow-hidden">
          {detailLoading ? (
            <PageLoader label={s.workflow.loading} />
          ) : !detail ? (
            <div className="flex flex-1 items-center justify-center">
              <PanelEmpty description={s.workflow.selectPrompt} icon="type-hierarchy" title={s.workflow.heading} />
            </div>
          ) : (
            <ReactFlowProvider>
              <WorkflowEditor initial={detail} onSaved={handleSaved} workspaceRoot={workspaceRoot} />
            </ReactFlowProvider>
          )}
        </main>
      </MasterDetail>

      <CreateWorkflowDialog
        creating={creating}
        onClose={() => setCreateOpen(false)}
        onCreate={() => void handleCreate()}
        onTitleChange={setCreateTitle}
        open={createOpen}
        title={createTitle}
      />
    </>
  )
}

function CreateWorkflowDialog({
  creating,
  onClose,
  onCreate,
  onTitleChange,
  open,
  title
}: {
  creating: boolean
  onClose: () => void
  onCreate: () => void
  onTitleChange: (value: string) => void
  open: boolean
  title: string
}) {
  return (
    <Dialog onOpenChange={next => !creating && !next && onClose()} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{s.workflow.createTitle}</DialogTitle>
          <DialogDescription>{s.workflow.createDialogDesc}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <label className="grid gap-1 text-xs font-medium text-foreground">
            {s.workflow.titleLabel}
            <Input
              autoFocus
              disabled={creating}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => onTitleChange(event.target.value)}
              placeholder={s.workflow.titlePlaceholder}
              value={title}
            />
          </label>
        </div>

        <DialogFooter>
          <Button disabled={creating} onClick={onClose} variant="outline">
            {s.cancel}
          </Button>
          <Button disabled={creating || !title.trim()} onClick={onCreate} variant="default">
            {creating ? s.workflow.creating : s.workflow.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
