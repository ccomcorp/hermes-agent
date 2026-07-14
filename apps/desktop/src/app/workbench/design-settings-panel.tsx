import type { WorkbenchDesignSettings } from '@hermes/shared'
/**
 * Design Studio settings panel — Slice F, SETTINGS ONLY (go-forward plan §5
 * Slice F/G/H/I split).
 *
 * This is a plain form over the single `WorkbenchDesignSettings` document
 * persisted per workspace at `.hermes/workbench/designs/settings.json` (via
 * api.ts -> preload -> IPC, never an in-memory mock or a direct filesystem
 * path from this component). Loads existing settings on mount — the backend
 * always returns a value (sensible defaults when nothing has been saved yet;
 * see workbench-artifacts.cjs `readDesignSettings`), so there is no separate
 * "create" step, just load + edit + save.
 *
 * Hard scope boundary: this file only ever calls `readDesignSettings`/
 * `writeDesignSettings`. Brief/HTML-prototype generation (Slice G) lives in
 * the sibling `design-generation-panel.tsx`; sandboxed prototype preview
 * (Slice H) and design-to-code ChangeSet application (Slice I) remain
 * out of scope everywhere in Design Studio — neither exists yet.
 */
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { notify, notifyError } from '@/store/notifications'

import { PanelEmpty } from '../overlays/panel'

import { readDesignSettings, writeDesignSettings } from './api'
import {
  $workbenchDesignSettings,
  $workbenchDesignSettingsError,
  $workbenchDesignSettingsLoading,
  setWorkbenchDesignSettings,
  setWorkbenchDesignSettingsError,
  setWorkbenchDesignSettingsLoading
} from './store'
import { workbenchStrings as s } from './strings'

const PRESET_OPTIONS: WorkbenchDesignSettings['designSystemPreset'][] = [
  'none',
  'shadcn',
  'radix',
  'material',
  'ios',
  'fluent',
  'ant',
  'chakra',
  'carbon',
  'polaris',
  'bootstrap',
  'geist',
  'brutalism',
  'editorial'
]

const VIEWPORT_OPTIONS: WorkbenchDesignSettings['defaultViewport'][] = ['mobile', 'tablet', 'desktop']

const RADIUS_OPTIONS: NonNullable<WorkbenchDesignSettings['radius']>[] = ['sharp', 'soft', 'rounded', 'pill']

const DENSITY_OPTIONS: NonNullable<WorkbenchDesignSettings['density']>[] = ['compact', 'cozy', 'spacious']

const FONT_STYLE_OPTIONS: NonNullable<WorkbenchDesignSettings['fontStyle']>[] = [
  'system',
  'geometric',
  'humanist',
  'serif',
  'mono'
]

// Sentinel for the "clear this optional enum field" option in a native
// <select> — WorkbenchDesignSettings' radius/density/fontStyle are optional,
// and a <select> can't natively carry `undefined` as a value.
const UNSET = '__unset__'

function toneToText(tone: string[]): string {
  return tone.join(', ')
}

function textToTone(text: string): string[] {
  return text
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
}

interface DesignSettingsPanelProps {
  workspaceRoot: string
}

export function DesignSettingsPanel({ workspaceRoot }: DesignSettingsPanelProps) {
  const savedSettings = useStore($workbenchDesignSettings)
  const loading = useStore($workbenchDesignSettingsLoading)
  const loadError = useStore($workbenchDesignSettingsError)

  const [draft, setDraft] = useState<WorkbenchDesignSettings | null>(null)
  const [toneText, setToneText] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setWorkbenchDesignSettingsLoading(true)
    setWorkbenchDesignSettingsError(null)

    try {
      const res = await readDesignSettings(workspaceRoot)

      if (res.ok) {
        setWorkbenchDesignSettings(res.value)
        setDraft(res.value)
        setToneText(toneToText(res.value.tone))
      } else {
        setWorkbenchDesignSettingsError(res.message)
        notify({ kind: 'error', title: s.design.loadFailed, message: res.message })
      }
    } catch (err) {
      notifyError(err, s.design.loadFailed)
    } finally {
      setWorkbenchDesignSettingsLoading(false)
    }
  }, [workspaceRoot])

  // Design settings are workspace-wide (one document per workspace, see
  // store.ts), so a fresh load only needs to happen per workspace root.
  useEffect(() => {
    void load()
  }, [load])

  const handleSave = useCallback(async () => {
    if (!draft) {
      return
    }

    const next: WorkbenchDesignSettings = { ...draft, tone: textToTone(toneText) }

    setSaving(true)

    try {
      const res = await writeDesignSettings(workspaceRoot, next)

      if (res.ok) {
        setWorkbenchDesignSettings(res.value)
        setDraft(res.value)
        setToneText(toneToText(res.value.tone))
        notify({ kind: 'success', title: s.design.saved, message: '' })
      } else {
        notify({ kind: 'error', title: s.design.saveFailed, message: res.message })
      }
    } catch (err) {
      notifyError(err, s.design.saveFailed)
    } finally {
      setSaving(false)
    }
  }, [draft, toneText, workspaceRoot])

  const dirty =
    draft !== null &&
    savedSettings !== null &&
    JSON.stringify({ ...draft, tone: textToTone(toneText) }) !== JSON.stringify(savedSettings)

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-foreground">{s.design.heading}</h2>
        {draft && (
          <Button disabled={saving || !dirty} onClick={() => void handleSave()} size="sm">
            <Codicon name={saving ? 'loading' : 'save'} size="0.8125rem" spinning={saving} />
            {saving ? s.saving : s.save}
          </Button>
        )}
      </div>

      <div className="max-h-72 min-h-0 overflow-y-auto pr-1">
        {loading && !draft ? (
          <PageLoader label={s.design.loading} />
        ) : loadError && !draft ? (
          <PanelEmpty description={loadError} icon="error" title={s.design.loadFailed} />
        ) : !draft ? (
          <PanelEmpty description={s.design.emptyDesc} icon="note" title={s.design.heading} />
        ) : (
          <DesignSettingsForm draft={draft} onChange={setDraft} onToneChange={setToneText} toneText={toneText} />
        )}
      </div>
    </div>
  )
}

function DesignSettingsForm({
  draft,
  onChange,
  onToneChange,
  toneText
}: {
  draft: WorkbenchDesignSettings
  onChange: (next: WorkbenchDesignSettings) => void
  onToneChange: (value: string) => void
  toneText: string
}) {
  return (
    <div className="flex flex-col gap-3 pb-1">
      <label className="flex items-center gap-2 text-xs font-medium text-foreground">
        <Switch
          aria-label={s.design.enabledLabel}
          checked={draft.enabled}
          onCheckedChange={checked => onChange({ ...draft, enabled: checked })}
          size="xs"
        />
        {s.design.enabledLabel}
      </label>

      <label className="grid gap-1 text-xs font-medium text-foreground">
        {s.design.presetLabel}
        <select
          className="w-full rounded-md border border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) px-2 py-1 text-xs text-foreground"
          onChange={event =>
            onChange({
              ...draft,
              designSystemPreset: event.target.value as WorkbenchDesignSettings['designSystemPreset']
            })
          }
          value={draft.designSystemPreset}
        >
          {PRESET_OPTIONS.map(preset => (
            <option key={preset} value={preset}>
              {s.design.presetNames[preset] ?? preset}
            </option>
          ))}
        </select>
      </label>

      <label className="grid gap-1 text-xs font-medium text-foreground">
        {s.design.brandColorLabel}
        <Input
          maxLength={64}
          onChange={event => onChange({ ...draft, brandColor: event.target.value || undefined })}
          placeholder={s.design.brandColorPlaceholder}
          value={draft.brandColor ?? ''}
        />
      </label>

      <label className="grid gap-1 text-xs font-medium text-foreground">
        {s.design.toneLabel}
        <Input
          onChange={event => onToneChange(event.target.value)}
          placeholder={s.design.tonePlaceholder}
          value={toneText}
        />
      </label>

      <label className="grid gap-1 text-xs font-medium text-foreground">
        {s.design.densityLabel}
        <select
          className="w-full rounded-md border border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) px-2 py-1 text-xs text-foreground"
          onChange={event => {
            const value = event.target.value

            onChange({
              ...draft,
              density: value === UNSET ? undefined : (value as WorkbenchDesignSettings['density'])
            })
          }}
          value={draft.density ?? UNSET}
        >
          <option value={UNSET}>{s.design.unsetOption}</option>
          {DENSITY_OPTIONS.map(density => (
            <option key={density} value={density}>
              {s.design.densityNames[density] ?? density}
            </option>
          ))}
        </select>
      </label>

      <label className="grid gap-1 text-xs font-medium text-foreground">
        {s.design.radiusLabel}
        <select
          className="w-full rounded-md border border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) px-2 py-1 text-xs text-foreground"
          onChange={event => {
            const value = event.target.value

            onChange({
              ...draft,
              radius: value === UNSET ? undefined : (value as WorkbenchDesignSettings['radius'])
            })
          }}
          value={draft.radius ?? UNSET}
        >
          <option value={UNSET}>{s.design.unsetOption}</option>
          {RADIUS_OPTIONS.map(radius => (
            <option key={radius} value={radius}>
              {s.design.radiusNames[radius] ?? radius}
            </option>
          ))}
        </select>
      </label>

      <label className="grid gap-1 text-xs font-medium text-foreground">
        {s.design.fontStyleLabel}
        <select
          className="w-full rounded-md border border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) px-2 py-1 text-xs text-foreground"
          onChange={event => {
            const value = event.target.value

            onChange({
              ...draft,
              fontStyle: value === UNSET ? undefined : (value as WorkbenchDesignSettings['fontStyle'])
            })
          }}
          value={draft.fontStyle ?? UNSET}
        >
          <option value={UNSET}>{s.design.unsetOption}</option>
          {FONT_STYLE_OPTIONS.map(fontStyle => (
            <option key={fontStyle} value={fontStyle}>
              {s.design.fontStyleNames[fontStyle] ?? fontStyle}
            </option>
          ))}
        </select>
      </label>

      <label className="grid gap-1 text-xs font-medium text-foreground">
        {s.design.viewportLabel}
        <select
          className="w-full rounded-md border border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) px-2 py-1 text-xs text-foreground"
          onChange={event =>
            onChange({ ...draft, defaultViewport: event.target.value as WorkbenchDesignSettings['defaultViewport'] })
          }
          value={draft.defaultViewport}
        >
          {VIEWPORT_OPTIONS.map(viewport => (
            <option key={viewport} value={viewport}>
              {s.design.viewportNames[viewport] ?? viewport}
            </option>
          ))}
        </select>
      </label>

      <label className="grid gap-1 text-xs font-medium text-foreground">
        {s.design.stackHintLabel}
        <Input
          maxLength={200}
          onChange={event => onChange({ ...draft, stackHint: event.target.value || undefined })}
          placeholder={s.design.stackHintPlaceholder}
          value={draft.stackHint ?? ''}
        />
      </label>

      <label className="flex items-center gap-2 text-xs font-medium text-foreground">
        <Switch
          aria-label={s.design.sandboxLabel}
          checked={draft.sandboxHtmlPreview}
          onCheckedChange={checked => onChange({ ...draft, sandboxHtmlPreview: checked })}
          size="xs"
        />
        {s.design.sandboxLabel}
      </label>
    </div>
  )
}
