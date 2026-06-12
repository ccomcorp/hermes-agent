// Local English strings for the Webhooks feature. Per the desktop port rules we
// keep these in-feature (not in the shared i18n locales) so parallel ports don't
// collide on locale files. The wiring step can lift these into i18n later.
export const WEBHOOKS_STRINGS = {
  title: 'Webhooks',
  search: 'Search subscriptions',
  newSubscription: 'New subscription',
  loading: 'Loading webhooks',
  loadFailed: 'Failed to load webhooks',
  // Platform-disabled banner
  disabledTitle: 'Webhook platform disabled',
  disabledBody:
    'The webhook platform must be enabled on the Channels page before you can create subscriptions. Enable it there, then return to this page.',
  // List
  subscriptionsHeading: 'Subscriptions',
  hotReloadHint: 'Disabled webhooks reject incoming events; the gateway hot-reloads changes (no restart needed).',
  emptyTitle: 'No subscriptions yet',
  emptyDesc: 'Create a subscription to receive incoming webhook events.',
  emptySearchTitle: 'No matches',
  emptySearchDesc: 'No subscriptions match your search.',
  allEvents: 'all events',
  deliverOnly: 'deliver only',
  disabledBadge: 'disabled',
  enable: 'Enable',
  disable: 'Disable',
  delete: 'Delete',
  copyUrl: 'Copy URL',
  copied: 'Copied',
  // Toggle / delete notifications
  enabledToast: 'Enabled subscription',
  disabledToast: 'Disabled subscription',
  toggleFailed: 'Failed to update subscription',
  deleted: 'Deleted subscription',
  deleteFailed: 'Failed to delete subscription',
  // Delete dialog
  deleteTitle: 'Delete webhook',
  deleteDescPrefix: 'This permanently removes the subscription ',
  deleteDescSuffix: '.',
  cancel: 'Cancel',
  deleting: 'Deleting…',
  // Create dialog
  createTitle: 'New subscription',
  createDesc: 'Receive an event from an external service and route it to the agent.',
  nameLabel: 'Name',
  namePlaceholder: 'e.g. github-push',
  descriptionLabel: 'Description',
  descriptionLabelOptional: 'optional',
  descriptionPlaceholder: 'What this webhook does',
  eventsLabel: 'Events',
  eventsLabelOptional: 'optional',
  eventsPlaceholder: 'comma-separated, leave empty for all',
  deliverLabel: 'Deliver to',
  deliverOnlyLabel: 'Deliver only',
  deliverOnlyHint: 'Skip the agent, deliver the payload directly',
  promptLabel: 'Prompt',
  promptLabelOptional: 'optional',
  promptPlaceholder: 'Instructions for the agent when this webhook fires',
  create: 'Create',
  creating: 'Creating…',
  nameRequired: 'Name is required',
  createFailed: 'Failed to create subscription',
  // Created (secret reveal) step
  createdTitle: 'Subscription created',
  createdDesc: 'Copy the secret now — it is only shown once.',
  webhookUrlLabel: 'Webhook URL',
  secretLabel: 'Secret (shown once)',
  copySecret: 'Copy secret',
  done: 'Done'
} as const

export const DELIVERY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'log', label: 'Log' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'discord', label: 'Discord' },
  { value: 'slack', label: 'Slack' },
  { value: 'email', label: 'Email' },
  { value: 'github_comment', label: 'GitHub comment' }
]
