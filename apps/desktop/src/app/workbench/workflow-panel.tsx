/**
 * Workflow Designer panel — Slice M (go-forward plan §5). AUTHORING ONLY.
 *
 * A WorkbenchWorkflow is a graph (nodes + edges) that is created, saved,
 * loaded, and edited — and NEVER RUN. There is no "Run" button, no execution
 * engine, and no interpreter for any node's `config` anywhere in this file.
 * The canvas is `@xyflow/react` (React Flow), the sourced dependency choice
 * documented in 00-go-forward-plan.md (Kun's own confirmed `^12.11.0`).
 *
 * The node palette offers exactly 3 creatable kinds: Trigger (`manual_trigger`,
 * an inert authoring placeholder — it represents "this is where a run would
 * start" and does nothing when clicked beyond normal graph editing),
 * Condition, and Output. `WorkbenchWorkflowNodeKind` has 12 declared kinds in
 * `@hermes/shared` — this UI intentionally exposes only 3 of them; the other
 * 9 (`ai_agent`, `code`, `http_request`, `webhook_trigger`,
 * `schedule_trigger`, `human_approval`, `delay`, `loop`, `subworkflow`) are
 * NOT offered here, even as disabled stubs. The backend validator stays
 * permissive of all 12 kinds (see apps/shared/src/workbench/validators.ts) —
 * this is a UI-only restriction.
 *
 * Node/edge drag, connect, and delete all go through React Flow's own
 * `onNodesChange`/`onEdgesChange`/`onConnect` handlers plus `applyNodeChanges`/
 * `applyEdgeChanges`/`addEdge` — no hand-rolled graph math. A Condition node's
 * expression text is stored in `config.expression` and a display-only
 * placeholder is shown for `config.label` on an Output node; neither is ever
 * evaluated by any code in this file.
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
import { createContext, useCallback, useContext, useEffect, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { notify, notifyError } from '@/store/notifications'

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

function ConditionNode({ data, id }: NodeProps<WorkflowNode>) {
  const { updateNodeConfig } = useContext(WorkflowNodeActionsContext)
  const expression = typeof data.config.expression === 'string' ? data.config.expression : ''

  return (
    <div className="min-w-40 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) px-3 py-2 text-xs shadow-sm">
      <Handle position={Position.Left} type="target" />
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        <Codicon name="git-branch" size="0.75rem" />
        {data.name}
      </div>
      <label className="mt-1.5 block text-[0.62rem] text-muted-foreground/60">
        {s.workflow.conditionExpressionLabel}
        <input
          className="nodrag mt-0.5 w-full rounded border border-(--ui-stroke-tertiary) bg-transparent px-1.5 py-1 text-[0.68rem] text-foreground outline-none"
          onChange={event => updateNodeConfig(id, { expression: event.target.value })}
          placeholder={s.workflow.conditionExpressionPlaceholder}
          value={expression}
        />
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

  useEffect(() => {
    setTitle(initial.title)
    setNodes(toFlowNodes(initial.nodes))
    setEdges(toFlowEdges(initial.edges))
    setDirty(false)
  }, [initial])

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
      const nodesForSave: WorkbenchWorkflowNode[] = nodes.map(node => ({
        config: node.data.config,
        id: node.id,
        name: node.data.name,
        position: node.position,
        type: node.data.kind
      }))

      const edgesForSave: WorkbenchWorkflowEdge[] = edges.map(edge => ({
        id: edge.id,
        source: edge.source,
        ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
        target: edge.target,
        ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {})
      }))

      const res = await updateWorkflow({
        edges: edgesForSave,
        nodes: nodesForSave,
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
    </div>
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
