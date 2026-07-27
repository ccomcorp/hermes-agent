/**
 * Security gate for executing gateway-served dashboard plugin JS in the
 * privileged desktop renderer (audit H4).
 *
 * Remote gateways must never inject code via `new Function`. Loopback-only
 * is allowed so the default local backend still loads Kanban/Canvas plugins.
 */

export function canExecuteGatewayPluginScript(baseUrl: string | null | undefined): boolean {
  // An empty/nullish baseUrl is the default local backend: the renderer's plugin
  // fetch falls back to http://127.0.0.1:9120 (loopback), so this is safe to run.
  // Without this, Canvas/Kanban plugins never load on the default local install.
  if (!baseUrl) {return true}

  try {
    const u = new URL(String(baseUrl))
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()

    return (
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === '::1' ||
      host.endsWith('.localhost')
    )
  } catch {
    return false
  }
}

export function assertCanExecuteGatewayPluginScript(baseUrl: string | null | undefined): void {
  if (!canExecuteGatewayPluginScript(baseUrl)) {
    throw new Error(
      'Refusing to execute gateway plugin script from a non-loopback host. ' +
        'Remote gateways cannot inject code into Hermes Desktop. Use a local gateway, ' +
        'or load plugins from a packaged local path.'
    )
  }
}
