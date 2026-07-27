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
 * Config path + import/export/reset: mirrors the web dashboard Config page
 * header (path display, JSON export/import, reset). Path is profile-scoped
 * (HERMES_HOME) — not an arbitrary free-text path; Reveal opens the folder.
 */
import type * as React from 'react'
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import {
  getHermesConfigDefaults,
  getHermesConfigRaw,
  getHermesConfigRecord,
  saveHermesConfig
} from '@/hermes'
import { revealDesktopPath } from '@/lib/desktop-fs'
import { triggerHaptic } from '@/lib/haptics'
import { Copy, Download, FolderOpen, RefreshCw, Upload } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'
import type { HermesConfigRecord } from '@/types/hermes'

import { setHermesConfigCache } from '../hooks/use-config-record'
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

  // Own the import input here so Import works even when Appearance is selected
  // (ConfigSettings is unmounted in that case). Settings overlay keeps its own.
  const importInputRef = useRef<HTMLInputElement | null>(null)
  // Required by ConfigSettings when mounted — unused for the toolbar import.
  const settingsImportRef = useRef<HTMLInputElement | null>(null)

  const [configPath, setConfigPath] = useState<string | null>(null)
  const [pathLoading, setPathLoading] = useState(true)
  // Bump to force ConfigSettings remount after external import/reset so fields refresh.
  const [configEpoch, setConfigEpoch] = useState(0)

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

  const exportConfig = useCallback(async () => {
    try {
      const cfg = await getHermesConfigRecord()
      const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'hermes-config.json'
      a.click()
      URL.revokeObjectURL(url)
      triggerHaptic('success')
      notify({ kind: 'success', title: s.exportDone, message: 'hermes-config.json' })
    } catch (err) {
      notifyError(err, s.exportFailed)
    }
  }, [])

  const resetConfig = useCallback(async () => {
    if (!window.confirm(s.resetConfirm)) {
      return
    }

    try {
      const defaults = await getHermesConfigDefaults()
      await saveHermesConfig(defaults)
      setHermesConfigCache(defaults)
      setConfigEpoch(n => n + 1)
      triggerHaptic('success')
      notify({ kind: 'success', title: s.resetDone, message: s.configFileLabel })
      onConfigSaved?.()
      void loadConfigPath()
    } catch (err) {
      notifyError(err, s.resetFailed)
    }
  }, [loadConfigPath, onConfigSaved])

  const revealConfig = useCallback(async () => {
    if (!configPath) {
      return
    }

    try {
      await revealDesktopPath(configPath)
    } catch (err) {
      notifyError(err, s.revealFailed)
    }
  }, [configPath])

  const openImport = useCallback(() => {
    triggerHaptic('open')
    importInputRef.current?.click()
  }, [])

  const handleImportFile = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''

      if (!file) {
        return
      }

      const reader = new FileReader()

      reader.onload = () => {
        void (async () => {
          try {
            const imported = JSON.parse(String(reader.result)) as HermesConfigRecord
            await saveHermesConfig(imported)
            setHermesConfigCache(imported)
            setConfigEpoch(n => n + 1)
            triggerHaptic('success')
            notify({ kind: 'success', title: s.importConfig, message: 'Saved' })
            onConfigSaved?.()
            void loadConfigPath()
          } catch (err) {
            notifyError(err, s.importFailed)
          }
        })()
      }

      reader.readAsText(file)
    },
    [loadConfigPath, onConfigSaved]
  )

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

          {/* Absolute config.yaml path + web-parity toolbar */}
          <div className="mb-3 flex min-w-0 flex-col gap-2 rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary)/40 px-2.5 py-1.5 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Codicon className="shrink-0 text-muted-foreground" name="file" size="0.875rem" />
              <code
                className="min-w-0 flex-1 truncate font-mono text-[0.7rem] text-muted-foreground"
                title={configPath || s.pathHint}
              >
                {pathLoading ? s.configFileLoading : configPath || s.configFileUnavailable}
              </code>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-0.5">
              <Tip label={s.copyPath}>
                <Button
                  className="h-7 gap-1 px-2 text-[0.7rem]"
                  disabled={!configPath}
                  onClick={() => void copyPath()}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Copy className="size-3.5" />
                  <span className="hidden sm:inline">{s.copyPath}</span>
                </Button>
              </Tip>

              <Tip label={s.revealInFolder}>
                <Button
                  className="h-7 gap-1 px-2 text-[0.7rem]"
                  disabled={!configPath}
                  onClick={() => void revealConfig()}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <FolderOpen className="size-3.5" />
                  <span className="hidden sm:inline">{s.revealInFolder}</span>
                </Button>
              </Tip>

              <div className="mx-0.5 h-4 w-px bg-(--ui-stroke-tertiary)" />

              <Tip label={s.exportConfig}>
                <Button
                  className="h-7 gap-1 px-2 text-[0.7rem]"
                  onClick={() => void exportConfig()}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Download className="size-3.5" />
                  <span className="hidden sm:inline">{s.exportConfig}</span>
                </Button>
              </Tip>

              <Tip label={s.importConfig}>
                <Button
                  className="h-7 gap-1 px-2 text-[0.7rem]"
                  onClick={openImport}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Upload className="size-3.5" />
                  <span className="hidden sm:inline">{s.importConfig}</span>
                </Button>
              </Tip>

              <Tip label={s.resetToDefaults}>
                <Button
                  className="h-7 gap-1 px-2 text-[0.7rem] hover:text-destructive"
                  onClick={() => {
                    triggerHaptic('warning')
                    void resetConfig()
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <RefreshCw className="size-3.5" />
                  <span className="hidden sm:inline">{s.resetToDefaults}</span>
                </Button>
              </Tip>
            </div>
          </div>

          <p className="mb-2 text-[0.65rem] leading-snug text-muted-foreground">{s.pathHint}</p>

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
            importInputRef={settingsImportRef}
            key={`config-body-${configEpoch}`}
            onConfigSaved={onConfigSaved}
            onMainModelChanged={onMainModelChanged}
          />
        )}
      </div>

      <input
        accept=".json,application/json"
        className="hidden"
        onChange={handleImportFile}
        ref={importInputRef}
        type="file"
      />
    </section>
  )
}
