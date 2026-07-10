import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the session store so the POST logic can be tested without loading the
// heavy real store or a live gateway. `$connection.get()` is the only thing
// design-kanban.ts reads from it.
const connectionRef: { current: { baseUrl: string; token: string } | null } = { current: null }

vi.mock('@/store/session', () => ({
  $connection: {
    get: () => connectionRef.current
  }
}))

import {
  DESIGN_KANBAN_ASSIGNEE,
  getKanbanCard,
  isTerminalKanbanStatus,
  kanbanStatusBadgeVariant,
  sendDesignToKanban
} from './design-kanban'

describe('sendDesignToKanban', () => {
  const baseArgs = {
    workspaceRoot: '/home/user/project',
    requirementId: 'req-42',
    content: '# Brief\n\nBuild it.'
  } as const

  beforeEach(() => {
    connectionRef.current = { baseUrl: 'http://127.0.0.1:9120', token: 'tok-abc' }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    connectionRef.current = null
  })

  it('POSTs the full card payload (assignee + dir workspace scoping) for a brief and returns the new card id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task: { id: 'card-7' } })
    })

    vi.stubGlobal('fetch', fetchMock)

    const id = await sendDesignToKanban({ ...baseArgs, kind: 'brief' })

    expect(id).toBe('card-7')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:9120/api/plugins/kanban/tasks')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.headers.Authorization).toBe('Bearer tok-abc')

    const payload = JSON.parse(init.body)
    expect(payload.title).toBe('Implement design (brief): req-42')
    // Body now leads with the human-readable origin breadcrumb, then the
    // "Implement this design…" instruction + content.
    expect(payload.body).toMatch(/^Origin: Workbench requirement "req-42" \(req-42\)/)
    expect(payload.body).toContain('Implement the following design as real code in this project.')
    expect(payload.assignee).toBe(DESIGN_KANBAN_ASSIGNEE)
    expect(DESIGN_KANBAN_ASSIGNEE).toBe('fable-orchestrator')
    expect(payload.workspace_kind).toBe('dir')
    expect(payload.workspace_path).toBe('/home/user/project')
  })

  it('scopes a prototype card the same way and fences the html body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task: { id: 'card-8' } })
    })

    vi.stubGlobal('fetch', fetchMock)

    await sendDesignToKanban({ ...baseArgs, kind: 'prototype', content: '<!doctype html><body>Hi</body>' })

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(payload.title).toBe('Implement design (prototype): req-42')
    expect(payload.body).toContain('```html\n<!doctype html><body>Hi</body>\n```')
    expect(payload.assignee).toBe('fable-orchestrator')
    expect(payload.workspace_kind).toBe('dir')
    expect(payload.workspace_path).toBe('/home/user/project')
  })

  it('fails closed with no card when the gateway is not connected', async () => {
    connectionRef.current = null
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(sendDesignToKanban({ ...baseArgs, kind: 'brief' })).rejects.toThrow(/not connected/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws a clear error on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad board'
    })

    vi.stubGlobal('fetch', fetchMock)

    await expect(sendDesignToKanban({ ...baseArgs, kind: 'brief' })).rejects.toThrow(/HTTP 400.*bad board/)
  })

  it('wraps a network failure in a clear error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(sendDesignToKanban({ ...baseArgs, kind: 'brief' })).rejects.toThrow(/Could not reach the Hermes gateway/)
  })

  it('throws (never returns an empty id) on a 2xx response with no task.id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task: {} })
    })

    vi.stubGlobal('fetch', fetchMock)

    // A 2xx-but-unparseable body must be treated as an error, not '' — a blank
    // backlink and a false "success" are the bug being fixed here.
    await expect(sendDesignToKanban({ ...baseArgs, kind: 'brief' })).rejects.toThrow(/no card id/i)
  })

  it('throws when the response body is entirely unparseable (null)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('not json')
      }
    })

    vi.stubGlobal('fetch', fetchMock)

    await expect(sendDesignToKanban({ ...baseArgs, kind: 'brief' })).rejects.toThrow(/no card id/i)
  })
})

describe('isTerminalKanbanStatus', () => {
  it('treats only done + archived as terminal', () => {
    expect(isTerminalKanbanStatus('done')).toBe(true)
    expect(isTerminalKanbanStatus('archived')).toBe(true)
  })

  it('treats every in-flight status (incl. blocked + review) as non-terminal', () => {
    for (const status of ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review']) {
      expect(isTerminalKanbanStatus(status)).toBe(false)
    }
  })

  it('treats an unknown/future status as non-terminal (keep watching)', () => {
    expect(isTerminalKanbanStatus('some_new_state')).toBe(false)
  })
})

describe('kanbanStatusBadgeVariant', () => {
  it('maps each known status onto its badge variant', () => {
    expect(kanbanStatusBadgeVariant('done')).toBe('default')
    expect(kanbanStatusBadgeVariant('blocked')).toBe('destructive')
    expect(kanbanStatusBadgeVariant('running')).toBe('warn')
    expect(kanbanStatusBadgeVariant('review')).toBe('warn')
    expect(kanbanStatusBadgeVariant('archived')).toBe('muted')
    expect(kanbanStatusBadgeVariant('todo')).toBe('outline')
    expect(kanbanStatusBadgeVariant('triage')).toBe('outline')
    expect(kanbanStatusBadgeVariant('scheduled')).toBe('outline')
    expect(kanbanStatusBadgeVariant('ready')).toBe('outline')
  })

  it('degrades an unknown status to a neutral outline (never throws)', () => {
    expect(kanbanStatusBadgeVariant('wat')).toBe('outline')
  })
})

describe('getKanbanCard', () => {
  beforeEach(() => {
    connectionRef.current = { baseUrl: 'http://127.0.0.1:9120', token: 'tok-abc' }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    connectionRef.current = null
  })

  it('reads status/title/assignee from the { task } envelope and issues a bearer GET', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        task: { id: 'card-7', status: 'running', title: 'Implement design (brief): req-42', assignee: 'fable-orchestrator' },
        comments: [],
        events: []
      })
    })

    vi.stubGlobal('fetch', fetchMock)

    const card = await getKanbanCard('card-7')

    expect(card).toEqual({
      id: 'card-7',
      status: 'running',
      title: 'Implement design (brief): req-42',
      assignee: 'fable-orchestrator'
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:9120/api/plugins/kanban/tasks/card-7')
    expect(init.method).toBe('GET')
    expect(init.headers.Authorization).toBe('Bearer tok-abc')
  })

  it('url-encodes the card id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task: { id: 'a/b c', status: 'todo' } })
    })

    vi.stubGlobal('fetch', fetchMock)

    await getKanbanCard('a/b c')

    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:9120/api/plugins/kanban/tasks/a%2Fb%20c')
  })

  it('returns null (no throw) when the gateway is not connected', async () => {
    connectionRef.current = null
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(getKanbanCard('card-7')).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null (no throw) on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    await expect(getKanbanCard('card-7')).resolves.toBeNull()
  })

  it('returns null (no throw) on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))

    await expect(getKanbanCard('card-7')).resolves.toBeNull()
  })

  it('returns null when the body is unparseable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error('not json')
        }
      })
    )

    await expect(getKanbanCard('card-7')).resolves.toBeNull()
  })

  it('returns null when the envelope has no task or no usable status', async () => {
    const bodies = [{}, { task: null }, { task: {} }, { task: { id: 'card-7' } }, { task: { status: 42 } }]

    for (const body of bodies) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }))
       
      await expect(getKanbanCard('card-7')).resolves.toBeNull()
    }
  })

  it('falls back to the requested id and omits blank optional fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ task: { status: 'ready', title: '   ', assignee: '' } })
      })
    )

    await expect(getKanbanCard('card-9')).resolves.toEqual({ id: 'card-9', status: 'ready' })
  })
})
