import type { WorkbenchDesignSettings } from '@hermes/shared'
import { describe, expect, it } from 'vitest'

import {
  buildDesignBriefPrompt,
  buildDesignGenerationPrompt,
  buildDesignPrototypePrompt,
  defaultDesignSettingsForGeneration,
  stripCodeFence
} from './design-generation'

const BASE_SETTINGS: WorkbenchDesignSettings = {
  enabled: true,
  defaultViewport: 'desktop',
  designSystemPreset: 'shadcn',
  brandColor: '#3366ff',
  tone: ['confident', 'minimal'],
  radius: 'soft',
  density: 'cozy',
  fontStyle: 'geometric',
  stackHint: 'react + tailwind',
  sandboxHtmlPreview: true
}

describe('buildDesignBriefPrompt', () => {
  it('asks for prose only, never HTML/code, and includes the requirement markdown as input', () => {
    const prompt = buildDesignBriefPrompt('# Requirement\n\nUsers need X.', BASE_SETTINGS)

    expect(prompt.input).toBe('# Requirement\n\nUsers need X.')
    expect(prompt.instructions).toMatch(/design brief/i)
    expect(prompt.instructions).toMatch(/target users/i)
    expect(prompt.instructions).toMatch(/key screens/i)
    expect(prompt.instructions).toMatch(/Do not write any HTML or code/i)
    expect(prompt.instructions).not.toContain('Users need X.')
  })

  it('injects the design settings as context (preset, brand color, tone, density, radius, font, viewport)', () => {
    const prompt = buildDesignBriefPrompt('Some requirement.', BASE_SETTINGS)

    expect(prompt.instructions).toContain('shadcn')
    expect(prompt.instructions).toContain('#3366ff')
    expect(prompt.instructions).toContain('confident, minimal')
    expect(prompt.instructions).toContain('cozy')
    expect(prompt.instructions).toContain('soft')
    expect(prompt.instructions).toContain('geometric')
    expect(prompt.instructions).toContain('desktop')
  })

  it('omits optional settings fields entirely when unset', () => {
    const minimal: WorkbenchDesignSettings = defaultDesignSettingsForGeneration()
    const prompt = buildDesignBriefPrompt('req', minimal)

    expect(prompt.instructions).not.toContain('Brand color')
    expect(prompt.instructions).not.toContain('Corner radius')
    expect(prompt.instructions).not.toContain('Typography style')
  })
})

describe('buildDesignPrototypePrompt', () => {
  it('requires a complete self-contained HTML document with no external resources', () => {
    const prompt = buildDesignPrototypePrompt('# Requirement', BASE_SETTINGS)

    expect(prompt.instructions).toMatch(/self-contained HTML document/i)
    expect(prompt.instructions).toMatch(/inline `<style>`/i)
    expect(prompt.instructions).toMatch(/Do NOT fetch or reference any external resource/i)
    expect(prompt.instructions).toMatch(/no `<script src="http/i)
    expect(prompt.instructions).toMatch(/no preamble/i)
  })

  it('includes the same design-context block as the brief prompt', () => {
    const prompt = buildDesignPrototypePrompt('req', BASE_SETTINGS)

    expect(prompt.instructions).toContain('shadcn')
    expect(prompt.instructions).toContain('#3366ff')
  })
})

describe('buildDesignGenerationPrompt', () => {
  it('dispatches to the brief builder for kind "brief"', () => {
    const prompt = buildDesignGenerationPrompt('brief', 'req', BASE_SETTINGS)

    expect(prompt.instructions).toMatch(/design brief/i)
  })

  it('dispatches to the prototype builder for kind "prototype"', () => {
    const prompt = buildDesignGenerationPrompt('prototype', 'req', BASE_SETTINGS)

    expect(prompt.instructions).toMatch(/self-contained HTML document/i)
  })
})

describe('stripCodeFence', () => {
  it('strips a ```html fenced response down to its inner content', () => {
    const fenced = '```html\n<!doctype html><html></html>\n```'

    expect(stripCodeFence(fenced)).toBe('<!doctype html><html></html>')
  })

  it('strips a bare ``` fence with no language tag', () => {
    const fenced = '```\n<!doctype html><html></html>\n```'

    expect(stripCodeFence(fenced)).toBe('<!doctype html><html></html>')
  })

  it('returns the trimmed text unchanged when there is no fence', () => {
    const raw = '  <!doctype html><html></html>  '

    expect(stripCodeFence(raw)).toBe('<!doctype html><html></html>')
  })
})

describe('defaultDesignSettingsForGeneration', () => {
  it('matches the backend default shape (enabled, desktop viewport, none preset, empty tone, sandbox on)', () => {
    const defaults = defaultDesignSettingsForGeneration()

    expect(defaults.enabled).toBe(true)
    expect(defaults.defaultViewport).toBe('desktop')
    expect(defaults.designSystemPreset).toBe('none')
    expect(defaults.tone).toEqual([])
    expect(defaults.sandboxHtmlPreview).toBe(true)
  })
})
