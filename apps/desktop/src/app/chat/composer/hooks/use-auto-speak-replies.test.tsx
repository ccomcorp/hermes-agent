import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAutoSpeakReplies } from './use-auto-speak-replies'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

type SpeakMode = 'full' | 'conversational'

type MockAtom<T> = {
  get: () => T
  set: (v: T) => void
  subscribe: (fn: (v: T) => void) => () => void
  listen: (fn: (v: T) => void) => () => void
}

function makeMockAtom<T>(initial: T): MockAtom<T> {
  let value = initial
  const listeners = new Set<(v: T) => void>()
  return {
    get: () => value,
    set: (v: T) => {
      value = v
      listeners.forEach(fn => fn(v))
    },
    subscribe: (fn: (v: T) => void) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    listen: (fn: (v: T) => void) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    }
  }
}

// vi.hoisted for vi.fn() — vi is a vitest global, available at hoist time.
const m = vi.hoisted(() => ({
  playSpeechText: vi.fn<[string, { messageId?: string; source?: string }?], Promise<boolean>>(),
  stopVoicePlayback: vi.fn()
}))

// Fresh atoms container — reassigned in beforeEach so each test gets clean atoms.
let $aa: MockAtom<boolean>
let $sm: MockAtom<SpeakMode>
let $msg: MockAtom<unknown[]>
let $vp: MockAtom<{ status: string }>

// Module mocks use getters so they always resolve to the current atoms.
vi.mock('@/lib/voice-playback', () => ({
  playSpeechText: m.playSpeechText,
  stopVoicePlayback: m.stopVoicePlayback
}))

vi.mock('@/store/voice-prefs', () => ({
  get $autoSpeakReplies() { return $aa },
  get $speakMode() { return $sm }
}))

vi.mock('@/store/session', () => ({
  get $messages() { return $msg }
}))

vi.mock('@/store/voice-playback', () => ({
  get $voicePlayback() { return $vp }
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve pending microtasks so async effects flush. */
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

type Reply = { id: string; pending: boolean; spoken_reply?: string | null; text: string }

function setup(options: {
  conversationActive?: boolean
  pendingReply?: () => Reply | null
  sessionId?: string | null
}) {
  const markSpokenFn = vi.fn()

  const hookResult = renderHook(
    ({ conversationActive }: { conversationActive: boolean }) =>
      useAutoSpeakReplies({
        conversationActive,
        failureLabel: 'auto-speak-error',
        markSpoken: markSpokenFn,
        pendingReply: options.pendingReply ?? (() => null),
        sessionId: options.sessionId ?? null
      }),
    {
      initialProps: {
        conversationActive: options.conversationActive ?? false
      }
    }
  )

  return { hookResult, markSpoken: markSpokenFn }
}

/** Enable auto-speak and wait for the effect to subscribe. */
async function enableAutoSpeak() {
  await act(async () => {
    $aa.set(true)
    await tick()
  })
}

/** Fire the $messages subscribe callback to trigger speakLatest. */
function fireMessagesUpdate() {
  $msg.set([{ id: String(Math.random()) }])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAutoSpeakReplies', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Fresh atoms per test — no stale subscribers
    $aa = makeMockAtom(false)
    $sm = makeMockAtom('full')
    $msg = makeMockAtom([])
    $vp = makeMockAtom({ status: 'idle' })
    m.playSpeechText.mockResolvedValue(true)
  })

  // ---- spoken_reply fallback (EVAL-VDP-005b) ----

  it('EVAL-VDP-005b: uses spoken_reply when speakMode is "conversational" and spoken_reply is present', async () => {
    $sm.set('conversational')
    const reply: Reply = {
      id: 'resp-1',
      pending: false,
      text: 'Full verbose response...',
      spoken_reply: 'Short spoken reply'
    }

    setup({ pendingReply: () => reply })
    await enableAutoSpeak()

    await act(async () => {
      fireMessagesUpdate()
      await tick()
      await tick()
    })

    expect(m.playSpeechText).toHaveBeenCalledWith('Short spoken reply', {
      messageId: 'resp-1',
      source: 'read-aloud'
    })
  })

  it('EVAL-VDP-005b-fallback: short synthesis when spoken_reply is null (conversational mode)', async () => {
    $sm.set('conversational')
    const reply: Reply = {
      id: 'resp-2',
      pending: false,
      text: 'Full text fallback. Extra paragraphs stay on screen only.',
      spoken_reply: null
    }

    setup({ pendingReply: () => reply })
    await enableAutoSpeak()

    await act(async () => {
      fireMessagesUpdate()
      await tick()
      await tick()
    })

    expect(m.playSpeechText).toHaveBeenCalled()
    const spoken = m.playSpeechText.mock.calls[0][0] as string
    expect(spoken.toLowerCase()).toContain('full text fallback')
    expect(spoken.length).toBeLessThanOrEqual(reply.text.length)
  })

  it('EVAL-VDP-005b-fallback: synthesizes short take when spoken_reply is empty (never essay dump)', async () => {
    $sm.set('conversational')
    const reply: Reply = {
      id: 'resp-3',
      pending: false,
      text: 'Full text for empty spoken_reply. More detail would follow in the written answer.',
      spoken_reply: ''
    }

    setup({ pendingReply: () => reply })
    await enableAutoSpeak()

    await act(async () => {
      fireMessagesUpdate()
      await tick()
      await tick()
    })

    expect(m.playSpeechText).toHaveBeenCalled()
    const spoken = m.playSpeechText.mock.calls[0][0] as string
    expect(spoken.length).toBeLessThan(reply.text.length + 5)
    expect(spoken.toLowerCase()).toContain('full text for empty')
    expect(m.playSpeechText).toHaveBeenCalledWith(spoken, {
      messageId: 'resp-3',
      source: 'read-aloud'
    })
  })

  it('EVAL-VDP-005b: uses full text when speakMode is "all" regardless of spoken_reply', async () => {
    $sm.set('full')
    const reply: Reply = {
      id: 'resp-4',
      pending: false,
      text: 'Full text for all mode',
      spoken_reply: 'Should be ignored'
    }

    setup({ pendingReply: () => reply })
    await enableAutoSpeak()

    await act(async () => {
      fireMessagesUpdate()
      await tick()
      await tick()
    })

    expect(m.playSpeechText).toHaveBeenCalledWith('Full text for all mode', {
      messageId: 'resp-4',
      source: 'read-aloud'
    })
  })

  // ---- Hold-until-idle ----

  it('EVAL-VDP-P2a: queues reply when playback is busy (hold-until-idle)', async () => {
    // $voicePlayback is NOT idle → speakLatest returns early
    $vp.set({ status: 'playing' })

    const reply: Reply = {
      id: 'resp-5',
      pending: false,
      text: 'Should not speak now'
    }

    setup({ pendingReply: () => reply })
    await enableAutoSpeak()

    await act(async () => {
      fireMessagesUpdate()
      await tick()
      await tick()
    })

    expect(m.playSpeechText).not.toHaveBeenCalled()

    // Set playback idle → $voicePlayback.listen triggers speakLatest
    await act(async () => {
      $vp.set({ status: 'idle' })
      await tick()
      await tick()
    })

    expect(m.playSpeechText).toHaveBeenCalledWith('Should not speak now', {
      messageId: 'resp-5',
      source: 'read-aloud'
    })
  })

  // ---- Conversation-inactive guard ----

  it('EVAL-VDP-P2a: does NOT auto-speak when voice conversation is active', async () => {
    const reply: Reply = {
      id: 'resp-6',
      pending: false,
      text: 'Should not speak'
    }

    setup({
      pendingReply: () => reply,
      conversationActive: true
    })

    await enableAutoSpeak()

    await act(async () => {
      fireMessagesUpdate()
      await tick()
      await tick()
    })

    expect(m.playSpeechText).not.toHaveBeenCalled()
  })

  // ---- Does nothing when auto-speak is off ----

  it('does nothing when autoSpeakSetting is off', async () => {
    const reply: Reply = {
      id: 'resp-7',
      pending: false,
      text: 'Should not speak'
    }

    setup({ pendingReply: () => reply })

    // Never enable auto-speak; useStore returns false

    await act(async () => {
      fireMessagesUpdate()
      await tick()
    })

    expect(m.playSpeechText).not.toHaveBeenCalled()
  })

  // ---- Dedupe ----

  it('dedupes: calls markSpoken() to consume the reply', async () => {
    const reply: Reply = {
      id: 'resp-8',
      pending: false,
      text: 'Deduped reply'
    }

    let callCount = 0
    setup({
      pendingReply: () => {
        if (callCount === 0) {
          callCount++
          return reply
        }
        return null
      }
    })

    await enableAutoSpeak()

    // First fire → speakLatest runs, calls markSpoken, speaks
    await act(async () => {
      fireMessagesUpdate()
      await tick()
      await tick()
    })

    expect(m.playSpeechText).toHaveBeenCalledTimes(1)

    // Second fire → speakLatest runs, pendingReply returns null → no speak
    await act(async () => {
      fireMessagesUpdate()
      await tick()
      await tick()
    })

    expect(m.playSpeechText).toHaveBeenCalledTimes(1)
  })

  // ---- Empty/null reply ----

  it('does not crash when reply is null', async () => {
    setup({ pendingReply: () => null })
    await enableAutoSpeak()

    await act(async () => {
      fireMessagesUpdate()
      await tick()
    })

    expect(m.playSpeechText).not.toHaveBeenCalled()
  })

  it('does not crash when reply has empty text and no spoken_reply', async () => {
    const reply: Reply = {
      id: 'resp-9',
      pending: false,
      text: '',
      spoken_reply: null
    }

    setup({ pendingReply: () => reply })
    await enableAutoSpeak()

    await act(async () => {
      fireMessagesUpdate()
      await tick()
      await tick()
    })

    // Nothing to say — skip TTS rather than playing an empty clip
    expect(m.playSpeechText).not.toHaveBeenCalled()
  })
})
