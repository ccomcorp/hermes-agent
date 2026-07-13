import type { WorkbenchWorkflowEdge, WorkbenchWorkflowNode } from '@hermes/shared'
import { describe, expect, it } from 'vitest'

import { toEngineGraph } from './workflow-run'

function node(partial: Partial<WorkbenchWorkflowNode> & Pick<WorkbenchWorkflowNode, 'id' | 'type'>): WorkbenchWorkflowNode {
  return { config: {}, name: partial.type, position: { x: 0, y: 0 }, ...partial }
}

describe('toEngineGraph', () => {
  it('maps node.type -> engine kind, hyphenating underscores', () => {
    // The authoring shape uses `type` with underscore kinds; the Python engine
    // indexes on `kind` with hyphenated kinds (workflow_runtime.py:_index +
    // workflow_guard.py PURE_KINDS/_APPROVAL_KINDS). A mismatch means the engine
    // silently treats the node as an unknown kind and DENIES it.
    const graph = toEngineGraph(
      [node({ id: 'a', type: 'manual_trigger' }), node({ id: 'b', type: 'ai_agent' }), node({ id: 'c', type: 'http_request' })],
      []
    )

    expect(graph.nodes.map(n => n.kind)).toEqual(['manual-trigger', 'ai-agent', 'http-request'])
  })

  it('carries node id and config through verbatim', () => {
    const graph = toEngineGraph([node({ config: { prompt: 'hi' }, id: 'x', type: 'ai_agent' })], [])

    expect(graph.nodes[0]).toEqual({ config: { prompt: 'hi' }, id: 'x', kind: 'ai-agent' })
  })

  it('maps edge source/target -> from/to and omits label when no handle', () => {
    const edges: WorkbenchWorkflowEdge[] = [{ id: 'e1', source: 'a', target: 'b' }]

    expect(toEngineGraph([], edges).edges).toEqual([{ from: 'a', to: 'b' }])
  })

  it('promotes a React Flow sourceHandle to the engine edge label', () => {
    // A condition true/false branch (or any labelled handle) must reach the
    // engine as `label`, which is how it routes conditional edges.
    const edges: WorkbenchWorkflowEdge[] = [{ id: 'e1', source: 'a', sourceHandle: 'true', target: 'b' }]

    expect(toEngineGraph([], edges).edges).toEqual([{ from: 'a', label: 'true', to: 'b' }])
  })

  it('drops disabled nodes', () => {
    const graph = toEngineGraph([node({ disabled: true, id: 'off', type: 'output' }), node({ id: 'on', type: 'output' })], [])

    expect(graph.nodes.map(n => n.id)).toEqual(['on'])
  })

  it('every declared node kind hyphenates to a kind the WF0 guard recognises', () => {
    // Completeness lock: if a future kind is added whose hyphenated form is not a
    // guard-recognised kind, a live run would DENY it as unknown. These are the
    // 12 WorkbenchWorkflowNodeKind values (@hermes/shared) mapped to the guard's
    // PURE_KINDS / _APPROVAL_KINDS / narrowly-gated http-request|code.
    const allKinds: WorkbenchWorkflowNode['type'][] = [
      'manual_trigger', 'schedule_trigger', 'webhook_trigger', 'ai_agent', 'human_approval',
      'condition', 'http_request', 'code', 'delay', 'loop', 'subworkflow', 'output'
    ]

    const guardRecognised = new Set([
      // PURE_KINDS (subset relevant here)
      'manual-trigger', 'condition', 'loop', 'output',
      // _APPROVAL_KINDS
      'ai-agent', 'subworkflow', 'schedule-trigger', 'webhook-trigger', 'human-approval', 'delay',
      // narrowly gated
      'http-request', 'code'
    ])

    const graph = toEngineGraph(allKinds.map((type, i) => node({ id: `n${i}`, type })), [])

    for (const n of graph.nodes) {
      expect(guardRecognised.has(n.kind), `unmapped kind: ${n.kind}`).toBe(true)
    }
  })
})
