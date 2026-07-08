import type { WorkbenchManifestEntry, WorkbenchRequirementStatus } from '@hermes/shared'
/**
 * Requirement panel — list existing Requirement Units (via api.ts -> preload
 * -> IPC -> `.hermes/workbench/requirements/<id>/{requirement.md,trace.json}`
 * on disk, never an in-memory mock), create new ones (title + Markdown), and
 * open/edit/save an existing one. Status shown is the persisted
 * `WorkbenchRequirement`/trace status, not a client-side guess.
 *
 * No raw filesystem path ever appears here — every call goes through a
 * requirement id plus the workspace root the shell already validated.
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
import { notify, notifyError } from '@/store/notifications'

import { DetailColumn, ListColumn, MasterDetail } from '../master-detail'
import { PanelEmpty, PanelListRow } from '../overlays/panel'

import { createRequirement, listRequirements, readRequirement, updateRequirement } from './api'
import type { WorkbenchRequirementDetail } from './api'
import {
  $workbenchActiveRequirementId,
  $workbenchListError,
  $workbenchListLoading,
  $workbenchRequirements,
  patchWorkbenchManifestEntry,
  setWorkbenchActiveRequirementId,
  setWorkbenchListError,
  setWorkbenchListLoading,
  setWorkbenchRequirements,
  upsertWorkbenchManifestEntry
} from './store'
import { workbenchStrings as s } from './strings'

const STATUS_OPTIONS: WorkbenchRequirementStatus[] = [
  'draft',
  'clarified',
  'planned',
  'in_progress',
  'implemented',
  'reviewed',
  'verified',
  'archived'
]

interface RequirementPanelProps {
  workspaceRoot: string
}

export function RequirementPanel({ workspaceRoot }: RequirementPanelProps) {
  const requirements = useStore($workbenchRequirements)
  const activeId = useStore($workbenchActiveRequirementId)
  const listLoading = useStore($workbenchListLoading)
  const listError = useStore($workbenchListError)

  const [detail, setDetail] = useState<WorkbenchRequirementDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [draftMarkdown, setDraftMarkdown] = useState('')
  const [draftTitle, setDraftTitle] = useState('')
  const [draftStatus, setDraftStatus] = useState<WorkbenchRequirementStatus>('draft')
  const [saving, setSaving] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [createTitle, setCreateTitle] = useState('')
  const [createMarkdown, setCreateMarkdown] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setWorkbenchListLoading(true)
    setWorkbenchListError(null)

    try {
      const res = await listRequirements(workspaceRoot)

      if (res.ok) {
        setWorkbenchRequirements(res.value)
      } else {
        setWorkbenchListError(res.message)
        notify({ kind: 'error', title: s.loadFailed, message: res.message })
      }
    } catch (err) {
      notifyError(err, s.loadFailed)
    } finally {
      setWorkbenchListLoading(false)
    }
  }, [workspaceRoot])

  // Fresh list on mount and on every workspace-root change (the shell only
  // mounts this panel once a root is selected, so this also covers "list
  // survives reload").
  useEffect(() => {
    setDetail(null)
    void load()
  }, [load])

  const openRequirement = useCallback(
    async (requirementId: string) => {
      setWorkbenchActiveRequirementId(requirementId)
      setDetailLoading(true)
      setDetail(null)

      try {
        const res = await readRequirement(workspaceRoot, requirementId)

        if (res.ok) {
          setDetail(res.value)
          setDraftMarkdown(res.value.markdown)
          setDraftTitle(res.value.trace?.title ?? requirementId)
          setDraftStatus(res.value.trace?.status ?? 'draft')
        } else {
          notify({ kind: 'error', title: s.openFailed, message: res.message })
        }
      } catch (err) {
        notifyError(err, s.openFailed)
      } finally {
        setDetailLoading(false)
      }
    },
    [workspaceRoot]
  )

  const handleCreate = useCallback(async () => {
    const title = createTitle.trim()

    if (!title) {
      notify({ kind: 'error', title: s.createFailed, message: s.titleLabel })

      return
    }

    setCreating(true)

    try {
      const res = await createRequirement({ workspaceRoot, title, markdown: createMarkdown, source: 'user' })

      if (res.ok) {
        const { requirement, trace } = res.value

        upsertWorkbenchManifestEntry({
          id: requirement.id,
          title: requirement.title,
          relativePath: requirement.draftRelativePath,
          updatedAt: requirement.updatedAt
        })
        setWorkbenchActiveRequirementId(requirement.id)
        setDetail({
          id: requirement.id,
          markdown: createMarkdown || `# ${title}\n\n> Describe the requirement here.\n`,
          trace,
          draftRelativePath: requirement.draftRelativePath,
          traceRelativePath: requirement.traceRelativePath
        })
        setDraftMarkdown(createMarkdown || `# ${title}\n\n> Describe the requirement here.\n`)
        setDraftTitle(title)
        setDraftStatus('draft')
        notify({ kind: 'success', title: s.createdTitle(title), message: '' })
        setCreateOpen(false)
        setCreateTitle('')
        setCreateMarkdown('')
        // Re-list from disk so the row reflects exactly what the backend
        // persisted, rather than trusting only the optimistic upsert above.
        void load()
      } else {
        notify({ kind: 'error', title: s.createFailed, message: res.message })
      }
    } catch (err) {
      notifyError(err, s.createFailed)
    } finally {
      setCreating(false)
    }
  }, [createMarkdown, createTitle, load, workspaceRoot])

  const handleSave = useCallback(async () => {
    if (!activeId) {
      return
    }

    setSaving(true)

    try {
      const trimmedTitle = draftTitle.trim()

      const res = await updateRequirement({
        workspaceRoot,
        requirementId: activeId,
        markdown: draftMarkdown,
        title: trimmedTitle || undefined,
        status: draftStatus
      })

      if (res.ok) {
        setDetail(current =>
          current
            ? {
                ...current,
                markdown: draftMarkdown,
                trace: current.trace
                  ? { ...current.trace, status: draftStatus, title: trimmedTitle || current.trace.title }
                  : current.trace
              }
            : current
        )

        const patch: Partial<WorkbenchManifestEntry> = { updatedAt: res.value.updatedAt }

        if (trimmedTitle) {
          patch.title = trimmedTitle
        }

        patchWorkbenchManifestEntry(activeId, patch)
        notify({ kind: 'success', title: s.saved, message: '' })
      } else {
        notify({ kind: 'error', title: s.saveFailed, message: res.message })
      }
    } catch (err) {
      notifyError(err, s.saveFailed)
    } finally {
      setSaving(false)
    }
  }, [activeId, draftMarkdown, draftStatus, draftTitle, workspaceRoot])

  const dirty =
    detail !== null &&
    (draftMarkdown !== detail.markdown ||
      draftTitle !== (detail.trace?.title ?? '') ||
      draftStatus !== (detail.trace?.status ?? 'draft'))

  return (
    <>
      <MasterDetail>
        <ListColumn
          header={
            <div className="mb-1 flex h-6 shrink-0 items-center justify-between gap-2 pl-2 pr-1">
              <span className="text-[0.68rem] font-medium uppercase tracking-wide text-muted-foreground/60">
                {s.title}
              </span>
              <Button
                aria-label={s.newRequirement}
                className="size-5 text-muted-foreground/70 hover:bg-(--ui-control-active-background) hover:text-foreground"
                onClick={() => setCreateOpen(true)}
                size="icon"
                title={s.newRequirement}
                variant="ghost"
              >
                <Codicon name="add" size="0.8125rem" />
              </Button>
            </div>
          }
        >
          {listLoading && requirements.length === 0 ? (
            <PageLoader label={s.loading} />
          ) : listError && requirements.length === 0 ? (
            <PanelEmpty
              action={
                <Button onClick={() => void load()} size="sm" variant="outline">
                  {s.refresh}
                </Button>
              }
              description={listError}
              icon="error"
              title={s.loadFailed}
            />
          ) : requirements.length === 0 ? (
            <PanelEmpty
              action={
                <Button onClick={() => setCreateOpen(true)} size="sm" variant="outline">
                  {s.newRequirement}
                </Button>
              }
              description={s.emptyDesc}
              icon="inbox"
              title={s.emptyTitle}
            />
          ) : (
            requirements.map(entry => (
              <PanelListRow
                active={entry.id === activeId}
                key={entry.id}
                meta={new Date(entry.updatedAt).toLocaleDateString()}
                onSelect={() => void openRequirement(entry.id)}
                rowKey={entry.id}
                title={entry.title}
              />
            ))
          )}
        </ListColumn>

        <DetailColumn
          actionBar={
            detail ? (
              <Button disabled={saving || !dirty} onClick={() => void handleSave()} size="sm">
                <Codicon name={saving ? 'loading' : 'save'} size="0.875rem" spinning={saving} />
                {saving ? s.saving : s.save}
              </Button>
            ) : undefined
          }
        >
          {detailLoading ? (
            <PageLoader label={s.loading} />
          ) : !detail ? (
            <PanelEmpty description={s.selectPrompt} icon="note" title={s.title} />
          ) : (
            <RequirementEditor
              dirty={dirty}
              draftMarkdown={draftMarkdown}
              draftStatus={draftStatus}
              draftTitle={draftTitle}
              onMarkdownChange={setDraftMarkdown}
              onStatusChange={setDraftStatus}
              onTitleChange={setDraftTitle}
            />
          )}
        </DetailColumn>
      </MasterDetail>

      <CreateRequirementDialog
        creating={creating}
        markdown={createMarkdown}
        onClose={() => setCreateOpen(false)}
        onCreate={() => void handleCreate()}
        onMarkdownChange={setCreateMarkdown}
        onTitleChange={setCreateTitle}
        open={createOpen}
        title={createTitle}
      />
    </>
  )
}

function RequirementEditor({
  dirty,
  draftMarkdown,
  draftStatus,
  draftTitle,
  onMarkdownChange,
  onStatusChange,
  onTitleChange
}: {
  dirty: boolean
  draftMarkdown: string
  draftStatus: WorkbenchRequirementStatus
  draftTitle: string
  onMarkdownChange: (value: string) => void
  onStatusChange: (value: WorkbenchRequirementStatus) => void
  onTitleChange: (value: string) => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={s.editTitleLabel}
          className="max-w-sm font-medium"
          onChange={event => onTitleChange(event.target.value)}
          value={draftTitle}
        />
        <Badge variant={draftStatus === 'archived' ? 'muted' : 'default'}>
          {s.statusNames[draftStatus] ?? draftStatus}
        </Badge>
        {dirty && <span className="text-[0.65rem] text-muted-foreground/60">{s.unsavedHint}</span>}
      </div>

      <label className="grid gap-1 text-xs font-medium text-foreground">
        {s.statusLabel}
        <select
          className="w-fit rounded-md border border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) px-2 py-1 text-xs text-foreground"
          onChange={event => onStatusChange(event.target.value as WorkbenchRequirementStatus)}
          value={draftStatus}
        >
          {STATUS_OPTIONS.map(status => (
            <option key={status} value={status}>
              {s.statusNames[status] ?? status}
            </option>
          ))}
        </select>
      </label>

      <label className="grid min-h-0 flex-1 gap-1 text-xs font-medium text-foreground">
        {s.editMarkdownLabel}
        <Textarea
          className="min-h-64 flex-1 font-mono text-xs"
          onChange={event => onMarkdownChange(event.target.value)}
          value={draftMarkdown}
        />
      </label>
    </div>
  )
}

function CreateRequirementDialog({
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
          <DialogTitle>{s.createTitle}</DialogTitle>
          <DialogDescription>{s.createDialogDesc}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <label className="grid gap-1 text-xs font-medium text-foreground">
            {s.titleLabel}
            <Input
              autoFocus
              disabled={creating}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => onTitleChange(event.target.value)}
              placeholder={s.titlePlaceholder}
              value={title}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-foreground">
            {s.markdownLabel}
            <Textarea
              className="min-h-32 font-mono text-xs"
              disabled={creating}
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => onMarkdownChange(event.target.value)}
              placeholder={s.markdownPlaceholder}
              value={markdown}
            />
          </label>
        </div>

        <DialogFooter>
          <Button disabled={creating} onClick={onClose} variant="outline">
            {s.cancel}
          </Button>
          <Button disabled={creating || !title.trim()} onClick={onCreate} variant="default">
            {creating ? s.creating : s.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
