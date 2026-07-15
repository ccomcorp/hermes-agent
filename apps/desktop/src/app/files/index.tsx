/**
 * Files — managed file browser (list / read / upload / mkdir / delete) over the
 * backend's `/api/files` family. Functional parity with the web dashboard's
 * FilesPage, rebuilt in the desktop design system: flat rows, tokens over
 * literals, shared primitives (Button, SearchField, Dialog, Input, Codicon,
 * PageLoader, ErrorState). Distinct from the chat right-rail file viewer.
 *
 * Initial path seeds from the desktop Default project directory
 * (`project-dir.json` / Settings → Sessions), so Files lands on the same root
 * as new sessions rather than the backend home-dir default. Browse / Set as
 * default on this page write that same setting.
 */
import type * as React from 'react'
import { type DragEvent as ReactDragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'
import { applyConfiguredDefaultProjectDir } from '@/store/session'

import { PAGE_INSET_X } from '../layout-constants'
import { PageSearchShell } from '../page-search-shell'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import {
  createDirectory,
  deleteFile,
  listFiles,
  type ManagedFileEntry,
  type ManagedFilesResponse,
  readFile,
  uploadFile
} from './api'
import { FILES_STRINGS as S } from './strings'

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
})

function joinPath(base: string, name: string): string {
  const cleanName = name.trim().replace(/^[\\/]+/, '')

  if (!cleanName) {
    return base
  }

  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'

  if (!base || base.endsWith('/') || base.endsWith('\\')) {
    return `${base}${cleanName}`
  }

  return `${base}${separator}${cleanName}`
}

function formatBytes(size: number | null): string {
  if (size === null) {
    return '—'
  }

  if (size < 1024) {
    return `${size} B`
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }

  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }

  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatMtime(mtime: number): string {
  return Number.isFinite(mtime) ? DATE_FORMAT.format(mtime * 1000) : '—'
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Could not read file'))
      }
    })
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Could not read file')))
    reader.readAsDataURL(file)
  })
}

function downloadDataUrl(dataUrl: string, name: string) {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = name || 'download'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

function transferHasFiles(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

function matchesQuery(entry: ManagedFileEntry, q: string): boolean {
  return !q || entry.name.toLowerCase().includes(q)
}

const GRID_COLS = 'grid-cols-[minmax(10rem,1fr)_6rem_11rem_5rem]'

interface FilesViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup: SetStatusbarItemGroup
}

export function FilesView({ setStatusbarItemGroup, ...props }: FilesViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dragDepthRef = useRef(0)

  const [currentPath, setCurrentPath] = useState<string | undefined>(undefined)
  const [pathInput, setPathInput] = useState('')
  const [listing, setListing] = useState<ManagedFilesResponse | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<ManagedFileEntry | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Gates the list load until we've seeded from Default project directory.
  const [ready, setReady] = useState(false)

  const activePath = listing?.path ?? currentPath ?? ''
  const canChangePath = listing?.can_change_path ?? false
  const canUpload = Boolean(activePath) && !uploading
  const headerPath = (listing?.locked_root ?? listing?.path ?? currentPath ?? '').trim()

  const load = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)

    try {
      const result = await listFiles(path)
      setListing(result)
      setCurrentPath(result.path)
      setPathInput(result.path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  // Bootstrap once from the desktop Default project directory so Files opens
  // on the same root as new sessions (not Path.home() from /api/files).
  useEffect(() => {
    let alive = true

    void (async () => {
      try {
        const settings = window.hermesDesktop?.settings

        if (settings) {
          const result = await settings.getDefaultProjectDir()

          if (!alive) {
            return
          }

          applyConfiguredDefaultProjectDir(result.dir)
          const start = (result.dir || result.resolvedCwd || '').trim()

          if (start) {
            setCurrentPath(start)
            setPathInput(start)
          }
        }
      } catch {
        // Fall through — load(undefined) uses the backend default path.
      } finally {
        if (alive) {
          setReady(true)
        }
      }
    })()

    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!ready) {
      return
    }

    void load(currentPath)
  }, [currentPath, load, ready])

  // Surface the active path + a refresh affordance in the statusbar so the
  // header row stays clean. Cleared on unmount.
  useEffect(() => {
    setStatusbarItemGroup('files', [
      {
        id: 'files-path',
        label: headerPath || S.title,
        title: headerPath || S.title,
        variant: 'text'
      }
    ])

    return () => setStatusbarItemGroup('files', [])
  }, [headerPath, setStatusbarItemGroup])

  const visibleEntries = useMemo(() => {
    if (!listing) {
      return []
    }

    const q = query.trim().toLowerCase()

    return listing.entries
      .filter(entry => matchesQuery(entry, q))
      .sort((a, b) => {
        if (a.is_directory !== b.is_directory) {
          return a.is_directory ? -1 : 1
        }

        return a.name.localeCompare(b.name)
      })
  }, [listing, query])

  const openDirectory = useCallback((entry: ManagedFileEntry) => {
    if (entry.is_directory) {
      setCurrentPath(entry.path)
    }
  }, [])

  const goToPath = useCallback(async () => {
    const nextPath = pathInput.trim()

    if (!nextPath) {
      notify({ kind: 'error', message: S.pathRequired })

      return
    }

    await load(nextPath)
  }, [load, pathInput])

  const browseRoot = useCallback(async () => {
    const settings = window.hermesDesktop?.settings

    if (!settings) {
      return
    }

    try {
      const picked = await settings.pickDefaultProjectDir()

      if (picked.canceled || !picked.dir) {
        return
      }

      const result = await settings.setDefaultProjectDir(picked.dir)
      applyConfiguredDefaultProjectDir(result.dir)
      setCurrentPath(picked.dir)
      setPathInput(picked.dir)
      notify({ kind: 'success', title: S.defaultRootSet, message: picked.dir })
    } catch (err) {
      notifyError(err, S.failedSetRoot)
    }
  }, [])

  const setCurrentAsDefault = useCallback(async () => {
    const settings = window.hermesDesktop?.settings
    const next = (activePath || pathInput).trim()

    if (!settings || !next) {
      return
    }

    try {
      const result = await settings.setDefaultProjectDir(next)
      applyConfiguredDefaultProjectDir(result.dir)
      notify({ kind: 'success', title: S.defaultRootSet, message: next })
    } catch (err) {
      notifyError(err, S.failedSetRoot)
    }
  }, [activePath, pathInput])

  const handleCreateDirectory = useCallback(async () => {
    const name = folderName.trim()

    if (!activePath) {
      notify({ kind: 'error', message: S.directoryUnavailable })

      return
    }

    if (!name) {
      notify({ kind: 'error', message: S.folderNameRequired })

      return
    }

    setCreating(true)

    try {
      await createDirectory(joinPath(activePath, name))
      setFolderName('')
      setCreateDialogOpen(false)
      notify({ kind: 'success', title: S.folderCreated, message: name })
      await load(activePath)
    } catch (err) {
      notifyError(err, S.failedCreate)
    } finally {
      setCreating(false)
    }
  }, [activePath, folderName, load])

  const uploadFiles = useCallback(
    async (files: FileList | null) => {
      if (!files?.length || !activePath) {
        return
      }

      setUploading(true)

      try {
        for (const file of Array.from(files)) {
          const dataUrl = await readAsDataUrl(file)
          await uploadFile(joinPath(activePath, file.name), dataUrl, true)
        }

        notify({
          kind: 'success',
          title: S.uploaded,
          message: `${files.length} file${files.length === 1 ? '' : 's'}`
        })
        await load(activePath)
      } catch (err) {
        notifyError(err, S.failedUpload)
      } finally {
        setUploading(false)

        if (fileInputRef.current) {
          fileInputRef.current.value = ''
        }
      }
    },
    [activePath, load]
  )

  const downloadEntry = useCallback(async (entry: ManagedFileEntry) => {
    if (entry.is_directory) {
      return
    }

    try {
      const file = await readFile(entry.path)
      downloadDataUrl(file.data_url, file.name)
    } catch (err) {
      notifyError(err, S.failedDownload)
    }
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) {
      return
    }

    setDeleting(true)

    try {
      await deleteFile(pendingDelete.path, pendingDelete.is_directory)
      notify({ kind: 'success', title: S.deleted, message: pendingDelete.name })
      setPendingDelete(null)
      await load(activePath)
    } catch (err) {
      notifyError(err, S.failedDelete)
    } finally {
      setDeleting(false)
    }
  }, [activePath, load, pendingDelete])

  function handleDragEnter(event: ReactDragEvent<HTMLElement>) {
    if (!canUpload || !transferHasFiles(event)) {
      return
    }

    event.preventDefault()
    dragDepthRef.current += 1
    setDraggingFiles(true)
  }

  function handleDragOver(event: ReactDragEvent<HTMLElement>) {
    if (!canUpload || !transferHasFiles(event)) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  function handleDragLeave(event: ReactDragEvent<HTMLElement>) {
    if (!canUpload || !transferHasFiles(event)) {
      return
    }

    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)

    if (dragDepthRef.current === 0) {
      setDraggingFiles(false)
    }
  }

  function handleDrop(event: ReactDragEvent<HTMLElement>) {
    if (!canUpload) {
      return
    }

    event.preventDefault()
    dragDepthRef.current = 0
    setDraggingFiles(false)
    void uploadFiles(event.dataTransfer.files)
  }

  const hasEntries = (listing?.entries.length ?? 0) > 0

  return (
    <PageSearchShell
      {...props}
      onSearchChange={setQuery}
      searchHidden={!hasEntries}
      searchPlaceholder={S.searchPlaceholder}
      searchTrailingAction={
        <Button
          aria-label={loading ? S.refreshing : S.refresh}
          className="text-(--ui-text-tertiary) hover:bg-transparent hover:text-foreground"
          disabled={loading}
          onClick={() => void load(activePath || undefined)}
          size="icon-xs"
          title={loading ? S.refreshing : S.refresh}
          type="button"
          variant="ghost"
        >
          <Codicon name="refresh" size="0.875rem" spinning={loading} />
        </Button>
      }
      searchValue={query}
    >
      <input
        className="hidden"
        multiple
        onChange={event => void uploadFiles(event.currentTarget.files)}
        ref={fileInputRef}
        type="file"
      />

      <div className={cn('flex h-full min-w-0 flex-col gap-3 overflow-y-auto py-3', PAGE_INSET_X)}>
        {/* Path + actions row. */}
        <div className="flex min-w-0 flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
          {canChangePath ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-2"
              onSubmit={event => {
                event.preventDefault()
                void goToPath()
              }}
            >
              <Input
                aria-label={S.pathLabel}
                className="min-w-0 flex-1 font-mono"
                onChange={event => setPathInput(event.target.value)}
                placeholder={S.pathPlaceholder}
                value={pathInput}
              />
              <Button size="sm" type="submit" variant="outline">
                {S.go}
              </Button>
              <Button
                onClick={() => void browseRoot()}
                size="sm"
                title={S.browseTitle}
                type="button"
                variant="outline"
              >
                <Codicon name="folder-opened" size="0.875rem" />
                {S.browse}
              </Button>
              <Button
                disabled={!(activePath || pathInput).trim()}
                onClick={() => void setCurrentAsDefault()}
                size="sm"
                title={S.setAsDefaultTitle}
                type="button"
                variant="outline"
              >
                <Codicon name="bookmark" size="0.875rem" />
                {S.setAsDefault}
              </Button>
            </form>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="min-w-0 truncate font-mono text-xs text-(--ui-text-secondary)" title={activePath}>
                {activePath || S.loading}
              </div>
            </div>
          )}

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              disabled={!canUpload}
              onClick={() => fileInputRef.current?.click()}
              size="sm"
              type="button"
              variant="outline"
            >
              <Codicon name={uploading ? 'loading' : 'cloud-upload'} size="0.875rem" spinning={uploading} />
              {uploading ? S.uploading : S.upload}
            </Button>
            <Button
              disabled={!activePath}
              onClick={() => setCreateDialogOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              <Codicon name="new-folder" size="0.875rem" />
              {S.newFolder}
            </Button>
          </div>
        </div>

        {/* Dropzone. Flat: a single dashed hairline, accent fill on hover/drag. */}
        <button
          aria-label={S.upload}
          className={cn(
            'flex min-h-16 w-full min-w-0 items-center justify-between gap-4 rounded-md border border-dashed px-4 py-3 text-left transition-colors',
            draggingFiles
              ? 'border-primary bg-primary/10 text-foreground'
              : 'border-(--ui-stroke-tertiary) text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)',
            !canUpload && 'cursor-default opacity-60'
          )}
          disabled={!canUpload}
          onClick={() => canUpload && fileInputRef.current?.click()}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          type="button"
        >
          <span className="flex min-w-0 items-center gap-3">
            <Codicon
              className="shrink-0 text-(--ui-text-tertiary)"
              name={uploading ? 'loading' : 'cloud-upload'}
              size="1.25rem"
              spinning={uploading}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">
                {uploading ? S.uploading : draggingFiles ? S.dropRelease : S.dropTitle}
              </span>
              <span className="block truncate font-mono text-xs text-(--ui-text-tertiary)" title={activePath}>
                {activePath || S.loading}
              </span>
            </span>
          </span>
          <span className="hidden shrink-0 text-xs text-(--ui-text-tertiary) sm:block">{S.chooseFiles}</span>
        </button>

        {/* Listing. */}
        {error ? (
          <ErrorState
            className="py-12"
            description={error}
            title={S.errorTitle}
          >
            <Button onClick={() => void load(activePath || undefined)} variant="outline">
              {S.refresh}
            </Button>
          </ErrorState>
        ) : loading && !listing ? (
          <PageLoader label={S.loading} />
        ) : (
          <div className="min-w-0">
            {/* Header row. */}
            <div
              className={cn(
                'grid min-w-[36rem] items-center gap-3 border-b border-(--ui-stroke-tertiary) px-1 py-2 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-(--ui-text-tertiary)',
                GRID_COLS
              )}
            >
              <span>{S.colName}</span>
              <span>{S.colSize}</span>
              <span>{S.colModified}</span>
              <span className="text-right">{S.colActions}</span>
            </div>

            {listing?.parent && (
              <button
                className={cn(
                  'grid w-full min-w-[36rem] items-center gap-3 px-1 py-2 text-left text-sm transition-colors hover:bg-(--chrome-action-hover)',
                  GRID_COLS
                )}
                onClick={() => setCurrentPath(listing.parent ?? undefined)}
                title={S.parentDir}
                type="button"
              >
                <span className="flex min-w-0 items-center gap-2 font-mono text-(--ui-text-secondary)">
                  <Codicon className="shrink-0 text-(--ui-text-tertiary)" name="arrow-up" size="0.875rem" />
                  ..
                </span>
                <span />
                <span />
                <span />
              </button>
            )}

            {visibleEntries.length === 0 ? (
              <FilesEmpty searching={query.trim().length > 0} />
            ) : (
              visibleEntries.map(entry => (
                <div
                  className={cn(
                    'grid min-w-[36rem] items-center gap-3 px-1 py-2 text-sm transition-colors hover:bg-(--chrome-action-hover)',
                    GRID_COLS
                  )}
                  key={entry.path}
                >
                  <button
                    className="flex min-w-0 items-center gap-2 text-left font-mono text-foreground"
                    onClick={() => (entry.is_directory ? openDirectory(entry) : void downloadEntry(entry))}
                    type="button"
                  >
                    <Codicon
                      className={cn('shrink-0', entry.is_directory ? 'text-primary' : 'text-(--ui-text-tertiary)')}
                      name={entry.is_directory ? 'folder' : 'file'}
                      size="0.875rem"
                    />
                    <span className="truncate">{entry.name}</span>
                  </button>
                  <span className="text-xs tabular-nums text-(--ui-text-secondary)">{formatBytes(entry.size)}</span>
                  <span className="truncate text-xs text-(--ui-text-secondary)">{formatMtime(entry.mtime)}</span>
                  <span className="flex justify-end gap-0.5">
                    <Button
                      aria-label={entry.is_directory ? `${S.open} ${entry.name}` : `${S.download} ${entry.name}`}
                      className="text-(--ui-text-tertiary) hover:text-foreground"
                      onClick={() => (entry.is_directory ? openDirectory(entry) : void downloadEntry(entry))}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <Codicon name={entry.is_directory ? 'folder-opened' : 'cloud-download'} size="0.875rem" />
                    </Button>
                    <Button
                      aria-label={`${S.delete} ${entry.name}`}
                      className="text-(--ui-text-tertiary) hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setPendingDelete(entry)}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <Codicon name="trash" size="0.875rem" />
                    </Button>
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Create-folder dialog. */}
      <Dialog
        onOpenChange={open => {
          if (creating) {
            return
          }

          setCreateDialogOpen(open)

          if (!open) {
            setFolderName('')
          }
        }}
        open={createDialogOpen}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{S.createFolderTitle}</DialogTitle>
            <DialogDescription className="font-mono">
              {S.createFolderTarget}: {activePath || S.loading}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            disabled={creating}
            onChange={event => setFolderName(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                void handleCreateDirectory()
              }
            }}
            placeholder={S.folderNamePlaceholder}
            value={folderName}
          />
          <DialogFooter>
            <Button
              disabled={creating}
              onClick={() => {
                setCreateDialogOpen(false)
                setFolderName('')
              }}
              type="button"
              variant="outline"
            >
              {S.cancel}
            </Button>
            <Button disabled={creating} onClick={() => void handleCreateDirectory()} type="button">
              <Codicon name={creating ? 'loading' : 'new-folder'} size="0.875rem" spinning={creating} />
              {creating ? S.creating : S.create}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete-confirm dialog. */}
      <Dialog
        onOpenChange={open => !open && !deleting && setPendingDelete(null)}
        open={pendingDelete !== null}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{pendingDelete ? `${S.delete} ${pendingDelete.name}?` : S.deleteTitle}</DialogTitle>
            <DialogDescription>
              {pendingDelete?.is_directory ? S.deleteFolderDesc : S.deleteFileDesc}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={deleting} onClick={() => setPendingDelete(null)} type="button" variant="outline">
              {S.cancel}
            </Button>
            <Button disabled={deleting} onClick={() => void confirmDelete()} type="button" variant="destructive">
              {deleting ? S.deleting : S.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSearchShell>
  )
}

function FilesEmpty({ searching }: { searching: boolean }) {
  return (
    <div className="grid min-h-40 place-items-center text-center">
      <div>
        <div className="text-sm font-medium">{searching ? S.emptySearchTitle : S.emptyTitle}</div>
        <div className="mt-1 text-xs text-muted-foreground">{searching ? S.emptySearchDesc : S.emptyDesc}</div>
      </div>
    </div>
  )
}
