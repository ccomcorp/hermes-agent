'use strict'

// Hermes Workbench Artifact Store
//
// This module owns artifact persistence for the Workbench. It is the only
// place that knows how artifacts map to disk. UI components should not write
// files directly.
//
// Workbench artifacts are workspace-relative project files. Keep all writes
// under .hermes/workbench unless the user explicitly chose an external path.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKBENCH_DIR = '.hermes/workbench'
const REQUIREMENTS_DIR = '.hermes/workbench/requirements'
const PLANS_DIR = '.hermes/workbench/plans'
const CHANGESETS_DIR = '.hermes/workbench/changesets'
const DESIGNS_DIR = '.hermes/workbench/designs'
const DESIGN_SETTINGS_RELATIVE_PATH = `${DESIGNS_DIR}/settings.json`
const WRITE_DIR = '.hermes/workbench/write'
const WORKFLOWS_DIR = '.hermes/workbench/workflows'
const MANIFEST_PATH = '.hermes/workbench/manifest.json'

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function generateId(prefix) {
  const timestamp = Date.now().toString(36)
  const random = crypto.randomBytes(4).toString('hex')
  return `${prefix}-${timestamp}${random}`
}

function sanitizeId(id) {
  if (!id || typeof id !== 'string') return ''
  return id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Requirement status lifecycle, in order. Mirrors STATUS_OPTIONS in
// requirement-panel.tsx and VALID_REQUIREMENT_STATUSES in shared/validators.ts.
// Used ONLY for forward-only (monotonic) auto-advance driven by the Kanban
// lifecycle — manual status edits are NEVER constrained by this order.
const REQUIREMENT_STATUS_ORDER = [
  'draft', 'clarified', 'planned', 'in_progress',
  'implemented', 'reviewed', 'verified', 'archived'
]

function statusRank(status) {
  const i = REQUIREMENT_STATUS_ORDER.indexOf(status)
  return i === -1 ? 0 : i // unknown/undefined ranks as the earliest (draft)
}

// Forward-only: returns whichever of the two statuses is LATER in the
// lifecycle. Guarantees an auto-advance can never move a requirement backward
// (so a manually-set reviewed/verified/archived survives a later Kanban signal).
function laterStatus(current, target) {
  return statusRank(target) > statusRank(current) ? target : current
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

function contentHash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// Atomic write helper
//
// Write-to-temp-then-rename pattern. Temp file stays in the same directory
// to avoid cross-device rename issues. Temp name includes a random suffix
// to avoid collision.
// ---------------------------------------------------------------------------

function atomicWriteFile(filePath, content) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const tmpName = path.basename(filePath) + '.tmp.' + crypto.randomBytes(4).toString('hex')
  const tmpPath = path.join(dir, tmpName)

  try {
    fs.writeFileSync(tmpPath, content, 'utf8')
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
}

function atomicWriteJSON(filePath, data) {
  atomicWriteFile(filePath, JSON.stringify(data, null, 2))
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function normalizeRelativePath(value) {
  if (!value || typeof value !== 'string') return ''

  let p = value.trim()
  p = p.replace(/\\/g, '/')
  p = p.replace(/^\.\/+/, '')
  p = p.replace(/^\/+/, '')
  p = p.replace(/\/{2,}/g, '/')
  p = p.replace(/\/$/, '')
  return p
}

function isSafeRelativePath(value) {
  if (!value || typeof value !== 'string') return false

  const normalized = normalizeRelativePath(value)
  if (!normalized) return false

  // Reject absolute paths
  if (/^[a-zA-Z]:/.test(value)) return false
  if (value.startsWith('\\\\')) return false

  // Reject POSIX-absolute paths (leading `/`) on the ORIGINAL input.
  // normalizeRelativePath() strips a leading `/` to make the result
  // relative (needed for legitimate relative-path normalization, e.g.
  // `./x` or duplicate slashes), but that means absolute input like
  // `/etc/passwd` would otherwise be silently rewritten into a "safe"
  // relative path instead of being rejected. Fail closed: absolute input
  // is invalid input, not something to coerce into relative.
  if (/^\/+/.test(value.trim())) return false

  // Reject path traversal
  const segments = normalized.split('/')
  if (segments.includes('..')) return false

  let depth = 0
  for (const seg of segments) {
    if (seg === '..') depth--
    else if (seg !== '.') depth++
    if (depth < 0) return false
  }

  return true
}

function resolveWorkspacePath(workspaceRoot, relativePath) {
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '')
  const rel = normalizeRelativePath(relativePath)
  // Use path.join for OS-correct separators
  return path.join(root, rel)
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function ensureManifest(workspaceRoot) {
  const manifestFullPath = resolveWorkspacePath(workspaceRoot, MANIFEST_PATH)
  const dir = path.dirname(manifestFullPath)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  if (!fs.existsSync(manifestFullPath)) {
    const now = new Date().toISOString()
    const manifest = {
      version: 1,
      createdAt: now,
      updatedAt: now,
      requirements: [],
      plans: [],
      changesets: [],
      designs: [],
      writeProjects: [],
      workflows: []
    }
    atomicWriteJSON(manifestFullPath, manifest)
    return manifest
  }

  try {
    const content = fs.readFileSync(manifestFullPath, 'utf8')
    const manifest = JSON.parse(content)
    if (!manifest.version || manifest.version !== 1) {
      throw new Error('Unsupported manifest version: ' + manifest.version)
    }
    return manifest
  } catch (err) {
    // Corrupt manifest — return a fresh one and warn
    const now = new Date().toISOString()
    const manifest = {
      version: 1,
      createdAt: now,
      updatedAt: now,
      requirements: [],
      plans: [],
      changesets: [],
      designs: [],
      writeProjects: [],
      workflows: []
    }
    atomicWriteJSON(manifestFullPath, manifest)
    return manifest
  }
}

function updateManifest(workspaceRoot, patchFn) {
  const manifest = ensureManifest(workspaceRoot)
  const updated = patchFn(manifest)
  updated.updatedAt = new Date().toISOString()
  const manifestFullPath = resolveWorkspacePath(workspaceRoot, MANIFEST_PATH)
  atomicWriteJSON(manifestFullPath, updated)
  return updated
}

function readManifest(workspaceRoot) {
  return ensureManifest(workspaceRoot)
}

// ---------------------------------------------------------------------------
// Requirement operations
// ---------------------------------------------------------------------------

function createRequirement(workspaceRoot, input) {
  const now = new Date().toISOString()
  // Re-sanitize AFTER truncating: slice(0, 20) can re-introduce a trailing
  // hyphen that the first sanitizeId() already stripped (e.g. "coming-soon
  // landing page" -> "coming-soon-landing-"), yielding an id that is NOT
  // idempotent under sanitizeId. Every downstream lookup (design artifacts,
  // kanban/plan backlinks, listDesignArtifacts) re-runs sanitizeId on this id,
  // so a non-idempotent id silently splits a requirement from its artifacts.
  // The invariant this restores: sanitizeId(id) === id for every requirement id.
  const id = sanitizeId(sanitizeId(input.title).slice(0, 20)) || generateId('req')
  const uniqueId = ensureUniqueId(workspaceRoot, id, REQUIREMENTS_DIR)

  const relativeDir = `${REQUIREMENTS_DIR}/${uniqueId}`
  const draftRelativePath = `${relativeDir}/requirement.md`
  const traceRelativePath = `${relativeDir}/trace.json`

  const markdown = input.markdown || `# ${input.title}\n\n> Describe the requirement here.\n`
  const hash = contentHash(markdown)

  const requirement = {
    id: uniqueId,
    title: input.title,
    workspaceRoot,
    relativeDir,
    draftRelativePath,
    traceRelativePath,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    contentHash: hash
  }

  const trace = {
    version: 1,
    requirementId: uniqueId,
    title: input.title,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    linkedPlanIds: [],
    linkedChangeSetIds: [],
    linkedPrototypeIds: [],
    linkedDesignArtifactIds: [],
    linkedWriteArtifactIds: [],
    linkedKanbanCardIds: [],
    history: [
      {
        id: generateId('trace'),
        at: now,
        actor: input.source === 'chat' ? 'agent' : 'user',
        kind: 'created',
        summary: 'Requirement created'
      }
    ]
  }

  // Write files
  const draftFullPath = resolveWorkspacePath(workspaceRoot, draftRelativePath)
  const traceFullPath = resolveWorkspacePath(workspaceRoot, traceRelativePath)
  atomicWriteFile(draftFullPath, markdown)
  atomicWriteJSON(traceFullPath, trace)

  // Update manifest
  updateManifest(workspaceRoot, (m) => {
    m.requirements.push({
      id: uniqueId,
      title: input.title,
      relativePath: draftRelativePath,
      updatedAt: now
    })
    return m
  })

  return { requirement, trace }
}

function readRequirement(workspaceRoot, requirementId) {
  const safeId = sanitizeId(requirementId)
  const draftRelativePath = `${REQUIREMENTS_DIR}/${safeId}/requirement.md`
  const traceRelativePath = `${REQUIREMENTS_DIR}/${safeId}/trace.json`

  const draftFullPath = resolveWorkspacePath(workspaceRoot, draftRelativePath)
  const traceFullPath = resolveWorkspacePath(workspaceRoot, traceRelativePath)

  if (!fs.existsSync(draftFullPath)) {
    return { ok: false, message: 'Requirement not found', code: 'NOT_FOUND' }
  }

  const markdown = fs.readFileSync(draftFullPath, 'utf8')
  let trace = null
  if (fs.existsSync(traceFullPath)) {
    try {
      trace = JSON.parse(fs.readFileSync(traceFullPath, 'utf8'))
    } catch { trace = null }
  }

  return {
    ok: true,
    value: {
      id: safeId,
      markdown,
      trace,
      draftRelativePath,
      traceRelativePath
    }
  }
}

function updateRequirement(workspaceRoot, requirementId, input) {
  const safeId = sanitizeId(requirementId)
  const draftRelativePath = `${REQUIREMENTS_DIR}/${safeId}/requirement.md`
  const traceRelativePath = `${REQUIREMENTS_DIR}/${safeId}/trace.json`

  const draftFullPath = resolveWorkspacePath(workspaceRoot, draftRelativePath)
  if (!fs.existsSync(draftFullPath)) {
    return { ok: false, message: 'Requirement not found', code: 'NOT_FOUND' }
  }

  const now = new Date().toISOString()
  const hash = contentHash(input.markdown)

  atomicWriteFile(draftFullPath, input.markdown)

  // Update trace
  const traceFullPath = resolveWorkspacePath(workspaceRoot, traceRelativePath)
  let trace = null
  if (fs.existsSync(traceFullPath)) {
    try {
      trace = JSON.parse(fs.readFileSync(traceFullPath, 'utf8'))
    } catch { trace = null }
  }

  if (trace) {
    trace.updatedAt = now
    if (input.title) trace.title = input.title

    if (input.autoAdvance && input.status) {
      // Forward-only monotonic advance (Kanban-driven, e.g. a linked card
      // reaching done -> implemented). A no-op if it would move backward, and
      // records history ONLY when the status actually advances — so the
      // renderer's 5s status poll can call this repeatedly without churn.
      const advanced = laterStatus(trace.status, input.status)
      if (advanced !== trace.status) {
        trace.status = advanced
        trace.history.push({
          id: generateId('trace'),
          at: now,
          actor: 'agent',
          kind: 'status_changed',
          summary: `Status auto-advanced to ${advanced} (Kanban)`
        })
      }
    } else {
      // Manual update path — unchanged behavior (verbatim status set, any
      // direction; the dropdown must be able to move a status backward too).
      if (input.status) trace.status = input.status
      trace.history.push({
        id: generateId('trace'),
        at: now,
        actor: 'user',
        kind: input.status ? 'status_changed' : 'updated',
        summary: input.status ? `Status changed to ${input.status}` : 'Requirement updated'
      })
    }

    atomicWriteJSON(traceFullPath, trace)
  }

  // Update manifest
  updateManifest(workspaceRoot, (m) => {
    const idx = m.requirements.findIndex((r) => r.id === safeId)
    if (idx >= 0) {
      m.requirements[idx].title = input.title || m.requirements[idx].title
      m.requirements[idx].updatedAt = now
    }
    return m
  })

  return {
    ok: true,
    value: {
      id: safeId,
      title: input.title,
      status: input.status,
      contentHash: hash,
      updatedAt: now
    }
  }
}

function listRequirements(workspaceRoot) {
  const manifest = ensureManifest(workspaceRoot)
  return { ok: true, value: manifest.requirements }
}

// ---------------------------------------------------------------------------
// Plan operations
// ---------------------------------------------------------------------------

function createPlan(workspaceRoot, input) {
  const now = new Date().toISOString()
  const id = sanitizeId(input.title || generateId('plan'))
  const uniqueId = ensureUniqueId(workspaceRoot, id, PLANS_DIR)

  const relativePath = `${PLANS_DIR}/${uniqueId}.md`
  const metaRelativePath = `${PLANS_DIR}/${uniqueId}.meta.json`
  const hash = contentHash(input.markdown)
  const byteSize = Buffer.byteLength(input.markdown, 'utf8')

  const plan = {
    id: uniqueId,
    title: input.title || uniqueId,
    workspaceRoot,
    relativePath,
    requirementId: input.requirementId || undefined,
    sourceRequest: input.sourceRequest,
    operation: input.operation || 'draft',
    createdAt: now,
    updatedAt: now,
    savedAt: now,
    contentHash: hash,
    byteSize,
    version: 1,
    supersedesPlanId: undefined
  }

  // Write plan file
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)
  atomicWriteFile(fullPath, input.markdown)

  // Write a metadata sidecar next to the plan so a later refine can walk the
  // version chain from disk (version + supersedes link) without the manifest.
  atomicWriteJSON(resolveWorkspacePath(workspaceRoot, metaRelativePath), {
    version: 1,
    baseId: uniqueId,
    supersedesPlanId: null,
    requirementId: input.requirementId || null,
    title: plan.title,
    operation: plan.operation,
    createdAt: now
  })

  // Update manifest
  updateManifest(workspaceRoot, (m) => {
    m.plans.push({
      id: uniqueId,
      title: plan.title,
      relativePath,
      updatedAt: now,
      version: 1,
      supersedesPlanId: null,
      requirementId: input.requirementId || undefined
    })
    return m
  })

  // Link to requirement trace if provided
  if (input.requirementId) {
    linkPlanToRequirement(workspaceRoot, input.requirementId, uniqueId)
  }

  return { plan, summary: `Plan "${plan.title}" created` }
}

// ---------------------------------------------------------------------------
// Versioned plan refine (locked decision: refine keeps history)
//
// A refine never overwrites or deletes the prior plan. It writes a NEW plan
// version file (`<base>-v<n>.md`) plus a `.meta.json` sidecar that carries the
// supersedes-link back to the prior version, and records the new plan + link in
// the source requirement's trace.json (`linkedPlanIds` + a `plan_linked` entry).
// ---------------------------------------------------------------------------

function readPlanMeta(workspaceRoot, planId) {
  const safeId = sanitizeId(planId)
  if (!safeId) return null
  const metaRelativePath = `${PLANS_DIR}/${safeId}.meta.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, metaRelativePath)
  if (!fs.existsSync(fullPath)) return null
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'))
  } catch {
    return null
  }
}

function refinePlan(workspaceRoot, input) {
  const now = new Date().toISOString()

  const priorId = sanitizeId(input.planId)
  if (!priorId) {
    return { ok: false, message: 'planId is required to refine a plan', code: 'MISSING_PLAN_ID' }
  }

  // Defense in depth: a caller-supplied relative path is a traversal vector.
  // Fail closed if it would escape the workspace.
  if (input.planRelativePath && !isSafeRelativePath(input.planRelativePath)) {
    return { ok: false, message: 'planRelativePath escapes the workspace', code: 'UNSAFE_PATH' }
  }

  // Locate the prior version. Never mutate it.
  const priorRelativePath = `${PLANS_DIR}/${priorId}.md`
  const priorFullPath = resolveWorkspacePath(workspaceRoot, priorRelativePath)
  if (!fs.existsSync(priorFullPath)) {
    return { ok: false, message: 'Prior plan not found', code: 'NOT_FOUND' }
  }

  const priorMeta = readPlanMeta(workspaceRoot, priorId)
  const priorVersion = priorMeta && Number.isFinite(priorMeta.version) ? priorMeta.version : 1
  const baseId = (priorMeta && priorMeta.baseId) || priorId.replace(/-v\d+$/, '')
  const newVersion = priorVersion + 1

  const newId = ensureUniqueId(workspaceRoot, `${baseId}-v${newVersion}`, PLANS_DIR)
  const relativePath = `${PLANS_DIR}/${newId}.md`
  const metaRelativePath = `${PLANS_DIR}/${newId}.meta.json`

  const hash = contentHash(input.markdown)
  const byteSize = Buffer.byteLength(input.markdown, 'utf8')
  const requirementId = input.requirementId || (priorMeta && priorMeta.requirementId) || undefined
  const title = input.title || (priorMeta && priorMeta.title) || newId

  const plan = {
    id: newId,
    title,
    workspaceRoot,
    relativePath,
    requirementId: requirementId || undefined,
    sourceRequest: input.sourceRequest,
    operation: 'refine',
    createdAt: now,
    updatedAt: now,
    savedAt: now,
    contentHash: hash,
    byteSize,
    version: newVersion,
    supersedesPlanId: priorId
  }

  // Write the NEW version and its supersedes-carrying sidecar. The prior
  // version file and sidecar are never touched — refine keeps full history.
  atomicWriteFile(resolveWorkspacePath(workspaceRoot, relativePath), input.markdown)
  atomicWriteJSON(resolveWorkspacePath(workspaceRoot, metaRelativePath), {
    version: newVersion,
    baseId,
    supersedesPlanId: priorId,
    requirementId: requirementId || null,
    title,
    operation: 'refine',
    createdAt: now
  })

  // Manifest: append the new version, leave the prior entry intact.
  updateManifest(workspaceRoot, (m) => {
    m.plans.push({
      id: newId,
      title,
      relativePath,
      updatedAt: now,
      version: newVersion,
      supersedesPlanId: priorId,
      requirementId: requirementId || undefined
    })
    return m
  })

  // Record the new version + supersedes link in the requirement trace.
  if (requirementId) {
    linkPlanToRequirement(workspaceRoot, requirementId, newId, {
      supersedesPlanId: priorId,
      version: newVersion
    })
  }

  return { plan, summary: `Plan refined to v${newVersion} (supersedes ${priorId})` }
}

function readPlan(workspaceRoot, planId) {
  const safeId = sanitizeId(planId)
  const relativePath = `${PLANS_DIR}/${safeId}.md`
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  if (!fs.existsSync(fullPath)) {
    return { ok: false, message: 'Plan not found', code: 'NOT_FOUND' }
  }

  const markdown = fs.readFileSync(fullPath, 'utf8')
  const hash = contentHash(markdown)
  const stat = fs.statSync(fullPath)
  const meta = readPlanMeta(workspaceRoot, safeId)

  return {
    ok: true,
    value: {
      id: safeId,
      markdown,
      relativePath,
      contentHash: hash,
      byteSize: stat.size,
      savedAt: stat.mtime.toISOString(),
      version: meta && Number.isFinite(meta.version) ? meta.version : 1,
      supersedesPlanId: meta && meta.supersedesPlanId ? meta.supersedesPlanId : undefined
    }
  }
}

function listPlans(workspaceRoot, requirementId) {
  const manifest = ensureManifest(workspaceRoot)
  if (requirementId) {
    // TODO: filter by requirementId when trace linkage is queried
    // For now return all and let caller filter
  }
  return { ok: true, value: manifest.plans }
}

// ---------------------------------------------------------------------------
// ChangeSet operations
// ---------------------------------------------------------------------------

function createChangeSet(workspaceRoot, input) {
  const now = new Date().toISOString()
  const id = generateId('cs')

  const relativePath = `${CHANGESETS_DIR}/${id}.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  const changeset = {
    id,
    workspaceRoot,
    source: input.source,
    requirementId: input.requirementId || undefined,
    planId: input.planId || undefined,
    title: input.title,
    summary: input.summary || '',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    files: input.files || [],
    approvals: []
  }

  atomicWriteJSON(fullPath, changeset)

  updateManifest(workspaceRoot, (m) => {
    m.changesets.push({
      id,
      title: input.title,
      relativePath,
      updatedAt: now
    })
    return m
  })

  return { ok: true, value: changeset }
}

function readChangeSet(workspaceRoot, changesetId) {
  const relativePath = `${CHANGESETS_DIR}/${sanitizeId(changesetId)}.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  if (!fs.existsSync(fullPath)) {
    return { ok: false, message: 'ChangeSet not found', code: 'NOT_FOUND' }
  }

  try {
    const changeset = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
    return { ok: true, value: changeset }
  } catch {
    return { ok: false, message: 'Corrupt changeset file', code: 'CORRUPT' }
  }
}

function updateChangeSetStatus(workspaceRoot, changesetId, statusPatch) {
  const relativePath = `${CHANGESETS_DIR}/${sanitizeId(changesetId)}.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  if (!fs.existsSync(fullPath)) {
    return { ok: false, message: 'ChangeSet not found', code: 'NOT_FOUND' }
  }

  try {
    const changeset = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
    const now = new Date().toISOString()

    if (statusPatch.status) changeset.status = statusPatch.status
    if (statusPatch.fileUpdates) {
      for (const update of statusPatch.fileUpdates) {
        const fileIdx = changeset.files.findIndex((f) => f.path === update.path)
        if (fileIdx >= 0) {
          changeset.files[fileIdx].status = update.status
        }
      }
    }
    if (statusPatch.approval) {
      changeset.approvals.push({
        id: generateId('appr'),
        ...statusPatch.approval,
        at: now
      })
    }

    changeset.updatedAt = now
    atomicWriteJSON(fullPath, changeset)

    // Update manifest
    updateManifest(workspaceRoot, (m) => {
      const idx = m.changesets.findIndex((c) => c.id === changesetId)
      if (idx >= 0) m.changesets[idx].updatedAt = now
      return m
    })

    return { ok: true, value: changeset }
  } catch {
    return { ok: false, message: 'Corrupt changeset file', code: 'CORRUPT' }
  }
}

function listChangeSets(workspaceRoot) {
  const manifest = ensureManifest(workspaceRoot)
  return { ok: true, value: manifest.changesets }
}

// Persists a full, already-mutated changeset object back to disk. Used by
// workbench-changeset-apply.cjs (Slice E) after it mutates per-file
// status/applyResult and the overall changeset status in memory — this
// function owns the actual path/atomic-write mechanics (same discipline as
// every other write in this file), the caller owns the apply/commit
// semantics. Not used by updateChangeSetStatus above, which does its own
// narrower read-patch-write for the Slice D status-transition path.
function writeChangeSet(workspaceRoot, changeset) {
  const relativePath = `${CHANGESETS_DIR}/${sanitizeId(changeset.id)}.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  atomicWriteJSON(fullPath, changeset)

  updateManifest(workspaceRoot, (m) => {
    const idx = m.changesets.findIndex((c) => c.id === changeset.id)
    if (idx >= 0) m.changesets[idx].updatedAt = changeset.updatedAt
    return m
  })

  return { ok: true, value: changeset }
}

// ---------------------------------------------------------------------------
// Design Studio — SETTINGS only (Slice F, go-forward plan §5).
//
// Unlike requirements/plans/changesets, there is exactly ONE
// WorkbenchDesignSettings document per workspace — not a list keyed by id.
// readDesignSettings()/writeDesignSettings() read/write the whole object at
// `.hermes/workbench/designs/settings.json`. This never touches
// WorkbenchDesignArtifact (briefs/prototypes/quality reports) — generating
// those is Slice G/H/I, explicitly out of scope here.
// ---------------------------------------------------------------------------

function defaultDesignSettings() {
  return {
    enabled: true,
    defaultViewport: 'desktop',
    designSystemPreset: 'none',
    tone: [],
    sandboxHtmlPreview: true
  }
}

function readDesignSettings(workspaceRoot) {
  const fullPath = resolveWorkspacePath(workspaceRoot, DESIGN_SETTINGS_RELATIVE_PATH)

  if (!fs.existsSync(fullPath)) {
    // Fail OPEN with sensible defaults here, not a NOT_FOUND error — a
    // workspace with no saved design settings yet is the normal first-load
    // state, matching the "show sensible defaults if none saved yet" UX,
    // not a missing-artifact error.
    return { ok: true, value: defaultDesignSettings() }
  }

  try {
    const settings = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
    return { ok: true, value: settings }
  } catch {
    return { ok: false, message: 'Corrupt design settings file', code: 'CORRUPT' }
  }
}

function writeDesignSettings(workspaceRoot, settings) {
  const now = new Date().toISOString()
  const fullPath = resolveWorkspacePath(workspaceRoot, DESIGN_SETTINGS_RELATIVE_PATH)

  atomicWriteJSON(fullPath, settings)

  // Keep the manifest's `designs` array in sync with a single settings entry
  // — mirrors the bookkeeping every other artifact type gets, even though
  // this is a singleton document rather than a list.
  updateManifest(workspaceRoot, (m) => {
    if (!Array.isArray(m.designs)) m.designs = []
    const idx = m.designs.findIndex((d) => d.id === 'settings')
    const entry = { id: 'settings', title: 'Design settings', relativePath: DESIGN_SETTINGS_RELATIVE_PATH, updatedAt: now }
    if (idx >= 0) m.designs[idx] = entry
    else m.designs.push(entry)
    return m
  })

  return { ok: true, value: settings }
}

// ---------------------------------------------------------------------------
// Design Studio — artifact generation (Slice G, go-forward plan §5 Slice G).
//
// Unlike design SETTINGS above (one singleton document per workspace), a
// WorkbenchDesignArtifact is a list, scoped to a requirement — every
// generation call creates a BRAND-NEW artifact under
// `.hermes/workbench/designs/<requirementId>/<artifactId>.<ext>`; it never
// overwrites a prior one (same non-destructive principle as Plan refine,
// simpler here: no supersedes-chain, just an ever-growing list per
// requirement). Mirrors the Plan file+`.meta.json` sidecar pattern: the
// content file holds the raw artifact text (Markdown for brief/design_system/
// quality_report, an HTML document STRING for prototype — this module never
// parses or executes that HTML, only reads/writes it as text), and the
// sidecar holds the full WorkbenchDesignArtifact record so a later list/read
// doesn't need to re-derive `kind`/`createdAt`/`contentHash` from the
// filename. No generation/model-invocation logic lives here — this is pure
// artifact-store CRUD, exactly like every other section in this file.
// ---------------------------------------------------------------------------

const DESIGN_ARTIFACT_EXTENSIONS = {
  brief: 'md',
  design_system: 'md',
  prototype: 'html',
  quality_report: 'md'
}

const VALID_DESIGN_ARTIFACT_KINDS = ['brief', 'design_system', 'prototype', 'quality_report']

function designArtifactRelativeDir(requirementId) {
  return `${DESIGNS_DIR}/${sanitizeId(requirementId)}`
}

function designArtifactContentRelativePath(requirementId, id, kind) {
  const ext = DESIGN_ARTIFACT_EXTENSIONS[kind] || 'md'
  return `${designArtifactRelativeDir(requirementId)}/${id}.${ext}`
}

function designArtifactMetaRelativePath(requirementId, id) {
  return `${designArtifactRelativeDir(requirementId)}/${id}.meta.json`
}

// Records the new artifact in the source requirement's trace.json
// (`linkedDesignArtifactIds` + a `design_linked` history entry), mirroring
// `linkPlanToRequirement` below. Silently skips if the requirement/trace is
// missing or corrupt — same fail-soft bookkeeping behavior as the plan link.
function linkDesignArtifactToRequirement(workspaceRoot, requirementId, artifactId) {
  const tracePath = `${REQUIREMENTS_DIR}/${sanitizeId(requirementId)}/trace.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, tracePath)

  if (!fs.existsSync(fullPath)) return

  try {
    const trace = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
    const now = new Date().toISOString()

    if (!trace.linkedDesignArtifactIds) trace.linkedDesignArtifactIds = []
    if (!trace.linkedDesignArtifactIds.includes(artifactId)) {
      trace.linkedDesignArtifactIds.push(artifactId)
    }
    trace.updatedAt = now
    trace.history.push({
      id: generateId('trace'),
      at: now,
      actor: 'agent',
      kind: 'design_linked',
      summary: `Design artifact ${artifactId} linked`
    })

    atomicWriteJSON(fullPath, trace)
  } catch {
    // Silently skip if trace is missing/corrupt
  }
}

// Records a Kanban card id into the requirement's trace.json
// (`linkedKanbanCardIds` + a `kanban_linked` history entry). This MIRRORS the
// append + `.includes` dedupe SHAPE of linkDesignArtifactToRequirement above,
// but deliberately NOT its fail-silent, void-returning posture: the "Send to
// Kanban" handoff runs this AFTER a real card already exists on the board, and
// a card-created-but-not-linked state must be SURFACED to the user (a distinct
// soft warning), never swallowed. So this returns a discriminated result the
// renderer branches on:
//   { ok: true,  value: <updated trace> }
//   { ok: false, code: 'EMPTY_CARD_ID' | 'TRACE_NOT_FOUND' | 'IO_ERROR', message }
// It also REJECTS an empty/missing/non-string cardId up front (never writes an
// empty backlink) and guards `trace.history` is an array before pushing (the
// original mirror throws here if history is absent). Re-linking the same card
// is an idempotent no-op that still reports ok.
function linkKanbanCardToRequirement(workspaceRoot, requirementId, cardId) {
  if (typeof cardId !== 'string' || !cardId.trim()) {
    return { ok: false, code: 'EMPTY_CARD_ID', message: 'cardId is required' }
  }

  const id = cardId.trim()
  const tracePath = `${REQUIREMENTS_DIR}/${sanitizeId(requirementId)}/trace.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, tracePath)

  if (!fs.existsSync(fullPath)) {
    return { ok: false, code: 'TRACE_NOT_FOUND', message: `Requirement trace not found for ${requirementId}` }
  }

  try {
    const trace = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
    const now = new Date().toISOString()

    if (!Array.isArray(trace.linkedKanbanCardIds)) trace.linkedKanbanCardIds = []
    if (!Array.isArray(trace.history)) trace.history = []

    // Idempotent: re-linking an already-recorded card writes nothing.
    if (!trace.linkedKanbanCardIds.includes(id)) {
      trace.linkedKanbanCardIds.push(id)
      trace.updatedAt = now
      trace.history.push({
        id: generateId('trace'),
        at: now,
        actor: 'user',
        kind: 'kanban_linked',
        summary: `Kanban card ${id} linked`
      })

      // Auto-advance (forward-only): dispatching a design to Kanban means the
      // requirement is now being implemented. laterStatus() guarantees this
      // never moves a manually-advanced status backward.
      const advanced = laterStatus(trace.status, 'in_progress')
      if (advanced !== trace.status) {
        trace.status = advanced
        trace.history.push({
          id: generateId('trace'),
          at: now,
          actor: 'agent',
          kind: 'status_changed',
          summary: `Status auto-advanced to ${advanced} (sent to Kanban)`
        })
      }

      atomicWriteJSON(fullPath, trace)
    }

    return { ok: true, value: trace }
  } catch (err) {
    return { ok: false, code: 'IO_ERROR', message: `Failed to link Kanban card: ${err.message}` }
  }
}

function createDesignArtifact(workspaceRoot, input) {
  const requirementId = sanitizeId(input && input.requirementId)
  if (!requirementId) {
    return { ok: false, message: 'requirementId is required', code: 'MISSING_REQUIREMENT_ID' }
  }

  if (!input || !VALID_DESIGN_ARTIFACT_KINDS.includes(input.kind)) {
    return { ok: false, message: 'invalid design artifact kind', code: 'INVALID_KIND' }
  }

  if (typeof input.content !== 'string' || !input.content.trim()) {
    return { ok: false, message: 'content is required', code: 'MISSING_CONTENT' }
  }

  const now = new Date().toISOString()
  const id = generateId('design')
  const relativePath = designArtifactContentRelativePath(requirementId, id, input.kind)
  const metaRelativePath = designArtifactMetaRelativePath(requirementId, id)
  const hash = contentHash(input.content)

  const artifact = {
    id,
    requirementId,
    workspaceRoot,
    kind: input.kind,
    relativePath,
    createdAt: now,
    contentHash: hash
  }

  atomicWriteFile(resolveWorkspacePath(workspaceRoot, relativePath), input.content)
  atomicWriteJSON(resolveWorkspacePath(workspaceRoot, metaRelativePath), artifact)

  // Bookkeeping only — listDesignArtifacts()/readDesignArtifact() below read
  // from the per-requirement directory / manifest entry respectively, not by
  // re-deriving state from this push, but the manifest entry's relativePath
  // is what readDesignArtifact() (which takes only an artifactId, no
  // requirementId) uses to locate the file.
  updateManifest(workspaceRoot, (m) => {
    if (!Array.isArray(m.designs)) m.designs = []
    m.designs.push({
      id,
      title: `${input.kind} — ${requirementId}`,
      relativePath,
      updatedAt: now,
      requirementId,
      kind: input.kind
    })
    return m
  })

  linkDesignArtifactToRequirement(workspaceRoot, requirementId, id)

  return { ok: true, value: artifact }
}

function listDesignArtifacts(workspaceRoot, requirementId) {
  const safeReqId = sanitizeId(requirementId)
  if (!safeReqId) {
    return { ok: false, message: 'requirementId is required', code: 'MISSING_REQUIREMENT_ID' }
  }

  const dirFullPath = resolveWorkspacePath(workspaceRoot, designArtifactRelativeDir(safeReqId))

  if (!fs.existsSync(dirFullPath)) {
    return { ok: true, value: [] }
  }

  const sidecarNames = fs.readdirSync(dirFullPath).filter((name) => name.endsWith('.meta.json'))
  const artifacts = []

  for (const name of sidecarNames) {
    try {
      artifacts.push(JSON.parse(fs.readFileSync(path.join(dirFullPath, name), 'utf8')))
    } catch {
      // Skip a corrupt sidecar rather than failing the whole list
    }
  }

  // Newest first — matches how a per-requirement, ever-growing list is most
  // useful to browse (most recent generation at the top).
  artifacts.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))

  return { ok: true, value: artifacts }
}

// Takes ONLY an artifactId (no requirementId) — the manifest is the id ->
// relativePath lookup that makes this possible, since the artifact's real
// location is nested under a requirement-scoped directory this function
// doesn't otherwise know.
function readDesignArtifact(workspaceRoot, artifactId) {
  const safeId = sanitizeId(artifactId)
  if (!safeId) {
    return { ok: false, message: 'artifactId is required', code: 'MISSING_ARTIFACT_ID' }
  }

  const manifest = ensureManifest(workspaceRoot)
  const entry = (manifest.designs || []).find((d) => d.id === safeId && d.relativePath)

  if (!entry) {
    return { ok: false, message: 'Design artifact not found', code: 'NOT_FOUND' }
  }

  const fullPath = resolveWorkspacePath(workspaceRoot, entry.relativePath)
  if (!fs.existsSync(fullPath)) {
    return { ok: false, message: 'Design artifact not found', code: 'NOT_FOUND' }
  }

  const content = fs.readFileSync(fullPath, 'utf8')

  const metaRelativePath = `${path.posix.dirname(entry.relativePath)}/${safeId}.meta.json`
  const metaFullPath = resolveWorkspacePath(workspaceRoot, metaRelativePath)

  let meta = null
  if (fs.existsSync(metaFullPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(metaFullPath, 'utf8'))
    } catch {
      meta = null
    }
  }

  const artifact = meta || {
    id: safeId,
    requirementId: entry.requirementId,
    workspaceRoot,
    kind: entry.kind,
    relativePath: entry.relativePath,
    createdAt: entry.updatedAt,
    contentHash: contentHash(content)
  }

  return { ok: true, value: { ...artifact, content } }
}

// ---------------------------------------------------------------------------
// Write Workspace — CRUD only (Slice J, go-forward plan §5).
//
// A WorkbenchWriteProject is a single markdown document + metadata, the same
// shape as a Requirement: one directory per project holding a content file
// (`document.md`) and a metadata sidecar (`project.json`, mirroring
// requirement's trace.json / plan's meta.json). `project.json` also carries
// `recentEdits` — a capped, PASSIVE history log of saves (title/content
// snapshots truncated for size), never an undo-an-AI-edit mechanism (that
// would require Slice K's inline-edit flow, which does not exist yet). No
// generation, export, or retrieval API is called anywhere in this section.
// ---------------------------------------------------------------------------

const MAX_RECENT_EDITS = 20
const RECENT_EDIT_PREVIEW_LENGTH = 500

function writeProjectRelativeDir(id) {
  return `${WRITE_DIR}/${id}`
}

function writeProjectDocRelativePath(id) {
  return `${writeProjectRelativeDir(id)}/document.md`
}

function writeProjectMetaRelativePath(id) {
  return `${writeProjectRelativeDir(id)}/project.json`
}

function readWriteProjectMeta(workspaceRoot, id) {
  const fullPath = resolveWorkspacePath(workspaceRoot, writeProjectMetaRelativePath(id))
  if (!fs.existsSync(fullPath)) return null
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'))
  } catch {
    return null
  }
}

function previewText(text) {
  if (typeof text !== 'string') return ''
  return text.length > RECENT_EDIT_PREVIEW_LENGTH
    ? text.slice(0, RECENT_EDIT_PREVIEW_LENGTH) + '…'
    : text
}

// Appends one passive save-history entry (source is always 'user' here —
// Slice J never produces an 'inline_edit' entry, that requires Slice K's
// AI-edit flow) and caps the list so it never grows unbounded.
function appendRecentEdit(meta, input) {
  const entries = Array.isArray(meta.recentEdits) ? meta.recentEdits : []
  entries.push({
    at: new Date().toISOString(),
    source: 'user',
    fileRelativePath: input.fileRelativePath,
    from: 0,
    to: input.previousLength,
    deletedText: previewText(input.previousMarkdown),
    insertedText: previewText(input.nextMarkdown)
  })
  return entries.slice(-MAX_RECENT_EDITS)
}

// Converts stored (at-anchored) entries into the wire `WorkbenchWriteRecentEdit`
// shape, computing `ageMs` at read time rather than persisting a value that
// would go stale the instant it was written.
function toRecentEditsResponse(entries) {
  if (!Array.isArray(entries)) return []
  const now = Date.now()
  return entries.map((entry) => ({
    source: entry.source,
    ageMs: Math.max(0, now - new Date(entry.at).getTime()),
    fileRelativePath: entry.fileRelativePath,
    from: entry.from,
    to: entry.to,
    deletedText: entry.deletedText,
    insertedText: entry.insertedText,
    ...(entry.instruction ? { instruction: entry.instruction } : {})
  }))
}

function createWriteProject(workspaceRoot, input) {
  const now = new Date().toISOString()
  const id = sanitizeId(input.title).slice(0, 20) || generateId('write')
  const uniqueId = ensureUniqueId(workspaceRoot, id, WRITE_DIR)

  const rootRelativeDir = writeProjectRelativeDir(uniqueId)
  const activeFileRelativePath = writeProjectDocRelativePath(uniqueId)
  const metaRelativePath = writeProjectMetaRelativePath(uniqueId)

  const markdown = input.markdown || `# ${input.title}\n\n> Start writing here.\n`

  const project = {
    id: uniqueId,
    workspaceRoot,
    title: input.title,
    rootRelativeDir,
    activeFileRelativePath,
    createdAt: now,
    updatedAt: now
  }

  atomicWriteFile(resolveWorkspacePath(workspaceRoot, activeFileRelativePath), markdown)
  atomicWriteJSON(resolveWorkspacePath(workspaceRoot, metaRelativePath), {
    version: 1,
    project,
    recentEdits: []
  })

  updateManifest(workspaceRoot, (m) => {
    if (!Array.isArray(m.writeProjects)) m.writeProjects = []
    m.writeProjects.push({
      id: uniqueId,
      title: input.title,
      relativePath: activeFileRelativePath,
      updatedAt: now
    })
    return m
  })

  return { project }
}

function readWriteProject(workspaceRoot, writeProjectId) {
  const safeId = sanitizeId(writeProjectId)
  const activeFileRelativePath = writeProjectDocRelativePath(safeId)
  const fullPath = resolveWorkspacePath(workspaceRoot, activeFileRelativePath)

  if (!fs.existsSync(fullPath)) {
    return { ok: false, message: 'Write project not found', code: 'NOT_FOUND' }
  }

  const markdown = fs.readFileSync(fullPath, 'utf8')
  const meta = readWriteProjectMeta(workspaceRoot, safeId)
  const project = (meta && meta.project) || {
    id: safeId,
    workspaceRoot,
    title: safeId,
    rootRelativeDir: writeProjectRelativeDir(safeId),
    activeFileRelativePath,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }

  return {
    ok: true,
    value: {
      id: safeId,
      title: project.title,
      markdown,
      rootRelativeDir: project.rootRelativeDir,
      activeFileRelativePath: project.activeFileRelativePath,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      recentEdits: toRecentEditsResponse(meta && meta.recentEdits)
    }
  }
}

function updateWriteProject(workspaceRoot, writeProjectId, input) {
  const safeId = sanitizeId(writeProjectId)
  const activeFileRelativePath = writeProjectDocRelativePath(safeId)
  const fullPath = resolveWorkspacePath(workspaceRoot, activeFileRelativePath)

  if (!fs.existsSync(fullPath)) {
    return { ok: false, message: 'Write project not found', code: 'NOT_FOUND' }
  }

  const now = new Date().toISOString()
  const previousMarkdown = fs.readFileSync(fullPath, 'utf8')
  const hash = contentHash(input.markdown)

  atomicWriteFile(fullPath, input.markdown)

  const metaRelativePath = writeProjectMetaRelativePath(safeId)
  const metaFullPath = resolveWorkspacePath(workspaceRoot, metaRelativePath)
  const meta = readWriteProjectMeta(workspaceRoot, safeId) || { version: 1, project: null, recentEdits: [] }

  const project = meta.project || {
    id: safeId,
    workspaceRoot,
    title: input.title || safeId,
    rootRelativeDir: writeProjectRelativeDir(safeId),
    activeFileRelativePath,
    createdAt: now,
    updatedAt: now
  }

  project.updatedAt = now
  if (input.title) project.title = input.title

  meta.project = project
  meta.recentEdits = appendRecentEdit(meta, {
    fileRelativePath: activeFileRelativePath,
    previousLength: previousMarkdown.length,
    previousMarkdown,
    nextMarkdown: input.markdown
  })

  atomicWriteJSON(metaFullPath, meta)

  updateManifest(workspaceRoot, (m) => {
    if (!Array.isArray(m.writeProjects)) m.writeProjects = []
    const idx = m.writeProjects.findIndex((w) => w.id === safeId)
    if (idx >= 0) {
      m.writeProjects[idx].title = project.title
      m.writeProjects[idx].updatedAt = now
    } else {
      m.writeProjects.push({ id: safeId, title: project.title, relativePath: activeFileRelativePath, updatedAt: now })
    }
    return m
  })

  return {
    ok: true,
    value: {
      id: safeId,
      title: project.title,
      contentHash: hash,
      updatedAt: now
    }
  }
}

function listWriteProjects(workspaceRoot) {
  const manifest = ensureManifest(workspaceRoot)
  return { ok: true, value: manifest.writeProjects || [] }
}

// ---------------------------------------------------------------------------
// Workflow Designer — AUTHORING ONLY (Slice M, go-forward plan §5).
//
// A WorkbenchWorkflow is a single JSON document (the whole graph: id/title/
// workspaceRoot/enabled/nodes/edges/timestamps) per workflow, stored as a flat
// file under WORKFLOWS_DIR — the same shape as a ChangeSet, not a directory
// with a sidecar like Requirement/Write project. Nothing in this section
// interprets, evaluates, or executes any node's `config`; every function here
// is a pure JSON read/write, exactly like every other artifact type in this
// file. There is no "run workflow" function anywhere in this module.
// ---------------------------------------------------------------------------

function workflowRelativePath(id) {
  return `${WORKFLOWS_DIR}/${sanitizeId(id)}.json`
}

function createWorkflow(workspaceRoot, input) {
  const now = new Date().toISOString()
  const id = generateId('wf')
  const relativePath = workflowRelativePath(id)
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  const workflow = {
    id,
    title: input.title,
    workspaceRoot,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
    nodes: Array.isArray(input.nodes) ? input.nodes : [],
    edges: Array.isArray(input.edges) ? input.edges : [],
    createdAt: now,
    updatedAt: now
  }

  atomicWriteJSON(fullPath, workflow)

  updateManifest(workspaceRoot, (m) => {
    if (!Array.isArray(m.workflows)) m.workflows = []
    m.workflows.push({ id, title: input.title, relativePath, updatedAt: now })
    return m
  })

  return { workflow }
}

function readWorkflow(workspaceRoot, workflowId) {
  const safeId = sanitizeId(workflowId)
  const relativePath = workflowRelativePath(safeId)
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  if (!fs.existsSync(fullPath)) {
    return { ok: false, message: 'Workflow not found', code: 'NOT_FOUND' }
  }

  try {
    const workflow = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
    return { ok: true, value: workflow }
  } catch {
    return { ok: false, message: 'Corrupt workflow file', code: 'CORRUPT' }
  }
}

function updateWorkflow(workspaceRoot, workflowId, input) {
  const safeId = sanitizeId(workflowId)
  const relativePath = workflowRelativePath(safeId)
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  if (!fs.existsSync(fullPath)) {
    return { ok: false, message: 'Workflow not found', code: 'NOT_FOUND' }
  }

  let workflow
  try {
    workflow = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
  } catch {
    return { ok: false, message: 'Corrupt workflow file', code: 'CORRUPT' }
  }

  const now = new Date().toISOString()

  if (input.title) workflow.title = input.title
  if (typeof input.enabled === 'boolean') workflow.enabled = input.enabled
  if (Array.isArray(input.nodes)) workflow.nodes = input.nodes
  if (Array.isArray(input.edges)) workflow.edges = input.edges
  workflow.updatedAt = now

  atomicWriteJSON(fullPath, workflow)

  updateManifest(workspaceRoot, (m) => {
    if (!Array.isArray(m.workflows)) m.workflows = []
    const idx = m.workflows.findIndex((w) => w.id === safeId)
    if (idx >= 0) {
      m.workflows[idx].title = workflow.title
      m.workflows[idx].updatedAt = now
    } else {
      m.workflows.push({ id: safeId, title: workflow.title, relativePath, updatedAt: now })
    }
    return m
  })

  const hash = contentHash(JSON.stringify({ nodes: workflow.nodes, edges: workflow.edges }))

  return {
    ok: true,
    value: {
      id: safeId,
      title: workflow.title,
      enabled: workflow.enabled,
      contentHash: hash,
      updatedAt: now
    }
  }
}

function listWorkflows(workspaceRoot) {
  const manifest = ensureManifest(workspaceRoot)
  return { ok: true, value: manifest.workflows || [] }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ensureUniqueId(workspaceRoot, baseId, dir) {
  const fullPath = resolveWorkspacePath(workspaceRoot, dir)
  if (!fs.existsSync(fullPath)) return baseId

  // Check if baseId already exists
  const basePath = path.join(fullPath, baseId)
  if (!fs.existsSync(basePath) && !fs.existsSync(path.join(fullPath, baseId + '.md'))) {
    return baseId
  }

  // Append numeric suffix
  let counter = 1
  while (true) {
    const candidate = `${baseId}-${counter}`
    const candidatePath = path.join(fullPath, candidate)
    if (!fs.existsSync(candidatePath) && !fs.existsSync(path.join(fullPath, candidate + '.md'))) {
      return candidate
    }
    counter++
  }
}

function linkPlanToRequirement(workspaceRoot, requirementId, planId, metadata) {
  const tracePath = `${REQUIREMENTS_DIR}/${sanitizeId(requirementId)}/trace.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, tracePath)

  if (!fs.existsSync(fullPath)) return

  try {
    const trace = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
    const now = new Date().toISOString()

    if (!trace.linkedPlanIds) trace.linkedPlanIds = []
    if (!trace.linkedPlanIds.includes(planId)) {
      trace.linkedPlanIds.push(planId)
    }
    trace.updatedAt = now
    const supersedes = metadata && metadata.supersedesPlanId
    trace.history.push({
      id: generateId('trace'),
      at: now,
      actor: 'system',
      kind: 'plan_linked',
      summary: supersedes
        ? `Plan ${planId} linked (refine of ${supersedes})`
        : `Plan ${planId} linked`,
      ...(metadata ? { metadata } : {})
    })

    atomicWriteJSON(fullPath, trace)
  } catch {
    // Silently skip if trace is missing/corrupt
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createRequirement,
  readRequirement,
  updateRequirement,
  listRequirements,
  linkKanbanCardToRequirement,
  createPlan,
  refinePlan,
  readPlan,
  readPlanMeta,
  listPlans,
  createChangeSet,
  readChangeSet,
  updateChangeSetStatus,
  listChangeSets,
  writeChangeSet,
  readDesignSettings,
  writeDesignSettings,
  createDesignArtifact,
  listDesignArtifacts,
  readDesignArtifact,
  createWriteProject,
  readWriteProject,
  updateWriteProject,
  listWriteProjects,
  createWorkflow,
  readWorkflow,
  updateWorkflow,
  listWorkflows,
  readManifest,
  ensureManifest,
  updateManifest,
  // Exposed for testing
  _internal: {
    generateId,
    sanitizeId,
    laterStatus,
    statusRank,
    REQUIREMENT_STATUS_ORDER,
    contentHash,
    atomicWriteFile,
    atomicWriteJSON,
    normalizeRelativePath,
    isSafeRelativePath,
    resolveWorkspacePath,
    ensureUniqueId
  }
}
