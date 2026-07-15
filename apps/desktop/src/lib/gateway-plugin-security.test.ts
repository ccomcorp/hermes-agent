import { describe, expect, it } from 'vitest'

import { assertCanExecuteGatewayPluginScript, canExecuteGatewayPluginScript } from './gateway-plugin-security'

describe('canExecuteGatewayPluginScript', () => {
  it('allows explicit loopback hosts', () => {
    expect(canExecuteGatewayPluginScript('http://127.0.0.1:9120')).toBe(true)
    expect(canExecuteGatewayPluginScript('http://localhost:9120')).toBe(true)
    expect(canExecuteGatewayPluginScript('http://[::1]:9120')).toBe(true)
  })

  it('blocks non-loopback / remote hosts', () => {
    expect(canExecuteGatewayPluginScript('http://1.1.11.31:9120')).toBe(false)
    expect(canExecuteGatewayPluginScript('https://gateway.example.com')).toBe(false)
    expect(canExecuteGatewayPluginScript('not-a-url')).toBe(false)
  })

  // Regression: the default local backend leaves connection.baseUrl empty; the
  // renderer fetch falls back to http://127.0.0.1:9120 (loopback), so an empty
  // baseUrl MUST be treated as executable — otherwise Canvas/Kanban plugins never
  // load on the default local install.
  it('treats empty/nullish baseUrl as local loopback', () => {
    expect(canExecuteGatewayPluginScript('')).toBe(true)
    expect(canExecuteGatewayPluginScript(null)).toBe(true)
    expect(canExecuteGatewayPluginScript(undefined)).toBe(true)
  })
})

describe('assertCanExecuteGatewayPluginScript', () => {
  it('does not throw for the default local backend', () => {
    expect(() => assertCanExecuteGatewayPluginScript('')).not.toThrow()
    expect(() => assertCanExecuteGatewayPluginScript(null)).not.toThrow()
  })

  it('throws for a remote gateway', () => {
    expect(() => assertCanExecuteGatewayPluginScript('http://1.1.11.31:9120')).toThrow()
  })
})
