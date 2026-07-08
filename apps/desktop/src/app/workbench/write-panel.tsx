import type { WorkbenchWriteExportFormat, WorkbenchWriteRecentEdit } from '@hermes/shared'
/**
 * Write Workspace panel — list existing WorkbenchWriteProjects (via api.ts ->
 * preload -> IPC -> `.hermes/workbench/write/<id>/{document.md,project.json}`
 * on disk, never an in-memory mock), create new ones (title + Markdown), and
 * open/edit/save an existing one. This follows requirement-panel.tsx's exact
 * structural pattern (list/create/open/edit/save), plus what Slice J adds on
 * top: a live Markdown preview alongside the source textarea (reusing the
 * existing `CompactMarkdown` renderer — see the import below — rather than
 * writing a new Markdown-to-React pipeline) and a source/preview/split view
 * toggle. "Recent edits" is a passive, read-only history list of saves (the
 * backend's `recentEdits`), NOT an undo-an-AI-edit mechanism — there is no AI
 * edit flow in this slice to undo.
 *
 * Slice L adds Export (HTML/PDF/DOCX/PNG) — see `./write-export.tsx` for the
 * markdown -> HTML rendering (reusing CompactMarkdown) and `./api.ts`'s
 * `exportWriteProject` for the IPC call. Export is only ever offered from
 * inside `WriteEditor`, which only renders when a write project is open, so
 * there is no open project -> no export action, by construction.
 *
 * Hard scope boundary: no quick actions (polish/explain/reformat/distill/
 * strengthen/soften/critique), no selection-aware inline edit, and no
 * retrieval from workspace sources live here — those are Slice K. This file
 * never calls a model/skill/agent API.
 *
 * No raw filesystem path ever appears here — every call goes through a write
 * project id plus the workspace root the shell already validated. Export's
 * target path is chosen entirely by the user via the OS save dialog on the
 * main-process side; this file never sees or constructs that path.
 */
import { useStore } from '@nanostores/react'
import type * as React from 'react'
import { useCallback, useEffect, useState } from 'react'

import { CompactMarkdown } from '@/components/chat/compact-markdown'
import { PageLoader } from '@/components/page-loader'
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { notify, notifyError } from '@/store/notifications'

import { ListColumn, MasterDetail } from '../master-detail'
import { PanelEmpty, PanelListRow } from '../overlays/panel'

import {
  createWriteProject,
  exportWriteProject,
  listWriteProjects,
  readWriteProject,
  updateWriteProject
} from './api'
import type { WorkbenchWriteProjectDetail } from './api'
import {
  $workbenchActiveWriteProjectId,
  $workbenchWriteProjects,
  $workbenchWriteProjectsError,
  $workbenchWriteProjectsLoading,
  patchWorkbenchWriteProjectManifestEntry,
  setWorkbenchActiveWriteProjectId,
  setWorkbenchWriteProjects,
  setWorkbenchWriteProjectsError,
  setWorkbenchWriteProjectsLoading,
  upsertWorkbenchWriteProjectManifestEntry
} from './store'
import { workbenchStrings as s } from './strings'
import { renderWriteExportHtml } from './write-export'

type SplitMode = 'source' | 'preview' | 'split'

interface WritePanelProps {
  workspaceRoot: string
}

export function WritePanel({ workspaceRoot }: WritePanelProps) {
  const projects = useStore($workbenchWriteProjects)
  const activeId = useStore($workbenchActiveWriteProjectId)
  const listLoading = useStore($workbenchWriteProjectsLoading)
  const listError = useStore($workbenchWriteProjectsError)

  const [detail, setDetail] = useState<WorkbenchWriteProjectDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [draftMarkdown, setDraftMarkdown] = useState('')
  const [draftTitle, setDraftTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [viewMode, setViewMode] = useState<SplitMode>('split')
  const [exportingFormat, setExportingFormat] = useState<WorkbenchWriteExportFormat | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [createTitle, setCreateTitle] = useState('')
  const [createMarkdown, setCreateMarkdown] = useState('')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setWorkbenchWriteProjectsLoading(true)
    setWorkbenchWriteProjectsError(null)

    try {
      const res = await listWriteProjects(workspaceRoot)

      if (res.ok) {
        setWorkbenchWriteProjects(res.value)
      } else {
        setWorkbenchWriteProjectsError(res.message)
        notify({ kind: 'error', title: s.write.loadFailed, message: res.message })
      }
    } catch (err) {
      notifyError(err, s.write.loadFailed)
    } finally {
      setWorkbenchWriteProjectsLoading(false)
    }
  }, [workspaceRoot])

  useEffect(() => {
    setDetail(null)
    void load()
  }, [load])

  const openProject = useCallback(
    async (writeProjectId: string) => {
      setWorkbenchActiveWriteProjectId(writeProjectId)
      setDetailLoading(true)
      setDetail(null)

      try {
        const res = await readWriteProject(workspaceRoot, writeProjectId)

        if (res.ok) {
          setDetail(res.value)
          setDraftMarkdown(res.value.markdown)
          setDraftTitle(res.value.title)
        } else {
          notify({ kind: 'error', title: s.write.openFailed, message: res.message })
        }
      } catch (err) {
        notifyError(err, s.write.openFailed)
      } finally {
        setDetailLoading(false)
      }
    },
    [workspaceRoot]
  )

  const handleCreate = useCallback(async () => {
    const title = createTitle.trim()

    if (!title) {
      notify({ kind: 'error', title: s.write.createFailed, message: s.write.titleLabel })

      return
    }

    setCreating(true)

    try {
      const res = await createWriteProject({ workspaceRoot, title, markdown: createMarkdown })

      if (res.ok) {
        const { project } = res.value

        upsertWorkbenchWriteProjectManifestEntry({
          id: project.id,
          title: project.title,
          relativePath: project.activeFileRelativePath ?? project.rootRelativeDir,
          updatedAt: project.updatedAt
        })
        setWorkbenchActiveWriteProjectId(project.id)
        setDetail({
          id: project.id,
          title: project.title,
          markdown: createMarkdown || `# ${title}\n\n> Start writing here.\n`,
          rootRelativeDir: project.rootRelativeDir,
          activeFileRelativePath: project.activeFileRelativePath,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          recentEdits: []
        })
        setDraftMarkdown(createMarkdown || `# ${title}\n\n> Start writing here.\n`)
        setDraftTitle(title)
        notify({ kind: 'success', title: s.write.createdTitle(title), message: '' })
        setCreateOpen(false)
        setCreateTitle('')
        setCreateMarkdown('')
        void load()
      } else {
        notify({ kind: 'error', title: s.write.createFailed, message: res.message })
      }
    } catch (err) {
      notifyError(err, s.write.createFailed)
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

      const res = await updateWriteProject({
        workspaceRoot,
        writeProjectId: activeId,
        markdown: draftMarkdown,
        title: trimmedTitle || undefined
      })

      if (res.ok) {
        setDetail(current => (current ? { ...current, markdown: draftMarkdown, title: res.value.title ?? current.title } : current))

        patchWorkbenchWriteProjectManifestEntry(activeId, {
          updatedAt: res.value.updatedAt,
          ...(trimmedTitle ? { title: trimmedTitle } : {})
        })

        notify({ kind: 'success', title: s.write.saved, message: '' })

        // Re-read so the recent-edits history list reflects exactly what the
        // backend persisted, rather than trusting a client-side guess.
        void openProject(activeId)
      } else {
        notify({ kind: 'error', title: s.write.saveFailed, message: res.message })
      }
    } catch (err) {
      notifyError(err, s.write.saveFailed)
    } finally {
      setSaving(false)
    }
  }, [activeId, draftMarkdown, draftTitle, openProject, workspaceRoot])

  // Renders the current draft to a standalone HTML document (client-side,
  // reusing CompactMarkdown) and hands it to the main process, which shows
  // the OS save dialog and writes ONLY to whatever path the user picks there
  // — this function never sees or builds a filesystem path itself. Only
  // reachable while a write project is open (see WriteEditor below), so
  // there is no separate "no open project" guard needed here beyond the
  // `!activeId` early return.
  const handleExport = useCallback(
    async (format: WorkbenchWriteExportFormat) => {
      if (!activeId) {
        return
      }

      const title = draftTitle.trim() || detail?.title || 'Untitled document'

      setExportingFormat(format)

      try {
        const html = renderWriteExportHtml(draftMarkdown, title)

        const res = await exportWriteProject({
          workspaceRoot,
          writeProjectId: activeId,
          format,
          title,
          html
        })

        if (res.ok) {
          // A canceled OS dialog is not an error — stay silent, matching
          // normal save-dialog-cancel UX.
          if (!res.value.canceled && res.value.path) {
            notify({ kind: 'success', title: s.write.exported(res.value.path), message: '' })
          }
        } else {
          notify({ kind: 'error', title: s.write.exportFailed, message: res.message })
        }
      } catch (err) {
        notifyError(err, s.write.exportFailed)
      } finally {
        setExportingFormat(null)
      }
    },
    [activeId, detail, draftMarkdown, draftTitle, workspaceRoot]
  )

  const dirty = detail !== null && (draftMarkdown !== detail.markdown || draftTitle !== detail.title)

  return (
    <>
      <MasterDetail>
        <ListColumn
          header={
            <div className="mb-1 flex h-6 shrink-0 items-center justify-between gap-2 pl-2 pr-1">
              <span className="text-[0.68rem] font-medium uppercase tracking-wide text-muted-foreground/60">
                {s.write.heading}
              </span>
              <Button
                aria-label={s.write.newProject}
                className="size-5 text-muted-foreground/70 hover:bg-(--ui-control-active-background) hover:text-foreground"
                onClick={() => setCreateOpen(true)}
                size="icon"
                title={s.write.newProject}
                variant="ghost"
              >
                <Codicon name="add" size="0.8125rem" />
              </Button>
            </div>
          }
        >
          {listLoading && projects.length === 0 ? (
            <PageLoader label={s.write.loading} />
          ) : listError && projects.length === 0 ? (
            <PanelEmpty description={listError} icon="error" title={s.write.loadFailed} />
          ) : projects.length === 0 ? (
            <PanelEmpty
              action={
                <Button onClick={() => setCreateOpen(true)} size="sm" variant="outline">
                  {s.write.newProject}
                </Button>
              }
              description={s.write.emptyDesc}
              icon="inbox"
              title={s.write.emptyTitle}
            />
          ) : (
            projects.map(entry => (
              <PanelListRow
                active={entry.id === activeId}
                key={entry.id}
                meta={new Date(entry.updatedAt).toLocaleDateString()}
                onSelect={() => void openProject(entry.id)}
                rowKey={entry.id}
                title={entry.title}
              />
            ))
          )}
        </ListColumn>

        <main className="flex min-h-0 flex-col overflow-hidden">
          {detailLoading ? (
            <PageLoader label={s.write.loading} />
          ) : !detail ? (
            <div className="flex flex-1 items-center justify-center">
              <PanelEmpty description={s.write.selectPrompt} icon="note" title={s.write.heading} />
            </div>
          ) : (
            <WriteEditor
              detail={detail}
              dirty={dirty}
              draftMarkdown={draftMarkdown}
              draftTitle={draftTitle}
              exportingFormat={exportingFormat}
              onExport={format => void handleExport(format)}
              onMarkdownChange={setDraftMarkdown}
              onSave={() => void handleSave()}
              onTitleChange={setDraftTitle}
              onViewModeChange={setViewMode}
              saving={saving}
              viewMode={viewMode}
            />
          )}
        </main>
      </MasterDetail>

      <CreateWriteProjectDialog
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

function ViewModeToggle({ onChange, value }: { onChange: (mode: SplitMode) => void; value: SplitMode }) {
  const options: { label: string; mode: SplitMode }[] = [
    { label: s.write.viewSource, mode: 'source' },
    { label: s.write.viewSplit, mode: 'split' },
    { label: s.write.viewPreview, mode: 'preview' }
  ]

  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-(--ui-stroke-secondary) p-0.5">
      {options.map(option => (
        <button
          className={
            option.mode === value
              ? 'rounded-[0.25rem] bg-(--ui-control-active-background) px-2 py-0.5 text-[0.68rem] font-medium text-foreground'
              : 'rounded-[0.25rem] px-2 py-0.5 text-[0.68rem] font-medium text-muted-foreground/70 hover:text-foreground'
          }
          key={option.mode}
          onClick={() => onChange(option.mode)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function RecentEditsList({ recentEdits }: { recentEdits: WorkbenchWriteRecentEdit[] }) {
  if (recentEdits.length === 0) {
    return <p className="text-[0.68rem] text-muted-foreground/60">{s.write.recentEditsEmpty}</p>
  }

  // Newest first — the backend appends in chronological order.
  const ordered = [...recentEdits].reverse()

  return (
    <ul className="space-y-1">
      {ordered.map((entry, index) => (
        <li className="flex items-center justify-between gap-2 text-[0.65rem] text-muted-foreground/70" key={index}>
          <span className="truncate">{entry.fileRelativePath}</span>
          <span className="shrink-0 tabular-nums">{s.write.recentEditAgo(entry.ageMs)}</span>
        </li>
      ))}
    </ul>
  )
}

function ExportMenu({
  exportingFormat,
  onExport
}: {
  exportingFormat: WorkbenchWriteExportFormat | null
  onExport: (format: WorkbenchWriteExportFormat) => void
}) {
  const exporting = exportingFormat !== null

  const items: { format: WorkbenchWriteExportFormat; label: string }[] = [
    { format: 'html', label: s.write.exportHtml },
    { format: 'pdf', label: s.write.exportPdf },
    { format: 'docx', label: s.write.exportDocx },
    { format: 'png', label: s.write.exportPng }
  ]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button disabled={exporting} size="sm" variant="outline">
          <Codicon name={exporting ? 'loading' : 'export'} size="0.875rem" spinning={exporting} />
          {exporting ? s.write.exporting : s.write.export}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map(item => (
          <DropdownMenuItem disabled={exporting} key={item.format} onSelect={() => onExport(item.format)}>
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function WriteEditor({
  detail,
  dirty,
  draftMarkdown,
  draftTitle,
  exportingFormat,
  onExport,
  onMarkdownChange,
  onSave,
  onTitleChange,
  onViewModeChange,
  saving,
  viewMode
}: {
  detail: WorkbenchWriteProjectDetail
  dirty: boolean
  draftMarkdown: string
  draftTitle: string
  exportingFormat: WorkbenchWriteExportFormat | null
  onExport: (format: WorkbenchWriteExportFormat) => void
  onMarkdownChange: (value: string) => void
  onSave: () => void
  onTitleChange: (value: string) => void
  onViewModeChange: (mode: SplitMode) => void
  saving: boolean
  viewMode: SplitMode
}) {
  const showSource = viewMode === 'source' || viewMode === 'split'
  const showPreview = viewMode === 'preview' || viewMode === 'split'

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={s.write.editTitleLabel}
          className="max-w-sm font-medium"
          onChange={event => onTitleChange(event.target.value)}
          value={draftTitle}
        />
        {dirty && <span className="text-[0.65rem] text-muted-foreground/60">{s.write.unsavedHint}</span>}
        <div className="ml-auto flex items-center gap-2">
          <ViewModeToggle onChange={onViewModeChange} value={viewMode} />
          <ExportMenu exportingFormat={exportingFormat} onExport={onExport} />
          <Button disabled={saving || !dirty} onClick={onSave} size="sm">
            <Codicon name={saving ? 'loading' : 'save'} size="0.875rem" spinning={saving} />
            {saving ? s.write.saving : s.write.save}
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden md:grid-flow-col md:auto-cols-fr">
        {showSource && (
          <Textarea
            aria-label={s.write.markdownLabel}
            className="min-h-64 flex-1 resize-none font-mono text-xs"
            onChange={event => onMarkdownChange(event.target.value)}
            value={draftMarkdown}
          />
        )}
        {showPreview && (
          <div className="min-h-64 flex-1 overflow-y-auto rounded-md border border-(--ui-stroke-secondary) p-3">
            <CompactMarkdown text={draftMarkdown} />
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-(--ui-stroke-tertiary) pt-2">
        <span className="text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground/50">
          {s.write.recentEditsHeading}
        </span>
        <div className="mt-1 max-h-24 overflow-y-auto">
          <RecentEditsList recentEdits={detail.recentEdits} />
        </div>
      </div>
    </div>
  )
}

function CreateWriteProjectDialog({
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
          <DialogTitle>{s.write.createTitle}</DialogTitle>
          <DialogDescription>{s.write.createDialogDesc}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <label className="grid gap-1 text-xs font-medium text-foreground">
            {s.write.titleLabel}
            <Input
              autoFocus
              disabled={creating}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => onTitleChange(event.target.value)}
              placeholder={s.write.titlePlaceholder}
              value={title}
            />
          </label>
          <label className="grid gap-1 text-xs font-medium text-foreground">
            {s.write.markdownLabel}
            <Textarea
              className="min-h-32 font-mono text-xs"
              disabled={creating}
              onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => onMarkdownChange(event.target.value)}
              placeholder={s.write.markdownPlaceholder}
              value={markdown}
            />
          </label>
        </div>

        <DialogFooter>
          <Button disabled={creating} onClick={onClose} variant="outline">
            {s.cancel}
          </Button>
          <Button disabled={creating || !title.trim()} onClick={onCreate} variant="default">
            {creating ? s.write.creating : s.write.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
