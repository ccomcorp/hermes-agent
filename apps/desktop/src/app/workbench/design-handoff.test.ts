import { describe, expect, it } from 'vitest'

import { buildDesignHandoffMessage, buildDesignKanbanCard } from './design-handoff'

describe('buildDesignHandoffMessage', () => {
  it('wraps a prototype artifact in an html code fence and notes it is a visual reference', () => {
    const message = buildDesignHandoffMessage('prototype', '<!doctype html><html><body>Hi</body></html>')

    expect(message).toMatch(/^Implement the following design as real code in this project\./)
    expect(message).toMatch(/visual\/behavioral reference/i)
    expect(message).toContain('```html\n<!doctype html><html><body>Hi</body></html>\n```')
    expect(message).toMatch(/Vite \+ React \+ Tailwind/)
  })

  it('includes a brief artifact as plain prose with no code fence', () => {
    const message = buildDesignHandoffMessage('brief', '# Design brief\n\nTarget users: everyone.')

    expect(message).toMatch(/^Implement the following design as real code in this project\./)
    expect(message).toMatch(/design brief describing target users/i)
    expect(message).toContain('# Design brief\n\nTarget users: everyone.')
    expect(message).toMatch(/Vite \+ React \+ Tailwind/)
    expect(message).not.toContain('```')
  })

  it('trims leading/trailing whitespace from the artifact content', () => {
    const message = buildDesignHandoffMessage('brief', '   \n  Some brief.  \n\n  ')

    expect(message.endsWith('Some brief.')).toBe(true)
  })
})

describe('buildDesignKanbanCard', () => {
  it('titles a brief card from the requirement id, prepends a human-readable origin breadcrumb, and keeps the handoff message', () => {
    const card = buildDesignKanbanCard('brief', 'req-123', '# Design brief\n\nTarget users: everyone.')

    expect(card.title).toBe('Implement design (brief): req-123')
    // A short, human-readable origin breadcrumb leads the body (NOT a
    // machine-resolvable marker) — see design-handoff.ts.
    expect(card.body).toMatch(/^Origin: Workbench requirement "req-123" \(req-123\)\n\n/)
    // The design content the code-agent handoff sends is still inlined, just
    // after the breadcrumb.
    expect(card.body).toContain(buildDesignHandoffMessage('brief', '# Design brief\n\nTarget users: everyone.'))
    expect(card.body).toContain('Implement the following design as real code in this project.')
    expect(card.body).toContain('# Design brief\n\nTarget users: everyone.')
  })

  it('titles a prototype card, prepends the origin breadcrumb, and fences the html in the body', () => {
    const card = buildDesignKanbanCard('prototype', 'req-999', '<!doctype html><html><body>Hi</body></html>')

    expect(card.title).toBe('Implement design (prototype): req-999')
    expect(card.body).toMatch(/^Origin: Workbench requirement "req-999" \(req-999\)\n\n/)
    expect(card.body).toContain(buildDesignHandoffMessage('prototype', '<!doctype html><html><body>Hi</body></html>'))
    expect(card.body).toContain('```html\n<!doctype html><html><body>Hi</body></html>\n```')
  })
})
