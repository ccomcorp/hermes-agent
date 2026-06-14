/**
 * Webhooks — dynamic webhook subscriptions (create / list / delete / toggle).
 *
 * Functional port of the dashboard's WebhooksPage; styling is the desktop's own
 * design system (flat, tokens-not-literals, reused primitives — no card-in-card).
 * API calls live in ./api, mirroring src/hermes.ts's request helper.
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { AlertTriangle } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { PageSearchShell } from '../page-search-shell'
import { EmptyState, ListRow } from '../settings/primitives'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  setWebhookEnabled,
  type WebhookCreated,
  type WebhookRoute,
  type WebhooksResponse
} from './api'
import { DELIVERY_OPTIONS, WEBHOOKS_STRINGS as S } from './strings'

function matchesQuery(sub: WebhookRoute, q: string): boolean {
  if (!q) {
    return true
  }

  const needle = q.toLowerCase()

  return [sub.name, sub.description, sub.deliver, ...sub.events].some(value =>
    value?.toLowerCase().includes(needle)
  )
}

interface WebhooksViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup: SetStatusbarItemGroup
}

export function WebhooksView({ setStatusbarItemGroup, ...props }: WebhooksViewProps) {
  const [data, setData] = useState<WebhooksResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [busyName, setBusyName] = useState<null | string>(null)
  const [pendingDelete, setPendingDelete] = useState<WebhookRoute | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setData(await listWebhooks())
    } catch (err) {
      notifyError(err, S.loadFailed)
    } finally {
      setLoading(false)
    }
  }, [])

  useRefreshHotkey(refresh)

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    setStatusbarItemGroup('webhooks', [])

    return () => setStatusbarItemGroup('webhooks', [])
  }, [setStatusbarItemGroup])

  const enabled = data?.enabled ?? false
  const subscriptions = data?.subscriptions ?? []
  const totalCount = subscriptions.length

  const visible = useMemo(
    () =>
      subscriptions
        .filter(sub => matchesQuery(sub, query.trim()))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [subscriptions, query]
  )

  const handleToggle = useCallback(
    async (sub: WebhookRoute, next: boolean) => {
      setBusyName(sub.name)

      try {
        await setWebhookEnabled(sub.name, next)
        setData(current =>
          current
            ? {
                ...current,
                subscriptions: current.subscriptions.map(row =>
                  row.name === sub.name ? { ...row, enabled: next } : row
                )
              }
            : current
        )
        notify({ kind: 'success', title: next ? S.enabledToast : S.disabledToast, message: sub.name })
      } catch (err) {
        notifyError(err, S.toggleFailed)
      } finally {
        setBusyName(null)
      }
    },
    []
  )

  async function handleConfirmDelete() {
    if (!pendingDelete) {
      return
    }

    setDeleting(true)

    try {
      await deleteWebhook(pendingDelete.name)
      setData(current =>
        current
          ? { ...current, subscriptions: current.subscriptions.filter(row => row.name !== pendingDelete.name) }
          : current
      )
      notify({ kind: 'success', title: S.deleted, message: pendingDelete.name })
      setPendingDelete(null)
    } catch (err) {
      notifyError(err, S.deleteFailed)
    } finally {
      setDeleting(false)
    }
  }

  function handleCreated(created: WebhookCreated) {
    setData(current => {
      if (!current) {
        return current
      }

      const { secret: _secret, ...route } = created

      return { ...current, subscriptions: [...current.subscriptions, route] }
    })
  }

  return (
    <PageSearchShell
      {...props}
      onSearchChange={setQuery}
      searchHidden={totalCount === 0}
      searchPlaceholder={S.search}
      searchTrailingAction={
        <Button disabled={!enabled} onClick={() => setCreateOpen(true)} size="sm">
          <Codicon name="add" size="0.875rem" />
          {S.newSubscription}
        </Button>
      }
      searchValue={query}
    >
      {loading ? (
        <PageLoader label={S.loading} />
      ) : (
        <div className="h-full min-h-0 overflow-y-auto px-[clamp(1.25rem,4vw,4rem)] pb-20">
          <div className="mx-auto w-full max-w-4xl">
            {!enabled && (
              <div className="mt-4 flex items-start gap-2.5 rounded-md bg-amber-500/10 px-3 py-2.5 text-amber-600 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0">
                  <div className="text-[length:var(--conversation-text-font-size)] font-medium">{S.disabledTitle}</div>
                  <div className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-amber-600/85 dark:text-amber-300/85">
                    {S.disabledBody}
                  </div>
                </div>
              </div>
            )}

            <div className="mb-2.5 flex items-center gap-2 pt-2 text-[length:var(--conversation-text-font-size)] font-medium">
              <Codicon className="text-muted-foreground" name="radio-tower" size="1rem" />
              <span>{S.subscriptionsHeading}</span>
              <Badge variant="muted">{totalCount}</Badge>
            </div>
            <p className="-mt-1 mb-1 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
              {S.hotReloadHint}
            </p>

            {totalCount === 0 ? (
              <EmptyState description={S.emptyDesc} title={S.emptyTitle} />
            ) : visible.length === 0 ? (
              <EmptyState description={S.emptySearchDesc} title={S.emptySearchTitle} />
            ) : (
              <div className="divide-y divide-(--ui-stroke-tertiary)">
                {visible.map(sub => (
                  <WebhookRow
                    busy={busyName === sub.name}
                    key={sub.name}
                    onDelete={() => setPendingDelete(sub)}
                    onToggle={next => void handleToggle(sub, next)}
                    sub={sub}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <CreateWebhookDialog onCreated={handleCreated} onOpenChange={setCreateOpen} open={createOpen} />

      <Dialog onOpenChange={open => !open && !deleting && setPendingDelete(null)} open={pendingDelete !== null}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{S.deleteTitle}</DialogTitle>
            <DialogDescription>
              {pendingDelete ? (
                <>
                  {S.deleteDescPrefix}
                  <span className="font-medium text-foreground">{pendingDelete.name}</span>
                  {S.deleteDescSuffix}
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={deleting} onClick={() => setPendingDelete(null)} variant="outline">
              {S.cancel}
            </Button>
            <Button disabled={deleting} onClick={() => void handleConfirmDelete()} variant="destructive">
              {deleting ? S.deleting : S.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSearchShell>
  )
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }, [value])

  return (
    <Button aria-label={label} onClick={handleCopy} size="icon-xs" title={label} variant="ghost">
      <Codicon name={copied ? 'check' : 'copy'} size="0.875rem" />
    </Button>
  )
}

function WebhookRow({
  busy,
  onDelete,
  onToggle,
  sub
}: {
  busy: boolean
  onDelete: () => void
  onToggle: (next: boolean) => void
  sub: WebhookRoute
}) {
  return (
    <ListRow
      action={
        <div className="flex items-center gap-1.5">
          <Switch
            aria-label={sub.enabled ? S.disable : S.enable}
            checked={sub.enabled}
            disabled={busy}
            onCheckedChange={onToggle}
            size="xs"
          />
          <Button
            aria-label={S.delete}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={onDelete}
            size="icon-xs"
            title={S.delete}
            variant="ghost"
          >
            <Codicon name="trash" size="0.875rem" />
          </Button>
        </div>
      }
      below={
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{sub.deliver}</Badge>
          {sub.deliver_only && <Badge variant="muted">{S.deliverOnly}</Badge>}
          {sub.events.length === 0 ? (
            <Badge variant="muted">{S.allEvents}</Badge>
          ) : (
            sub.events.map(evt => (
              <Badge key={evt} variant="muted">
                {evt}
              </Badge>
            ))
          )}
        </div>
      }
      description={sub.description || undefined}
      hint={
        <span className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate">{sub.url}</span>
          <CopyButton label={S.copyUrl} value={sub.url} />
        </span>
      }
      title={
        <span className={cn('inline-flex items-center gap-2', !sub.enabled && 'opacity-60')}>
          <span className="truncate">{sub.name}</span>
          {!sub.enabled && <Badge variant="warn">{S.disabledBadge}</Badge>}
        </span>
      }
    />
  )
}

function CreateWebhookDialog({
  onCreated,
  onOpenChange,
  open
}: {
  onCreated: (created: WebhookCreated) => void
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [events, setEvents] = useState('')
  const [deliver, setDeliver] = useState('log')
  const [deliverOnly, setDeliverOnly] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const [created, setCreated] = useState<null | WebhookCreated>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    setName('')
    setDescription('')
    setEvents('')
    setDeliver('log')
    setDeliverOnly(false)
    setPrompt('')
    setCreating(false)
    setError(null)
    setCreated(null)
  }, [open])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    const trimmedName = name.trim()

    if (!trimmedName) {
      setError(S.nameRequired)

      return
    }

    setCreating(true)
    setError(null)

    try {
      const eventsList = events
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)

      const result = await createWebhook({
        name: trimmedName,
        description: description.trim() || undefined,
        events: eventsList.length ? eventsList : undefined,
        deliver,
        deliver_only: deliverOnly,
        prompt: prompt.trim() || undefined
      })

      onCreated(result)
      setCreated(result)
      notify({ kind: 'success', title: S.createdTitle, message: trimmedName })
    } catch (err) {
      setError(err instanceof Error ? err.message : S.createFailed)
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog onOpenChange={value => !value && !creating && onOpenChange(false)} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{created ? S.createdTitle : S.createTitle}</DialogTitle>
          <DialogDescription>{created ? S.createdDesc : S.createDesc}</DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="grid gap-4">
            <Field label={S.webhookUrlLabel}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{created.url}</span>
                <CopyButton label={S.copyUrl} value={created.url} />
              </div>
            </Field>

            <Field label={S.secretLabel}>
              <div className="flex items-center gap-2 rounded-md bg-amber-500/10 px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-amber-600 dark:text-amber-300">
                  {created.secret}
                </span>
                <CopyButton label={S.copySecret} value={created.secret} />
              </div>
            </Field>

            <DialogFooter>
              <Button onClick={() => onOpenChange(false)} type="button">
                {S.done}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={handleSubmit}>
            <Field htmlFor="webhook-name" label={S.nameLabel}>
              <Input
                autoFocus
                id="webhook-name"
                onChange={event => setName(event.target.value)}
                placeholder={S.namePlaceholder}
                value={name}
              />
            </Field>

            <Field htmlFor="webhook-description" label={S.descriptionLabel} optional optionalLabel={S.descriptionLabelOptional}>
              <Input
                id="webhook-description"
                onChange={event => setDescription(event.target.value)}
                placeholder={S.descriptionPlaceholder}
                value={description}
              />
            </Field>

            <Field htmlFor="webhook-events" label={S.eventsLabel} optional optionalLabel={S.eventsLabelOptional}>
              <Input
                id="webhook-events"
                onChange={event => setEvents(event.target.value)}
                placeholder={S.eventsPlaceholder}
                value={events}
              />
            </Field>

            <div className="grid items-start gap-4 sm:grid-cols-2">
              <Field htmlFor="webhook-deliver" label={S.deliverLabel}>
                <Select onValueChange={setDeliver} value={deliver}>
                  <SelectTrigger className="h-9 rounded-md" id="webhook-deliver">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DELIVERY_OPTIONS.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label={S.deliverOnlyLabel}>
                <label className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    aria-label={S.deliverOnlyLabel}
                    checked={deliverOnly}
                    onCheckedChange={setDeliverOnly}
                    size="xs"
                  />
                  <span>{S.deliverOnlyHint}</span>
                </label>
              </Field>
            </div>

            <Field htmlFor="webhook-prompt" label={S.promptLabel} optional optionalLabel={S.promptLabelOptional}>
              <Textarea
                className="min-h-20 font-mono"
                id="webhook-prompt"
                onChange={event => setPrompt(event.target.value)}
                placeholder={S.promptPlaceholder}
                value={prompt}
              />
            </Field>

            {error && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <DialogFooter>
              <Button disabled={creating} onClick={() => onOpenChange(false)} type="button" variant="outline">
                {S.cancel}
              </Button>
              <Button disabled={creating} type="submit">
                {creating ? S.creating : S.create}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Field({
  children,
  htmlFor,
  label,
  optional,
  optionalLabel
}: {
  children: React.ReactNode
  htmlFor?: string
  label: string
  optional?: boolean
  optionalLabel?: string
}) {
  return (
    <div className="grid gap-1.5">
      <label className="flex items-baseline gap-2 text-xs font-medium text-foreground" htmlFor={htmlFor}>
        {label}
        {optional && <span className="text-[0.65rem] font-normal text-muted-foreground">{optionalLabel}</span>}
      </label>
      {children}
    </div>
  )
}
