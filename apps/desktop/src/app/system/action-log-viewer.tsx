/**
 * Live action-log viewer for spawn-based admin actions (doctor, audit, backup,
 * import, skills update, checkpoints prune, gateway start/stop/restart, update).
 *
 * Polls `/api/actions/<name>/status` until the process exits. Desktop-styled:
 * flat surface, shared LogView + Badge + Codicon primitives, tokens not
 * literals.
 */
import { useEffect, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { LogView } from '@/components/ui/log-view'

import { getActionStatus } from './api'
import { systemStrings as s } from './strings'

const POLL_INTERVAL_MS = 1200

export function ActionLogViewer({ action, onClose }: { action: string; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([])
  const [running, setRunning] = useState(true)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const st = await getActionStatus(action, 400)

        if (cancelled) {
          return
        }

        setLines(st.lines)
        setRunning(st.running)
        setExitCode(st.exit_code)

        if (st.running) {
          timer.current = setTimeout(() => void poll(), POLL_INTERVAL_MS)
        }
      } catch {
        if (!cancelled) {
          setRunning(false)
        }
      }
    }

    void poll()

    return () => {
      cancelled = true

      if (timer.current) {
        clearTimeout(timer.current)
      }
    }
  }, [action])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Codicon className="text-muted-foreground" name="terminal" size="0.875rem" />
        <span className="font-mono text-xs text-foreground">{action}</span>
        {running ? (
          <Badge variant="warn">
            <Codicon name="loading" size="0.7rem" spinning /> {s.actionRunning}
          </Badge>
        ) : (
          <Badge variant={exitCode === 0 ? 'default' : 'destructive'}>
            {exitCode === 0 ? s.actionDone : s.actionExit(exitCode)}
          </Badge>
        )}
        <Button
          aria-label={s.actionClose}
          className="ml-auto text-muted-foreground hover:text-foreground"
          onClick={onClose}
          size="icon-xs"
          title={s.actionClose}
          variant="ghost"
        >
          <Codicon name="close" size="0.875rem" />
        </Button>
      </div>
      <LogView className="max-h-72">{lines.length ? lines.join('\n') : s.actionStarting}</LogView>
    </div>
  )
}
