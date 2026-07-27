import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
// @vitest-environment jsdom
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import type { DoxProjectStatus, DoxReport } from '@/types/hermes.ts'

// ── Mocks ─────────────────────────────────────────────────────────────────

const getDoxStatus = vi.fn()
const runDoxCheck = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getDoxStatus: (...args: unknown[]) => getDoxStatus(...args),
  runDoxCheck: (...args: unknown[]) => runDoxCheck(...args)
}))

const mockCwdAtom = atom('/test-project')
vi.mock('@/store/session', async importOriginal => {
  const actual = await importOriginal<typeof import('@/store/session')>()

  return {
    ...actual,
    $currentCwd: mockCwdAtom
  }
})

const mockScopeAtom = atom<string>('__all_projects__')
const mockProjects = atom<Array<{ id: string; name: string; primary_path?: string; folders?: unknown[] }>>([])
const mockProjectTree = atom<Array<{ id: string; path?: string; repos: Array<{ path?: string }> }>>([])
vi.mock('@/store/projects', async importOriginal => {
  const actual = await importOriginal<typeof import('@/store/projects')>()

  return {
    ...actual,
    $projectScope: mockScopeAtom,
    $projects: mockProjects,
    $projectTree: mockProjectTree
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────

function activeStatus(overrides: Partial<DoxProjectStatus> = {}): DoxProjectStatus {
  return {
    active: true,
    mode: 'code',
    layers: { contract: true, ledger: false, publish: true },
    markers: {
      docops_yml: true,
      agents_md_header: true,
      structural: ['src/**/*.py']
    },
    drift: [],
    pending_advisories: 2,
    last_publish: { pack: 'v1.0.0', at: '2026-07-15T10:00:00Z' },
    ...overrides
  }
}

async function renderDocOps(client?: QueryClient) {
  const { DocOpsView } = await import('./index')
  const onClose = vi.fn()

  return {
    onClose,
    ...render(
      <QueryClientProvider client={client ?? new QueryClient()}>
        <DocOpsView onClose={onClose} />
      </QueryClientProvider>
    )
  }
}

// ── Setup / teardown ──────────────────────────────────────────────────────

beforeEach(() => {
  getDoxStatus.mockResolvedValue(activeStatus())
  mockCwdAtom.set('/test-project')
  mockScopeAtom.set('__all_projects__')
  mockProjects.set([])
  mockProjectTree.set([])

  // jsdom does not implement scrollIntoView; Radix Select calls it when the
  // listbox opens. Stub it so picker-interaction tests don't throw.
  if (!(Element.prototype as { scrollIntoView?: unknown }).scrollIntoView) {
    ;

(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  }

  // Radix also probes pointer-capture APIs jsdom lacks.
  if (!(Element.prototype as { hasPointerCapture?: unknown }).hasPointerCapture) {
    ;(Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () => false
  }

  if (!(Element.prototype as { setPointerCapture?: unknown }).setPointerCapture) {
    ;

(Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {}
  }

  if (!(Element.prototype as { releasePointerCapture?: unknown }).releasePointerCapture) {
    ;

(Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {}
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────────────

describe('DocOpsView', () => {
  it('hosts content in OverlayView/Panel chrome (not a full-window surface)', async () => {
    await renderDocOps()

    await waitFor(() => {
      expect(screen.getByText('DocOps')).toBeDefined()
    })

    // OverlayView paints a fixed inset host; Panel wires onClose into it.
    expect(screen.getByRole('button', { name: 'Close DocOps' })).toBeDefined()
  })

  it('renders the project path in the header subtitle', async () => {
    await renderDocOps()

    await waitFor(() => {
      expect(screen.getByText(/test-project/)).toBeDefined()
    })
  })

  it('shows the mode badge (Code)', async () => {
    await renderDocOps()

    await waitFor(() => {
      const badges = screen.getAllByText('Code')
      expect(badges.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('shows layer status', async () => {
    await renderDocOps()

    await waitFor(() => {
      expect(screen.getByText(/Contract/)).toBeDefined()
      expect(screen.getByText(/Ledger/)).toBeDefined()
      expect(screen.getByText(/Publish/)).toBeDefined()
    })
  })

  it('shows marker status', async () => {
    await renderDocOps()

    await waitFor(() => {
      expect(screen.getByText('docops.yml')).toBeDefined()
      expect(screen.getByText('AGENTS.md')).toBeDefined()
      expect(screen.getByText('src/**/*.py')).toBeDefined()
    })
  })

  it('shows the advisory count', async () => {
    await renderDocOps()

    await waitFor(() => {
      expect(screen.getByText('2')).toBeDefined()
      expect(screen.getByText('pending')).toBeDefined()
    })
  })

  it('shows last publish info', async () => {
    await renderDocOps()

    await waitFor(() => {
      expect(screen.getByText('v1.0.0')).toBeDefined()
    })
  })

  it('shows "hybrid" mode correctly', async () => {
    getDoxStatus.mockResolvedValue(activeStatus({ mode: 'hybrid' }))
    await renderDocOps()

    await waitFor(() => {
      const badges = screen.getAllByText('Hybrid')
      expect(badges.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('shows inactive view when project is not configured', async () => {
    getDoxStatus.mockResolvedValue(activeStatus({ active: false, mode: null }))
    await renderDocOps()

    await waitFor(() => {
      expect(screen.getByText('DocOps not configured')).toBeDefined()
      expect(screen.getByText(/docops\.yml/)).toBeDefined()
    })

    // Still dismissible via Panel chrome when inactive
    expect(screen.getByRole('button', { name: 'Close DocOps' })).toBeDefined()
  })

  it('shows empty project state with Panel chrome', async () => {
    mockCwdAtom.set('')
    await renderDocOps()

    await waitFor(() => {
      // Title (PanelEmpty) + subtitle (PanelHeader) both carry this copy.
      expect(screen.getAllByText('No project selected').length).toBeGreaterThanOrEqual(1)
    })
    expect(screen.getByRole('button', { name: 'Close DocOps' })).toBeDefined()
    expect(screen.getByText(/Open a working directory/)).toBeDefined()
  })

  it('shows drift items when present', async () => {
    getDoxStatus.mockResolvedValue(
      activeStatus({
        drift: [
          { tier: 'B', path: 'docs/foo.md', kind: 'missing-index' },
          { tier: 'A', path: 'docs/bar.md', kind: 'stale-reference' }
        ]
      })
    )
    await renderDocOps()

    await waitFor(() => {
      expect(screen.getByText(/docs\/foo\.md/)).toBeDefined()
      expect(screen.getByText(/docs\/bar\.md/)).toBeDefined()
    })
  })

  it('shows an all-clear drift message when no drift', async () => {
    getDoxStatus.mockResolvedValue(activeStatus({ drift: [] }))
    await renderDocOps()

    await waitFor(() => {
      expect(screen.getByText(/documentation is in sync/i)).toBeDefined()
    })
  })

  // ── Run Check action ──────────────────────────────────────────────────

  it('shows a "Run Check" control', async () => {
    await renderDocOps()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run DocOps check' })).toBeDefined()
    })
  })

  it('calls runDoxCheck when "Run Check" is clicked', async () => {
    runDoxCheck.mockResolvedValue({
      status: {} as DoxReport['status'],
      drift: [],
      exit_code: 0
    })
    await renderDocOps()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run DocOps check' })).toBeDefined()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Run DocOps check' }))

    await waitFor(() => {
      expect(runDoxCheck).toHaveBeenCalledWith('/test-project')
    })
  })

  it('invalidates the dox status query on successful check', async () => {
    runDoxCheck.mockResolvedValue({
      status: {} as DoxReport['status'],
      drift: [],
      exit_code: 0
    })

    const queryClient = new QueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await renderDocOps(queryClient)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run DocOps check' })).toBeDefined()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Run DocOps check' }))

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['dox', 'status', '/test-project']
      })
    })
  })

  it('shows an error when runDoxCheck rejects', async () => {
    runDoxCheck.mockRejectedValue(new Error('Permission denied'))
    await renderDocOps()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run DocOps check' })).toBeDefined()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Run DocOps check' }))

    await waitFor(() => {
      expect(screen.getByText('Permission denied')).toBeDefined()
    })
  })

  it('shows "Checking…" text while the check is running', async () => {
    let resolveCheck: (value: DoxReport) => void

    const checkPromise = new Promise<DoxReport>(resolve => {
      resolveCheck = resolve
    })

    runDoxCheck.mockReturnValue(checkPromise)

    await renderDocOps()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run DocOps check' })).toBeDefined()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Run DocOps check' }))

    await waitFor(() => {
      expect(screen.getAllByText('Checking…').length).toBeGreaterThanOrEqual(1)
    })

    resolveCheck!({ status: {} as DoxReport['status'], drift: [], exit_code: 0 })

    await waitFor(() => {
      expect(screen.queryByText('Checking…')).toBeNull()
      expect(screen.getAllByText('Run Check').length).toBeGreaterThanOrEqual(1)
    })
  })

  it('invokes onClose when Close DocOps is clicked', async () => {
    const { onClose } = await renderDocOps()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Close DocOps' })).toBeDefined()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Close DocOps' }))
    expect(onClose).toHaveBeenCalled()
  })

  // ── Target resolution: active project primary path vs cwd ─────────────
  // Regression guard for the fix that made DocOps resolve the SELECTED
  // project's workspace, not just the raw session cwd — so a session sitting
  // in a subfolder still reports the dox-initialized project root.

  it('prefers the scoped project path over the session cwd', async () => {
    // cwd is a subfolder / parent root; the panel must target the scoped project.
    mockCwdAtom.set('/ws')
    mockScopeAtom.set('p_azure')
    mockProjects.set([
      { id: 'p_azure', name: 'Azure', primary_path: '/ws/Azure', folders: [] } as never
    ])

    await renderDocOps()

    await waitFor(() => {
      expect(getDoxStatus).toHaveBeenCalledWith('/ws/Azure')
    })
  })

  it('prefers the project tree path when present', async () => {
    mockCwdAtom.set('/ws')
    mockScopeAtom.set('p_azure')
    mockProjectTree.set([{ id: 'p_azure', path: '/ws/Azure-tree', repos: [] }])
    mockProjects.set([
      { id: 'p_azure', name: 'Azure', primary_path: '/ws/Azure-list', folders: [] } as never
    ])

    await renderDocOps()

    await waitFor(() => {
      expect(getDoxStatus).toHaveBeenCalledWith('/ws/Azure-tree')
    })
  })

  it('falls back to the session cwd when no project is scoped', async () => {
    mockCwdAtom.set('/ws/loose-session')
    mockScopeAtom.set('__all_projects__')
    mockProjects.set([])
    mockProjectTree.set([])

    await renderDocOps()

    await waitFor(() => {
      expect(getDoxStatus).toHaveBeenCalledWith('/ws/loose-session')
    })
  })

  // ── Explicit project picker ───────────────────────────────────────────

  it('renders a project picker trigger listing the scoped project', async () => {
    mockCwdAtom.set('/ws')
    mockScopeAtom.set('p_azure')
    mockProjects.set([
      { id: 'p_azure', name: 'Azure', primary_path: '/ws/Azure', folders: [] } as never,
      { id: 'p_teams', name: 'Teams', primary_path: '/ws/Teams', folders: [] } as never
    ])

    await renderDocOps()

    // Radix Select renders a button trigger (aria-label), not a native combobox.
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'DocOps project' })).toBeDefined()
    })
    // Default reflects the scoped project label.
    expect(screen.getByText('Azure')).toBeDefined()
    expect(getDoxStatus).toHaveBeenCalledWith('/ws/Azure')
  })

  it('defaults to Current directory when no project is scoped', async () => {
    mockCwdAtom.set('/ws/loose')
    mockScopeAtom.set('__all_projects__')
    mockProjects.set([
      { id: 'p_azure', name: 'Azure', primary_path: '/ws/Azure', folders: [] } as never
    ])

    await renderDocOps()

    await waitFor(() => {
      expect(getDoxStatus).toHaveBeenCalledWith('/ws/loose')
    })
  })

  it('queries the picked project path when the user selects one', async () => {
    mockCwdAtom.set('/ws')
    mockScopeAtom.set('__all_projects__')
    mockProjects.set([
      { id: 'p_azure', name: 'Azure', primary_path: '/ws/Azure', folders: [] } as never
    ])

    await renderDocOps()

    const trigger = await screen.findByRole('combobox', { name: 'DocOps project' })
    fireEvent.click(trigger)

    const option = await screen.findByRole('option', { name: 'Azure' })
    fireEvent.click(option)

    await waitFor(() => {
      expect(getDoxStatus).toHaveBeenCalledWith('/ws/Azure')
    })
  })

  // ── Run Check feedback (no longer silent) ─────────────────────────────

  it('shows an all-clear banner after a clean check', async () => {
    runDoxCheck.mockResolvedValue({ status: {} as DoxReport['status'], drift: [], exit_code: 0 })
    await renderDocOps()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run DocOps check' })).toBeDefined()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Run DocOps check' }))

    await waitFor(() => {
      expect(screen.getByText(/Check complete — no drift found/)).toBeDefined()
    })
  })

  it('shows a findings banner after a check with drift', async () => {
    runDoxCheck.mockResolvedValue({
      status: {} as DoxReport['status'],
      drift: [
        { tier: 'A', path: 'reports/x/report.html', kind: 'report_html_missing' },
        { tier: 'A', path: 'reports/x/MANIFEST.json', kind: 'manifest_missing' }
      ],
      exit_code: 0
    })
    await renderDocOps()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run DocOps check' })).toBeDefined()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Run DocOps check' }))

    await waitFor(() => {
      expect(screen.getByText(/Check complete — 2 items need attention/)).toBeDefined()
    })
  })

  it('explains the advisories counter is profile-wide', async () => {
    getDoxStatus.mockResolvedValue(activeStatus({ pending_advisories: 3 }))
    await renderDocOps()

    await waitFor(() => {
      expect(screen.getByText(/profile-wide/)).toBeDefined()
    })
  })
})
