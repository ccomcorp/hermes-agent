/**
 * Channels — gateway messaging-channel configuration.
 *
 * Functional spec: web `src/pages/ChannelsPage.tsx`. Capability ported:
 *  - list channels with live state (`GET /api/messaging/platforms`)
 *  - enable / disable a channel (`PUT /api/messaging/platforms/:id`)
 *  - configure a channel's credentials (`PUT …` with `env`)
 *  - test a channel's connection (`POST …/:id/test`)
 *  - restart the gateway to apply changes (`POST /api/gateway/restart`)
 *  - Telegram pairing: start / poll / apply / cancel
 *    (`/api/messaging/telegram/onboarding/*`) with allowed-user-id management
 *
 * Desktop-styled: flat rows (no card-in-card), shared primitives (Button,
 * Badge, Switch, Codicon, Dialog, Input, PageSearchShell), tokens not literals,
 * and the standard PAGE_INSET_X gutter. The pairing flow surfaces the Telegram
 * deep link + copyable payload rather than rendering a QR image, to avoid
 * pulling in a QR dependency the desktop app does not declare.
 */
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Badge, type BadgeProps } from '@/components/ui/badge'
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
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { PAGE_INSET_X } from '../layout-constants'
import { PageSearchShell } from '../page-search-shell'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import {
  applyTelegramOnboarding,
  cancelTelegramOnboarding,
  getActionStatus,
  getMessagingPlatforms,
  getTelegramOnboardingStatus,
  type MessagingPlatform,
  type MessagingPlatformEnvVar,
  type MessagingPlatformUpdate,
  restartGateway,
  startTelegramOnboarding,
  type TelegramOnboardingStartResponse,
  testMessagingPlatform,
  updateMessagingPlatform
} from './api'
import { channelsStrings as s } from './strings'

const TELEGRAM_USER_ID_RE = /^\d+$/

const STATE_BADGE: Record<string, { variant: BadgeProps['variant']; icon: string }> = {
  connected: { variant: 'default', icon: 'pass-filled' },
  pending_restart: { variant: 'warn', icon: 'sync' },
  gateway_stopped: { variant: 'warn', icon: 'circle-slash' },
  disconnected: { variant: 'warn', icon: 'debug-disconnect' },
  not_configured: { variant: 'outline', icon: 'circle-large-outline' },
  disabled: { variant: 'muted', icon: 'circle-slash' },
  fatal: { variant: 'destructive', icon: 'error' }
}

function stateBadge(state: string): { variant: BadgeProps['variant']; icon: string; label: string } {
  const entry = STATE_BADGE[state] ?? { variant: 'outline' as const, icon: 'broadcast' }

  return { ...entry, label: s.states[state] ?? state }
}

function formatExpiry(expiresAt: string): string {
  const ms = Date.parse(expiresAt) - Date.now()

  if (!Number.isFinite(ms) || ms <= 0) {
    return s.telegramExpired
  }

  const seconds = Math.ceil(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60

  return `${minutes}:${rest.toString().padStart(2, '0')}`
}

function isTerminalTelegramOnboardingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)

  return /\b410\b/.test(message) && /\b(expired|claimed|gone)\b/i.test(message)
}

function matchesQuery(platform: MessagingPlatform, q: string): boolean {
  if (!q) {
    return true
  }

  const needle = q.toLowerCase()

  return [platform.name, platform.description, platform.id, platform.state].some(value =>
    value.toLowerCase().includes(needle)
  )
}

interface ChannelsViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

export function ChannelsView({ setStatusbarItemGroup, ...props }: ChannelsViewProps) {
  const [platforms, setPlatforms] = useState<MessagingPlatform[] | null>(null)
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const [editing, setEditing] = useState<MessagingPlatform | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [restartNeeded, setRestartNeeded] = useState(false)
  const [restarting, setRestarting] = useState(false)

  const refresh = useCallback(async () => {
    setRefreshing(true)

    try {
      const res = await getMessagingPlatforms()
      setPlatforms(res.platforms)
    } catch (err) {
      notifyError(err, s.loadFailed)
    } finally {
      setRefreshing(false)
    }
  }, [])

  useRefreshHotkey(refresh)

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    setStatusbarItemGroup?.('channels', [])

    return () => setStatusbarItemGroup?.('channels', [])
  }, [setStatusbarItemGroup])

  const handleRestart = useCallback(async () => {
    setRestarting(true)

    try {
      await restartGateway()
      notify({ kind: 'success', title: s.restartStarted, message: '' })
      setRestartNeeded(false)
      // Give the gateway a moment to come up, then refresh status.
      window.setTimeout(() => void refresh(), 4000)
    } catch (err) {
      notifyError(err, s.restartFailed)
    } finally {
      setRestarting(false)
    }
  }, [refresh])

  const handleToggle = useCallback(
    async (platform: MessagingPlatform) => {
      const next = !platform.enabled
      setTogglingId(platform.id)

      try {
        await updateMessagingPlatform(platform.id, { enabled: next })
        setPlatforms(prev =>
          (prev ?? []).map(p =>
            p.id === platform.id ? { ...p, enabled: next, state: next ? 'pending_restart' : 'disabled' } : p
          )
        )
        setRestartNeeded(true)
      } catch (err) {
        notifyError(err, s.toggleFailed)
      } finally {
        setTogglingId(null)
      }
    },
    []
  )

  const handleTest = useCallback(async (platform: MessagingPlatform) => {
    setTestingId(platform.id)

    try {
      const res = await testMessagingPlatform(platform.id)
      notify({
        kind: res.ok ? 'success' : 'error',
        title: platform.name,
        message: res.message
      })
    } catch (err) {
      notifyError(err, platform.name)
    } finally {
      setTestingId(null)
    }
  }, [])

  const handleSaved = useCallback(() => {
    setEditing(null)
    setRestartNeeded(true)
    void refresh()
  }, [refresh])

  const loaded = platforms !== null
  const all = platforms ?? []
  const configured = useMemo(() => all.filter(p => p.configured).length, [all])
  const gatewayRunning = all.length > 0 && all[0].gateway_running
  const visible = useMemo(() => all.filter(p => matchesQuery(p, query.trim())), [all, query])

  return (
    <PageSearchShell
      {...props}
      onSearchChange={setQuery}
      searchHidden={!loaded || all.length === 0}
      searchPlaceholder={s.search}
      searchTrailingAction={
        <Button
          aria-label={refreshing ? s.refreshing : s.refresh}
          className="text-(--ui-text-tertiary) hover:bg-transparent hover:text-foreground"
          disabled={refreshing}
          onClick={() => void refresh()}
          size="icon-xs"
          title={refreshing ? s.refreshing : s.refresh}
          type="button"
          variant="ghost"
        >
          <Codicon name="refresh" size="0.875rem" spinning={refreshing} />
        </Button>
      }
      searchValue={query}
    >
      {!loaded ? (
        <PageLoader label={s.loading} />
      ) : (
        <div className={cn('h-full overflow-y-auto py-3', PAGE_INSET_X)}>
          <div className="mx-auto w-full max-w-3xl space-y-4">
            {restartNeeded && (
              <Notice
                action={
                  <Button disabled={restarting} onClick={() => void handleRestart()} size="sm" variant="default">
                    <Codicon name={restarting ? 'loading' : 'sync'} size="0.875rem" spinning={restarting} />
                    {restarting ? s.restarting : s.restartNow}
                  </Button>
                }
                icon="warning"
                title={s.restartBannerTitle}
                tone="warn"
              >
                {s.restartBannerDesc}
              </Notice>
            )}

            {!gatewayRunning && !restartNeeded && all.length > 0 && (
              <Notice icon="circle-slash" title={s.gatewayStoppedTitle} tone="muted">
                {s.gatewayStoppedDesc}
              </Notice>
            )}

            <p className="text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
              {s.summary(configured, all.length)} {s.credentialsNote}
            </p>

            <div className="-mt-1">
              {all.length === 0 ? (
                <EmptyRow text={s.empty} />
              ) : visible.length === 0 ? (
                <EmptyRow text={s.noMatches} />
              ) : (
                visible.map(platform => (
                  <ChannelRow
                    busy={togglingId === platform.id}
                    key={platform.id}
                    onConfigure={() => setEditing(platform)}
                    onTest={() => void handleTest(platform)}
                    onToggle={() => void handleToggle(platform)}
                    platform={platform}
                    testing={testingId === platform.id}
                  >
                    {platform.id === 'telegram' && (
                      <TelegramPairingPanel
                        onApplied={handleSaved}
                        platform={platform}
                      />
                    )}
                  </ChannelRow>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <ConfigureDialog onClose={() => setEditing(null)} onSaved={handleSaved} platform={editing} />
    </PageSearchShell>
  )
}

function Notice({
  action,
  children,
  icon,
  title,
  tone
}: {
  action?: React.ReactNode
  children: React.ReactNode
  icon: string
  title: string
  tone: 'warn' | 'muted'
}) {
  return (
    <div className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2">
        <Codicon
          className={cn('mt-px shrink-0', tone === 'warn' ? 'text-amber-600 dark:text-amber-300' : 'text-muted-foreground')}
          name={icon}
          size="0.9rem"
        />
        <div className="min-w-0">
          <div className="text-[length:var(--conversation-text-font-size)] font-medium text-foreground">{title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{children}</div>
        </div>
      </div>
      {action && <div className="shrink-0 sm:self-center">{action}</div>}
    </div>
  )
}

function ChannelRow({
  busy,
  children,
  onConfigure,
  onTest,
  onToggle,
  platform,
  testing
}: {
  busy: boolean
  children?: React.ReactNode
  onConfigure: () => void
  onTest: () => void
  onToggle: () => void
  platform: MessagingPlatform
  testing: boolean
}) {
  const badge = stateBadge(platform.state)

  return (
    <div className="border-b border-(--ui-stroke-tertiary) py-3 last:border-b-0">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[length:var(--conversation-text-font-size)] font-medium text-foreground">
              {platform.name}
            </span>
            <Badge variant={badge.variant}>
              <Codicon name={badge.icon} size="0.7rem" />
              {badge.label}
            </Badge>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{platform.description}</div>
          {platform.error_message && (
            <div className="mt-1 inline-flex items-start gap-1 text-xs text-destructive">
              <Codicon className="mt-px shrink-0" name="error" size="0.75rem" />
              <span className="line-clamp-2">{platform.error_message}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 sm:justify-self-end">
          {busy ? (
            <Codicon className="text-muted-foreground" name="loading" size="0.875rem" spinning />
          ) : (
            <Switch
              aria-label={s.enableAria(platform.name)}
              checked={platform.enabled}
              onCheckedChange={() => onToggle()}
              size="xs"
            />
          )}
          <Button disabled={testing} onClick={onTest} size="sm" variant="ghost">
            <Codicon name={testing ? 'loading' : 'plug'} size="0.875rem" spinning={testing} />
            {testing ? s.testing : s.test}
          </Button>
          <Button onClick={onConfigure} size="sm" variant="outline">
            <Codicon name="settings-gear" size="0.875rem" />
            {s.configure}
          </Button>
        </div>
      </div>
      {children}
    </div>
  )
}

function ConfigureDialog({
  onClose,
  onSaved,
  platform
}: {
  onClose: () => void
  onSaved: () => void
  platform: MessagingPlatform | null
}) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!platform) {
      return
    }

    const initial: Record<string, string> = {}
    platform.env_vars.forEach(field => {
      initial[field.key] = ''
    })
    setDraft(initial)
    setSaving(false)
  }, [platform])

  async function handleSave() {
    if (!platform) {
      return
    }

    // Only send fields the user actually filled in — leaving a field blank
    // preserves the existing value rather than clobbering it.
    const env: Record<string, string> = {}
    Object.entries(draft).forEach(([key, value]) => {
      if (value.trim()) {
        env[key] = value.trim()
      }
    })

    if (Object.keys(env).length === 0) {
      notify({ kind: 'error', title: s.saveFailed, message: s.nothingToSave })

      return
    }

    const missing = platform.env_vars.filter(field => field.required && !field.is_set && !env[field.key])

    if (missing.length > 0) {
      notify({ kind: 'error', title: s.saveFailed, message: s.fieldRequired(missing[0].prompt || missing[0].key) })

      return
    }

    setSaving(true)

    try {
      const body: MessagingPlatformUpdate = { env, enabled: true }
      await updateMessagingPlatform(platform.id, body)
      notify({ kind: 'success', title: s.savedTitle(platform.name), message: '' })
      onSaved()
    } catch (err) {
      notifyError(err, s.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog onOpenChange={open => !open && !saving && onClose()} open={platform !== null}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{platform ? s.configureTitle(platform.name) : ''}</DialogTitle>
          <DialogDescription>{platform?.description}</DialogDescription>
        </DialogHeader>

        {platform?.docs_url && (
          <a
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            href={platform.docs_url}
            rel="noreferrer"
            target="_blank"
          >
            <Codicon name="link-external" size="0.75rem" />
            {s.setupGuide}
          </a>
        )}

        <div className="grid gap-4">
          {platform?.env_vars.map((field: MessagingPlatformEnvVar) => (
            <Field field={field} key={field.key} onChange={value => setDraft(prev => ({ ...prev, [field.key]: value }))} value={draft[field.key] ?? ''} />
          ))}
        </div>

        <DialogFooter>
          <Button disabled={saving} onClick={onClose} variant="outline">
            {s.cancel}
          </Button>
          <Button disabled={saving} onClick={() => void handleSave()} variant="default">
            {saving ? s.saving : s.saveEnable}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  field,
  onChange,
  value
}: {
  field: MessagingPlatformEnvVar
  onChange: (value: string) => void
  value: string
}) {
  const placeholder = field.is_set ? field.redacted_value || `•••••• (${s.keepBlankHint})` : field.key

  return (
    <div className="grid gap-1.5">
      <label className="text-xs font-medium text-foreground" htmlFor={`channel-field-${field.key}`}>
        {field.prompt || field.key}
        {field.required ? s.fieldRequiredSuffix : ''}
      </label>
      {field.description && <span className="text-[0.66rem] leading-4 text-muted-foreground">{field.description}</span>}
      <Input
        id={`channel-field-${field.key}`}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        type={field.is_password ? 'password' : 'text'}
        value={value}
      />
    </div>
  )
}

type TelegramPhase = 'idle' | 'starting' | 'waiting' | 'ready' | 'applying'

function TelegramPairingPanel({
  onApplied,
  platform
}: {
  onApplied: () => void
  platform: MessagingPlatform
}) {
  const [setup, setSetup] = useState<TelegramOnboardingStartResponse | null>(null)
  const [phase, setPhase] = useState<TelegramPhase>('idle')
  const [botUsername, setBotUsername] = useState<string | null>(null)
  const [allowedIds, setAllowedIds] = useState<string[]>([])
  const [detectedOwnerId, setDetectedOwnerId] = useState<string | null>(null)
  const [newAllowedId, setNewAllowedId] = useState('')
  const [tick, setTick] = useState(0)
  const setupRef = useRef<TelegramOnboardingStartResponse | null>(null)
  setupRef.current = setup

  // Poll for pairing completion while waiting.
  useEffect(() => {
    if (!setup || phase !== 'waiting') {
      return
    }

    let cancelled = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      try {
        const status = await getTelegramOnboardingStatus(setup.pairing_id)

        if (cancelled) {
          return
        }

        if (status.status === 'ready') {
          setPhase('ready')
          setBotUsername(status.bot_username ?? null)

          if (status.owner_user_id && TELEGRAM_USER_ID_RE.test(status.owner_user_id)) {
            setDetectedOwnerId(status.owner_user_id)
            setAllowedIds([status.owner_user_id])
          }

          return
        }

        timeout = setTimeout(() => void poll(), 2000)
      } catch (err) {
        if (cancelled) {
          return
        }

        const expiresAt = Date.parse(setup.expires_at)
        const expired = Number.isFinite(expiresAt) && Date.now() >= expiresAt

        if (isTerminalTelegramOnboardingError(err) || expired) {
          reset()
          notify({ kind: 'error', title: s.telegramSaveFailed, message: s.telegramExpiredReset })

          return
        }

        timeout = setTimeout(() => void poll(), 2000)
      }
    }

    timeout = setTimeout(() => void poll(), 1200)

    return () => {
      cancelled = true

      if (timeout) {
        clearTimeout(timeout)
      }
    }
     
  }, [phase, setup])

  // Drive the countdown clock once a pairing is active.
  useEffect(() => {
    if (!setup) {
      return
    }

    const timer = window.setInterval(() => setTick(value => value + 1), 1000)

    return () => window.clearInterval(timer)
  }, [setup])

  function reset() {
    setSetup(null)
    setPhase('idle')
    setBotUsername(null)
    setAllowedIds([])
    setDetectedOwnerId(null)
    setNewAllowedId('')
  }

  async function start() {
    setPhase('starting')
    setBotUsername(null)
    setAllowedIds([])
    setDetectedOwnerId(null)
    setNewAllowedId('')

    try {
      const res = await startTelegramOnboarding({ bot_name: 'Hermes Agent' })
      setSetup(res)
      setPhase('waiting')
    } catch (err) {
      setPhase('idle')
      notifyError(err, s.telegramSaveFailed)
    }
  }

  async function cancel() {
    if (setup) {
      try {
        await cancelTelegramOnboarding(setup.pairing_id)
      } catch {
        /* local cleanup still wins */
      }
    }

    reset()
  }

  function addAllowedId() {
    const trimmed = newAllowedId.trim()

    if (!TELEGRAM_USER_ID_RE.test(trimmed)) {
      notify({ kind: 'error', title: s.telegramSaveFailed, message: s.telegramNumericOnly })

      return
    }

    setAllowedIds(ids => (ids.includes(trimmed) ? ids : [...ids, trimmed]))
    setNewAllowedId('')
  }

  // restart_started only means the restart child spawned — not that it
  // succeeded. Poll the action status briefly and surface a non-zero exit.
  async function watchRestartOutcome() {
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 1500))

      try {
        const st = await getActionStatus('gateway-restart', 5)

        if (st.running) {
          continue
        }

        if (st.exit_code !== 0 && st.exit_code !== null) {
          notify({ kind: 'error', title: s.restartFailed, message: s.restartFailedExit(st.exit_code) })
        }

        return
      } catch {
        // transient fetch error; keep polling
      }
    }
  }

  async function apply() {
    if (!setup) {
      return
    }

    if (allowedIds.length === 0) {
      notify({ kind: 'error', title: s.telegramSaveFailed, message: s.telegramAtLeastOne })

      return
    }

    setPhase('applying')

    try {
      const result = await applyTelegramOnboarding(setup.pairing_id, { allowed_user_ids: allowedIds })
      reset()

      if (result.restart_started) {
        notify({ kind: 'success', title: s.telegramSaved, message: '' })
        void watchRestartOutcome()
      } else if (result.restart_started === undefined && result.needs_restart) {
        try {
          await restartGateway()
          notify({ kind: 'success', title: s.telegramSaved, message: '' })
        } catch (err) {
          notifyError(err, s.restartFailed)
        }
      } else {
        const detail = result.restart_error ? `: ${result.restart_error}` : ''
        notify({ kind: 'error', title: s.restartFailed, message: detail })
      }

      onApplied()
    } catch (err) {
      setPhase('ready')
      notifyError(err, s.telegramSaveFailed)
    }
  }

  const expiresIn = useMemo(
    () => (setup ? formatExpiry(setup.expires_at) : ''),
    // tick keeps the memo fresh each second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setup, tick]
  )

  async function copyPayload() {
    if (!setup) {
      return
    }

    try {
      await navigator.clipboard.writeText(setup.qr_payload)
      notify({ kind: 'success', title: s.telegramCopied, message: '' })
    } catch (err) {
      notifyError(err, s.telegramCopied)
    }
  }

  const busy = phase === 'starting' || phase === 'waiting' || phase === 'applying'

  return (
    <div className="mt-3 rounded-md bg-(--ui-bg-quinary) px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Codicon name="broadcast" size="0.8rem" />
          {s.telegramHeading}
        </span>
        {!setup && (
          <Button disabled={busy} onClick={() => void start()} size="sm" variant="outline">
            <Codicon name={phase === 'starting' ? 'loading' : 'link'} size="0.875rem" spinning={phase === 'starting'} />
            {phase === 'starting' ? s.telegramStarting : s.telegramStart}
          </Button>
        )}
        {platform.configured && !setup && (
          <span className="text-xs text-muted-foreground">{s.telegramConfigured}</span>
        )}
      </div>

      {setup && (
        <div className="mt-3 grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {phase === 'waiting' ? (
              <Badge variant="warn">
                <Codicon name="loading" size="0.7rem" spinning />
                {s.telegramWaiting}
              </Badge>
            ) : (
              <Badge variant="default">
                <Codicon name="pass-filled" size="0.7rem" />
                {s.telegramReady}
              </Badge>
            )}
            {botUsername && <span className="font-mono text-xs text-muted-foreground">@{botUsername}</span>}
            <Badge variant={expiresIn === s.telegramExpired ? 'destructive' : 'outline'}>
              {s.telegramExpiresIn(expiresIn)}
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <a href={setup.deep_link} rel="noreferrer" target="_blank">
                <Codicon name="link-external" size="0.875rem" />
                {s.telegramOpenApp}
              </a>
            </Button>
            <Button onClick={() => void copyPayload()} size="sm" variant="ghost">
              <Codicon name="copy" size="0.875rem" />
              {s.telegramCopyPayload}
            </Button>
            <Button onClick={() => void cancel()} size="sm" variant="text">
              {s.cancel}
            </Button>
          </div>

          {(phase === 'ready' || phase === 'applying') && (
            <div className="grid gap-2 border-t border-(--ui-stroke-tertiary) pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[0.62rem] font-medium uppercase tracking-wide text-muted-foreground">
                  {s.telegramAllowedHeading}
                </span>
                {detectedOwnerId && allowedIds.includes(detectedOwnerId) && (
                  <Badge variant="default">{s.telegramOwnerDetected}</Badge>
                )}
              </div>

              <div className="flex flex-wrap gap-1.5">
                {allowedIds.length === 0 ? (
                  <span className="text-xs text-muted-foreground">{s.telegramAllowedHint}</span>
                ) : (
                  allowedIds.map(id => (
                    <button
                      aria-label={s.removeAllowedAria(id)}
                      className="inline-flex items-center gap-1 rounded-[3px] border border-(--ui-stroke-secondary) px-2 py-0.5 font-mono text-xs text-foreground transition-colors hover:border-destructive/50 hover:text-destructive"
                      key={id}
                      onClick={() => setAllowedIds(ids => ids.filter(existing => existing !== id))}
                      type="button"
                    >
                      {id}
                      <Codicon name="close" size="0.7rem" />
                    </button>
                  ))
                )}
              </div>

              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  className="font-mono"
                  onChange={event => setNewAllowedId(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addAllowedId()
                    }
                  }}
                  placeholder={s.telegramAddPlaceholder}
                  value={newAllowedId}
                />
                <Button onClick={addAllowedId} size="sm" variant="outline">
                  <Codicon name="add" size="0.875rem" />
                  {s.telegramAdd}
                </Button>
              </div>

              <div>
                <Button disabled={phase === 'applying'} onClick={() => void apply()} size="sm" variant="default">
                  <Codicon name={phase === 'applying' ? 'loading' : 'save'} size="0.875rem" spinning={phase === 'applying'} />
                  {phase === 'applying' ? s.saving : s.telegramSaveRestart}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function EmptyRow({ text }: { text: string }) {
  return <div className="py-6 text-center text-xs text-muted-foreground">{text}</div>
}
