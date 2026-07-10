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
 *
 * *** DESIGN-TO-CODE HANDOFF (Slice I, go-forward plan §5 Slice I — the final
 * slice): the viewer dialog's "Send to code agent" action (brief AND
 * prototype artifacts) hands the open artifact's content to the user's
 * EXISTING chat/agent conversation, NOT a new code-generation pipeline. It
 * builds a seed message (`./design-handoff.ts`, pure logic, unit tested) and
 * calls the EXISTING `requestStartWorkSession()` seam (`@/store/projects`) —
 * the same "open a fresh session anchored at a path, carrying a draft as its
 * first turn" mechanism the composer's "branch off into a new worktree"
 * action already uses (see `use-composer-branch.ts`'s `openInWorktree`). This
 * creates/navigates to a new session scoped to `workspaceRoot` and PREFILLS
 * its composer with the seed message via `requestComposerInsert` — it does
 * NOT auto-submit; the user reviews and sends it themselves, exactly like
 * Kun's "Implement in code" opening a fresh, reviewable thread rather than a
 * silent direct-apply. No `requestOneShot()` call, no new IPC channel, no
 * ChangeSet/diff/file-apply logic is added by this slice — any resulting file
 * writes happen through the existing, separately-reviewed chat/agent tool-use
 * path once the seeded turn runs.
 */
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { requestOneShot } from '@/lib/oneshot'
import { notify, notifyError } from '@/store/notifications'
import { requestStartWorkSession } from '@/store/projects'
import { $connection } from '@/store/session'

import { PanelEmpty } from '../overlays/panel'

import {
  createDesignArtifact,
  linkKanbanCardToRequirement,
  listDesignArtifacts,
  readDesignArtifact,
  readRequirement
} from './api'
import { buildDesignGenerationPrompt, defaultDesignSettingsForGeneration, stripCodeFence } from './design-generation'
import type { DesignGenerationKind } from './design-generation'
import { buildDesignHandoffMessage } from './design-handoff'
import {
  getKanbanCard,
  isTerminalKanbanStatus,
  type KanbanCardStatus,
  kanbanStatusBadgeVariant,
  sendDesignToKanban
} from './design-kanban'
import { DesignPrototypePreview } from './design-prototype-preview'
import {
  $workbenchActiveRequirementId,
  $workbenchActiveRequirementTrace,
  $workbenchDesignSettings,
  addLinkedKanbanCardId
} from './store'
import { workbenchStrings as s } from './strings'

type DesignArtifactDetail = WorkbenchDesignArtifact & { content: string }

// Source/preview toggle for the viewer dialog below — 'preview' is only ever
// reachable for `kind: 'prototype'` artifacts AND only when
// `WorkbenchDesignSettings.sandboxHtmlPreview` is true (see `previewAllowed`
// in the component). Every other combination falls back to 'source', which
// is always available.
type ArtifactViewTab = 'preview' | 'source'

// Light auto-poll cadence for linked-card live status. 5s keeps the list
// feeling live while the orchestrator builds without hammering the gateway
// (one GET per linked card per tick). Polling stops entirely once every linked
// card is terminal (done/archived) — see the poller effect below.
const KANBAN_STATUS_POLL_MS = 5000

interface DesignGenerationPanelProps {
  workspaceRoot: string
}

export function DesignGenerationPanel({ workspaceRoot }: DesignGenerationPanelProps) {
  const requirementId = useStore($workbenchActiveRequirementId)
  const settings = useStore($workbenchDesignSettings)
  // The open requirement's trace, mirrored into the store by requirement-panel.tsx
  // (a sibling — see store.ts). This panel reads its `linkedKanbanCardIds` for
  // both the pre-send idempotency guard and the visible linked-cards list. Only
  // trusted when it belongs to the open requirement (guarded below); older
  // traces may predate the field, so it's always read as `?? []`.
  const activeTrace = useStore($workbenchActiveRequirementTrace)

  const linkedKanbanCardIds = useMemo(
    () =>
      activeTrace && activeTrace.requirementId === requirementId ? (activeTrace.linkedKanbanCardIds ?? []) : [],
    [activeTrace, requirementId]
  )

  // Live gateway connection (baseUrl + token). Only read here to tell a single
  // unreachable card ("status unavailable") apart from a wholly disconnected
  // gateway ("gateway not connected") in the linked-cards note.
  const connection = useStore($connection)

  const [artifacts, setArtifacts] = useState<WorkbenchDesignArtifact[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [busyKind, setBusyKind] = useState<DesignGenerationKind | null>(null)
  const [viewing, setViewing] = useState<DesignArtifactDetail | null>(null)
  const [viewTab, setViewTab] = useState<ArtifactViewTab>('source')
  const [kanbanBusy, setKanbanBusy] = useState(false)
  // Live status per linked card id. `null` = fetched but unavailable (a card
  // still absent from the map has simply not been fetched yet). Never throws:
  // getKanbanCard fully degrades to null, so this map never carries an error.
  const [cardStatuses, setCardStatuses] = useState<Record<string, KanbanCardStatus | null>>({})

  // Fetch every linked card's live status in parallel (one GET each) and
  // replace the map. Identity changes only when the linked-id set changes, so
  // it is a stable dep for the effects below.
  const refreshCardStatuses = useCallback(async () => {
    if (linkedKanbanCardIds.length === 0) {
      return
    }

    const entries = await Promise.all(
      linkedKanbanCardIds.map(async (id): Promise<[string, KanbanCardStatus | null]> => [id, await getKanbanCard(id)])
    )

    const next: Record<string, KanbanCardStatus | null> = {}

    for (const [id, status] of entries) {
      next[id] = status
    }

    setCardStatuses(next)
  }, [linkedKanbanCardIds])

  // Keep polling while ANY linked card is non-terminal OR not yet known /
  // unreachable (a transient hiccup should recover). All terminal → stop.
  const shouldPollCardStatuses = useMemo(
    () =>
      linkedKanbanCardIds.some(id => {
        const st = cardStatuses[id]

        return !st || !isTerminalKanbanStatus(st.status)
      }),
    [linkedKanbanCardIds, cardStatuses]
  )

  // Fetch once on mount and whenever the linked-id set changes. Clears the map
  // when there are no linked cards so stale statuses never linger.
  useEffect(() => {
    if (linkedKanbanCardIds.length === 0) {
      setCardStatuses({})

      return
    }

    void refreshCardStatuses()
  }, [linkedKanbanCardIds, refreshCardStatuses])

  // Light auto-poll — only exists while polling is warranted, and is always
  // cleared on unmount or when the last card goes terminal (no leaked timer).
  useEffect(() => {
    if (!shouldPollCardStatuses) {
      return
    }

    const interval = setInterval(() => void refreshCardStatuses(), KANBAN_STATUS_POLL_MS)

    return () => clearInterval(interval)
  }, [shouldPollCardStatuses, refreshCardStatuses])

  // Fail closed: the Preview tab only ever exists for a 'prototype' artifact,
  // and only when the workspace has explicitly turned on
  // WorkbenchDesignSettings.sandboxHtmlPreview. A missing settings document
  // (null — not yet saved for this workspace) is treated the same as "off".
  const previewAllowed = viewing?.kind === 'prototype' && settings?.sandboxHtmlPreview === true

  // "Send to code agent" (Slice I) only makes sense for the two generation
  // kinds this slice actually ships UI for — 'design_system'/'quality_report'
  // have no generation entry point yet, so fail closed on those rather than
  // guessing what a handoff for them should contain.
  const handoffAllowed = viewing?.kind === 'brief' || viewing?.kind === 'prototype'

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

  // Hands the open artifact to the user's existing chat/agent conversation —
  // see the module header and design-handoff.ts for why this is the entire
  // mechanism (no model call, no ChangeSet, no new session-creation code: it
  // reuses requestStartWorkSession(), the composer's existing "open a fresh
  // session anchored at a path, carrying a draft" hand-off). Fails closed via
  // `handoffAllowed`/`viewing` — with nothing open, or an artifact kind this
  // slice doesn't support, this is a no-op.
  const handleSendToCodeAgent = useCallback(() => {
    if (!viewing || (viewing.kind !== 'brief' && viewing.kind !== 'prototype')) {
      return
    }

    requestStartWorkSession(workspaceRoot, buildDesignHandoffMessage(viewing.kind, viewing.content))
    setViewing(null)
  }, [viewing, workspaceRoot])

  // "Send to Kanban" (additive sibling of "Send to code agent") — creates a
  // card on the multi-agent board assigned to the dev orchestrator via the
  // existing kanban plugin endpoint (see design-kanban.ts), then records that
  // card id back into the requirement's trace (the two-way traceability
  // backlink). Same brief/prototype gating; a null gateway connection fails
  // closed inside sendDesignToKanban with a clear error (no card).
  //
  // Three distinct outcomes, never conflated:
  //   • card created + link ok  → success notify, refresh the linked-cards list
  //   • card created + link FAILED → a DISTINCT soft warning (the card is NOT
  //     lost, NOT re-sent — the backlink is best-effort, fail-open)
  //   • no card (empty id / throw) → sendDesignToKanban throws, error notify
  //
  // Idempotency guard: if this design's requirement already has ≥1 linked card,
  // confirm before sending again — a double-send spawns two orchestrator agents
  // editing the same real project dir. Declining creates no card.
  const handleSendToKanban = useCallback(async () => {
    if (!viewing || (viewing.kind !== 'brief' && viewing.kind !== 'prototype') || kanbanBusy) {
      return
    }

    const targetRequirementId = viewing.requirementId

    if (linkedKanbanCardIds.length > 0 && !window.confirm(s.designGeneration.kanbanResendConfirm)) {
      return
    }

    setKanbanBusy(true)

    try {
      // Guaranteed non-empty (sendDesignToKanban throws on a missing card id).
      const cardId = await sendDesignToKanban({
        workspaceRoot,
        requirementId: targetRequirementId,
        kind: viewing.kind,
        content: viewing.content
      })

      const linkRes = await linkKanbanCardToRequirement(workspaceRoot, targetRequirementId, cardId)

      if (linkRes.ok) {
        addLinkedKanbanCardId(targetRequirementId, cardId)
        notify({ kind: 'success', title: s.designGeneration.sentToKanban, message: '' })
      } else {
        // Card exists on the board; only the backlink failed. Surface it as a
        // distinct soft warning — never silent, never a re-POST.
        notify({
          kind: 'warning',
          title: s.designGeneration.sentToKanbanLinkFailed,
          message: s.designGeneration.sentToKanbanLinkFailedDetail(cardId, linkRes.message)
        })
      }

      setViewing(null)
    } catch (err) {
      notifyError(err, s.designGeneration.sendToKanbanFailed)
    } finally {
      setKanbanBusy(false)
    }
  }, [kanbanBusy, linkedKanbanCardIds, viewing, workspaceRoot])

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

      {/* Linked Kanban cards (Kanban traceability — live status) — the visible
          "requirement → its cards" list. Reads the open requirement's
          trace.linkedKanbanCardIds (mirrored into the store by
          requirement-panel.tsx); refreshed optimistically after a successful
          send via addLinkedKanbanCardId. Each card fetches its LIVE status from
          the kanban plugin (cardStatuses, light-polled above) and renders a
          status badge + title + assignee; a card whose status couldn't be read
          degrades to a muted note and is NEVER hidden. Hidden only when there
          are no linked cards at all. */}
      {linkedKanbanCardIds.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-(--ui-stroke-tertiary) pt-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[0.7rem] font-semibold text-muted-foreground/80">
              {s.designGeneration.linkedKanbanHeading} ({linkedKanbanCardIds.length})
            </h3>
            <button
              className="flex items-center gap-1 rounded-[0.25rem] px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground/70 hover:text-foreground"
              onClick={() => void refreshCardStatuses()}
              title={s.designGeneration.kanbanRefresh}
              type="button"
            >
              <Codicon name="refresh" size="0.7rem" />
              {s.designGeneration.kanbanRefresh}
            </button>
          </div>
          <ul className="flex flex-col gap-0.5">
            {linkedKanbanCardIds.map(cardId => {
              // `undefined` = not fetched yet; `null` = fetched but unavailable.
              const card = cardStatuses[cardId]
              const known = card != null

              return (
                <li
                  className="flex items-center gap-1.5 text-[0.65rem] text-muted-foreground/70"
                  key={cardId}
                  title={cardId}
                >
                  <Codicon name="project" size="0.7rem" />
                  {known ? (
                    <Badge variant={kanbanStatusBadgeVariant(card.status)}>
                      {s.designGeneration.kanbanStatusLabels[card.status] ?? card.status}
                    </Badge>
                  ) : (
                    <Badge variant="muted">
                      {connection
                        ? s.designGeneration.kanbanStatusUnavailable
                        : s.designGeneration.kanbanStatusGatewayOffline}
                    </Badge>
                  )}
                  {card?.title && <span className="truncate">{card.title}</span>}
                  {card?.assignee && <span className="shrink-0 text-muted-foreground/50">{card.assignee}</span>}
                  <span className="ml-auto shrink-0 truncate font-mono text-muted-foreground/50">{cardId}</span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

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
            {handoffAllowed && (
              <Button onClick={handleSendToCodeAgent} variant="default">
                <Codicon name="arrow-right" size="0.8125rem" />
                {s.designGeneration.sendToCodeAgent}
              </Button>
            )}
            {handoffAllowed && (
              <Button disabled={kanbanBusy} onClick={() => void handleSendToKanban()} variant="outline">
                <Codicon name={kanbanBusy ? 'loading' : 'project'} size="0.8125rem" spinning={kanbanBusy} />
                {kanbanBusy ? s.designGeneration.sendingToKanban : s.designGeneration.sendToKanban}
              </Button>
            )}
            <Button onClick={() => setViewing(null)} variant="outline">
              {s.designGeneration.sourceDialogClose}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
