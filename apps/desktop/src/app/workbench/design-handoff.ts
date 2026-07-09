import type { DesignGenerationKind } from './design-generation'

// Hermes Workbench — Design Studio "Send to code agent" handoff (Slice I,
// go-forward plan §5 Slice I — the final deferred slice, "design-to-code").
//
// *** THE ARCHITECTURAL DECISION FOR THIS SLICE *** — traced and reused, not
// reinvented: turning an approved design brief/prototype into real code is a
// multi-file, judgment-heavy coding task, not a one-shot text transform like
// Slice K's quick actions or Slice G's generation. Per Kun's own "Implement
// in code" design (github.com/KunAgent/Kun, cited in this plan's Slice M
// research note): that action ALWAYS opens a fresh, reviewable code-agent
// THREAD — never a silent, automated direct-apply. This slice follows the
// same model: it hands the design artifact to the user's EXISTING, already-
// trusted chat/agent conversation via the EXISTING new-session hand-off seam
// (`requestStartWorkSession()` in `@/store/projects`, the same mechanism the
// composer's "branch off into a new worktree" action already uses — see
// `use-composer-branch.ts`'s `openInWorktree`). `design-generation-panel.tsx`
// is the only caller; it does not call `requestOneShot()` for this (that
// seam is for Slice K/G's silent one-off text transforms, not this), and it
// builds no ChangeSet/diff/file-apply of its own — any resulting file writes
// happen through the EXISTING, separately-reviewed chat/agent tool-use path,
// once the user reviews and sends the seeded message themselves.
//
// This module is pure string-building only (no IPC, no DOM, no session
// creation) so it can be unit tested without Electron or a model — see
// design-handoff.test.ts. The actual session-creation/seed/navigate call
// lives in design-generation-panel.tsx, right next to the button that
// triggers it.

const INSTRUCTION_PREFIX = 'Implement the following design as real code in this project.'

const PROTOTYPE_NOTE =
  'It is an HTML prototype showing the intended look, layout, and interactions — use it as a ' +
  "visual/behavioral reference and build the equivalent using this project's existing stack, " +
  'components, and conventions rather than embedding this HTML verbatim.'

const BRIEF_NOTE = 'It is a design brief describing target users, key screens/flows, and the intended style direction.'

/**
 * Builds the seed message for a new chat session's first turn from a
 * generated design artifact's content — the ONLY thing this slice hands to
 * the existing chat/agent conversation. Never sent anywhere itself; the
 * caller passes the returned string to `requestStartWorkSession()` as the
 * composer draft for a fresh session.
 */
export function buildDesignHandoffMessage(kind: DesignGenerationKind, content: string): string {
  const trimmed = content.trim()

  if (kind === 'prototype') {
    return `${INSTRUCTION_PREFIX} ${PROTOTYPE_NOTE}\n\n\`\`\`html\n${trimmed}\n\`\`\``
  }

  return `${INSTRUCTION_PREFIX} ${BRIEF_NOTE}\n\n${trimmed}`
}

// Human-readable noun per generation kind, used only for the Kanban card
// title. Kept alongside buildDesignHandoffMessage so both handoff surfaces
// (code-agent + Kanban) share the same design vocabulary.
const KANBAN_CARD_NOUN: Record<DesignGenerationKind, string> = {
  brief: 'brief',
  prototype: 'prototype'
}

export interface DesignKanbanCard {
  title: string
  body: string
}

/**
 * Builds the `{ title, body }` for a "Send to Kanban" card from a generated
 * design artifact — the SECOND handoff option alongside "Send to code agent".
 *
 * Pure string-building (no IPC, no DOM, no fetch) so it is unit-testable the
 * same way `buildDesignHandoffMessage` is (see design-handoff.test.ts). The
 * body REUSES `buildDesignHandoffMessage` verbatim, so the card carries the
 * exact same "Implement this design as real code…" instruction + brief prose
 * or prototype HTML that the code-agent handoff does. The card's assignee and
 * workspace scoping are added by the POST layer (design-kanban.ts), not here.
 *
 * `requirementId` is used only to give the card a stable, identifiable title;
 * the artifact does not carry a human requirement title at this layer.
 */
export function buildDesignKanbanCard(
  kind: DesignGenerationKind,
  requirementId: string,
  content: string
): DesignKanbanCard {
  const noun = KANBAN_CARD_NOUN[kind] ?? 'design'

  return {
    title: `Implement design (${noun}): ${requirementId}`,
    body: buildDesignHandoffMessage(kind, content)
  }
}
