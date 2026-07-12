'use strict'

// Hermes Workbench — Plugin Tester Store
//
// Owns filesystem persistence for request collections, execution history,
// and environment variable sets. Follows the same atomic-write patterns as
// workbench-artifacts.cjs.
//
// Layout (under .hermes/workbench/plugin-tester/):
//
//   collections/
//     <id>.json              — request collection (array of request slots)
//   history/
//     <id>.json              — single execution history entry (response + trace)
//   environments/
//     <id>.json              — named set of key=value variables
//   manifest.json            — index of all stored items
//
// --- Credential-at-rest (deliberate decision) ---
//
// COLLECTIONS: Request collections persist auth values (bearer tokens,
// basic-auth passwords, API keys) UNMASKED in plaintext JSON. This is
// Postman/Insomnia parity — the data lives under a gitignored, local
// workspace directory and is treated as developer-local state. Users who
// save a collection with credentials are making an explicit choice.
//
// HISTORY: Execution history entries DO NOT retain auth values. The
// `recordHistory()` path redacts bearer tokens, basic-auth passwords,
// and API key values from the persisted request object before writing to
// disk. History is an execution log, not a credential store.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORE_ROOT = '.hermes/workbench/plugin-tester'
const COLLECTIONS_DIR = `${STORE_ROOT}/collections`
const HISTORY_DIR = `${STORE_ROOT}/history`
const ENVIRONMENTS_DIR = `${STORE_ROOT}/environments`
const MANIFEST_RELATIVE_PATH = `${STORE_ROOT}/manifest.json`

const MAX_COLLECTIONS = 50
const MAX_HISTORY = 200
const MAX_ENVIRONMENTS = 20

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
// Path safety (mirrors workbench-artifacts.cjs patterns)
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
  // normalizeRelativePath strips leading `/` to make the result relative,
  // so absolute input like `/etc/passwd` would be silently rewritten into a
  // "safe" relative path instead of being rejected. Fail closed.
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

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a workspace-relative path to an absolute path.
 * The workspace root is the actual project directory.
 *
 * Rejects unsafe relative paths (../ segments, absolute paths) as
 * defense-in-depth: every call site today goes through sanitizeId()
 * or server-generated IDs, so this guard is not reachable by current
 * callers, but it prevents a path-traversal primitive if a future
 * caller passes an untrusted relativePath.
 *
 * @param {string} workspaceRoot
 * @param {string} relativePath
 * @returns {string}
 * @throws {Error} if relativePath contains path traversal or is non-relative
 */
function resolveWorkspacePath(workspaceRoot, relativePath) {
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(
      `Path traversal rejected in resolveWorkspacePath: unsafe relative path "${relativePath}". ` +
      'Only plain relative paths without ../ or absolute components are allowed.'
    )
  }

  const normalized = normalizeRelativePath(relativePath)
  return path.join(workspaceRoot, normalized)
}

// ---------------------------------------------------------------------------
// Atomic write helpers
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

function atomicWriteJSON(filePath, obj) {
  atomicWriteFile(filePath, JSON.stringify(obj, null, 2))
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function ensureManifest(workspaceRoot) {
  const manifestPath = resolveWorkspacePath(workspaceRoot, MANIFEST_RELATIVE_PATH)
  const dir = path.dirname(manifestPath)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  if (!fs.existsSync(manifestPath)) {
    const empty = { collections: [], history: [], environments: [] }
    fs.writeFileSync(manifestPath, JSON.stringify(empty, null, 2), 'utf8')
    return empty
  }

  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    raw.collections = raw.collections || []
    raw.history = raw.history || []
    raw.environments = raw.environments || []
    return raw
  } catch {
    const empty = { collections: [], history: [], environments: [] }
    fs.writeFileSync(manifestPath, JSON.stringify(empty, null, 2), 'utf8')
    return empty
  }
}

function saveManifest(workspaceRoot, manifest) {
  const manifestPath = resolveWorkspacePath(workspaceRoot, MANIFEST_RELATIVE_PATH)
  atomicWriteJSON(manifestPath, manifest)
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/**
 * List all collections for a workspace.
 *
 * @param {string} workspaceRoot
 * @returns {{ ok: true, value: Array } | { ok: false, message: string, code: string }}
 */
function listCollections(workspaceRoot) {
  const manifest = ensureManifest(workspaceRoot)
  return { ok: true, value: manifest.collections }
}

/**
 * Create a new request collection.
 *
 * @param {string} workspaceRoot
 * @param {object} input
 * @param {string} input.name - collection name
 * @param {string} [input.description]
 * @param {Array<object>} [input.requests] - initial request slots
 * @returns {{ ok: true, value: object } | { ok: false, message: string, code: string }}
 */
function createCollection(workspaceRoot, input) {
  const manifest = ensureManifest(workspaceRoot)

  if (manifest.collections.length >= MAX_COLLECTIONS) {
    return { ok: false, message: `Maximum ${MAX_COLLECTIONS} collections reached`, code: 'LIMIT_REACHED' }
  }

  const now = new Date().toISOString()
  const id = generateId('coll')
  const safeName = sanitizeId(input.name) || id

  const relativePath = `${COLLECTIONS_DIR}/${id}.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  const collection = {
    id,
    name: input.name,
    description: input.description || '',
    requests: (input.requests && Array.isArray(input.requests)) ? input.requests : [],
    createdAt: now,
    updatedAt: now
  }

  atomicWriteJSON(fullPath, collection)

  manifest.collections.push({
    id,
    name: input.name,
    description: input.description || '',
    requestCount: collection.requests.length,
    relativePath,
    updatedAt: now
  })

  saveManifest(workspaceRoot, manifest)

  return { ok: true, value: collection }
}

/**
 * Read a single collection.
 *
 * @param {string} workspaceRoot
 * @param {string} collectionId
 * @returns {{ ok: true, value: object } | { ok: false, message: string, code: string }}
 */
function readCollection(workspaceRoot, collectionId) {
  const safeId = sanitizeId(collectionId)
  const relativePath = `${COLLECTIONS_DIR}/${safeId}.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  if (!fs.existsSync(fullPath)) {
    return { ok: false, message: 'Collection not found', code: 'NOT_FOUND' }
  }

  try {
    const collection = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
    return { ok: true, value: collection }
  } catch {
    return { ok: false, message: 'Corrupt collection file', code: 'CORRUPT' }
  }
}

/**
 * Update a collection (name, description, requests).
 *
 * @param {string} workspaceRoot
 * @param {string} collectionId
 * @param {object} patch
 * @returns {{ ok: true, value: object } | { ok: false, message: string, code: string }}
 */
function updateCollection(workspaceRoot, collectionId, patch) {
  const safeId = sanitizeId(collectionId)
  const relativePath = `${COLLECTIONS_DIR}/${safeId}.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  if (!fs.existsSync(fullPath)) {
    return { ok: false, message: 'Collection not found', code: 'NOT_FOUND' }
  }

  try {
    const collection = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
    const now = new Date().toISOString()

    if (patch.name !== undefined) collection.name = patch.name
    if (patch.description !== undefined) collection.description = patch.description
    if (patch.requests !== undefined) collection.requests = Array.isArray(patch.requests) ? patch.requests : []
    collection.updatedAt = now

    atomicWriteJSON(fullPath, collection)

    // Update manifest entry
    const manifest = ensureManifest(workspaceRoot)
    const idx = manifest.collections.findIndex(c => c.id === collectionId)
    if (idx >= 0) {
      manifest.collections[idx].name = collection.name
      manifest.collections[idx].description = collection.description || ''
      manifest.collections[idx].requestCount = collection.requests.length
      manifest.collections[idx].updatedAt = now
    }
    saveManifest(workspaceRoot, manifest)

    return { ok: true, value: collection }
  } catch (err) {
    if (err.message && err.message.includes('not found')) throw err
    return { ok: false, message: 'Corrupt collection file', code: 'CORRUPT' }
  }
}

/**
 * Delete a collection.
 *
 * @param {string} workspaceRoot
 * @param {string} collectionId
 * @returns {{ ok: true } | { ok: false, message: string, code: string }}
 */
function deleteCollection(workspaceRoot, collectionId) {
  const safeId = sanitizeId(collectionId)
  const relativePath = `${COLLECTIONS_DIR}/${safeId}.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  if (!fs.existsSync(fullPath)) {
    return { ok: false, message: 'Collection not found', code: 'NOT_FOUND' }
  }

  fs.unlinkSync(fullPath)

  const manifest = ensureManifest(workspaceRoot)
  manifest.collections = manifest.collections.filter(c => c.id !== collectionId)
  saveManifest(workspaceRoot, manifest)

  return { ok: true, value: null }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * Strip auth values from a request object clone so they are never persisted
 * in execution history. Returns a new object; the original is untouched.
 *
 * Redacted fields: auth.token, auth.password, auth.value.
 * The auth shape (type, key, username, addTo) is preserved so the UI can
 * show the auth method in history without leaking the secret.
 *
 * @param {object|null} request
 * @returns {object|null}
 */
function redactRequestAuth(request) {
  if (!request || typeof request !== 'object') return request

  const cloned = { ...request }

  if (cloned.auth && typeof cloned.auth === 'object') {
    cloned.auth = { ...cloned.auth }
    if ('token' in cloned.auth) cloned.auth.token = '[REDACTED]'
    if ('password' in cloned.auth) cloned.auth.password = '[REDACTED]'
    if ('value' in cloned.auth) cloned.auth.value = '[REDACTED]'
  }

  return cloned
}

/**
 * Record a request execution in history.
 *
 * @param {string} workspaceRoot
 * @param {object} input
 * @param {object} input.request - the original request sent
 * @param {object} input.response - the response received
 * @param {Array} input.trace - execution timing trace
 * @param {string} [input.collectionId] - optional parent collection
 * @returns {{ ok: true, value: object } | { ok: false, message: string, code: string }}
 */
function recordHistory(workspaceRoot, input) {
  const manifest = ensureManifest(workspaceRoot)
  const now = new Date().toISOString()
  const id = generateId('hst')

  const relativePath = `${HISTORY_DIR}/${id}.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  // Redact auth secrets before persisting — history is an execution log,
  // not a credential store.
  const safeRequest = redactRequestAuth(input.request)

  const entry = {
    id,
    request: safeRequest,
    response: input.response || null,
    trace: input.trace || [],
    collectionId: input.collectionId || undefined,
    createdAt: now
  }

  atomicWriteJSON(fullPath, entry)

  manifest.history.unshift({
    id,
    url: input.request?.url || '(unknown)',
    method: input.request?.method || 'GET',
    status: input.response?.status || 0,
    duration: input.trace && input.trace[0] ? input.trace[0].duration : 0,
    collectionId: input.collectionId || undefined,
    relativePath,
    createdAt: now
  })

  // FIFO eviction — keep at most MAX_HISTORY entries
  while (manifest.history.length > MAX_HISTORY) {
    const removed = manifest.history.pop()
    try {
      const removedPath = resolveWorkspacePath(workspaceRoot, removed.relativePath)
      fs.unlinkSync(removedPath)
    } catch { /* file already gone, skip */ }
  }

  saveManifest(workspaceRoot, manifest)

  return { ok: true, value: entry }
}

/**
 * List history entries, newest first.
 *
 * @param {string} workspaceRoot
 * @param {object} [opts]
 * @param {string} [opts.collectionId] - filter by collection
 * @param {number} [opts.limit] - max entries (default 50)
 * @param {number} [opts.offset] - pagination offset
 * @returns {{ ok: true, value: { entries: Array, total: number } }}
 */
function listHistory(workspaceRoot, opts) {
  const manifest = ensureManifest(workspaceRoot)
  let entries = manifest.history || []

  if (opts && opts.collectionId) {
    entries = entries.filter(e => e.collectionId === opts.collectionId)
  }

  const total = entries.length
  const offset = (opts && opts.offset && Number.isFinite(opts.offset)) ? opts.offset : 0
  const limit = (opts && opts.limit && Number.isFinite(opts.limit)) ? Math.min(opts.limit, 100) : 50

  return { ok: true, value: { entries: entries.slice(offset, offset + limit), total } }
}

/**
 * Read a single history entry with full response details.
 *
 * @param {string} workspaceRoot
 * @param {string} historyId
 * @returns {{ ok: true, value: object } | { ok: false, message: string, code: string }}
 */
function readHistoryEntry(workspaceRoot, historyId) {
  const safeId = sanitizeId(historyId)
  const relativePath = `${HISTORY_DIR}/${safeId}.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  if (!fs.existsSync(fullPath)) {
    return { ok: false, message: 'History entry not found', code: 'NOT_FOUND' }
  }

  try {
    const entry = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
    return { ok: true, value: entry }
  } catch {
    return { ok: false, message: 'Corrupt history file', code: 'CORRUPT' }
  }
}

/**
 * Delete a single history entry.
 *
 * @param {string} workspaceRoot
 * @param {string} historyId
 * @returns {{ ok: true } | { ok: false, message: string, code: string }}
 */
function deleteHistoryEntry(workspaceRoot, historyId) {
  const safeId = sanitizeId(historyId)
  const relativePath = `${HISTORY_DIR}/${safeId}.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  if (!fs.existsSync(fullPath)) {
    return { ok: false, message: 'History entry not found', code: 'NOT_FOUND' }
  }

  fs.unlinkSync(fullPath)

  const manifest = ensureManifest(workspaceRoot)
  manifest.history = manifest.history.filter(e => e.id !== historyId)
  saveManifest(workspaceRoot, manifest)

  return { ok: true, value: null }
}

/**
 * Clear all history entries for a workspace.
 *
 * @param {string} workspaceRoot
 * @returns {{ ok: true, value: { removed: number } }}
 */
function clearHistory(workspaceRoot) {
  const manifest = ensureManifest(workspaceRoot)
  const count = manifest.history.length

  for (const entry of manifest.history) {
    try {
      const fullPath = resolveWorkspacePath(workspaceRoot, entry.relativePath)
      fs.unlinkSync(fullPath)
    } catch { /* skip missing files */ }
  }

  manifest.history = []
  saveManifest(workspaceRoot, manifest)

  return { ok: true, value: { removed: count } }
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

/**
 * List all environments for a workspace.
 *
 * @param {string} workspaceRoot
 * @returns {{ ok: true, value: Array }}
 */
function listEnvironments(workspaceRoot) {
  const manifest = ensureManifest(workspaceRoot)
  return { ok: true, value: manifest.environments }
}

/**
 * Create a new environment (named set of variables).
 *
 * @param {string} workspaceRoot
 * @param {object} input
 * @param {string} input.name
 * @param {Record<string, string>} input.variables
 * @returns {{ ok: true, value: object } | { ok: false, message: string, code: string }}
 */
function createEnvironment(workspaceRoot, input) {
  const manifest = ensureManifest(workspaceRoot)

  if (manifest.environments.length >= MAX_ENVIRONMENTS) {
    return { ok: false, message: `Maximum ${MAX_ENVIRONMENTS} environments reached`, code: 'LIMIT_REACHED' }
  }

  const now = new Date().toISOString()
  const id = generateId('env')

  const relativePath = `${ENVIRONMENTS_DIR}/${id}.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  const environment = {
    id,
    name: input.name,
    variables: input.variables || {},
    createdAt: now,
    updatedAt: now
  }

  atomicWriteJSON(fullPath, environment)

  manifest.environments.push({
    id,
    name: input.name,
    variableCount: Object.keys(environment.variables).length,
    relativePath,
    updatedAt: now
  })

  saveManifest(workspaceRoot, manifest)

  return { ok: true, value: environment }
}

/**
 * Read a single environment.
 *
 * @param {string} workspaceRoot
 * @param {string} environmentId
 * @returns {{ ok: true, value: object } | { ok: false, message: string, code: string }}
 */
function readEnvironment(workspaceRoot, environmentId) {
  const safeId = sanitizeId(environmentId)
  const relativePath = `${ENVIRONMENTS_DIR}/${safeId}.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  if (!fs.existsSync(fullPath)) {
    return { ok: false, message: 'Environment not found', code: 'NOT_FOUND' }
  }

  try {
    const environment = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
    return { ok: true, value: environment }
  } catch {
    return { ok: false, message: 'Corrupt environment file', code: 'CORRUPT' }
  }
}

/**
 * Update an environment (name, variables).
 *
 * @param {string} workspaceRoot
 * @param {string} environmentId
 * @param {object} patch
 * @returns {{ ok: true, value: object } | { ok: false, message: string, code: string }}
 */
function updateEnvironment(workspaceRoot, environmentId, patch) {
  const safeId = sanitizeId(environmentId)
  const relativePath = `${ENVIRONMENTS_DIR}/${safeId}.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  if (!fs.existsSync(fullPath)) {
    return { ok: false, message: 'Environment not found', code: 'NOT_FOUND' }
  }

  try {
    const environment = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
    const now = new Date().toISOString()

    if (patch.name !== undefined) environment.name = patch.name
    if (patch.variables !== undefined) environment.variables = patch.variables
    environment.updatedAt = now

    atomicWriteJSON(fullPath, environment)

    const manifest = ensureManifest(workspaceRoot)
    const idx = manifest.environments.findIndex(e => e.id === environmentId)
    if (idx >= 0) {
      manifest.environments[idx].name = environment.name
      manifest.environments[idx].variableCount = Object.keys(environment.variables).length
      manifest.environments[idx].updatedAt = now
    }
    saveManifest(workspaceRoot, manifest)

    return { ok: true, value: environment }
  } catch (err) {
    if (err.message && err.message.includes('not found')) throw err
    return { ok: false, message: 'Corrupt environment file', code: 'CORRUPT' }
  }
}

/**
 * Delete an environment.
 *
 * @param {string} workspaceRoot
 * @param {string} environmentId
 * @returns {{ ok: true } | { ok: false, message: string, code: string }}
 */
function deleteEnvironment(workspaceRoot, environmentId) {
  const safeId = sanitizeId(environmentId)
  const relativePath = `${ENVIRONMENTS_DIR}/${safeId}.json`
  const fullPath = resolveWorkspacePath(workspaceRoot, relativePath)

  if (!fs.existsSync(fullPath)) {
    return { ok: false, message: 'Environment not found', code: 'NOT_FOUND' }
  }

  fs.unlinkSync(fullPath)

  const manifest = ensureManifest(workspaceRoot)
  manifest.environments = manifest.environments.filter(e => e.id !== environmentId)
  saveManifest(workspaceRoot, manifest)

  return { ok: true, value: null }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Collections
  listCollections,
  createCollection,
  readCollection,
  updateCollection,
  deleteCollection,
  // History
  recordHistory,
  listHistory,
  readHistoryEntry,
  deleteHistoryEntry,
  clearHistory,
  // Environments
  listEnvironments,
  createEnvironment,
  readEnvironment,
  updateEnvironment,
  deleteEnvironment,
  // Internal helpers (exposed for testing)
  _internal: {
    generateId,
    sanitizeId,
    normalizeRelativePath,
    isSafeRelativePath,
    resolveWorkspacePath,
    atomicWriteFile,
    atomicWriteJSON,
    ensureManifest,
    redactRequestAuth
  },
  // Constants
  MAX_COLLECTIONS,
  MAX_HISTORY,
  MAX_ENVIRONMENTS
}
