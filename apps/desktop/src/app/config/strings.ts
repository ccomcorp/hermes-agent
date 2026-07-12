/**
 * Local, English-only strings for the Config feature.
 *
 * DECISION (2026-06-11): kept LOCAL on purpose — do NOT fold into the shared
 * i18n locales (src/i18n/*). This is an English-only deployment, so the
 * multi-language catalog adds nothing here, and keeping this text out of the
 * shared locale files (which upstream hermes-agent edits constantly) keeps the
 * AIOS fork delta shallow and avoids merge conflicts when pulling upstream
 * updates. Only fold into useI18n() if real multi-language support is needed.
 */

export const configStrings = {
  title: 'Config',
  subtitle: 'Agent configuration',
  // Section tab nav lives in this pane; the section bodies are rendered by the
  // existing settings ConfigSettings component (reused, not recreated).
  sectionNavLabel: 'Configuration sections',
  // Absolute config.yaml path (from GET /api/config/raw) — web dashboard parity.
  configFileLabel: 'config.yaml',
  configFileLoading: 'Resolving config path…',
  configFileUnavailable: 'Config path unavailable',
  copyPath: 'Copy path',
  pathCopied: 'Path copied',
  // Toolbar — web Config page + Settings overlay parity.
  exportConfig: 'Export config',
  importConfig: 'Import config',
  resetToDefaults: 'Reset to defaults',
  revealInFolder: 'Show in folder',
  exportFailed: 'Export failed',
  exportDone: 'Config exported',
  importFailed: 'Import failed',
  resetConfirm:
    'Reset all configuration to Hermes defaults? This overwrites your current config.yaml after save.',
  resetFailed: 'Reset failed',
  resetDone: 'Config reset to defaults',
  revealFailed: 'Could not open the config folder',
  pathHint:
    'Path is fixed per profile (HERMES_HOME). Switch profile to use a different config.yaml; use Show in folder to open it.'
} as const
