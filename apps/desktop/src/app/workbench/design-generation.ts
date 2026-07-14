import type { WorkbenchDesignSettings } from '@hermes/shared'

// Hermes Workbench — Design Studio generation (Slice G, go-forward plan §5).
//
// MODEL-INVOCATION SEAM: this module never calls a model itself and adds NO
// new IPC channel or model-calling path. `design-generation-panel.tsx` calls
// the EXISTING stateless `requestOneShot()` seam (`@/lib/oneshot`) — the same
// mechanism Slice K's write quick actions already established (see
// `write-quick-actions.ts`'s header comment and `generateCommitMessage` in
// `apps/desktop/src/store/review.ts`, the original precedent). This module is
// pure prompt-building logic only, so it can be unit tested without a real
// model or Electron main process (see design-generation.test.ts).
//
// SAFETY BOUNDARY: this module only ever produces TEXT — a Markdown design
// brief, or a complete HTML document as a STRING. Nothing here renders,
// parses-as-a-document, or executes the generated HTML; see
// `design-generation-panel.tsx`'s read-only `<pre>` display for the generated
// prototype's SOURCE. Sandboxed live rendering is Slice H, a separate,
// not-yet-started, safety-critical piece of work — out of scope here.
//
// PROMPT STRUCTURE — own design, informed by (not copied from) Kun's Design
// mode (github.com/KunAgent/Kun, docs/DESIGN_MODE.md §10): Kun's "design
// context" (brand color, tone, design-system preset, structured tokens —
// radius/density/font — plus free-form guidelines) is injected into every
// design-generation turn, and Kun appends a fixed "craft baseline"
// (`DESIGN_CRAFT_LINES`) anti-AI-slop rubric to every generation prompt:
// avoid cream/sand backgrounds, purple-to-blue gradients, bounce easing,
// nested cards, low-contrast gray-on-tint text; verify contrast; provide a
// `prefers-reduced-motion` fallback; use a real type scale and one spacing
// scale. This module mirrors both ideas structurally (a settings-derived
// design-context block, plus a similarly-scoped craft-baseline paragraph)
// using its own wording — Kun's exact prompt strings are not published in its
// docs, only the rubric's contents (§10 of the doc above) and the fact that
// design context is injected (§2/§10).

export type DesignGenerationKind = 'brief' | 'prototype'

export interface DesignModelPrompt {
  input: string
  instructions: string
}

// Mirrors Kun's DESIGN_CRAFT_LINES anti-AI-slop rubric (see module header) in
// intent, not in exact wording — Kun's own prompt strings are not published.
const CRAFT_BASELINE =
  'Avoid generic "AI slop" visual defaults: no cream/sand backgrounds, no purple-to-blue ' +
  'gradients, no bouncy/elastic easing, no cards nested inside cards, no low-contrast ' +
  'gray-on-tint text. Use a real, limited type scale and a single consistent spacing scale. ' +
  'Verify text/background contrast is readable. Where interaction or animation is used, ' +
  'respect `prefers-reduced-motion`.'

// Renders the workspace's WorkbenchDesignSettings into a short text block —
// this module's analogue of Kun's "design context" injection (§10).
function describeDesignSettings(settings: WorkbenchDesignSettings): string {
  const lines: string[] = [`Design system preset: ${settings.designSystemPreset}`]

  if (settings.brandColor) {
    lines.push(`Brand color: ${settings.brandColor}`)
  }

  if (settings.tone.length > 0) {
    lines.push(`Tone: ${settings.tone.join(', ')}`)
  }

  if (settings.density) {
    lines.push(`Layout density: ${settings.density}`)
  }

  if (settings.radius) {
    lines.push(`Corner radius: ${settings.radius}`)
  }

  if (settings.fontStyle) {
    lines.push(`Typography style: ${settings.fontStyle}`)
  }

  lines.push(`Target viewport: ${settings.defaultViewport}`)

  if (settings.stackHint) {
    lines.push(`Implementation stack hint (context only — do not generate real application code here): ${settings.stackHint}`)
  }

  return lines.join('\n')
}

export function buildDesignBriefPrompt(requirementMarkdown: string, settings: WorkbenchDesignSettings): DesignModelPrompt {
  const instructions =
    'You are a product designer writing a design brief for the requirement given below. ' +
    'Write prose (Markdown) covering: target users, key screens/flows, and a style direction ' +
    '(look and feel, tone, layout approach) informed by the design context below. ' +
    'Do not write any HTML or code — this is a prose brief only.\n\n' +
    `Design context:\n${describeDesignSettings(settings)}\n\n${CRAFT_BASELINE}\n\n` +
    'Return ONLY the design brief in Markdown, with no preamble or commentary outside the brief itself.'

  return { input: requirementMarkdown, instructions }
}

export function buildDesignPrototypePrompt(requirementMarkdown: string, settings: WorkbenchDesignSettings): DesignModelPrompt {
  const instructions =
    'You are a product designer producing a single-file interactive HTML prototype for the ' +
    'requirement given below. Produce ONE complete, self-contained HTML document: a full ' +
    '`<html>...</html>` document with inline `<style>` for all styling. Do NOT fetch or ' +
    'reference any external resource — no external stylesheets, fonts, images, or scripts ' +
    '(no `<link rel="stylesheet" href="http...">`, no `<script src="http...">`). Any inline ' +
    'script must not attempt network access. Inform the visual direction with the design ' +
    `context below.\n\nDesign context:\n${describeDesignSettings(settings)}\n\n${CRAFT_BASELINE}\n\n` +
    'Return ONLY the HTML document, starting with `<!doctype html>`, with no preamble, ' +
    'commentary, or Markdown code fences around it.'

  return { input: requirementMarkdown, instructions }
}

export function buildDesignGenerationPrompt(
  kind: DesignGenerationKind,
  requirementMarkdown: string,
  settings: WorkbenchDesignSettings
): DesignModelPrompt {
  return kind === 'brief'
    ? buildDesignBriefPrompt(requirementMarkdown, settings)
    : buildDesignPrototypePrompt(requirementMarkdown, settings)
}

// Strips a single leading/trailing Markdown code fence (```html ... ``` or
// ``` ... ```) if the model wrapped its response in one despite being asked
// not to. Pure string handling only — this never parses the content as
// HTML/DOM and never executes anything; it exists so a still-fenced response
// doesn't get persisted with literal backtick fences as part of the "HTML"
// artifact file.
export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenceMatch = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(trimmed)

  return fenceMatch ? fenceMatch[1].trim() : trimmed
}

// Default settings mirroring workbench-artifacts.cjs's `defaultDesignSettings()`
// — used when generation is triggered before Design Settings (Slice F) have
// ever been saved for this workspace, so generation still has a sensible
// design context instead of failing closed on a null settings object.
export function defaultDesignSettingsForGeneration(): WorkbenchDesignSettings {
  return {
    enabled: true,
    defaultViewport: 'desktop',
    designSystemPreset: 'none',
    tone: [],
    sandboxHtmlPreview: true
  }
}
