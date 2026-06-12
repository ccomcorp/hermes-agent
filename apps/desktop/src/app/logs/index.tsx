/**
 * Logs — tail the Hermes log files (agent / errors / gateway) with level and
 * component filters.
 *
 * Functional spec: web `src/pages/LogsPage.tsx`. Capability ported:
 *  - file / level / component / line-count filters (GET /api/logs)
 *  - per-line severity classification + coloring (error / warning / info / debug)
 *  - optional auto-refresh poll (5s)
 *
 * Reuses the chassis log IPC `getLogs` from `src/hermes.ts` (routes through
 * `window.hermesDesktop.api<LogsResponse>` exactly like every other feature) —
 * no feature-local api.ts and no invented endpoints.
 *
 * Desktop-styled: full-width main-pane (flat section, no card-in-card), shared
 * primitives (Button, Badge, Codicon, Switch, SegmentedControl, LogView),
 * tokens not literals, and the standard PAGE_INSET_X gutter.
 */
import type * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { getLogs } from '@/hermes'
import { cn } from '@/lib/utils'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { PAGE_INSET_X } from '../layout-constants'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { logsStrings as s } from './strings'

const FILES = ['agent', 'errors', 'gateway'] as const
const LEVELS = ['ALL', 'DEBUG', 'INFO', 'WARNING', 'ERROR'] as const
const COMPONENTS = ['all', 'gateway', 'agent', 'tools', 'cli', 'cron'] as const
const LINE_COUNTS = [50, 100, 200, 500] as const

const AUTO_REFRESH_INTERVAL_MS = 5000

type LogFile = (typeof FILES)[number]
type LogLevel = (typeof LEVELS)[number]
type LogComponent = (typeof COMPONENTS)[number]
type LineCount = (typeof LINE_COUNTS)[number]
type LineSeverity = 'debug' | 'error' | 'info' | 'warning'

const LINE_COLORS: Record<LineSeverity, string> = {
  error: 'text-destructive',
  warning: 'text-amber-600 dark:text-amber-300',
  info: 'text-foreground',
  debug: 'text-muted-foreground'
}

function classifyLine(line: string): LineSeverity {
  const upper = line.toUpperCase()

  if (upper.includes('ERROR') || upper.includes('CRITICAL') || upper.includes('FATAL')) {
    return 'error'
  }

  if (upper.includes('WARNING') || upper.includes('WARN')) {
    return 'warning'
  }

  if (upper.includes('DEBUG')) {
    return 'debug'
  }

  return 'info'
}

function toOptions<T extends string>(values: readonly T[]): SegmentedControlOption<T>[] {
  return values.map(value => ({ id: value, label: value.toUpperCase() }))
}

const LINE_COUNT_OPTIONS: SegmentedControlOption<string>[] = LINE_COUNTS.map(n => ({
  id: String(n),
  label: String(n)
}))

interface LogsViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

export function LogsView({ setStatusbarItemGroup, className, ...props }: LogsViewProps) {
  const [file, setFile] = useState<LogFile>('agent')
  const [level, setLevel] = useState<LogLevel>('ALL')
  const [component, setComponent] = useState<LogComponent>('all')
  const [lineCount, setLineCount] = useState<LineCount>(100)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)

  const fetchLogs = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const resp = await getLogs({ file, lines: lineCount, level, component })

      setLines(resp.lines)

      // Pin to the newest line after the surface paints.
      setTimeout(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
      }, 50)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [component, file, level, lineCount])

  useRefreshHotkey(() => void fetchLogs())

  useEffect(() => {
    void fetchLogs()
  }, [fetchLogs])

  useEffect(() => {
    if (!autoRefresh) {
      return
    }

    const interval = setInterval(() => void fetchLogs(), AUTO_REFRESH_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [autoRefresh, fetchLogs])

  useEffect(() => {
    return () => setStatusbarItemGroup?.('logs', [])
  }, [setStatusbarItemGroup])

  return (
    <section
      {...props}
      className={cn('flex h-full min-w-0 flex-col overflow-hidden bg-(--ui-chat-surface-background)', className)}
    >
      <div className={cn('h-full overflow-y-auto pb-20 pt-[calc(var(--titlebar-height)+0.75rem)]', PAGE_INSET_X)}>
        <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col gap-4">
          {/* ── Toolbar: filters + actions ─────────────────────────── */}
          <div
            aria-label={s.title}
            className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:gap-x-6 sm:gap-y-3"
            role="toolbar"
          >
            <Filter label={s.fileLabel}>
              <SegmentedControl onChange={setFile} options={toOptions(FILES)} value={file} />
            </Filter>

            <Filter label={s.levelLabel}>
              <SegmentedControl onChange={setLevel} options={toOptions(LEVELS)} value={level} />
            </Filter>

            <Filter label={s.componentLabel}>
              <SegmentedControl onChange={setComponent} options={toOptions(COMPONENTS)} value={component} />
            </Filter>

            <Filter label={s.linesLabel}>
              <SegmentedControl
                onChange={value => setLineCount(Number(value) as LineCount)}
                options={LINE_COUNT_OPTIONS}
                value={String(lineCount)}
              />
            </Filter>

            <div className="flex items-center gap-2 sm:ml-auto">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground" htmlFor="logs-auto-refresh">
                {s.autoRefresh}
              </label>
              <Switch checked={autoRefresh} id="logs-auto-refresh" onCheckedChange={setAutoRefresh} />
              {autoRefresh && (
                <Badge variant="default">
                  <span className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-current" />
                  {s.live}
                </Badge>
              )}
              <Button
                aria-label={s.refresh}
                className="text-muted-foreground hover:text-foreground"
                disabled={loading}
                onClick={() => void fetchLogs()}
                size="icon-xs"
                title={s.refresh}
                variant="ghost"
              >
                <Codicon name={loading ? 'loading' : 'refresh'} size="0.875rem" spinning={loading} />
              </Button>
            </div>
          </div>

          {/* ── Log surface ────────────────────────────────────────── */}
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-2">
              <Codicon className="text-muted-foreground" name="output" size="0.875rem" />
              <span className="font-mono text-xs text-foreground">{s.fileHeading(file)}</span>
            </div>

            {error && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <div
              className="min-h-0 flex-1 overflow-auto rounded-lg border border-(--ui-stroke-tertiary) px-2.5 py-1.5 font-mono text-[0.6875rem] leading-[1.5] break-words whitespace-pre-wrap [scrollbar-width:thin]"
              ref={scrollRef}
            >
              {lines.length === 0 && !loading ? (
                <p className="py-8 text-center text-muted-foreground">{s.noLogLines}</p>
              ) : (
                lines.map((line, i) => (
                  <div className={cn('-mx-1 px-1 hover:bg-(--ui-bg-tertiary)', LINE_COLORS[classifyLine(line)])} key={i}>
                    {line}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function Filter({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5 sm:flex-row sm:items-center">
      <span className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
      {children}
    </div>
  )
}
