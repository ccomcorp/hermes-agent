import type {
  PluginTesterAuth,
  PluginTesterCollectionManifestEntry,
  PluginTesterHistoryManifestEntry,
  PluginTesterRequest,
  PluginTesterResponse,
  PluginTesterTimingTrace
} from '@hermes/shared'
/**
 * Plugin Tester panel — Postman-style HTTP request composer and response viewer.
 *
 * Depends on plugin-tester-api.ts (IPC wrappers), store.ts (nanostore atoms),
 * and strings.ts (English-only strings).  Uses the same MasterDetail pattern as
 * requirement-panel.tsx for the collection list vs. composer/response detail.
 */
import { useStore } from '@nanostores/react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { notify, notifyError } from '@/store/notifications'

import { DetailColumn, ICON_BUTTON, ListColumn, MasterDetail } from '../master-detail'
import { PanelEmpty, PanelListRow } from '../overlays/panel'

import * as api from './plugin-tester-api'
import {
  $pluginTesterActiveCollectionId,
  $pluginTesterActiveEnvironmentId,
  $pluginTesterCollections,
  $pluginTesterCollectionsError,
  $pluginTesterCollectionsLoading,
  $pluginTesterEnvironments,
  $pluginTesterEnvironmentsError,
  $pluginTesterEnvironmentsLoading,
  $pluginTesterHistory,
  $pluginTesterHistoryError,
  $pluginTesterHistoryLoading,
  setPluginTesterActiveCollectionId,
  setPluginTesterActiveEnvironmentId,
  setPluginTesterCollections,
  setPluginTesterCollectionsError,
  setPluginTesterCollectionsLoading,
  setPluginTesterEnvironments,
  setPluginTesterEnvironmentsError,
  setPluginTesterEnvironmentsLoading,
  setPluginTesterHistory,
  setPluginTesterHistoryError,
  setPluginTesterHistoryLoading
} from './store'
import { workbenchStrings as s } from './strings'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPPORTED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  POST: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  PUT: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  PATCH: 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400',
  DELETE: 'bg-red-500/15 text-red-600 dark:text-red-400',
  HEAD: 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
  OPTIONS: 'bg-teal-500/15 text-teal-600 dark:text-teal-400'
}

function STATUS_COLOR(status: number): string {
  if (status < 200) { return 'bg-slate-500/15 text-slate-500' }

  if (status < 300) { return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' }

  if (status < 400) { return 'bg-blue-500/15 text-blue-600 dark:text-blue-400' }

  if (status < 500) { return 'bg-amber-500/15 text-amber-600 dark:text-amber-400' }

  return 'bg-red-500/15 text-red-600 dark:text-red-400'
}

const AUTH_TYPES = ['none', 'bearer', 'basic', 'apikey'] as const

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

interface Kv {
  key: string
  value: string
}

function kvToRecord(kvs: Kv[]): Record<string, string> {
  return Object.fromEntries(kvs.filter(r => r.key).map(r => [r.key, r.value]))
}

function recordToKv(rec: Record<string, string> | undefined): Kv[] {
  if (!rec) { return [{ key: '', value: '' }] }

  return Object.entries(rec).map(([key, value]) => ({ key, value }))
}

// ---------------------------------------------------------------------------
// Key-Value editor (shared by Headers, Params, Environments, etc.)
// ---------------------------------------------------------------------------

function KeyValueEditor({
  keyPlaceholder,
  onRowsChange,
  rows,
  valuePlaceholder
}: {
  keyPlaceholder: string
  onRowsChange: (rows: Kv[]) => void
  rows: Kv[]
  valuePlaceholder: string
}) {
  const setRow = (idx: number, field: 'key' | 'value', val: string) => {
    const next = rows.slice()

    next[idx] = { ...next[idx], [field]: val }
    onRowsChange(next)
  }

  const removeRow = (idx: number) => {
    const next = rows.filter((_, i) => i !== idx)

    onRowsChange(next.length === 0 ? [{ key: '', value: '' }] : next)
  }

  const addRow = () => onRowsChange([...rows, { key: '', value: '' }])

  return (
    <div className="space-y-1">
      {rows.map((row, idx) => (
        <div className="flex gap-2" key={idx}>
          <Input
            className="flex-1 font-mono text-xs"
            onChange={e => setRow(idx, 'key', e.target.value)}
            placeholder={idx === 0 ? keyPlaceholder : ''}
            size="sm"
            value={row.key}
          />
          <Input
            className="flex-1 font-mono text-xs"
            onChange={e => setRow(idx, 'value', e.target.value)}
            placeholder={idx === 0 ? valuePlaceholder : ''}
            size="sm"
            value={row.value}
          />
          <Button
            aria-label="Remove"
            className="shrink-0 size-6"
            onClick={() => removeRow(idx)}
            size="icon"
            variant="ghost"
          >
            <Codicon name="close" size="0.75rem" />
          </Button>
        </div>
      ))}
      <Button className="gap-1 text-xs" onClick={addRow} size="sm" variant="ghost">
        <Codicon name="add" size="0.75rem" />
        {' '}Add row
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab bar helper (local, not a global Tabs component)
// ---------------------------------------------------------------------------

function TabBar({
  onSelect,
  selected,
  tabs
}: {
  onSelect: (tab: string) => void
  selected: string
  tabs: readonly { id: string; label: string }[]
}) {
  return (
    <div className="flex gap-0.5 border-b border-(--ui-stroke-secondary)">
      {tabs.map(tab => (
        <button
          className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px ${
            selected === tab.id
              ? 'border-foreground text-foreground'
              : 'border-transparent text-muted-foreground/70 hover:text-foreground'
          }`}
          key={tab.id}
          onClick={() => onSelect(tab.id)}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface PluginTesterPanelProps {
  workspaceRoot: string
}

export function PluginTesterPanel({ workspaceRoot }: PluginTesterPanelProps) {
  // -- Store reads -----------------------------------------------------------
  const collections = useStore($pluginTesterCollections)
  const collectionsLoading = useStore($pluginTesterCollectionsLoading)
  const collectionsError = useStore($pluginTesterCollectionsError)
  const activeCollectionId = useStore($pluginTesterActiveCollectionId)

  const environments = useStore($pluginTesterEnvironments)
  const environmentsLoading = useStore($pluginTesterEnvironmentsLoading)
  const environmentsError = useStore($pluginTesterEnvironmentsError)
  const activeEnvironmentId = useStore($pluginTesterActiveEnvironmentId)

  const history = useStore($pluginTesterHistory)
  const historyLoading = useStore($pluginTesterHistoryLoading)
  const historyError = useStore($pluginTesterHistoryError)

  // -- Local draft state (not persisted on every keystroke) ------------------
  const [method, setMethod] = useState<string>('GET')
  const [url, setUrl] = useState('')
  const [headers, setHeaders] = useState<Kv[]>([{ key: '', value: '' }])
  const [params, setParams] = useState<Kv[]>([{ key: '', value: '' }])
  const [body, setBody] = useState('')
  const [contentType, setContentType] = useState('application/json')
  const [auth, setAuth] = useState<PluginTesterAuth>({ type: 'none' })
  const [timeout, setTimeout_] = useState(30000)

  // Execution state
  const [sending, setSending] = useState(false)
  const [response, setResponse] = useState<PluginTesterResponse | null>(null)
  const [trace, setTrace] = useState<PluginTesterTimingTrace[]>([])
  const [responseError, setResponseError] = useState<string | null>(null)

  // Tabs
  const [editorTab, setEditorTab] = useState('headers')
  const [responseTab, setResponseTab] = useState('body')

  // Dialogs
  const [collectionDialogOpen, setCollectionDialogOpen] = useState(false)
  const [collectionName, setCollectionName] = useState('')
  const [collectionDescription, setCollectionDescription] = useState('')
  const [collectionSaving, setCollectionSaving] = useState(false)

  const [envDialogOpen, setEnvDialogOpen] = useState(false)
  const [envName, setEnvName] = useState('')
  const [envVariables, setEnvVariables] = useState<Kv[]>([{ key: '', value: '' }])
  const [envSaving, setEnvSaving] = useState(false)

  // History pane: collapsed by default
  const [historyPaneOpen, setHistoryPaneOpen] = useState(false)

  // ---- Data loading --------------------------------------------------------
  const loadCollections = useCallback(async () => {
    setPluginTesterCollectionsLoading(true)
    setPluginTesterCollectionsError(null)

    try {
      const res = await api.listCollections(workspaceRoot)

      if (res.ok) {
        setPluginTesterCollections(res.value)
      } else {
        setPluginTesterCollectionsError(res.message)
      }
    } catch (err) {
      notifyError(err, s.pluginTester.collectionsFailed)
    } finally {
      setPluginTesterCollectionsLoading(false)
    }
  }, [workspaceRoot])

  const loadEnvironments = useCallback(async () => {
    setPluginTesterEnvironmentsLoading(true)
    setPluginTesterEnvironmentsError(null)

    try {
      const res = await api.listEnvironments(workspaceRoot)

      if (res.ok) {
        setPluginTesterEnvironments(res.value)
      } else {
        setPluginTesterEnvironmentsError(res.message)
      }
    } catch (err) {
      notifyError(err, s.pluginTester.environmentsFailed)
    } finally {
      setPluginTesterEnvironmentsLoading(false)
    }
  }, [workspaceRoot])

  const loadHistory = useCallback(async () => {
    setPluginTesterHistoryLoading(true)
    setPluginTesterHistoryError(null)

    try {
      const res = await api.listHistory(workspaceRoot, activeCollectionId ?? undefined)

      if (res.ok) {
        // listHistory returns a paginated shape { entries, total } (unlike
        // collections/environments which return a bare array), so extract
        // `.entries` — assigning res.value directly made the history atom a
        // non-array and crashed the pane's `.map()` ("s.map is not a function").
        setPluginTesterHistory(res.value.entries)
      } else {
        setPluginTesterHistoryError(res.message)
      }
    } catch (err) {
      notifyError(err, s.pluginTester.historyFailed)
    } finally {
      setPluginTesterHistoryLoading(false)
    }
  }, [activeCollectionId, workspaceRoot])

  useEffect(() => {
    void loadCollections()
    void loadEnvironments()
    void loadHistory()
  }, [loadCollections, loadEnvironments, loadHistory])

  // ---- Build request object ------------------------------------------------
  const buildRequest = useCallback((): PluginTesterRequest => {
    const req: PluginTesterRequest = { method, url }

    const hdrs = kvToRecord(headers)

    if (Object.keys(hdrs).length > 0) { req.headers = hdrs }

    const prms = kvToRecord(params)

    if (Object.keys(prms).length > 0) { req.params = prms }

    if (body) { req.body = body }

    if (contentType) { req.contentType = contentType }

    if (auth.type !== 'none') { req.auth = { ...auth } }

    if (timeout) { req.timeout = timeout }

    return req
  }, [method, url, headers, params, body, contentType, auth, timeout])

  // ---- Send request --------------------------------------------------------
  const handleSend = useCallback(async () => {
    if (!url.trim()) { return }

    setSending(true)
    setResponseError(null)

    try {
      const res = await api.executeRequest(
        workspaceRoot,
        buildRequest(),
        activeEnvironmentId ?? undefined,
        activeCollectionId ?? undefined
      )

      if (res.ok) {
        setResponse(res.value.response)
        setTrace(res.value.trace)
        setResponseTab('body')

        // Refresh history — execute auto-records server-side
        void loadHistory()
      } else {
        setResponseError(res.message)
        setResponse(null)
      }
    } catch (err) {
      notifyError(err, s.pluginTester.requestFailed)
      setResponseError(s.pluginTester.requestFailed)
      setResponse(null)
    } finally {
      setSending(false)
    }
  }, [activeCollectionId, activeEnvironmentId, buildRequest, loadHistory, url, workspaceRoot])

  // ---- Collection operations -----------------------------------------------
  const saveToCollection = useCallback(async () => {
    if (!activeCollectionId) { return }

    setCollectionSaving(true)

    try {
      const collRes = await api.readCollection(workspaceRoot, activeCollectionId)

      if (!collRes.ok) {
        notify({ kind: 'error', message: collRes.message, title: s.pluginTester.collectionsFailed })

        return
      }

      const updated = await api.updateCollection(
        workspaceRoot,
        activeCollectionId,
        collRes.value.name,
        collRes.value.description,
        [...collRes.value.requests, buildRequest()]
      )

      if (updated.ok) {
        notify({ kind: 'success', message: '', title: 'Request saved to collection' })
        void loadCollections()
      } else {
        notify({ kind: 'error', message: updated.message, title: s.pluginTester.collectionsFailed })
      }
    } catch (err) {
      notifyError(err, s.pluginTester.collectionsFailed)
    } finally {
      setCollectionSaving(false)
    }
  }, [activeCollectionId, buildRequest, loadCollections, workspaceRoot])

  const handleCreateCollection = useCallback(async () => {
    if (!collectionName.trim()) { return }

    setCollectionSaving(true)

    try {
      const res = await api.createCollection(workspaceRoot, collectionName.trim(), collectionDescription, [])

      if (res.ok) {
        notify({ kind: 'success', message: '', title: 'Collection created' })
        setCollectionDialogOpen(false)
        setCollectionName('')
        setCollectionDescription('')
        void loadCollections()
      } else {
        notify({ kind: 'error', message: res.message, title: s.pluginTester.collectionsFailed })
      }
    } catch (err) {
      notifyError(err, s.pluginTester.collectionsFailed)
    } finally {
      setCollectionSaving(false)
    }
  }, [collectionDescription, collectionName, loadCollections, workspaceRoot])

  const openCollectionRequests = useCallback(
    async (entry: PluginTesterCollectionManifestEntry) => {
      setPluginTesterActiveCollectionId(entry.id)

      try {
        const res = await api.readCollection(workspaceRoot, entry.id)

        if (res.ok && res.value.requests.length > 0) {
          // Load first request from collection
          const req = res.value.requests[0]

          setMethod(req.method)
          setUrl(req.url)
          setHeaders(recordToKv(req.headers))
          setParams(
            req.params
              ? Array.isArray(req.params)
                ? req.params
                : Object.entries(req.params).map(([k, v]) => ({ key: k, value: v }))
              : [{ key: '', value: '' }]
          )
          setBody(req.body ?? '')
          setContentType(req.contentType ?? 'application/json')
          setAuth(req.auth ?? { type: 'none' })

          if (req.timeout) { setTimeout_(req.timeout) }
        }
      } catch (err) {
        notifyError(err, 'Failed to load collection')
      }
    },
    [workspaceRoot]
  )

  // ---- Environment operations ----------------------------------------------
  const handleCreateEnvironment = useCallback(async () => {
    if (!envName.trim()) { return }

    setEnvSaving(true)

    try {
      const vars = kvToRecord(envVariables)
      const res = await api.createEnvironment(workspaceRoot, envName.trim(), vars)

      if (res.ok) {
        notify({ kind: 'success', message: '', title: 'Environment created' })
        setEnvDialogOpen(false)
        setEnvName('')
        setEnvVariables([{ key: '', value: '' }])
        void loadEnvironments()
      } else {
        notify({ kind: 'error', message: res.message, title: s.pluginTester.environmentsFailed })
      }
    } catch (err) {
      notifyError(err, s.pluginTester.environmentsFailed)
    } finally {
      setEnvSaving(false)
    }
  }, [envName, envVariables, loadEnvironments, workspaceRoot])

  // ---- History operations --------------------------------------------------
  const loadHistoryEntry = useCallback(
    async (entry: PluginTesterHistoryManifestEntry) => {
      try {
        const res = await api.readHistoryEntry(workspaceRoot, entry.id)

        if (res.ok) {
          setMethod(res.value.request.method)
          setUrl(res.value.request.url)
          setHeaders(recordToKv(res.value.request.headers))
          setParams(
            res.value.request.params
              ? Array.isArray(res.value.request.params)
                ? res.value.request.params
                : Object.entries(res.value.request.params).map(([k, v]) => ({ key: k, value: v }))
              : [{ key: '', value: '' }]
          )
          setBody(res.value.request.body ?? '')
          setContentType(res.value.request.contentType ?? 'application/json')
          setAuth(res.value.request.auth ?? { type: 'none' })

          if (res.value.request.timeout) { setTimeout_(res.value.request.timeout) }

          if (res.value.response) {
            setResponse(res.value.response)
            setTrace(res.value.trace)
            setResponseError(null)
          }
        }
      } catch (err) {
        notifyError(err, s.pluginTester.historyFailed)
      }
    },
    [workspaceRoot]
  )

  const handleClearHistory = useCallback(async () => {
    try {
      const res = await api.clearHistory(workspaceRoot)

      if (res.ok) {
        setPluginTesterHistory([])
        notify({ kind: 'success', message: '', title: 'History cleared' })
      }
    } catch (err) {
      notifyError(err, s.pluginTester.historyFailed)
    }
  }, [workspaceRoot])

  // ---- Total time from trace -----------------------------------------------
  const totalMs = useMemo(() => {
    const timingTrace = trace.find(t => t.step === 'response' && t.timing)

    return timingTrace?.timing?.total ?? trace.reduce((sum, t) => sum + t.duration, 0)
  }, [trace])

  const ttfb = useMemo(() => {
    const timingTrace = trace.find(t => t.step === 'response' && t.timing)

    return timingTrace?.timing?.ttfb ?? 0
  }, [trace])

  // ---- Tab bar items -------------------------------------------------------
  const editorTabs = useMemo(
    () => [
      { id: 'headers', label: s.pluginTester.headersHeading },
      { id: 'params', label: s.pluginTester.paramsHeading },
      { id: 'body', label: s.pluginTester.bodyHeading },
      { id: 'auth', label: s.pluginTester.authHeading }
    ],
    []
  )

  const responseTabs = useMemo(
    () => [
      { id: 'body', label: s.pluginTester.responseBody },
      { id: 'headers', label: s.pluginTester.responseHeaders },
      { id: 'cookies', label: s.pluginTester.responseCookies }
    ],
    []
  )

  // ---- Render --------------------------------------------------------------
  return (
    <>
      <MasterDetail>
        {/* ---- Collections sidebar ---- */}
        <ListColumn
          header={
            <div className="mb-1 flex h-6 shrink-0 items-center justify-between gap-2 pl-2 pr-1">
              <span className="text-[0.68rem] font-medium uppercase tracking-wide text-muted-foreground/60">
                {s.pluginTester.collectionsHeading}
              </span>
              <Button
                aria-label={s.pluginTester.createCollection}
                className={ICON_BUTTON}
                onClick={() => setCollectionDialogOpen(true)}
                size="icon"
                variant="ghost"
              >
                <Codicon name="add" size="0.8125rem" />
              </Button>
            </div>
          }
        >
          {collectionsLoading && collections.length === 0 ? (
            <PageLoader label={s.pluginTester.collectionsLoading} />
          ) : collectionsError && collections.length === 0 ? (
            <PanelEmpty
              action={
                <Button onClick={() => void loadCollections()} size="sm" variant="outline">
                  {s.refresh}
                </Button>
              }
              description={collectionsError}
              icon="error"
              title={s.pluginTester.collectionsFailed}
            />
          ) : collections.length === 0 ? (
            <PanelEmpty description={s.pluginTester.collectionsEmpty} icon="inbox" title="" />
          ) : (
            collections.map(entry => (
              <PanelListRow
                active={entry.id === activeCollectionId}
                key={entry.id}
                meta={String(entry.requestCount)}
                onSelect={() => void openCollectionRequests(entry)}
                title={entry.name}
              />
            ))
          )}
        </ListColumn>

        {/* ---- Main detail: composer + response ---- */}
        <DetailColumn>
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {/* -------- Environment picker + request composer bar -------- */}
            <div className="flex items-center gap-2">
              {/* Environment dropdown */}
              <Select
                onValueChange={value => setPluginTesterActiveEnvironmentId(value === '_none' ? null : value)}
                value={activeEnvironmentId ?? '_none'}
              >
                <SelectTrigger className="h-7 w-36 text-xs" size="sm">
                  <SelectValue placeholder={s.pluginTester.environmentsHeading} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">No environment</SelectItem>
                  {environments.map(env => (
                    <SelectItem key={env.id} value={env.id}>
                      {env.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                className="shrink-0 size-6"
                onClick={() => setEnvDialogOpen(true)}
                size="icon"
                variant="ghost"
              >
                <Codicon name="settings-gear" size="0.75rem" />
              </Button>
            </div>

            {/* -------- URL bar -------- */}
            <div className="flex gap-2">
              <Select onValueChange={setMethod} value={method}>
                <SelectTrigger className="h-8 w-28 text-xs" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORTED_METHODS.map(m => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Input
                className="flex-1 font-mono text-xs"
                onChange={e => setUrl(e.target.value)}
                placeholder={s.pluginTester.urlPlaceholder}
                size="sm"
                value={url}
              />

              <Button
                disabled={sending || !url.trim()}
                onClick={() => void handleSend()}
                size="sm"
                variant="default"
              >
                <Codicon name={sending ? 'loading' : 'send'} size="0.8125rem" spinning={sending} />
                {sending ? s.pluginTester.sendingButton : s.pluginTester.sendButton}
              </Button>

              {/* Save to active collection */}
              {activeCollectionId && (
                <Button
                  className="shrink-0"
                  disabled={collectionSaving || !url.trim()}
                  onClick={() => void saveToCollection()}
                  size="sm"
                  title="Save to collection"
                  variant="ghost"
                >
                  <Codicon name="save" size="0.8125rem" />
                </Button>
              )}
            </div>

            {/* -------- Tabbed editors -------- */}
            <div className="flex min-h-0 flex-1 flex-col">
              <TabBar onSelect={setEditorTab} selected={editorTab} tabs={editorTabs} />

              <div className="flex-1 overflow-y-auto p-2">
                {editorTab === 'headers' && (
                  <KeyValueEditor
                    keyPlaceholder={s.pluginTester.headerKeyPlaceholder}
                    onRowsChange={setHeaders}
                    rows={headers}
                    valuePlaceholder={s.pluginTester.headerValuePlaceholder}
                  />
                )}

                {editorTab === 'params' && (
                  <KeyValueEditor
                    keyPlaceholder={s.pluginTester.paramKeyPlaceholder}
                    onRowsChange={setParams}
                    rows={params}
                    valuePlaceholder={s.pluginTester.paramValuePlaceholder}
                  />
                )}

                {editorTab === 'body' && (
                  <div className="space-y-2">
                    <Select onValueChange={setContentType} value={contentType}>
                      <SelectTrigger className="h-7 w-44 text-xs" size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="application/json">application/json</SelectItem>
                        <SelectItem value="application/xml">application/xml</SelectItem>
                        <SelectItem value="text/plain">text/plain</SelectItem>
                        <SelectItem value="application/x-www-form-urlencoded">
                          x-www-form-urlencoded
                        </SelectItem>
                        <SelectItem value="multipart/form-data">multipart/form-data</SelectItem>
                      </SelectContent>
                    </Select>
                    <Textarea
                      className="min-h-24 font-mono text-xs"
                      onChange={e => setBody(e.target.value)}
                      placeholder={s.pluginTester.bodyPlaceholder}
                      value={body}
                    />
                  </div>
                )}

                {editorTab === 'auth' && (
                  <div className="space-y-3">
                    <Select
                      onValueChange={value =>
                        setAuth({ ...auth, type: value as PluginTesterAuth['type'] })
                      }
                      value={auth.type}
                    >
                      <SelectTrigger className="h-7 w-32 text-xs" size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {AUTH_TYPES.map(t => (
                          <SelectItem key={t} value={t}>
                            {t === 'none'
                              ? s.pluginTester.authTypeNone
                              : t === 'bearer'
                                ? s.pluginTester.authTypeBearer
                                : t === 'basic'
                                  ? s.pluginTester.authTypeBasic
                                  : s.pluginTester.authTypeApiKey}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {auth.type === 'bearer' && (
                      <Input
                        className="font-mono text-xs"
                        onChange={e => setAuth({ ...auth, token: e.target.value })}
                        placeholder={s.pluginTester.authTokenPlaceholder}
                        size="sm"
                        value={auth.token ?? ''}
                      />
                    )}

                    {auth.type === 'basic' && (
                      <>
                        <Input
                          className="font-mono text-xs"
                          onChange={e => setAuth({ ...auth, username: e.target.value })}
                          placeholder={s.pluginTester.authUsernameLabel}
                          size="sm"
                          value={auth.username ?? ''}
                        />
                        <Input
                          className="font-mono text-xs"
                          onChange={e => setAuth({ ...auth, password: e.target.value })}
                          placeholder={s.pluginTester.authPasswordLabel}
                          size="sm"
                          type="password"
                          value={auth.password ?? ''}
                        />
                      </>
                    )}

                    {auth.type === 'apikey' && (
                      <>
                        <Input
                          className="font-mono text-xs"
                          onChange={e => setAuth({ ...auth, key: e.target.value })}
                          placeholder={s.pluginTester.authKeyLabel}
                          size="sm"
                          value={auth.key ?? ''}
                        />
                        <Input
                          className="font-mono text-xs"
                          onChange={e => setAuth({ ...auth, value: e.target.value })}
                          placeholder={s.pluginTester.authValueLabel}
                          size="sm"
                          value={auth.value ?? ''}
                        />
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          Add to:
                          <select
                            className="rounded-md border border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) px-1.5 py-0.5 text-xs"
                            onChange={e =>
                              setAuth({ ...auth, addTo: e.target.value as 'header' | 'query' })
                            }
                            value={auth.addTo ?? 'header'}
                          >
                            <option value="header">{s.pluginTester.authAddToHeader}</option>
                            <option value="query">{s.pluginTester.authAddToQuery}</option>
                          </select>
                        </label>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* -------- Response viewer -------- */}
            <div className="flex min-h-0 flex-1 flex-col border-t border-(--ui-stroke-secondary) pt-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">
                    {s.pluginTester.responseHeading}
                  </span>
                  {response && (
                    <>
                      <Badge className={STATUS_COLOR(response.status)} variant="default">
                        {response.status} {response.statusText}
                      </Badge>
                      <span className="text-[0.62rem] tabular-nums text-muted-foreground/60">
                        {ttfb > 0 && `${s.pluginTester.timingTtfb}: ${ttfb}ms`}
                        {totalMs > 0 && ` | ${s.pluginTester.timingTotal}: ${totalMs}ms`}
                      </span>
                      <span className="text-[0.62rem] tabular-nums text-muted-foreground/60">
                        {s.pluginTester.responseSize}: {response.size} B
                      </span>
                    </>
                  )}
                  {responseError && (
                    <Badge className={STATUS_COLOR(0)} variant="default">
                      {responseError}
                    </Badge>
                  )}
                </div>
              </div>

              {!response && !responseError ? (
                <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/50">
                  {s.pluginTester.noResponse}
                </div>
              ) : response ? (
                <>
                  <TabBar onSelect={setResponseTab} selected={responseTab} tabs={responseTabs} />
                  <div className="flex-1 overflow-y-auto p-2">
                    {responseTab === 'body' && (
                      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground/85">
                        {response.body}
                      </pre>
                    )}
                    {responseTab === 'headers' && (
                      <div className="space-y-0.5">
                        {Object.entries(response.headers).map(([key, value]) => (
                          <div className="flex gap-2 text-xs" key={key}>
                            <span className="font-medium text-foreground/70">{key}:</span>
                            <span className="text-foreground/85">{value}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {responseTab === 'cookies' && (
                      <div className="space-y-1">
                        {response.cookies.length === 0 ? (
                          <span className="text-xs text-muted-foreground/50">No cookies</span>
                        ) : (
                          response.cookies.map((cookie, idx) => (
                            <div className="flex gap-2 text-xs" key={idx}>
                              <span className="font-medium text-foreground/70">
                                {cookie.name}:
                              </span>
                              <span className="text-foreground/85">{cookie.value}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </DetailColumn>
      </MasterDetail>

      {/* ---- History pane (below) ---- */}
      <div className="border-t border-(--ui-stroke-secondary)">
        <div className="flex h-8 items-center gap-2 px-3">
          <button
            className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground/70 hover:text-foreground"
            onClick={() => setHistoryPaneOpen(o => !o)}
            type="button"
          >
            <Codicon
              name={historyPaneOpen ? 'chevron-down' : 'chevron-right'}
              size="0.75rem"
            />
            {s.pluginTester.historyHeading}
          </button>
          {historyPaneOpen && history.length > 0 && (
            <Button
              className="ml-auto"
              onClick={() => void handleClearHistory()}
              size="sm"
              variant="ghost"
            >
              {s.pluginTester.clearHistory}
            </Button>
          )}
        </div>

        {historyPaneOpen && (
          <div className="max-h-48 overflow-y-auto">
            {historyLoading && history.length === 0 ? (
              <PageLoader label={s.pluginTester.historyLoading} />
            ) : historyError && history.length === 0 ? (
              <PanelEmpty
                action={
                  <Button onClick={() => void loadHistory()} size="sm" variant="outline">
                    {s.refresh}
                  </Button>
                }
                description={historyError}
                icon="error"
                title={s.pluginTester.historyFailed}
              />
            ) : history.length === 0 ? (
              <PanelEmpty description={s.pluginTester.historyEmpty} icon="history" title="" />
            ) : (
              history.map(entry => (
                <PanelListRow
                  active={false}
                  dotClassName={
                    entry.status >= 200 && entry.status < 300
                      ? 'bg-emerald-500'
                      : entry.status >= 400
                        ? 'bg-red-500'
                        : 'bg-muted-foreground/50'
                  }
                  key={entry.id}
                  meta={
                    <span className="tabular-nums">
                      {s.pluginTester.historyEntryDuration(entry.duration)}
                    </span>
                  }
                  onSelect={() => void loadHistoryEntry(entry)}
                  title={
                    <span className="flex items-center gap-1.5">
                      <span
                        className={`rounded px-1 py-px text-[0.6rem] font-medium ${METHOD_COLORS[entry.method] ?? 'bg-muted-foreground/10 text-muted-foreground'}`}
                      >
                        {s.pluginTester.historyEntryMethod(entry.method)}
                      </span>
                      <span className="truncate">{entry.url}</span>
                    </span>
                  }
                />
              ))
            )}
          </div>
        )}
      </div>

      {/* ---- Create Collection dialog ---- */}
      <Dialog
        onOpenChange={next => !collectionSaving && !next && setCollectionDialogOpen(false)}
        open={collectionDialogOpen}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{s.pluginTester.createCollection}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <label className="grid gap-1 text-xs font-medium text-foreground">
              {s.pluginTester.collectionNameLabel}
              <Input
                autoFocus
                disabled={collectionSaving}
                onChange={e => setCollectionName(e.target.value)}
                placeholder={s.pluginTester.collectionNamePlaceholder}
                value={collectionName}
              />
            </label>
            <label className="grid gap-1 text-xs font-medium text-foreground">
              {s.pluginTester.collectionDescriptionLabel}
              <Input
                disabled={collectionSaving}
                onChange={e => setCollectionDescription(e.target.value)}
                placeholder={s.pluginTester.collectionDescriptionPlaceholder}
                value={collectionDescription}
              />
            </label>
          </div>
          <DialogFooter>
            <Button
              disabled={collectionSaving}
              onClick={() => setCollectionDialogOpen(false)}
              variant="outline"
            >
              {s.cancel}
            </Button>
            <Button
              disabled={collectionSaving || !collectionName.trim()}
              onClick={() => void handleCreateCollection()}
              variant="default"
            >
              {collectionSaving ? s.creating : s.create}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Create/Edit Environment dialog ---- */}
      <Dialog
        onOpenChange={next => !envSaving && !next && setEnvDialogOpen(false)}
        open={envDialogOpen}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{s.pluginTester.createEnvironment}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <label className="grid gap-1 text-xs font-medium text-foreground">
              {s.pluginTester.environmentNameLabel}
              <Input
                autoFocus
                disabled={envSaving}
                onChange={e => setEnvName(e.target.value)}
                placeholder={s.pluginTester.environmentNamePlaceholder}
                value={envName}
              />
            </label>
            <div className="space-y-1">
              <span className="text-xs font-medium text-foreground/80">Variables</span>
              <KeyValueEditor
                keyPlaceholder={s.pluginTester.variableKeyPlaceholder}
                onRowsChange={setEnvVariables}
                rows={envVariables}
                valuePlaceholder={s.pluginTester.variableValuePlaceholder}
              />
            </div>
          </div>
          <DialogFooter>
            <Button disabled={envSaving} onClick={() => setEnvDialogOpen(false)} variant="outline">
              {s.cancel}
            </Button>
            <Button
              disabled={envSaving || !envName.trim()}
              onClick={() => void handleCreateEnvironment()}
              variant="default"
            >
              {envSaving ? s.creating : s.create}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
