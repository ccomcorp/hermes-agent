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
  sectionNavLabel: 'Configuration sections'
} as const
