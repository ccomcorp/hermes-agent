/**
 * Plan panel — Workbench Plans linked to the currently-open Requirement Unit
 * (via api.ts -> preload -> IPC -> `.hermes/workbench/plans/<id>.md`, never an
 * in-memory mock). Creates a plan FROM the open requirement, views one, and
 * refines it — refine is the ONLY edit mechanism (locked decision §3.2): it
 * never overwrites, it writes a new version file linked back to the prior one
 * via `supersedesPlanId`, and this panel shows the resulting version + link
 * rather than silently swapping content in place.
 *
 * No raw filesystem path is ever passed to the api.ts layer here — every call
 * goes through the workspace root plus a requirement/plan id. "Reveal file"
 * is the one exception: it composes workspaceRoot + the plan's relativePath
 * (both already known/returned by the api layer) purely to hand an absolute
 * path to the existing OS-reveal bridge, the same way the project sidebar's
 * "Reveal" action does — it is not an artifact read/write.
 *
 * Create/refine are pure file writes: neither calls any run/execute/terminal
 * API, so a plan-only action can never trigger implementation.
 */
import { useStore } from '@nanostores/react'
import type * as React from 'react'
import { useCallback, useEffect, useState } from 'react'

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
import { Textarea } from '@/components/ui/textarea'
import { revealDesktopPath } from '@/lib/desktop-fs'
import { notify, notifyError } from '@/store/notifications'

import { PanelEmpty, PanelListRow } from '../overlays/panel'

import { createPlan, listPlans, readPlan, refinePlan } from './api'
import type { WorkbenchPlanDetail } from './api'
import {
  $workbenchActivePlanId,
  $workbenchActiveRequirementId,
  $workbenchLinkedPlans,
  $workbenchPlansError,
  $workbenchPlansLoading,
  addLinkedPlanId,
  setWorkbenchActivePlanId,
  setWorkbenchPlans,
  setWorkbenchPlansError,
  setWorkbenchPlansLoading,
  upsertWorkbenchPlanManifestEntry
} from './store'
import { workbenchStrings as s } from './strings'

interface PlanVersionEntry {
  id: string
  savedAt: string
  supersedesPlanId?: string
  version: number
}

interface PlanPanelProps {
  workspaceRoot: string
}

export function PlanPanel({ workspaceRoot }: PlanPanelProps) {
  const requirementId = useStore($workbenchActiveRequirementId)
  const linkedPlans = useStore($workbenchLinkedPlans)
  const activePlanId = useStore($workbenchActivePlanId)
  const listLoading = useStore($workbenchPlansLoading)
  const listError = useStore($workbenchPlansError)

  const [detail, setDetail] = useState<WorkbenchPlanDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [history, setHistory] = useState<PlanVersionEntry[]>([])

  const [createOpen, setCreateOpen] = useState(false)
  const [createTitle, setCreateTitle] = useState('')
  const [createMarkdown, setCreateMarkdown] = useState('')
  const [creating, setCreating] = useState(false)

  const [refineOpen, setRefineOpen] = useState(false)
  const [refineMarkdown, setRefineMarkdown] = useState('')
  const [refining, setRefining] = useState(false)

  const load = useCallback(async () => {
    setWorkbenchPlansLoading(true)
    setWorkbenchPlansError(null)

    try {
      const res = await listPlans(workspaceRoot)

      if (res.ok) {
        setWorkbenchPlans(res.value)
      } else {
        setWorkbenchPlansError(res.message)
        notify({ kind: 'error', title: s.plans.loadFailed, message: res.message })
      }
    } catch (err) {
      notifyError(err, s.plans.loadFailed)
    } finally {
      setWorkbenchPlansLoading(false)
    }
  }, [workspaceRoot])

  // Plans are workspace-scoped (see store.ts), so a fresh list only needs to
  // happen per workspace root, not per requirement — $workbenchLinkedPlans
  // re-derives from the same list whenever the active requirement changes.
  useEffect(() => {
    void load()
  }, [load])

  // Closing (or switching) the open requirement already clears
  // $workbenchActivePlanId in store.ts — clear the locally-held plan
  // markdown/history here too so stale content never lingers behind.
  useEffect(() => {
    setDetail(null)
    setHistory([])
  }, [requirementId])

  // Walks the supersedes-link chain back to the first version for a simple
  // version timeline. Capped — this is a small, deliberate read-back for
  // display when a plan is opened, not a hot path.
  const loadHistory = useCallback(
    async (rootId: string) => {
      const chain: PlanVersionEntry[] = []
      let cursor: string | undefined = rootId
      let hops = 0

      while (cursor && hops < 25) {
        const res = await readPlan(workspaceRoot, cursor)

        if (!res.ok) {
          break
        }

        chain.push({
          id: res.value.id,
          savedAt: res.value.savedAt,
          supersedesPlanId: res.value.supersedesPlanId,
          version: res.value.version
        })
        cursor = res.value.supersedesPlanId
        hops += 1
      }

      setHistory(chain)
    },
    [workspaceRoot]
  )

  const openPlan = useCallback(
    async (planId: string) => {
      setWorkbenchActivePlanId(planId)
      setDetailLoading(true)
      setDetail(null)
      setHistory([])

      try {
        const res = await readPlan(workspaceRoot, planId)

        if (res.ok) {
          setDetail(res.value)
          void loadHistory(planId)
        } else {
          notify({ kind: 'error', title: s.plans.openFailed, message: res.message })
        }
      } catch (err) {
        notifyError(err, s.plans.openFailed)
      } finally {
        setDetailLoading(false)
      }
    },
    [loadHistory, workspaceRoot]
  )

  const handleCreate = useCallback(async () => {
    // Fail closed: creating a plan without an open requirement to link it to
    // is not allowed (constraint: no open requirement -> no plan creation).
    if (!requirementId) {
      return
    }

    setCreating(true)

    try {
      const res = await createPlan({
        markdown: createMarkdown.trim() || s.plans.defaultMarkdown,
        requirementId,
        title: createTitle.trim() || undefined,
        workspaceRoot
      })

      if (res.ok) {
        const { plan } = res.value

        upsertWorkbenchPlanManifestEntry({
          id: plan.id,
          relativePath: plan.relativePath,
          title: plan.title,
          updatedAt: plan.updatedAt
        })
        // The backend's linkPlanToRequirement() already pushed this id into
        // trace.json on disk (createPlan() was called with requirementId) —
        // mirror that locally so the linked list shows it immediately.
        addLinkedPlanId(plan.id)
        notify({ kind: 'success', message: '', title: s.plans.createdTitle(plan.title) })
        setCreateOpen(false)
        setCreateTitle('')
        setCreateMarkdown('')
        void openPlan(plan.id)
        // Re-list from disk so the row reflects exactly what the backend
        // persisted, rather than trusting only the optimistic upsert above.
        void load()
      } else {
        notify({ kind: 'error', message: res.message, title: s.plans.createFailed })
      }
    } catch (err) {
      notifyError(err, s.plans.createFailed)
    } finally {
      setCreating(false)
    }
  }, [createMarkdown, createTitle, load, openPlan, requirementId, workspaceRoot])

  const openRefine = useCallback(() => {
    if (!detail) {
      return
    }

    setRefineMarkdown(detail.markdown)
    setRefineOpen(true)
  }, [detail])

  const handleRefine = useCallback(async () => {
    if (!detail) {
      return
    }

    setRefining(true)

    try {
      const res = await refinePlan({
        markdown: refineMarkdown,
        planId: detail.id,
        requirementId: requirementId || undefined,
        workspaceRoot
      })

      if (res.ok) {
        const { plan } = res.value

        upsertWorkbenchPlanManifestEntry({
          id: plan.id,
          relativePath: plan.relativePath,
          title: plan.title,
          updatedAt: plan.updatedAt
        })
        addLinkedPlanId(plan.id)
        notify({ kind: 'success', message: '', title: s.plans.refined(plan.version) })
        setRefineOpen(false)
        // The refine response's plan.id is a NEW version, not the one passed
        // in — open it so the new version becomes what's shown as current.
        void openPlan(plan.id)
        void load()
      } else {
        notify({ kind: 'error', message: res.message, title: s.plans.refineFailed })
      }
    } catch (err) {
      notifyError(err, s.plans.refineFailed)
    } finally {
      setRefining(false)
    }
  }, [detail, load, openPlan, refineMarkdown, requirementId, workspaceRoot])

  const handleReveal = useCallback(() => {
    if (!detail) {
      return
    }

    const target = `${workspaceRoot.replace(/[\\/]+$/, '')}/${detail.relativePath}`

    void revealDesktopPath(target)
  }, [detail, workspaceRoot])

  if (!requirementId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <h2 className="text-xs font-semibold text-foreground">{s.plans.heading}</h2>
        <PanelEmpty description={s.plans.selectRequirementDesc} icon="note" title={s.plans.selectRequirementTitle} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-foreground">{s.plans.heading}</h2>
        <Button
          aria-label={s.plans.newPlan}
          className="size-5 text-muted-foreground/70 hover:bg-(--ui-control-active-background) hover:text-foreground"
          onClick={() => setCreateOpen(true)}
          size="icon"
          title={s.plans.newPlan}
          variant="ghost"
        >
          <Codicon name="add" size="0.8125rem" />
        </Button>
      </div>

      <div className="max-h-40 shrink-0 overflow-y-auto">
        {listLoading && linkedPlans.length === 0 ? (
          <PageLoader label={s.plans.loading} />
        ) : listError && linkedPlans.length === 0 ? (
          <PanelEmpty description={listError} icon="error" title={s.plans.loadFailed} />
        ) : linkedPlans.length === 0 ? (
          <PanelEmpty
            action={
              <Button onClick={() => setCreateOpen(true)} size="sm" variant="outline">
                {s.plans.newPlan}
              </Button>
            }
            description={s.plans.emptyDesc}
            icon="inbox"
            title={s.plans.emptyTitle}
          />
        ) : (
          linkedPlans.map(entry => (
            <PanelListRow
              active={entry.id === activePlanId}
              key={entry.id}
              meta={new Date(entry.updatedAt).toLocaleDateString()}
              onSelect={() => void openPlan(entry.id)}
              rowKey={entry.id}
              title={entry.title}
            />
          ))
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-(--ui-stroke-tertiary) pt-2">
        {detailLoading ? (
          <PageLoader label={s.plans.loading} />
        ) : !detail ? (
          <PanelEmpty description={s.plans.selectPlanPrompt} icon="note" title={s.plans.heading} />
        ) : (
          <PlanDetailView detail={detail} history={history} onRefine={openRefine} onReveal={handleReveal} />
        )}
      </div>

      <CreatePlanDialog
        creating={creating}
        markdown={createMarkdown}
        onClose={() => setCreateOpen(false)}
        onCreate={() => void handleCreate()}
        onMarkdownChange={setCreateMarkdown}
        onTitleChange={setCreateTitle}
        open={createOpen}
        title={createTitle}
      />

      <RefinePlanDialog
        markdown={refineMarkdown}
        onClose={() => setRefineOpen(false)}
        onMarkdownChange={setRefineMarkdown}
        onRefine={() => void handleRefine()}
        open={refineOpen}
        refining={refining}
      />
    </div>
  )
}

function PlanDetailView({
  detail,
  history,
  onRefine,
  onReveal
}: {
  detail: WorkbenchPlanDetail
  history: PlanVersionEntry[]
  onRefine: () => void
  onReveal: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="default">{s.plans.versionBadge(detail.version)}</Badge>
        {detail.supersedesPlanId && (
          <span className="text-[0.65rem] text-muted-foreground/60">{s.plans.supersedes(detail.supersedesPlanId)}</span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={onRefine} size="sm" variant="outline">
          <Codicon name="edit" size="0.8125rem" />
          {s.plans.refine}
        </Button>
        <Button onClick={onReveal} size="sm" variant="ghost">
          <Codicon name="folder-opened" size="0.8125rem" />
          {s.plans.revealFile}
        </Button>
      </div>

      <pre className="max-h-64 flex-1 overflow-auto whitespace-pre-wrap break-words rounded bg-foreground/5 p-2.5 font-mono text-[0.68rem] leading-relaxed text-foreground/80">
        {detail.markdown}
      </pre>

      {history.length > 1 && (
        <div className="shrink-0">
          <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground/50">
            {s.plans.historyHeading}
          </span>
          <ul className="mt-1 space-y-1">
            {history.map(entry => (
              <li className="text-[0.65rem] text-muted-foreground/70" key={entry.id}>
                {s.plans.versionBadge(entry.version)} · {entry.id}
                {entry.supersedesPlanId ? ` — ${s.plans.supersedes(entry.supersedesPlanId)}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function CreatePlanDialog({
  creating,
  markdown,
  onClose,
  onCreate,
  onMarkdownChange,
  onTitleChange,
  open,
  title
}: {
  creating: boolean
  markdown: string
  onClose: () => void
  onCreate: () => void
  onMarkdownChange: (value: string) => void
  onTitleChange: (value: string) => void
  open: boolean
  title: string
}) {
  return (
    <Dialog onOpenChange={next => !creating && !next && onClose()} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{s.plans.createTitle}</DialogTitle>
          <DialogDescription>{s.plans.createDialogDesc}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <label className="grid gap-1 text-xs font-medium text-foreground">
            {s.plans.titleLabel}
            <Input
              autoFocus
              disabled={creating}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => onTitleChange(event.target.value)}
              placeholder={s.plans.titlePlaceholder}
              value={title}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-foreground">
            {s.plans.markdownLabel}
            <Textarea
              className="min-h-32 font-mono text-xs"
              disabled={creating}
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => onMarkdownChange(event.target.value)}
              placeholder={s.plans.markdownPlaceholder}
              value={markdown}
            />
          </label>
        </div>

        <DialogFooter>
          <Button disabled={creating} onClick={onClose} variant="outline">
            {s.cancel}
          </Button>
          <Button disabled={creating} onClick={onCreate} variant="default">
            {creating ? s.plans.creating : s.plans.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RefinePlanDialog({
  markdown,
  onClose,
  onMarkdownChange,
  onRefine,
  open,
  refining
}: {
  markdown: string
  onClose: () => void
  onMarkdownChange: (value: string) => void
  onRefine: () => void
  open: boolean
  refining: boolean
}) {
  return (
    <Dialog onOpenChange={next => !refining && !next && onClose()} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{s.plans.refineTitle}</DialogTitle>
          <DialogDescription>{s.plans.refineDialogDesc}</DialogDescription>
        </DialogHeader>

        <label className="grid gap-1 text-xs font-medium text-foreground">
          {s.plans.markdownLabel}
          <Textarea
            className="min-h-48 font-mono text-xs"
            disabled={refining}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => onMarkdownChange(event.target.value)}
            value={markdown}
          />
        </label>

        <DialogFooter>
          <Button disabled={refining} onClick={onClose} variant="outline">
            {s.cancel}
          </Button>
          <Button disabled={refining} onClick={onRefine} variant="default">
            {refining ? s.plans.refining : s.plans.refine}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
