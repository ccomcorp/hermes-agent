import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useVoiceConversation } from './use-voice-conversation'

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted so vi.mock factory can reference them (vi.mock is hoisted)
// ---------------------------------------------------------------------------

const { playSpeechText, stopVoicePlayback } = vi.hoisted(() => ({
  playSpeechText: vi.fn<(text: string, options?: { source: string }) => Promise<boolean>>(),
  stopVoicePlayback: vi.fn<() => void>()
}))

vi.mock('@/lib/voice-playback', () => ({ playSpeechText, stopVoicePlayback }))

const { notify, notifyError } = vi.hoisted(() => ({
  notify: vi.fn(),
  notifyError: vi.fn()
}))

vi.mock('@/store/notifications', () => ({ notify, notifyError }))

// Simulate a mic handle we can control
const { micStart, micStop, micCancel, micHook } = vi.hoisted(() => {
  const start = vi.fn<() => Promise<void>>()
  const stop = vi.fn<() => Promise<{ audio: Blob; durationMs: number; heardSpeech: boolean } | null>>()
  const cancel = vi.fn<() => void>()

  const useMicRecorderFn = () => ({ handle: { start, stop, cancel }, level: 0 })

  return { micStart: start, micStop: stop, micCancel: cancel, micHook: useMicRecorderFn }
})

vi.mock('./use-mic-recorder', () => ({
  useMicRecorder: micHook
}))

const t = {
  notifications: {
    voice: {
      playbackFailed: 'TTS error',
      transcriptionFailed: 'STT error',
      microphoneFailed: 'Mic error',
      couldNotStartSession: 'Start error',
      unavailable: 'No STT',
      configureSpeechToText: 'Configure STT'
    }
  }
}

vi.mock('@/i18n', () => ({ useI18n: () => ({ t }) }))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve pending microtasks so async effects flush. */
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

const mockAudio = () => new Blob(['fake-audio-data'], { type: 'audio/webm' })

interface VoiceTestOptions {
  busy?: boolean
  enabled?: boolean
  onSubmit?: () => Promise<void> | void
  onTranscribeAudio?: ((audio: Blob) => Promise<string>) | null
  pendingResponse?: () => {
    id: string
    pending: boolean
    spoken_reply?: string | null
    text: string
  } | null
  consumePendingResponse?: () => void
}

function setupVoice(options: VoiceTestOptions = {}) {
  return renderHook(
    ({ busy, enabled }: { busy: boolean; enabled: boolean }) =>
      useVoiceConversation({
        busy,
        enabled,
        onSubmit: options.onSubmit ?? vi.fn(),
        onTranscribeAudio: options.onTranscribeAudio ?? undefined,
        pendingResponse: options.pendingResponse ?? (() => null),
        consumePendingResponse: options.consumePendingResponse ?? vi.fn()
      }),
    { initialProps: { busy: options.busy ?? false, enabled: options.enabled ?? false } }
  )
}

/** Create a completed reply with an id and text. */
const reply = (id: string, text: string, spoken_reply?: string | null) => ({
  id,
  pending: false,
  spoken_reply: spoken_reply ?? null,
  text
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useVoiceConversation — race: end during speak', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: mic starts OK, TTS resolves fast
    micStart.mockResolvedValue(undefined)
    playSpeechText.mockResolvedValue(true)
    // Default: mic stop returns no speech → won't transcribe unless we override
    micStop.mockResolvedValue(null)
    // Reset the mock hook to return a fresh handle each time
    // (vi.hoisted objects are shared, so we rely on mockResolvedValue)
  })

  // ---- EVAL-VDP-007: end() during TTS playback stops speech and leaves mic disarmed ----

  it('EVAL-VDP-007: end() during TTS playback stops speech and leaves mic disarmed', async () => {
    // Hold playSpeechText in-flight so we can race end() against it
    let resolveTts!: (value: boolean) => void
    playSpeechText.mockImplementation(
      () =>
        new Promise<boolean>(r => {
          resolveTts = r
        })
    )

    // Mic stop returns heard speech, and transcribe returns real text
    micStop.mockResolvedValue({ audio: mockAudio(), durationMs: 500, heardSpeech: true })

    const onTranscribe = vi.fn().mockResolvedValue('hello world')
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const pending = reply('msg-1', 'Response text')
    const pendingResponse = vi.fn(() => pending)
    const consumePending = vi.fn()

    const { result, rerender } = setupVoice({
      pendingResponse,
      consumePendingResponse: consumePending,
      onSubmit,
      onTranscribeAudio: onTranscribe
    })

    // Enable → start() → startListening() → mic.start() → status='listening'
    await act(async () => {
      rerender({ busy: false, enabled: true })
      await tick()
    })

    // After start() completes, mic start should have been called
    expect(micStart).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('listening')

    // Simulate user speech → stopTurn() → handleTurn(true)
    await act(async () => {
      result.current.stopTurn()
      await tick()
      await tick()
      await tick()
    })

    // handleTurn → transcribe → submit → status='thinking' → loop detects
    // awaitingSpokenResponseRef → pendingResponse() → speak()
    // Now the loop should have called playSpeechText (it's in-flight)
    expect(playSpeechText).toHaveBeenCalledWith('Response text', { source: 'voice-conversation' })

    // Immediately end the conversation while TTS is still playing
    act(() => {
      result.current.end()
    })

    // end() should have called stopVoicePlayback
    expect(stopVoicePlayback).toHaveBeenCalled()

    // Now resolve the in-flight TTS
    await act(async () => {
      resolveTts(true)
      await tick()
      await tick()
      await tick()
    })

    // After end(), status must be idle — NOT re-armed to listening
    expect(result.current.status).toBe('idle')
    // micHandle should NOT have been started again (cancelledRef prevents re-arm)
    expect(micStart).toHaveBeenCalledTimes(1)
  })

  // ---- EVAL-VDP-007b: end via enabled→false while speak is in-flight ----

  it('EVAL-VDP-007b: setting enabled=false while TTS is playing stops speech safely', async () => {
    let resolveTts!: (value: boolean) => void
    playSpeechText.mockImplementation(
      () =>
        new Promise<boolean>(r => {
          resolveTts = r
        })
    )

    micStop.mockResolvedValue({ audio: mockAudio(), durationMs: 500, heardSpeech: true })

    const onTranscribe = vi.fn().mockResolvedValue('hi there')
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const pending = reply('msg-2', 'Another response')
    const pendingResponse = vi.fn(() => pending)
    const consumePending = vi.fn()

    const { result, rerender } = setupVoice({
      pendingResponse,
      consumePendingResponse: consumePending,
      onSubmit,
      onTranscribeAudio: onTranscribe
    })

    // Enable → mic starts → user speaks → loop speaks
    await act(async () => {
      rerender({ busy: false, enabled: true })
      await tick()
    })

    await act(async () => {
      result.current.stopTurn()
      await tick()
      await tick()
      await tick()
    })

    expect(playSpeechText).toHaveBeenCalled()

    // Disable the voice conversation (simulates toggling off / ending)
    await act(async () => {
      rerender({ busy: false, enabled: false })
      await tick()
    })

    // The enabled→false effect calls end(), which calls stopVoicePlayback
    expect(stopVoicePlayback).toHaveBeenCalled()

    // Resolve in-flight TTS
    await act(async () => {
      resolveTts(true)
      await tick()
      await tick()
      await tick()
    })

    // Status must be idle after end, not re-arming
    expect(result.current.status).toBe('idle')
  })

  // ---- EVAL-VDP-008: normal speak completion re-arms the mic ----

  it('EVAL-VDP-008: after normal speak completion the loop re-arms for next turn', async () => {
    // TTS resolves normally (no in-flight hold)
    playSpeechText.mockResolvedValue(true)
    micStop.mockResolvedValue({ audio: mockAudio(), durationMs: 500, heardSpeech: true })

    const onTranscribe = vi.fn().mockResolvedValue('hello')
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const pending = reply('msg-3', 'Third reply')
    const pendingResponse = vi.fn(() => pending)
    const consumePending = vi.fn()

    const { result, rerender } = setupVoice({
      pendingResponse,
      consumePendingResponse: consumePending,
      onSubmit,
      onTranscribeAudio: onTranscribe
    })

    // Enable → mic starts
    await act(async () => {
      rerender({ busy: false, enabled: true })
      await tick()
    })

    expect(result.current.status).toBe('listening')

    // User speaks → transcription → submit → speak → idle → re-arm
    await act(async () => {
      result.current.stopTurn()
      await tick()
      await tick()
      await tick()
      await tick()
      await tick()
    })

    // After a normal speak → idle transition, the mic should re-arm
    expect(result.current.status).toBe('listening')
    // startListening called once for initial start, once for re-arm
    expect(micStart).toHaveBeenCalledTimes(2)
  })

  // ---- EVAL-VDP-008b: end then re-enable starts cleanly (cancelledRef reset) ----

  it('EVAL-VDP-008b: after end() a fresh enable starts cleanly (cancelledRef reset)', async () => {
    micStop.mockResolvedValue({ audio: mockAudio(), durationMs: 500, heardSpeech: true })
    playSpeechText.mockResolvedValue(true)

    const onTranscribe = vi.fn().mockResolvedValue('hello')
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const pending = reply('msg-4', 'Fresh start')
    const pendingResponse = vi.fn(() => pending)
    const consumePending = vi.fn()

    const { result, rerender } = setupVoice({
      pendingResponse,
      consumePendingResponse: consumePending,
      onSubmit,
      onTranscribeAudio: onTranscribe
    })

    await act(async () => {
      rerender({ busy: false, enabled: true })
      await tick()
    })

    await act(async () => {
      result.current.stopTurn()
      await tick()
      await tick()
      await tick()
      await tick()
      await tick()
    })

    // End conversation
    act(() => {
      result.current.end()
    })

    expect(result.current.status).toBe('idle')
    expect(stopVoicePlayback).toHaveBeenCalled()

    // Re-enable fresh — disabled then enabled triggers start()
    await act(async () => {
      rerender({ busy: false, enabled: false })
      await tick()
    })

    // Clear the mic mock count from the first enable+speak cycle
    micStart.mockClear()

    await act(async () => {
      rerender({ busy: false, enabled: true })
      await tick()
      await tick()
      await tick()
      await tick()
    })

    // Should be listening after fresh enable (cancelledRef was reset in startListening)
    expect(result.current.status).toBe('listening')
    expect(micStart).toHaveBeenCalled()
  })
})
