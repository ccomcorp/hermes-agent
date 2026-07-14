import type { Dispatch, SetStateAction } from 'react'

import type { HermesGateway } from '@/hermes'
import type { IconComponent } from '@/lib/icons'
import type { EnvVarInfo } from '@/types/hermes'

export type SettingsView =
  | 'about'
  | 'gateway'
  | 'keys'
  | 'notifications'
  | 'providers'
  | 'sessions'
  | `config:${string}`
export type EnvPatch = Partial<Pick<EnvVarInfo, 'is_set' | 'redacted_value'>>

export interface SettingsPageProps {
  gateway?: HermesGateway | null
  onClose: () => void
  onConfigSaved?: () => void
  onMainModelChanged?: (provider: string, model: string) => void
}

export interface ProviderGroup {
  name: string
  priority: number
  entries: [string, EnvVarInfo][]
  hasAnySet: boolean
}

export interface DesktopConfigSection {
  id: string
  label: string
  icon: IconComponent
  /**
   * Explicit schema field keys to show. When empty and `schemaCategory` is set,
   * all fields whose schema.category matches are shown (web-dashboard parity).
   */
  keys: string[]
  /**
   * Upstream CONFIG_SCHEMA category id (hermes_cli/web_server.py _CATEGORY_ORDER).
   * When set, ConfigSettings includes every schema field in that category — so
   * new DEFAULT_CONFIG keys appear without a desktop SECTIONS edit.
   */
  schemaCategory?: string
}

export interface EnvRowProps {
  varKey: string
  info: EnvVarInfo
  edits: Record<string, string>
  revealed: Record<string, string>
  saving: string | null
  setEdits: Dispatch<SetStateAction<Record<string, string>>>
  onSave: (key: string) => void
  onClear: (key: string) => void
  onReveal: (key: string) => void
  compact?: boolean
}
