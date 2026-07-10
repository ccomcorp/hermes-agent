/**
 * Config — full-width main-pane view for Hermes agent configuration.
 *
 * Chassis-fidelity port (AIOS `aios` fork): this is the standalone, full-width
 * pane counterpart to the existing Settings → Config tabs. It does NOT
 * re-implement config logic — it REUSES the settings feature's `SECTIONS`
 * (section/keys map) and `ConfigSettings` (load → edit → debounced autosave via
 * the `getHermesConfig*`/`saveHermesConfig` IPC) so there is a single source of
 * truth for config behaviour. This pane only owns the full-width chrome and the
 * in-pane section tab nav.
 *
 * Skeleton/props mirror `app/system/index.tsx` (the canonical full-width pane):
 *  - same `{ setStatusbarItemGroup }` prop signature (system/index.tsx:139-143)
 *  - same root `<section className="flex h-full min-w-0 flex-col overflow-hidden
 *    bg-(--ui-chat-surface-background)">` shell (system/index.tsx:524-529)
 *  - same `PAGE_INSET_X` gutter + titlebar-offset scroll body.
 *
 * Section selection is persisted in the URL via `useRouteEnumParam` (the chassis
 * convention used by Settings, so the active section survives a refresh).
 *
 * Config path: mirrors the web dashboard Config page header — profile-scoped
 * absolute path from GET /api/config/raw (not a hard-coded ~/.hermes hint).
 */
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { getHermesConfigRaw } from '@/hermes'
import { Copy } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'
import { useOnProfileSwitch } from '../hooks/use-on-profile-switch'
import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import { PAGE_INSET_X } from '../layout-constants'
import { AppearanceSettings } from '../settings/appearance-settings'
import { ConfigSettings } from '../settings/config-settings'
import { SECTIONS } from '../settings/constants'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { configStrings as s } from './strings'

interface ConfigViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
  /** Re-fetch config-dependent chrome (e.g. model badges) after an autosave. */
  onConfigSaved?: () => void
  /** Notify the host when the main model changes (mirrors Settings wiring). */
  onMainModelChanged?: (provider: string, model: string) => void
}

export function ConfigView({
  setStatusbarItemGroup,
  onConfigSaved,
  onMainModelChanged,
  className,
  ...props
}: ConfigViewProps) {
  const sectionIds = useMemo(() => SECTIONS.map(section => section.id), [])
  const [activeSectionId, setActiveSectionId] = useRouteEnumParam(
    'section',
    sectionIds,
    sectionIds[0] ?? 'model'
  )

  // ConfigSettings owns a hidden file input for config import; this pane has no
  // import affordance, but the prop is required, so pass a real ref.
  const importInputRef = useRef<HTMLInputElement | null>(null)

  const [configPath, setConfigPath] = useState<string | null>(null)
  const [pathLoading, setPathLoading] = useState(true)

  const loadConfigPath = useCallback(async () => {
    setPathLoading(true)

    try {
      const raw = await getHermesConfigRaw()
      setConfigPath(raw.path || null)
    } catch {
      setConfigPath(null)
    } finally {
      setPathLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadConfigPath()
  }, [loadConfigPath])

  // Profile switch changes HERMES_HOME → different config.yaml path.
  useOnProfileSwitch(() => {
    void loadConfigPath()
  })

  useEffect(() => {
    setStatusbarItemGroup?.('config', [
      {
        id: 'config-yaml-path',
        label: s.configFileLabel,
        detail: pathLoading ? '…' : configPath || '—',
        title: configPath || s.configFileUnavailable,
        variant: 'text'
      }
    ])

    return () => setStatusbarItemGroup?.('config', [])
  }, [configPath, pathLoading, setStatusbarItemGroup])

  const copyPath = useCallback(async () => {
    if (!configPath) {
      return
    }

    try {
      await navigator.clipboard.writeText(configPath)
      notify({ kind: 'success', title: s.pathCopied, message: configPath })
    } catch (err) {
      notifyError(err, s.copyPath)
    }
  }, [configPath])

  return (
    <section
      {...props}
      className={cn('flex h-full min-w-0 flex-col overflow-hidden bg-(--ui-chat-surface-background)', className)}
    >
      {/* ── Header / section tab nav ─────────────────────────────────── */}
      <div
        className={cn(
          'shrink-0 border-b border-(--ui-stroke-tertiary) pt-[calc(var(--titlebar-height)+0.75rem)]',
          PAGE_INSET_X
        )}
      >
        <div className="mx-auto w-full max-w-4xl">
          <div className="flex items-center gap-2 pb-2">
            <Codicon className="text-muted-foreground" name="settings-gear" size="1rem" />
            <h1 className="text-[length:var(--conversation-text-font-size)] font-medium text-foreground">
              {s.title}
            </h1>
            <span className="text-xs text-muted-foreground">{s.subtitle}</span>
          </div>

          {/* Absolute config.yaml path — web Config page header parity */}
          <div className="mb-3 flex min-w-0 items-center gap-2 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary)/40 px-2.5 py-1.5">
            <Codicon className="shrink-0 text-muted-foreground" name="file" size="0.875rem" />
            <code
              className="min-w-0 flex-1 truncate font-mono text-[0.7rem] text-muted-foreground"
              title={configPath || undefined}
            >
              {pathLoading ? s.configFileLoading : configPath || s.configFileUnavailable}
            </code>
            <Button
              className="h-7 shrink-0 gap-1 px-2 text-[0.7rem]"
              disabled={!configPath}
              onClick={() => void copyPath()}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Copy className="size-3.5" />
              {s.copyPath}
            </Button>
          </div>

          <nav aria-label={s.sectionNavLabel} className="-mb-px flex flex-wrap gap-1 pb-1">
            {SECTIONS.map(section => {
              const Icon = section.icon
              const active = section.id === activeSectionId

              return (
                <button
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[length:var(--conversation-text-font-size)] transition',
                    active
                      ? 'bg-(--ui-bg-tertiary) text-foreground'
                      : 'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground'
                  )}
                  key={section.id}
                  onClick={() => setActiveSectionId(section.id)}
                  type="button"
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="min-w-0 truncate">{section.label}</span>
                </button>
              )
            })}
          </nav>
        </div>
      </div>

      {/* ── Scrollable section body (reused ConfigSettings) ──────────── */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeSectionId === 'appearance' ? (
          // The `appearance` section carries no config keys (constants.ts →
          // keys: []); it is rendered by the dedicated AppearanceSettings
          // component, mirroring the Settings overlay (settings/index.tsx). Without
          // this intercept the generic ConfigSettings renders an empty
          // "Nothing to configure" pane for Appearance in this full-width view.
          <AppearanceSettings />
        ) : (
          <ConfigSettings
            activeSectionId={activeSectionId}
            importInputRef={importInputRef}
            onConfigSaved={onConfigSaved}
            onMainModelChanged={onMainModelChanged}
          />
        )}
      </div>
    </section>
  )
}
