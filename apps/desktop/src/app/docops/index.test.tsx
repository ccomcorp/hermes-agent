// @vitest-environment jsdom
import { atom } from 'nanostores'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesApi from '@/hermes'
import type { DoxProjectStatus, DoxReport } from '@/types/hermes.ts'

// ── Mocks ─────────────────────────────────────────────────────────────────

const getDoxStatus = vi.fn()
const runDoxCheck = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesApi>()),
  getDoxStatus: () => getDoxStatus(),
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

  it('shows empty drift message when no drift', async () => {
    getDoxStatus.mockResolvedValue(activeStatus({ drift: [] }))
    await renderDocOps()

    await waitFor(() => {
      expect(screen.getByText(/No drift detected/)).toBeDefined()
      expect(screen.getByText(/hermes dox check/)).toBeDefined()
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
})
