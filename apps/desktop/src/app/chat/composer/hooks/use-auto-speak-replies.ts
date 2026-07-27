import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'

import { resolveSpeakText } from '@/lib/speech-text'
import { playSpeechText } from '@/lib/voice-playback'
import { ownsAmbientCue } from '@/store/ambient'
import { notifyError } from '@/store/notifications'
import { $messages } from '@/store/session'
import { $voicePlayback } from '@/store/voice-playback'
import { $autoSpeakReplies, $speakMode } from '@/store/voice-prefs'

interface AutoSpeakReply {
  id: string
  pending: boolean
  spoken_reply?: string | null
  text: string
}

interface UseAutoSpeakReplies {
  conversationActive: boolean
  failureLabel: string
  /** Mark the current last reply spoken — shared dedupe with the conversation consumer. */
  markSpoken: () => void
  /** Latest completed assistant reply, or null; `pending` true while still streaming. */
  pendingReply: () => AutoSpeakReply | null
  /** Re-arm on session switch so opening a chat never reads its existing last reply. */
  sessionId: string | null | undefined
}

/**
 * Pure-TTS auto-speak: when `voice.auto_tts` is on, read each completed assistant
 * turn aloud — no dictation, no conversation loop. Stays off while a full voice
 * conversation runs (it speaks replies itself) and never overlaps clips.
 *
 * Honours `voice.speak_mode`: conversational speaks a short synthesis (spoken_reply
 * or first sentences) — never the full essay. Full mode reads the complete reply.
 */
export function useAutoSpeakReplies({
  conversationActive,
  failureLabel,
  markSpoken,
  pendingReply,
  sessionId
}: UseAutoSpeakReplies) {
  const enabled = useStore($autoSpeakReplies)
  const speakMode = useStore($speakMode)
  const latest = useRef({ conversationActive, failureLabel, markSpoken, pendingReply })
  latest.current = { conversationActive, failureLabel, markSpoken, pendingReply }

  useEffect(() => {
    if (!enabled) {
      return undefined
    }

    // Don't read whatever reply already sits at the bottom when the toggle flips
    // on (or a chat opens) — consume it so only later replies are spoken.
    latest.current.markSpoken()

    const speakLatest = () => {
      const { conversationActive, failureLabel, markSpoken, pendingReply } = latest.current

      if (conversationActive || $voicePlayback.get().status !== 'idle') {
        return
      }

      const reply = pendingReply()

      if (!reply || reply.pending) {
        return
      }

      markSpoken()

      const mode = $speakMode.get() === 'conversational' ? 'conversational' : 'full'

      const text = resolveSpeakText({
        mode,
        spokenReply: reply.spoken_reply,
        displayText: reply.text
      })

      if (!text) {
        return
      }

      // Only one window voices a given reply when the same chat is open in
      // several (reply.id is the shared backend message id). markSpoken already
      // ran in every window, so peers just stay quiet.
      void ownsAmbientCue(`speak:${reply.id}`).then(owns => {
        if (owns) {
          void playSpeechText(text, { messageId: reply.id, source: 'read-aloud' }).catch(error =>
            notifyError(error, failureLabel)
          )
        }
      })
    }

    // Re-check on a reply completing ($messages) and on the prior clip ending
    // ($voicePlayback → idle), which frees us to read the next held reply.
    const stops = [$messages.subscribe(speakLatest), $voicePlayback.listen(speakLatest)]

    return () => stops.forEach(f => f())
  }, [enabled, sessionId])
}
