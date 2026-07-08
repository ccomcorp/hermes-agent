/**
 * Canvas — Live UI creation workspace (AIOS hermes-canvas plugin).
 * Native desktop host for the hermes-canvas dashboard plugin, mirroring the
 * Kanban SDK-bridge pattern. The desktop sidebar is a static list (no dynamic
 * plugin tabs), so this native page loads the plugin bundle explicitly.
 *
 * Cross-origin note: unlike Kanban (which calls SDK.fetchJSON), the canvas
 * bundle uses RAW relative fetch('/api/plugins/hermes-canvas/...') — fine in the
 * same-origin web dashboard, but in Electron the renderer origin != gateway, so
 * we install a fetch rewrite that prefixes the gateway base for canvas's own
 * relative API + asset URLs. The bundle's prepended F1 auth shim then delegates
 * to it (adding X-Hermes-Session-Token).
 */
import * as React from 'react'
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { cn } from '@/lib/utils'
import { $connection } from '@/store/session'

import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

const win = window as any

// ── shim UI components (the set canvas's bundle reads via SDK.components) ──
const Badge = (props: any) =>
  React.createElement('span', {
    className: cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', props.className),
    ...props
  })
const Button = (props: any) =>
  React.createElement('button', { className: cn('inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium', props.className), ...props })
const Card = (props: any) =>
  React.createElement('div', { className: cn('rounded-lg border bg-card text-card-foreground', props.className), ...props })
const CardHeader = (props: any) => React.createElement('div', { className: cn('p-4 pb-2', props.className), ...props })
const CardTitle = (props: any) => React.createElement('h3', { className: cn('font-semibold leading-none', props.className), ...props })
const CardContent = (props: any) => React.createElement('div', { className: cn('p-4 pt-2', props.className), ...props })
const Separator = (props: any) => React.createElement('div', { className: cn('h-px w-full bg-border', props.className), ...props })
// Also provided so the SHARED __HERMES_PLUGIN_SDK__ singleton is a superset that
// still serves Kanban (which needs these) if Canvas installs the SDK first.
const Input = (props: any) =>
  React.createElement('input', { className: cn('flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm', props.className), ...props })
const Label = (props: any) =>
  React.createElement('label', { className: cn('text-sm font-medium', props.className), ...props })
const Select = (props: any) =>
  React.createElement('select', { className: cn('h-9 rounded-md border bg-transparent px-3 text-sm', props.className), ...props })
const SelectOption = (props: any) => React.createElement('option', props)

function timeAgo(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() / 1000 - ts
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function canvasUrl(connection: any, path: string): string {
  return `${connection?.baseUrl || 'http://127.0.0.1:9120'}${path}`
}

export function CanvasView({ setStatusbarItemGroup }: { setStatusbarItemGroup: SetStatusbarItemGroup }) {
  const connection = useStore($connection)
  const containerRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadCanvas = useCallback(async () => {
    if (!containerRef.current) return
    const token = connection?.token || ''
    const apiBase = connection?.baseUrl || 'http://127.0.0.1:9120'

    win.__HERMES_SESSION_TOKEN__ = token

    // Cross-origin fetch rewrite for canvas's raw relative URLs. Installed once,
    // BEFORE the bundle evaluates, so the bundle's own fetch shim wraps this.
    if (!win.__HERMES_CANVAS_DESKTOP_FETCH__) {
      win.__HERMES_CANVAS_DESKTOP_FETCH__ = true
      const orig = win.fetch.bind(win)
      win.fetch = (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        if (typeof url === 'string' && (url.startsWith('/api/plugins/hermes-canvas') || url.startsWith('/dashboard-plugins/hermes-canvas'))) {
          const base = $connection.get()?.baseUrl || apiBase
          const tok = $connection.get()?.token || ''
          const next = init || {}
          const headers = new Headers(next.headers || {})
          if (tok && !headers.has('X-Hermes-Session-Token')) headers.set('X-Hermes-Session-Token', tok)
          next.headers = headers
          return orig(`${base}${url}`, next)
        }
        return orig(input, init)
      }
    }

    // The SDK is a SHARED first-wins global singleton across all dashboard plugins
    // (Kanban guards the same global). So this MUST be a correct superset: the
    // fetch helpers carry Bearer auth (Kanban's board-load 401'd when it inherited
    // an auth-less Canvas SDK), the component/util set covers both plugins, and
    // buildWsUrl mirrors Kanban's contract (Canvas itself uses raw fetch, not these).
    if (!win.__HERMES_PLUGIN_SDK__) {
      const components = { Badge, Button, Card, CardHeader, CardTitle, CardContent, Separator, Input, Label, Select, SelectOption }
      win.__HERMES_PLUGIN_SDK__ = {
        React,
        components,
        ui: components,
        hooks: { useState, useEffect, useCallback, useMemo, useRef },
        utils: { cn, timeAgo },
        sdkVersion: '1.1.0',
        fetchJSON: async (url: string, opts?: any) => {
          const currentToken = $connection.get()?.token || ''
          const currentBase = $connection.get()?.baseUrl || apiBase
          const resolvedUrl = url.startsWith('/') ? `${currentBase}${url}` : url
          const headers: Record<string, string> = { Accept: 'application/json' }
          if (currentToken) headers['Authorization'] = `Bearer ${currentToken}`
          if (opts?.body && typeof opts.body !== 'string') { headers['Content-Type'] = 'application/json'; opts = { ...opts, body: JSON.stringify(opts.body) } }
          const res = await fetch(resolvedUrl, { ...opts, headers: { ...headers, ...(opts?.headers || {}) } })
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
          return res.json()
        },
        authedFetch: async (url: string, opts?: any) => {
          const currentToken = $connection.get()?.token || ''
          const currentBase = $connection.get()?.baseUrl || apiBase
          const resolvedUrl = url.startsWith('/') ? `${currentBase}${url}` : url
          const headers: Record<string, string> = {}
          if (currentToken) headers['Authorization'] = `Bearer ${currentToken}`
          if (opts?.body && !(opts.body instanceof FormData)) { headers['Content-Type'] = 'application/json'; opts = { ...opts, body: JSON.stringify(opts.body) } }
          const res = await fetch(resolvedUrl, { ...opts, headers: { ...headers, ...(opts?.headers || {}) } })
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
          return res.json()
        },
        buildWsUrl: async (path: string, params?: Record<string, string>) => {
          const currentToken = $connection.get()?.token || ''
          const currentBase = $connection.get()?.baseUrl || apiBase
          const u = new URL(currentBase)
          const protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
          const sp = new URLSearchParams(params || {})
          sp.set('token', currentToken)
          // Kanban's WS contract (caller passes '/events' → /api/plugins/kanban/events).
          // Canvas does not use WS; this exists so an inheriting Kanban keeps working.
          return `${protocol}//${u.host}/api/plugins/kanban${path}?${sp}`
        }
      }
    }

    if (!win.__HERMES_PLUGINS__) {
      win.__HERMES_PLUGINS__ = { _components: {}, register(name: string, component: any) { this._components[name] = component } }
    }

    const registry = win.__HERMES_PLUGINS__
    if (!registry._components['hermes-canvas']) {
      try {
        if (!document.querySelector('link[data-hermes-plugin="hermes-canvas"]')) {
          const link = document.createElement('link')
          link.rel = 'stylesheet'
          link.href = canvasUrl(connection, '/dashboard-plugins/hermes-canvas/dist/style.css?v=9')
          link.dataset.hermesPlugin = 'hermes-canvas'
          document.head.appendChild(link)
        }
        const resp = await fetch(canvasUrl(connection, '/dashboard-plugins/hermes-canvas/dist/index.js?v=11'))
        const code = await resp.text()
        new Function(code)()
      } catch (err) {
        console.error('[canvas] Plugin script failed:', err)
        setError('Failed to load canvas plugin. Check that the gateway is running.')
        setLoading(false)
        return
      }
    }

    const CanvasPage = registry._components['hermes-canvas']
    if (!CanvasPage) {
      console.error('[canvas] Plugin loaded but failed to register. Registry:', Object.keys(registry._components))
      setError('Canvas plugin loaded but failed to register its component.')
      setLoading(false)
      return
    }

    const { createRoot } = await import('react-dom/client')
    createRoot(containerRef.current!).render(React.createElement(CanvasPage))
    setLoading(false)
  }, [connection])

  useEffect(() => { void loadCanvas() }, [loadCanvas])
  useEffect(() => { setStatusbarItemGroup('canvas', []); return () => setStatusbarItemGroup('canvas', []) }, [setStatusbarItemGroup])

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-(--ui-chat-surface-background) pt-(--titlebar-height)">
      {loading && <div className="flex flex-1 items-center justify-center"><PageLoader /></div>}
      {error && (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-muted-foreground">
          <div><p className="text-lg font-medium text-destructive">Canvas unavailable</p><p className="mt-2 text-sm">{error}</p></div>
        </div>
      )}
      <div ref={containerRef} className={cn('flex-1 overflow-auto', loading && 'hidden')} />
    </div>
  )
}
