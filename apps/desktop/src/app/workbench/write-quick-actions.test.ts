import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  applySelectionReplacement,
  buildFreeTextEditPrompt,
  buildQuickActionPrompt,
  buildWriteChangeSetInput,
  findWriteQuickAction,
  sha256Hex16,
  WRITE_QUICK_ACTIONS
} from './write-quick-actions'

describe('WRITE_QUICK_ACTIONS catalog', () => {
  it('declares exactly the seven named actions from the go-forward plan', () => {
    const ids = WRITE_QUICK_ACTIONS.map(action => action.id).sort()

    expect(ids).toEqual(['critique', 'distill', 'explain', 'polish', 'reformat', 'soften', 'strengthen'])
  })

  it('marks explain/critique informational and the rest rewrite', () => {
    const kinds = Object.fromEntries(WRITE_QUICK_ACTIONS.map(action => [action.id, action.kind]))

    expect(kinds.explain).toBe('informational')
    expect(kinds.critique).toBe('informational')
    expect(kinds.polish).toBe('rewrite')
    expect(kinds.reformat).toBe('rewrite')
    expect(kinds.distill).toBe('rewrite')
    expect(kinds.strengthen).toBe('rewrite')
    expect(kinds.soften).toBe('rewrite')
  })

  it('findWriteQuickAction resolves a known id and throws on an unknown one', () => {
    expect(findWriteQuickAction('polish').label).toBe('Polish')
    expect(() => findWriteQuickAction('unknown' as never)).toThrow(/Unknown write quick action/)
  })
})

describe('buildQuickActionPrompt', () => {
  it('names the document scope and includes the given text as input, never wrapping it in the instructions', () => {
    const action = findWriteQuickAction('polish')
    const prompt = buildQuickActionPrompt(action, 'Some draft text.', 'document')

    expect(prompt.input).toBe('Some draft text.')
    expect(prompt.instructions).toMatch(/document/)
    expect(prompt.instructions).not.toContain('Some draft text.')
  })

  it('names the selection scope distinctly from the document scope', () => {
    const action = findWriteQuickAction('critique')
    const prompt = buildQuickActionPrompt(action, 'A sentence.', 'selection')

    expect(prompt.instructions).toMatch(/selected excerpt/)
  })

  it('tells rewrite actions to return only the revised text (no ChangeSet-corrupting preamble)', () => {
    const action = findWriteQuickAction('reformat')
    const prompt = buildQuickActionPrompt(action, 'text', 'document')

    expect(prompt.instructions).toMatch(/Return ONLY the revised text/)
  })

  it('does not impose the rewrite-only suffix on informational actions', () => {
    const action = findWriteQuickAction('explain')
    const prompt = buildQuickActionPrompt(action, 'text', 'document')

    expect(prompt.instructions).not.toMatch(/Return ONLY the revised text/)
  })
})

describe('buildFreeTextEditPrompt', () => {
  it('embeds the trimmed instruction and the scope label', () => {
    const prompt = buildFreeTextEditPrompt('  make this more formal  ', 'Hey there!', 'selection')

    expect(prompt.instructions).toContain('make this more formal')
    expect(prompt.instructions).toMatch(/selected excerpt/)
    expect(prompt.input).toBe('Hey there!')
  })
})

describe('applySelectionReplacement', () => {
  it('splices a replacement into the middle of a document', () => {
    const original = 'The quick brown fox jumps.'
    const from = original.indexOf('brown')
    const to = from + 'brown'.length

    expect(applySelectionReplacement(original, from, to, 'lazy')).toBe('The quick lazy fox jumps.')
  })

  it('clamps an out-of-range selection instead of throwing', () => {
    const original = 'short'

    expect(applySelectionReplacement(original, -5, 1000, 'REPLACED')).toBe('REPLACED')
  })

  it('handles a collapsed (zero-width) selection as a pure insertion', () => {
    const original = 'ab'

    expect(applySelectionReplacement(original, 1, 1, 'X')).toBe('aXb')
  })
})

describe('sha256Hex16', () => {
  // The single most important invariant in this file: this MUST match
  // workbench-artifacts.cjs's `contentHash()` bit-for-bit, or a proposed
  // ChangeSet's beforeHash would never match what
  // workbench-changeset-apply.cjs recomputes at apply time, and every
  // proposed rewrite would be refused as a false conflict.
  function nodeContentHash(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16)
  }

  it('matches the backend contentHash() algorithm for plain ASCII content', async () => {
    const content = '# Title\n\nSome document body.\n'

    expect(await sha256Hex16(content)).toBe(nodeContentHash(content))
  })

  it('matches the backend contentHash() algorithm for multi-byte UTF-8 content', async () => {
    const content = 'Héllo wörld — emoji: 🎉'

    expect(await sha256Hex16(content)).toBe(nodeContentHash(content))
  })

  it('matches the backend contentHash() algorithm for empty content', async () => {
    expect(await sha256Hex16('')).toBe(nodeContentHash(''))
  })

  it('returns exactly 16 lowercase hex characters', async () => {
    const hash = await sha256Hex16('anything')

    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('buildWriteChangeSetInput', () => {
  it('builds a single-file pending ChangeSet request with the write project path, beforeHash, and full next content as diff', () => {
    const input = buildWriteChangeSetInput({
      beforeHash: 'abc123abc123abcd',
      fileRelativePath: '.hermes/workbench/write/my-doc/document.md',
      nextContent: '# Polished\n\nRewritten body.\n',
      summary: 'Proposed by Polish quick action.',
      title: 'Polish: My Doc',
      workspaceRoot: '/tmp/workspace'
    })

    expect(input.workspaceRoot).toBe('/tmp/workspace')
    expect(input.source).toBe('write_inline_edit')
    expect(input.title).toBe('Polish: My Doc')
    expect(input.summary).toBe('Proposed by Polish quick action.')
    expect(input.files).toHaveLength(1)

    const [file] = input.files

    expect(file.path).toBe('.hermes/workbench/write/my-doc/document.md')
    expect(file.beforeHash).toBe('abc123abc123abcd')
    expect(file.diff).toBe('# Polished\n\nRewritten body.\n')
    expect(file.status).toBe('pending')
  })

  it('never sets an afterHash or applyResult — those belong to Slice E apply, not this proposal', () => {
    const input = buildWriteChangeSetInput({
      beforeHash: 'h',
      fileRelativePath: 'p',
      nextContent: 'c',
      summary: 's',
      title: 't',
      workspaceRoot: 'w'
    })

    expect(input.files[0].afterHash).toBeUndefined()
    expect(input.files[0].applyResult).toBeUndefined()
  })
})
