/**
 * Local, English-only strings for the Models feature.
 *
 * DECISION (2026-06-11): kept LOCAL on purpose — do NOT fold into the shared
 * i18n locales (src/i18n/*). This is an English-only deployment, so the
 * multi-language catalog adds nothing here, and keeping this text out of the
 * shared locale files (which upstream hermes-agent edits constantly) keeps the
 * AIOS fork delta shallow and avoids merge conflicts when pulling upstream
 * updates. Only fold into useI18n() if real multi-language support is needed.
 */
export const modelsStrings = {
  title: 'Models',
  // Header subtitle for the full-width pane.
  subtitle: 'Choose the main model and per-task auxiliary assignments.',
  // Section heading above the reused model-assignment surface.
  assignmentsHeading: 'Model assignments'
} as const
