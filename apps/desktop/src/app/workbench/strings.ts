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

  // Design Studio settings (Slice F — settings only; see go-forward plan §5
  // Slice F/G/H/I split). This is a plain form over one settings document per
  // workspace — no design-brief/prototype generation, no preview, and no
  // ChangeSet-apply copy belongs here.
  design: {
    heading: 'Design settings',
    loading: 'Loading design settings',
    loadFailed: 'Failed to load design settings',
    saveFailed: 'Failed to save design settings',
    saved: 'Design settings saved',
    emptyDesc: 'Design settings for this workspace will appear here once loaded.',

    enabledLabel: 'Design Studio enabled',
    presetLabel: 'Design system preset',
    brandColorLabel: 'Brand color',
    brandColorPlaceholder: '#3366ff',
    toneLabel: 'Tone (comma-separated)',
    tonePlaceholder: 'confident, minimal, playful',
    densityLabel: 'Layout density',
    radiusLabel: 'Corner radius',
    fontStyleLabel: 'Typography style',
    viewportLabel: 'Target viewport',
    stackHintLabel: 'Framework / stack hint',
    stackHintPlaceholder: 'react + tailwind',
    sandboxLabel: 'Sandbox HTML preview',
    unsetOption: 'Unset',

    presetNames: {
      none: 'None',
      shadcn: 'shadcn/ui',
      radix: 'Radix',
      material: 'Material',
      ios: 'iOS',
      fluent: 'Fluent',
      ant: 'Ant Design',
      chakra: 'Chakra UI',
      carbon: 'Carbon',
      polaris: 'Polaris',
      bootstrap: 'Bootstrap',
      geist: 'Geist',
      brutalism: 'Brutalism',
      editorial: 'Editorial'
    } as Record<string, string>,

    densityNames: {
      compact: 'Compact',
      cozy: 'Cozy',
      spacious: 'Spacious'
    } as Record<string, string>,

    radiusNames: {
      sharp: 'Sharp',
      soft: 'Soft',
      rounded: 'Rounded',
      pill: 'Pill'
    } as Record<string, string>,

    fontStyleNames: {
      system: 'System',
      geometric: 'Geometric',
      humanist: 'Humanist',
      serif: 'Serif',
      mono: 'Mono'
    } as Record<string, string>,

    viewportNames: {
      mobile: 'Mobile',
      tablet: 'Tablet',
      desktop: 'Desktop'
    } as Record<string, string>
  },

  // Write Workspace (Slice J — backend CRUD + editor only; see go-forward
  // plan §5 Slice J/K/L split). No quick-actions/inline-edit/retrieval/export
  // copy belongs here — that is Slice K/L.
  write: {
    heading: 'Write Workspace',
    navLabel: 'Write',

    loading: 'Loading write projects',
    loadFailed: 'Failed to load write projects',
    openFailed: 'Failed to open write project',
    newProject: 'New write project',
    emptyTitle: 'No write projects yet',
    emptyDesc: 'Create the first Write Workspace document for this workspace.',
    selectPrompt: 'Select a write project to view it, or create a new one.',

    createTitle: 'New write project',
    createDialogDesc: 'Write projects hold long-form Markdown documents. Creating one writes a file only.',
    titleLabel: 'Title',
    titlePlaceholder: 'Document title',
    markdownLabel: 'Content (Markdown)',
    markdownPlaceholder: '# Start writing…',
    create: 'Create',
    creating: 'Creating',
    createFailed: 'Failed to create write project',
    createdTitle: (title: string) => `"${title}" created`,

    editTitleLabel: 'Title',
    save: 'Save',
    saving: 'Saving',
    saved: 'Write project saved',
    saveFailed: 'Failed to save write project',
    unsavedHint: 'Unsaved changes',

    // Split-mode toggle — a plain three-way view switch, not a rich editor.
    viewSource: 'Source',
    viewPreview: 'Preview',
    viewSplit: 'Split',

    recentEditsHeading: 'Recent edits',
    recentEditsEmpty: 'No saves yet.',
    recentEditAgo: (ageMs: number) => {
      const minutes = Math.floor(ageMs / 60_000)

      if (minutes < 1) {
        return 'Just now'
      }

      if (minutes < 60) {
        return `${minutes}m ago`
      }

      const hours = Math.floor(minutes / 60)

      if (hours < 24) {
        return `${hours}h ago`
      }

      return `${Math.floor(hours / 24)}d ago`
    }
  },

  // Workflow Designer (Slice M — AUTHORING ONLY; see go-forward plan §5
  // Slice M/N split). A workflow is a graph (nodes + edges) that is created,
  // saved, loaded, and edited — it is NEVER RUN. No "Run" copy, no execution
  // status copy belongs here — that is Slice N, not started. The palette only
  // ever offers 3 node kinds (Trigger/Condition/Output); the other 9 declared
  // WorkbenchWorkflowNodeKind values are intentionally not named in this
  // catalog.
  workflow: {
    heading: 'Workflows',
    navLabel: 'Workflows',

    loading: 'Loading workflows',
    loadFailed: 'Failed to load workflows',
    openFailed: 'Failed to open workflow',
    newWorkflow: 'New workflow',
    emptyTitle: 'No workflows yet',
    emptyDesc: 'Create the first Workbench Workflow for this workspace.',
    selectPrompt: 'Select a workflow to view it, or create a new one.',

    createTitle: 'New workflow',
    createDialogDesc:
      'Workbench Workflows are authored graphs of nodes and edges. Creating one writes a file only — it is never run.',
    titleLabel: 'Title',
    titlePlaceholder: 'Workflow title',
    create: 'Create',
    creating: 'Creating',
    createFailed: 'Failed to create workflow',
    createdTitle: (title: string) => `"${title}" created`,

    save: 'Save',
    saving: 'Saving',
    saved: 'Workflow saved',
    saveFailed: 'Failed to save workflow',
    unsavedHint: 'Unsaved changes',

    // Node palette — exactly 3 creatable kinds. The other 9
    // WorkbenchWorkflowNodeKind values are deliberately not offered here.
    paletteHeading: 'Add node',
    addTrigger: 'Add trigger',
    addCondition: 'Add condition',
    addOutput: 'Add output',

    nodeNames: {
      manual_trigger: 'Trigger',
      condition: 'Condition',
      output: 'Output'
    } as Record<string, string>,

    conditionExpressionLabel: 'Expression (not evaluated)',
    conditionExpressionPlaceholder: 'e.g. status == "approved"',
    outputLabelLabel: 'Label',
    outputLabelPlaceholder: 'e.g. Final result',

    deleteNode: 'Delete node',
    deleteEdge: 'Delete connection'
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
