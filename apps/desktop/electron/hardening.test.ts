import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { test } from 'vitest'

import {
  DEFAULT_FETCH_TIMEOUT_MS,
  assertSafeOutboundUrl,
  assertTerminalOwner,
  buildDesktopContentSecurityPolicy,
  canExecuteGatewayPluginScript,
  encryptDesktopSecret,
  isPackagedDevToolsAllowed,
  isPrivateOrReservedIp,
  resolveDirectoryForIpc,
  resolveExistingPathForIpc,
  resolveReadableFileForIpc,
  resolveRequestedPathForIpc,
  resolveTimeoutMs,
  resolveWritableFileForIpc,
  sensitiveFileBlockReason
} from './hardening'

async function rejectsWithCode(promise, code: string) {
  await assert.rejects(promise, (error: any) => {
    assert.equal(error?.code, code)

    return true
  })
}

test('resolveTimeoutMs falls back to defaults and accepts overrides', () => {
  assert.equal(resolveTimeoutMs(undefined), DEFAULT_FETCH_TIMEOUT_MS)
  assert.equal(resolveTimeoutMs(0), DEFAULT_FETCH_TIMEOUT_MS)
  assert.equal(resolveTimeoutMs(-25), DEFAULT_FETCH_TIMEOUT_MS)
  assert.equal(resolveTimeoutMs('2750'), 2750)
})

test('encryptDesktopSecret requires available secure storage', () => {
  assert.equal(
    encryptDesktopSecret('', { isEncryptionAvailable: () => true, encryptString: () => Buffer.alloc(0) }),
    null
  )

  assert.throws(
    () => encryptDesktopSecret('token', { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0) }),
    /Secure token storage is unavailable/
  )
})

test('encryptDesktopSecret stores safeStorage base64 payload', () => {
  const secret = encryptDesktopSecret('token-123', {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`enc:${value}`, 'utf8')
  })

  assert.deepEqual(secret, {
    encoding: 'safeStorage',
    value: Buffer.from('enc:token-123', 'utf8').toString('base64')
  })
})

test('sensitiveFileBlockReason blocks obvious secret file patterns', () => {
  assert.match(String(sensitiveFileBlockReason('/tmp/.env')), /\.env/)
  assert.equal(sensitiveFileBlockReason('/tmp/.env.example'), null)
  assert.match(String(sensitiveFileBlockReason('/Users/me/.ssh/id_ed25519')), /SSH/)
  assert.match(String(sensitiveFileBlockReason('/tmp/server-cert.pem')), /\.pem/)
})

test('path helpers reject blank non-string NUL and Windows device syntax', async () => {
  await rejectsWithCode(resolveReadableFileForIpc('', { purpose: 'File preview' }), 'invalid-path')
  await rejectsWithCode(resolveReadableFileForIpc('   ', { purpose: 'File preview' }), 'invalid-path')
  await rejectsWithCode(resolveReadableFileForIpc(null, { purpose: 'File preview' }), 'invalid-path')
  await rejectsWithCode(resolveReadableFileForIpc(`safe${String.fromCharCode(0)}name.txt`), 'invalid-path')

  const devicePaths = [
    '\\\\?\\C:\\secret.txt',
    '\\\\.\\C:\\secret.txt',
    '\\\\?\\UNC\\server\\share\\secret.txt',
    'GLOBALROOT/Device/HarddiskVolumeShadowCopy1/secret.txt'
  ]

  for (const devicePath of devicePaths) {
    assert.throws(
      () => resolveRequestedPathForIpc(devicePath, { purpose: 'File preview' }),
      (error: any) => {
        assert.equal(error?.code, 'device-path')

        return true
      }
    )
    await rejectsWithCode(resolveReadableFileForIpc(devicePath, { purpose: 'File preview' }), 'device-path')
  }

  assert.throws(
    () => resolveRequestedPathForIpc('file:///%E0%A4%A', { purpose: 'File preview' }),
    (error: any) => {
      assert.equal(error?.code, 'invalid-path')

      return true
    }
  )
  await rejectsWithCode(resolveReadableFileForIpc('file:///%E0%A4%A', { purpose: 'File preview' }), 'invalid-path')
})

test('resolveRequestedPathForIpc resolves relative paths from the trimmed base directory', () => {
  const baseDir = path.join(os.tmpdir(), 'hermes-desktop-base')

  assert.equal(
    resolveRequestedPathForIpc('notes.txt', {
      baseDir: `  ${baseDir}  `,
      purpose: 'File preview'
    }),
    path.resolve(baseDir, 'notes.txt')
  )
})

test('resolveRequestedPathForIpc expands ~ to the home directory', () => {
  assert.equal(resolveRequestedPathForIpc('~', { purpose: 'Directory read' }), path.resolve(os.homedir()))
  assert.equal(
    resolveRequestedPathForIpc('~/www/project', { purpose: 'Directory read' }),
    path.resolve(os.homedir(), 'www/project')
  )
  // `~user` shorthand is NOT expanded — only the caller's own home.
  assert.equal(
    resolveRequestedPathForIpc('~other/secret', { baseDir: os.tmpdir(), purpose: 'Directory read' }),
    path.resolve(os.tmpdir(), '~other/secret')
  )
})

test('resolveReadableFileForIpc validates existence type size and sensitivity', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-desktop-hardening-'))

  try {
    const textPath = path.join(tempDir, 'notes.txt')
    fs.writeFileSync(textPath, 'hello world', 'utf8')

    const fromRelative = await resolveReadableFileForIpc('notes.txt', {
      baseDir: tempDir,
      maxBytes: 256,
      purpose: 'File preview'
    })

    assert.equal(fromRelative.resolvedPath, textPath)
    assert.equal(fromRelative.stat.size, 11)

    const fromFileUrl = await resolveReadableFileForIpc(pathToFileURL(textPath).toString(), {
      purpose: 'File preview'
    })

    assert.equal(fromFileUrl.resolvedPath, textPath)

    const spacedPath = path.join(tempDir, 'notes with spaces.txt')
    fs.writeFileSync(spacedPath, 'space ok', 'utf8')

    const fromSpacedFileUrl = await resolveReadableFileForIpc(pathToFileURL(spacedPath).toString(), {
      purpose: 'File preview'
    })

    assert.equal(fromSpacedFileUrl.resolvedPath, spacedPath)

    await assert.rejects(
      resolveReadableFileForIpc('missing.txt', {
        baseDir: tempDir,
        purpose: 'Text preview'
      }),
      /file does not exist/
    )

    const nestedDir = path.join(tempDir, 'directory')
    fs.mkdirSync(nestedDir)
    await assert.rejects(
      resolveReadableFileForIpc(nestedDir, {
        purpose: 'Text preview'
      }),
      /path points to a directory/
    )

    const largePath = path.join(tempDir, 'large.txt')
    fs.writeFileSync(largePath, 'x'.repeat(40), 'utf8')
    await assert.rejects(
      resolveReadableFileForIpc(largePath, {
        maxBytes: 8,
        purpose: 'File preview'
      }),
      /file is too large/
    )

    const envPath = path.join(tempDir, '.env')
    fs.writeFileSync(envPath, 'SECRET_TOKEN=123', 'utf8')
    await assert.rejects(
      resolveReadableFileForIpc(envPath, {
        purpose: 'File preview'
      }),
      /blocked for sensitive file/
    )

    const envTemplatePath = path.join(tempDir, '.env.example')
    fs.writeFileSync(envTemplatePath, 'EXAMPLE_TOKEN=value', 'utf8')

    const envTemplate = await resolveReadableFileForIpc(envTemplatePath, {
      purpose: 'File preview'
    })

    assert.equal(envTemplate.resolvedPath, envTemplatePath)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('resolveReadableFileForIpc blocks common sensitive files', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-desktop-sensitive-'))

  try {
    const sshDir = path.join(tempDir, '.ssh')
    fs.mkdirSync(sshDir)

    const blockedFiles = [
      path.join(tempDir, '.env'),
      path.join(tempDir, '.npmrc'),
      path.join(sshDir, 'id_ed25519'),
      path.join(tempDir, 'cert.pem'),
      path.join(tempDir, 'cert.p12'),
      path.join(tempDir, 'cert.pfx')
    ]

    for (const filePath of blockedFiles) {
      fs.writeFileSync(filePath, 'secret', 'utf8')
      await rejectsWithCode(resolveReadableFileForIpc(filePath, { purpose: 'File preview' }), 'sensitive-file')
    }

    const allowed = path.join(tempDir, '.env.example')
    fs.writeFileSync(allowed, 'EXAMPLE_TOKEN=value', 'utf8')
    assert.equal((await resolveReadableFileForIpc(allowed, { purpose: 'File preview' })).resolvedPath, allowed)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('resolveReadableFileForIpc blocks symlinks whose realpath is sensitive', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-desktop-realpath-'))

  try {
    const envPath = path.join(tempDir, '.env')
    const linkPath = path.join(tempDir, 'safe-name.txt')
    fs.writeFileSync(envPath, 'SECRET_TOKEN=123', 'utf8')

    try {
      fs.symlinkSync(envPath, linkPath, 'file')
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        // symlink creation is not permitted on this platform — skip
        return
      }

      throw error
    }

    await rejectsWithCode(resolveReadableFileForIpc(linkPath, { purpose: 'File preview' }), 'sensitive-file')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('resolveDirectoryForIpc accepts directories and rejects invalid directory targets', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-desktop-dir-'))

  try {
    const directory = path.join(tempDir, 'project')
    const filePath = path.join(tempDir, 'file.txt')
    fs.mkdirSync(directory)
    fs.writeFileSync(filePath, 'not a directory', 'utf8')

    const resolved = await resolveDirectoryForIpc(directory)
    assert.equal(resolved.resolvedPath, directory)
    assert.equal(resolved.stat.isDirectory(), true)

    await rejectsWithCode(resolveDirectoryForIpc(filePath), 'ENOTDIR')
    await rejectsWithCode(resolveDirectoryForIpc(path.join(tempDir, 'missing')), 'ENOENT')
    await rejectsWithCode(resolveDirectoryForIpc('\\\\?\\C:\\secret'), 'device-path')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('resolveDirectoryForIpc accepts directory symlinks or junctions', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-desktop-dir-link-'))

  try {
    const directory = path.join(tempDir, 'actual-project')
    const linkPath = path.join(tempDir, 'linked-project')
    fs.mkdirSync(directory)

    try {
      fs.symlinkSync(directory, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        // directory symlink creation is not permitted on this platform — skip
        return
      }

      throw error
    }

    const resolved = await resolveDirectoryForIpc(linkPath)
    assert.equal(resolved.resolvedPath, linkPath)
    assert.equal(resolved.stat.isDirectory(), true)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('resolveWritableFileForIpc blocks sensitive basenames and allows normal writes', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-desktop-write-'))

  try {
    const okPath = path.join(tempDir, 'notes.md')
    const resolved = await resolveWritableFileForIpc(okPath, { contentLength: 12 })
    assert.equal(resolved.resolvedPath, okPath)

    await rejectsWithCode(resolveWritableFileForIpc(path.join(tempDir, '.env'), { contentLength: 1 }), 'sensitive-file')
    await rejectsWithCode(
      resolveWritableFileForIpc(path.join(tempDir, 'id_ed25519'), { contentLength: 1 }),
      'sensitive-file'
    )
    await rejectsWithCode(resolveWritableFileForIpc(okPath, { contentLength: 2_000_000, maxBytes: 1000 }), 'EFBIG')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('resolveExistingPathForIpc blocks sensitive paths for trash/reveal', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-desktop-exist-'))

  try {
    const filePath = path.join(tempDir, 'safe.txt')
    fs.writeFileSync(filePath, 'ok', 'utf8')

    const resolved = await resolveExistingPathForIpc(filePath)
    assert.equal(resolved.resolvedPath, filePath)

    const envPath = path.join(tempDir, '.env')
    fs.writeFileSync(envPath, 'SECRET=1', 'utf8')
    await rejectsWithCode(resolveExistingPathForIpc(envPath), 'sensitive-file')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('assertTerminalOwner binds PTY ops to owning webContents id', () => {
  assert.equal(assertTerminalOwner({ webContentsId: 7 }, 7), true)
  assert.equal(assertTerminalOwner({ webContentsId: 7 }, 8), false)
  assert.equal(assertTerminalOwner(null, 1), false)
  assert.equal(assertTerminalOwner({}, 1), false)
})

test('isPrivateOrReservedIp covers loopback metadata and RFC1918', () => {
  assert.equal(isPrivateOrReservedIp('127.0.0.1'), true)
  assert.equal(isPrivateOrReservedIp('169.254.169.254'), true)
  assert.equal(isPrivateOrReservedIp('10.0.0.5'), true)
  assert.equal(isPrivateOrReservedIp('192.168.1.1'), true)
  assert.equal(isPrivateOrReservedIp('8.8.8.8'), false)
  assert.equal(isPrivateOrReservedIp('::1'), true)
})

test('assertSafeOutboundUrl rejects private hosts and non-https by default', async () => {
  await assert.rejects(
    () => assertSafeOutboundUrl('http://example.com/x', { lookup: async () => [{ address: '93.184.216.34', family: 4 }] }),
    (error: any) => error?.code === 'insecure-url'
  )
  await assert.rejects(
    () =>
      assertSafeOutboundUrl('https://metadata.example/', {
        lookup: async () => [{ address: '169.254.169.254', family: 4 }]
      }),
    (error: any) => error?.code === 'private-url'
  )
  await assert.rejects(
    () =>
      assertSafeOutboundUrl('https://evil.example/', {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }]
      }),
    (error: any) => error?.code === 'private-url'
  )

  const ok = await assertSafeOutboundUrl('https://example.com/a', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  })
  assert.equal(ok.hostname, 'example.com')
})

test('buildDesktopContentSecurityPolicy includes script-src self and blocks object', () => {
  const csp = buildDesktopContentSecurityPolicy({ devServer: 'http://127.0.0.1:5174' })
  assert.match(csp, /script-src 'self'/)
  assert.match(csp, /object-src 'none'/)
  assert.match(csp, /127\.0\.0\.1:5174/)
  // TTS playback uses data: URLs + hermes-media://stream for cached mp3s.
  assert.match(csp, /media-src [^;]*\bdata:/)
  assert.match(csp, /media-src [^;]*\bhermes-media:/)
})

test('buildDesktopContentSecurityPolicy permits guarded plugin eval and loopback styles', () => {
  const csp = buildDesktopContentSecurityPolicy()
  // Canvas/Kanban load plugin bundles via new Function() (gated to loopback by
  // assertCanExecuteGatewayPluginScript); without 'unsafe-eval' they fail to load.
  assert.match(csp, /script-src [^;]*'unsafe-eval'/)
  // Plugin stylesheets are served from the loopback gateway on an ephemeral port.
  assert.match(csp, /style-src [^;]*http:\/\/127\.0\.0\.1:\*/)
})

test('isPackagedDevToolsAllowed requires explicit env in packaged builds', () => {
  assert.equal(isPackagedDevToolsAllowed({}, false), true)
  assert.equal(isPackagedDevToolsAllowed({}, true), false)
  assert.equal(isPackagedDevToolsAllowed({ HERMES_DESKTOP_DEVTOOLS: '1' }, true), true)
  assert.equal(isPackagedDevToolsAllowed({ HERMES_DESKTOP_ALLOW_DEVTOOLS: 'true' }, true), true)
})

test('canExecuteGatewayPluginScript allows loopback only', () => {
  assert.equal(canExecuteGatewayPluginScript('http://127.0.0.1:9119'), true)
  assert.equal(canExecuteGatewayPluginScript('http://localhost:9119'), true)
  assert.equal(canExecuteGatewayPluginScript('https://gateway.example.com'), false)
  assert.equal(canExecuteGatewayPluginScript('not-a-url'), false)
  // Default local backend leaves baseUrl empty -> loopback 127.0.0.1 fallback.
  assert.equal(canExecuteGatewayPluginScript(''), true)
})
