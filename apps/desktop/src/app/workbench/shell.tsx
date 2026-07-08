/**
 * Workbench shell — three regions (left: requirement list, center: editor,
 * right: trace/linked-artifacts stub) plus a status bar showing workspace
 * root, terminal cwd, profile, and backend mode as separate, distinctly
 * labeled items (03-security-and-constraints.md §4 — profiles are not a
 * filesystem sandbox, so this view never conflates profile with workspace
 * root). Fails closed: with no workspace root selected, nothing under
 * `.hermes/workbench` is read or written — this shows a "select a workspace"
 * empty state instead.
 */
import { useStore } from '@nanostores/react'
import type * as React from 'react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $currentCwd } from '@/store/session'

import { PAGE_INSET_X } from '../layout-constants'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { ChangeSetPanel } from './changeset-panel'
import { DesignSettingsPanel } from './design-settings-panel'
import { PlanPanel } from './plan-panel'
import { RequirementPanel } from './requirement-panel'
import { $workbenchBackendMode, $workbenchWorkspaceRoot, setWorkbenchWorkspaceRoot } from './store'
import { workbenchStrings as s } from './strings'
import { WritePanel } from './write-panel'

// Top-level area switch (Requirements+Plans+ChangeSets+Design vs. Write
// Workspace). LAYOUT DECISION (Slice J): Write Workspace's live source/preview
// split needs real width to be usable — the existing 20rem right rail (which
// already stacks Plans/ChangeSets/Design settings) has no room left for a
// second editor pane. Rather than cram a fourth thing into that rail or force
// a redesign of the existing Requirements-centric layout, Write Workspace gets
// its own full-width area behind a simple two-way tab switch in the header,
// the same kind of one-off layout call Slices C/D/F each made when a new
// artifact type didn't fit the existing regions cleanly. Local component
// state (not persisted) — matches how Slice J's split-mode toggle is also a
// plain, non-persisted view state.
type WorkbenchArea = 'requirements' | 'write'

interface WorkbenchShellProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

export function WorkbenchShell({ setStatusbarItemGroup, ...props }: WorkbenchShellProps) {
  const workspaceRoot = useStore($workbenchWorkspaceRoot)
  const terminalCwd = useStore($currentCwd)
  const activeProfile = useStore($activeGatewayProfile)
  const backendMode = useStore($workbenchBackendMode)
  const [area, setArea] = useState<WorkbenchArea>('requirements')

  // Four distinctly-labeled status items, mirroring how Files pushes a single
  // 'files-path' group (files/index.tsx) — never merged into one string, so
  // "workspace root" and "profile" can never be read as the same thing.
  useEffect(() => {
    setStatusbarItemGroup?.('workbench', [
      {
        id: 'workbench-workspace-root',
        label: s.statusBar.workspaceRoot,
        detail: workspaceRoot || '—',
        title: workspaceRoot || s.selectWorkspaceTitle,
        variant: 'text'
      },
      {
        id: 'workbench-terminal-cwd',
        label: s.statusBar.terminalCwd,
        detail: terminalCwd || '—',
        title: terminalCwd || undefined,
        variant: 'text'
      },
      {
        id: 'workbench-profile',
        label: s.statusBar.profile,
        detail: normalizeProfileKey(activeProfile),
        variant: 'text'
      },
      {
        id: 'workbench-backend-mode',
        label: backendMode === 'local' ? s.statusBar.backendLocal : s.statusBar.backendRemoteUnsupported,
        variant: 'text'
      }
    ])

    return () => setStatusbarItemGroup?.('workbench', [])
  }, [activeProfile, backendMode, setStatusbarItemGroup, terminalCwd, workspaceRoot])

  const pickWorkspace = useCallback(async () => {
    try {
      const picked = await window.hermesDesktop.selectPaths({
        directories: true,
        multiple: false,
        title: s.selectWorkspace
      })

      const next = picked?.[0]

      if (next) {
        setWorkbenchWorkspaceRoot(next)
      }
    } catch (err) {
      notifyError(err, s.selectWorkspace)
    }
  }, [])

  return (
    <section
      {...props}
      className="flex h-full min-w-0 flex-col overflow-hidden bg-(--ui-chat-surface-background)"
    >
      <header
        className={cn(
          'flex shrink-0 items-center justify-between gap-3 pb-2 pt-[calc(var(--titlebar-height)+0.5rem)]',
          PAGE_INSET_X
        )}
      >
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-foreground">{s.title}</h1>
          {workspaceRoot && (
            <div className="flex items-center gap-0.5 rounded-md border border-(--ui-stroke-secondary) p-0.5">
              <button
                className={
                  area === 'requirements'
                    ? 'rounded-[0.25rem] bg-(--ui-control-active-background) px-2 py-0.5 text-[0.7rem] font-medium text-foreground'
                    : 'rounded-[0.25rem] px-2 py-0.5 text-[0.7rem] font-medium text-muted-foreground/70 hover:text-foreground'
                }
                onClick={() => setArea('requirements')}
                type="button"
              >
                {s.title}
              </button>
              <button
                className={
                  area === 'write'
                    ? 'rounded-[0.25rem] bg-(--ui-control-active-background) px-2 py-0.5 text-[0.7rem] font-medium text-foreground'
                    : 'rounded-[0.25rem] px-2 py-0.5 text-[0.7rem] font-medium text-muted-foreground/70 hover:text-foreground'
                }
                onClick={() => setArea('write')}
                type="button"
              >
                {s.write.navLabel}
              </button>
            </div>
          )}
        </div>
        <Button onClick={() => void pickWorkspace()} size="sm" variant="outline">
          <Codicon name="folder-opened" size="0.875rem" />
          {workspaceRoot ? s.changeWorkspace : s.selectWorkspace}
        </Button>
      </header>

      {!workspaceRoot ? (
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div className="flex max-w-sm flex-col items-center gap-3">
            <Codicon className="text-muted-foreground/50" name="folder" size="1.5rem" />
            <p className="text-sm font-medium text-foreground/90">{s.selectWorkspaceTitle}</p>
            <p className="text-xs leading-relaxed text-muted-foreground/70">{s.selectWorkspaceDesc}</p>
            <Button onClick={() => void pickWorkspace()} size="sm" variant="default">
              {s.selectWorkspace}
            </Button>
          </div>
        </div>
      ) : area === 'write' ? (
        <div className="grid min-h-0 flex-1 grid-cols-1">
          <WritePanel workspaceRoot={workspaceRoot} />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[minmax(0,1fr)_20rem]">
          <RequirementPanel workspaceRoot={workspaceRoot} />
          {/* Right rail: Plans linked to whichever requirement RequirementPanel
              has open (Slice C), stacked above ChangeSet review (Slice D,
              status-only — see changeset-panel.tsx), stacked above Design
              Studio settings (Slice F, settings only — see
              design-settings-panel.tsx). ChangeSets and Design settings are
              both workspace-wide rather than requirement-scoped (no backend
              linkage to derive from yet, see store.ts), so they get their own
              stacked sections instead of requiring an open requirement —
              Design settings uses a bounded/scrollable block rather than
              flex-1 like Plans/ChangeSets since it's a single form, not a
              list+detail split, so it doesn't need to compete for equal
              vertical share. This still fits the existing two-column shell
              without adding a new region or a tab. */}
          <aside className="hidden min-h-0 flex-col gap-3 border-l border-(--ui-stroke-tertiary) p-3 sm:flex sm:overflow-y-auto">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <PlanPanel workspaceRoot={workspaceRoot} />
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-(--ui-stroke-tertiary) pt-3">
              <ChangeSetPanel workspaceRoot={workspaceRoot} />
            </div>
            <div className="flex shrink-0 flex-col border-t border-(--ui-stroke-tertiary) pt-3">
              <DesignSettingsPanel workspaceRoot={workspaceRoot} />
            </div>
          </aside>
        </div>
      )}
    </section>
  )
}
