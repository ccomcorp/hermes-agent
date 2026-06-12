/**
 * Local, English-only strings for the Logs feature.
 *
 * DECISION (2026-06-11): kept LOCAL on purpose — do NOT fold into the shared
 * i18n locales (src/i18n/*). This is an English-only deployment, so the
 * multi-language catalog adds nothing here, and keeping this text out of the
 * shared locale files (which upstream hermes-agent edits constantly) keeps the
 * AIOS fork delta shallow and avoids merge conflicts when pulling upstream
 * updates. Only fold into useI18n() if real multi-language support is needed.
 */

export const logsStrings = {
  title: 'Logs',
  loading: 'Loading logs',
  loadFailed: 'Failed to load logs',

  refresh: 'Refresh',
  refreshing: 'Refreshing',

  // Toolbar filter group labels.
  fileLabel: 'File',
  levelLabel: 'Level',
  componentLabel: 'Component',
  linesLabel: 'Lines',

  // Auto-refresh toggle.
  autoRefresh: 'Auto-refresh',
  live: 'Live',

  // Log surface.
  fileHeading: (file: string) => `${file}.log`,
  noLogLines: 'No log lines'
} as const
