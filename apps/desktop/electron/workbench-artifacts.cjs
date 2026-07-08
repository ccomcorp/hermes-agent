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
  const id = sanitizeId(input.title).slice(0, 20) || generateId('req')
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
    if (input.status) trace.status = input.status
    trace.history.push({
      id: generateId('trace'),
      at: now,
      actor: 'user',
      kind: input.status ? 'status_changed' : 'updated',
      summary: input.status ? `Status changed to ${input.status}` : 'Requirement updated'
    })
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
  createPlan,
  refinePlan,
  readPlan,
  readPlanMeta,
  listPlans,
  createChangeSet,
  readChangeSet,
  updateChangeSetStatus,
  listChangeSets,
  readManifest,
  ensureManifest,
  updateManifest,
  // Exposed for testing
  _internal: {
    generateId,
    sanitizeId,
    contentHash,
    atomicWriteFile,
    atomicWriteJSON,
    normalizeRelativePath,
    isSafeRelativePath,
    resolveWorkspacePath,
    ensureUniqueId
  }
}
