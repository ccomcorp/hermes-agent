'use strict'

// Quick smoke test for the new plugin-tester modules.
// Run with: node electron/plugin-tester-smoke.cjs

const execMod = require('./workbench-plugin-tester-exec.cjs')
const storeMod = require('./workbench-plugin-tester-store.cjs')

let failures = 0
function check(condition, label) {
  if (!condition) {
    console.error('FAIL:', label)
    failures++
  } else {
    console.log('PASS:', label)
  }
}

// --- Exec exports ---
const execExports = ['executeRequest', 'validateRequest', 'resolveVariables', 'resolveHeaderVariables', 'buildUrl', 'buildAuth', 'parseCookies']
for (const k of execExports) {
  check(typeof execMod[k] === 'function', `exec exports ${k}`)
}

// --- Store exports ---
const storeExports = ['listCollections', 'createCollection', 'readCollection', 'updateCollection', 'deleteCollection', 'recordHistory', 'listHistory', 'readHistoryEntry', 'deleteHistoryEntry', 'clearHistory', 'listEnvironments', 'createEnvironment', 'readEnvironment', 'updateEnvironment', 'deleteEnvironment']
for (const k of storeExports) {
  check(typeof storeMod[k] === 'function', `store exports ${k}`)
}

// --- Smoke: resolveVariables ---
{
  const r = execMod.resolveVariables('https://{{host}}/api/{{path}}', { host: 'example.com', path: 'users' })
  check(r.resolved === 'https://example.com/api/users', 'resolveVariables resolved')
  check(r.unresolvedTokens.length === 0, 'resolveVariables no unresolved')
}

// --- Smoke: resolveVariables with unresolved token ---
{
  const r = execMod.resolveVariables('https://{{host}}/api/{{missing}}', { host: 'example.com' })
  check(r.resolved === 'https://example.com/api/{{missing}}', 'resolveVariables leaves unresolved')
  check(r.unresolvedTokens[0] === 'missing', 'resolveVariables unresolved token')
}

// --- Smoke: validateRequest ---
{
  const v = execMod.validateRequest({ method: 'GET', url: 'https://httpbin.org/get' })
  check(v.ok === true, 'validateRequest ok')
  check(v.value.method === 'GET', 'validateRequest normalizes method')
  check(v.value.url === 'https://httpbin.org/get', 'validateRequest trims url')
}

// --- Smoke: validateRequest rejects bad method ---
{
  const v = execMod.validateRequest({ method: 'BOGUS', url: 'https://example.com' })
  check(v.ok === false, 'validateRequest rejects bad method')
  check(v.code === 'INVALID_METHOD', 'validateRequest bad method code')
}

// --- Smoke: validateRequest rejects missing url ---
{
  const v = execMod.validateRequest({ method: 'GET' })
  check(v.ok === false, 'validateRequest rejects missing url')
  check(v.code === 'MISSING_URL', 'validateRequest missing url code')
}

// --- Smoke: resolveHeaderVariables ---
{
  const r = execMod.resolveHeaderVariables({ Authorization: 'Bearer {{token}}', 'X-Custom': 'static' }, { token: 'abc123' })
  check(Object.keys(r.headers).length === 2, 'resolveHeaderVariables count')
  check(r.headers.Authorization === 'Bearer abc123', 'resolveHeaderVariables resolved')
  check(r.headers['X-Custom'] === 'static', 'resolveHeaderVariables static passthrough')
  check(r.unresolvedTokens.length === 0, 'resolveHeaderVariables no unresolved')
}

// --- Smoke: store listCollections on empty workspace ---
{
  const tmpdir = require('os').tmpdir()
  const result = storeMod.listCollections(tmpdir)
  check(result.ok === true, 'store listCollections ok')
  check(Array.isArray(result.value), 'store listCollections returns array')
  check(result.value.length === 0, 'store listCollections empty')
}

// --- Smoke: store listEnvironments on empty workspace ---
{
  const tmpdir = require('os').tmpdir()
  const result = storeMod.listEnvironments(tmpdir)
  check(result.ok === true, 'store listEnvironments ok')
  check(Array.isArray(result.value), 'store listEnvironments returns array')
  check(result.value.length === 0, 'store listEnvironments empty')
}

// --- Smoke: store listHistory on empty workspace ---
{
  const tmpdir = require('os').tmpdir()
  const result = storeMod.listHistory(tmpdir)
  check(result.ok === true, 'store listHistory ok')
  check(Array.isArray(result.value.entries), 'store listHistory returns entries array')
  check(result.value.entries.length === 0, 'store listHistory empty')
}

// --- Smoke: create/read/delete collection round-trip ---
{
  const tmpdir = require('os').tmpdir()
  const create = storeMod.createCollection(tmpdir, { name: 'My Collection', description: 'Test' })
  check(create.ok === true, 'store createCollection ok')
  check(typeof create.value.id === 'string', 'store createCollection has id')

  const read = storeMod.readCollection(tmpdir, create.value.id)
  check(read.ok === true, 'store readCollection ok')
  check(read.value.name === 'My Collection', 'store readCollection name match')
  check(read.value.description === 'Test', 'store readCollection description match')

  const del = storeMod.deleteCollection(tmpdir, create.value.id)
  check(del.ok === true, 'store deleteCollection ok')

  const readAfterDel = storeMod.readCollection(tmpdir, create.value.id)
  check(readAfterDel.ok === false, 'store readCollection after delete fails')
  check(readAfterDel.code === 'NOT_FOUND', 'store readCollection after delete NOT_FOUND')
}

// --- Smoke: create/read/delete environment round-trip ---
{
  const tmpdir = require('os').tmpdir()
  const create = storeMod.createEnvironment(tmpdir, { name: 'Staging', variables: { API_URL: 'https://staging.example.com' } })
  check(create.ok === true, 'store createEnvironment ok')
  check(typeof create.value.id === 'string', 'store createEnvironment has id')

  const read = storeMod.readEnvironment(tmpdir, create.value.id)
  check(read.ok === true, 'store readEnvironment ok')
  check(read.value.name === 'Staging', 'store readEnvironment name match')
  check(read.value.variables.API_URL === 'https://staging.example.com', 'store readEnvironment variables match')

  const del = storeMod.deleteEnvironment(tmpdir, create.value.id)
  check(del.ok === true, 'store deleteEnvironment ok')

  const readAfterDel = storeMod.readEnvironment(tmpdir, create.value.id)
  check(readAfterDel.ok === false, 'store readEnvironment after delete fails')
}

// --- Smoke: recordHistory + listHistory + readHistoryEntry + delete ---
{
  const tmpdir = require('os').tmpdir()
  const entry = { request: { method: 'GET', url: 'https://httpbin.org/get' }, response: { status: 200 } }
  const record = storeMod.recordHistory(tmpdir, entry)
  check(record.ok === true, 'store recordHistory ok')
  check(typeof record.value.id === 'string', 'store recordHistory has id')

  const list = storeMod.listHistory(tmpdir)
  check(list.ok === true, 'store listHistory ok after record')
  check(list.value.entries.length === 1, 'store listHistory has 1 entry')

  const el = list.value.entries[0]
  check(el.method === 'GET', 'store listHistory entry method')
  check(el.url === 'https://httpbin.org/get', 'store listHistory entry url')

  const read = storeMod.readHistoryEntry(tmpdir, record.value.id)
  check(read.ok === true, 'store readHistoryEntry ok')
  check(read.value.request.method === 'GET', 'store readHistoryEntry request.method match')

  const del = storeMod.deleteHistoryEntry(tmpdir, record.value.id)
  check(del.ok === true, 'store deleteHistoryEntry ok')

  const listAfterDel = storeMod.listHistory(tmpdir)
  check(listAfterDel.value.entries.length === 0, 'store listHistory empty after delete')
}

// --- Smoke: clearHistory removes all ---
{
  const tmpdir = require('os').tmpdir()
  storeMod.recordHistory(tmpdir, { request: { method: 'GET', url: 'https://a.com' }, response: { status: 200 } })
  storeMod.recordHistory(tmpdir, { request: { method: 'POST', url: 'https://b.com' }, response: { status: 201 } })
  const before = storeMod.listHistory(tmpdir)
  check(before.value.entries.length === 2, 'store listHistory 2 entries before clear')

  const cleared = storeMod.clearHistory(tmpdir)
  check(cleared.ok === true, 'store clearHistory ok')

  const after = storeMod.listHistory(tmpdir)
  check(after.value.entries.length === 0, 'store listHistory empty after clear')
}

// --- Credential redaction: redactRequestAuth ---
{
  const redactRequestAuth = storeMod._internal.redactRequestAuth
  check(typeof redactRequestAuth === 'function', 'store exports redactRequestAuth')

  // Bearer token should be redacted
  const bearer = { method: 'GET', url: 'https://api.example.com', auth: { type: 'bearer', token: 'secret-token-123' } }
  const r1 = redactRequestAuth(bearer)
  check(r1.auth.type === 'bearer', 'redactRequestAuth preserves auth type (bearer)')
  check(r1.auth.token === '[REDACTED]', 'redactRequestAuth redacts bearer token')
  check(r1.method === 'GET', 'redactRequestAuth preserves method')
  check(r1.url === 'https://api.example.com', 'redactRequestAuth preserves url')
  check(bearer.auth.token === 'secret-token-123', 'redactRequestAuth does not mutate original')

  // Basic auth password should be redacted, username preserved
  const basic = { method: 'POST', url: 'https://api.example.com', auth: { type: 'basic', username: 'alice', password: 's3cret' } }
  const r2 = redactRequestAuth(basic)
  check(r2.auth.type === 'basic', 'redactRequestAuth preserves auth type (basic)')
  check(r2.auth.username === 'alice', 'redactRequestAuth preserves username')
  check(r2.auth.password === '[REDACTED]', 'redactRequestAuth redacts password')

  // API key value should be redacted, key name preserved
  const apikey = { method: 'GET', url: 'https://api.example.com', auth: { type: 'apikey', key: 'X-API-Key', value: 'my-api-key', addTo: 'header' } }
  const r3 = redactRequestAuth(apikey)
  check(r3.auth.type === 'apikey', 'redactRequestAuth preserves auth type (apikey)')
  check(r3.auth.key === 'X-API-Key', 'redactRequestAuth preserves key name')
  check(r3.auth.value === '[REDACTED]', 'redactRequestAuth redacts api key value')
  check(r3.auth.addTo === 'header', 'redactRequestAuth preserves addTo')

  // No auth — pass through
  const noAuth = { method: 'GET', url: 'https://example.com' }
  const r4 = redactRequestAuth(noAuth)
  check(r4.method === 'GET', 'redactRequestAuth no-auth preserves method')
  check(r4.auth === undefined, 'redactRequestAuth no-auth has no auth')

  // Null/undefined input
  check(redactRequestAuth(null) === null, 'redactRequestAuth(null) returns null')
  check(redactRequestAuth(undefined) === undefined, 'redactRequestAuth(undefined) returns undefined')
}

// --- Credential redaction: recordHistory redacts auth in persisted file ---
{
  const tmpdir = require('os').tmpdir()
  const authd = {
    request: {
      method: 'POST',
      url: 'https://api.example.com/data',
      headers: { 'Content-Type': 'application/json' },
      auth: { type: 'bearer', token: 'sk-live-abcdef123456' },
      body: '{"key":"value"}'
    },
    response: { status: 200 }
  }
  const record = storeMod.recordHistory(tmpdir, authd)
  check(record.ok === true, 'store recordHistory with auth ok')

  const read = storeMod.readHistoryEntry(tmpdir, record.value.id)
  check(read.ok === true, 'store readHistoryEntry with auth ok')
  check(read.value.request.auth.token === '[REDACTED]', 'recordHistory redacts bearer token on disk')
  check(read.value.request.method === 'POST', 'recordHistory preserves method')
  check(read.value.request.body === '{"key":"value"}', 'recordHistory preserves body')
  check(read.value.request.auth.type === 'bearer', 'recordHistory preserves auth type')

  // Cleanup
  storeMod.deleteHistoryEntry(tmpdir, record.value.id)
}

console.log(`\n${failures ? 'FAILURES: ' + failures : 'ALL TESTS PASSED'}`)
process.exit(failures ? 1 : 0)
