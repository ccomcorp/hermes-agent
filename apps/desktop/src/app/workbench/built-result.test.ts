import { describe, expect, it } from 'vitest'

import { builtEntryCandidates, extractDevPreviewUrl, toFileUrl } from './built-result'

describe('builtEntryCandidates', () => {
  it('lists index.html first, then dist/build/public, using the root separator', () => {
    const c = builtEntryCandidates('H:\\WSpace-Hermes\\hermes-projects\\coming-soon-landing-page')
    expect(c[0]).toBe('H:\\WSpace-Hermes\\hermes-projects\\coming-soon-landing-page\\index.html')
    expect(c[1]).toBe('H:\\WSpace-Hermes\\hermes-projects\\coming-soon-landing-page\\dist\\index.html')
    expect(c).toContain('H:\\WSpace-Hermes\\hermes-projects\\coming-soon-landing-page\\public\\index.html')
  })

  it('handles POSIX roots and a trailing separator', () => {
    const c = builtEntryCandidates('/home/user/site/')
    expect(c[0]).toBe('/home/user/site/index.html')
    expect(c[1]).toBe('/home/user/site/dist/index.html')
  })
})

describe('toFileUrl', () => {
  it('produces a triple-slash file URL for a Windows path with normalized slashes', () => {
    expect(toFileUrl('H:\\site\\index.html')).toBe('file:///H:/site/index.html')
  })

  it('keeps the leading slash for a POSIX absolute path', () => {
    expect(toFileUrl('/home/user/site/index.html')).toBe('file:///home/user/site/index.html')
  })
})

describe('extractDevPreviewUrl', () => {
  it('finds a localhost dev-server URL in noisy text', () => {
    expect(extractDevPreviewUrl('  VITE ready\n  Local:   http://localhost:5173/  \n')).toBe('http://localhost:5173/')
  })

  it('finds a 127.0.0.1 URL and a LAN URL', () => {
    expect(extractDevPreviewUrl('serving at http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(extractDevPreviewUrl('Network: http://192.168.1.20:4321/')).toBe('http://192.168.1.20:4321/')
  })

  it('normalizes 0.0.0.0 to 127.0.0.1', () => {
    expect(extractDevPreviewUrl('listening on http://0.0.0.0:8080')).toBe('http://127.0.0.1:8080')
  })

  it('ignores public URLs and returns null when there is no local server (static page)', () => {
    expect(extractDevPreviewUrl('Origin: Workbench requirement "coming-soon-landing"')).toBeNull()
    expect(extractDevPreviewUrl('see https://example.com/docs')).toBeNull()
  })
})
