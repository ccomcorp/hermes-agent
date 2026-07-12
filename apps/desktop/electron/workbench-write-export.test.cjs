'use strict'

// Unit tests for the pure (non-Electron) helpers in workbench-write-export.cjs.
//
// `exportWriteDocument` itself (dialog + hidden BrowserWindow + html-to-docx)
// needs a real Electron runtime and is exercised via manual/app-level
// verification, matching how dialog-dependent code elsewhere in this fork is
// tested. These tests cover the deterministic helpers: filename sanitizing,
// extension/filter selection, and the DOCX result buffer normalizer.

const { test } = require('node:test')
const assert = require('node:assert')

const { _internal } = require('./workbench-write-export.cjs')
const {
  sanitizeExportBaseName,
  exportExtensionForFormat,
  exportDialogFilterForFormat,
  ensureExtension,
  bufferFromDocxResult
} = _internal

test('sanitizeExportBaseName strips Windows-forbidden characters', () => {
  const result = sanitizeExportBaseName('My: Report / Test *')
  assert.ok(!/[<>:"/\\|?*]/.test(result), `expected no forbidden chars in "${result}"`)
})

test('sanitizeExportBaseName falls back to "export" for empty/whitespace titles', () => {
  assert.strictEqual(sanitizeExportBaseName(''), 'export')
  assert.strictEqual(sanitizeExportBaseName('   '), 'export')
  assert.strictEqual(sanitizeExportBaseName(undefined), 'export')
})

test('sanitizeExportBaseName caps length', () => {
  const result = sanitizeExportBaseName('a'.repeat(500))
  assert.ok(result.length <= 120)
})

test('sanitizeExportBaseName trims leading/trailing dots and whitespace', () => {
  const result = sanitizeExportBaseName('  ..My Doc..  ')
  assert.strictEqual(result.startsWith('.'), false)
  assert.strictEqual(result.endsWith('.'), false)
})

test('exportExtensionForFormat maps every declared format', () => {
  assert.strictEqual(exportExtensionForFormat('html'), '.html')
  assert.strictEqual(exportExtensionForFormat('pdf'), '.pdf')
  assert.strictEqual(exportExtensionForFormat('docx'), '.docx')
  assert.strictEqual(exportExtensionForFormat('png'), '.png')
})

test('exportExtensionForFormat defaults unknown formats to .html', () => {
  assert.strictEqual(exportExtensionForFormat('bogus'), '.html')
})

test('exportDialogFilterForFormat returns a matching filter per format', () => {
  assert.deepStrictEqual(exportDialogFilterForFormat('pdf'), { name: 'PDF', extensions: ['pdf'] })
  assert.deepStrictEqual(exportDialogFilterForFormat('docx'), { name: 'Word Document', extensions: ['docx'] })
  assert.deepStrictEqual(exportDialogFilterForFormat('png'), { name: 'PNG Image', extensions: ['png'] })
  assert.deepStrictEqual(exportDialogFilterForFormat('html'), { name: 'HTML', extensions: ['html'] })
})

test('ensureExtension appends the extension when missing', () => {
  assert.strictEqual(ensureExtension('C:/foo/bar', '.pdf'), 'C:/foo/bar.pdf')
})

test('ensureExtension leaves a matching extension (case-insensitive) alone', () => {
  assert.strictEqual(ensureExtension('C:/foo/bar.PDF', '.pdf'), 'C:/foo/bar.PDF')
  assert.strictEqual(ensureExtension('C:/foo/bar.pdf', '.pdf'), 'C:/foo/bar.pdf')
})

test('bufferFromDocxResult normalizes a Buffer as-is', async () => {
  const input = Buffer.from('hello')
  const result = await bufferFromDocxResult(input)
  assert.ok(Buffer.isBuffer(result))
  assert.strictEqual(result.toString(), 'hello')
})

test('bufferFromDocxResult normalizes an ArrayBuffer', async () => {
  const arrayBuffer = new TextEncoder().encode('hello').buffer
  const result = await bufferFromDocxResult(arrayBuffer)
  assert.ok(Buffer.isBuffer(result))
  assert.strictEqual(result.toString(), 'hello')
})

test('bufferFromDocxResult normalizes a Uint8Array view', async () => {
  const view = new TextEncoder().encode('hello')
  const result = await bufferFromDocxResult(view)
  assert.ok(Buffer.isBuffer(result))
  assert.strictEqual(result.toString(), 'hello')
})

test('bufferFromDocxResult normalizes a Blob', async () => {
  const blob = new Blob(['hello'])
  const result = await bufferFromDocxResult(blob)
  assert.ok(Buffer.isBuffer(result))
  assert.strictEqual(result.toString(), 'hello')
})

test('bufferFromDocxResult rejects unsupported types', async () => {
  await assert.rejects(() => bufferFromDocxResult(12345), TypeError)
})
