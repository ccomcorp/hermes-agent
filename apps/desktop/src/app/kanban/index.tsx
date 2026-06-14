/**
 * Kanban — Multi-agent collaboration board.
 * Loads the dashboard plugin via the SDK bridge pattern.
 */
import * as React from 'react'
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { cn } from '@/lib/utils'
import { $connection } from '@/store/session'

import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

const win = window as any

// ── shim components ──────────────────────────────────────────────────

const Badge = (props: any) =>
  React.createElement('span', {
    className: cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', props.className),
    ...props
  })
const Card = (props: any) =>
  React.createElement('div', { className: cn('rounded-lg border bg-card text-card-foreground', props.className), ...props })
const CardContent = (props: any) => React.createElement('div', { className: 'p-4', ...props })
const Label = (props: any) =>
  React.createElement('label', { className: cn('text-sm font-medium', props.className), ...props })
const Input = (props: any) =>
  React.createElement('input', { className: cn('flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm', props.className), ...props })
const Button = (props: any) =>
  React.createElement('button', { className: cn('inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium', props.className), ...props })
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

function kanbanUrl(connection: any, path: string): string {
  return `${connection?.baseUrl || 'http://127.0.0.1:9120'}${path}`
}

// ── page ─────────────────────────────────────────────────────────────

export function KanbanView({ setStatusbarItemGroup }: { setStatusbarItemGroup: SetStatusbarItemGroup }) {
  const connection = useStore($connection)
  const containerRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadKanban = useCallback(async () => {
    if (!containerRef.current) return
    const token = connection?.token || ''
    const apiBase = connection?.baseUrl || 'http://127.0.0.1:9120'

    if (!win.__HERMES_PLUGIN_SDK__) {
      win.__HERMES_SESSION_TOKEN__ = token
      win.__HERMES_PLUGIN_SDK__ = {
        React,
        components: { Badge, Button, Card, CardContent, Input, Label, Select, SelectOption },
        hooks: { useState, useEffect, useCallback, useMemo, useRef },
        utils: { cn, timeAgo },
        fetchJSON: async (url: string, opts?: any) => {
          const currentToken = $connection.get()?.token || ''
          const currentBase = $connection.get()?.baseUrl || 'http://127.0.0.1:9120'
          const resolvedUrl = url.startsWith('/') ? `${currentBase}${url}` : url
          const headers: Record<string, string> = { Accept: 'application/json' }
          if (currentToken) headers['Authorization'] = `Bearer ${currentToken}`
          if (opts?.body && typeof opts.body !== 'string') {
            headers['Content-Type'] = 'application/json'
            opts = { ...opts, body: JSON.stringify(opts.body) }
          }
          const res = await fetch(resolvedUrl, { ...opts, headers: { ...headers, ...(opts?.headers || {}) } })
          if (!res.ok) { const text = await res.text(); throw new Error(`HTTP ${res.status}: ${text}`) }
          return res.json()
        },
        buildWsUrl: async (path: string, params?: Record<string, string>) => {
          const currentToken = $connection.get()?.token || ''
          const currentBase = $connection.get()?.baseUrl || 'http://127.0.0.1:9120'
          const url = new URL(currentBase)
          const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
          const searchParams = new URLSearchParams(params || {})
          searchParams.set('token', currentToken)
          return `${protocol}//${url.host}/api/plugins/kanban${path}?${searchParams}`
        }
      }
    }

    if (!win.__HERMES_PLUGINS__) {
      win.__HERMES_PLUGINS__ = { _components: {}, register(name: string, component: any) { this._components[name] = component } }
    }

    const registry = win.__HERMES_PLUGINS__
    if (!registry._components['kanban']) {
      try {
        if (!document.querySelector('link[data-hermes-plugin="kanban"]')) {
          const link = document.createElement('link')
          link.rel = 'stylesheet'
          link.href = kanbanUrl(connection, '/dashboard-plugins/kanban/dist/style.css')
          link.dataset.hermesPlugin = 'kanban'
          document.head.appendChild(link)
          }
        const resp = await fetch(kanbanUrl(connection, '/dashboard-plugins/kanban/dist/index.js'))
        const code = await resp.text()
        new Function(code)()
      } catch (err) {
        console.error('[kanban] Plugin script failed:', err)
        setError('Failed to load kanban plugin. Check that the gateway is running.')
        setLoading(false)
        return
      }
    }

    const KanbanPage = registry._components['kanban']
    if (!KanbanPage) {
      console.error('[kanban] Plugin loaded but failed to register. Registry:', Object.keys(registry._components))
      setError('Kanban plugin loaded but failed to register its component.')
      setLoading(false)
      return
    }

    const { createRoot } = await import('react-dom/client')
    createRoot(containerRef.current!).render(React.createElement(KanbanPage))
    setLoading(false)
  }, [connection])

  useEffect(() => { void loadKanban() }, [loadKanban])
  useEffect(() => { setStatusbarItemGroup('kanban', []); return () => setStatusbarItemGroup('kanban', []) }, [setStatusbarItemGroup])

  return (
    <div
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-(--ui-chat-surface-background) pt-(--titlebar-height)"
      style={{
        '--color-border': '#D4C5B2',
        '--color-card': '#EDE7DB',
        '--color-card-subtle': '#E8E1D3',
        '--color-foreground': '#2D2A26',
        '--color-muted-foreground': '#6B6358',
        '--color-primary': '#C78E3F',
        '--color-destructive': '#C44E3D',
        '--color-ring': '#C78E3F',
        '--color-warning': '#C78E3F',
        '--font-mono': 'var(--font-mono-ui, ui-monospace, monospace)',
        '--hermes-diag-critical': '#DC2626',
        '--hermes-diag-error': '#EF4444',
        '--hermes-diag-warning': '#F59E0B',
        '--hermes-kanban-drawer-width': '420px',
        '--radius': '0.5rem',
        '--radius-sm': 'calc(0.5rem * 0.667)',
      } as React.CSSProperties}
    >
      {loading && <div className="flex flex-1 items-center justify-center"><PageLoader /></div>}
      {error && (
        <div className="flex flex-1 items-center justify-center p-8 text-center text-muted-foreground">
          <div><p className="text-lg font-medium text-destructive">Kanban unavailable</p><p className="mt-2 text-sm">{error}</p></div>
        </div>
      )}
      <div ref={containerRef} className={cn('flex-1 overflow-auto', loading && 'hidden')} />
    </div>
  )
}
