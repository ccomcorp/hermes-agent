const EMOJI_RE = /(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|[\u{FE0F}\u{200D}]|[\u{E0020}-\u{E007F}])+/gu

const FENCED_CODE_RE = /```[\s\S]*?(?:```|$)/g
const INLINE_CODE_RE = /`([^`]+)`/g
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g
const PARAGRAPH_BREAK_RE = /[ \t]*\n{2,}[ \t]*/g
const SOFT_BREAK_RE = /[ \t]*\n[ \t]*/g

const THINKING_PREFIX_RE =
  /^\s*(?:\([^)\n]{1,48}\)\s*)?(?:processing|thinking|reasoning|analyzing|pondering|contemplating|musing|cogitating|ruminating|deliberating|mulling|reflecting|computing|synthesizing|formulating|brainstorming)\.\.\.\s*/i

const URL_RE = /\bhttps?:\/\/\S+/gi

/** Hard cap for conversational TTS — long spoken take, not unbounded essay. */
export const CONVERSATIONAL_SPEAK_MAX_CHARS = 5000

/** How many sentences to allow in a progressive / fallback spoken take. */
export const CONVERSATIONAL_SPEAK_MAX_SENTENCES = 20

function normalizeLineBreaks(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/(\p{L})-\n(\p{L})/gu, '$1$2')
    .replace(PARAGRAPH_BREAK_RE, '. ')
    .replace(SOFT_BREAK_RE, ' ')
}

export function sanitizeTextForSpeech(text: string): string {
  // Drop table rows before we collapse newlines into spaces
  const withoutTables = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(line => {
      const s = line.trim()

      if (!s) {return true}

      if (s.startsWith('|') && s.endsWith('|')) {return false}

      if ((s.match(/\|/g) || []).length >= 2) {return false}

      return true
    })
    .join('\n')

  return normalizeLineBreaks(withoutTables)
    .replace(FENCED_CODE_RE, ' ')
    .replace(THINKING_PREFIX_RE, ' ')
    .replace(MARKDOWN_LINK_RE, '$1')
    .replace(INLINE_CODE_RE, '$1')
    .replace(URL_RE, ' link ')
    .replace(EMOJI_RE, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>#]/g, '')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** First N complete sentences (default 6), else truncated prose, under maxChars. */
export function firstSpeakableSentences(
  text: string,
  maxChars = CONVERSATIONAL_SPEAK_MAX_CHARS,
  maxSentences = CONVERSATIONAL_SPEAK_MAX_SENTENCES
): string {
  const clean = sanitizeTextForSpeech(text)

  if (!clean) {return ''}

  const parts = clean.split(/(?<=[.!?])\s+/).filter(Boolean)
  let out = ''

  for (const part of parts.slice(0, maxSentences)) {
    const next = out ? `${out} ${part}` : part

    if (next.length > maxChars) {break}
    out = next
  }

  if (!out) {
    out = clean.slice(0, Math.max(0, maxChars - 1)).trim()

    if (clean.length > maxChars) {out = `${out}…`}
  }

  return out
}

/**
 * Pick what TTS should say.
 * - full: sanitized full display text
 * - conversational: prefer backend spoken_reply; never fall back to a long essay
 */
export function resolveSpeakText(options: {
  mode: 'full' | 'conversational'
  spokenReply?: string | null
  displayText: string
  maxChars?: number
  maxSentences?: number
}): string {
  const maxChars = options.maxChars ?? CONVERSATIONAL_SPEAK_MAX_CHARS
  const maxSentences = options.maxSentences ?? CONVERSATIONAL_SPEAK_MAX_SENTENCES
  const spoken = options.spokenReply?.trim() || ''
  const display = options.displayText || ''

  if (options.mode === 'full') {
    return sanitizeTextForSpeech(display)
  }

  if (spoken) {
    const s = sanitizeTextForSpeech(spoken)

    if (s.length <= maxChars) {return s}

    return firstSpeakableSentences(s, maxChars, maxSentences)
  }

  // Progressive / missing spoken_reply: natural multi-sentence take, not the whole essay
  return firstSpeakableSentences(display, maxChars, maxSentences)
}

/** True when display text has at least one complete sentence to start speaking early. */
export function hasCompleteSentence(text: string): boolean {
  return /[.!?…](?:\s|$)/.test(sanitizeTextForSpeech(text))
}
