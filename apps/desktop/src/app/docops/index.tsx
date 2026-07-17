import { useStore } from '@nanostores/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { getDoxStatus, runDoxCheck } from '@/hermes'
import { cn } from '@/lib/utils'
import {
  $projects,
  $projectScope,
  $projectTree,
  ALL_PROJECTS,
  projectWorkspacePath
} from '@/store/projects'
import { $currentCwd } from '@/store/session'
import type { DoxProjectStatus } from '@/types/hermes.ts'

import {
  Panel,
  PanelAction,
  PanelEmpty,
  PanelHeader,
  PanelMeta,
  PanelPill,
  type PanelPillTone,
  PanelSectionLabel
} from '../overlays/panel'

// ── Display helpers ────────────────────────────────────────────────────────

const MODE_LABELS: Record<string, string> = {
  code: 'Code',
  hybrid: 'Hybrid',
  ops: 'Ops'
}

function modeTone(mode: string | null | undefined): PanelPillTone {
  if (!mode) return 'muted'
  if (mode === 'code') return 'good'
  if (mode === 'hybrid') return 'warn'
  return 'muted'
}

function tierTone(tier: string): PanelPillTone {
  if (tier === 'A') return 'warn'
  if (tier === 'B' || tier === 'C') return 'bad'
  return 'muted'
}

function shortPath(path: string, max = 64): string {
  if (path.length <= max) return path
  return `…${path.slice(-(max - 1))}`
}

// ── Status body ────────────────────────────────────────────────────────────

function ActiveDocOpsBody({
  checkError,
  checkRunning,
  onRunCheck,
  status
}: {
  checkError: string | null
  checkRunning: boolean
  onRunCheck: () => void
  status: DoxProjectStatus
}) {
  const layers = [
    { key: 'contract', label: 'Contract', active: status.layers.contract },
    { key: 'ledger', label: 'Ledger', active: status.layers.ledger },
    { key: 'publish', label: 'Publish', active: status.layers.publish }
  ]

  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain pb-4 pr-1">
      {checkError ? (
        <div
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          <Codicon className="mt-0.5 shrink-0" name="error" size="0.875rem" />
          <span className="min-w-0 break-words">{checkError}</span>
        </div>
      ) : null}

      <section className="space-y-2">
        <PanelSectionLabel>Mode</PanelSectionLabel>
        <div className="flex flex-wrap items-center gap-2">
          <PanelPill tone={modeTone(status.mode)}>
            {MODE_LABELS[status.mode ?? ''] ?? status.mode ?? 'Unknown'}
          </PanelPill>
          <PanelAction
            disabled={checkRunning}
            icon={checkRunning ? 'loading~spin' : 'debug-restart'}
            onClick={onRunCheck}
          >
            {checkRunning ? 'Checking…' : 'Run Check'}
          </PanelAction>
        </div>
      </section>

      <section className="space-y-2">
        <PanelSectionLabel>Layers</PanelSectionLabel>
        <div className="flex flex-wrap gap-1.5">
          {layers.map(layer => (
            <PanelPill key={layer.key} tone={layer.active ? 'good' : 'muted'}>
              {layer.label}
              {layer.active ? ' · on' : ' · off'}
            </PanelPill>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <PanelSectionLabel>Markers</PanelSectionLabel>
        <div className="flex flex-wrap gap-1.5">
          <PanelPill tone={status.markers.docops_yml ? 'good' : 'bad'}>docops.yml</PanelPill>
          <PanelPill tone={status.markers.agents_md_header ? 'good' : 'bad'}>AGENTS.md</PanelPill>
          {status.markers.structural.map(marker => (
            <PanelPill key={marker} tone="muted">
              {marker}
            </PanelPill>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <PanelSectionLabel>Drift</PanelSectionLabel>
        {status.drift.length === 0 ? (
          <p className="text-xs text-muted-foreground/80">
            No drift detected. Use <span className="font-medium text-foreground/80">Run Check</span> or{' '}
            <code className="rounded bg-foreground/5 px-1 py-0.5 text-[0.68rem]">hermes dox check</code> for a full
            analysis.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {status.drift.map((item, i) => (
              <li
                key={`${item.path}-${item.kind}-${i}`}
                className="flex items-start gap-2 rounded-md bg-foreground/5 px-2.5 py-1.5 text-xs"
              >
                <PanelPill tone={tierTone(item.tier)}>Tier {item.tier}</PanelPill>
                <div className="min-w-0">
                  <div className="font-medium text-foreground/90">{item.path}</div>
                  <div className="text-muted-foreground/75">
                    {item.kind}
                    {item.message ? ` — ${item.message}` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <PanelSectionLabel>Advisories</PanelSectionLabel>
        <div className="flex items-center gap-2">
          <PanelPill tone={status.pending_advisories > 0 ? 'warn' : 'muted'}>
            {status.pending_advisories}
          </PanelPill>
          <span className="text-xs text-muted-foreground/80">pending</span>
        </div>
      </section>

      <section className="space-y-2">
        <PanelSectionLabel>Last publish</PanelSectionLabel>
        {status.last_publish ? (
          <PanelMeta
            rows={[
              { label: 'Pack', value: status.last_publish.pack },
              { label: 'At', value: status.last_publish.at }
            ]}
          />
        ) : (
          <p className="text-xs text-muted-foreground/80">Never published</p>
        )}
      </section>

      <section className="space-y-2">
        <PanelSectionLabel>Actions</PanelSectionLabel>
        <p className="text-xs leading-relaxed text-muted-foreground/75">
          Status is read from the project root via <code className="rounded bg-foreground/5 px-1">hermes dox status</code>
          . Checks run through the Desktop bridge (
          <code className="rounded bg-foreground/5 px-1">POST /api/dox/check</code>
          ). Scaffold with{' '}
          <code className="rounded bg-foreground/5 px-1">hermes dox init --mode hybrid</code> when markers are missing.
        </p>
        <Button
          aria-label="Run DocOps check"
          className="gap-1.5"
          disabled={checkRunning}
          onClick={onRunCheck}
          size="sm"
          variant="secondary"
        >
          <Codicon name={checkRunning ? 'loading~spin' : 'check-all'} size="0.875rem" />
          {checkRunning ? 'Checking…' : 'Run Check'}
        </Button>
      </section>
    </div>
  )
}

// ── Main panel ─────────────────────────────────────────────────────────────

export function DocOpsView({ onClose }: { onClose: () => void }) {
  const currentCwd = useStore($currentCwd)
  const projectScope = useStore($projectScope)
  const projects = useStore($projects)
  const projectTree = useStore($projectTree)
  // Resolve the DocOps target from the SIDEBAR-SCOPED project ($projectScope,
  // what `enterProject` sets), mirroring resolveNewSessionCwd: tree path first,
  // then the project list's primary workspace path. This makes a session sitting
  // in a subfolder still report the project that was `dox init`-ed. Fall back to
  // the live cwd when no project is scoped ("All projects"). The backend walks
  // parents to the nearest docops.yml, so a subfolder cwd still resolves too.
  let scopedPath = ''
  if (projectScope && projectScope !== ALL_PROJECTS) {
    const treeNode = projectTree.find(node => node.id === projectScope)
    scopedPath = (treeNode?.path || treeNode?.repos.find(repo => repo.path)?.path || '').trim()
    if (!scopedPath) {
      const listed = projects.find(proj => proj.id === projectScope)
      scopedPath = (listed ? projectWorkspacePath(listed)?.trim() : '') || ''
    }
  }
  const projectPath = scopedPath || currentCwd?.trim() || ''
  const queryClient = useQueryClient()
  const [checkRunning, setCheckRunning] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)

  const {
    data: status,
    isLoading,
    error,
    isError,
    refetch,
    isFetching
  } = useQuery<DoxProjectStatus>({
    queryKey: ['dox', 'status', projectPath],
    queryFn: () => getDoxStatus(projectPath),
    enabled: !!projectPath,
    retry: 1,
    staleTime: 30_000
  })

  const handleRunCheck = async () => {
    if (!projectPath) return
    setCheckRunning(true)
    setCheckError(null)
    try {
      await runDoxCheck(projectPath)
      await queryClient.invalidateQueries({ queryKey: ['dox', 'status', projectPath] })
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : 'Check failed')
    } finally {
      setCheckRunning(false)
    }
  }

  const handleRefresh = () => {
    setCheckError(null)
    void refetch()
  }

  const subtitle = projectPath ? shortPath(projectPath) : 'No project selected'
  const headerActions = (
    <div className="flex items-center gap-1">
      {projectPath ? (
        <>
          <PanelAction disabled={isFetching || checkRunning} icon="refresh" onClick={handleRefresh}>
            Refresh
          </PanelAction>
          <PanelAction
            disabled={checkRunning || !status?.active}
            icon={checkRunning ? 'loading~spin' : 'check-all'}
            onClick={() => void handleRunCheck()}
          >
            {checkRunning ? 'Checking…' : 'Run Check'}
          </PanelAction>
        </>
      ) : null}
    </div>
  )

  // Always host inside Panel → OverlayView so DocOps is a card over the shell
  // (sidebar + chat remain underneath), not a full-window surface. Esc / backdrop
  // / titlebar X all dismiss via onClose.
  return (
    <Panel closeLabel="Close DocOps" onClose={onClose}>
      <PanelHeader actions={headerActions} subtitle={subtitle} title="DocOps" />

      {!projectPath ? (
        <PanelEmpty
          description="Open a working directory (project) first. DocOps status is scoped to the current project root."
          icon="folder"
          title="No project selected"
        />
      ) : isLoading ? (
        <PageLoader aria-label="Loading DocOps status..." className="min-h-0 flex-1" label="Loading DocOps status..." />
      ) : isError ? (
        <PanelEmpty
          action={
            <Button onClick={handleRefresh} size="sm" variant="secondary">
              Retry
            </Button>
          }
          description={(error as Error)?.message || 'Unknown error loading DocOps status.'}
          icon="warning"
          title="Could not load DocOps status"
        />
      ) : !status?.active ? (
        <PanelEmpty
          description={
            <>
              No <code className="rounded bg-foreground/5 px-1">docops.yml</code> found under{' '}
              <span className={cn('font-medium text-foreground/85')}>{projectPath}</span>. Run{' '}
              <code className="rounded bg-foreground/5 px-1">hermes dox init</code> (code / ops / hybrid) to enable
              living documentation for this project.
            </>
          }
          icon="book"
          title="DocOps not configured"
        />
      ) : (
        <ActiveDocOpsBody
          checkError={checkError}
          checkRunning={checkRunning}
          onRunCheck={() => void handleRunCheck()}
          status={status}
        />
      )}
    </Panel>
  )
}
