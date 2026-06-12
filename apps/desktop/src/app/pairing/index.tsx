/**
 * Pairing — admin view for DM pairing codes.
 *
 * Functional spec: web `src/pages/PairingPage.tsx`. Capability ported:
 *  - list pending + approved users (`GET /api/pairing`)
 *  - approve a pending request by its code (`POST /api/pairing/approve`)
 *  - revoke an approved user (`POST /api/pairing/revoke`)
 *  - clear all pending requests (`POST /api/pairing/clear-pending`)
 *
 * Desktop-styled: flat rows (no card-in-card), shared primitives (Button,
 * Badge, Codicon, Dialog, PageSearchShell), tokens not literals, and the
 * standard PAGE_INSET_X gutter.
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
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { PAGE_INSET_X } from '../layout-constants'
import { PageSearchShell } from '../page-search-shell'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { approvePairing, clearPendingPairing, getPairing, type PairingUser, revokePairing } from './api'
import { pairingStrings as s } from './strings'

function userKey(user: PairingUser): string {
  return `${user.platform}:${user.user_id}`
}

function userLabel(user: PairingUser): string {
  return user.user_name?.trim() || user.user_id
}

function matchesQuery(user: PairingUser, q: string): boolean {
  if (!q) {
    return true
  }

  const needle = q.toLowerCase()

  return [user.platform, user.user_id, user.user_name ?? '', user.code ?? ''].some(value =>
    value.toLowerCase().includes(needle)
  )
}

interface PairingViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

export function PairingView({ setStatusbarItemGroup, ...props }: PairingViewProps) {
  const [pending, setPending] = useState<PairingUser[] | null>(null)
  const [approved, setApproved] = useState<PairingUser[] | null>(null)
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [approvingKey, setApprovingKey] = useState<string | null>(null)

  // Confirm dialogs: clear-pending + per-user revoke (both destructive).
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<PairingUser | null>(null)
  const [revoking, setRevoking] = useState(false)

  const refresh = useCallback(async () => {
    setRefreshing(true)

    try {
      const res = await getPairing()
      setPending(res.pending)
      setApproved(res.approved)
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
    setStatusbarItemGroup?.('pairing', [])

    return () => setStatusbarItemGroup?.('pairing', [])
  }, [setStatusbarItemGroup])

  const visiblePending = useMemo(
    () => (pending ?? []).filter(user => matchesQuery(user, query.trim())),
    [pending, query]
  )

  const visibleApproved = useMemo(
    () => (approved ?? []).filter(user => matchesQuery(user, query.trim())),
    [approved, query]
  )

  async function handleApprove(user: PairingUser) {
    if (!user.code) {
      notify({ kind: 'error', title: s.approveFailed, message: s.missingCode })

      return
    }

    const key = userKey(user)
    setApprovingKey(key)

    try {
      await approvePairing(user.platform, user.code)
      notify({ kind: 'success', title: s.approvedTitle, message: s.approvedMessage(userLabel(user)) })
      await refresh()
    } catch (err) {
      notifyError(err, s.approveFailed)
    } finally {
      setApprovingKey(null)
    }
  }

  async function handleConfirmClear() {
    setClearing(true)

    try {
      const res = await clearPendingPairing()
      notify({ kind: 'success', title: s.clearedTitle, message: s.clearedMessage(res.cleared) })
      setConfirmClear(false)
      await refresh()
    } catch (err) {
      notifyError(err, s.clearPendingTitle)
    } finally {
      setClearing(false)
    }
  }

  async function handleConfirmRevoke() {
    if (!revokeTarget) {
      return
    }

    setRevoking(true)

    try {
      await revokePairing(revokeTarget.platform, revokeTarget.user_id)
      notify({ kind: 'success', title: s.revokedTitle, message: s.revokedMessage(userLabel(revokeTarget)) })
      setRevokeTarget(null)
      await refresh()
    } catch (err) {
      notifyError(err, s.revokeFailed)
    } finally {
      setRevoking(false)
    }
  }

  const loaded = pending !== null && approved !== null
  const hasAnyPending = (pending?.length ?? 0) > 0
  const hasAny = (pending?.length ?? 0) + (approved?.length ?? 0) > 0

  return (
    <PageSearchShell
      {...props}
      onSearchChange={setQuery}
      searchHidden={!hasAny}
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
          <div className="mx-auto w-full max-w-3xl space-y-8">
            <Section
              action={
                hasAnyPending ? (
                  <Button disabled={clearing} onClick={() => setConfirmClear(true)} size="sm" variant="outline">
                    <Codicon name="trash" size="0.875rem" />
                    {s.clearPending}
                  </Button>
                ) : undefined
              }
              count={pending?.length ?? 0}
              icon="organization"
              title={s.pendingHeading}
            >
              {visiblePending.length === 0 ? (
                <EmptyRow text={hasAnyPending ? s.noMatches : s.noPending} />
              ) : (
                visiblePending.map(user => (
                  <PendingRow
                    busy={approvingKey === userKey(user)}
                    disabled={!user.code}
                    key={userKey(user)}
                    onApprove={() => void handleApprove(user)}
                    user={user}
                  />
                ))
              )}
            </Section>

            <Section count={approved?.length ?? 0} icon="shield" title={s.approvedHeading}>
              {visibleApproved.length === 0 ? (
                <EmptyRow text={(approved?.length ?? 0) > 0 ? s.noMatches : s.noApproved} />
              ) : (
                visibleApproved.map(user => (
                  <ApprovedRow key={userKey(user)} onRevoke={() => setRevokeTarget(user)} user={user} />
                ))
              )}
            </Section>
          </div>
        </div>
      )}

      <Dialog onOpenChange={open => !open && !clearing && setConfirmClear(false)} open={confirmClear}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{s.clearPendingTitle}</DialogTitle>
            <DialogDescription>{s.clearPendingDesc}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={clearing} onClick={() => setConfirmClear(false)} variant="outline">
              {s.cancel}
            </Button>
            <Button disabled={clearing} onClick={() => void handleConfirmClear()} variant="destructive">
              {clearing ? s.clearing : s.clearPendingConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={open => !open && !revoking && setRevokeTarget(null)} open={revokeTarget !== null}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{s.revokeTitle}</DialogTitle>
            <DialogDescription>
              {revokeTarget ? s.revokeDesc(userLabel(revokeTarget)) : s.revokeDesc('')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={revoking} onClick={() => setRevokeTarget(null)} variant="outline">
              {s.cancel}
            </Button>
            <Button disabled={revoking} onClick={() => void handleConfirmRevoke()} variant="destructive">
              {revoking ? s.revoking : s.revokeConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSearchShell>
  )
}

function Section({
  action,
  children,
  count,
  icon,
  title
}: {
  action?: React.ReactNode
  children: React.ReactNode
  count: number
  icon: string
  title: string
}) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2 pb-1">
        <Codicon className="text-muted-foreground" name={icon} size="0.9rem" />
        <span className="text-[length:var(--conversation-text-font-size)] font-medium text-foreground">{title}</span>
        <Badge variant="muted">{count}</Badge>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      <div>{children}</div>
    </section>
  )
}

function PendingRow({
  busy,
  disabled,
  onApprove,
  user
}: {
  busy: boolean
  disabled: boolean
  onApprove: () => void
  user: PairingUser
}) {
  return (
    <div className="grid gap-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{user.platform}</Badge>
          {user.code && <span className="font-mono text-sm text-foreground">{user.code}</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
          <span className="truncate">{user.user_id}</span>
          {user.user_name && <span className="truncate">{user.user_name}</span>}
          {typeof user.age_minutes === 'number' && <span className="tabular-nums">{s.ageAgo(user.age_minutes)}</span>}
        </div>
      </div>
      <div className="sm:justify-self-end">
        <Button disabled={busy || disabled} onClick={onApprove} size="sm" variant="default">
          <Codicon name={busy ? 'loading' : 'check'} size="0.875rem" spinning={busy} />
          {s.approve}
        </Button>
      </div>
    </div>
  )
}

function ApprovedRow({ onRevoke, user }: { onRevoke: () => void; user: PairingUser }) {
  return (
    <div className="grid gap-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{user.platform}</Badge>
          <span className="truncate text-sm font-medium text-foreground">{user.user_id}</span>
        </div>
        {user.user_name && <div className="mt-1 truncate text-xs text-muted-foreground">{user.user_name}</div>}
      </div>
      <div className="sm:justify-self-end">
        <Button
          aria-label={s.revoke}
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={onRevoke}
          size="icon-sm"
          title={s.revoke}
          variant="ghost"
        >
          <Codicon name="close" size="0.875rem" />
        </Button>
      </div>
    </div>
  )
}

function EmptyRow({ text }: { text: string }) {
  return <div className="py-6 text-center text-xs text-muted-foreground">{text}</div>
}
