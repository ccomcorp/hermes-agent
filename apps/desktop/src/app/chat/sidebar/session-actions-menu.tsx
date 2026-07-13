import { useStore } from '@nanostores/react'
import type * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { CopyButton } from '@/components/ui/copy-button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { renameSession } from '@/hermes'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { exportSession } from '@/lib/session-export'
import { activeGateway } from '@/store/gateway'
import { notify, notifyError } from '@/store/notifications'
import {
  $projects,
  createProjectAndMoveSession,
  moveSessionToProject,
  pickProjectFolder,
  projectWorkspacePath,
  refreshProjects
} from '@/store/projects'
import { $activeSessionId, $currentCwd, $selectedStoredSessionId, setSessions } from '@/store/session'
import { canOpenSessionWindow, openSessionInNewWindow } from '@/store/windows'
import type { ProjectInfo } from '@/types/hermes'

import type { SessionTitleResponse } from '../../types'

// Rename a session, preferring the gateway's session.title RPC over REST.
//
// A freshly *branched* session (and any brand-new chat) lives only in the
// gateway's in-memory _sessions map keyed by its RUNTIME id — no row is
// persisted to state.db until the first turn. REST PATCH /api/sessions/{id}
// resolves against the stored sessions table, so it 404s ("Session not found")
// on these runtime-only sessions. The session.title RPC resolves the live
// runtime session AND persists the row on demand, so it succeeds where REST
// cannot. This mirrors the /title slash command's fix (use-prompt-actions.ts).
//
// We only take the RPC path for the ACTIVE/selected session: its runtime id is
// known ($activeSessionId) and it lives on the active gateway, so there is no
// profile-routing ambiguity. Every other row (already persisted, possibly on a
// background profile) keeps the REST path, which handles profile scoping and a
// non-empty title is required by the RPC (it rejects clears), so clears stay on
// REST too.
export async function renameSessionPreferringRpc(
  storedSessionId: string,
  title: string,
  profile?: string
): Promise<{ title?: string }> {
  const isActiveRow = storedSessionId === $selectedStoredSessionId.get()
  const runtimeId = isActiveRow ? $activeSessionId.get() : null
  const gateway = activeGateway()

  if (title && runtimeId && gateway) {
    try {
      const result = await gateway.request<SessionTitleResponse>('session.title', {
        session_id: runtimeId,
        title
      })

      return { title: result?.title ?? title }
    } catch (err) {
      // Fall through to REST — e.g. the socket is mid-reconnect. REST still
      // works for any session that already has a persisted row. Log so a
      // genuine RPC-side failure (which then surfaces a REST 404 for the
      // runtime id) is at least diagnosable instead of silently swallowed.
      console.warn('session.title RPC rename failed; falling back to REST', err)
    }
  }

  return renameSession(storedSessionId, title, profile)
}

interface SessionActions {
  sessionId: string
  title: string
  pinned?: boolean
  profile?: string
  onPin?: () => void
  onBranch?: () => void
  onArchive?: () => void
  onDelete?: () => void
}

type MenuItem = typeof DropdownMenuItem | typeof ContextMenuItem

interface ItemSpec {
  className?: string
  disabled: boolean
  icon: string
  label: string
  onSelect: (event: Event) => void
  variant?: 'destructive'
}

function useSessionActions({
  sessionId,
  title,
  pinned = false,
  profile,
  onPin,
  onBranch,
  onArchive,
  onDelete
}: SessionActions) {
  const { t } = useI18n()
  const r = t.sidebar.row
  const [renameOpen, setRenameOpen] = useState(false)
  const [moveCreateOpen, setMoveCreateOpen] = useState(false)
  const [moving, setMoving] = useState(false)
  const allProjects = useStore($projects)

  // Explicit, non-archived projects with at least one folder — those are the
  // only targets that can own a session via cwd-prefix.
  const moveTargets = useMemo(
    () =>
      allProjects
        .filter(project => !project.archived && projectWorkspacePath(project))
        .slice()
        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    [allProjects]
  )

  useEffect(() => {
    // Keep the submenu list fresh when the menu mounts (projects can lag).
    void refreshProjects().catch(() => undefined)
  }, [])

  const runMove = async (project: ProjectInfo) => {
    if (!sessionId || moving) {
      return
    }

    setMoving(true)
    triggerHaptic('selection')

    try {
      await moveSessionToProject({ sessionId, project, profile })
      notify({
        durationMs: 2_500,
        kind: 'success',
        message: r.movedToProject(project.name || project.id)
      })
    } catch (err) {
      notifyError(err, r.moveFailed)
    } finally {
      setMoving(false)
    }
  }

  const pinItem: ItemSpec = {
    disabled: !onPin,
    icon: 'pin',
    label: pinned ? r.unpin : r.pin,
    onSelect: () => {
      triggerHaptic('selection')
      onPin?.()
    }
  }

  const items: ItemSpec[] = [
    ...(canOpenSessionWindow()
      ? [
          {
            disabled: !sessionId,
            icon: 'link-external',
            label: r.newWindow,
            onSelect: () => {
              triggerHaptic('selection')
              void openSessionInNewWindow(sessionId)
            }
          }
        ]
      : []),
    {
      disabled: !sessionId,
      icon: 'cloud-download',
      label: r.export,
      onSelect: () => {
        triggerHaptic('selection')
        void exportSession(sessionId, { profile, title })
      }
    },
    {
      disabled: !onBranch,
      icon: 'git-branch',
      label: r.branchFrom,
      onSelect: () => {
        triggerHaptic('selection')
        onBranch?.()
      }
    },
    {
      disabled: !sessionId,
      icon: 'edit',
      label: r.rename,
      onSelect: () => {
        triggerHaptic('selection')
        setRenameOpen(true)
      }
    },
    {
      disabled: !onArchive,
      icon: 'archive',
      label: r.archive,
      onSelect: () => {
        triggerHaptic('selection')
        onArchive?.()
      }
    },
    {
      className: 'text-destructive focus:text-destructive',
      disabled: !onDelete,
      icon: 'trash',
      label: t.common.delete,
      onSelect: () => {
        triggerHaptic('warning')
        onDelete?.()
      },
      variant: 'destructive'
    }
  ]

  const renderMenuItem = (Item: MenuItem, { className, disabled, icon, label, onSelect, variant }: ItemSpec) => (
    <Item className={className} disabled={disabled} key={label} onSelect={onSelect} variant={variant}>
      <Codicon name={icon} size="0.875rem" />
      <span>{label}</span>
    </Item>
  )

  const renderMoveSubmenu = (variant: 'dropdown' | 'context') => {
    const Sub = variant === 'dropdown' ? DropdownMenuSub : ContextMenuSub
    const SubTrigger = variant === 'dropdown' ? DropdownMenuSubTrigger : ContextMenuSubTrigger
    const SubContent = variant === 'dropdown' ? DropdownMenuSubContent : ContextMenuSubContent
    const Item = variant === 'dropdown' ? DropdownMenuItem : ContextMenuItem
    const Separator = variant === 'dropdown' ? DropdownMenuSeparator : ContextMenuSeparator

    return (
      <Sub key="move-to-project">
        <SubTrigger disabled={!sessionId || moving} className="gap-2">
          <Codicon name="folder" size="0.875rem" />
          <span>{r.moveToProject}</span>
        </SubTrigger>
        <SubContent className="max-h-72 w-56 overflow-y-auto">
          {moveTargets.length === 0 ? (
            <Item disabled>
              <span className="text-muted-foreground">{r.moveNoProjects}</span>
            </Item>
          ) : (
            moveTargets.map(project => (
              <Item
                disabled={moving}
                key={project.id}
                onSelect={() => {
                  void runMove(project)
                }}
              >
                <Codicon name="folder" size="0.875rem" />
                <span className="truncate">{project.name || project.id}</span>
              </Item>
            ))
          )}
          <Separator />
          <Item
            disabled={!sessionId || moving}
            onSelect={() => {
              triggerHaptic('selection')
              setMoveCreateOpen(true)
            }}
          >
            <Codicon name="new-folder" size="0.875rem" />
            <span>{r.moveNewProject}</span>
          </Item>
        </SubContent>
      </Sub>
    )
  }

  const renderItems = (Item: MenuItem, variant: 'dropdown' | 'context') => (
    <>
      {renderMenuItem(Item, pinItem)}
      <CopyButton
        appearance={Item === DropdownMenuItem ? 'menu-item' : 'context-menu-item'}
        disabled={!sessionId}
        errorMessage={r.copyIdFailed}
        iconClassName="size-3.5 text-current"
        key={r.copyId}
        label={r.copyId}
        onCopyError={err => notifyError(err, r.copyIdFailed)}
        text={sessionId}
      />
      {renderMoveSubmenu(variant)}
      {items.map(spec => renderMenuItem(Item, spec))}
    </>
  )

  const renameDialog = (
    <RenameSessionDialog
      currentTitle={title}
      onOpenChange={setRenameOpen}
      open={renameOpen}
      profile={profile}
      sessionId={sessionId}
    />
  )

  const moveCreateDialog = (
    <MoveToNewProjectDialog
      onOpenChange={setMoveCreateOpen}
      open={moveCreateOpen}
      profile={profile}
      sessionId={sessionId}
      sessionTitle={title}
    />
  )

  return { moveCreateDialog, renameDialog, renderItems }
}

interface SessionActionsMenuProps
  extends SessionActions, Pick<React.ComponentProps<typeof DropdownMenuContent>, 'align' | 'sideOffset'> {
  children: React.ReactNode
}

export function SessionActionsMenu({ children, align = 'end', sideOffset = 6, ...actions }: SessionActionsMenuProps) {
  const { t } = useI18n()
  const { moveCreateDialog, renameDialog, renderItems } = useSessionActions(actions)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent
          align={align}
          aria-label={t.sidebar.row.actionsFor(actions.title)}
          className="w-48"
          sideOffset={sideOffset}
        >
          {renderItems(DropdownMenuItem, 'dropdown')}
        </DropdownMenuContent>
      </DropdownMenu>
      {renameDialog}
      {moveCreateDialog}
    </>
  )
}

interface SessionContextMenuProps extends SessionActions {
  children: React.ReactNode
}

export function SessionContextMenu({ children, ...actions }: SessionContextMenuProps) {
  const { t } = useI18n()
  const { moveCreateDialog, renameDialog, renderItems } = useSessionActions(actions)

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent aria-label={t.sidebar.row.actionsFor(actions.title)} className="w-48">
          {renderItems(ContextMenuItem, 'context')}
        </ContextMenuContent>
      </ContextMenu>
      {renameDialog}
      {moveCreateDialog}
    </>
  )
}

interface RenameSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  currentTitle: string
  profile?: string
}

function RenameSessionDialog({ open, onOpenChange, sessionId, currentTitle, profile }: RenameSessionDialogProps) {
  const { t } = useI18n()
  const r = t.sidebar.row
  const [value, setValue] = useState(currentTitle)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setValue(currentTitle)
      window.setTimeout(() => inputRef.current?.select(), 0)
    }
  }, [currentTitle, open])

  const submit = async () => {
    const next = value.trim()

    if (!sessionId || submitting) {
      return
    }

    if (next === currentTitle.trim()) {
      onOpenChange(false)

      return
    }

    setSubmitting(true)

    try {
      const result = await renameSessionPreferringRpc(sessionId, next, profile)
      const finalTitle = result.title || next || ''
      setSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, title: finalTitle || null } : s)))
      notify({ durationMs: 2_000, kind: 'success', message: r.renamed })
      onOpenChange(false)
    } catch (err) {
      notifyError(err, r.renameFailed)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{r.renameTitle}</DialogTitle>
          <DialogDescription>{r.renameDesc}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          disabled={submitting}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            } else if (event.key === 'Escape') {
              onOpenChange(false)
            }
          }}
          placeholder={r.untitledPlaceholder}
          ref={inputRef}
          value={value}
        />
        <DialogFooter>
          <Button disabled={submitting} onClick={() => onOpenChange(false)} type="button" variant="ghost">
            {t.common.cancel}
          </Button>
          <Button disabled={submitting} onClick={() => void submit()} type="button">
            {t.common.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface MoveToNewProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  sessionTitle: string
  profile?: string
}

function MoveToNewProjectDialog({
  open,
  onOpenChange,
  sessionId,
  sessionTitle,
  profile
}: MoveToNewProjectDialogProps) {
  const { t } = useI18n()
  const r = t.sidebar.row
  const [name, setName] = useState('')
  const [folder, setFolder] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    // Default name from the chat title when it looks usable; folder from the
    // live workspace chip (or empty → user picks).
    const defaultName = (sessionTitle || '').trim()
    setName(defaultName && defaultName.length <= 60 ? defaultName : '')
    setFolder(($currentCwd.get() || '').trim())
    setSubmitting(false)
    window.setTimeout(() => nameRef.current?.select(), 0)
  }, [open, sessionTitle])

  const submit = async () => {
    const trimmedName = name.trim()
    const trimmedFolder = folder.trim()

    if (!sessionId || !trimmedName || !trimmedFolder || submitting) {
      return
    }

    setSubmitting(true)

    try {
      const created = await createProjectAndMoveSession({
        sessionId,
        name: trimmedName,
        folder: trimmedFolder,
        profile
      })
      notify({
        durationMs: 2_500,
        kind: 'success',
        message: r.movedToProject(created.name || trimmedName)
      })
      onOpenChange(false)
    } catch (err) {
      notifyError(err, r.moveFailed)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{r.moveNewProjectTitle}</DialogTitle>
          <DialogDescription>{r.moveNewProjectDesc}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-muted-foreground text-xs font-medium" htmlFor="move-project-name">
              {r.moveProjectName}
            </label>
            <Input
              autoFocus
              disabled={submitting}
              id="move-project-name"
              onChange={event => setName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void submit()
                }
              }}
              placeholder="Hermes Update"
              ref={nameRef}
              value={name}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-muted-foreground text-xs font-medium" htmlFor="move-project-folder">
              {r.moveProjectFolder}
            </label>
            <div className="flex gap-2">
              <Input
                disabled={submitting}
                id="move-project-folder"
                onChange={event => setFolder(event.target.value)}
                placeholder={r.moveProjectFolderPlaceholder}
                value={folder}
              />
              <Button
                disabled={submitting}
                onClick={() => {
                  void pickProjectFolder().then(dir => {
                    if (dir) {
                      setFolder(dir)
                    }
                  })
                }}
                type="button"
                variant="outline"
              >
                {r.moveBrowse}
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button disabled={submitting} onClick={() => onOpenChange(false)} type="button" variant="ghost">
            {t.common.cancel}
          </Button>
          <Button
            disabled={submitting || !name.trim() || !folder.trim()}
            onClick={() => void submit()}
            type="button"
          >
            {r.moveCreateAndMove}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
