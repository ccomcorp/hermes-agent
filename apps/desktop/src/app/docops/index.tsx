import { useStore } from '@nanostores/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, FileText, Layers, RefreshCw, Settings, Tag, XCircle } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import { PageLoader } from '@/components/page-loader'
import { getDoxStatus, runDoxCheck } from '@/hermes'
import { cn } from '@/lib/utils'
import { $currentCwd } from '@/store/session'
import type { DoxProjectStatus } from '@/types/hermes.ts'

// ── Health mapping (shared with existing panel) ────────────────────────────
const TIER_HEALTH: Record<string, { label: string; cls: string; icon: typeof AlertTriangle }> = {
  A: { label: 'Attention', cls: 'border-amber-500/40 text-amber-300', icon: AlertTriangle },
  B: { label: 'Blocked', cls: 'border-red-500/40 text-red-300', icon: XCircle },
  C: { label: 'Blocked', cls: 'border-red-500/40 text-red-300', icon: XCircle }
}

const MODE_LABELS: Record<string, string> = {
  code: 'Code',
  hybrid: 'Hybrid',
  ops: 'Ops'
}

// ── Views ──────────────────────────────────────────────────────────────────

function InactiveState({ projectPath }: { projectPath: string }) {
  return (
    <ErrorState
      icon={<FileText className="size-10" />}
      title="DocOps not configured"
      description={
        projectPath
          ? `No docops.yml found under ${projectPath}.`
          : 'No project selected. Open a working directory to check DocOps status.'
      }
    >
      <p className="text-xs text-muted-foreground mt-2">
        Run <code className="bg-muted px-1 rounded text-xs">hermes dox init</code> to set up DocOps for this project.
      </p>
    </ErrorState>
  )
}

function ErrorFetchView({ error }: { error: Error }) {
  return (
    <ErrorState
      icon={<XCircle className="size-10" />}
      title="Could not load DocOps status"
      description={error.message}
    />
  )
}

function StatusBadge({ active, mode }: { active: boolean; mode: string | null }) {
  if (!active || !mode) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        Not initialized
      </Badge>
    )
  }
  return (
    <Badge
      className={cn(
        'text-white border',
        mode === 'code'
          ? 'border-green-500/40 bg-green-900/40 text-green-300'
          : mode === 'hybrid'
            ? 'border-blue-500/40 bg-blue-900/40 text-blue-300'
            : 'border-purple-500/40 bg-purple-900/40 text-purple-300'
      )}
    >
      {MODE_LABELS[mode] ?? mode}
    </Badge>
  )
}

function LayerStatus({ layers }: { layers: DoxProjectStatus['layers'] }) {
  const items = [
    { key: 'contract', label: 'Contract', active: layers.contract },
    { key: 'ledger', label: 'Ledger', active: layers.ledger },
    { key: 'publish', label: 'Publish', active: layers.publish }
  ]
  return (
    <div className="flex gap-3">
      {items.map(item => {
        const Icon = item.active ? CheckCircle2 : XCircle
        return (
          <div
            key={item.key}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs',
              item.active
                ? 'border-green-500/30 text-green-300 bg-green-900/30'
                : 'border-muted text-muted-foreground'
            )}
          >
            <Icon className="size-3" />
            {item.label}
          </div>
        )
      })}
    </div>
  )
}

function MarkersDisplay({ markers }: { markers: DoxProjectStatus['markers'] }) {
  return (
    <div className="flex flex-wrap gap-2">
      <div
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs',
          markers.docops_yml
            ? 'border-green-500/30 text-green-300 bg-green-900/30'
            : 'border-red-500/30 text-red-300 bg-red-900/30'
        )}
      >
        {markers.docops_yml ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
        docops.yml
      </div>
      <div
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs',
          markers.agents_md_header
            ? 'border-green-500/30 text-green-300 bg-green-900/30'
            : 'border-red-500/30 text-red-300 bg-red-900/30'
        )}
      >
        {markers.agents_md_header ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
        AGENTS.md
      </div>
      {markers.structural.map(m => (
        <div
          key={m}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs border-blue-500/30 text-blue-300 bg-blue-900/30"
        >
          <Tag className="size-3" />
          {m}
        </div>
      ))}
    </div>
  )
}

function DriftView({ drift }: { drift: DoxProjectStatus['drift'] }) {
  if (drift.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No drift detected. Run <code className="bg-muted px-1 rounded text-xs">hermes do check</code> for a full analysis.
      </p>
    )
  }

  return (
    <div className="space-y-1">
      {drift.map((item, i) => {
        const health = TIER_HEALTH[item.tier]
        const Icon = health?.icon ?? AlertTriangle
        return (
          <div
            key={`${item.path}-${i}`}
            className={cn(
              'flex items-start gap-2 px-2.5 py-1.5 rounded border text-xs',
              health?.cls ?? 'border-muted text-muted-foreground'
            )}
          >
            <Icon className="size-3 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <span className="font-medium">{item.path}</span>
              <span className="text-muted-foreground"> — {item.kind}</span>
              {item.message && (
                <span className="text-muted-foreground">: {item.message}</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Main Panel ─────────────────────────────────────────────────────────────

export function DocOpsView({ onClose }: { onClose?: () => void }) {
  const currentCwd = useStore($currentCwd)
  const projectPath = currentCwd?.trim() || ''
  const queryClient = useQueryClient()
  const [checkRunning, setCheckRunning] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)

  const {
    data: status,
    isLoading,
    error,
    isError
  } = useQuery<DoxProjectStatus>({
    queryKey: ['dox', 'status', projectPath],
    queryFn: () => getDoxStatus(projectPath),
    enabled: !!projectPath,
    retry: 1,
    staleTime: 30_000
  })

  const handleRunCheck = async () => {
    setCheckRunning(true)
    setCheckError(null)
    try {
      await runDoxCheck(projectPath)
      // Refresh the status panel after a successful check
      await queryClient.invalidateQueries({ queryKey: ['dox', 'status', projectPath] })
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : 'Check failed')
    } finally {
      setCheckRunning(false)
    }
  }

  // No project selected
  if (!projectPath) {
    return (
      <div className="flex items-center justify-center h-full">
        <InactiveState projectPath="" />
      </div>
    )
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <PageLoader label="Loading DocOps status..." />
      </div>
    )
  }

  // Error state
  if (isError) {
    return (
      <div className="flex items-center justify-center h-full">
        <ErrorFetchView error={error as Error} />
      </div>
    )
  }

  // Inactive project (no docops.yml)
  if (!status?.active) {
    return (
      <div className="flex items-center justify-center h-full">
        <InactiveState projectPath={projectPath} />
      </div>
    )
  }

  // Active project — render full panel
  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <Settings className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold tracking-tight">DocOps — {projectPath}</h2>
          <StatusBadge active={status.active} mode={status.mode} />
        </div>
        <div className="flex items-center gap-2">
          <Button
            aria-label="Run DocOps check"
            disabled={checkRunning}
            onClick={() => void handleRunCheck()}
            size="xs"
            variant="secondary"
          >
            {checkRunning ? (
              <>
                <RefreshCw className="size-3 animate-spin" />
                Checking…
              </>
            ) : (
              <>
                <RefreshCw className="size-3" />
                Run Check
              </>
            )}
          </Button>
          {onClose && (
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground p-1 rounded"
              aria-label="Close DocOps panel"
            >
              <XCircle className="size-4" />
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-5 space-y-5">
        {/* Check error */}
        {checkError && (
          <div className="flex items-start gap-2 px-3 py-2 rounded border border-red-500/30 bg-red-900/20 text-red-300 text-xs">
            <XCircle className="size-3 mt-0.5 shrink-0" />
            <span>{checkError}</span>
          </div>
        )}

        {/* Mode */}
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Mode
          </h3>
          <StatusBadge active={status.active} mode={status.mode} />
        </section>

        {/* Layers */}
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Layers className="size-3" /> Layers
          </h3>
          <LayerStatus layers={status.layers} />
        </section>

        {/* Markers */}
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Tag className="size-3" /> Markers
          </h3>
          <MarkersDisplay markers={status.markers} />
        </section>

        {/* Drift */}
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <AlertTriangle className="size-3" /> Drift
          </h3>
          <DriftView drift={status.drift} />
        </section>

        {/* Advisories */}
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Advisories
          </h3>
          <div className="flex items-center gap-2">
            <Badge
              className={
                status.pending_advisories > 0
                  ? 'border-amber-500/40 text-amber-300 bg-amber-900/30'
                  : 'border-muted text-muted-foreground'
              }
            >
              {status.pending_advisories}
            </Badge>
            <span className="text-xs text-muted-foreground">pending</span>
          </div>
        </section>

        {/* Last Publish */}
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Last Publish
          </h3>
          {status.last_publish ? (
            <div className="flex items-center gap-2">
              <Badge className="border-green-500/30 text-green-300 bg-green-900/30">
                {status.last_publish.pack}
              </Badge>
              <span className="text-xs text-muted-foreground">{status.last_publish.at}</span>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Never published</p>
          )}
        </section>
      </div>
    </div>
  )
}
