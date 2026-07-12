/**
 * Write Workspace quick actions + selection-aware inline edit (Slice K, see
 * go-forward plan §5). Renders as a small toolbar control next to Export in
 * write-panel.tsx's `WriteEditor`.
 *
 * MODEL-INVOCATION SEAM: every action below calls `requestOneShot()`
 * (`@/lib/oneshot`) — the existing one-off, non-conversational LLM seam the
 * review pane's commit-message generator already uses (see
 * `apps/desktop/src/store/review.ts` `generateCommitMessage`). It never
 * touches the visible chat thread, session history, or the system prompt/
 * tool list. This slice adds NO new model-calling path.
 *
 * Every REWRITE action (polish/reformat/distill/strengthen/soften/custom
 * instruction) never writes to the write project's saved file directly — it
 * always proposes a `WorkbenchChangeSet` (status `pending`) via the EXISTING
 * `createChangeSet` API (Slice A/E's mechanism, see `./api.ts`), which the
 * user reviews/accepts/applies through the EXISTING ChangeSet Review panel
 * (Slice D) and Apply action (Slice E) — nothing here bypasses that. The two
 * INFORMATIONAL actions (Explain/Critique) only display the model's response;
 * they never call `createChangeSet`.
 *
 * Fails closed: disabled with no open write project (the caller only mounts
 * this once a project is open), while a save is pending (`dirty`), and while
 * an action is already in flight.
 */
import { type RefObject, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { requestOneShot } from '@/lib/oneshot'
import { notify, notifyError } from '@/store/notifications'

import { createChangeSet } from './api'
import type { WorkbenchWriteProjectDetail } from './api'
import { workbenchStrings as s } from './strings'
import {
  applySelectionReplacement,
  buildFreeTextEditPrompt,
  buildQuickActionPrompt,
  buildWriteChangeSetInput,
  sha256Hex16,
  WRITE_QUICK_ACTIONS
} from './write-quick-actions'
import type { WriteEditScope, WriteQuickActionDef } from './write-quick-actions'

interface WriteQuickActionsBarProps {
  detail: WorkbenchWriteProjectDetail
  dirty: boolean
  textareaRef: RefObject<HTMLTextAreaElement | null>
  workspaceRoot: string
}

interface CurrentSelection {
  from: number
  scope: WriteEditScope
  text: string
  to: number
}

function readSelection(textareaRef: RefObject<HTMLTextAreaElement | null>, markdown: string): CurrentSelection {
  const el = textareaRef.current
  const from = el?.selectionStart ?? 0
  const to = el?.selectionEnd ?? 0

  if (el && to > from) {
    return { from, scope: 'selection', text: markdown.slice(from, to), to }
  }

  return { from: 0, scope: 'document', text: markdown, to: markdown.length }
}

export function WriteQuickActionsBar({ detail, dirty, textareaRef, workspaceRoot }: WriteQuickActionsBarProps) {
  const [busyId, setBusyId] = useState<null | string>(null)
  const [infoResult, setInfoResult] = useState<null | { text: string; title: string }>(null)
  const [customOpen, setCustomOpen] = useState(false)
  const [customInstruction, setCustomInstruction] = useState('')

  const busy = busyId !== null
  const disabled = busy || dirty

  const filePath = detail.activeFileRelativePath ?? `${detail.rootRelativeDir}/document.md`

  // Shared tail of every rewrite action: run the model, splice/replace,
  // hash the CURRENT SAVED content (never the possibly-unsaved draft — quick
  // actions are disabled while dirty, so `detail.markdown` is always what's
  // on disk here), and propose a ChangeSet. Never writes the file directly.
  const proposeRewrite = async (label: string, prompt: { input: string; instructions: string }, selection: CurrentSelection) => {
    setBusyId(label)

    try {
      const resultText = (await requestOneShot({ instructions: prompt.instructions, input: prompt.input })).trim()

      if (!resultText) {
        notify({ kind: 'error', title: s.writeQuickActions.failed(label), message: s.writeQuickActions.emptyModelResponse })

        return
      }

      const nextContent =
        selection.scope === 'selection'
          ? applySelectionReplacement(detail.markdown, selection.from, selection.to, resultText)
          : resultText

      const beforeHash = await sha256Hex16(detail.markdown)

      const input = buildWriteChangeSetInput({
        beforeHash,
        fileRelativePath: filePath,
        nextContent,
        summary: `${label} proposed for "${detail.title}" (${selection.scope}).`,
        title: `${label}: ${detail.title}`,
        workspaceRoot
      })

      const res = await createChangeSet(input)

      if (res.ok) {
        notify({
          kind: 'success',
          title: s.writeQuickActions.proposedTitle,
          message: s.writeQuickActions.proposedMessage(
            selection.scope === 'selection' ? s.writeQuickActions.scopeSelection : s.writeQuickActions.scopeDocument
          )
        })
      } else {
        notify({ kind: 'error', title: s.writeQuickActions.proposeFailed, message: res.message })
      }
    } catch (err) {
      notifyError(err, s.writeQuickActions.failed(label))
    } finally {
      setBusyId(null)
    }
  }

  const runInformational = async (action: WriteQuickActionDef, selection: CurrentSelection) => {
    setBusyId(action.label)

    try {
      const prompt = buildQuickActionPrompt(action, selection.text, selection.scope)
      const resultText = (await requestOneShot({ instructions: prompt.instructions, input: prompt.input })).trim()

      setInfoResult({ text: resultText || s.writeQuickActions.emptyModelResponse, title: action.label })
    } catch (err) {
      notifyError(err, s.writeQuickActions.failed(action.label))
    } finally {
      setBusyId(null)
    }
  }

  const handleQuickAction = (action: WriteQuickActionDef) => {
    if (disabled) {
      return
    }

    const selection = readSelection(textareaRef, detail.markdown)

    if (!selection.text.trim()) {
      notify({ kind: 'error', title: action.label, message: s.writeQuickActions.nothingToActOn })

      return
    }

    if (action.kind === 'informational') {
      void runInformational(action, selection)

      return
    }

    void proposeRewrite(action.label, buildQuickActionPrompt(action, selection.text, selection.scope), selection)
  }

  const handleCustomSubmit = () => {
    const instruction = customInstruction.trim()

    if (disabled || !instruction) {
      return
    }

    const selection = readSelection(textareaRef, detail.markdown)

    if (!selection.text.trim()) {
      notify({ kind: 'error', title: s.writeQuickActions.customInstruction, message: s.writeQuickActions.nothingToActOn })

      return
    }

    setCustomOpen(false)
    setCustomInstruction('')
    void proposeRewrite(
      s.writeQuickActions.customInstruction,
      buildFreeTextEditPrompt(instruction, selection.text, selection.scope),
      selection
    )
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            disabled={disabled}
            size="sm"
            title={dirty ? s.writeQuickActions.disabledDirtyTitle : undefined}
            variant="outline"
          >
            <Codicon name={busy ? 'loading' : 'sparkle'} size="0.875rem" spinning={busy} />
            {s.writeQuickActions.menuLabel}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {WRITE_QUICK_ACTIONS.map(action => (
            <DropdownMenuItem disabled={disabled} key={action.id} onSelect={() => handleQuickAction(action)}>
              {s.writeQuickActions.labels[action.id] ?? action.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem disabled={disabled} onSelect={() => setCustomOpen(true)}>
            {s.writeQuickActions.customInstruction}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog onOpenChange={next => !next && setInfoResult(null)} open={infoResult !== null}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{infoResult?.title}</DialogTitle>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-md border border-(--ui-stroke-secondary) p-3 text-sm">
            {infoResult?.text}
          </div>
          <DialogFooter>
            <Button onClick={() => setInfoResult(null)} variant="outline">
              {s.writeQuickActions.resultDialogClose}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={next => !busy && setCustomOpen(next)} open={customOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{s.writeQuickActions.customDialogTitle}</DialogTitle>
            <DialogDescription>{s.writeQuickActions.customDialogDesc}</DialogDescription>
          </DialogHeader>
          <Textarea
            className="min-h-20 font-mono text-xs"
            disabled={busy}
            onChange={event => setCustomInstruction(event.target.value)}
            placeholder={s.writeQuickActions.customPlaceholder}
            value={customInstruction}
          />
          <DialogFooter>
            <Button disabled={busy} onClick={() => setCustomOpen(false)} variant="outline">
              {s.cancel}
            </Button>
            <Button disabled={busy || !customInstruction.trim()} onClick={handleCustomSubmit} variant="default">
              <Codicon name={busy ? 'loading' : 'sparkle'} size="0.875rem" spinning={busy} />
              {busy ? s.writeQuickActions.customApplying : s.writeQuickActions.customSubmit}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
