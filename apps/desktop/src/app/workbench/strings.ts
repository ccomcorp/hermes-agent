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
    } as Record<string, string>,

    // Apply + Commit (Slice E) — a SEPARATE, additional pair of actions from
    // accept/reject above. Apply is only offered once a changeset is
    // `accepted`; it is the first Workbench action that writes to the user's
    // real project files. Commit is a further separate, explicit action,
    // never auto-triggered by Apply.
    apply: 'Apply',
    applying: 'Applying',
    applyFailed: 'Failed to apply changeset',
    applied: 'Changeset applied',
    applyNote:
      'Apply writes each file diff to your real project files. A file that changed on disk since this ChangeSet was proposed is skipped, never overwritten.',

    fileResultNames: {
      applied: 'Applied',
      conflict: 'Conflict',
      error: 'Error',
      skipped: 'Skipped'
    } as Record<string, string>,

    commit: 'Commit',
    committing: 'Committing',
    commitFailed: 'Failed to commit changeset',
    committed: 'Changeset committed',
    committedFiles: (count: number) => `Committed ${count} file${count === 1 ? '' : 's'}`,
    commitMessageLabel: 'Commit message',
    commitNotRepoHint: 'Workspace is not a git repository — commit is unavailable.'
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

  // Design Studio generation (Slice G — brief/prototype generation, tied to
  // the currently-open requirement). Generated HTML prototypes are shown as
  // read-only SOURCE TEXT only — see design-generation-panel.tsx; there is no
  // "preview"/"render" string here on purpose, that is Slice H.
  designGeneration: {
    heading: 'Generate',
    generateBrief: 'Generate brief',
    generatePrototype: 'Generate prototype',
    loading: 'Loading generated artifacts',
    listFailed: 'Failed to load generated artifacts',
    readFailed: 'Failed to open artifact',
    emptyTitle: 'Nothing generated yet',
    emptyDesc: 'Generate a design brief or an HTML prototype for the open requirement.',
    noRequirementDesc: 'Open a requirement to generate a design brief or prototype for it.',
    emptyModelResponse: 'The model returned an empty response.',
    failed: (kind: string) => `Failed to generate ${kind === 'brief' ? 'brief' : 'prototype'}`,
    generatedTitle: (kind: string) => (kind === 'brief' ? 'Design brief generated' : 'Prototype generated'),

    kindLabels: {
      brief: 'Brief',
      design_system: 'Design system',
      prototype: 'Prototype',
      quality_report: 'Quality report'
    } as Record<string, string>,

    sourceDialogClose: 'Close',
    prototypeSourceHint: 'Raw HTML source — shown as read-only text, never rendered.',

    // "Surface the built page" (Kun-informed) — shown once a linked Kanban card
    // reports done and the orchestrator's deliverable is located in the project dir.
    builtResultHeading: 'Built result',
    builtView: 'View built page',
    builtOpenExternal: 'Open in browser',
    builtLivePreview: 'Open live preview',
    builtDialogTitle: 'Built page',
    openInCanvas: 'Open in Canvas',
    openedInCanvas: 'Opened in Canvas — develop it there with select-to-edit',
    openInCanvasFailed: 'Could not open in Canvas',

    // Design-to-code handoff (Slice I — go-forward plan §5 Slice I, the final
    // slice). Opens a fresh chat session seeded with this artifact's content
    // so the user's existing agent implements it — see design-handoff.ts and
    // design-generation-panel.tsx's handleSendToCodeAgent.
    sendToCodeAgent: 'Send to code agent',

    // "Send to Kanban" handoff — the SECOND, additive handoff option alongside
    // "Send to code agent". Creates a card on the multi-agent board assigned to
    // the dev orchestrator (see design-kanban.ts). Same brief/prototype gating.
    sendToKanban: 'Send to Kanban',
    sendingToKanban: 'Sending to Kanban',
    sentToKanban: 'Sent to Kanban — card created for the dev team',
    sendToKanbanFailed: 'Failed to send to Kanban',

    // Two-way traceability (Kanban traceability spec). Idempotency guard:
    // re-sending a design whose requirement already has a linked card prompts
    // first (a double-send spawns two orchestrator agents on the same dir).
    kanbanResendConfirm: "This design's requirement already has a Kanban card. Send another?",
    // Card-created-but-link-failed: a DISTINCT soft warning, never silent. The
    // card is NOT lost and NOT re-sent (fail-open backlink).
    sentToKanbanLinkFailed: 'Card created, but not linked back',
    sentToKanbanLinkFailedDetail: (cardId: string, reason: string) =>
      `Card ${cardId} was created on the board, but couldn't be linked back to the requirement — ${reason}`,
    // The visible "linked cards" list in the requirement's design panel — the
    // v1 consumer of the backlink (requirement → its cards).
    linkedKanbanHeading: 'Kanban cards',

    // Live linked-card status (Kanban traceability — live status). Each linked
    // card fetches its LIVE status from the kanban plugin and shows a badge;
    // the list light-polls while any card is non-terminal so it updates as the
    // orchestrator builds. Human labels for each backend status + the two
    // degrade-gracefully notes (card unreachable / gateway disconnected).
    kanbanStatusLabels: {
      triage: 'Triage',
      todo: 'To do',
      scheduled: 'Scheduled',
      ready: 'Ready',
      running: 'In progress',
      blocked: 'Blocked',
      review: 'In review',
      done: 'Done',
      archived: 'Archived'
    } as Record<string, string>,
    // A card whose status couldn't be read (transient gateway hiccup / odd
    // card shape) — never hidden, never a crash, just an honest muted note.
    kanbanStatusUnavailable: 'status unavailable',
    // No gateway connection at all — distinct from a single unreachable card.
    kanbanStatusGatewayOffline: 'gateway not connected',
    kanbanRefresh: 'Refresh',

    // Sandboxed live preview (Slice H — go-forward plan §5 Slice H). A
    // SEPARATE, additional view alongside the read-only source text above,
    // never a replacement for it. Gated on WorkbenchDesignSettings.
    // sandboxHtmlPreview being true — see design-generation-panel.tsx.
    viewSource: 'Source',
    viewPreview: 'Preview',
    previewDisabledHint: 'Turn on "Sandbox HTML preview" in Design settings to preview this prototype.',
    previewSandboxBadge: 'Sandboxed preview — this content is isolated and cannot access Hermes or your files.',
    previewIframeTitle: 'Sandboxed prototype preview'
  },

  // Write Workspace (Slice J — backend CRUD + editor; Slice K adds quick
  // actions + selection-aware inline edit below. Retrieval from workspace
  // sources is still deferred — a distinct, later slice.)
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

    // Export (Slice L) — HTML/PDF/DOCX/PNG, saved only to a path the user
    // picks via the OS save dialog. No quick-actions/inline-edit/retrieval
    // copy belongs here — that is Slice K.
    export: 'Export',
    exporting: 'Exporting',
    exportHtml: 'Export as HTML',
    exportPdf: 'Export as PDF',
    exportDocx: 'Export as Word (.docx)',
    exportPng: 'Export as PNG',
    exportFailed: 'Failed to export document',
    exported: (path: string) => `Exported to ${path}`,

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

  // Quick actions + selection-aware inline edit (Slice K, go-forward plan
  // §5). Every rewrite action proposes a ChangeSet — reviewed via the
  // existing ChangeSet Review panel (Slice D) and Apply (Slice E), never
  // written directly. Explain/Critique are informational only.
  writeQuickActions: {
    menuLabel: 'Quick actions',
    scopeSelection: 'selection',
    scopeDocument: 'document',
    disabledDirtyTitle: 'Save your changes before running a quick action',
    disabledEmptyTitle: 'Open a write project to use quick actions',
    nothingToActOn: 'Nothing to act on — the document is empty.',
    running: (label: string) => `Running ${label}…`,
    failed: (label: string) => `${label} failed`,
    emptyModelResponse: 'The model returned an empty response.',

    customInstruction: 'Custom instruction…',
    customDialogTitle: 'Custom edit instruction',
    customDialogDesc: 'Describe the edit in your own words (e.g. "make this more formal"). Applies to the selection, or the whole document if nothing is selected.',
    customPlaceholder: 'e.g. Make this more formal',
    customSubmit: 'Propose edit',
    customApplying: 'Applying…',

    proposedTitle: 'ChangeSet proposed',
    proposedMessage: (scope: string) =>
      `A rewrite of the ${scope} was proposed as a ChangeSet. Review it in ChangeSet Review before it changes the saved file.`,
    proposeFailed: 'Failed to propose the ChangeSet',

    resultDialogClose: 'Close',

    labels: {
      polish: 'Polish',
      explain: 'Explain',
      reformat: 'Reformat',
      distill: 'Distill',
      strengthen: 'Strengthen',
      soften: 'Soften',
      critique: 'Critique'
    } as Record<string, string>
  },

  // Workflow Designer (Slice M authoring + Slice N bounded manual Run; see
  // go-forward plan §5). A workflow is a graph (nodes + edges) that is
  // created, saved, loaded, edited, and — as of Slice N — run manually
  // against a hard step cap with a cycle guard (workflow-run-engine.ts). The
  // palette only ever offers 3 node kinds (Trigger/Condition/Output); the
  // other 9 declared WorkbenchWorkflowNodeKind values are intentionally not
  // named in this catalog, and a Run refuses to execute any of them.
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

    // Structured condition comparison — REPLACES the old free-text
    // "Expression (not evaluated)" field from Slice M. See
    // workflow-run-engine.ts for the fixed operator enum and comparison
    // semantics (plain field comparison, never evaluated as code).
    conditionLeftLabel: 'Left value',
    conditionLeftPlaceholder: 'e.g. approved',
    conditionOperatorLabel: 'Operator',
    conditionOperatorPlaceholder: 'Choose an operator',
    conditionRightLabel: 'Compare to',
    conditionRightPlaceholder: 'e.g. approved',
    conditionCaseSensitiveLabel: 'Case sensitive',

    operatorNames: {
      equals: 'Equals',
      not_equals: 'Not equals',
      contains: 'Contains',
      greater_than: 'Greater than',
      less_than: 'Less than',
      is_empty: 'Is empty'
    } as Record<string, string>,

    outputLabelLabel: 'Label',
    outputLabelPlaceholder: 'e.g. Final result',

    deleteNode: 'Delete node',
    deleteEdge: 'Delete connection',

    // Manual Run (Slice N) — a bounded, local, in-memory graph traversal;
    // see workflow-run-engine.ts. No model/skill/agent/HTTP/terminal/git/
    // cron/child_process API is ever reachable from a Run. Nothing from a
    // run is written to disk — the result is ephemeral React state, cleared
    // on dialog close or the next run.
    run: 'Run',
    runFailed: 'Run failed',
    runResultHeading: 'Run result',
    runResultEmpty: 'No run yet.',
    runStepsHeading: 'Steps',
    runStepsEmpty: 'No node was reached.',
    runOutputsHeading: 'Outputs',
    runOutputsEmpty: 'No output node was reached.',

    // Gateway-backed run (lib/workflow-run.ts → tui_gateway workflow.run/dryRun),
    // as opposed to the pure in-memory preview `run` above.
    dryRun: 'Dry run',
    liveRun: 'Live run',
    remoteRunHeading: 'Gateway run',
    remoteRunFailed: 'Gateway run failed',
    remoteNoSession: 'Open a chat session first — a live run routes progress through the active session.',
    remoteRunning: 'Running…',
    remoteDryRunning: 'Tracing…',
    remoteEventsHeading: 'Progress',
    remoteEventsEmpty: 'No events yet.',
    remoteResultHeading: 'Result',
    remoteDryHint: 'Trace only — no node runs and nothing is approved.',

    runStatusNames: {
      completed: 'Completed',
      halted_cycle: 'Stopped — cycle detected',
      halted_max_steps: 'Stopped — max steps reached',
      nothing_to_run: 'Nothing to run',
      refused_unsupported_node: 'Run refused'
    } as Record<string, string>
  },

  // Plugin Tester (Slice N — HTTP request executor + persistence).
  // A Postman-style HTTP tester that sends real requests through the
  // Electron main process and persists collections, history, and
  // environments under .hermes/workbench/plugin-tester/.
  pluginTester: {
    navLabel: 'Plugin Tester',

    // Request composer.
    methodLabel: 'Method',
    urlLabel: 'URL',
    urlPlaceholder: 'https://api.example.com/endpoint',
    sendButton: 'Send',
    sendingButton: 'Sending',

    headersHeading: 'Headers',
    headerKeyPlaceholder: 'Key',
    headerValuePlaceholder: 'Value',
    addHeader: 'Add header',
    paramsHeading: 'Params',
    paramKeyPlaceholder: 'Key',
    paramValuePlaceholder: 'Value',
    addParam: 'Add param',
    bodyHeading: 'Body',
    bodyPlaceholder: '{}',
    authHeading: 'Auth',
    authTypeNone: 'None',
    authTypeBearer: 'Bearer',
    authTypeBasic: 'Basic',
    authTypeApiKey: 'API Key',
    authTokenLabel: 'Token',
    authTokenPlaceholder: 'Bearer eyJ…',
    authUsernameLabel: 'Username',
    authPasswordLabel: 'Password',
    authKeyLabel: 'Key',
    authValueLabel: 'Value',
    authAddToHeader: 'Header',
    authAddToQuery: 'Query',
    timeoutLabel: 'Timeout (ms)',
    contentTypeLabel: 'Content-Type',

    // Response.
    responseHeading: 'Response',
    responseStatus: 'Status',
    responseHeaders: 'Headers',
    responseBody: 'Body',
    responseCookies: 'Cookies',
    responseTiming: 'Timing',
    responseSize: 'Size',
    noResponse: 'Send a request to see the response.',
    requestFailed: 'Request failed',

    // Timing.
    timingDns: 'DNS',
    timingConnect: 'Connect',
    timingTtfb: 'TTFB',
    timingDownload: 'Download',
    timingTotal: 'Total',

    // Collections.
    collectionsHeading: 'Collections',
    createCollection: 'New collection',
    collectionNameLabel: 'Name',
    collectionNamePlaceholder: 'Collection name',
    collectionDescriptionLabel: 'Description',
    collectionDescriptionPlaceholder: 'API for…',
    renameCollection: 'Rename',
    deleteCollection: 'Delete',
    collectionsEmpty: 'No collections yet.',
    collectionsLoading: 'Loading collections',
    collectionsFailed: 'Failed to load collections',

    // Environments.
    environmentsHeading: 'Environments',
    createEnvironment: 'New environment',
    environmentNameLabel: 'Name',
    environmentNamePlaceholder: 'Environment name',
    renameEnvironment: 'Rename',
    deleteEnvironment: 'Delete',
    variableKeyPlaceholder: 'Key',
    variableValuePlaceholder: 'Value',
    addVariable: 'Add variable',
    environmentsEmpty: 'No environments yet.',
    environmentsLoading: 'Loading environments',
    environmentsFailed: 'Failed to load environments',

    // History.
    historyHeading: 'History',
    clearHistory: 'Clear history',
    clearHistoryConfirm: 'Clear all history entries?',
    historyEmpty: 'No history yet.',
    historyLoading: 'Loading history',
    historyFailed: 'Failed to load history',
    historyEntryMethod: (method: string) => method,
    historyEntryStatus: (status: number) => `${status}`,
    historyEntryDuration: (ms: number) => `${ms}ms`,
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
