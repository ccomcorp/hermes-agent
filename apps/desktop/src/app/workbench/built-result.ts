/**
 * Workbench — "surface the built page" helpers (final Workbench slice).
 *
 * After a design brief is sent to Kanban and the dev orchestrator builds real
 * code into the PROJECT directory (not the workbench artifact store), this
 * lets the Workbench show the delivered result. The pattern is adapted from
 * Kun (github.com/KunAgent/Kun), which surfaces built output two ways:
 *
 *   - DESIGN mode: render the built HTML file in a sandboxed view. We reuse the
 *     existing `DesignPrototypePreview` srcDoc iframe (see that file's header
 *     for why we deliberately use srcDoc, not Kun's <webview src=file://>), fed
 *     by `readFileText` on the located entry. `builtEntryCandidates()` picks the
 *     file. This is the path a STATIC deliverable (a single index.html) takes.
 *   - CODE mode: for a framework project the orchestrator starts a dev server
 *     and prints a localhost URL; `extractDevPreviewUrl()` finds it so the UI
 *     can offer an "open live preview" launch instead of a static file render.
 *
 * Pure/string-only (no DOM, no IPC, no fs) so it unit-tests without Electron —
 * see built-result.test.ts.
 */

// Candidate built-entry absolute paths, in priority order, for a workspace
// root. A design->code deliverable is most often a single `index.html` at the
// project root (static); framework builds emit into dist/build/public. The
// caller tries each with `readFileText` and takes the first that reads.
export function builtEntryCandidates(workspaceRoot: string): string[] {
  const root = workspaceRoot.replace(/[\\/]+$/, '')
  const sep = root.includes('\\') ? '\\' : '/'

  return ['index.html', `dist${sep}index.html`, `build${sep}index.html`, `public${sep}index.html`].map(
    rel => `${root}${sep}${rel}`
  )
}

// Build a `file://` URL for `openExternal` from an absolute path. Backslashes
// are normalized to forward slashes and a drive-letter path (Windows) gets the
// `file:///` triple-slash; a POSIX absolute path keeps its leading slash.
export function toFileUrl(absPath: string): string {
  const p = absPath.replace(/\\/g, '/')

  return p.startsWith('/') ? `file://${p}` : `file:///${p}`
}

// Hosts that denote a LOCAL dev server (never a public site we'd wrongly offer
// to "preview"): loopback, the common bind-all, RFC1918 LAN ranges, and mDNS
// `*.local`. Mirrors Kun's dev-preview-url allowlist intent.
const LOCAL_HOST =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[\w-]+\.local)$/i

/**
 * Extract the first LOCAL dev-server URL from arbitrary text (a Kanban card's
 * body/output). Returns null when none is present — the static-page case, where
 * the caller falls back to rendering the built file. `0.0.0.0` is normalized to
 * `127.0.0.1` so the returned URL is actually openable.
 */
export function extractDevPreviewUrl(text: string): string | null {
  if (!text) {return null}
  const re = /https?:\/\/([^\s/:"'<>]+)(?::(\d{2,5}))?(\/[^\s"'<>]*)?/gi
  let m: RegExpExecArray | null

  while ((m = re.exec(text)) !== null) {
    if (LOCAL_HOST.test(m[1])) {
      return m[0].replace('0.0.0.0', '127.0.0.1')
    }
  }

  return null
}
