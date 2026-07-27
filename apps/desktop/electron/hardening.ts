import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_FETCH_TIMEOUT_MS = 15_000
const DATA_URL_READ_MAX_BYTES = 16 * 1024 * 1024
const TEXT_PREVIEW_SOURCE_MAX_BYTES = 64 * 1024 * 1024

const SAFE_ENV_SUFFIXES = new Set(['dist', 'example', 'sample', 'template'])
const SENSITIVE_EXTENSIONS = new Set(['.kdbx', '.p12', '.pem', '.pfx'])

function resolveTimeoutMs(timeoutMs, fallbackMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const fallback =
    Number.isFinite(fallbackMs) && Number(fallbackMs) > 0 ? Math.round(Number(fallbackMs)) : DEFAULT_FETCH_TIMEOUT_MS

  const parsed = Number(timeoutMs)

  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed)
  }

  return fallback
}

function encryptDesktopSecret(value, safeStorageApi) {
  const raw = String(value || '')

  if (!raw) {
    return null
  }

  let encryptionAvailable = false

  try {
    encryptionAvailable = Boolean(safeStorageApi?.isEncryptionAvailable?.())
  } catch {
    encryptionAvailable = false
  }

  if (!encryptionAvailable) {
    throw new Error(
      'Secure token storage is unavailable, so Hermes Desktop cannot save remote gateway tokens. ' +
        'Set HERMES_DESKTOP_REMOTE_URL and HERMES_DESKTOP_REMOTE_TOKEN in your environment, or enable OS keychain access and try again.'
    )
  }

  try {
    return {
      encoding: 'safeStorage',
      value: safeStorageApi.encryptString(raw).toString('base64')
    }
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` (${error.message})` : ''
    throw new Error(
      `Failed to encrypt the remote gateway token for secure storage${detail}. ` +
        'Set HERMES_DESKTOP_REMOTE_URL and HERMES_DESKTOP_REMOTE_TOKEN in your environment as a fallback.'
    )
  }
}

function sensitiveFileBlockReason(filePath) {
  const normalized = String(filePath || '')
    .replace(/\\/g, '/')
    .toLowerCase()

  const basename = path.basename(normalized)
  const ext = path.extname(basename)

  if (!basename) {
    return null
  }

  if (normalized.includes('/.ssh/')) {
    return 'SSH key/config files are blocked.'
  }

  if (normalized.includes('/.gnupg/')) {
    return 'GPG key material is blocked.'
  }

  if (normalized.endsWith('/.aws/credentials')) {
    return 'AWS credential files are blocked.'
  }

  if (basename === '.env') {
    return '.env files are blocked because they commonly contain secrets.'
  }

  if (basename.startsWith('.env.')) {
    const suffix = basename.slice('.env.'.length)

    if (!SAFE_ENV_SUFFIXES.has(suffix)) {
      return `${basename} is blocked because it appears to contain environment secrets.`
    }
  }

  if (/^id_(rsa|dsa|ecdsa|ed25519)(?:\..+)?$/.test(basename) && !basename.endsWith('.pub')) {
    return 'SSH private key files are blocked.'
  }

  if (SENSITIVE_EXTENSIONS.has(ext)) {
    return `${ext} key/certificate files are blocked.`
  }

  if (basename === '.npmrc' || basename === '.netrc' || basename === '.pypirc') {
    return `${basename} is blocked because it may include auth credentials.`
  }

  return null
}

function ipcPathError(code: any, message: string): Error & { code: any } {
  const error = new Error(message) as Error & { code: any }

  ;(error as any).code = code

  return error
}

function rejectUnsafePathSyntax(filePath, purpose = 'File read') {
  if (typeof filePath !== 'string') {
    throw ipcPathError('invalid-path', `${purpose} failed: file path is required.`)
  }

  const raw = filePath.trim()

  if (!raw) {
    throw ipcPathError('invalid-path', `${purpose} failed: file path is required.`)
  }

  if (raw.includes('\0')) {
    throw ipcPathError('invalid-path', `${purpose} failed: file path is invalid.`)
  }

  const normalized = raw.replace(/\\/g, '/').toLowerCase()

  if (
    normalized.startsWith('//?/') ||
    normalized.startsWith('//./') ||
    normalized.startsWith('globalroot/device/') ||
    normalized.includes('/globalroot/device/')
  ) {
    throw ipcPathError('device-path', `${purpose} blocked: Windows device paths are not allowed.`)
  }

  return raw
}

function resolveRequestedPathForIpc(filePath, options: { purpose?: string; baseDir?: fs.PathOrFileDescriptor } = {}) {
  const purpose = String(options.purpose || 'File read')
  let raw = rejectUnsafePathSyntax(filePath, purpose)

  // Gateway-reported cwds (config `terminal.cwd`, remote sessions) routinely
  // arrive as `~/...`. Node's fs has no shell — without expansion the path
  // resolves under process.cwd() and every read "ENOENT"s forever.
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    raw = path.join(os.homedir(), raw.slice(1))
  }

  if (/^file:/i.test(raw)) {
    let resolvedPath

    try {
      const parsed = new URL(raw)

      if (parsed.protocol !== 'file:') {
        throw new Error('not a file URL')
      }

      resolvedPath = fileURLToPath(parsed)
    } catch {
      throw ipcPathError('invalid-path', `${purpose} failed: file URL is invalid.`)
    }

    rejectUnsafePathSyntax(resolvedPath, purpose)

    return path.resolve(resolvedPath)
  }

  const baseInput = typeof options.baseDir === 'string' && options.baseDir.trim() ? options.baseDir : process.cwd()
  const safeBaseInput = rejectUnsafePathSyntax(baseInput, purpose)
  const resolvedBase = path.resolve(safeBaseInput)
  rejectUnsafePathSyntax(resolvedBase, purpose)
  const resolvedPath = path.resolve(resolvedBase, raw)
  rejectUnsafePathSyntax(resolvedPath, purpose)

  return resolvedPath
}

async function statForIpc(fsImpl: { promises: { stat: typeof fs.promises.stat } }, resolvedPath, purpose, typeLabel) {
  try {
    return await fsImpl.promises.stat(resolvedPath)
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : ''

    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw ipcPathError(code || 'ENOENT', `${purpose} failed: ${typeLabel} does not exist.`)
    }

    throw ipcPathError(
      code || 'read-error',
      `${purpose} failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

async function realpathForIpc(fsImpl, resolvedPath, purpose) {
  if (typeof fsImpl.promises.realpath !== 'function') {
    return resolvedPath
  }

  try {
    const realPath = await fsImpl.promises.realpath(resolvedPath)
    rejectUnsafePathSyntax(realPath, purpose)

    return realPath
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : ''
    throw ipcPathError(
      code || 'read-error',
      `${purpose} failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function rejectSensitiveFilePath(filePath, purpose) {
  const blockReason = sensitiveFileBlockReason(filePath)

  if (blockReason) {
    throw ipcPathError('sensitive-file', `${purpose} blocked for sensitive file: ${blockReason}`)
  }
}

async function resolveDirectoryForIpc(
  dirPath,
  options: {
    purpose?: string
    baseDir?: fs.PathOrFileDescriptor
    fs?: { promises: { stat: typeof fs.promises.stat } }
  } = {}
) {
  const purpose = String(options.purpose || 'Directory read')
  const fsImpl = options.fs || fs
  const resolvedPath = resolveRequestedPathForIpc(dirPath, { baseDir: options.baseDir, purpose })
  const stat = await statForIpc(fsImpl, resolvedPath, purpose, 'directory')

  if (!stat.isDirectory()) {
    throw ipcPathError('ENOTDIR', `${purpose} failed: path is not a directory.`)
  }

  const realPath = await realpathForIpc(fsImpl, resolvedPath, purpose)

  return { realPath, resolvedPath, stat }
}

async function resolveReadableFileForIpc(
  filePath,
  options: {
    purpose?: string
    baseDir?: fs.PathOrFileDescriptor
    fs?: typeof fs
    blockSensitive?: boolean
    maxBytes?: number
  } = {}
) {
  const purpose = String(options.purpose || 'File read')
  const fsImpl = options.fs || fs
  const resolvedPath = resolveRequestedPathForIpc(filePath, { baseDir: options.baseDir, purpose })

  if (options.blockSensitive !== false) {
    rejectSensitiveFilePath(resolvedPath, purpose)
  }

  const stat = await statForIpc(fsImpl, resolvedPath, purpose, 'file')

  if (stat.isDirectory()) {
    throw ipcPathError('EISDIR', `${purpose} failed: path points to a directory.`)
  }

  if (!stat.isFile()) {
    throw ipcPathError('EINVAL', `${purpose} failed: only regular files can be read.`)
  }

  const realPath = await realpathForIpc(fsImpl, resolvedPath, purpose)

  if (options.blockSensitive !== false) {
    rejectSensitiveFilePath(realPath, purpose)
  }

  const maxBytes = Number.isFinite(options.maxBytes) && Number(options.maxBytes) > 0 ? Number(options.maxBytes) : null

  if (maxBytes && stat.size > maxBytes) {
    throw ipcPathError('EFBIG', `${purpose} failed: file is too large (${stat.size} bytes; limit ${maxBytes} bytes).`)
  }

  try {
    await fsImpl.promises.access(resolvedPath, fs.constants.R_OK)
  } catch {
    throw ipcPathError('EACCES', `${purpose} failed: file is not readable.`)
  }

  return { realPath, resolvedPath, stat }
}

/**
 * Resolve a path for IPC write/create of a regular text file.
 * Parent must exist; sensitive basenames/extensions are blocked on both the
 * requested path and the parent realpath (parity with read hardening).
 */
async function resolveWritableFileForIpc(
  filePath,
  options: {
    purpose?: string
    baseDir?: fs.PathOrFileDescriptor
    fs?: typeof fs
    maxBytes?: number
    contentLength?: number
  } = {}
) {
  const purpose = String(options.purpose || 'File write')
  const fsImpl = options.fs || fs
  const resolvedPath = resolveRequestedPathForIpc(filePath, { baseDir: options.baseDir, purpose })
  rejectSensitiveFilePath(resolvedPath, purpose)

  const parent = path.dirname(resolvedPath)
  rejectSensitiveFilePath(parent, purpose)

  const parentStat = await statForIpc(fsImpl, parent, purpose, 'directory')

  if (!parentStat.isDirectory()) {
    throw ipcPathError('ENOTDIR', `${purpose} failed: parent path is not a directory.`)
  }

  const parentReal = await realpathForIpc(fsImpl, parent, purpose)
  rejectSensitiveFilePath(parentReal, purpose)

  // If the target already exists, require it to be a regular file and block sensitive realpaths.
  try {
    const existing = await fsImpl.promises.stat(resolvedPath)

    if (existing.isDirectory()) {
      throw ipcPathError('EISDIR', `${purpose} failed: path points to a directory.`)
    }

    if (!existing.isFile()) {
      throw ipcPathError('EINVAL', `${purpose} failed: only regular files can be written.`)
    }

    const realPath = await realpathForIpc(fsImpl, resolvedPath, purpose)
    rejectSensitiveFilePath(realPath, purpose)
  } catch (error) {
    if (error && typeof error === 'object' && (error as any).code && (error as any).code !== 'ENOENT') {
      if ((error as any).code === 'EISDIR' || (error as any).code === 'EINVAL' || (error as any).code === 'sensitive-file') {
        throw error
      }
    }

    if (!(error && typeof error === 'object' && (error as any).code === 'ENOENT')) {
      // Fall through: ENOENT is fine (create new file). Other unknown errors rethrow if already ipc errors.
      if (error instanceof Error && (error as any).code) {
        throw error
      }
    }
  }

  const contentLength =
    Number.isFinite(options.contentLength) && Number(options.contentLength) >= 0
      ? Number(options.contentLength)
      : null

  const maxBytes =
    Number.isFinite(options.maxBytes) && Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 1_000_000

  if (contentLength !== null && contentLength > maxBytes) {
    throw ipcPathError('EFBIG', `${purpose} failed: content is too large (${contentLength} bytes; limit ${maxBytes} bytes).`)
  }

  return { resolvedPath, parentReal }
}

/**
 * Resolve an existing path for trash/reveal/rename source with sensitive-file blocks.
 * Allows files and directories (trash is not file-only).
 */
async function resolveExistingPathForIpc(
  targetPath,
  options: {
    purpose?: string
    baseDir?: fs.PathOrFileDescriptor
    fs?: typeof fs
    blockSensitive?: boolean
  } = {}
) {
  const purpose = String(options.purpose || 'Path access')
  const fsImpl = options.fs || fs
  const resolvedPath = resolveRequestedPathForIpc(targetPath, { baseDir: options.baseDir, purpose })

  if (options.blockSensitive !== false) {
    rejectSensitiveFilePath(resolvedPath, purpose)
  }

  const stat = await statForIpc(fsImpl, resolvedPath, purpose, 'path')
  const realPath = await realpathForIpc(fsImpl, resolvedPath, purpose)

  if (options.blockSensitive !== false) {
    rejectSensitiveFilePath(realPath, purpose)
  }

  return { realPath, resolvedPath, stat }
}

/** Pure owner check for terminal PTY sessions (H2). */
function assertTerminalOwner(sessionInfo: { webContentsId?: number } | null | undefined, senderId: number) {
  if (!sessionInfo || typeof sessionInfo !== 'object') {
    return false
  }

  return Number(sessionInfo.webContentsId) === Number(senderId)
}

function isPrivateOrReservedIp(address: string) {
  const raw = String(address || '').trim().toLowerCase()

  if (!raw) {
    return true
  }

  // IPv4-mapped IPv6
  const v4Mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  const ip = v4Mapped ? v4Mapped[1] : raw

  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') {
    return true
  }

  // IPv6 unique-local / link-local
  if (ip.includes(':')) {
    if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) {
      return true
    }

    // Treat unspecified as unsafe
    if (ip === '::' || ip === '0:0:0:0:0:0:0:0') {
      return true
    }

    return false
  }

  const parts = ip.split('.').map(p => Number(p))

  // Not an IPv4 literal — leave hostnames to DNS resolution.
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false
  }

  const [a, b] = parts

  // loopback, RFC1918, link-local (incl. cloud metadata 169.254.169.254), CGNAT, broadcast-ish
  if (a === 0 || a === 10 || a === 127 || a === 255) {
    return true
  }

  if (a === 169 && b === 254) {
    return true
  }

  if (a === 172 && b >= 16 && b <= 31) {
    return true
  }

  if (a === 192 && b === 168) {
    return true
  }

  if (a === 100 && b >= 64 && b <= 127) {
    // CGNAT / carrier-grade NAT
    return true
  }

  return false
}

/**
 * SSRF guard for user-influenced main-process fetches (link title, images, etc.).
 * https-only by default; optional http for loopback when allowLoopbackHttp is set.
 * Resolves DNS and rejects any private/reserved address (including metadata IPs).
 */
async function assertSafeOutboundUrl(
  rawUrl: string,
  options: {
    purpose?: string
    allowHttp?: boolean
    allowLoopbackHttp?: boolean
    lookup?: (hostname: string, opts: { all: true }) => Promise<Array<{ address: string; family: number }>>
  } = {}
) {
  const purpose = String(options.purpose || 'Outbound fetch')
  const raw = String(rawUrl || '').trim()

  if (!raw) {
    throw ipcPathError('invalid-url', `${purpose} failed: URL is required.`)
  }

  let parsed: URL

  try {
    parsed = new URL(raw)
  } catch {
    throw ipcPathError('invalid-url', `${purpose} failed: URL is invalid.`)
  }

  if (parsed.protocol === 'https:') {
    // ok
  } else if (parsed.protocol === 'http:') {
    if (!options.allowHttp && !options.allowLoopbackHttp) {
      throw ipcPathError('insecure-url', `${purpose} blocked: only https URLs are allowed.`)
    }
  } else {
    throw ipcPathError('invalid-url', `${purpose} blocked: unsupported protocol ${parsed.protocol}`)
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')

  if (!hostname) {
    throw ipcPathError('invalid-url', `${purpose} failed: hostname is required.`)
  }

  // Block obvious local names before DNS (TOCTOU still exists for rebinding — pin later if needed)
  const hostLower = hostname.toLowerCase()

  const looksLocal =
    hostLower === 'localhost' ||
    hostLower.endsWith('.localhost') ||
    hostLower === '0.0.0.0' ||
    hostLower === '::1' ||
    isPrivateOrReservedIp(hostLower)

  if (looksLocal && !options.allowLoopbackHttp) {
    throw ipcPathError('private-url', `${purpose} blocked: private/local hosts are not allowed.`)
  }

  if (parsed.protocol === 'http:' && looksLocal && options.allowLoopbackHttp) {
    // allowed for local gateway diagnostics only
  } else if (parsed.protocol === 'http:' && !options.allowHttp) {
    throw ipcPathError('insecure-url', `${purpose} blocked: only https URLs are allowed.`)
  }

  let lookupFn = options.lookup

  if (!lookupFn) {
    const dns = await import('node:dns/promises')
    lookupFn = (h, o) => dns.lookup(h, o)
  }

  let addrs: Array<{ address: string; family: number }>

  try {
    addrs = await lookupFn(hostname, { all: true })
  } catch {
    throw ipcPathError('dns-error', `${purpose} failed: could not resolve host.`)
  }

  if (!addrs || addrs.length === 0) {
    throw ipcPathError('dns-error', `${purpose} failed: host resolved to no addresses.`)
  }

  for (const entry of addrs) {
    if (isPrivateOrReservedIp(entry.address)) {
      if (options.allowLoopbackHttp && isPrivateOrReservedIp(entry.address)) {
        // Still allow only if the *hostname* was explicitly local-looking; otherwise block rebinding to private IP.
        if (!looksLocal) {
          throw ipcPathError(
            'private-url',
            `${purpose} blocked: host resolved to private/reserved address ${entry.address}.`
          )
        }

        continue
      }

      throw ipcPathError(
        'private-url',
        `${purpose} blocked: host resolved to private/reserved address ${entry.address}.`
      )
    }
  }

  return parsed
}

/**
 * Content-Security-Policy for the desktop renderer.
 * Allows loopback API/WS for the local gateway and optional Vite dev server.
 */
function buildDesktopContentSecurityPolicy(options: { devServer?: string | null } = {}) {
  const connect = new Set(["'self'", 'http://127.0.0.1:*', 'http://localhost:*', 'ws://127.0.0.1:*', 'ws://localhost:*', 'https:', 'wss:'])

  if (options.devServer) {
    try {
      const u = new URL(options.devServer)
      connect.add(`${u.protocol}//${u.host}`)
      connect.add(`${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}`)
    } catch {
      // ignore bad dev server URL
    }
  }

  // Electron CSP. script-src keeps 'unsafe-eval' because Canvas/Kanban load their
  // dashboard-plugin bundles via new Function(); that eval is gated to loopback by
  // assertCanExecuteGatewayPluginScript() (see gateway-plugin-security.ts), which is
  // the compensating control against remote code injection. style-src allows the
  // loopback gateway origin so plugin stylesheets (served on an ephemeral 127.0.0.1
  // port) load; img/frame-src already permit loopback.
  return [
    `default-src 'self'`,
    `script-src 'self' 'unsafe-eval'`,
    `style-src 'self' 'unsafe-inline' http://127.0.0.1:* http://localhost:*`,
    `img-src 'self' data: blob: https: http://127.0.0.1:* http://localhost:*`,
    `font-src 'self' data:`,
    `connect-src ${[...connect].join(' ')}`,
    // Voice playback uses HTMLAudioElement with TTS data: URLs and the
    // hermes-media://stream custom protocol for cached mp3 files. Without
    // those schemes, Edge/xAI TTS synthesizes fine but the renderer CSP
    // blocks every play attempt (silent "can't hear you" in Desktop).
    `media-src 'self' data: blob: https: hermes-media:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-src 'self' https: http://127.0.0.1:* http://localhost:*`,
    `worker-src 'self' blob:`,
    `form-action 'self'`
  ].join('; ')
}

/** Packaged builds hide DevTools unless explicitly enabled for diagnostics. */
function isPackagedDevToolsAllowed(env: NodeJS.ProcessEnv = process.env, isPackaged = false) {
  if (!isPackaged) {
    return true
  }

  const flag = String(env.HERMES_DESKTOP_DEVTOOLS || env.HERMES_DESKTOP_ALLOW_DEVTOOLS || '')
    .trim()
    .toLowerCase()

  return flag === '1' || flag === 'true' || flag === 'yes'
}

/**
 * Whether it is safe to execute gateway-served dashboard plugin JS via new Function.
 * Loopback-only by default — remote gateways must not inject code into the privileged renderer.
 */
function canExecuteGatewayPluginScript(baseUrl: string) {
  // Empty/nullish baseUrl is the default local backend (loopback 127.0.0.1),
  // which must remain executable so local dashboard plugins load.
  if (!baseUrl) {return true}

  try {
    const u = new URL(String(baseUrl))
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()

    return (
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === '::1' ||
      host.endsWith('.localhost')
    )
  } catch {
    return false
  }
}

export {
  assertSafeOutboundUrl,
  assertTerminalOwner,
  buildDesktopContentSecurityPolicy,
  canExecuteGatewayPluginScript,
  DATA_URL_READ_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  encryptDesktopSecret,
  isPackagedDevToolsAllowed,
  isPrivateOrReservedIp,
  rejectUnsafePathSyntax,
  resolveDirectoryForIpc,
  resolveExistingPathForIpc,
  resolveReadableFileForIpc,
  resolveRequestedPathForIpc,
  resolveTimeoutMs,
  resolveWritableFileForIpc,
  sensitiveFileBlockReason,
  TEXT_PREVIEW_SOURCE_MAX_BYTES
}
