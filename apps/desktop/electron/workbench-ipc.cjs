'use strict'

// Hermes Workbench IPC handlers
//
// Extracted from main.cjs to avoid making it larger. Registers all
// `hermes:workbench:*` IPC channels and routes them to the Artifact Store.
//
// Do not trust renderer payloads. Every handler validates before writing.

const { ipcMain, BrowserWindow } = require('electron')

const store = require('./workbench-artifacts.cjs')
const { exportWriteDocument } = require('./workbench-write-export.cjs')
const { applyChangeSet, commitChangeSet } = require('./workbench-changeset-apply.cjs')

// Shared validators — imported from the compiled shared package.
// In the Electron main process (.cjs context) we can't import .ts directly,
// so we do hand-written validation here that mirrors the shared validators.
// The shared TypeScript validators are the canonical source; these are the
// runtime enforcement layer.

// ---------------------------------------------------------------------------
// Inline validators (mirror of apps/shared/src/workbench/validators.ts)
// ---------------------------------------------------------------------------

function validateWorkspaceRoot(value) {
  if (!value || typeof value !== 'string' || !value.trim()) {
    return { ok: false, message: 'workspaceRoot is required', code: 'MISSING_WORKSPACE_ROOT' }
  }
  return { ok: true }
}

function validateTitle(value) {
  if (!value || typeof value !== 'string' || !value.trim()) {
    return { ok: false, message: 'title is required', code: 'MISSING_TITLE' }
  }
  if (value.length > 500) {
    return { ok: false, message: 'title is too long', code: 'TITLE_TOO_LONG' }
  }
  return { ok: true }
}

function validateMarkdown(value, required) {
  if (required && (!value || typeof value !== 'string' || !value.trim())) {
    return { ok: false, message: 'markdown is required', code: 'MISSING_MARKDOWN' }
  }
  if (value && value.length > 1_000_000) {
    return { ok: false, message: 'markdown exceeds size limit', code: 'MARKDOWN_TOO_LARGE' }
  }
  return { ok: true }
}

function isOk(result) {
  return result && result.ok === true
}

function fail(result) {
  return { ok: false, message: result.message, code: result.code || 'VALIDATION_ERROR' }
}

// ---------------------------------------------------------------------------
// Design settings validators (mirror of validateWriteDesignSettingsRequest in
// apps/shared/src/workbench/validators.ts — see the comment at the top of
// this file for why the .cjs context hand-writes a runtime copy).
// ---------------------------------------------------------------------------

const VALID_VIEWPORTS = ['mobile', 'tablet', 'desktop']
const VALID_DESIGN_PRESETS = [
  'none', 'shadcn', 'radix', 'material', 'ios', 'fluent', 'ant',
  'chakra', 'carbon', 'polaris', 'bootstrap', 'geist', 'brutalism', 'editorial'
]
const VALID_RADIUS_VALUES = ['sharp', 'soft', 'rounded', 'pill']
const VALID_DENSITY_VALUES = ['compact', 'cozy', 'spacious']
const VALID_FONT_STYLE_VALUES = ['system', 'geometric', 'humanist', 'serif', 'mono']

function validateDesignSettings(settings) {
  if (!settings || typeof settings !== 'object') {
    return { ok: false, message: 'settings is required', code: 'MISSING_SETTINGS' }
  }

  if (typeof settings.enabled !== 'boolean') {
    return { ok: false, message: 'settings.enabled must be a boolean', code: 'INVALID_ENABLED' }
  }

  if (!VALID_VIEWPORTS.includes(settings.defaultViewport)) {
    return { ok: false, message: 'invalid defaultViewport', code: 'INVALID_VIEWPORT' }
  }

  if (!VALID_DESIGN_PRESETS.includes(settings.designSystemPreset)) {
    return { ok: false, message: 'invalid designSystemPreset', code: 'INVALID_PRESET' }
  }

  if (settings.brandColor !== undefined) {
    if (typeof settings.brandColor !== 'string' || settings.brandColor.length > 64) {
      return { ok: false, message: 'brandColor is invalid', code: 'INVALID_BRAND_COLOR' }
    }
  }

  if (!Array.isArray(settings.tone)) {
    return { ok: false, message: 'tone must be an array', code: 'INVALID_TONE' }
  }

  if (settings.tone.length > 20) {
    return { ok: false, message: 'too many tone entries', code: 'INVALID_TONE' }
  }

  if (settings.tone.some((entry) => typeof entry !== 'string' || entry.length > 100)) {
    return { ok: false, message: 'tone entries must be short strings', code: 'INVALID_TONE' }
  }

  if (settings.radius !== undefined && !VALID_RADIUS_VALUES.includes(settings.radius)) {
    return { ok: false, message: 'invalid radius', code: 'INVALID_RADIUS' }
  }

  if (settings.density !== undefined && !VALID_DENSITY_VALUES.includes(settings.density)) {
    return { ok: false, message: 'invalid density', code: 'INVALID_DENSITY' }
  }

  if (settings.fontStyle !== undefined && !VALID_FONT_STYLE_VALUES.includes(settings.fontStyle)) {
    return { ok: false, message: 'invalid fontStyle', code: 'INVALID_FONT_STYLE' }
  }

  if (settings.stackHint !== undefined) {
    if (typeof settings.stackHint !== 'string' || settings.stackHint.length > 200) {
      return { ok: false, message: 'stackHint is invalid', code: 'INVALID_STACK_HINT' }
    }
  }

  if (typeof settings.sandboxHtmlPreview !== 'boolean') {
    return { ok: false, message: 'settings.sandboxHtmlPreview must be a boolean', code: 'INVALID_SANDBOX_FLAG' }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Write Workspace export validators (mirror of validateExportWriteProjectRequest
// in apps/shared/src/workbench/validators.ts). Slice L. The export target path
// always comes from the OS save dialog inside workbench-write-export.cjs —
// nothing here validates or constructs a filesystem path.
// ---------------------------------------------------------------------------

const VALID_WRITE_EXPORT_FORMATS = ['html', 'pdf', 'docx', 'png']
const MAX_EXPORT_HTML_LENGTH = 5_000_000

// ---------------------------------------------------------------------------
// Workflow validators (mirror of validateCreate/UpdateWorkflowRequest in
// apps/shared/src/workbench/validators.ts). AUTHORING ONLY (Slice M) — these
// never interpret/evaluate/execute any node's `config`; they only bound its
// size like any other free-text field. The backend stays PERMISSIVE of all 12
// declared node kinds — the 3-kind UI restriction lives only in the node
// palette (workflow-panel.tsx), not here.
// ---------------------------------------------------------------------------

const VALID_WORKFLOW_NODE_KINDS = [
  'manual_trigger', 'schedule_trigger', 'webhook_trigger', 'ai_agent',
  'human_approval', 'condition', 'http_request', 'code', 'delay', 'loop',
  'subworkflow', 'output'
]

// 500 nodes is a generous ceiling for a hand-authored graph (no execution
// engine exists yet to make a bigger graph useful) — it exists to reject
// pathological/malicious payloads, not to constrain real usage. Edges are
// naturally denser than nodes in a real graph, so their cap is proportionally
// larger.
const MAX_WORKFLOW_NODES = 500
const MAX_WORKFLOW_EDGES = 2000
const MAX_NODE_NAME_LENGTH = 200
const MAX_NODE_CONFIG_JSON_LENGTH = 50_000

function validateWorkflowNodes(nodes) {
  if (!Array.isArray(nodes)) {
    return { ok: false, message: 'nodes must be an array', code: 'INVALID_NODES' }
  }

  if (nodes.length > MAX_WORKFLOW_NODES) {
    return { ok: false, message: 'too many nodes', code: 'TOO_MANY_NODES' }
  }

  for (const node of nodes) {
    if (!node || typeof node !== 'object') {
      return { ok: false, message: 'each node must be an object', code: 'INVALID_NODE' }
    }
    if (!node.id || typeof node.id !== 'string') {
      return { ok: false, message: 'node.id is required', code: 'MISSING_NODE_ID' }
    }
    if (!node.type || !VALID_WORKFLOW_NODE_KINDS.includes(node.type)) {
      return { ok: false, message: 'invalid node type', code: 'INVALID_NODE_TYPE' }
    }
    if (!node.name || typeof node.name !== 'string' || node.name.length > MAX_NODE_NAME_LENGTH) {
      return { ok: false, message: 'node.name is required and must be a reasonable length', code: 'INVALID_NODE_NAME' }
    }
    if (!node.position || typeof node.position.x !== 'number' || typeof node.position.y !== 'number') {
      return { ok: false, message: 'node.position must have numeric x/y', code: 'INVALID_NODE_POSITION' }
    }
    if (node.config !== undefined) {
      if (typeof node.config !== 'object' || node.config === null) {
        return { ok: false, message: 'node.config must be an object', code: 'INVALID_NODE_CONFIG' }
      }
      if (JSON.stringify(node.config).length > MAX_NODE_CONFIG_JSON_LENGTH) {
        return { ok: false, message: 'node.config exceeds size limit', code: 'NODE_CONFIG_TOO_LARGE' }
      }
    }
  }

  return { ok: true }
}

function validateWorkflowEdges(edges, nodes) {
  if (!Array.isArray(edges)) {
    return { ok: false, message: 'edges must be an array', code: 'INVALID_EDGES' }
  }

  if (edges.length > MAX_WORKFLOW_EDGES) {
    return { ok: false, message: 'too many edges', code: 'TOO_MANY_EDGES' }
  }

  const nodeIds = new Set((nodes || []).map((n) => n.id))

  for (const edge of edges) {
    if (!edge || typeof edge !== 'object') {
      return { ok: false, message: 'each edge must be an object', code: 'INVALID_EDGE' }
    }
    if (!edge.id || typeof edge.id !== 'string') {
      return { ok: false, message: 'edge.id is required', code: 'MISSING_EDGE_ID' }
    }
    if (!edge.source || typeof edge.source !== 'string' || !edge.target || typeof edge.target !== 'string') {
      return { ok: false, message: 'edge.source and edge.target are required', code: 'INVALID_EDGE_ENDPOINTS' }
    }
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      return { ok: false, message: 'edge references an unknown node', code: 'EDGE_UNKNOWN_NODE' }
    }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Response normalization (locked decision §3.5)
//
// Every workbench handler must return exactly ONE envelope shape to the
// renderer: WorkbenchResult<T> = { ok, value?, message?, code? }. The store is
// mixed — some methods return a bare payload (createRequirement -> { requirement,
// trace }), others already return a WorkbenchResult (readPlan -> { ok, value }).
// `normalize` collapses both into the single shape so no renderer component has
// to special-case where the envelope came from. It only touches the envelope;
// the returned data is unchanged.
// ---------------------------------------------------------------------------

function normalize(result) {
  if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
    return result
  }
  return { ok: true, value: result }
}

// ---------------------------------------------------------------------------
// Register all workbench IPC handlers
// ---------------------------------------------------------------------------

// `options.gitBin` mirrors how main.cjs threads `resolveGitBinary()` into
// every other git-backed IPC handler (see git-review-ops.cjs's call sites in
// main.cjs) — Slice E's apply/commit handlers below need the same resolved
// binary so packaged Windows builds find `git.exe` the same way the coding
// rail does.
function registerWorkbenchIpc(options = {}) {
  const gitBin = options.gitBin

  // -- Requirements ----------------------------------------------------------

  ipcMain.handle('hermes:workbench:requirements:list', (_event, payload) => {
    const rootCheck = validateWorkspaceRoot(payload?.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    try {
      return normalize(store.listRequirements(payload.workspaceRoot))
    } catch (err) {
      return { ok: false, message: 'Failed to list requirements: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:requirements:create', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    const titleCheck = validateTitle(payload.title)
    if (!isOk(titleCheck)) return fail(titleCheck)

    const mdCheck = validateMarkdown(payload.markdown, false)
    if (!isOk(mdCheck)) return fail(mdCheck)

    if (payload.source && !['user', 'chat', 'import'].includes(payload.source)) {
      return { ok: false, message: 'invalid source', code: 'INVALID_SOURCE' }
    }

    try {
      return normalize(store.createRequirement(payload.workspaceRoot, payload))
    } catch (err) {
      return { ok: false, message: 'Failed to create requirement: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:requirements:read', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.requirementId || !payload.requirementId.trim()) {
      return { ok: false, message: 'requirementId is required', code: 'MISSING_REQUIREMENT_ID' }
    }

    try {
      return normalize(store.readRequirement(payload.workspaceRoot, payload.requirementId))
    } catch (err) {
      return { ok: false, message: 'Failed to read requirement: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:requirements:update', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.requirementId || !payload.requirementId.trim()) {
      return { ok: false, message: 'requirementId is required', code: 'MISSING_REQUIREMENT_ID' }
    }

    const mdCheck = validateMarkdown(payload.markdown, true)
    if (!isOk(mdCheck)) return fail(mdCheck)

    if (payload.status) {
      const validStatuses = ['draft', 'clarified', 'planned', 'in_progress', 'implemented', 'reviewed', 'verified', 'archived']
      if (!validStatuses.includes(payload.status)) {
        return { ok: false, message: 'invalid requirement status', code: 'INVALID_STATUS' }
      }
    }

    try {
      return normalize(store.updateRequirement(payload.workspaceRoot, payload.requirementId, payload))
    } catch (err) {
      return { ok: false, message: 'Failed to update requirement: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  // -- Plans -----------------------------------------------------------------

  ipcMain.handle('hermes:workbench:plans:list', (_event, payload) => {
    const rootCheck = validateWorkspaceRoot(payload?.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    try {
      return normalize(store.listPlans(payload.workspaceRoot, payload.requirementId))
    } catch (err) {
      return { ok: false, message: 'Failed to list plans: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:plans:create', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    const mdCheck = validateMarkdown(payload.markdown, true)
    if (!isOk(mdCheck)) return fail(mdCheck)

    if (payload.title) {
      const titleCheck = validateTitle(payload.title)
      if (!isOk(titleCheck)) return fail(titleCheck)
    }

    if (payload.operation && !['draft', 'refine'].includes(payload.operation)) {
      return { ok: false, message: 'invalid plan operation', code: 'INVALID_OPERATION' }
    }

    try {
      return normalize(store.createPlan(payload.workspaceRoot, payload))
    } catch (err) {
      return { ok: false, message: 'Failed to create plan: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  // Versioned refine (locked decision §3.2). `plans:update` writes a NEW plan
  // version linked to the prior one; it never overwrites the prior file.
  ipcMain.handle('hermes:workbench:plans:update', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.planId || typeof payload.planId !== 'string' || !payload.planId.trim()) {
      return { ok: false, message: 'planId is required', code: 'MISSING_PLAN_ID' }
    }

    // A caller-supplied relative path is a path-traversal vector — fail closed.
    if (payload.planRelativePath && !store._internal.isSafeRelativePath(payload.planRelativePath)) {
      return { ok: false, message: 'planRelativePath escapes the workspace', code: 'UNSAFE_PATH' }
    }

    const mdCheck = validateMarkdown(payload.markdown, true)
    if (!isOk(mdCheck)) return fail(mdCheck)

    if (payload.title) {
      const titleCheck = validateTitle(payload.title)
      if (!isOk(titleCheck)) return fail(titleCheck)
    }

    if (payload.operation && payload.operation !== 'refine') {
      return { ok: false, message: 'plans:update only supports the refine operation', code: 'INVALID_OPERATION' }
    }

    try {
      return normalize(store.refinePlan(payload.workspaceRoot, { ...payload, operation: 'refine' }))
    } catch (err) {
      return { ok: false, message: 'Failed to refine plan: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:plans:read', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.planId || !payload.planId.trim()) {
      return { ok: false, message: 'planId is required', code: 'MISSING_PLAN_ID' }
    }

    try {
      return normalize(store.readPlan(payload.workspaceRoot, payload.planId))
    } catch (err) {
      return { ok: false, message: 'Failed to read plan: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  // -- ChangeSets ------------------------------------------------------------

  ipcMain.handle('hermes:workbench:changesets:list', (_event, payload) => {
    const rootCheck = validateWorkspaceRoot(payload?.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    try {
      return normalize(store.listChangeSets(payload.workspaceRoot))
    } catch (err) {
      return { ok: false, message: 'Failed to list changesets: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:changesets:create', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    const titleCheck = validateTitle(payload.title)
    if (!isOk(titleCheck)) return fail(titleCheck)

    const validSources = ['agent', 'plan_implementation', 'design_implementation', 'write_inline_edit', 'workflow', 'manual']
    if (!validSources.includes(payload.source)) {
      return { ok: false, message: 'invalid change source', code: 'INVALID_SOURCE' }
    }

    if (!Array.isArray(payload.files) || payload.files.length === 0) {
      return { ok: false, message: 'changeset must contain at least one file', code: 'EMPTY_CHANGESET' }
    }

    try {
      return normalize(store.createChangeSet(payload.workspaceRoot, payload))
    } catch (err) {
      return { ok: false, message: 'Failed to create changeset: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:changesets:read', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.changesetId || !payload.changesetId.trim()) {
      return { ok: false, message: 'changesetId is required', code: 'MISSING_CHANGESET_ID' }
    }

    try {
      return normalize(store.readChangeSet(payload.workspaceRoot, payload.changesetId))
    } catch (err) {
      return { ok: false, message: 'Failed to read changeset: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:changesets:update', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.changesetId || !payload.changesetId.trim()) {
      return { ok: false, message: 'changesetId is required', code: 'MISSING_CHANGESET_ID' }
    }

    if (payload.statusPatch?.status) {
      const validStatuses = ['pending', 'partially_accepted', 'accepted', 'rejected', 'applied', 'archived']
      if (!validStatuses.includes(payload.statusPatch.status)) {
        return { ok: false, message: 'invalid changeset status', code: 'INVALID_STATUS' }
      }
    }

    try {
      return normalize(store.updateChangeSetStatus(
        payload.workspaceRoot,
        payload.changesetId,
        payload.statusPatch || {}
      ))
    } catch (err) {
      return { ok: false, message: 'Failed to update changeset: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  // -- ChangeSets — Apply + Commit (Slice E) ---------------------------------
  //
  // Apply is a SEPARATE, ADDITIONAL action from accept/reject above — it does
  // not change how a changeset becomes `accepted`, and it is the first
  // Workbench write that reaches the user's REAL project files instead of
  // `.hermes/workbench/`. Fail closed: workspaceRoot + changesetId are
  // required, and workbench-changeset-apply.cjs itself independently refuses
  // to run unless the changeset is already `accepted`.
  //
  // Deliberately NOT declared `async` (same reasoning as write:export above):
  // every validation failure below returns a plain synchronous result, and
  // only the final success path returns a Promise, which `ipcMain.handle`
  // awaits natively.
  ipcMain.handle('hermes:workbench:changesets:apply', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.changesetId || !payload.changesetId.trim()) {
      return { ok: false, message: 'changesetId is required', code: 'MISSING_CHANGESET_ID' }
    }

    return applyChangeSet(payload.workspaceRoot, payload.changesetId, { gitBin })
      .then(result => normalize(result))
      .catch(err => ({ ok: false, message: 'Failed to apply changeset: ' + err.message, code: 'INTERNAL_ERROR' }))
  })

  // Commit is a further separate, explicit action — never auto-triggered by
  // apply above. Stages+commits only the files this changeset applied.
  ipcMain.handle('hermes:workbench:changesets:commit', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.changesetId || !payload.changesetId.trim()) {
      return { ok: false, message: 'changesetId is required', code: 'MISSING_CHANGESET_ID' }
    }

    if (payload.message !== undefined && (typeof payload.message !== 'string' || payload.message.length > 2000)) {
      return { ok: false, message: 'message is invalid', code: 'INVALID_MESSAGE' }
    }

    return commitChangeSet(payload.workspaceRoot, payload.changesetId, { gitBin, message: payload.message })
      .then(result => normalize(result))
      .catch(err => ({ ok: false, message: 'Failed to commit changeset: ' + err.message, code: 'INTERNAL_ERROR' }))
  })

  // -- Design settings (Slice F — settings only, never briefs/prototypes) ----

  ipcMain.handle('hermes:workbench:design:settings:read', (_event, payload) => {
    const rootCheck = validateWorkspaceRoot(payload?.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    try {
      return normalize(store.readDesignSettings(payload.workspaceRoot))
    } catch (err) {
      return { ok: false, message: 'Failed to read design settings: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:design:settings:write', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    const settingsCheck = validateDesignSettings(payload.settings)
    if (!isOk(settingsCheck)) return fail(settingsCheck)

    try {
      return normalize(store.writeDesignSettings(payload.workspaceRoot, payload.settings))
    } catch (err) {
      return { ok: false, message: 'Failed to write design settings: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  // -- Write Workspace — CRUD only (Slice J) ---------------------------------
  //
  // A write project is a single markdown document + metadata, same shape as a
  // Requirement. No quick-actions/inline-edit/retrieval/export channel exists
  // here — those are Slice K/L, not built in this slice.

  ipcMain.handle('hermes:workbench:write:list', (_event, payload) => {
    const rootCheck = validateWorkspaceRoot(payload?.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    try {
      return normalize(store.listWriteProjects(payload.workspaceRoot))
    } catch (err) {
      return { ok: false, message: 'Failed to list write projects: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:write:create', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    const titleCheck = validateTitle(payload.title)
    if (!isOk(titleCheck)) return fail(titleCheck)

    const mdCheck = validateMarkdown(payload.markdown, false)
    if (!isOk(mdCheck)) return fail(mdCheck)

    try {
      return normalize(store.createWriteProject(payload.workspaceRoot, payload))
    } catch (err) {
      return { ok: false, message: 'Failed to create write project: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:write:read', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.writeProjectId || !payload.writeProjectId.trim()) {
      return { ok: false, message: 'writeProjectId is required', code: 'MISSING_WRITE_PROJECT_ID' }
    }

    try {
      return normalize(store.readWriteProject(payload.workspaceRoot, payload.writeProjectId))
    } catch (err) {
      return { ok: false, message: 'Failed to read write project: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:write:update', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.writeProjectId || !payload.writeProjectId.trim()) {
      return { ok: false, message: 'writeProjectId is required', code: 'MISSING_WRITE_PROJECT_ID' }
    }

    const mdCheck = validateMarkdown(payload.markdown, true)
    if (!isOk(mdCheck)) return fail(mdCheck)

    if (payload.title) {
      const titleCheck = validateTitle(payload.title)
      if (!isOk(titleCheck)) return fail(titleCheck)
    }

    try {
      return normalize(store.updateWriteProject(payload.workspaceRoot, payload.writeProjectId, payload))
    } catch (err) {
      return { ok: false, message: 'Failed to update write project: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  // -- Write Workspace export (Slice L) --------------------------------------
  //
  // Renders to HTML/PDF/DOCX/PNG and writes ONLY to a path the user picks via
  // the OS save dialog — see workbench-write-export.cjs. `workspaceRoot`/
  // `writeProjectId` get the same fail-closed validation as every other
  // request; they are never used to build the target path here.

  // Deliberately NOT declared `async`: every validation failure below returns
  // a plain (synchronous) result, exactly like every other handler in this
  // file, and only the final success path returns a Promise (which
  // `ipcMain.handle` awaits natively). This keeps validation-denial testing
  // synchronous like the rest of this suite instead of forcing every caller
  // of this one channel to await a Promise just to see a validation error.
  ipcMain.handle('hermes:workbench:write:export', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.writeProjectId || !payload.writeProjectId.trim()) {
      return { ok: false, message: 'writeProjectId is required', code: 'MISSING_WRITE_PROJECT_ID' }
    }

    if (!payload.format || !VALID_WRITE_EXPORT_FORMATS.includes(payload.format)) {
      return { ok: false, message: 'invalid export format', code: 'INVALID_FORMAT' }
    }

    if (!payload.html || typeof payload.html !== 'string' || !payload.html.trim()) {
      return { ok: false, message: 'html is required', code: 'MISSING_HTML' }
    }

    if (payload.html.length > MAX_EXPORT_HTML_LENGTH) {
      return { ok: false, message: 'html exceeds size limit', code: 'HTML_TOO_LARGE' }
    }

    if (payload.title) {
      const titleCheck = validateTitle(payload.title)
      if (!isOk(titleCheck)) return fail(titleCheck)
    }

    const parentWindow = BrowserWindow.getFocusedWindow()

    return exportWriteDocument(
      { format: payload.format, html: payload.html, title: payload.title || 'export' },
      { parentWindow }
    )
      .then(result => normalize(result))
      .catch(err => ({ ok: false, message: 'Failed to export write project: ' + err.message, code: 'INTERNAL_ERROR' }))
  })

  // -- Workflow Designer — AUTHORING ONLY (Slice M) --------------------------
  //
  // A WorkbenchWorkflow is a graph (nodes + edges) that is created, saved,
  // loaded, and edited — NEVER RUN. No node-execution logic, "run workflow"
  // handler, or interpreter of any kind exists here or anywhere in this
  // slice. These four handlers are pure JSON document CRUD, exactly like
  // Requirements/Plans/ChangeSets/Write projects above.

  ipcMain.handle('hermes:workbench:workflows:list', (_event, payload) => {
    const rootCheck = validateWorkspaceRoot(payload?.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    try {
      return normalize(store.listWorkflows(payload.workspaceRoot))
    } catch (err) {
      return { ok: false, message: 'Failed to list workflows: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:workflows:create', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    const titleCheck = validateTitle(payload.title)
    if (!isOk(titleCheck)) return fail(titleCheck)

    const nodes = payload.nodes ?? []
    const nodesCheck = validateWorkflowNodes(nodes)
    if (!isOk(nodesCheck)) return fail(nodesCheck)

    const edgesCheck = validateWorkflowEdges(payload.edges ?? [], nodes)
    if (!isOk(edgesCheck)) return fail(edgesCheck)

    if (payload.enabled !== undefined && typeof payload.enabled !== 'boolean') {
      return { ok: false, message: 'enabled must be a boolean', code: 'INVALID_ENABLED' }
    }

    try {
      return normalize(store.createWorkflow(payload.workspaceRoot, payload))
    } catch (err) {
      return { ok: false, message: 'Failed to create workflow: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:workflows:read', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.workflowId || !payload.workflowId.trim()) {
      return { ok: false, message: 'workflowId is required', code: 'MISSING_WORKFLOW_ID' }
    }

    try {
      return normalize(store.readWorkflow(payload.workspaceRoot, payload.workflowId))
    } catch (err) {
      return { ok: false, message: 'Failed to read workflow: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:workflows:update', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.workflowId || !payload.workflowId.trim()) {
      return { ok: false, message: 'workflowId is required', code: 'MISSING_WORKFLOW_ID' }
    }

    if (payload.title) {
      const titleCheck = validateTitle(payload.title)
      if (!isOk(titleCheck)) return fail(titleCheck)
    }

    const nodesCheck = validateWorkflowNodes(payload.nodes)
    if (!isOk(nodesCheck)) return fail(nodesCheck)

    const edgesCheck = validateWorkflowEdges(payload.edges, payload.nodes)
    if (!isOk(edgesCheck)) return fail(edgesCheck)

    if (payload.enabled !== undefined && typeof payload.enabled !== 'boolean') {
      return { ok: false, message: 'enabled must be a boolean', code: 'INVALID_ENABLED' }
    }

    try {
      return normalize(store.updateWorkflow(payload.workspaceRoot, payload.workflowId, payload))
    } catch (err) {
      return { ok: false, message: 'Failed to update workflow: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })
}

module.exports = { registerWorkbenchIpc }
