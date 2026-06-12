/**
 * Local, English-only strings for the Channels feature.
 *
 * Per the desktop port convention these live beside the feature instead of in
 * the shared i18n locale files (touching those serially conflicts with parallel
 * ports). The wiring step can fold these into `useI18n()` later; the keys here
 * are the canonical source for that migration.
 */
export const channelsStrings = {
  title: 'Channels',
  loading: 'Loading channels',
  loadFailed: 'Failed to load channels',
  refresh: 'Refresh',
  refreshing: 'Refreshing',
  search: 'Search channels',

  // Page intro / status
  summary: (configured: number, total: number) =>
    `${configured} of ${total} channels configured.`,
  credentialsNote:
    'Credentials are written to ~/.hermes/.env; the gateway connects each enabled channel on its next restart.',
  gatewayStoppedTitle: 'Gateway is not running',
  gatewayStoppedDesc:
    'Configure channels here, then start the gateway with `hermes gateway start` or the Restart gateway action.',
  restartBannerTitle: 'Changes saved',
  restartBannerDesc: 'Restart the gateway for the changes to take effect.',

  restartGateway: 'Restart gateway',
  restarting: 'Restarting',
  restartNow: 'Restart now',
  restartStarted: 'Gateway restarting',
  restartFailed: 'Failed to restart gateway',
  restartFailedExit: (code: number) => `Gateway restart failed (exit ${code}) — restart manually`,

  // Per-channel actions
  configure: 'Configure',
  test: 'Test',
  testing: 'Testing',
  enableAria: (name: string) => `Enable ${name}`,
  toggleFailed: 'Failed to update channel',
  savedTitle: (name: string) => `${name} saved`,
  saveFailed: 'Failed to save channel',

  // State badges
  states: {
    connected: 'Connected',
    pending_restart: 'Restart to apply',
    gateway_stopped: 'Gateway stopped',
    disconnected: 'Disconnected',
    not_configured: 'Not configured',
    disabled: 'Disabled',
    fatal: 'Error'
  } as Record<string, string>,

  // Empty
  empty: 'No channels available',
  noMatches: 'No matching channels',

  // Config dialog
  configureTitle: (name: string) => `Configure ${name}`,
  setupGuide: 'Setup guide',
  fieldRequiredSuffix: ' *',
  keepBlankHint: 'set — leave blank to keep',
  nothingToSave: 'Nothing to save — fill in at least one field.',
  fieldRequired: (label: string) => `${label} is required`,
  saveEnable: 'Save & enable',
  saving: 'Saving',
  cancel: 'Cancel',

  // Telegram pairing
  telegramHeading: 'Telegram pairing',
  telegramConfigured: 'Existing Telegram credentials are configured.',
  telegramStart: 'Start pairing',
  telegramStarting: 'Starting',
  telegramOpenApp: 'Open in Telegram',
  telegramPayloadLabel: 'Pairing payload',
  telegramCopyPayload: 'Copy payload',
  telegramCopied: 'Pairing payload copied',
  telegramExpiresIn: (clock: string) => `Expires in ${clock}`,
  telegramExpired: 'expired',
  telegramWaiting: 'Waiting for Telegram',
  telegramReady: 'Ready',
  telegramOwnerDetected: 'owner detected',
  telegramAllowedHeading: 'Allowed users',
  telegramAllowedHint: 'Add at least one Telegram user ID.',
  telegramAddPlaceholder: 'Telegram user ID',
  telegramAdd: 'Add',
  telegramNumericOnly: 'Allowed Telegram user IDs must be numeric.',
  telegramAtLeastOne: 'Add at least one allowed Telegram user ID.',
  telegramSaveRestart: 'Save and restart',
  telegramSaved: 'Telegram saved; gateway restarting',
  telegramSaveFailed: 'Failed to save Telegram pairing',
  telegramExpiredReset: 'Telegram pairing expired. Start a new setup to try again.',
  removeAllowedAria: (id: string) => `Remove ${id}`
} as const
