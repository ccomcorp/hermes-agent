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
 * *** SAFETY BOUNDARY (updated for Slice H): the read-only SOURCE TEXT view
 * below (a plain <pre> block, never dangerouslySetInnerHTML) remains the
 * default and is never removed. Slice H (go-forward plan §5 Slice H) adds a
 * SEPARATE, additional "Preview" view for `kind: 'prototype'` artifacts only,
 * which renders the HTML live inside a sandboxed <iframe srcDoc> (see
 * `./design-prototype-preview.tsx` for the exact sandbox attribute and
 * reasoning) — no webview, still no dangerouslySetInnerHTML anywhere in this
 * file. The preview is available ONLY when the workspace's
 * `WorkbenchDesignSettings.sandboxHtmlPreview` is `true`; otherwise the
 * Preview toggle is disabled with a hint pointing at Design settings — it
 * never silently renders. ***
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
import { DesignPrototypePreview } from './design-prototype-preview'
import { $workbenchActiveRequirementId, $workbenchDesignSettings } from './store'
import { workbenchStrings as s } from './strings'

type DesignArtifactDetail = WorkbenchDesignArtifact & { content: string }

// Source/preview toggle for the viewer dialog below — 'preview' is only ever
// reachable for `kind: 'prototype'` artifacts AND only when
// `WorkbenchDesignSettings.sandboxHtmlPreview` is true (see `previewAllowed`
// in the component). Every other combination falls back to 'source', which
// is always available.
type ArtifactViewTab = 'preview' | 'source'

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
  const [viewTab, setViewTab] = useState<ArtifactViewTab>('source')

  // Fail closed: the Preview tab only ever exists for a 'prototype' artifact,
  // and only when the workspace has explicitly turned on
  // WorkbenchDesignSettings.sandboxHtmlPreview. A missing settings document
  // (null — not yet saved for this workspace) is treated the same as "off".
  const previewAllowed = viewing?.kind === 'prototype' && settings?.sandboxHtmlPreview === true

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
          // Always open on Source — never remember a prior artifact's
          // Preview selection (fail closed rather than assuming the newly
          // opened artifact should render live).
          setViewTab('source')
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

      {/* Viewer dialog: read-only SOURCE TEXT (a <pre> block, unchanged from
          Slice G) is always available and is the default tab. For
          `kind: 'prototype'` artifacts ONLY, and only when the workspace's
          WorkbenchDesignSettings.sandboxHtmlPreview is true, a second
          "Preview" tab renders the HTML live inside a sandboxed
          <iframe srcDoc> (see design-prototype-preview.tsx). Neither tab ever
          uses dangerouslySetInnerHTML or a <webview>. */}
      <Dialog onOpenChange={next => !next && setViewing(null)} open={viewing !== null}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{viewing ? (s.designGeneration.kindLabels[viewing.kind] ?? viewing.kind) : ''}</DialogTitle>
          </DialogHeader>

          {viewing?.kind === 'prototype' && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-0.5 rounded-md border border-(--ui-stroke-secondary) p-0.5">
                <button
                  className={
                    viewTab === 'source'
                      ? 'rounded-[0.25rem] bg-(--ui-control-active-background) px-2 py-0.5 text-[0.68rem] font-medium text-foreground'
                      : 'rounded-[0.25rem] px-2 py-0.5 text-[0.68rem] font-medium text-muted-foreground/70 hover:text-foreground'
                  }
                  onClick={() => setViewTab('source')}
                  type="button"
                >
                  {s.designGeneration.viewSource}
                </button>
                <button
                  className={
                    viewTab === 'preview' && previewAllowed
                      ? 'rounded-[0.25rem] bg-(--ui-control-active-background) px-2 py-0.5 text-[0.68rem] font-medium text-foreground'
                      : 'rounded-[0.25rem] px-2 py-0.5 text-[0.68rem] font-medium text-muted-foreground/40 cursor-not-allowed'
                  }
                  disabled={!previewAllowed}
                  onClick={() => previewAllowed && setViewTab('preview')}
                  title={previewAllowed ? undefined : s.designGeneration.previewDisabledHint}
                  type="button"
                >
                  {s.designGeneration.viewPreview}
                </button>
              </div>
              {!previewAllowed && (
                <span className="text-[0.65rem] text-muted-foreground/60">{s.designGeneration.previewDisabledHint}</span>
              )}
            </div>
          )}

          {viewing?.kind === 'prototype' && (viewTab === 'source' || !previewAllowed) && (
            <p className="text-[0.7rem] text-muted-foreground/70">{s.designGeneration.prototypeSourceHint}</p>
          )}

          {viewTab === 'preview' && previewAllowed && viewing ? (
            <DesignPrototypePreview html={viewing.content} />
          ) : (
            <pre className="max-h-96 overflow-auto rounded-md border border-(--ui-stroke-secondary) p-3 text-xs whitespace-pre-wrap">
              {viewing?.content}
            </pre>
          )}

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
