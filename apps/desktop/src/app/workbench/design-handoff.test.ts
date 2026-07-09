import { describe, expect, it } from 'vitest'

import { buildDesignHandoffMessage, buildDesignKanbanCard } from './design-handoff'

describe('buildDesignHandoffMessage', () => {
  it('wraps a prototype artifact in an html code fence and notes it is a visual reference', () => {
    const message = buildDesignHandoffMessage('prototype', '<!doctype html><html><body>Hi</body></html>')

    expect(message).toMatch(/^Implement the following design as real code in this project\./)
    expect(message).toMatch(/visual\/behavioral reference/i)
    expect(message).toContain('```html\n<!doctype html><html><body>Hi</body></html>\n```')
  })

  it('includes a brief artifact as plain prose with no code fence', () => {
    const message = buildDesignHandoffMessage('brief', '# Design brief\n\nTarget users: everyone.')

    expect(message).toMatch(/^Implement the following design as real code in this project\./)
    expect(message).toMatch(/design brief describing target users/i)
    expect(message).toContain('# Design brief\n\nTarget users: everyone.')
    expect(message).not.toContain('```')
  })

  it('trims leading/trailing whitespace from the artifact content', () => {
    const message = buildDesignHandoffMessage('brief', '   \n  Some brief.  \n\n  ')

    expect(message.endsWith('Some brief.')).toBe(true)
  })
})

describe('buildDesignKanbanCard', () => {
  it('titles a brief card from the requirement id and reuses the handoff message as the body', () => {
    const card = buildDesignKanbanCard('brief', 'req-123', '# Design brief\n\nTarget users: everyone.')

    expect(card.title).toBe('Implement design (brief): req-123')
    // Body carries the same "Implement this design as real code…" instruction +
    // brief prose the code-agent handoff sends.
    expect(card.body).toBe(buildDesignHandoffMessage('brief', '# Design brief\n\nTarget users: everyone.'))
    expect(card.body).toMatch(/^Implement the following design as real code in this project\./)
    expect(card.body).toContain('# Design brief\n\nTarget users: everyone.')
  })

  it('titles a prototype card and fences the html in the body', () => {
    const card = buildDesignKanbanCard('prototype', 'req-999', '<!doctype html><html><body>Hi</body></html>')

    expect(card.title).toBe('Implement design (prototype): req-999')
    expect(card.body).toBe(buildDesignHandoffMessage('prototype', '<!doctype html><html><body>Hi</body></html>'))
    expect(card.body).toContain('```html\n<!doctype html><html><body>Hi</body></html>\n```')
  })
})
