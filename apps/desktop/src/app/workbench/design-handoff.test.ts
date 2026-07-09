import { describe, expect, it } from 'vitest'

import { buildDesignHandoffMessage } from './design-handoff'

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
