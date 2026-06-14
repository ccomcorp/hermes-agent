/**
 * Local, English-only strings for the Pairing feature.
 *
 * DECISION (2026-06-11): kept LOCAL on purpose — do NOT fold into the shared
 * i18n locales (src/i18n/*). This is an English-only deployment, so the
 * multi-language catalog adds nothing here, and keeping this text out of the
 * shared locale files (which upstream hermes-agent edits constantly) keeps the
 * AIOS fork delta shallow and avoids merge conflicts when pulling upstream
 * updates. Only fold into useI18n() if real multi-language support is needed.
 */
export const pairingStrings = {
  title: 'Pairing',
  loading: 'Loading pairing requests',
  loadFailed: 'Failed to load pairing requests',
  refresh: 'Refresh',
  refreshing: 'Refreshing',
  search: 'Search pairing requests',

  clearPending: 'Clear pending',
  clearPendingTitle: 'Clear pending requests',
  clearPendingDesc: 'All pending pairing requests will be discarded. This cannot be undone.',
  clearPendingConfirm: 'Clear pending',
  clearing: 'Clearing',
  clearedTitle: 'Pending cleared',
  clearedMessage: (n: number) => `Discarded ${n} pending request${n === 1 ? '' : 's'}`,

  pendingHeading: 'Pending requests',
  approvedHeading: 'Approved users',
  noPending: 'No pending pairing requests',
  noApproved: 'No approved users',
  noMatches: 'No matching requests',

  approve: 'Approve',
  approving: 'Approving',
  approvedTitle: 'Pairing approved',
  approvedMessage: (label: string) => `"${label}" can now message Hermes`,
  approveFailed: 'Failed to approve request',
  missingCode: 'Missing pairing code',

  revoke: 'Revoke',
  revokeTitle: 'Revoke access',
  revokeDesc: (label: string) => `"${label}" will lose access. This cannot be undone.`,
  revokeConfirm: 'Revoke',
  revoking: 'Revoking',
  revokedTitle: 'Access revoked',
  revokedMessage: (label: string) => `"${label}" can no longer message Hermes`,
  revokeFailed: 'Failed to revoke access',

  cancel: 'Cancel',
  ageAgo: (minutes: number) => `${minutes}m ago`
} as const
