/**
 * Design Studio — sandboxed prototype preview (Slice H, go-forward plan §5
 * Slice H).
 *
 * *** SECURITY-CRITICAL FILE — READ BEFORE EDITING ***
 *
 * Renders a Slice G `prototype` artifact's generated HTML as a LIVE document,
 * for the first time in Design Studio (Slice G explicitly never did this —
 * see design-generation-panel.tsx's module header). The generated HTML is
 * model output: untrusted content, even though it never leaves the local
 * workspace.
 *
 * MECHANISM: a plain, standard, browser-native sandboxed `<iframe>` using the
 * `sandbox` HTML attribute plus `srcDoc` (content passed as a string — never a
 * `src=` URL, never a `file://` path, never any real navigation). This needs
 * ZERO changes to any BrowserWindow's `webPreferences` anywhere in this app —
 * it is pure renderer-side, standard web-platform sandboxing already
 * supported by Chromium without any new Electron main-process capability.
 * (Correction on review: the main window's `webPreferences` — via
 * `chatWindowWebPreferences()` in `electron/session-windows.cjs` — already has
 * `webviewTag: true` set for unrelated functionality, alongside
 * `contextIsolation: true`/`sandbox: true`/`nodeIntegration: false`. That
 * existing flag is irrelevant to this file either way: this component adds no
 * `<webview>` and reaches none of that capability, regardless of what's
 * already enabled on the window for other features.)
 *
 * Diverging from Kun (github.com/KunAgent/Kun) on purpose: Kun's own recipe
 * (`DESIGN_MODE_PLAN.md`, `src/renderer/src/write/html-embed-dom.ts`) is
 * `window.kunGui.authorizeWritePrototype({ path, workspaceRoot })` (an
 * IPC-gated path-allowlist) feeding `<webview src=fileUrl
 * partition="kun-proto" webpreferences="contextIsolation=yes,nodeIntegration
 * =no,sandbox=yes">` — i.e. Kun writes the prototype HTML to a real file
 * under the workspace first, then loads it by `file://` URL in a `<webview>`.
 * That requires (a) enabling `webviewTag` on a BrowserWindow — a new Electron
 * main-process attack surface explicitly out of scope for this slice, (b)
 * persisting the HTML to a new on-disk location, and (c) a new IPC
 * path-allowlist channel — none of which this slice needs: the artifact
 * content already reached the renderer via the existing `readDesignArtifact`
 * call. A same-process `srcDoc` iframe reaches the same "render this HTML
 * safely" goal with less new surface, so this file does NOT follow Kun's
 * `<webview>` shape.
 *
 * SANDBOX ATTRIBUTE — the single most consequential line in this file:
 * `sandbox="allow-scripts"` and NOTHING else.
 *   - `allow-scripts` alone (see below) is included because Slice G's own
 *     generation prompt (design-generation.ts `buildDesignPrototypePrompt`)
 *     explicitly allows inline `<script>` for basic interactivity while
 *     forbidding any network access — a prototype with no JS at all would
 *     silently break that already-generated content.
 *   - `allow-same-origin` is deliberately NEVER added. This is the one flag
 *     that, combined with `allow-scripts`, lets sandboxed content escape
 *     effective isolation (the well-documented sandbox anti-pattern: without
 *     `allow-same-origin` the framed document has an opaque, unique origin
 *     even though scripts run, so it cannot read/write this app's cookies,
 *     storage, or `window` internals, and a `document.domain` trick has
 *     nothing matching to widen into). Do not add it.
 *   - `allow-top-navigation`, `allow-popups`, `allow-forms`,
 *     `allow-pointer-lock`, and `allow-modals` are also never added — a
 *     prototype preview has no legitimate reason to navigate the app, open a
 *     popup, submit a form, capture the pointer, or spawn a native dialog.
 *   - No `allow` (Permissions Policy) attribute is set, so the default
 *     restrictive policy applies (camera/microphone/geolocation/etc. are not
 *     granted).
 *   - No `referrerPolicy`/`src` is ever set — content only ever reaches this
 *     iframe via the `srcDoc` prop below.
 *
 * No preload script, no contextBridge, nothing Electron-specific reaches this
 * iframe — it is exactly as isolated as any ordinary sandboxed iframe in a
 * plain browser tab.
 */
import { type PointerEvent as ReactPointerEvent, useRef } from 'react'

import { Codicon } from '@/components/ui/codicon'

import { workbenchStrings as s } from './strings'

interface DesignPrototypePreviewProps {
  html: string
  // `fill`: the larger "built page" dialog wants a big, MANUALLY RESIZABLE
  // preview (drag the bottom-right corner to make it wider/taller) instead of
  // the compact fixed-height box the prototype preview uses. Sizing ONLY — the
  // sandbox attribute below is byte-for-byte identical in both modes.
  fill?: boolean
}

export function DesignPrototypePreview({ html, fill = false }: DesignPrototypePreviewProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)

  // Manual drag-to-resize for fill mode. A plain CSS `resize` handle does NOT work
  // over an iframe — the cross-origin frame swallows the corner-grip pointer events —
  // so we drive it ourselves: during a drag we set the box's inline width/height AND
  // temporarily disable the iframe's pointer-events, so pointermove keeps reaching this
  // window even while the cursor is over the preview.
  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = boxRef.current
    if (!box) return

    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startW = box.offsetWidth
    const startH = box.offsetHeight
    const frame = frameRef.current
    if (frame) frame.style.pointerEvents = 'none'

    const onMove = (ev: PointerEvent) => {
      box.style.width = `${Math.max(360, startW + (ev.clientX - startX))}px`
      box.style.height = `${Math.max(240, startH + (ev.clientY - startY))}px`
    }
    const onUp = () => {
      if (frame) frame.style.pointerEvents = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const containerClass = fill
    ? 'relative flex h-[64vh] min-h-64 w-full flex-col overflow-hidden rounded-md border border-(--ui-stroke-secondary)'
    : 'flex max-h-96 min-h-64 flex-1 flex-col overflow-hidden rounded-md border border-(--ui-stroke-secondary)'

  return (
    <div className={containerClass} ref={boxRef}>
      <div className="flex shrink-0 items-center gap-1.5 border-b border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) px-2 py-1 text-[0.65rem] font-medium text-muted-foreground/70">
        <Codicon name="shield" size="0.75rem" />
        {s.designGeneration.previewSandboxBadge}
      </div>
      {/* Content reaches this iframe ONLY via `srcDoc` — never a `src=` URL,
          never a file:// path, never real navigation. See module header for
          the sandbox attribute's exact value and reasoning. */}
      <iframe
        className="min-h-64 flex-1 border-0 bg-white"
        ref={frameRef}
        sandbox="allow-scripts"
        srcDoc={html}
        title={s.designGeneration.previewIframeTitle}
      />
      {fill && (
        <div
          aria-label="Drag to resize"
          className="absolute bottom-0 right-0 z-20 h-5 w-5 cursor-nwse-resize"
          onPointerDown={onResizeStart}
          style={{
            background:
              'linear-gradient(135deg, transparent 0 58%, var(--ui-stroke-secondary) 58% 70%, transparent 70% 80%, var(--ui-stroke-secondary) 80% 92%, transparent 92%)'
          }}
          title="Drag to resize"
        />
      )}
    </div>
  )
}
