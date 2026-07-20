import { useCallback } from 'react'

import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import type { HermesConfigRecord } from '@/types/hermes'

import { getNested, setNested } from './helpers'

const MODE_OPTIONS = ['off', 'log', 'nudge'] as const
const MIN_LEVEL_OPTIONS = ['moderate', 'complex', 'expert'] as const

interface Props {
  config: HermesConfigRecord
  onConfigChange: (next: HermesConfigRecord) => void
}

export function RouteAdvisorControls({ config, onConfigChange }: Props) {
  const { t } = useI18n()
  const d = t.settings.delegation

  const mode = String(getNested(config, 'route_advisor.mode') ?? 'off')
  const minLevel = String(getNested(config, 'route_advisor.min_level') ?? 'complex')
  const cooldownTurns = Number(getNested(config, 'route_advisor.cooldown_turns') ?? 5)

  const modeLabels: Record<string, string> = {
    off: d.advisorModeOff,
    log: d.advisorModeLog,
    nudge: d.advisorModeNudge
  }

  const minLevelLabels: Record<string, string> = {
    moderate: d.advisorMinLevelModerate,
    complex: d.advisorMinLevelComplex,
    expert: d.advisorMinLevelExpert
  }

  const handleModeChange = useCallback(
    (next: string) => {
      onConfigChange(setNested(config, 'route_advisor.mode', next))
    },
    [config, onConfigChange]
  )

  const handleMinLevelChange = useCallback(
    (next: string) => {
      onConfigChange(setNested(config, 'route_advisor.min_level', next))
    },
    [config, onConfigChange]
  )

  const handleCooldownChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const parsed = parseInt(e.target.value, 10)
      if (!isNaN(parsed) && parsed >= 1) {
        onConfigChange(setNested(config, 'route_advisor.cooldown_turns', parsed))
      }
    },
    [config, onConfigChange]
  )

  return (
    <div className="rounded-lg border p-4 space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">{d.advisorTitle}</h3>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-prose">{d.advisorDesc}</p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">{d.advisorMode}</label>
          <Select onValueChange={handleModeChange} value={mode}>
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODE_OPTIONS.map(opt => (
                <SelectItem key={opt} value={opt}>
                  {modeLabels[opt]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">{d.advisorMinLevel}</label>
          <Select onValueChange={handleMinLevelChange} value={minLevel}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MIN_LEVEL_OPTIONS.map(opt => (
                <SelectItem key={opt} value={opt}>
                  {minLevelLabels[opt]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">{d.advisorCooldown}</label>
          <Input
            className="w-20 text-center"
            max={60}
            min={1}
            onChange={handleCooldownChange}
            type="number"
            value={cooldownTurns}
          />
        </div>
      </div>
    </div>
  )
}
