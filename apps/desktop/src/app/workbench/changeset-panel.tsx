import type { WorkbenchChangedFile, WorkbenchChangeSet } from '@hermes/shared'
/**
 * ChangeSet panel — Slice D (review/status) + Slice E (apply + commit).
 *
 * Lists ChangeSets (via api.ts -> preload -> IPC ->
 * `.hermes/workbench/changesets/<id>.json` on disk, never an in-memory mock),
 * opens one, and renders its `files` list as a READ-ONLY metadata summary —
 * path/status/hash, not a real diff viewer. Accept/Reject call
 * `updateChangeSetStatus` to flip the changeset's OWN status file only — this
 * behavior and its UI copy (`reviewNote` below) are UNCHANGED from Slice D:
 * accept/reject still never write to the user's project files and never run
 * git.
 *
 * Apply and Commit (Slice E) are SEPARATE, ADDITIONAL actions layered on top:
 * - Apply is only offered once a changeset is already `accepted` (Slice D's
 *   own flow — Apply never changes how a changeset becomes accepted). It is
 *   the first Workbench action anywhere that writes to the user's REAL
 *   project files, via `applyChangeSet` (api.ts -> `changesets:apply` IPC).
 * - Commit is only offered once the workspace is a real git repo AND at
 *   least one file is `applied`; it is never auto-triggered by Apply.
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
import { Input } from '@/components/ui/input'
import { notify, notifyError } from '@/store/notifications'

import { PanelEmpty, PanelListRow } from '../overlays/panel'

import {
  applyChangeSet,
  commitChangeSet,
  isWorkspaceGitRepo,
  listChangeSets,
  readChangeSet,
  updateChangeSetStatus
} from './api'
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
  const [applying, setApplying] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  // Null while the check hasn't resolved yet — treated as "not a repo" for
  // gating purposes so the Commit button never flashes on before we know.
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null)

  // Gate the Commit button on whether the workspace is actually a git repo.
  // Reuses the existing coding-rail git surface (see api.ts
  // `isWorkspaceGitRepo`) rather than adding a bespoke new IPC channel.
  useEffect(() => {
    let cancelled = false

    void isWorkspaceGitRepo(workspaceRoot).then(result => {
      if (!cancelled) {
        setIsGitRepo(result)
      }
    })

    return () => {
      cancelled = true
    }
  }, [workspaceRoot])

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

  // Seed a default commit message from the changeset's own title whenever a
  // different changeset is opened — the user can still edit it before
  // committing.
  useEffect(() => {
    setCommitMessage(detail?.title ?? '')
  }, [detail?.id, detail?.title])

  // The ONLY write path Slice D performs: a pure status-JSON transition via
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

  // Slice E — a SEPARATE, additional action from accept/reject above. Only
  // reachable once `detail.status === 'accepted'` (enforced again below in
  // the render, and independently by the backend). This is the first write
  // in this file that reaches the user's real project files.
  const doApply = useCallback(async () => {
    if (!detail) {
      return
    }

    setApplying(true)

    try {
      const res = await applyChangeSet({ changesetId: detail.id, workspaceRoot })

      if (res.ok) {
        setDetail(res.value)
        notify({ kind: 'success', message: '', title: s.changesets.applied })
        // Re-list so the row's updatedAt/status reflects exactly what the
        // backend persisted, same discipline as accept/reject above.
        void load()
      } else {
        notify({ kind: 'error', message: res.message, title: s.changesets.applyFailed })
      }
    } catch (err) {
      notifyError(err, s.changesets.applyFailed)
    } finally {
      setApplying(false)
    }
  }, [detail, load, workspaceRoot])

  // Slice E — a further separate, explicit action. Never called by
  // `doApply` above.
  const doCommit = useCallback(async () => {
    if (!detail) {
      return
    }

    setCommitting(true)

    try {
      const res = await commitChangeSet({
        changesetId: detail.id,
        message: commitMessage.trim() || undefined,
        workspaceRoot
      })

      if (res.ok) {
        notify({
          kind: 'success',
          message: res.value.message,
          title: s.changesets.committedFiles(res.value.files.length)
        })
      } else {
        notify({ kind: 'error', message: res.message, title: s.changesets.commitFailed })
      }
    } catch (err) {
      notifyError(err, s.changesets.commitFailed)
    } finally {
      setCommitting(false)
    }
  }, [commitMessage, detail, workspaceRoot])

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
            applying={applying}
            commitMessage={commitMessage}
            committing={committing}
            deciding={deciding}
            detail={detail}
            isGitRepo={isGitRepo}
            onAccept={() => void decide('accept')}
            onApply={() => void doApply()}
            onCommit={() => void doCommit()}
            onCommitMessageChange={setCommitMessage}
            onReject={() => void decide('reject')}
          />
        )}
      </div>
    </div>
  )
}

function ChangeSetDetailView({
  applying,
  commitMessage,
  committing,
  deciding,
  detail,
  isGitRepo,
  onAccept,
  onApply,
  onCommit,
  onCommitMessageChange,
  onReject
}: {
  applying: boolean
  commitMessage: string
  committing: boolean
  deciding: Decision | null
  detail: WorkbenchChangeSet
  isGitRepo: boolean | null
  onAccept: () => void
  onApply: () => void
  onCommit: () => void
  onCommitMessageChange: (value: string) => void
  onReject: () => void
}) {
  const canApply = detail.status === 'accepted'
  const hasAppliedFile = detail.files.some(file => file.status === 'applied')
  const canCommit = isGitRepo === true && hasAppliedFile

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

      {canApply ? (
        <div className="flex flex-col gap-1 rounded border border-(--ui-stroke-tertiary) p-2">
          <Button disabled={applying} onClick={onApply} size="sm" variant="outline">
            <Codicon name={applying ? 'loading' : 'check-all'} size="0.8125rem" spinning={applying} />
            {applying ? s.changesets.applying : s.changesets.apply}
          </Button>
          <p className="text-[0.62rem] leading-relaxed text-muted-foreground/50">{s.changesets.applyNote}</p>
        </div>
      ) : null}

      {hasAppliedFile ? (
        <div className="flex flex-col gap-1 rounded border border-(--ui-stroke-tertiary) p-2">
          {isGitRepo === false ? (
            <p className="text-[0.62rem] text-muted-foreground/60">{s.changesets.commitNotRepoHint}</p>
          ) : (
            <>
              <label className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground/50">
                {s.changesets.commitMessageLabel}
              </label>
              <Input
                onChange={event => onCommitMessageChange(event.target.value)}
                size="sm"
                value={commitMessage}
              />
              <Button disabled={!canCommit || committing} onClick={onCommit} size="sm" variant="outline">
                <Codicon name={committing ? 'loading' : 'git-commit'} size="0.8125rem" spinning={committing} />
                {committing ? s.changesets.committing : s.changesets.commit}
              </Button>
            </>
          )}
        </div>
      ) : null}

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
                {/* Per-file Apply outcome (Slice E) — shown distinctly from
                    `file.status` since a partial apply can leave some files
                    applied and others in conflict/error within one changeset. */}
                {file.applyResult ? (
                  <div className="mt-0.5 text-muted-foreground/60">
                    <span className="font-medium">{fileResultLabel(file)}</span>
                    {file.applyMessage ? `: ${file.applyMessage}` : null}
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

function fileResultLabel(file: WorkbenchChangedFile): string {
  if (!file.applyResult) {
    return ''
  }

  return s.changesets.fileResultNames[file.applyResult] ?? file.applyResult
}
