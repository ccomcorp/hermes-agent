/**
 * Local, English-only strings for the Pairing feature.
 *
 * Per the desktop port convention these live beside the feature instead of in
 * the shared i18n locale files (touching those serially conflicts with parallel
 * ports). The wiring step can fold these into `useI18n()` later; the keys here
 * are the canonical source for that migration.
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
