import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Radix Select calls scrollIntoView / pointer-capture APIs jsdom lacks.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

const getGlobalModelOptions = vi.fn()
const saveHermesConfig = vi.fn()

vi.mock('@/hermes', () => ({
  getGlobalModelOptions: () => getGlobalModelOptions(),
  saveHermesConfig: (...args: any[]) => saveHermesConfig(...args)
}))

const t = {
  common: {
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    edit: 'Edit',
    close: 'Close',
    confirm: 'Confirm'
  },
  settings: {
    config: {
      none: 'None',
      autosaveFailed: 'Autosave failed'
    },
    delegation: {
      noRoutes: 'No routes',
      routeCount: (n: number) => `${n} routes`,
      seedButton: 'Seed',
      seeding: 'Seeding\u2026',
      seededTitle: 'Seeded',
      seededMessage: 'Routes seeded',
      seedFailed: 'Seed failed',
      emptyTitle: 'No lanes',
      emptyDesc: 'Add a lane',
      addLane: 'Add lane',
      addLaneTitle: 'New lane',
      editLaneTitle: 'Edit lane',
      editLaneDesc: 'Edit lane desc',
      laneName: 'Name',
      laneProvider: 'Provider',
      laneModel: 'Model',
      laneEffort: 'Effort',
      laneDescription: 'Description',
      laneDescriptionPlaceholder: 'Placeholder',
      laneBaseUrl: 'Base URL',
      laneApiKey: 'API Key',
      laneApiMode: 'API Mode',
      apiKeyHint: 'Hint',
      selectProvider: 'Select provider\u2026',
      selectModel: 'Select model\u2026',
      typeModel: 'Type a model\u2026',
      pickProviderFirst: 'Pick provider first',
      advanced: 'Advanced',
      cancel: 'Cancel',
      saveLane: 'Save',
      edit: 'Edit',
      delete: 'Delete',
      deleteTitle: 'Delete lane',
      deleteDesc: (name: string) => `Delete ${name}?`,
      deleteConfirm: 'Delete',
      colName: 'Name',
      colProvider: 'Provider',
      colModel: 'Model',
      colEffort: 'Effort',
      colDescription: 'Description',
      apiModeOpenAI: 'OpenAI',
      apiModeAnthropic: 'Anthropic',
      apiModeGemini: 'Gemini'
    }
  },
  shell: {
    modelOptions: {}
  }
}

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t })
}))

beforeEach(() => {
  getGlobalModelOptions.mockResolvedValue({
    providers: [
      { name: 'OpenAI', slug: 'openai', models: ['gpt-5', 'gpt-5-mini'] },
      { name: 'Anthropic', slug: 'anthropic', models: ['claude-sonnet-4'] }
    ]
  })
  saveHermesConfig.mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function renderField(value: Record<string, any> = {}, onChange = vi.fn()) {
  const { DelegationRoutesField } = await import('./delegation-routes-field')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={client}>
      <DelegationRoutesField onChange={onChange} value={value} />
    </QueryClientProvider>
  )

  return onChange
}

const TWO_LANES: Record<string, any> = {
  coding: { provider: 'openai', model: 'gpt-5', description: 'Code gen' },
  review: { provider: 'anthropic', model: 'claude-sonnet-4' }
}

describe('DelegationRoutesField', () => {
  it('shows empty-state hint when there are no routes', async () => {
    await renderField({})

    await waitFor(() => {
      expect(screen.getByText('No routes')).toBeTruthy()
    })
    expect(screen.getByText('Add lane')).toBeTruthy()
  })

  it('renders each named route as a table row', async () => {
    await renderField(TWO_LANES)

    await waitFor(() => {
      expect(screen.getByText('coding')).toBeTruthy()
      expect(screen.getByText('review')).toBeTruthy()
    })
    expect(screen.getByText('2 routes')).toBeTruthy()
    expect(screen.queryByText(/\[object Object\]/)).toBeNull()
  })

  it('clicking "Add lane" opens the lane form dialog', async () => {
    await renderField(TWO_LANES)

    fireEvent.click(screen.getByRole('button', { name: 'Add lane' }))

    // The form is a Radix Dialog (state-driven open); assert by dialog role.
    // Title/labels come from the mocked `t` above (addLaneTitle → 'New lane').
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('New lane')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('removing a route emits the remaining map', async () => {
    const onChange = await renderField(TWO_LANES)

    await waitFor(() => {
      expect(screen.getByText('coding')).toBeTruthy()
    })

    // Each row has an Edit + Delete button; click the first row's Delete.
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])

    // A confirm dialog appears with the destructive "Delete" action.
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Delete lane')).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled()
      const lastCall = onChange.mock.calls.at(-1)?.[0]
      expect(lastCall).toBeDefined()
      expect(lastCall).not.toHaveProperty('coding')
      expect(lastCall).toHaveProperty('review')
    })
  })

  it('empty lanes object still shows empty state', async () => {
    await renderField({})

    await waitFor(() => {
      expect(screen.getByText('No routes')).toBeTruthy()
    })
  })

  it('resyncs rows when external value prop changes', async () => {
    const onChange = vi.fn()
    const { DelegationRoutesField } = await import('./delegation-routes-field')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const view = render(
      <QueryClientProvider client={client}>
        <DelegationRoutesField onChange={onChange} value={TWO_LANES} />
      </QueryClientProvider>
    )

    await waitFor(() => {
      expect(screen.getByText('coding')).toBeTruthy()
      expect(screen.getByText('review')).toBeTruthy()
    })

    view.rerender(
      <QueryClientProvider client={client}>
        <DelegationRoutesField
          onChange={onChange}
          value={{ research: { provider: 'anthropic', model: 'claude-sonnet-4' } }}
        />
      </QueryClientProvider>
    )

    await waitFor(() => {
      expect(screen.getByText('1 routes')).toBeTruthy()
      expect(screen.queryByText('coding')).toBeNull()
      expect(screen.getByText('research')).toBeTruthy()
    })
  })
})
