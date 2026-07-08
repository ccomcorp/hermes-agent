import type { WorkbenchChangeSet } from '@hermes/shared'
/**
 * ChangeSet panel — Slice D, REVIEW/STATUS ONLY (go-forward plan §5 Slice D).
 *
 * Lists ChangeSets (via api.ts -> preload -> IPC ->
 * `.hermes/workbench/changesets/<id>.json` on disk, never an in-memory mock),
 * opens one, and renders its `files` list as a READ-ONLY metadata summary —
 * path/status/hash, not a real diff viewer. Accept/Reject call
 * `updateChangeSetStatus` to flip the changeset's OWN status file only.
 *
 * Hard scope boundary (see go-forward plan §5's Slice D/E split): this panel
 * must never write/patch a file outside `.hermes/workbench/`, never call any
 * git IPC, and never call any terminal/execute API. Applying a changeset's
 * real file patches + git staging is Slice E, a separate, not-yet-started
 * piece of work — nothing here reaches toward it.
 *
 * ChangeSets are workspace-wide, not scoped to the open requirement (see the
 * comment in store.ts) — this panel therefore always renders once a
 * workspace is selected, independent of whatever RequirementPanel has open.
 *
 * No raw filesystem path is ever passed to the api.ts layer here — every call
 * goes through the workspace root plus a changeset id.
 */
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Badge } from '@/components/ui/badge'
import type { BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { notify, notifyError } from '@/store/notifications'

import { PanelEmpty, PanelListRow } from '../overlays/panel'

import { listChangeSets, readChangeSet, updateChangeSetStatus } from './api'
import {
  $workbenchActiveChangeSetId,
  $workbenchChangeSets,
  $workbenchChangeSetsError,
  $workbenchChangeSetsLoading,
  setWorkbenchActiveChangeSetId,
  setWorkbenchChangeSets,
  setWorkbenchChangeSetsError,
  setWorkbenchChangeSetsLoading
} from './store'
import { workbenchStrings as s } from './strings'

const STATUS_BADGE_VARIANT: Record<string, BadgeProps['variant']> = {
  pending: 'outline',
  partially_accepted: 'warn',
  accepted: 'default',
  rejected: 'destructive',
  applied: 'default',
  archived: 'muted'
}

type Decision = 'accept' | 'reject'

interface ChangeSetPanelProps {
  workspaceRoot: string
}

export function ChangeSetPanel({ workspaceRoot }: ChangeSetPanelProps) {
  const changesets = useStore($workbenchChangeSets)
  const activeId = useStore($workbenchActiveChangeSetId)
  const listLoading = useStore($workbenchChangeSetsLoading)
  const listError = useStore($workbenchChangeSetsError)

  const [detail, setDetail] = useState<null | WorkbenchChangeSet>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [deciding, setDeciding] = useState<Decision | null>(null)

  const load = useCallback(async () => {
    setWorkbenchChangeSetsLoading(true)
    setWorkbenchChangeSetsError(null)

    try {
      const res = await listChangeSets(workspaceRoot)

      if (res.ok) {
        setWorkbenchChangeSets(res.value)
      } else {
        setWorkbenchChangeSetsError(res.message)
        notify({ kind: 'error', title: s.changesets.loadFailed, message: res.message })
      }
    } catch (err) {
      notifyError(err, s.changesets.loadFailed)
    } finally {
      setWorkbenchChangeSetsLoading(false)
    }
  }, [workspaceRoot])

  // ChangeSets are workspace-wide (see store.ts) — one list per workspace
  // root, same as Plans; no requirement dependency to react to.
  useEffect(() => {
    void load()
  }, [load])

  const openChangeSet = useCallback(
    async (changesetId: string) => {
      setWorkbenchActiveChangeSetId(changesetId)
      setDetailLoading(true)
      setDetail(null)

      try {
        const res = await readChangeSet(workspaceRoot, changesetId)

        if (res.ok) {
          setDetail(res.value)
        } else {
          notify({ kind: 'error', title: s.changesets.openFailed, message: res.message })
        }
      } catch (err) {
        notifyError(err, s.changesets.openFailed)
      } finally {
        setDetailLoading(false)
      }
    },
    [workspaceRoot]
  )

  // The ONLY write path in this file: a pure status-JSON transition via
  // updateChangeSetStatus. No file-apply, no git, no terminal/execute call.
  const decide = useCallback(
    async (decision: Decision) => {
      if (!detail) {
        return
      }

      const nextStatus = decision === 'accept' ? 'accepted' : 'rejected'

      setDeciding(decision)

      try {
        const res = await updateChangeSetStatus({
          changesetId: detail.id,
          statusPatch: {
            status: nextStatus,
            approval: { kind: 'user', decision: decision === 'accept' ? 'approved' : 'denied' }
          },
          workspaceRoot
        })

        if (res.ok) {
          setDetail(res.value)
          notify({
            kind: 'success',
            message: '',
            title: decision === 'accept' ? s.changesets.accepted : s.changesets.rejected
          })
          // Re-list from disk so the row's updatedAt reflects exactly what the
          // backend persisted (mirrors requirement/plan panel discipline).
          void load()
        } else {
          notify({
            kind: 'error',
            message: res.message,
            title: decision === 'accept' ? s.changesets.acceptFailed : s.changesets.rejectFailed
          })
        }
      } catch (err) {
        notifyError(err, decision === 'accept' ? s.changesets.acceptFailed : s.changesets.rejectFailed)
      } finally {
        setDeciding(null)
      }
    },
    [detail, load, workspaceRoot]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-foreground">{s.changesets.heading}</h2>
      </div>

      <div className="max-h-40 shrink-0 overflow-y-auto">
        {listLoading && changesets.length === 0 ? (
          <PageLoader label={s.changesets.loading} />
        ) : listError && changesets.length === 0 ? (
          <PanelEmpty description={listError} icon="error" title={s.changesets.loadFailed} />
        ) : changesets.length === 0 ? (
          <PanelEmpty description={s.changesets.emptyDesc} icon="inbox" title={s.changesets.emptyTitle} />
        ) : (
          changesets.map(entry => (
            <PanelListRow
              active={entry.id === activeId}
              key={entry.id}
              meta={new Date(entry.updatedAt).toLocaleDateString()}
              onSelect={() => void openChangeSet(entry.id)}
              rowKey={entry.id}
              title={entry.title}
            />
          ))
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-(--ui-stroke-tertiary) pt-2">
        {detailLoading ? (
          <PageLoader label={s.changesets.loading} />
        ) : !detail ? (
          <PanelEmpty description={s.changesets.selectPrompt} icon="note" title={s.changesets.heading} />
        ) : (
          <ChangeSetDetailView
            deciding={deciding}
            detail={detail}
            onAccept={() => void decide('accept')}
            onReject={() => void decide('reject')}
          />
        )}
      </div>
    </div>
  )
}

function ChangeSetDetailView({
  deciding,
  detail,
  onAccept,
  onReject
}: {
  deciding: Decision | null
  detail: WorkbenchChangeSet
  onAccept: () => void
  onReject: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STATUS_BADGE_VARIANT[detail.status] ?? 'default'}>
          {s.changesets.statusNames[detail.status] ?? detail.status}
        </Badge>
        <span className="text-[0.65rem] text-muted-foreground/60">{detail.source}</span>
      </div>

      {detail.summary ? <p className="text-xs leading-relaxed text-foreground/80">{detail.summary}</p> : null}

      <div className="flex flex-wrap gap-2">
        <Button disabled={deciding !== null} onClick={onAccept} size="sm" variant="outline">
          <Codicon name={deciding === 'accept' ? 'loading' : 'check'} size="0.8125rem" spinning={deciding === 'accept'} />
          {deciding === 'accept' ? s.changesets.accepting : s.changesets.accept}
        </Button>
        <Button disabled={deciding !== null} onClick={onReject} size="sm" variant="ghost">
          <Codicon name={deciding === 'reject' ? 'loading' : 'close'} size="0.8125rem" spinning={deciding === 'reject'} />
          {deciding === 'reject' ? s.changesets.rejecting : s.changesets.reject}
        </Button>
      </div>

      <p className="text-[0.62rem] leading-relaxed text-muted-foreground/50">{s.changesets.reviewNote}</p>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground/50">
          {s.changesets.filesHeading}
        </span>
        {detail.files.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground/60">{s.changesets.noFiles}</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {detail.files.map(file => (
              <li className="rounded bg-foreground/5 px-2 py-1 text-[0.68rem]" key={file.path}>
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-foreground/85" title={file.path}>
                    {file.path}
                  </span>
                  <span className="shrink-0 text-muted-foreground/60">{file.status}</span>
                </div>
                {file.beforeHash || file.afterHash ? (
                  <div className="mt-0.5 truncate text-muted-foreground/50">
                    {file.beforeHash ? `before ${file.beforeHash}` : null}
                    {file.beforeHash && file.afterHash ? ' · ' : null}
                    {file.afterHash ? `after ${file.afterHash}` : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
