import type { WorkbenchChangedFile, WorkbenchChangeSource } from '@hermes/shared'

// Hermes Workbench — Write Workspace quick actions + inline edit (Slice K).
//
// MODEL-INVOCATION SEAM (the key architectural decision for this slice): this
// module never calls a model itself, and this slice adds NO new IPC channel
// or model-calling path. Every quick action and every inline edit sends its
// prompt through the EXISTING one-shot LLM seam —
// `requestOneShot()` in `apps/desktop/src/lib/oneshot.ts`, which calls the
// gateway RPC `llm.oneshot` already wired to `agent/oneshot.py`'s
// `run_oneshot()`. That seam already does exactly what this slice needs: a
// single, stateless model call that runs OUTSIDE the visible chat
// conversation — no session, no message-history append, no prompt-cache
// break — and it already ships in this codebase for precisely this "small
// generative chore" class of work (see `generateCommitMessage` in
// `apps/desktop/src/store/review.ts`, the review pane's commit-message
// generator, the direct precedent this slice follows). See
// `write-quick-actions-panel.tsx` for the actual `requestOneShot` call site.
//
// Every REWRITE action (polish/reformat/distill/strengthen/soften/free-text
// edit) produces a proposed `WorkbenchChangeSet` — never a direct write to
// the write project's saved file. The two INFORMATIONAL actions
// (explain/critique) return prose for on-screen display only; they never
// build or send a ChangeSet.
//
// Everything in this file is pure and synchronous/async-without-side-effects
// (no IPC, no DOM, no React) so it can be unit tested without a real model or
// a real Electron main process — see write-quick-actions.test.ts.

export type WriteQuickActionId = 'critique' | 'distill' | 'explain' | 'polish' | 'reformat' | 'soften' | 'strengthen'

export type WriteQuickActionKind = 'informational' | 'rewrite'

export type WriteEditScope = 'document' | 'selection'

export interface WriteQuickActionDef {
  buildInstructions: (scopeLabel: string) => string
  id: WriteQuickActionId
  kind: WriteQuickActionKind
  label: string
}

const REWRITE_SUFFIX =
  'Return ONLY the revised text, with no preamble, commentary, explanation, or markdown code fences.'

// Order here is the order shown in the quick-actions menu (go-forward plan
// §5 Slice K's named action set, verbatim).
export const WRITE_QUICK_ACTIONS: WriteQuickActionDef[] = [
  {
    buildInstructions: scopeLabel =>
      `Polish the following ${scopeLabel} for clarity, flow, and correctness, preserving its original meaning and structure. ${REWRITE_SUFFIX}`,
    id: 'polish',
    kind: 'rewrite',
    label: 'Polish'
  },
  {
    buildInstructions: scopeLabel =>
      `Explain the following ${scopeLabel} in plain language: what it says, and any notable structure, claims, or ambiguity. Do not rewrite it — respond with an explanation only, no code fences.`,
    id: 'explain',
    kind: 'informational',
    label: 'Explain'
  },
  {
    buildInstructions: scopeLabel =>
      `Reformat the following ${scopeLabel}'s structure and Markdown (headings, lists, spacing) for readability, without changing its wording or meaning. ${REWRITE_SUFFIX}`,
    id: 'reformat',
    kind: 'rewrite',
    label: 'Reformat'
  },
  {
    buildInstructions: scopeLabel =>
      `Distill the following ${scopeLabel} down to its most essential points, removing redundancy while preserving all key meaning. ${REWRITE_SUFFIX}`,
    id: 'distill',
    kind: 'rewrite',
    label: 'Distill'
  },
  {
    buildInstructions: scopeLabel =>
      `Strengthen the following ${scopeLabel}'s argument and word choice to make it more confident and persuasive, preserving its meaning and structure. ${REWRITE_SUFFIX}`,
    id: 'strengthen',
    kind: 'rewrite',
    label: 'Strengthen'
  },
  {
    buildInstructions: scopeLabel =>
      `Soften the tone of the following ${scopeLabel} to be gentler and more diplomatic, preserving its meaning and structure. ${REWRITE_SUFFIX}`,
    id: 'soften',
    kind: 'rewrite',
    label: 'Soften'
  },
  {
    buildInstructions: scopeLabel =>
      `Critique the following ${scopeLabel}: identify weaknesses in clarity, structure, argument, or correctness, and suggest specific improvements. Do not rewrite it — respond with a critique only, no code fences.`,
    id: 'critique',
    kind: 'informational',
    label: 'Critique'
  }
]

export function findWriteQuickAction(id: WriteQuickActionId): WriteQuickActionDef {
  const action = WRITE_QUICK_ACTIONS.find(entry => entry.id === id)

  if (!action) {
    throw new Error(`Unknown write quick action: ${id}`)
  }

  return action
}

function scopeLabelFor(scope: WriteEditScope): string {
  return scope === 'selection' ? 'selected excerpt' : 'document'
}

export interface WriteModelPrompt {
  input: string
  instructions: string
}

export function buildQuickActionPrompt(action: WriteQuickActionDef, text: string, scope: WriteEditScope): WriteModelPrompt {
  return { input: text, instructions: action.buildInstructions(scopeLabelFor(scope)) }
}

// Selection-aware inline edit via a free-text instruction (e.g. "make this
// more formal"), same model-invocation seam as the named quick actions —
// this is always a rewrite, never informational.
export function buildFreeTextEditPrompt(instruction: string, text: string, scope: WriteEditScope): WriteModelPrompt {
  const trimmed = instruction.trim()

  return {
    input: text,
    instructions:
      `Edit the following ${scopeLabelFor(scope)} per this instruction: "${trimmed}". ` +
      `Preserve everything not relevant to the instruction, and keep the original formatting conventions. ${REWRITE_SUFFIX}`
  }
}

// Splices a rewritten selection back into the full document. `from`/`to` are
// clamped to the document's current bounds so a stale selection (e.g. the
// document changed length between reading the selection and the model's
// reply landing) can never throw or silently corrupt content outside the
// original range.
export function applySelectionReplacement(original: string, from: number, to: number, replacement: string): string {
  const start = Math.max(0, Math.min(from, original.length))
  const end = Math.max(start, Math.min(to, original.length))

  return original.slice(0, start) + replacement + original.slice(end)
}

// Matches the backend's `contentHash()` in `workbench-artifacts.cjs`
// bit-for-bit: SHA-256 of the UTF-8-encoded content, lowercase hex, first 16
// characters. This makes a changeset's `beforeHash` byte-identical to what
// `workbench-changeset-apply.cjs`'s conflict guard recomputes at apply time
// (`currentHash !== file.beforeHash` refuses the write as a conflict — see
// that file's `contentHash` re-use). Uses the standard Web Crypto API
// (`crypto.subtle`, available in the renderer with no Node integration and
// in the Node test runtime) rather than a new IPC round-trip to main.
export async function sha256Hex16(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content)
  const digest = await crypto.subtle.digest('SHA-256', bytes)

  const hex = Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')

  return hex.slice(0, 16)
}

export interface BuildWriteChangeSetParams {
  beforeHash: string
  fileRelativePath: string
  nextContent: string
  summary: string
  title: string
  workspaceRoot: string
}

// Structurally matches `CreateWorkbenchChangeSetInput` in `./api` — kept as
// a local, dependency-light type here (rather than importing `./api`) so
// this module stays a pure logic module with no ambient `window` reference
// anywhere in its import graph.
export interface WriteChangeSetInput {
  files: WorkbenchChangedFile[]
  source: WorkbenchChangeSource
  summary: string
  title: string
  workspaceRoot: string
}

// Builds the `createChangeSet` request for one proposed rewrite — ALWAYS a
// single file entry targeting the write project's own on-disk path
// (`WorkbenchWriteProject.activeFileRelativePath`, workspace-relative), with
// `diff` set to the full literal next-content. Slice E's apply path
// (`workbench-changeset-apply.cjs` `isUnifiedDiffText`) treats any
// non-unified-diff `diff` string as the file's complete replacement content,
// so handing it full content here (rather than a computed patch) is the
// simplest, correct choice — this is the ONLY place in this slice that
// shapes a ChangeSet, and it never writes to disk itself:
// `write-quick-actions-panel.tsx` hands this straight to the EXISTING
// `createChangeSet` API (Slice A/E's mechanism), never a new write path.
export function buildWriteChangeSetInput(params: BuildWriteChangeSetParams): WriteChangeSetInput {
  return {
    files: [
      {
        beforeHash: params.beforeHash,
        diff: params.nextContent,
        path: params.fileRelativePath,
        status: 'pending'
      }
    ],
    source: 'write_inline_edit',
    summary: params.summary,
    title: params.title,
    workspaceRoot: params.workspaceRoot
  }
}
