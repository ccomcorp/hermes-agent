'use strict'

// Hermes Workbench IPC handlers
//
// Extracted from main.cjs to avoid making it larger. Registers all
// `hermes:workbench:*` IPC channels and routes them to the Artifact Store.
//
// Do not trust renderer payloads. Every handler validates before writing.

const { ipcMain } = require('electron')

const store = require('./workbench-artifacts.cjs')

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

function registerWorkbenchIpc() {
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
}

module.exports = { registerWorkbenchIpc }
