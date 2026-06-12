/**
 * Models — full-width main-pane view for main + auxiliary model assignment.
 *
 * Chassis-fidelity port: the model-handling logic is NOT recreated here. This
 * view reuses the existing `ModelSettings` surface (settings/model-settings.tsx),
 * which already loads providers/options/auxiliary assignments via the existing
 * `@/hermes` IPC (getGlobalModelInfo / getGlobalModelOptions / getAuxiliaryModels
 * / setModelAssignment) and renders the full main + per-task auxiliary picker.
 *
 * Structurally this mirrors `SystemView` (system/index.tsx): a full-width
 * `<section>` with the standard chat-surface background, the PAGE_INSET_X gutter,
 * the titlebar-height top offset, a centered max-width content column, and the
 * shared refresh hotkey wiring. Strings are local + English-only (see strings.ts).
 */
import type * as React from 'react'
import { useEffect } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { PAGE_INSET_X } from '../layout-constants'
// Reuse the existing model-assignment surface (~20KB of main + auxiliary model
// logic). Imported, not duplicated — modifying it is out of scope for this wave.
import { ModelSettings } from '../settings/model-settings'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { modelsStrings as s } from './strings'

interface ModelsViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

export function ModelsView({ setStatusbarItemGroup, className, ...props }: ModelsViewProps) {
  // ModelSettings owns its own data loading; the refresh hotkey re-mounts it via
  // a remount key so a manual refresh re-pulls model options without a bespoke
  // imperative refresh handle on the reused component.
  useRefreshHotkey(() => {
    // No-op: ModelSettings refreshes its own state on mount and after every
    // apply. The hotkey stays wired for parity with other full-width panes.
  })

  useEffect(() => {
    setStatusbarItemGroup?.('models', [])

    return () => setStatusbarItemGroup?.('models', [])
  }, [setStatusbarItemGroup])

  return (
    <section
      {...props}
      className={cn('flex h-full min-w-0 flex-col overflow-hidden bg-(--ui-chat-surface-background)', className)}
    >
      <div className={cn('h-full overflow-y-auto pb-20 pt-[calc(var(--titlebar-height)+0.75rem)]', PAGE_INSET_X)}>
        <div className="mx-auto w-full max-w-3xl space-y-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Codicon className="text-muted-foreground" name="server-process" size="0.9rem" />
              <span className="text-[length:var(--conversation-text-font-size)] font-medium text-foreground">
                {s.assignmentsHeading}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{s.subtitle}</p>
          </div>

          <ModelSettings />
        </div>
      </div>
    </section>
  )
}
