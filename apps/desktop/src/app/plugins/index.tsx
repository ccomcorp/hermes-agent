/**
 * Plugins — manage + hub for agent plugins.
 *
 * Functional spec: web `src/pages/PluginsPage.tsx`. Capabilities ported:
 *  - hub load (`GET /api/dashboard/plugins/hub`) -> rows + providers + orphans
 *  - rescan from disk (`GET /api/dashboard/plugins/rescan`)
 *  - install from identifier (`POST /api/dashboard/agent-plugins/install`)
 *  - enable / disable runtime, git update, remove (per-row actions)
 *  - hide / show a dashboard plugin in the sidebar
 *  - choose memory + context providers (`PUT /api/dashboard/plugin-providers`)
 *
 * Desktop-styled: flat rows (no card-in-card), shared primitives (Button,
 * Badge, Codicon, Switch, Input, Select, Dialog, LogView, PageSearchShell),
 * tokens not literals, and the standard PAGE_INSET_X gutter. API calls live in
 * ./api, mirroring src/hermes.ts's request helper.
 */
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { LogView } from '@/components/ui/log-view'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { PAGE_INSET_X } from '../layout-constants'
import { PageSearchShell } from '../page-search-shell'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import {
  type AgentPluginInstallResponse,
  disableAgentPlugin,
  enableAgentPlugin,
  getPluginsHub,
  type HubAgentPluginRow,
  installAgentPlugin,
  type PluginManifest,
  type PluginRuntimeStatus,
  type PluginsHubProviders,
  removeAgentPlugin,
  rescanPlugins,
  savePluginProviders,
  setPluginVisibility,
  updateAgentPlugin
} from './api'
import { CONTEXT_ENGINE_DEFAULT, MEMORY_PROVIDER_BUILTIN, pluginsStrings as s } from './strings'

function pluginLabel(row: HubAgentPluginRow): string {
  return row.dashboard_manifest?.label?.trim() || row.name
}

function matchesQuery(row: HubAgentPluginRow, q: string): boolean {
  if (!q) {
    return true
  }

  const needle = q.toLowerCase()

  return [row.name, row.description, row.source, row.version, row.runtime_status].some(value =>
    value?.toLowerCase().includes(needle)
  )
}

const STATUS_TONE: Record<PluginRuntimeStatus, 'default' | 'destructive' | 'muted'> = {
  enabled: 'default',
  disabled: 'destructive',
  inactive: 'muted'
}

interface PluginsViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup: SetStatusbarItemGroup
}

export function PluginsView({ setStatusbarItemGroup, ...props }: PluginsViewProps) {
  const [rows, setRows] = useState<HubAgentPluginRow[] | null>(null)
  const [orphans, setOrphans] = useState<PluginManifest[]>([])
  const [providers, setProviders] = useState<PluginsHubProviders | null>(null)
  const [query, setQuery] = useState('')
  const [rescanning, setRescanning] = useState(false)

  // Install form
  const [installId, setInstallId] = useState('')
  const [installForce, setInstallForce] = useState(false)
  const [installEnable, setInstallEnable] = useState(true)
  const [installBusy, setInstallBusy] = useState(false)

  // Provider selection
  const [memorySel, setMemorySel] = useState(MEMORY_PROVIDER_BUILTIN)
  const [contextSel, setContextSel] = useState(CONTEXT_ENGINE_DEFAULT)
  const [providerBusy, setProviderBusy] = useState(false)

  // Per-row in-flight action + remove confirmation
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<HubAgentPluginRow | null>(null)
  const [removing, setRemoving] = useState(false)

  const applyHub = useCallback((hub: Awaited<ReturnType<typeof getPluginsHub>>) => {
    setRows(hub.plugins)
    setOrphans(hub.orphan_dashboard_plugins)
    setProviders(hub.providers)
    setMemorySel(hub.providers.memory_provider || MEMORY_PROVIDER_BUILTIN)
    setContextSel(hub.providers.context_engine || CONTEXT_ENGINE_DEFAULT)
  }, [])

  const loadHub = useCallback(async () => {
    try {
      applyHub(await getPluginsHub())
    } catch (err) {
      notifyError(err, s.loadFailed)
    }
  }, [applyHub])

  const rescan = useCallback(async () => {
    setRescanning(true)

    try {
      const res = await rescanPlugins()
      applyHub(await getPluginsHub())
      notify({ kind: 'success', title: s.refresh, message: s.rescanDone(res.count) })
    } catch (err) {
      notifyError(err, s.rescanFailed)
    } finally {
      setRescanning(false)
    }
  }, [applyHub])

  useRefreshHotkey(rescan)

  useEffect(() => {
    void loadHub()
  }, [loadHub])

  useEffect(() => {
    setStatusbarItemGroup('plugins', [])

    return () => setStatusbarItemGroup('plugins', [])
  }, [setStatusbarItemGroup])

  const visibleRows = useMemo(() => (rows ?? []).filter(row => matchesQuery(row, query.trim())), [rows, query])

  async function handleInstall() {
    const identifier = installId.trim()

    if (!identifier) {
      notify({ kind: 'error', title: s.installFailed, message: s.installHintRequired })

      return
    }

    setInstallBusy(true)

    try {
      const res: AgentPluginInstallResponse = await installAgentPlugin({
        identifier,
        force: installForce,
        enable: installEnable
      })

      notify({ kind: 'success', title: s.install, message: s.installed(res.plugin_name ?? identifier) })

      if ((res.warnings?.length ?? 0) > 0) {
        notify({ kind: 'warning', title: s.install, message: res.warnings!.join(' ') })
      }

      if ((res.missing_env?.length ?? 0) > 0) {
        notify({ kind: 'warning', title: s.missingEnvWarn, message: res.missing_env!.join(', ') })
      }

      setInstallId('')
      await loadHub()
    } catch (err) {
      notifyError(err, s.installFailed)
    } finally {
      setInstallBusy(false)
    }
  }

  async function handleSaveProviders() {
    setProviderBusy(true)

    try {
      await savePluginProviders({
        memory_provider: memorySel === MEMORY_PROVIDER_BUILTIN ? '' : memorySel,
        context_engine: contextSel
      })
      notify({ kind: 'success', title: s.providersHeading, message: s.savedProviders })
      await loadHub()
    } catch (err) {
      notifyError(err, s.saveProvidersFailed)
    } finally {
      setProviderBusy(false)
    }
  }

  async function runRowAction(row: HubAgentPluginRow, action: () => Promise<void>) {
    setRowBusy(row.name)

    try {
      await action()
      await loadHub()
    } catch (err) {
      notifyError(err, s.actionFailed)
    } finally {
      setRowBusy(null)
    }
  }

  function handleEnable(row: HubAgentPluginRow) {
    void runRowAction(row, async () => {
      await enableAgentPlugin(row.name)
      notify({ kind: 'success', title: s.enableRuntime, message: s.enabledRuntime(pluginLabel(row)) })
    })
  }

  function handleDisable(row: HubAgentPluginRow) {
    void runRowAction(row, async () => {
      await disableAgentPlugin(row.name)
      notify({ kind: 'success', title: s.disableRuntime, message: s.disabledRuntime(pluginLabel(row)) })
    })
  }

  function handleUpdate(row: HubAgentPluginRow) {
    void runRowAction(row, async () => {
      const res = await updateAgentPlugin(row.name)
      notify({
        kind: 'success',
        title: s.updateGit,
        message: res.unchanged ? s.updateUnchanged(pluginLabel(row)) : s.updated(pluginLabel(row))
      })
    })
  }

  function handleToggleVisibility(row: HubAgentPluginRow) {
    void runRowAction(row, async () => {
      await setPluginVisibility(row.name, !row.user_hidden)
    })
  }

  async function handleConfirmRemove() {
    if (!removeTarget) {
      return
    }

    const target = removeTarget
    setRemoving(true)

    try {
      await removeAgentPlugin(target.name)
      notify({ kind: 'success', title: s.remove, message: s.removed(pluginLabel(target)) })
      setRemoveTarget(null)
      await loadHub()
    } catch (err) {
      notifyError(err, s.actionFailed)
    } finally {
      setRemoving(false)
    }
  }

  const loaded = rows !== null
  const hasAny = (rows?.length ?? 0) > 0

  return (
    <PageSearchShell
      {...props}
      onSearchChange={setQuery}
      searchHidden={!hasAny}
      searchPlaceholder={s.search}
      searchTrailingAction={
        <Button
          aria-label={rescanning ? s.refreshing : s.refresh}
          className="text-(--ui-text-tertiary) hover:bg-transparent hover:text-foreground"
          disabled={rescanning}
          onClick={() => void rescan()}
          size="icon-xs"
          title={rescanning ? s.refreshing : s.refresh}
          type="button"
          variant="ghost"
        >
          <Codicon name="refresh" size="0.875rem" spinning={rescanning} />
        </Button>
      }
      searchValue={query}
    >
      {!loaded ? (
        <PageLoader label={s.loading} />
      ) : (
        <div className={cn('h-full overflow-y-auto py-3', PAGE_INSET_X)}>
          <div className="mx-auto w-full max-w-3xl space-y-10">
            {providers && (
              <ProvidersSection
                busy={providerBusy}
                contextSel={contextSel}
                memorySel={memorySel}
                onContextChange={setContextSel}
                onMemoryChange={setMemorySel}
                onSave={() => void handleSaveProviders()}
                providers={providers}
              />
            )}

            <InstallSection
              busy={installBusy}
              enable={installEnable}
              force={installForce}
              identifier={installId}
              onEnableChange={setInstallEnable}
              onForceChange={setInstallForce}
              onIdentifierChange={setInstallId}
              onInstall={() => void handleInstall()}
            />

            <Section count={rows?.length ?? 0} icon="extensions" title={s.pluginListHeading}>
              {visibleRows.length === 0 ? (
                <EmptyRow text={hasAny ? s.noMatches : s.emptyDesc} />
              ) : (
                visibleRows.map(row => (
                  <PluginRow
                    busy={rowBusy === row.name}
                    key={row.name}
                    onDisable={() => handleDisable(row)}
                    onEnable={() => handleEnable(row)}
                    onRemove={() => setRemoveTarget(row)}
                    onToggleVisibility={() => handleToggleVisibility(row)}
                    onUpdate={() => handleUpdate(row)}
                    row={row}
                  />
                ))
              )}
            </Section>

            {orphans.length > 0 && (
              <Section count={orphans.length} icon="browser" title={s.orphanHeading}>
                <p className="pb-1 text-xs text-muted-foreground">{s.orphanHint}</p>
                {orphans.map(manifest => (
                  <OrphanRow key={manifest.name} manifest={manifest} />
                ))}
              </Section>
            )}
          </div>
        </div>
      )}

      <Dialog onOpenChange={open => !open && !removing && setRemoveTarget(null)} open={removeTarget !== null}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{s.removeTitle}</DialogTitle>
            <DialogDescription>{removeTarget ? s.removeDesc(pluginLabel(removeTarget)) : s.removeDesc('')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={removing} onClick={() => setRemoveTarget(null)} variant="outline">
              {s.cancel}
            </Button>
            <Button disabled={removing} onClick={() => void handleConfirmRemove()} variant="destructive">
              {removing ? s.removing : s.removeConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSearchShell>
  )
}

function ProvidersSection({
  busy,
  contextSel,
  memorySel,
  onContextChange,
  onMemoryChange,
  onSave,
  providers
}: {
  busy: boolean
  contextSel: string
  memorySel: string
  onContextChange: (value: string) => void
  onMemoryChange: (value: string) => void
  onSave: () => void
  providers: PluginsHubProviders
}) {
  // The default context engine is always offered; de-dupe so a plugin that
  // declares "compressor" doesn't render it twice.
  const contextOptions = providers.context_options.filter(option => option.name !== CONTEXT_ENGINE_DEFAULT)

  return (
    <Section icon="settings-gear" title={s.providersHeading}>
      <p className="pb-2 text-xs text-muted-foreground">{s.providersHint}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field htmlFor="plugins-memory" label={s.memoryProviderLabel}>
          <Select onValueChange={onMemoryChange} value={memorySel}>
            <SelectTrigger id="plugins-memory">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={MEMORY_PROVIDER_BUILTIN}>{`(${s.providerDefault})`}</SelectItem>
              {providers.memory_options.map(option => (
                <SelectItem key={option.name} value={option.name}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field htmlFor="plugins-context" label={s.contextEngineLabel}>
          <Select onValueChange={onContextChange} value={contextSel}>
            <SelectTrigger id="plugins-context">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CONTEXT_ENGINE_DEFAULT}>{CONTEXT_ENGINE_DEFAULT}</SelectItem>
              {contextOptions.map(option => (
                <SelectItem key={option.name} value={option.name}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="pt-3">
        <Button disabled={busy} onClick={onSave} size="sm">
          {busy ? <Codicon name="loading" size="0.875rem" spinning /> : null}
          {busy ? s.saving : s.save}
        </Button>
      </div>
    </Section>
  )
}

function InstallSection({
  busy,
  enable,
  force,
  identifier,
  onEnableChange,
  onForceChange,
  onIdentifierChange,
  onInstall
}: {
  busy: boolean
  enable: boolean
  force: boolean
  identifier: string
  onEnableChange: (value: boolean) => void
  onForceChange: (value: boolean) => void
  onIdentifierChange: (value: string) => void
  onInstall: () => void
}) {
  return (
    <Section icon="cloud-download" title={s.installHeading}>
      <p className="pb-2 text-xs text-muted-foreground">{s.installHint}</p>
      <Field htmlFor="plugins-install-id" label={s.identifierLabel}>
        <Input
          className="font-mono lowercase"
          id="plugins-install-id"
          onChange={event => onIdentifierChange(event.target.value)}
          placeholder={s.identifierPlaceholder}
          spellCheck={false}
          value={identifier}
        />
      </Field>

      <div className="mt-3 flex flex-wrap items-center gap-x-8 gap-y-3">
        <ToggleRow checked={force} label={s.forceReinstall} onCheckedChange={onForceChange} />
        <ToggleRow checked={enable} label={s.enableAfterInstall} onCheckedChange={onEnableChange} />
      </div>

      <div className="pt-3">
        <Button disabled={busy} onClick={onInstall} size="sm">
          {busy ? <Codicon name="loading" size="0.875rem" spinning /> : <Codicon name="add" size="0.875rem" />}
          {busy ? s.installing : s.install}
        </Button>
      </div>
    </Section>
  )
}

function ToggleRow({
  checked,
  label,
  onCheckedChange
}: {
  checked: boolean
  label: string
  onCheckedChange: (value: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5">
      <Switch aria-label={label} checked={checked} onCheckedChange={onCheckedChange} size="xs" />
      <span className="text-xs text-(--ui-text-secondary)">{label}</span>
    </label>
  )
}

function PluginRow({
  busy,
  onDisable,
  onEnable,
  onRemove,
  onToggleVisibility,
  onUpdate,
  row
}: {
  busy: boolean
  onDisable: () => void
  onEnable: () => void
  onRemove: () => void
  onToggleVisibility: () => void
  onUpdate: () => void
  row: HubAgentPluginRow
}) {
  const enabled = row.runtime_status === 'enabled'

  return (
    <div className={cn('grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start', busy && 'opacity-60')}>
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{row.name}</span>
          <Badge variant="outline">
            {s.sourceLabel}: {row.source}
          </Badge>
          <Badge variant="outline">v{row.version || '—'}</Badge>
          <Badge variant={STATUS_TONE[row.runtime_status]}>{row.runtime_status}</Badge>
          {row.auth_required && <Badge variant="destructive">{s.authRequired}</Badge>}
        </div>

        {row.description && <p className="text-xs text-muted-foreground">{row.description}</p>}

        {row.dashboard_manifest?.slots?.length ? (
          <p className="text-xs text-(--ui-text-tertiary)">
            {s.dashboardSlots}: {row.dashboard_manifest.slots.join(', ')}
          </p>
        ) : null}

        {!row.has_dashboard_manifest && !row.dashboard_manifest && (
          <p className="text-xs italic text-(--ui-text-tertiary)">{s.noDashboardTab}</p>
        )}

        {row.auth_required && row.auth_command && (
          <div className="space-y-1 pt-0.5">
            <p className="text-xs text-muted-foreground">{s.authRequiredHint}</p>
            <LogView>{row.auth_command}</LogView>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 sm:justify-self-end">
        {enabled ? (
          <Button disabled={busy} onClick={onDisable} size="sm" variant="ghost">
            {s.disableRuntime}
          </Button>
        ) : (
          <Button disabled={busy} onClick={onEnable} size="sm" variant="ghost">
            {s.enableRuntime}
          </Button>
        )}

        {row.can_update_git && (
          <Button disabled={busy} onClick={onUpdate} size="sm" variant="outline">
            <Codicon name="sync" size="0.875rem" />
            {s.updateGit}
          </Button>
        )}

        {row.has_dashboard_manifest && (
          <Button
            aria-label={row.user_hidden ? s.showInSidebar : s.hideFromSidebar}
            disabled={busy}
            onClick={onToggleVisibility}
            size="icon-sm"
            title={row.user_hidden ? s.showInSidebar : s.hideFromSidebar}
            variant="ghost"
          >
            <Codicon name={row.user_hidden ? 'eye-closed' : 'eye'} size="0.875rem" />
          </Button>
        )}

        {row.can_remove && (
          <Button
            aria-label={s.remove}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            disabled={busy}
            onClick={onRemove}
            size="icon-sm"
            title={s.remove}
            variant="ghost"
          >
            <Codicon name="trash" size="0.875rem" />
          </Button>
        )}
      </div>
    </div>
  )
}

function OrphanRow({ manifest }: { manifest: PluginManifest }) {
  const detail = manifest.description || manifest.tab?.path || ''

  return (
    <div className="py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">{manifest.label || manifest.name}</span>
        <Badge variant="outline">{manifest.source}</Badge>
      </div>
      {detail && <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p>}
    </div>
  )
}

function Section({
  children,
  count,
  icon,
  title
}: {
  children: React.ReactNode
  count?: number
  icon: string
  title: string
}) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2 pb-1">
        <Codicon className="text-muted-foreground" name={icon} size="0.9rem" />
        <span className="text-[length:var(--conversation-text-font-size)] font-medium text-foreground">{title}</span>
        {typeof count === 'number' && <Badge variant="muted">{count}</Badge>}
      </div>
      <div>{children}</div>
    </section>
  )
}

function Field({
  children,
  htmlFor,
  label
}: {
  children: React.ReactNode
  htmlFor: string
  label: string
}) {
  return (
    <div className="grid gap-1.5">
      <label className="text-xs font-medium text-foreground" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  )
}

function EmptyRow({ text }: { text: string }) {
  return <div className="py-6 text-center text-xs text-muted-foreground">{text}</div>
}
