/**
 * System — host/system health and operations admin view.
 *
 * Functional spec: web `src/pages/SystemPage.tsx`. Capability ported:
 *  - host/system stats incl. Hermes version + update status (`GET /api/system/stats`,
 *    `GET /api/hermes/update/check`, `POST /api/hermes/update`)
 *  - Nous Portal login + routing status (`GET /api/portal`)
 *  - skill curator pause/resume/run (`GET /api/curator`, `PUT /api/curator/paused`,
 *    `POST /api/curator/run`)
 *  - gateway start/stop/restart (`POST /api/gateway/{start,stop,restart}`)
 *  - built-in memory provider + reset (`GET /api/memory`, `POST /api/memory/reset`)
 *  - credential pool add/remove (`GET/POST/DELETE /api/credentials/pool`)
 *  - operations (doctor / audit / backup / import / skills update / prompt size /
 *    dump / config migrate) (`POST /api/ops/*`, `POST /api/skills/hub/update`)
 *  - debug share with copyable paste URLs (`POST /api/ops/debug-share`)
 *  - rollback checkpoints prune (`GET /api/ops/checkpoints`, `POST .../prune`)
 *  - shell hooks list / create / delete (`GET/POST/DELETE /api/ops/hooks`)
 *
 * Desktop-styled: flat sections (no card-in-card), shared primitives (Button,
 * Badge, Input, Switch, Codicon, Dialog, LogView), tokens not literals, and the
 * standard PAGE_INSET_X gutter. Spawn-based ops surface their live log via the
 * shared ActionLogViewer.
 */
import type * as React from 'react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'

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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { PAGE_INSET_X } from '../layout-constants'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { ActionLogViewer } from './action-log-viewer'
import {
  type ActionResponse,
  addCredentialPoolEntry,
  checkHermesUpdate,
  type CheckpointsResponse,
  createHook,
  type CredentialPoolProvider,
  type CuratorStatus,
  type DebugShareResponse,
  deleteHook,
  getCheckpoints,
  getCredentialPool,
  getCurator,
  getHooks,
  getMemory,
  getPortal,
  getStatus,
  getSystemStats,
  type HookEntry,
  type HooksResponse,
  type MemoryStatus,
  type PortalStatus,
  pruneCheckpoints,
  removeCredentialPoolEntry,
  resetMemory,
  restartGateway,
  runBackup,
  runConfigMigrate,
  runCurator,
  runDebugShare,
  runDoctor,
  runDump,
  runImport,
  runPromptSize,
  runSecurityAudit,
  setCuratorPaused,
  startGateway,
  type StatusResponse,
  stopGateway,
  type SystemStats,
  type UpdateCheckResponse,
  updateHermes,
  updateSkillsFromHub
} from './api'
import { systemStrings as s } from './strings'

const HOOK_EVENTS_FALLBACK = [
  'pre_tool_call',
  'post_tool_call',
  'pre_llm_call',
  'post_llm_call',
  'on_session_start',
  'on_session_end'
]

function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`
  }

  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`
  }

  if (n < 1024 * 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
  }

  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)

  if (d > 0) {
    return `${d}d ${h}h ${m}m`
  }

  if (h > 0) {
    return `${h}h ${m}m`
  }

  return `${m}m`
}

type MemoryResetTarget = 'all' | 'memory' | 'user'

interface SystemViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

export function SystemView({ setStatusbarItemGroup, className, ...props }: SystemViewProps) {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [stats, setStats] = useState<SystemStats | null>(null)
  const [memory, setMemory] = useState<MemoryStatus | null>(null)
  const [pool, setPool] = useState<CredentialPoolProvider[]>([])
  const [checkpoints, setCheckpoints] = useState<CheckpointsResponse | null>(null)
  const [hooks, setHooks] = useState<HooksResponse | null>(null)
  const [curator, setCurator] = useState<CuratorStatus | null>(null)
  const [portal, setPortal] = useState<PortalStatus | null>(null)
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResponse | null>(null)
  const [loaded, setLoaded] = useState(false)

  const [activeAction, setActiveAction] = useState<string | null>(null)

  // Add-credential form.
  const [credProvider, setCredProvider] = useState('openrouter')
  const [credKey, setCredKey] = useState('')
  const [credLabel, setCredLabel] = useState('')
  const [addingCred, setAddingCred] = useState(false)

  const [importPath, setImportPath] = useState('')

  // Update check / apply.
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateConfirmOpen, setUpdateConfirmOpen] = useState(false)

  // Debug share.
  const [shareRedact, setShareRedact] = useState(true)
  const [sharing, setSharing] = useState(false)
  const [shareResult, setShareResult] = useState<DebugShareResponse | null>(null)
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null)

  // Destructive confirms.
  const [memoryResetTarget, setMemoryResetTarget] = useState<MemoryResetTarget | null>(null)
  const [resettingMemory, setResettingMemory] = useState(false)
  const [credRemoveTarget, setCredRemoveTarget] = useState<{ provider: string; index: number } | null>(null)
  const [removingCred, setRemovingCred] = useState(false)
  const [pruneConfirm, setPruneConfirm] = useState(false)
  const [pruning, setPruning] = useState(false)
  const [hookRemoveTarget, setHookRemoveTarget] = useState<HookEntry | null>(null)
  const [removingHook, setRemovingHook] = useState(false)

  // Create-hook dialog.
  const [hookDialogOpen, setHookDialogOpen] = useState(false)
  const [hookEvent, setHookEvent] = useState('pre_tool_call')
  const [hookCommand, setHookCommand] = useState('')
  const [hookMatcher, setHookMatcher] = useState('')
  const [hookTimeout, setHookTimeout] = useState('')
  const [hookApprove, setHookApprove] = useState(true)
  const [creatingHook, setCreatingHook] = useState(false)

  const loadAll = useCallback(async () => {
    const [st, sy, me, pl, cp, hk, cu, pt, up] = await Promise.allSettled([
      getStatus(),
      getSystemStats(),
      getMemory(),
      getCredentialPool(),
      getCheckpoints(),
      getHooks(),
      getCurator(),
      getPortal(),
      // Cached (non-forced) check so the version row shows update status on load
      // without a forced network round-trip.
      checkHermesUpdate(false)
    ])

    if (st.status === 'fulfilled') {
      setStatus(st.value)
    }

    if (sy.status === 'fulfilled') {
      setStats(sy.value)
    }

    if (me.status === 'fulfilled') {
      setMemory(me.value)
    }

    if (pl.status === 'fulfilled') {
      setPool(pl.value)
    }

    if (cp.status === 'fulfilled') {
      setCheckpoints(cp.value)
    }

    if (hk.status === 'fulfilled') {
      setHooks(hk.value)
    }

    if (cu.status === 'fulfilled') {
      setCurator(cu.value)
    }

    if (pt.status === 'fulfilled') {
      setPortal(pt.value)
    }

    if (up.status === 'fulfilled') {
      setUpdateInfo(up.value)
    }

    setLoaded(true)
  }, [])

  useRefreshHotkey(loadAll)

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  useEffect(() => {
    setStatusbarItemGroup?.('system', [])

    return () => setStatusbarItemGroup?.('system', [])
  }, [setStatusbarItemGroup])

  // ── Gateway lifecycle ──────────────────────────────────────────────
  const runGateway = useCallback(
    async (verb: 'restart' | 'start' | 'stop') => {
      try {
        const action =
          verb === 'start'
            ? await startGateway()
            : verb === 'stop'
              ? await stopGateway()
              : await restartGateway()

        setActiveAction(action.name ?? `gateway-${verb}`)
        notify({ kind: 'success', message: s.gatewayStartedToast(verb) })
        setTimeout(() => void loadAll(), 3000)
      } catch (err) {
        notifyError(err, s.gatewayFailedToast(verb))
      }
    },
    [loadAll]
  )

  // ── Curator ────────────────────────────────────────────────────────
  const toggleCuratorPaused = useCallback(async () => {
    if (!curator) {
      return
    }

    try {
      await setCuratorPaused(!curator.paused)
      notify({ kind: 'success', message: curator.paused ? s.curatorResumedToast : s.curatorPausedToast })
      await loadAll()
    } catch (err) {
      notifyError(err, s.curatorToggleFailed)
    }
  }, [curator, loadAll])

  // ── Operations (fire-and-forget spawn ops) ─────────────────────────
  const runOp = useCallback(async (fn: () => Promise<ActionResponse>, label: string) => {
    try {
      const res = await fn()
      setActiveAction(res.name)
      notify({ kind: 'success', message: s.opStarted(label) })
    } catch (err) {
      notifyError(err, s.opFailed(label))
    }
  }, [])

  // ── Credential pool ────────────────────────────────────────────────
  const addCredential = useCallback(async () => {
    if (!credProvider.trim() || !credKey.trim()) {
      notify({ kind: 'warning', message: s.credRequired })

      return
    }

    setAddingCred(true)

    try {
      await addCredentialPoolEntry(credProvider.trim(), credKey.trim(), credLabel.trim() || undefined)
      notify({ kind: 'success', message: s.credAddedToast })
      setCredKey('')
      setCredLabel('')
      await loadAll()
    } catch (err) {
      notifyError(err, s.credAddFailed)
    } finally {
      setAddingCred(false)
    }
  }, [credProvider, credKey, credLabel, loadAll])

  const confirmRemoveCred = useCallback(async () => {
    if (!credRemoveTarget) {
      return
    }

    setRemovingCred(true)

    try {
      await removeCredentialPoolEntry(credRemoveTarget.provider, credRemoveTarget.index)
      notify({ kind: 'success', message: s.credRemovedToast })
      setCredRemoveTarget(null)
      await loadAll()
    } catch (err) {
      notifyError(err, s.credRemoveFailed)
    } finally {
      setRemovingCred(false)
    }
  }, [credRemoveTarget, loadAll])

  // ── Memory ─────────────────────────────────────────────────────────
  const confirmResetMemory = useCallback(async () => {
    if (!memoryResetTarget) {
      return
    }

    setResettingMemory(true)

    try {
      const res = await resetMemory(memoryResetTarget)
      notify({ kind: 'success', message: s.resetDone(res.deleted.join(', ')) })
      setMemoryResetTarget(null)
      await loadAll()
    } catch (err) {
      notifyError(err, s.resetFailed)
    } finally {
      setResettingMemory(false)
    }
  }, [memoryResetTarget, loadAll])

  // ── Checkpoints ────────────────────────────────────────────────────
  const confirmPrune = useCallback(async () => {
    setPruning(true)

    try {
      const res = await pruneCheckpoints()
      setActiveAction(res.name)
      notify({ kind: 'success', message: s.checkpointsStarted })
      setPruneConfirm(false)
    } catch (err) {
      notifyError(err, s.checkpointsFailed)
    } finally {
      setPruning(false)
    }
  }, [])

  // ── Update ─────────────────────────────────────────────────────────
  const checkForUpdate = useCallback(async () => {
    setCheckingUpdate(true)

    try {
      const info = await checkHermesUpdate(true)
      setUpdateInfo(info)

      if (info.update_available) {
        notify({
          kind: 'success',
          message: info.behind && info.behind > 0 ? s.updateFoundBehind(info.behind) : s.updateFound
        })
      } else if (info.behind === 0) {
        notify({ kind: 'success', message: s.updateUpToDate })
      } else if (info.message) {
        notify({ kind: 'error', title: s.updateCheckFailed, message: info.message })
      }
    } catch (err) {
      notifyError(err, s.updateCheckFailed)
    } finally {
      setCheckingUpdate(false)
    }
  }, [])

  const applyUpdate = useCallback(async () => {
    setUpdateConfirmOpen(false)

    try {
      const resp = await updateHermes()

      if (!resp.ok && resp.error === 'docker_update_unsupported') {
        notify({
          kind: 'error',
          title: s.updateFailed,
          message: resp.message ?? "Updates don't apply inside Docker — re-pull the image instead."
        })

        return
      }

      setActiveAction(resp.name ?? 'hermes-update')
      notify({ kind: 'success', message: s.updateStarted })
    } catch (err) {
      notifyError(err, s.updateFailed)
    }
  }, [])

  // ── Debug share ────────────────────────────────────────────────────
  const copyToClipboard = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedLabel(label)
      setTimeout(() => setCopiedLabel(cur => (cur === label ? null : cur)), 1500)
    } catch {
      notify({ kind: 'error', message: s.shareCopyFailed })
    }
  }, [])

  const doDebugShare = useCallback(async () => {
    setSharing(true)
    setShareResult(null)

    try {
      const res = await runDebugShare({ redact: shareRedact })
      setShareResult(res)
      const n = Object.keys(res.urls).length
      notify({ kind: 'success', message: s.shareUploadedToast(n, res.redacted) })
    } catch (err) {
      notifyError(err, s.shareFailed)
    } finally {
      setSharing(false)
    }
  }, [shareRedact])

  // ── Hooks ──────────────────────────────────────────────────────────
  const submitHook = useCallback(async () => {
    if (!hookCommand.trim()) {
      notify({ kind: 'warning', message: s.hookCommandRequired })

      return
    }

    setCreatingHook(true)

    try {
      await createHook({
        event: hookEvent,
        command: hookCommand.trim(),
        matcher: hookMatcher.trim() || undefined,
        timeout: hookTimeout.trim() ? Number(hookTimeout) : undefined,
        approve: hookApprove
      })
      notify({ kind: 'success', message: s.hookCreatedToast })
      setHookCommand('')
      setHookMatcher('')
      setHookTimeout('')
      setHookDialogOpen(false)
      await loadAll()
    } catch (err) {
      notifyError(err, s.hookCreateFailed)
    } finally {
      setCreatingHook(false)
    }
  }, [hookEvent, hookCommand, hookMatcher, hookTimeout, hookApprove, loadAll])

  const confirmRemoveHook = useCallback(async () => {
    if (!hookRemoveTarget) {
      return
    }

    setRemovingHook(true)

    try {
      await deleteHook(hookRemoveTarget.event, hookRemoveTarget.command ?? '')
      notify({ kind: 'success', message: s.hookRemovedToast })
      setHookRemoveTarget(null)
      await loadAll()
    } catch (err) {
      notifyError(err, s.hookRemoveFailed)
    } finally {
      setRemovingHook(false)
    }
  }, [hookRemoveTarget, loadAll])

  const gatewayRunning = status?.gateway_running ?? false
  const validEvents = hooks?.valid_events?.length ? hooks.valid_events : HOOK_EVENTS_FALLBACK

  if (!loaded) {
    return (
      <section
        {...props}
        className={cn('flex h-full min-w-0 flex-col overflow-hidden bg-(--ui-chat-surface-background)', className)}
      >
        <PageLoader label={s.loading} />
      </section>
    )
  }

  return (
    <section
      {...props}
      className={cn('flex h-full min-w-0 flex-col overflow-hidden bg-(--ui-chat-surface-background)', className)}
    >
      <div className={cn('h-full overflow-y-auto pb-20 pt-[calc(var(--titlebar-height)+0.75rem)]', PAGE_INSET_X)}>
        <div className="mx-auto w-full max-w-3xl space-y-9">
          {/* Live action log */}
          {activeAction && <ActionLogViewer action={activeAction} onClose={() => setActiveAction(null)} />}

          {/* ── Host / system stats ───────────────────────────────── */}
          <Section icon="server" title={s.hostHeading}>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              <Stat label={s.statOs} value={`${stats?.os ?? '—'} ${stats?.os_release ?? ''}`} />
              <Stat label={s.statArch} value={stats?.arch ?? '—'} />
              <Stat label={s.statHost} truncate value={stats?.hostname ?? '—'} />
              <Stat label={s.statPython} value={`${stats?.python_impl ?? ''} ${stats?.python_version ?? ''}`} />
              <Stat
                label={s.statHermes}
                value={
                  <span className="flex items-center gap-2">
                    <span>v{stats?.hermes_version ?? '—'}</span>
                    {updateInfo &&
                      (updateInfo.update_available ? (
                        <Badge variant="warn">
                          {updateInfo.behind && updateInfo.behind > 0
                            ? s.updateBehind(updateInfo.behind)
                            : s.updateAvailable}
                        </Badge>
                      ) : updateInfo.behind === 0 ? (
                        <Badge variant="default">{s.updateLatest}</Badge>
                      ) : null)}
                  </span>
                }
              />
              <Stat
                icon="pulse"
                label={s.statCpu}
                value={`${stats?.cpu_count ?? '—'} ${s.cores('').trim()}${
                  typeof stats?.cpu_percent === 'number' ? ` · ${stats.cpu_percent.toFixed(0)}%` : ''
                }`}
              />
              {stats?.memory && (
                <Stat
                  label={s.statMemory}
                  value={`${formatBytes(stats.memory.used)} / ${formatBytes(stats.memory.total)} (${stats.memory.percent}%)`}
                />
              )}
              {stats?.disk && (
                <Stat
                  icon="database"
                  label={s.statDisk}
                  value={`${formatBytes(stats.disk.used)} / ${formatBytes(stats.disk.total)} (${stats.disk.percent}%)`}
                />
              )}
              {typeof stats?.uptime_seconds === 'number' && (
                <Stat label={s.statUptime} value={formatDuration(stats.uptime_seconds)} />
              )}
              {stats?.load_avg && stats.load_avg.length >= 3 && (
                <Stat label={s.statLoad} value={stats.load_avg.map(n => n.toFixed(2)).join(' / ')} />
              )}
            </div>

            {stats && !stats.psutil && <p className="mt-3 text-xs text-muted-foreground">{s.psutilHint}</p>}

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-(--ui-stroke-tertiary) pt-4">
              <Button disabled={checkingUpdate} onClick={() => void checkForUpdate()} size="sm" variant="outline">
                <Codicon name={checkingUpdate ? 'loading' : 'refresh'} size="0.875rem" spinning={checkingUpdate} />
                {s.checkForUpdates}
              </Button>
              {updateInfo?.update_available && updateInfo.can_apply && (
                <Button onClick={() => setUpdateConfirmOpen(true)} size="sm">
                  <Codicon name="cloud-download" size="0.875rem" />
                  {s.updateNow}
                </Button>
              )}
              {updateInfo && !updateInfo.can_apply && updateInfo.update_available && (
                <span className="text-xs text-muted-foreground">{s.updateWith(updateInfo.update_command)}</span>
              )}
              {updateInfo?.message && !updateInfo.update_available && (
                <span className="text-xs text-muted-foreground">{updateInfo.message}</span>
              )}
            </div>
          </Section>

          {/* ── Portal ────────────────────────────────────────────── */}
          <Section icon="globe" title={s.portalHeading}>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant={portal?.logged_in ? 'default' : 'muted'}>
                  {portal?.logged_in ? s.portalLoggedIn : s.portalLoggedOut}
                </Badge>
                {portal?.provider && (
                  <span className="text-sm text-muted-foreground">{s.portalProvider(portal.provider)}</span>
                )}
                <a
                  className="ml-auto text-xs text-primary hover:underline"
                  href={portal?.subscription_url || 'https://portal.nousresearch.com/manage-subscription'}
                  rel="noreferrer"
                  target="_blank"
                >
                  {s.portalManage}
                </a>
              </div>
              {portal?.features && portal.features.length > 0 && (
                <div className="space-y-1 border-t border-(--ui-stroke-tertiary) pt-3">
                  <div className="text-[0.62rem] font-medium uppercase tracking-wide text-muted-foreground">
                    {s.portalRouting}
                  </div>
                  {portal.features.map(f => (
                    <div className="flex items-center justify-between text-sm" key={f.label}>
                      <span>{f.label}</span>
                      <span className="text-muted-foreground">{f.state}</span>
                    </div>
                  ))}
                </div>
              )}
              {!portal?.logged_in && <p className="text-xs text-muted-foreground">{s.portalLoginHint}</p>}
            </div>
          </Section>

          {/* ── Curator ───────────────────────────────────────────── */}
          <Section icon="sparkle" title={s.curatorHeading}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant={curator?.paused ? 'warn' : curator?.enabled ? 'default' : 'muted'}>
                  {curator?.paused ? s.curatorPaused : curator?.enabled ? s.curatorActive : s.curatorDisabled}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {curator?.interval_hours ? `${s.curatorEvery(curator.interval_hours)} · ` : ''}
                  {curator?.last_run_at
                    ? s.curatorLastRun(new Date(curator.last_run_at).toLocaleString())
                    : s.curatorNeverRun}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={() => void toggleCuratorPaused()} size="sm" variant="outline">
                  {curator?.paused ? s.curatorResume : s.curatorPause}
                </Button>
                <Button onClick={() => void runOp(runCurator, s.curatorRunLabel)} size="sm" variant="outline">
                  <Codicon name="play" size="0.875rem" />
                  {s.curatorRunNow}
                </Button>
              </div>
            </div>
          </Section>

          {/* ── Gateway ───────────────────────────────────────────── */}
          <Section icon="plug" title={s.gatewayHeading}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant={gatewayRunning ? 'default' : 'muted'}>
                  {gatewayRunning ? s.gatewayRunning : s.gatewayStopped}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {status?.gateway_state ?? '—'}
                  {status?.gateway_pid ? ` · ${s.pid(status.gateway_pid)}` : ''}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button disabled={gatewayRunning} onClick={() => void runGateway('start')} size="sm">
                  <Codicon name="play" size="0.875rem" />
                  {s.gatewayStart}
                </Button>
                <Button onClick={() => void runGateway('restart')} size="sm" variant="outline">
                  <Codicon name="refresh" size="0.875rem" />
                  {s.gatewayRestart}
                </Button>
                <Button
                  className="text-amber-600 hover:bg-amber-500/10 dark:text-amber-300"
                  disabled={!gatewayRunning}
                  onClick={() => void runGateway('stop')}
                  size="sm"
                  variant="ghost"
                >
                  <Codicon name="debug-stop" size="0.875rem" />
                  {s.gatewayStop}
                </Button>
              </div>
            </div>
          </Section>

          {/* ── Memory ────────────────────────────────────────────── */}
          <Section icon="database" title={s.memoryHeading}>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {s.memoryProvider(memory?.active ?? '')}
                </span>
                <span className="ml-auto font-mono">{s.memorySetupHint}</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 border-t border-(--ui-stroke-tertiary) pt-3">
                <span className="text-xs text-muted-foreground">
                  {s.memoryBuiltin(
                    formatBytes(memory?.builtin_files.memory ?? 0),
                    formatBytes(memory?.builtin_files.user ?? 0)
                  )}
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-1">
                  <Button
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setMemoryResetTarget('memory')}
                    size="sm"
                    variant="ghost"
                  >
                    {s.resetMemoryFile}
                  </Button>
                  <Button
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setMemoryResetTarget('user')}
                    size="sm"
                    variant="ghost"
                  >
                    {s.resetUserFile}
                  </Button>
                  <Button
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setMemoryResetTarget('all')}
                    size="sm"
                    variant="ghost"
                  >
                    {s.resetAll}
                  </Button>
                </div>
              </div>
            </div>
          </Section>

          {/* ── Credential pool ───────────────────────────────────── */}
          <Section icon="key" title={s.credHeading}>
            <div className="space-y-4">
              <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-4">
                <Field label={s.credProvider}>
                  <Input onChange={e => setCredProvider(e.target.value)} placeholder="openrouter" value={credProvider} />
                </Field>
                <Field className="sm:col-span-2" label={s.credKey}>
                  <Input
                    onChange={e => setCredKey(e.target.value)}
                    placeholder="sk-…"
                    type="password"
                    value={credKey}
                  />
                </Field>
                <Field label={s.credLabel}>
                  <Input onChange={e => setCredLabel(e.target.value)} placeholder="optional" value={credLabel} />
                </Field>
              </div>
              <div className="flex justify-end">
                <Button disabled={addingCred} onClick={() => void addCredential()} size="sm">
                  {addingCred && <Codicon name="loading" size="0.875rem" spinning />}
                  {addingCred ? s.credAdding : s.credAdd}
                </Button>
              </div>
              {pool.length === 0 ? (
                <p className="text-sm text-muted-foreground">{s.credEmpty}</p>
              ) : (
                pool.map(prov => (
                  <div className="space-y-1.5" key={prov.provider}>
                    <div className="text-[0.62rem] font-medium uppercase tracking-wide text-muted-foreground">
                      {prov.provider}
                    </div>
                    {prov.entries.map(entry => (
                      <div
                        className="flex flex-wrap items-center gap-3 py-1.5"
                        key={`${prov.provider}-${entry.index}`}
                      >
                        <span className="text-sm font-medium text-foreground">{entry.label || prov.provider}</span>
                        <span className="font-mono text-xs text-muted-foreground">{entry.token_preview}</span>
                        {entry.auth_type && <Badge variant="outline">{entry.auth_type}</Badge>}
                        {entry.last_status && <Badge variant="muted">{entry.last_status}</Badge>}
                        <Button
                          aria-label={s.credRemove}
                          className="ml-auto text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => setCredRemoveTarget({ provider: prov.provider, index: entry.index })}
                          size="icon-sm"
                          title={s.credRemove}
                          variant="ghost"
                        >
                          <Codicon name="trash" size="0.875rem" />
                        </Button>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </Section>

          {/* ── Operations ────────────────────────────────────────── */}
          <Section icon="tools" title={s.opsHeading}>
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void runOp(runDoctor, s.labelDoctor)} size="sm" variant="outline">
                  <Codicon name="pulse" size="0.875rem" />
                  {s.opRunDoctor}
                </Button>
                <Button onClick={() => void runOp(runSecurityAudit, s.labelSecurityAudit)} size="sm" variant="outline">
                  <Codicon name="shield" size="0.875rem" />
                  {s.opSecurityAudit}
                </Button>
                <Button onClick={() => void runOp(() => runBackup(), s.labelBackup)} size="sm" variant="outline">
                  <Codicon name="database" size="0.875rem" />
                  {s.opBackup}
                </Button>
                <Button onClick={() => void runOp(updateSkillsFromHub, s.labelSkillsUpdate)} size="sm" variant="outline">
                  <Codicon name="refresh" size="0.875rem" />
                  {s.opUpdateSkills}
                </Button>
                <Button onClick={() => void runOp(runPromptSize, s.labelPromptSize)} size="sm" variant="outline">
                  <Codicon name="pulse" size="0.875rem" />
                  {s.opPromptSize}
                </Button>
                <Button onClick={() => void runOp(runDump, s.labelSupportDump)} size="sm" variant="outline">
                  <Codicon name="archive" size="0.875rem" />
                  {s.opSupportDump}
                </Button>
                <Button onClick={() => void runOp(runConfigMigrate, s.labelConfigMigrate)} size="sm" variant="outline">
                  <Codicon name="settings-gear" size="0.875rem" />
                  {s.opConfigMigrate}
                </Button>
              </div>

              {/* Restore from backup archive */}
              <div className="flex flex-col gap-3 border-t border-(--ui-stroke-tertiary) pt-3 sm:flex-row sm:items-end">
                <Field className="flex-1" label={s.importTitle}>
                  <Input
                    onChange={e => setImportPath(e.target.value)}
                    placeholder={s.importPlaceholder}
                    value={importPath}
                  />
                </Field>
                <Button
                  disabled={!importPath.trim()}
                  onClick={() => importPath.trim() && void runOp(() => runImport(importPath.trim()), s.labelImport)}
                  size="sm"
                  variant="outline"
                >
                  {s.importAction}
                </Button>
              </div>
            </div>
          </Section>

          {/* ── Debug share ───────────────────────────────────────── */}
          <Section icon="link" title={s.shareTitle}>
            <div className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="max-w-prose text-xs text-muted-foreground">{s.shareDesc}</p>
                <Button disabled={sharing} onClick={() => void doDebugShare()} size="sm">
                  <Codicon name={sharing ? 'loading' : 'link'} size="0.875rem" spinning={sharing} />
                  {sharing ? s.shareUploading : s.shareGenerate}
                </Button>
              </div>

              <label className="flex select-none items-center gap-2 text-xs text-muted-foreground">
                <Switch
                  aria-label={s.shareRedact}
                  checked={shareRedact}
                  disabled={sharing}
                  onCheckedChange={setShareRedact}
                  size="xs"
                />
                {s.shareRedact}
              </label>

              {shareResult && (
                <div className="space-y-2 border-t border-(--ui-stroke-tertiary) pt-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="default">{s.shareUploaded}</Badge>
                      {shareResult.redacted ? (
                        <Badge variant="outline">{s.shareRedacted}</Badge>
                      ) : (
                        <Badge variant="warn">{s.shareNotRedacted}</Badge>
                      )}
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Codicon name="clock" size="0.75rem" />
                        {s.shareAutoDelete(Math.round(shareResult.auto_delete_seconds / 3600))}
                      </span>
                    </div>
                    {Object.keys(shareResult.urls).length > 1 && (
                      <Button
                        onClick={() =>
                          void copyToClipboard(
                            Object.entries(shareResult.urls)
                              .map(([label, url]) => `${label}: ${url}`)
                              .join('\n'),
                            '__all__'
                          )
                        }
                        size="sm"
                        variant="outline"
                      >
                        <Codicon name={copiedLabel === '__all__' ? 'check' : 'copy'} size="0.875rem" />
                        {s.shareCopyAll}
                      </Button>
                    )}
                  </div>

                  {Object.entries(shareResult.urls).map(([label, url]) => (
                    <div className="flex items-center gap-2 py-1" key={label}>
                      <Codicon className="shrink-0 text-muted-foreground" name="link" size="0.875rem" />
                      <span className="w-24 shrink-0 truncate font-mono text-xs text-muted-foreground">{label}</span>
                      <a
                        className="min-w-0 flex-1 truncate font-mono text-xs text-primary hover:underline"
                        href={url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {url}
                      </a>
                      <Button
                        aria-label={s.shareCopy(label)}
                        onClick={() => void copyToClipboard(url, label)}
                        size="icon-sm"
                        title={s.shareCopy(label)}
                        variant="ghost"
                      >
                        <Codicon name={copiedLabel === label ? 'check' : 'copy'} size="0.875rem" />
                      </Button>
                    </div>
                  ))}

                  {shareResult.failures.length > 0 && (
                    <span className="text-xs text-destructive">{s.shareFailures(shareResult.failures.join('; '))}</span>
                  )}
                </div>
              )}
            </div>
          </Section>

          {/* ── Checkpoints ───────────────────────────────────────── */}
          <Section icon="history" title={s.checkpointsHeading}>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {s.checkpointsSummary(checkpoints?.sessions.length ?? 0, formatBytes(checkpoints?.total_bytes ?? 0))}
              </span>
              <Button
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                disabled={!checkpoints?.sessions.length}
                onClick={() => setPruneConfirm(true)}
                size="sm"
                variant="ghost"
              >
                <Codicon name="trash" size="0.875rem" />
                {s.checkpointsPrune}
              </Button>
            </div>
          </Section>

          {/* ── Shell hooks ───────────────────────────────────────── */}
          <Section
            action={
              <Button onClick={() => setHookDialogOpen(true)} size="sm">
                <Codicon name="add" size="0.875rem" />
                {s.hooksNew}
              </Button>
            }
            icon="terminal"
            title={s.hooksHeading}
          >
            {!hooks || hooks.hooks.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">{s.hooksEmpty}</div>
            ) : (
              <div>
                {hooks.hooks.map((h, i) => (
                  <div className="flex flex-wrap items-center gap-3 py-2" key={`${h.event}-${i}`}>
                    <Badge variant="outline">{h.event}</Badge>
                    {h.matcher && <span className="text-xs text-muted-foreground">{s.hookMatcher(h.matcher)}</span>}
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{h.command}</span>
                    {h.executable === false && <Badge variant="destructive">{s.hookNotExecutable}</Badge>}
                    <Badge variant={h.allowed ? 'default' : 'warn'}>
                      {h.allowed ? s.hookAllowed : s.hookNotApproved}
                    </Badge>
                    <Button
                      aria-label={s.hookRemove}
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setHookRemoveTarget(h)}
                      size="icon-sm"
                      title={s.hookRemove}
                      variant="ghost"
                    >
                      <Codicon name="trash" size="0.875rem" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>

      {/* ── Update confirm ──────────────────────────────────────── */}
      <Dialog onOpenChange={open => !open && setUpdateConfirmOpen(false)} open={updateConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{s.updateTitle}</DialogTitle>
            <DialogDescription>
              {updateInfo && updateInfo.behind && updateInfo.behind > 0
                ? s.updateDescCommits(updateInfo.update_command, updateInfo.behind)
                : s.updateDescGeneric(updateInfo?.update_command ?? 'hermes update')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setUpdateConfirmOpen(false)} variant="outline">
              {s.cancel}
            </Button>
            <Button onClick={() => void applyUpdate()}>{s.updateConfirm}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Memory reset confirm ────────────────────────────────── */}
      <Dialog
        onOpenChange={open => !open && !resettingMemory && setMemoryResetTarget(null)}
        open={memoryResetTarget !== null}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{s.resetMemoryTitle}</DialogTitle>
            <DialogDescription>{s.resetMemoryDesc}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={resettingMemory} onClick={() => setMemoryResetTarget(null)} variant="outline">
              {s.cancel}
            </Button>
            <Button disabled={resettingMemory} onClick={() => void confirmResetMemory()} variant="destructive">
              {resettingMemory ? s.resetting : s.resetConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Credential remove confirm ───────────────────────────── */}
      <Dialog
        onOpenChange={open => !open && !removingCred && setCredRemoveTarget(null)}
        open={credRemoveTarget !== null}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{s.credRemoveTitle}</DialogTitle>
            <DialogDescription>{s.credRemoveDesc}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={removingCred} onClick={() => setCredRemoveTarget(null)} variant="outline">
              {s.cancel}
            </Button>
            <Button disabled={removingCred} onClick={() => void confirmRemoveCred()} variant="destructive">
              {removingCred ? s.credRemoving : s.credRemoveConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Checkpoints prune confirm ───────────────────────────── */}
      <Dialog onOpenChange={open => !open && !pruning && setPruneConfirm(false)} open={pruneConfirm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{s.checkpointsPruneTitle}</DialogTitle>
            <DialogDescription>{s.checkpointsPruneDesc}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={pruning} onClick={() => setPruneConfirm(false)} variant="outline">
              {s.cancel}
            </Button>
            <Button disabled={pruning} onClick={() => void confirmPrune()} variant="destructive">
              {pruning ? s.checkpointsPruning : s.checkpointsPruneConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Hook remove confirm ─────────────────────────────────── */}
      <Dialog
        onOpenChange={open => !open && !removingHook && setHookRemoveTarget(null)}
        open={hookRemoveTarget !== null}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{s.hookRemoveTitle}</DialogTitle>
            <DialogDescription>{s.hookRemoveDesc}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={removingHook} onClick={() => setHookRemoveTarget(null)} variant="outline">
              {s.cancel}
            </Button>
            <Button disabled={removingHook} onClick={() => void confirmRemoveHook()} variant="destructive">
              {removingHook ? s.hookRemoving : s.hookRemoveConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Create-hook dialog ──────────────────────────────────── */}
      <Dialog onOpenChange={open => !open && !creatingHook && setHookDialogOpen(false)} open={hookDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{s.hookDialogTitle}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <Field label={s.hookEvent}>
              <Select onValueChange={setHookEvent} value={hookEvent}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {validEvents.map(ev => (
                    <SelectItem key={ev} value={ev}>
                      {ev}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={s.hookCommand}>
              <Input
                autoFocus
                className="font-mono"
                onChange={e => setHookCommand(e.target.value)}
                placeholder={s.hookCommandPlaceholder}
                value={hookCommand}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label={s.hookMatcherLabel}>
                <Input
                  onChange={e => setHookMatcher(e.target.value)}
                  placeholder={s.hookMatcherPlaceholder}
                  value={hookMatcher}
                />
              </Field>
              <Field label={s.hookTimeout}>
                <Input
                  onChange={e => setHookTimeout(e.target.value)}
                  placeholder={s.hookTimeoutPlaceholder}
                  value={hookTimeout}
                />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch aria-label={s.hookApprove} checked={hookApprove} onCheckedChange={setHookApprove} size="xs" />
              {s.hookApprove}
            </label>
            <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-300">
              <Codicon className="mt-0.5 shrink-0" name="warning" size="0.875rem" />
              <span>{s.hookWarning}</span>
            </p>
          </div>
          <DialogFooter>
            <Button disabled={creatingHook} onClick={() => setHookDialogOpen(false)} variant="outline">
              {s.cancel}
            </Button>
            <Button disabled={creatingHook} onClick={() => void submitHook()}>
              {creatingHook && <Codicon name="loading" size="0.875rem" spinning />}
              {creatingHook ? s.hookCreating : s.hookCreate}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

// ── Local presentational helpers ─────────────────────────────────────────────

function Section({
  action,
  children,
  icon,
  title
}: {
  action?: ReactNode
  children: ReactNode
  icon: string
  title: string
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-2">
        <Codicon className="text-muted-foreground" name={icon} size="0.9rem" />
        <span className="text-[length:var(--conversation-text-font-size)] font-medium text-foreground">{title}</span>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      <div>{children}</div>
    </section>
  )
}

function Stat({
  icon,
  label,
  truncate,
  value
}: {
  icon?: string
  label: string
  truncate?: boolean
  value: ReactNode
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[0.62rem] font-medium uppercase tracking-wide text-muted-foreground">
        {icon && <Codicon name={icon} size="0.7rem" />}
        {label}
      </div>
      <div className={cn('text-foreground', truncate && 'truncate')}>{value}</div>
    </div>
  )
}

function Field({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <label className="text-xs font-medium text-foreground">{label}</label>
      {children}
    </div>
  )
}
