import { useQuery } from '@tanstack/react-query'
import type { ChangeEvent } from 'react'
import { useCallback, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { getGlobalModelOptions } from '@/hermes'
import { useI18n } from '@/i18n'
import { notify, notifyError } from '@/store/notifications'
import type { HermesConfigRecord } from '@/types/hermes'

import { CONTROL_TEXT, EMPTY_SELECT_VALUE, FIELD_LABELS } from './constants'
import { getNested } from './helpers'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RouteLane {
  provider: string
  model: string
  base_url?: string
  api_key?: string
  api_mode?: string
  reasoning_effort?: string
  description: string
}

type RoutesMap = Record<string, RouteLane>

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const LANE_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/

const RESERVED_NAMES = new Set([
  'default', 'none', 'auto', 'all', 'any', 'parent', 'main'
])

const API_KEY_RE = /^\$\{[A-Z_][A-Z0-9_]*\}$/

const EFFORT_OPTIONS = ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

function validateLaneName(name: string, existing: RoutesMap, editingName?: string): string | null {
  if (!name.trim()) {return 'Name is required'}

  if (!LANE_NAME_RE.test(name)) {return 'Must start with a lowercase letter, then only a-z, 0-9, _, -, max 32 chars'}

  if (RESERVED_NAMES.has(name.toLowerCase())) {return `"${name}" is a reserved name`}

  if (name !== editingName && name in existing) {return `"${name}" already exists`}

  return null
}

function validateApiKey(key: string): string | null {
  if (!key) {return null}

  if (!key.startsWith('${') || !key.endsWith('}')) {return 'Must be an env-var reference like ${VAR_NAME}'}

  if (!API_KEY_RE.test(key)) {return 'Invalid env-var format — use ${VAR_NAME}'}

  return null
}

// ---------------------------------------------------------------------------
// Empty lane factory
// ---------------------------------------------------------------------------

function emptyLane(): RouteLane {
  return { provider: '', model: '', description: '' }
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

interface Props {
  onChange: (next: RoutesMap) => void
  value: unknown
  /** Full config record for seeding suggested lanes. */
  config?: HermesConfigRecord
}

export function DelegationRoutesField({ onChange, value, config }: Props) {
  const { t } = useI18n()

  const routes: RoutesMap = useMemo(() => {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>
      const out: RoutesMap = {}

      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          const lane = v as Record<string, unknown>
          out[k] = {
            provider: String(lane.provider ?? ''),
            model: String(lane.model ?? ''),
            base_url: lane.base_url != null ? String(lane.base_url) : undefined,
            api_key: lane.api_key != null ? String(lane.api_key) : undefined,
            api_mode: lane.api_mode != null ? String(lane.api_mode) : undefined,
            reasoning_effort: lane.reasoning_effort != null ? String(lane.reasoning_effort) : undefined,
            description: String(lane.description ?? '')
          }
        }
      }

      return out
    }

    return {}
  }, [value])

  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<{ name: string; lane: RouteLane }>({ name: '', lane: emptyLane() })
  const [nameError, setNameError] = useState<string | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [seeding, setSeeding] = useState(false)

  const { data: modelOptions } = useQuery({
    queryKey: ['modelOptions', 'delegation-routes'],
    queryFn: () => getGlobalModelOptions(),
    staleTime: 60_000
  })

  const providers = useMemo(() => modelOptions?.providers ?? [], [modelOptions])

  // Suggest models for a given provider.
  const modelsForProvider = useCallback(
    (provider: string) => {
      if (!provider || !modelOptions) {return []}
      const providerData = providers.find(p => p.slug === provider)

      return providerData?.models ?? []
    },
    [modelOptions, providers]
  )

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  const notifySaved = useCallback(() => {
    notify({ title: t.settings.config.autosaveFailed, message: '' }) // reuse auto-save feedback
  }, [t])

  const commit = useCallback(
    (next: RoutesMap) => {
      onChange(next)
    },
    [onChange]
  )

  // -----------------------------------------------------------------------
  // Edit actions
  // -----------------------------------------------------------------------

  const openEdit = useCallback(
    (name: string) => {
      const lane = routes[name]
      setEditing(name)
      setForm({ name, lane: lane ? { ...lane } : emptyLane() })
      setNameError(null)
      setKeyError(null)
      setShowAdvanced(!!(lane?.base_url || lane?.api_mode))
    },
    [routes]
  )

  const openAdd = useCallback(() => {
    setEditing('__new__')
    setForm({ name: '', lane: emptyLane() })
    setNameError(null)
    setKeyError(null)
    setShowAdvanced(false)
  }, [])

  const cancelEdit = useCallback(() => {
    setEditing(null)
    setForm({ name: '', lane: emptyLane() })
    setNameError(null)
    setKeyError(null)
    setShowAdvanced(false)
  }, [])

  const saveEdit = useCallback(() => {
    const { name, lane } = form
    const editingName = editing === '__new__' ? undefined : editing ?? undefined
    const err = validateLaneName(name, routes, editingName)

    if (err) {
      setNameError(err)

      return
    }

    const keyErr = validateApiKey(lane.api_key ?? '')

    if (keyErr) {
      setKeyError(keyErr)

      return
    }

    const next = { ...routes }

    // If renaming, delete old key first.
    if (editingName && editingName !== name) {
      delete next[editingName]
    }

    next[name] = { ...lane }
    commit(next)
    cancelEdit()
  }, [form, editing, routes, commit, cancelEdit])

  const deleteLane = useCallback(() => {
    if (!deleteTarget) {return}
    const next = { ...routes }
    delete next[deleteTarget]
    commit(next)
    setDeleteTarget(null)

    if (editing === deleteTarget) {cancelEdit()}
  }, [deleteTarget, routes, commit, editing, cancelEdit])

  // -----------------------------------------------------------------------
  // Seed
  // -----------------------------------------------------------------------

  const seedSuggested = useCallback(async () => {
    if (!config) {return}
    setSeeding(true)

    try {
      const mainProvider = String(getNested(config, 'model.provider') ?? getNested(config, 'provider') ?? '')
      const mainModel = String(getNested(config, 'model.model') ?? getNested(config, 'model') ?? '')

      const baseUrl = String(getNested(config, 'delegation.base_url') ?? '')

      const lanes: RoutesMap = {}

      // coding lane: main provider/model + max effort
      if (mainProvider && mainModel) {
        lanes.coding = {
          provider: mainProvider,
          model: mainModel,
          base_url: baseUrl || undefined,
          reasoning_effort: 'max',
          description: 'Implementation, refactors, tests — main pair, max reasoning'
        }
      }

      // review lane: different model family
      const reviewProvider = mainProvider === 'deepseek' ? 'kimi-coding' : 'deepseek'
      lanes.review = {
        provider: reviewProvider,
        model: '',
        base_url: baseUrl || undefined,
        reasoning_effort: 'max',
        description: 'Adversarial review — different model family than the implementer'
      }

      // research lane: lighter / cheap model
      lanes.research = {
        provider: mainProvider || 'deepseek',
        model: '',
        reasoning_effort: 'low',
        description: 'Web searches, docs lookup, light analysis'
      }

      commit(lanes)
      notify({ title: t.settings.delegation.seededTitle, message: t.settings.delegation.seededMessage })
    } catch (err: unknown) {
      notifyError(err, t.settings.delegation.seedFailed)
    } finally {
      setSeeding(false)
    }
  }, [config, commit, t])

  // -----------------------------------------------------------------------
  // Form helpers
  // -----------------------------------------------------------------------

  const setLaneField = useCallback(
    (field: keyof RouteLane, value: string) => {
      setForm(prev => ({ ...prev, lane: { ...prev.lane, [field]: value } }))
    },
    []
  )

  // -----------------------------------------------------------------------
  // Render helpers
  // -----------------------------------------------------------------------

  const effortLabel = useCallback(
    (effort: string | undefined) => {
      if (!effort) {return '—'}
      const m = t.shell.modelOptions as Record<string, string>

      return m[effort] ?? effort
    },
    [t]
  )

  const laneNames = useMemo(() => Object.keys(routes).sort(), [routes])
  const isEmpty = laneNames.length === 0 && editing !== '__new__'

  const renderEditDialog = () => (
    <Dialog onOpenChange={open => { if (!open) {cancelEdit()} }} open={editing !== null}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing === '__new__'
              ? t.settings.delegation.addLaneTitle
              : t.settings.delegation.editLaneTitle}
          </DialogTitle>
          <DialogDescription>{t.settings.delegation.editLaneDesc}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="text-sm font-medium">{t.settings.delegation.laneName}</label>
            <Input
              className="mt-1"
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setForm(prev => ({ ...prev, name: e.target.value }))
                setNameError(null)
              }}
              placeholder="e.g. coding, review"
              value={form.name}
            />
            {nameError && <p className="text-xs text-destructive mt-1">{nameError}</p>}
          </div>

          {/* Provider */}
          <div>
            <label className="text-sm font-medium">{t.settings.delegation.laneProvider}</label>
            <Select
              onValueChange={v => {
                setLaneField('provider', v === EMPTY_SELECT_VALUE ? '' : v)
                setLaneField('model', '') // reset model on provider change
              }}
              value={form.lane.provider || EMPTY_SELECT_VALUE}
            >
              <SelectTrigger className={`${CONTROL_TEXT} mt-1`}>
                <SelectValue placeholder={t.settings.delegation.selectProvider} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EMPTY_SELECT_VALUE}>{t.settings.config.none}</SelectItem>
                {providers.map(p => (
                  <SelectItem key={p.slug} value={p.slug}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Model */}
          <div>
            <label className="text-sm font-medium">{t.settings.delegation.laneModel}</label>
            {form.lane.provider && modelsForProvider(form.lane.provider).length > 0 ? (
              <Select
                onValueChange={v => setLaneField('model', v === EMPTY_SELECT_VALUE ? '' : v)}
                value={form.lane.model || EMPTY_SELECT_VALUE}
              >
                <SelectTrigger className={`${CONTROL_TEXT} mt-1`}>
                  <SelectValue placeholder={t.settings.delegation.selectModel} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={EMPTY_SELECT_VALUE}>{t.settings.config.none}</SelectItem>
                  {modelsForProvider(form.lane.provider).map(m => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                className="mt-1"
                onChange={(e: ChangeEvent<HTMLInputElement>) => setLaneField('model', e.target.value)}
                placeholder={form.lane.provider ? t.settings.delegation.typeModel : t.settings.delegation.pickProviderFirst}
                value={form.lane.model}
              />
            )}
          </div>

          {/* Reasoning Effort */}
          <div>
            <label className="text-sm font-medium">{FIELD_LABELS['delegation.reasoning_effort'] ?? t.settings.delegation.laneEffort}</label>
            <Select
              onValueChange={v => setLaneField('reasoning_effort', v === EMPTY_SELECT_VALUE ? '' : v)}
              value={form.lane.reasoning_effort ?? ''}
            >
              <SelectTrigger className={`${CONTROL_TEXT} mt-1`}>
                <SelectValue placeholder={t.settings.config.none} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EMPTY_SELECT_VALUE}>{t.settings.config.none}</SelectItem>
                {EFFORT_OPTIONS.filter(Boolean).map(e => (
                  <SelectItem key={e} value={e}>
                    {effortLabel(e)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Description */}
          <div>
            <label className="text-sm font-medium">{t.settings.delegation.laneDescription}</label>
            <Textarea
              className="mt-1"
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setLaneField('description', e.target.value)}
              placeholder={t.settings.delegation.laneDescriptionPlaceholder}
              rows={2}
              value={form.lane.description}
            />
          </div>

          {/* API Key */}
          <div>
            <label className="text-sm font-medium">{t.settings.delegation.laneApiKey}</label>
            <Input
              className="mt-1 font-mono"
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setLaneField('api_key', e.target.value)
                setKeyError(null)
              }}
              placeholder={'${PROVIDER_API_KEY}'}
              value={form.lane.api_key ?? ''}
            />
            {keyError ? (
              <p className="text-xs text-destructive mt-1">{keyError}</p>
            ) : form.lane.api_key ? (
              <p className="text-xs text-muted-foreground mt-1">{t.settings.delegation.apiKeyHint}</p>
            ) : null}
          </div>

          {/* Advanced toggle */}
          <div>
            <button
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setShowAdvanced(v => !v)}
              type="button"
            >
              {showAdvanced ? '▾' : '▸'} {t.settings.delegation.advanced}
            </button>
          </div>

          {showAdvanced && (
            <div className="space-y-4 pl-2 border-l-2 border-muted">
              {/* Base URL */}
              <div>
                <label className="text-sm font-medium">{t.settings.delegation.laneBaseUrl}</label>
                <Input
                  className="mt-1"
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setLaneField('base_url', e.target.value)}
                  placeholder="https://api.example.com/v1"
                  value={form.lane.base_url ?? ''}
                />
              </div>

              {/* API Mode */}
              <div>
                <label className="text-sm font-medium">{t.settings.delegation.laneApiMode}</label>
                <Select
                  onValueChange={v => setLaneField('api_mode', v === EMPTY_SELECT_VALUE ? '' : v)}
                  value={form.lane.api_mode ?? ''}
                >
                  <SelectTrigger className={`${CONTROL_TEXT} mt-1`}>
                    <SelectValue placeholder={t.settings.config.none} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={EMPTY_SELECT_VALUE}>{t.settings.config.none}</SelectItem>
                    <SelectItem value="openai">{t.settings.delegation.apiModeOpenAI}</SelectItem>
                    <SelectItem value="anthropic">{t.settings.delegation.apiModeAnthropic}</SelectItem>
                    <SelectItem value="gemini">{t.settings.delegation.apiModeGemini}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={cancelEdit} variant="outline">
            {t.settings.delegation.cancel}
          </Button>
          <Button onClick={saveEdit}>
            {editing === '__new__' ? t.settings.delegation.addLane : t.settings.delegation.saveLane}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  // -----------------------------------------------------------------------
  // Main render
  // -----------------------------------------------------------------------

  return (
    <div className="w-full space-y-3">
      {/* Header: lane count + actions */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {laneNames.length === 0
            ? t.settings.delegation.noRoutes
            : t.settings.delegation.routeCount(laneNames.length)}
        </span>
        <div className="flex gap-2">
          {isEmpty && (
            <Button
              disabled={!config || seeding}
              onClick={seedSuggested}
              size="sm"
              variant="outline"
            >
              {seeding ? t.settings.delegation.seeding : t.settings.delegation.seedButton}
            </Button>
          )}
          <Button onClick={openAdd} size="sm" variant="outline">
            {t.settings.delegation.addLane}
          </Button>
        </div>
      </div>

      {/* Route table / empty state */}
      {isEmpty ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t.settings.delegation.emptyTitle}
          <br />
          {t.settings.delegation.emptyDesc}
        </div>
      ) : (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="px-3 py-2 text-left font-medium">{t.settings.delegation.colName}</th>
                <th className="px-3 py-2 text-left font-medium">{t.settings.delegation.colProvider}</th>
                <th className="px-3 py-2 text-left font-medium">{t.settings.delegation.colModel}</th>
                <th className="px-3 py-2 text-left font-medium">{t.settings.delegation.colEffort}</th>
                <th className="px-3 py-2 text-left font-medium">{t.settings.delegation.colDescription}</th>
                <th className="px-3 py-2 w-[80px]" />
              </tr>
            </thead>
            <tbody>
              {laneNames.map((name, i) => {
                const lane = routes[name]
                const isLast = i === laneNames.length - 1

                return (
                  <tr className={isLast ? '' : 'border-b'} key={name}>
                    <td className="px-3 py-2 font-mono text-xs">{name}</td>
                    <td className="px-3 py-2">{lane.provider || '—'}</td>
                    <td className="px-3 py-2">{lane.model || '—'}</td>
                    <td className="px-3 py-2">{effortLabel(lane.reasoning_effort)}</td>
                    <td className="px-3 py-2 max-w-[200px] truncate">{lane.description || '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <Button
                          className="h-7 px-2 text-xs"
                          onClick={() => openEdit(name)}
                          size="sm"
                          variant="ghost"
                        >
                          {t.settings.delegation.edit}
                        </Button>
                        <Button
                          className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(name)}
                          size="sm"
                          variant="ghost"
                        >
                          {t.settings.delegation.delete}
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit dialog */}
      {renderEditDialog()}

      {/* Delete confirm dialog */}
      <Dialog onOpenChange={open => { if (!open) {setDeleteTarget(null)} }} open={deleteTarget !== null}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t.settings.delegation.deleteTitle}</DialogTitle>
            <DialogDescription>
              {t.settings.delegation.deleteDesc(deleteTarget ?? '')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setDeleteTarget(null)} variant="outline">
              {t.settings.delegation.cancel}
            </Button>
            <Button onClick={deleteLane} variant="destructive">
              {t.settings.delegation.deleteConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
