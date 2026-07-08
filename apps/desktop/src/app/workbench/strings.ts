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

  // Right rail — Workbench Plans linked to the open requirement (Slice C).
  // ChangeSets/Design/Write/Workflow artifacts remain later slices.
  plans: {
    heading: 'Plans',
    selectRequirementTitle: 'No requirement open',
    selectRequirementDesc: 'Open a requirement to see and create its Plans.',
    selectPlanPrompt: 'Select a plan to view it, or create a new one.',

    loading: 'Loading plans',
    loadFailed: 'Failed to load plans',
    openFailed: 'Failed to open plan',
    newPlan: 'New plan',
    emptyTitle: 'No plans yet',
    emptyDesc: 'Create the first Workbench Plan for this requirement.',

    createTitle: 'New plan',
    createDialogDesc:
      'Workbench Plans capture how a requirement will be approached, in Markdown. Creating a plan writes a file only — it never runs or implements anything.',
    titleLabel: 'Title (optional)',
    titlePlaceholder: 'Plan title',
    markdownLabel: 'Plan (Markdown)',
    markdownPlaceholder: '# Describe the approach…',
    defaultMarkdown: '# Plan\n\n> Describe the approach here.\n',
    create: 'Create',
    creating: 'Creating',
    createFailed: 'Failed to create plan',
    createdTitle: (title: string) => `"${title}" created`,

    refine: 'Refine',
    refining: 'Refining',
    refineTitle: 'Refine plan',
    refineDialogDesc:
      'Refine writes a NEW version linked to this one — the current version is kept, never overwritten.',
    refineFailed: 'Failed to refine plan',
    refined: (version: number) => `Refined to v${version}`,

    revealFile: 'Reveal file',
    versionBadge: (version: number) => `v${version}`,
    supersedes: (priorId: string) => `Supersedes ${priorId}`,
    historyHeading: 'Version history'
  },

  // ChangeSet review (Slice D) — status-only: accept/reject just transition
  // the changeset's own status file. No file-apply/git action lives behind
  // any of this copy (that is Slice E, not built here).
  changesets: {
    heading: 'ChangeSets',
    loading: 'Loading changesets',
    loadFailed: 'Failed to load changesets',
    openFailed: 'Failed to open changeset',
    emptyTitle: 'No changesets yet',
    emptyDesc: 'ChangeSets created by other Workbench flows will appear here for review.',
    selectPrompt: 'Select a changeset to review it.',

    filesHeading: 'Files',
    noFiles: 'This changeset has no files.',

    accept: 'Accept',
    accepting: 'Accepting',
    reject: 'Reject',
    rejecting: 'Rejecting',
    acceptFailed: 'Failed to accept changeset',
    rejectFailed: 'Failed to reject changeset',
    accepted: 'Changeset accepted',
    rejected: 'Changeset rejected',

    reviewNote:
      'Accept or reject only changes this ChangeSet status here — it never writes to your project files and never runs git.',

    statusNames: {
      pending: 'Pending',
      partially_accepted: 'Partially accepted',
      accepted: 'Accepted',
      rejected: 'Rejected',
      applied: 'Applied',
      archived: 'Archived'
    } as Record<string, string>
  },

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
