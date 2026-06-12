/**
 * Local, English-only strings for the Plugins feature.
 *
 * Per the desktop port convention these live beside the feature instead of in
 * the shared i18n locale files (touching those serially conflicts with parallel
 * ports). The wiring step can fold these into `useI18n()` later; the keys here
 * are the canonical source for that migration.
 */

/** Built-in memory provider sentinel. The backend uses an empty string for the
 *  default provider; never bind a Select option to `""` (an empty value renders
 *  an empty label), so map it to this sentinel in the UI and back to `""` on
 *  save. */
export const MEMORY_PROVIDER_BUILTIN = '__hermes_memory_builtin__'

/** Default context engine value the backend recognises. */
export const CONTEXT_ENGINE_DEFAULT = 'compressor'

export const pluginsStrings = {
  title: 'Plugins',
  loading: 'Loading plugins',
  loadFailed: 'Failed to load plugins',
  refresh: 'Rescan plugins',
  refreshing: 'Rescanning',
  search: 'Search plugins',
  noMatches: 'No matching plugins',

  rescanDone: (n: number) => `Rescanned plugins (${n} found)`,
  rescanFailed: 'Failed to rescan plugins',

  // Providers section
  providersHeading: 'Providers',
  providersHint: 'Choose which installed plugins back memory and context.',
  memoryProviderLabel: 'Memory provider',
  contextEngineLabel: 'Context engine',
  providerDefault: 'default',
  save: 'Save',
  saving: 'Saving',
  savedProviders: 'Provider selection saved',
  saveProvidersFailed: 'Failed to save providers',

  // Install section
  installHeading: 'Install a plugin',
  installHint: 'Install from owner/repo, owner/repo/subdir, or a full URL.',
  identifierLabel: 'Plugin identifier',
  identifierPlaceholder: 'owner/repo, owner/repo/subdir, or https://...',
  forceReinstall: 'Force reinstall',
  enableAfterInstall: 'Enable after install',
  install: 'Install',
  installing: 'Installing',
  installHintRequired: 'Enter a plugin identifier first',
  installed: (label: string) => `"${label}" installed`,
  installFailed: 'Install failed',
  missingEnvWarn: 'Missing environment variables:',

  // Plugin list
  pluginListHeading: 'Installed plugins',
  emptyTitle: 'No plugins installed',
  emptyDesc: 'Install a plugin above to extend your agent.',

  sourceLabel: 'source',
  authRequired: 'Auth required',
  authRequiredHint: 'Run this to authenticate:',
  dashboardSlots: 'Dashboard slots',
  noDashboardTab: 'No dashboard tab',

  enableRuntime: 'Enable',
  disableRuntime: 'Disable',
  enabledRuntime: (label: string) => `"${label}" enabled`,
  disabledRuntime: (label: string) => `"${label}" disabled`,
  updateGit: 'Update',
  updated: (label: string) => `"${label}" updated`,
  updateUnchanged: (label: string) => `"${label}" already up to date`,
  showInSidebar: 'Show in sidebar',
  hideFromSidebar: 'Hide from sidebar',
  remove: 'Remove',
  removeTitle: 'Remove plugin',
  removeDesc: (label: string) => `"${label}" will be removed from your agent. This cannot be undone.`,
  removeConfirm: 'Remove',
  removing: 'Removing',
  removed: (label: string) => `"${label}" removed`,
  actionFailed: 'Action failed',

  // Orphan dashboard plugins
  orphanHeading: 'Dashboard-only plugins',
  orphanHint: 'Dashboard plugins without a matching agent plugin.',

  cancel: 'Cancel'
} as const
