'use strict'

// Hermes Workbench IPC handlers
//
// Extracted from main.cjs to avoid making it larger. Registers all
// `hermes:workbench:*` IPC channels and routes them to the Artifact Store.
//
// Do not trust renderer payloads. Every handler validates before writing.

const { ipcMain } = require('electron')

const store = require('./workbench-artifacts.cjs')
const { applyChangeSet, commitChangeSet } = require('./workbench-changeset-apply.cjs')
const testerStore = require('./workbench-plugin-tester-store.cjs')
const testerExec = require('./workbench-plugin-tester-exec.cjs')

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
// Design artifact generation validators (Slice G). These channels are pure
// artifact-store CRUD — no model/generation call happens on the main-process
// side (that lives in the renderer's `requestOneShot()` call, same seam as
// Slice K's write quick actions). Structurally permissive of all four
// declared kinds, matching WorkbenchDesignArtifact — only 'brief'/'prototype'
// have a generation UI in this slice, but the store/IPC do not special-case
// that restriction.
// ---------------------------------------------------------------------------

const VALID_DESIGN_ARTIFACT_KINDS = ['brief', 'design_system', 'prototype', 'quality_report']
const MAX_DESIGN_ARTIFACT_CONTENT_LENGTH = 2_000_000

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

  // Records a Kanban card id into the requirement trace's linkedKanbanCardIds
  // (the "Send to Kanban" design handoff's Workbench → card backlink). Fail
  // closed on the inputs like every other channel; the store fn itself returns
  // a discriminated result (EMPTY_CARD_ID/TRACE_NOT_FOUND/IO_ERROR) that the
  // renderer branches on for the card-created-but-link-failed soft warning.
  ipcMain.handle('hermes:workbench:requirements:link-kanban-card', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.requirementId || typeof payload.requirementId !== 'string' || !payload.requirementId.trim()) {
      return { ok: false, message: 'requirementId is required', code: 'MISSING_REQUIREMENT_ID' }
    }

    if (!payload.cardId || typeof payload.cardId !== 'string' || !payload.cardId.trim()) {
      return { ok: false, message: 'cardId is required', code: 'EMPTY_CARD_ID' }
    }

    try {
      return normalize(store.linkKanbanCardToRequirement(payload.workspaceRoot, payload.requirementId, payload.cardId))
    } catch (err) {
      return { ok: false, message: 'Failed to link Kanban card: ' + err.message, code: 'INTERNAL_ERROR' }
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

  // -- Design artifacts — generation storage (Slice G) -----------------------
  //
  // Pure artifact-store CRUD, mirroring Requirements' create/list/read shape
  // exactly. No model/generation call happens here — the renderer builds the
  // prompt and calls `requestOneShot()` itself (see design-generation.ts /
  // design-generation-panel.tsx), then hands the resulting text to
  // `create` below. Each call creates a brand-new artifact; there is no
  // update/overwrite channel.

  ipcMain.handle('hermes:workbench:design:artifacts:create', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.requirementId || typeof payload.requirementId !== 'string' || !payload.requirementId.trim()) {
      return { ok: false, message: 'requirementId is required', code: 'MISSING_REQUIREMENT_ID' }
    }

    if (!payload.kind || !VALID_DESIGN_ARTIFACT_KINDS.includes(payload.kind)) {
      return { ok: false, message: 'invalid design artifact kind', code: 'INVALID_KIND' }
    }

    if (!payload.content || typeof payload.content !== 'string' || !payload.content.trim()) {
      return { ok: false, message: 'content is required', code: 'MISSING_CONTENT' }
    }

    if (payload.content.length > MAX_DESIGN_ARTIFACT_CONTENT_LENGTH) {
      return { ok: false, message: 'content exceeds size limit', code: 'CONTENT_TOO_LARGE' }
    }

    try {
      return normalize(store.createDesignArtifact(payload.workspaceRoot, payload))
    } catch (err) {
      return { ok: false, message: 'Failed to create design artifact: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:design:artifacts:list', (_event, payload) => {
    const rootCheck = validateWorkspaceRoot(payload?.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.requirementId || typeof payload.requirementId !== 'string' || !payload.requirementId.trim()) {
      return { ok: false, message: 'requirementId is required', code: 'MISSING_REQUIREMENT_ID' }
    }

    try {
      return normalize(store.listDesignArtifacts(payload.workspaceRoot, payload.requirementId))
    } catch (err) {
      return { ok: false, message: 'Failed to list design artifacts: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:design:artifacts:read', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.artifactId || typeof payload.artifactId !== 'string' || !payload.artifactId.trim()) {
      return { ok: false, message: 'artifactId is required', code: 'MISSING_ARTIFACT_ID' }
    }

    try {
      return normalize(store.readDesignArtifact(payload.workspaceRoot, payload.artifactId))
    } catch (err) {
      return { ok: false, message: 'Failed to read design artifact: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  // =========================================================================
  // Plugin Tester — HTTP request executor + persistence (Slice N)
  // =========================================================================
  //
  // Executes real HTTP requests via Node.js fetch (NEVER from the renderer),
  // and persists request collections, execution history, and environment
  // variable sets under .hermes/workbench/plugin-tester/.
  //
  // All handlers follow the same fail-closed validation pattern as every other
  // domain handler in this file.

  // -- Plugin Tester: Execute request ----------------------------------------

  ipcMain.handle('hermes:workbench:plugin-tester:execute', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    // Validate the request structure
    const requestCheck = testerExec.validateRequest(payload.request)
    if (!isOk(requestCheck)) return fail(requestCheck)

    // Async execution path — only the success path returns a Promise,
    // matching the changesets:apply pattern.
    return (async () => {
      const validatedRequest = requestCheck.value

      // Resolve environment variables if an environment id is provided
      let resolvedRequest = { ...validatedRequest }

      if (payload.environmentId) {
        const envResult = testerStore.readEnvironment(payload.workspaceRoot, payload.environmentId)
        if (!isOk(envResult)) return fail(envResult)

        const variables = envResult.value.variables || {}

        // Resolve URL
        const { resolved: resolvedUrl, unresolvedTokens: urlTokens } = testerExec.resolveVariables(
          validatedRequest.url, variables
        )
        resolvedRequest.url = resolvedUrl

        // Resolve headers
        const { headers: resolvedHeaders, unresolvedTokens: headerTokens } = testerExec.resolveHeaderVariables(
          validatedRequest.headers || {}, variables
        )
        resolvedRequest.headers = resolvedHeaders

        // Resolve body
        if (typeof validatedRequest.body === 'string') {
          const { resolved: resolvedBody } = testerExec.resolveVariables(
            validatedRequest.body, variables
          )
          resolvedRequest.body = resolvedBody
        }

        // Resolve auth values
        if (validatedRequest.auth) {
          const resolvedAuth = { ...validatedRequest.auth }
          if (typeof resolvedAuth.token === 'string') {
            resolvedAuth.token = testerExec.resolveVariables(resolvedAuth.token, variables).resolved
          }
          if (typeof resolvedAuth.username === 'string') {
            resolvedAuth.username = testerExec.resolveVariables(resolvedAuth.username, variables).resolved
          }
          if (typeof resolvedAuth.password === 'string') {
            resolvedAuth.password = testerExec.resolveVariables(resolvedAuth.password, variables).resolved
          }
          if (typeof resolvedAuth.value === 'string') {
            resolvedAuth.value = testerExec.resolveVariables(resolvedAuth.value, variables).resolved
          }
          resolvedRequest.auth = resolvedAuth

          if (urlTokens.length > 0 || headerTokens.length > 0) {
            resolvedRequest._unresolvedTokens = [...urlTokens, ...headerTokens]
          }
        }
      }

      // Execute the request
      const result = await testerExec.executeRequest(resolvedRequest)

      // If successful, record in history
      if (result.ok && result.value) {
        try {
          testerStore.recordHistory(payload.workspaceRoot, {
            request: resolvedRequest,
            response: result.value.response,
            trace: result.value.trace,
            collectionId: payload.collectionId || undefined
          })
        } catch { /* history recording is best-effort; never fail the response */ }
      }

      return result
    })().catch(err => ({ ok: false, message: 'Failed to execute request: ' + err.message, code: 'INTERNAL_ERROR' }))
  })

  // -- Plugin Tester: Collections CRUD ---------------------------------------

  ipcMain.handle('hermes:workbench:plugin-tester:collections:list', (_event, payload) => {
    const rootCheck = validateWorkspaceRoot(payload?.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    try {
      return normalize(testerStore.listCollections(payload.workspaceRoot))
    } catch (err) {
      return { ok: false, message: 'Failed to list collections: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:plugin-tester:collections:create', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.name || typeof payload.name !== 'string' || !payload.name.trim()) {
      return { ok: false, message: 'name is required', code: 'MISSING_NAME' }
    }

    if (payload.name.length > 200) {
      return { ok: false, message: 'name is too long', code: 'NAME_TOO_LONG' }
    }

    if (payload.description && typeof payload.description !== 'string') {
      return { ok: false, message: 'description must be a string', code: 'INVALID_DESCRIPTION' }
    }

    if (payload.description && payload.description.length > 2000) {
      return { ok: false, message: 'description is too long', code: 'DESCRIPTION_TOO_LONG' }
    }

    if (payload.requests !== undefined && !Array.isArray(payload.requests)) {
      return { ok: false, message: 'requests must be an array', code: 'INVALID_REQUESTS' }
    }

    try {
      return normalize(testerStore.createCollection(payload.workspaceRoot, payload))
    } catch (err) {
      return { ok: false, message: 'Failed to create collection: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:plugin-tester:collections:read', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.collectionId || !payload.collectionId.trim()) {
      return { ok: false, message: 'collectionId is required', code: 'MISSING_COLLECTION_ID' }
    }

    try {
      return normalize(testerStore.readCollection(payload.workspaceRoot, payload.collectionId))
    } catch (err) {
      return { ok: false, message: 'Failed to read collection: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:plugin-tester:collections:update', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.collectionId || !payload.collectionId.trim()) {
      return { ok: false, message: 'collectionId is required', code: 'MISSING_COLLECTION_ID' }
    }

    if (payload.name !== undefined && (typeof payload.name !== 'string' || !payload.name.trim())) {
      return { ok: false, message: 'name must be a non-empty string', code: 'INVALID_NAME' }
    }

    if (payload.name && payload.name.length > 200) {
      return { ok: false, message: 'name is too long', code: 'NAME_TOO_LONG' }
    }

    try {
      return normalize(testerStore.updateCollection(payload.workspaceRoot, payload.collectionId, payload))
    } catch (err) {
      return { ok: false, message: 'Failed to update collection: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:plugin-tester:collections:delete', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.collectionId || !payload.collectionId.trim()) {
      return { ok: false, message: 'collectionId is required', code: 'MISSING_COLLECTION_ID' }
    }

    try {
      return normalize(testerStore.deleteCollection(payload.workspaceRoot, payload.collectionId))
    } catch (err) {
      return { ok: false, message: 'Failed to delete collection: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  // -- Plugin Tester: History ------------------------------------------------

  ipcMain.handle('hermes:workbench:plugin-tester:history:list', (_event, payload) => {
    const rootCheck = validateWorkspaceRoot(payload?.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    try {
      return normalize(testerStore.listHistory(payload.workspaceRoot, {
        collectionId: payload?.collectionId,
        limit: payload?.limit,
        offset: payload?.offset
      }))
    } catch (err) {
      return { ok: false, message: 'Failed to list history: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:plugin-tester:history:create', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.request || typeof payload.request !== 'object') {
      return { ok: false, message: 'request is required', code: 'MISSING_REQUEST' }
    }

    try {
      return normalize(testerStore.recordHistory(payload.workspaceRoot, {
        request: payload.request,
        response: payload.response || null,
        trace: payload.trace || [],
        collectionId: payload.collectionId || undefined
      }))
    } catch (err) {
      return { ok: false, message: 'Failed to record history: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:plugin-tester:history:read', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.historyId || !payload.historyId.trim()) {
      return { ok: false, message: 'historyId is required', code: 'MISSING_HISTORY_ID' }
    }

    try {
      return normalize(testerStore.readHistoryEntry(payload.workspaceRoot, payload.historyId))
    } catch (err) {
      return { ok: false, message: 'Failed to read history entry: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:plugin-tester:history:delete', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.historyId || !payload.historyId.trim()) {
      return { ok: false, message: 'historyId is required', code: 'MISSING_HISTORY_ID' }
    }

    try {
      return normalize(testerStore.deleteHistoryEntry(payload.workspaceRoot, payload.historyId))
    } catch (err) {
      return { ok: false, message: 'Failed to delete history entry: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:plugin-tester:history:clear', (_event, payload) => {
    const rootCheck = validateWorkspaceRoot(payload?.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    try {
      return normalize(testerStore.clearHistory(payload.workspaceRoot))
    } catch (err) {
      return { ok: false, message: 'Failed to clear history: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  // -- Plugin Tester: Environments CRUD --------------------------------------

  ipcMain.handle('hermes:workbench:plugin-tester:environments:list', (_event, payload) => {
    const rootCheck = validateWorkspaceRoot(payload?.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    try {
      return normalize(testerStore.listEnvironments(payload.workspaceRoot))
    } catch (err) {
      return { ok: false, message: 'Failed to list environments: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:plugin-tester:environments:create', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.name || typeof payload.name !== 'string' || !payload.name.trim()) {
      return { ok: false, message: 'name is required', code: 'MISSING_NAME' }
    }

    if (payload.name.length > 200) {
      return { ok: false, message: 'name is too long', code: 'NAME_TOO_LONG' }
    }

    if (payload.variables !== undefined && typeof payload.variables !== 'object') {
      return { ok: false, message: 'variables must be an object', code: 'INVALID_VARIABLES' }
    }

    // Validate variable count
    if (payload.variables && Object.keys(payload.variables).length > 500) {
      return { ok: false, message: 'too many variables (max 500)', code: 'VARIABLES_TOO_MANY' }
    }

    try {
      return normalize(testerStore.createEnvironment(payload.workspaceRoot, payload))
    } catch (err) {
      return { ok: false, message: 'Failed to create environment: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:plugin-tester:environments:read', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.environmentId || !payload.environmentId.trim()) {
      return { ok: false, message: 'environmentId is required', code: 'MISSING_ENVIRONMENT_ID' }
    }

    try {
      return normalize(testerStore.readEnvironment(payload.workspaceRoot, payload.environmentId))
    } catch (err) {
      return { ok: false, message: 'Failed to read environment: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:plugin-tester:environments:update', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.environmentId || !payload.environmentId.trim()) {
      return { ok: false, message: 'environmentId is required', code: 'MISSING_ENVIRONMENT_ID' }
    }

    if (payload.name !== undefined && (typeof payload.name !== 'string' || !payload.name.trim())) {
      return { ok: false, message: 'name must be a non-empty string', code: 'INVALID_NAME' }
    }

    if (payload.variables !== undefined && typeof payload.variables !== 'object') {
      return { ok: false, message: 'variables must be an object', code: 'INVALID_VARIABLES' }
    }

    try {
      return normalize(testerStore.updateEnvironment(payload.workspaceRoot, payload.environmentId, payload))
    } catch (err) {
      return { ok: false, message: 'Failed to update environment: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })

  ipcMain.handle('hermes:workbench:plugin-tester:environments:delete', (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, message: 'Invalid payload', code: 'INVALID_PAYLOAD' }
    }

    const rootCheck = validateWorkspaceRoot(payload.workspaceRoot)
    if (!isOk(rootCheck)) return fail(rootCheck)

    if (!payload.environmentId || !payload.environmentId.trim()) {
      return { ok: false, message: 'environmentId is required', code: 'MISSING_ENVIRONMENT_ID' }
    }

    try {
      return normalize(testerStore.deleteEnvironment(payload.workspaceRoot, payload.environmentId))
    } catch (err) {
      return { ok: false, message: 'Failed to delete environment: ' + err.message, code: 'INTERNAL_ERROR' }
    }
  })
}

module.exports = { registerWorkbenchIpc }
