import type { WorkbenchDesignArtifact } from '@hermes/shared'
/**
 * Design Studio generation — Slice G (go-forward plan §5 Slice G), sibling of
 * `design-settings-panel.tsx` (Slice F, settings only).
 *
 * Owns the "Generate brief" / "Generate prototype" actions and the generated-
 * artifact list, tied to whichever requirement is currently open
 * (`$workbenchActiveRequirementId` — the same store atom requirement-panel.tsx
 * and plan-panel.tsx already use to scope themselves to the open requirement).
 * Fails closed: with no open requirement, this section renders nothing (no
 * generation is available).
 *
 * MODEL INVOCATION: reuses the EXISTING stateless `requestOneShot()` seam
 * (`@/lib/oneshot`) — the same mechanism Slice K's write quick actions use
 * (see write-quick-actions-panel.tsx). No new model-calling path is added.
 *
 * STORAGE: a generated artifact is a NEW, Workbench-owned artifact under
 * `.hermes/workbench/designs/` — same storage class as Requirements/Plans,
 * stored directly via `createDesignArtifact` (api.ts). Unlike Slice K's write
 * rewrites, this never goes through the ChangeSet apply/review pipeline: it
 * doesn't touch the user's real project files, so there's nothing to review
 * as a diff. A failed model call surfaces an error notification and never
 * calls `createDesignArtifact` — there is no partial/corrupt artifact record.
 *
 * *** CRITICAL SAFETY BOUNDARY: this file NEVER renders or executes generated
 * HTML. No iframe, no webview, no dangerouslySetInnerHTML. A generated
 * `prototype` artifact's HTML is shown as raw, read-only SOURCE TEXT inside a
 * plain <pre> block below — never parsed as a live document. Sandboxed live
 * rendering is Slice H, separate and not built here. ***
 */
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { requestOneShot } from '@/lib/oneshot'
import { notify, notifyError } from '@/store/notifications'

import { PanelEmpty } from '../overlays/panel'

import { createDesignArtifact, listDesignArtifacts, readDesignArtifact, readRequirement } from './api'
import { buildDesignGenerationPrompt, defaultDesignSettingsForGeneration, stripCodeFence } from './design-generation'
import type { DesignGenerationKind } from './design-generation'
import { $workbenchActiveRequirementId, $workbenchDesignSettings } from './store'
import { workbenchStrings as s } from './strings'

type DesignArtifactDetail = WorkbenchDesignArtifact & { content: string }

interface DesignGenerationPanelProps {
  workspaceRoot: string
}

export function DesignGenerationPanel({ workspaceRoot }: DesignGenerationPanelProps) {
  const requirementId = useStore($workbenchActiveRequirementId)
  const settings = useStore($workbenchDesignSettings)

  const [artifacts, setArtifacts] = useState<WorkbenchDesignArtifact[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [busyKind, setBusyKind] = useState<DesignGenerationKind | null>(null)
  const [viewing, setViewing] = useState<DesignArtifactDetail | null>(null)

  const loadArtifacts = useCallback(
    async (reqId: string) => {
      setListLoading(true)

      try {
        const res = await listDesignArtifacts(workspaceRoot, reqId)

        if (res.ok) {
          setArtifacts(res.value)
        } else {
          notify({ kind: 'error', title: s.designGeneration.listFailed, message: res.message })
        }
      } catch (err) {
        notifyError(err, s.designGeneration.listFailed)
      } finally {
        setListLoading(false)
      }
    },
    [workspaceRoot]
  )

  useEffect(() => {
    if (requirementId) {
      void loadArtifacts(requirementId)
    } else {
      setArtifacts([])
    }
  }, [loadArtifacts, requirementId])

  const handleGenerate = useCallback(
    async (kind: DesignGenerationKind) => {
      if (!requirementId || busyKind) {
        return
      }

      setBusyKind(kind)

      try {
        const reqRes = await readRequirement(workspaceRoot, requirementId)

        if (!reqRes.ok) {
          notify({ kind: 'error', title: s.designGeneration.failed(kind), message: reqRes.message })

          return
        }

        const effectiveSettings = settings ?? defaultDesignSettingsForGeneration()
        const prompt = buildDesignGenerationPrompt(kind, reqRes.value.markdown, effectiveSettings)
        const resultText = (await requestOneShot({ instructions: prompt.instructions, input: prompt.input })).trim()

        if (!resultText) {
          notify({ kind: 'error', title: s.designGeneration.failed(kind), message: s.designGeneration.emptyModelResponse })

          return
        }

        const content = kind === 'prototype' ? stripCodeFence(resultText) : resultText

        const res = await createDesignArtifact({ workspaceRoot, requirementId, kind, content })

        if (res.ok) {
          notify({ kind: 'success', title: s.designGeneration.generatedTitle(kind), message: '' })
          void loadArtifacts(requirementId)
        } else {
          notify({ kind: 'error', title: s.designGeneration.failed(kind), message: res.message })
        }
      } catch (err) {
        notifyError(err, s.designGeneration.failed(kind))
      } finally {
        setBusyKind(null)
      }
    },
    [busyKind, loadArtifacts, requirementId, settings, workspaceRoot]
  )

  const openArtifact = useCallback(
    async (artifactId: string) => {
      try {
        const res = await readDesignArtifact(workspaceRoot, artifactId)

        if (res.ok) {
          setViewing(res.value)
        } else {
          notify({ kind: 'error', title: s.designGeneration.readFailed, message: res.message })
        }
      } catch (err) {
        notifyError(err, s.designGeneration.readFailed)
      }
    },
    [workspaceRoot]
  )

  if (!requirementId) {
    return null
  }

  const busy = busyKind !== null

  return (
    <div className="flex min-h-0 flex-col gap-2 border-t border-(--ui-stroke-tertiary) pt-3">
      <h2 className="text-xs font-semibold text-foreground">{s.designGeneration.heading}</h2>

      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => void handleGenerate('brief')} size="sm" variant="outline">
          <Codicon name={busyKind === 'brief' ? 'loading' : 'sparkle'} size="0.8125rem" spinning={busyKind === 'brief'} />
          {s.designGeneration.generateBrief}
        </Button>
        <Button disabled={busy} onClick={() => void handleGenerate('prototype')} size="sm" variant="outline">
          <Codicon
            name={busyKind === 'prototype' ? 'loading' : 'sparkle'}
            size="0.8125rem"
            spinning={busyKind === 'prototype'}
          />
          {s.designGeneration.generatePrototype}
        </Button>
      </div>

      <div className="max-h-48 min-h-0 overflow-y-auto">
        {listLoading ? (
          <p className="text-xs text-muted-foreground/70">{s.designGeneration.loading}</p>
        ) : artifacts.length === 0 ? (
          <PanelEmpty description={s.designGeneration.emptyDesc} icon="note" title={s.designGeneration.emptyTitle} />
        ) : (
          <ul className="flex flex-col gap-1">
            {artifacts.map(artifact => (
              <li key={artifact.id}>
                <button
                  className="flex w-full items-center justify-between gap-2 rounded-md border border-(--ui-stroke-secondary) px-2 py-1 text-left text-xs text-foreground hover:bg-(--ui-control-hover-background)"
                  onClick={() => void openArtifact(artifact.id)}
                  type="button"
                >
                  <span className="font-medium">{s.designGeneration.kindLabels[artifact.kind] ?? artifact.kind}</span>
                  <span className="text-[0.65rem] text-muted-foreground/70">
                    {new Date(artifact.createdAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Read-only SOURCE TEXT viewer — a <pre> block only. This never uses
          dangerouslySetInnerHTML, an <iframe>, or a <webview>: a generated
          `prototype` artifact's HTML is displayed as plain text, never parsed
          or rendered as a live document. See module header. */}
      <Dialog onOpenChange={next => !next && setViewing(null)} open={viewing !== null}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{viewing ? (s.designGeneration.kindLabels[viewing.kind] ?? viewing.kind) : ''}</DialogTitle>
          </DialogHeader>
          {viewing?.kind === 'prototype' && (
            <p className="text-[0.7rem] text-muted-foreground/70">{s.designGeneration.prototypeSourceHint}</p>
          )}
          <pre className="max-h-96 overflow-auto rounded-md border border-(--ui-stroke-secondary) p-3 text-xs whitespace-pre-wrap">
            {viewing?.content}
          </pre>
          <DialogFooter>
            <Button onClick={() => setViewing(null)} variant="outline">
              {s.designGeneration.sourceDialogClose}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
