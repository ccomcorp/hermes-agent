'use strict'

// Hermes Workbench -- Write Workspace export (Slice L)
//
// Converts an already-rendered standalone HTML document (built by the
// renderer from a write project's markdown, reusing the same renderer
// CompactMarkdown uses -- see apps/desktop/src/app/workbench/write-export.tsx)
// into HTML/PDF/DOCX/PNG and writes it ONLY to a path the user picks via the
// OS save dialog. This module never constructs the target path itself and
// never writes to `.hermes/workbench/` or any other fixed location -- the
// dialog result is the only path ever passed to a write call.
//
// Research note (2026-07-08): per the standing "check Kun" instruction, Kun's
// own `src/main/services/write-export-service.ts` does exactly this shape --
// `dialog.showSaveDialog` for the target path, `webContents.printToPDF` on a
// hidden BrowserWindow for PDF (no external PDF library), the same
// hidden-window + `capturePage().toPNG()` trick for PNG, and the
// `html-to-docx` package (confirmed dependency, `^1.8.0`) for DOCX. This
// module mirrors that shape, adapted to this fork's CJS main process (no
// `createRequire` workaround needed -- `.cjs` files are always CommonJS here
// regardless of the package's `"type": "module"`).

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { BrowserWindow, dialog } = require('electron')

const EXPORT_WINDOW_WAIT_MS = 120
const EXPORT_PNG_RESIZE_WAIT_MS = 50
const MAX_BASE_NAME_LENGTH = 120

// Characters forbidden in Windows filenames (also unsafe/awkward on other
// platforms), replaced so a suggested export file name is portable.
const UNSAFE_FILENAME_CHAR_PATTERN = '[<>:"/\\\\|?*]'
const UNSAFE_FILENAME_CHARS = new RegExp(UNSAFE_FILENAME_CHAR_PATTERN, 'g')

function sanitizeExportBaseName(title) {
  const trimmed = typeof title === 'string' ? title.trim() : ''
  const cleaned = trimmed
    .replace(UNSAFE_FILENAME_CHARS, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, MAX_BASE_NAME_LENGTH)
    .trim()

  return cleaned || 'export'
}

function exportExtensionForFormat(format) {
  if (format === 'pdf') return '.pdf'
  if (format === 'docx') return '.docx'
  if (format === 'png') return '.png'
  return '.html'
}

function exportDialogFilterForFormat(format) {
  if (format === 'pdf') return { name: 'PDF', extensions: ['pdf'] }
  if (format === 'docx') return { name: 'Word Document', extensions: ['docx'] }
  if (format === 'png') return { name: 'PNG Image', extensions: ['png'] }
  return { name: 'HTML', extensions: ['html'] }
}

function ensureExtension(filePath, ext) {
  return filePath.toLowerCase().endsWith(ext.toLowerCase()) ? filePath : `${filePath}${ext}`
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Normalizes whatever `html-to-docx` hands back (Buffer / ArrayBuffer /
// Uint8Array / Blob, depending on runtime) into a Node Buffer we can write.
async function bufferFromDocxResult(result) {
  if (Buffer.isBuffer(result)) {
    return result
  }
  if (ArrayBuffer.isView(result)) {
    return Buffer.from(result.buffer, result.byteOffset, result.byteLength)
  }
  if (result instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(result))
  }
  if (typeof Blob !== 'undefined' && result instanceof Blob) {
    return Buffer.from(await result.arrayBuffer())
  }
  throw new TypeError('Unsupported DOCX export result')
}

// Renders a standalone HTML document to a PDF or PNG buffer via a hidden,
// hardened BrowserWindow (contextIsolation on, nodeIntegration off, sandboxed
// -- the exported document is untrusted-ish user content, never given any
// Electron/Node capability). No external PDF/screenshot library: PDF uses
// Electron's built-in `webContents.printToPDF`; PNG uses `capturePage`.
async function renderHtmlToBuffer(html, format) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hermes-workbench-export-'))
  const tempHtmlPath = path.join(tempDir, 'document.html')
  await fs.promises.writeFile(tempHtmlPath, html, 'utf8')

  const hiddenWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true
    }
  })

  try {
    await hiddenWindow.loadURL(pathToFileURL(tempHtmlPath).href)
    // Give web fonts/images a beat to finish loading before capturing --
    // mirrors Kun's own export wait (fonts.ready + image load/error settle).
    await hiddenWindow.webContents.executeJavaScript(`
      Promise.all([
        document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve(),
        Promise.all(
          Array.from(document.images).map((image) => {
            if (image.complete) return Promise.resolve()
            return new Promise((resolve) => {
              const done = () => resolve(undefined)
              image.addEventListener('load', done, { once: true })
              image.addEventListener('error', done, { once: true })
            })
          })
        )
      ]).then(() => undefined)
    `)
    await delay(EXPORT_WINDOW_WAIT_MS)

    if (format === 'png') {
      const size = await hiddenWindow.webContents.executeJavaScript(`
        ({
          width: Math.min(1600, Math.max(800, document.documentElement.scrollWidth)),
          height: Math.min(16384, Math.max(600, document.documentElement.scrollHeight))
        })
      `)
      hiddenWindow.setContentSize(Math.round(size.width), Math.round(size.height))
      await delay(EXPORT_PNG_RESIZE_WAIT_MS)
      const image = await hiddenWindow.webContents.capturePage()
      return image.toPNG()
    }

    const pdf = await hiddenWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true
    })
    return Buffer.from(pdf)
  } finally {
    if (!hiddenWindow.isDestroyed()) hiddenWindow.destroy()
    await fs.promises.rm(tempDir, { recursive: true, force: true })
  }
}

async function writeExportFile(targetPath, format, html, title) {
  if (format === 'html') {
    await fs.promises.writeFile(targetPath, html, 'utf8')
    return
  }

  if (format === 'docx') {
    // Required lazily so a missing/broken optional dependency can't break
    // every other Workbench IPC handler at module load time.
    const htmlToDocx = require('html-to-docx')
    const docx = await htmlToDocx(html, null, {
      title,
      creator: 'Hermes',
      keywords: ['workbench', 'write', 'export'],
      description: `Exported from Hermes Write Workspace: ${title}`
    })
    await fs.promises.writeFile(targetPath, await bufferFromDocxResult(docx))
    return
  }

  // pdf / png
  await fs.promises.writeFile(targetPath, await renderHtmlToBuffer(html, format))
}

// Shows the OS save dialog and, unless canceled, writes the export. The
// target path is ALWAYS the dialog's result -- nothing here builds a path
// from workspaceRoot/writeProjectId/title beyond the suggested file NAME.
async function exportWriteDocument(payload, options = {}) {
  const { format, html, title } = payload
  const parentWindow = options.parentWindow || null

  const ext = exportExtensionForFormat(format)
  const defaultPath = `${sanitizeExportBaseName(title)}${ext}`
  const dialogOptions = {
    title: 'Export document',
    defaultPath,
    filters: [exportDialogFilterForFormat(format)]
  }

  const result = parentWindow
    ? await dialog.showSaveDialog(parentWindow, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions)

  if (result.canceled || !result.filePath) {
    return { ok: true, value: { canceled: true } }
  }

  const targetPath = ensureExtension(result.filePath, ext)

  await writeExportFile(targetPath, format, html, sanitizeExportBaseName(title))

  return {
    ok: true,
    value: {
      canceled: false,
      path: targetPath,
      format,
      exportedAt: new Date().toISOString()
    }
  }
}

module.exports = {
  exportWriteDocument,
  // Exposed for testing -- pure helpers with no Electron dependency.
  _internal: {
    sanitizeExportBaseName,
    exportExtensionForFormat,
    exportDialogFilterForFormat,
    ensureExtension,
    bufferFromDocxResult
  }
}
