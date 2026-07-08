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
// Register all workbench IPC handlers
// ---------------------------------------------------------------------------

function registerWorkbenchIpc() {
  // -- Requirements ----------------------------------------------------------

  ipcMain.handle('hermes:workbench:requirements:list', (_event, payload) => {
    const rootCheck = validateWorkspaceRoot(payload?.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    try {
      return store.listRequirements(payload.workspaceRoot)
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
      const result = store.createRequirement(payload.workspaceRoot, payload)
      return { ok: true, value: result }
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
      return store.readRequirement(payload.workspaceRoot, payload.requirementId)
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
      return store.updateRequirement(payload.workspaceRoot, payload.requirementId, payload)
    } catch (err) {
      return { ok: false, message: 'Failed to update requirement: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  // -- Plans -----------------------------------------------------------------

  ipcMain.handle('hermes:workbench:plans:list', (_event, payload) => {
    const rootCheck = validateWorkspaceRoot(payload?.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    try {
      return store.listPlans(payload.workspaceRoot, payload.requirementId)
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
      const result = store.createPlan(payload.workspaceRoot, payload)
      return { ok: true, value: result }
    } catch (err) {
      return { ok: false, message: 'Failed to create plan: ' + err.message, code: 'INTERNAL_ERROR' }
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
      return store.readPlan(payload.workspaceRoot, payload.planId)
    } catch (err) {
      return { ok: false, message: 'Failed to read plan: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  // -- ChangeSets ------------------------------------------------------------

  ipcMain.handle('hermes:workbench:changesets:list', (_event, payload) => {
    const rootCheck = validateWorkspaceRoot(payload?.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    try {
      return store.listChangeSets(payload.workspaceRoot)
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
      return store.createChangeSet(payload.workspaceRoot, payload)
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
      return store.readChangeSet(payload.workspaceRoot, payload.changesetId)
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
      return store.updateChangeSetStatus(
        payload.workspaceRoot,
        payload.changesetId,
        payload.statusPatch || {}
      )
    } catch (err) {
      return { ok: false, message: 'Failed to update changeset: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })
}

module.exports = { registerWorkbenchIpc }
