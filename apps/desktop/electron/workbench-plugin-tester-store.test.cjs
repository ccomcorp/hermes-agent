'use strict'

// Hermes Workbench — Plugin Tester Store unit tests
// Run with: node --test electron/workbench-plugin-tester-store.test.cjs

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const store = require('./workbench-plugin-tester-store.cjs')
const { normalizeRelativePath, isSafeRelativePath, resolveWorkspacePath } = store._internal

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

test('isSafeRelativePath rejects traversal', () => {
  assert.strictEqual(isSafeRelativePath('../etc/passwd'), false)
  assert.strictEqual(isSafeRelativePath('a/../../b'), false)
  assert.strictEqual(isSafeRelativePath('C:/test'), false)
  assert.strictEqual(isSafeRelativePath('safe/path'), true)
  assert.strictEqual(isSafeRelativePath('.hermes/workbench/plugin-tester/collections/coll-abc.json'), true)
})

test('isSafeRelativePath rejects POSIX-absolute paths', () => {
  assert.strictEqual(isSafeRelativePath('/etc/passwd'), false)
  assert.strictEqual(isSafeRelativePath('/absolute/but/nested'), false)
})

test('resolveWorkspacePath throws on escape attempt', () => {
  const workspaceRoot = path.join(os.tmpdir(), 'test-workspace')

  assert.throws(
    () => resolveWorkspacePath(workspaceRoot, '../../escape.json'),
    /Path traversal rejected/
  )
})

test('resolveWorkspacePath resolves safe relative paths correctly', () => {
  const workspaceRoot = path.join(os.tmpdir(), 'test-workspace')

  const result = resolveWorkspacePath(workspaceRoot, '.hermes/workbench/plugin-tester/manifest.json')
  assert.strictEqual(result, path.join(workspaceRoot, '.hermes/workbench/plugin-tester/manifest.json'))
})

test('resolveWorkspacePath resolves constant paths', () => {
  // Integration smoke: all store constants must pass the safety check.
  const workspaceRoot = path.join(os.tmpdir(), 'test-workspace')

  // These are the constants the store internally uses with resolveWorkspacePath.
  // They are always generated locally, so they must never trigger a rejection.
  const safePaths = [
    '.hermes/workbench/plugin-tester/manifest.json',
    '.hermes/workbench/plugin-tester/collections/coll-abc123.json',
    '.hermes/workbench/plugin-tester/history/hst-abc123.json',
    '.hermes/workbench/plugin-tester/environments/env-abc123.json'
  ]

  for (const p of safePaths) {
    const result = resolveWorkspacePath(workspaceRoot, p)
    assert.ok(result.startsWith(path.resolve(workspaceRoot)),
      `resolveWorkspacePath("${p}") must stay inside workspace root`)
    // Safe path check — normalize separators to handle OS differences
    const normalized = result.replace(/\\/g, '/')
    assert.ok(normalized.includes('.hermes/workbench/plugin-tester'),
      `resolveWorkspacePath("${p}") must be under .hermes/workbench/plugin-tester/`)
  }
})

test('resolveWorkspacePath rejects empty/whitespace paths', () => {
  const workspaceRoot = path.join(os.tmpdir(), 'test-workspace')

  assert.throws(() => resolveWorkspacePath(workspaceRoot, ''), /Path traversal rejected/)
  assert.throws(() => resolveWorkspacePath(workspaceRoot, '   '), /Path traversal rejected/)
})
