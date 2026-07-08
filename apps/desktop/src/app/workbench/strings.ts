/**
 * Local, English-only strings for the Workbench feature.
 *
 * DECISION: kept LOCAL on purpose, matching `../channels/strings.ts` and
 * `../files/strings.ts` (2026-06-11) — this is an English-only deployment, so
 * the shared i18n catalog (src/i18n/*) adds nothing here, and keeping this text
 * out of the shared locale files (which upstream hermes-agent edits constantly)
 * keeps the AIOS fork delta shallow and avoids merge conflicts on upstream
 * updates. Only fold into useI18n() if real multi-language support is needed.
 *
 * Naming: "Requirement Unit" / "Workbench" only — no other project's names in
 * any user-facing string (security/constraints doc §"Naming & constraints").
 */
export const workbenchStrings = {
  title: 'Workbench',
  navLabel: 'Workbench',

  // Workspace-root gate (fail closed — see 03-security-and-constraints.md §4/§8).
  selectWorkspaceTitle: 'Select a workspace',
  selectWorkspaceDesc:
    'Requirement Units are written under .hermes/workbench inside a workspace folder. Choose one to get started.',
  selectWorkspace: 'Select workspace',
  changeWorkspace: 'Change',

  // List.
  loading: 'Loading requirements',
  loadFailed: 'Failed to load requirements',
  refresh: 'Refresh',
  refreshing: 'Refreshing',
  newRequirement: 'New requirement',
  emptyTitle: 'No requirements yet',
  emptyDesc: 'Create the first Requirement Unit for this workspace.',
  selectPrompt: 'Select a requirement to view it, or create a new one.',
  openFailed: 'Failed to open requirement',

  // Create dialog.
  createTitle: 'New requirement',
  createDialogDesc:
    'Requirement Units capture what needs to be built, in Markdown. They link to Plans and ChangeSets as work progresses.',
  titleLabel: 'Title',
  titlePlaceholder: 'Requirement title',
  markdownLabel: 'Description (Markdown)',
  markdownPlaceholder: '# Describe the requirement…',
  create: 'Create',
  creating: 'Creating',
  cancel: 'Cancel',
  createFailed: 'Failed to create requirement',
  createdTitle: (title: string) => `"${title}" created`,

  // Detail / editor.
  editTitleLabel: 'Title',
  editMarkdownLabel: 'Requirement (Markdown)',
  statusLabel: 'Status',
  save: 'Save',
  saving: 'Saving',
  saved: 'Requirement saved',
  saveFailed: 'Failed to save requirement',
  unsavedHint: 'Unsaved changes',

  statusNames: {
    draft: 'Draft',
    clarified: 'Clarified',
    planned: 'Planned',
    in_progress: 'In progress',
    implemented: 'Implemented',
    reviewed: 'Reviewed',
    verified: 'Verified',
    archived: 'Archived'
  } as Record<string, string>,

  // Right rail (Plans/ChangeSets land in a later slice).
  traceHeading: 'Trace & linked artifacts',
  traceStub: 'Plans, ChangeSets, and other linked artifacts arrive in a later slice.',
  traceHistoryHeading: 'History',
  traceEmpty: 'No trace history yet.',

  // Status bar (each item labeled and shown separately — profiles are not a
  // filesystem sandbox, so this never conflates profile with workspace root).
  statusBar: {
    workspaceRoot: 'Workspace',
    terminalCwd: 'Terminal cwd',
    profile: 'Profile',
    backendLocal: 'Local backend',
    backendRemoteUnsupported: 'Remote — not supported yet'
  },

  updatedAt: (iso: string) => new Date(iso).toLocaleString()
} as const
