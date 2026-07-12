import type { WorkbenchWorkflowEdge, WorkbenchWorkflowNode } from '@hermes/shared'
import { describe, expect, it } from 'vitest'

import { evaluateCondition, runWorkflow } from './workflow-run-engine'

function trigger(id: string, name = 'Start'): WorkbenchWorkflowNode {
  return { config: {}, id, name, position: { x: 0, y: 0 }, type: 'manual_trigger' }
}

function condition(id: string, config: Record<string, unknown>, name = 'Check'): WorkbenchWorkflowNode {
  return { config, id, name, position: { x: 0, y: 0 }, type: 'condition' }
}

function output(id: string, name = 'Result'): WorkbenchWorkflowNode {
  return { config: {}, id, name, position: { x: 0, y: 0 }, type: 'output' }
}

function edge(id: string, source: string, target: string): WorkbenchWorkflowEdge {
  return { id, source, target }
}

describe('evaluateCondition', () => {
  it('evaluates equals', () => {
    expect(evaluateCondition({ leftExpr: 'approved', operator: 'equals', rightValue: 'approved' }).result).toBe(true)
    expect(evaluateCondition({ leftExpr: 'approved', operator: 'equals', rightValue: 'denied' }).result).toBe(false)
  })

  it('evaluates greater_than numerically', () => {
    expect(evaluateCondition({ leftExpr: '10', operator: 'greater_than', rightValue: '5' }).result).toBe(true)
    expect(evaluateCondition({ leftExpr: '3', operator: 'greater_than', rightValue: '5' }).result).toBe(false)
  })

  it('treats a missing/legacy config (old Slice M config.expression shape) as not configured, never as code', () => {
    const evaluation = evaluateCondition({ expression: 'status == "approved"' })

    expect(evaluation.configured).toBe(false)
    expect(evaluation.result).toBe(false)
  })
})

describe('runWorkflow', () => {
  it('completes a normal graph and reaches Output with the expected value', () => {
    const nodes = [trigger('t1'), condition('c1', { leftExpr: 'approved', operator: 'equals', rightValue: 'approved' }), output('o1', 'Final')]
    const edges = [edge('e1', 't1', 'c1'), edge('e2', 'c1', 'o1')]

    const result = runWorkflow(nodes, edges)

    expect(result.status).toBe('completed')
    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0]).toMatchObject({ name: 'Final', nodeId: 'o1' })
    expect(result.outputs[0].receivedValue).toContain('Final')
  })

  it('halts on a manually-wired cycle instead of hanging, bounded by the step cap', () => {
    // c1 -> c2 -> c1 is a back-edge React Flow's UI does not prevent wiring
    // (both conditions have an ordinary source handle) — the engine must
    // detect it and stop rather than recursing forever.
    const nodes = [
      trigger('t1'),
      condition('c1', { leftExpr: 'x', operator: 'equals', rightValue: 'x' }),
      condition('c2', { leftExpr: 'x', operator: 'equals', rightValue: 'x' })
    ]

    const edges = [edge('e1', 't1', 'c1'), edge('e2', 'c1', 'c2'), edge('e3', 'c2', 'c1')]

    const result = runWorkflow(nodes, edges, { maxSteps: 5 })

    expect(result.status).toBe('halted_cycle')
    expect(result.message).toMatch(/cycle/i)
  })

  it('halts on max steps for a long chain that never reaches a natural end', () => {
    // A chain of conditions with no cycle, but longer than the configured cap.
    const nodes: WorkbenchWorkflowNode[] = [trigger('t1')]
    const edges: WorkbenchWorkflowEdge[] = []

    for (let i = 0; i < 20; i += 1) {
      nodes.push(condition(`c${i}`, { leftExpr: 'x', operator: 'equals', rightValue: 'x' }))
      edges.push(edge(`e${i}`, i === 0 ? 't1' : `c${i - 1}`, `c${i}`))
    }

    const result = runWorkflow(nodes, edges, { maxSteps: 5 })

    expect(result.status).toBe('halted_max_steps')
    expect(result.message).toMatch(/max steps/i)
  })

  it('reports nothing_to_run when there is no trigger node', () => {
    const result = runWorkflow([condition('c1', {}), output('o1')], [edge('e1', 'c1', 'o1')])

    expect(result.status).toBe('nothing_to_run')
  })

  it('refuses to run a workflow containing an unsupported node kind', () => {
    const nodes: WorkbenchWorkflowNode[] = [
      trigger('t1'),
      { config: {}, id: 'a1', name: 'Agent', position: { x: 0, y: 0 }, type: 'ai_agent' }
    ]

    const result = runWorkflow(nodes, [edge('e1', 't1', 'a1')])

    expect(result.status).toBe('refused_unsupported_node')
    expect(result.steps).toHaveLength(0)
  })

  it('takes no path when a condition evaluates false', () => {
    const nodes = [trigger('t1'), condition('c1', { leftExpr: 'a', operator: 'equals', rightValue: 'b' }), output('o1')]
    const edges = [edge('e1', 't1', 'c1'), edge('e2', 'c1', 'o1')]

    const result = runWorkflow(nodes, edges)

    expect(result.status).toBe('completed')
    expect(result.outputs).toHaveLength(0)
  })
})
