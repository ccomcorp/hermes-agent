import { describe, expect, it } from 'vitest'

import {
  firstSpeakableSentences,
  hasCompleteSentence,
  resolveSpeakText,
  sanitizeTextForSpeech
} from './speech-text'

describe('resolveSpeakText conversational', () => {
  it('never falls back to a long essay when spoken_reply is missing', () => {
    const essay = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} is long.`).join(' ')
    const out = resolveSpeakText({ mode: 'conversational', displayText: essay })
    expect(out.length).toBeLessThanOrEqual(5000)
    expect(out.length).toBeGreaterThan(80)
    // Caps sentences but allows a real multi-sentence take
    expect(out.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(21)
  })

  it('prefers spoken_reply when short', () => {
    const out = resolveSpeakText({
      mode: 'conversational',
      spokenReply: 'Here is the short take.',
      displayText: '## Huge\n\n| a | b |\n| 1 | 2 |\n\nLots of detail.'
    })
    expect(out).toBe('Here is the short take.')
  })

  it('drops table markup from synthesis', () => {
    const out = firstSpeakableSentences('Title\n| a | b |\n| 1 | 2 |\nReal point lands here.')
    expect(out).not.toContain('|')
    expect(out.toLowerCase()).toContain('real point')
  })

  it('detects complete sentences for progressive start', () => {
    expect(hasCompleteSentence('Still writing')).toBe(false)
    expect(hasCompleteSentence('First thought is ready. More coming')).toBe(true)
  })

  it('full mode sanitizes but keeps more content', () => {
    const text = 'Hello **world**. `code` stays as code.'
    expect(sanitizeTextForSpeech(text)).toContain('Hello world')
    const full = resolveSpeakText({ mode: 'full', displayText: text })
    expect(full.toLowerCase()).toContain('hello world')
  })
})
