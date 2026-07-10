'use strict'

// Hermes Workbench — Plugin Tester HTTP Request Executor
//
// Makes real HTTP requests from the Electron main process via Node.js `fetch`
// (built into Electron's Node). Returns structured responses with timing,
// headers, cookies and trace info.
//
// The renderer NEVER touches the network directly — all HTTP execution
// is mediated through this module.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000
const SUPPORTED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

// ---------------------------------------------------------------------------
// Variable resolution
// ---------------------------------------------------------------------------

/**
 * Replace {{key}} tokens in a template string with values from an environment
 * variables object. Returns the resolved string and a list of unresolved tokens.
 *
 * @param {string} template
 * @param {Record<string, string>} variables
 * @returns {{ resolved: string, unresolvedTokens: string[] }}
 */
function resolveVariables(template, variables) {
  if (!template || typeof template !== 'string') {
    return { resolved: template || '', unresolvedTokens: [] }
  }

  const vars = variables && typeof variables === 'object' ? variables : {}
  const unresolvedTokens = []
  const TOKEN_RE = /\{\{([^}]+)\}\}/g

  const resolved = template.replace(TOKEN_RE, (_match, token) => {
    const key = token.trim()
    if (key in vars && vars[key] !== undefined && vars[key] !== null) {
      return String(vars[key])
    }
    unresolvedTokens.push(key)
    return `{{${key}}}` // leave unresolved tokens in-place
  })

  return { resolved, unresolvedTokens }
}

/**
 * Resolve variables across a headers object. Only string header values are
 * processed; objects/arrays pass through.
 *
 * @param {Record<string, string>} headers
 * @param {Record<string, string>} variables
 * @returns {{ headers: Record<string, string>, unresolvedTokens: string[] }}
 */
function resolveHeaderVariables(headers, variables) {
  if (!headers || typeof headers !== 'object') {
    return { headers: headers || {}, unresolvedTokens: [] }
  }

  const allUnresolved = []
  const resolvedHeaders = {}

  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      const { resolved, unresolvedTokens } = resolveVariables(value, variables)
      resolvedHeaders[name] = resolved
      allUnresolved.push(...unresolvedTokens)
    } else {
      resolvedHeaders[name] = value
    }
  }

  return { headers: resolvedHeaders, unresolvedTokens: allUnresolved }
}

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

/**
 * Append query params to a URL. Existing query params on the URL are preserved.
 *
 * @param {string} url
 * @param {Record<string, string>|Array<{key: string, value: string}>} params
 * @returns {string}
 */
function buildUrl(url, params) {
  if (!params) return url

  const entries = Array.isArray(params)
    ? params.map(p => [p.key, p.value])
    : Object.entries(params)

  if (entries.length === 0) return url

  const urlObj = new URL(url)
  for (const [key, value] of entries) {
    if (key && value !== undefined && value !== null) {
      urlObj.searchParams.append(key, String(value))
    }
  }

  return urlObj.toString()
}

// ---------------------------------------------------------------------------
// Cookie parsing
// ---------------------------------------------------------------------------

/**
 * Parse Set-Cookie headers into a structured array.
 *
 * @param {Headers} headers
 * @returns {Array<{ name: string, value: string, attributes: Record<string, string|true> }>}
 */
function parseCookies(headers) {
  const setCookieHeaders = headers.getSetCookie ? headers.getSetCookie() : []
  if (setCookieHeaders.length === 0) {
    // Fallback for runtimes where getSetCookie isn't available
    const raw = headers.get('set-cookie')
    if (!raw) return []
    return parseCookieString(raw)
  }

  return setCookieHeaders.map(parseCookieString).flat()
}

function parseCookieString(header) {
  if (!header) return []

  return header.split(',').map(part => {
    const trimmed = part.trim()
    const segments = trimmed.split(';').map(s => s.trim())
    const [nameValue, ...attrStrings] = segments

    const eqIdx = nameValue.indexOf('=')
    const name = eqIdx >= 0 ? nameValue.slice(0, eqIdx).trim() : nameValue.trim()
    const value = eqIdx >= 0 ? nameValue.slice(eqIdx + 1).trim() : ''

    const attributes = {}
    for (const attr of attrStrings) {
      const attrEq = attr.indexOf('=')
      if (attrEq >= 0) {
        attributes[attr.slice(0, attrEq).trim().toLowerCase()] = attr.slice(attrEq + 1).trim()
      } else {
        attributes[attr.toLowerCase()] = true
      }
    }

    return { name, value, attributes }
  })
}

// ---------------------------------------------------------------------------
// Auth header construction
// ---------------------------------------------------------------------------

/**
 * Build an Authorization header value from an auth config object.
 *
 * @param {object} auth
 * @param {string} [auth.type] - 'none', 'bearer', 'basic', 'apikey'
 * @param {string} [auth.token] - bearer token value
 * @param {string} [auth.username] - basic auth username
 * @param {string} [auth.password] - basic auth password
 * @param {string} [auth.key] - API key name
 * @param {string} [auth.value] - API key value
 * @param {string} [auth.addTo] - 'header' | 'query' for API key placement
 * @returns {{ header: string|null, queryParam: {key: string, value: string}|null }}
 */
function buildAuth(auth) {
  if (!auth || !auth.type || auth.type === 'none') {
    return { header: null, queryParam: null }
  }

  switch (auth.type) {
    case 'bearer':
      if (auth.token) {
        return { header: `Bearer ${auth.token}`, queryParam: null }
      }
      return { header: null, queryParam: null }

    case 'basic': {
      if (auth.username || auth.password) {
        const creds = Buffer.from(`${auth.username || ''}:${auth.password || ''}`).toString('base64')
        return { header: `Basic ${creds}`, queryParam: null }
      }
      return { header: null, queryParam: null }
    }

    case 'apikey':
      if (auth.key && auth.value) {
        if (auth.addTo === 'query') {
          return { header: null, queryParam: { key: auth.key, value: auth.value } }
        }
        return { header: `${auth.key} ${auth.value}`, queryParam: null }
      }
      return { header: null, queryParam: null }

    default:
      return { header: null, queryParam: null }
  }
}

// ---------------------------------------------------------------------------
// Main execute function
// ---------------------------------------------------------------------------

/**
 * Execute an HTTP request and return a structured response.
 *
 * @param {object} request
 * @param {string} request.method - HTTP method (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS)
 * @param {string} request.url - full URL (variables should already be resolved)
 * @param {Record<string, string>} [request.headers] - request headers
 * @param {object|Array} [request.params] - query parameters
 * @param {string} [request.body] - raw request body string
 * @param {string} [request.contentType] - Content-Type header override
 * @param {object} [request.auth] - auth config (type, token, etc.)
 * @param {number} [request.timeout] - timeout in ms (default 30s)
 * @returns {Promise<object>} - { ok: true, value: { response, trace } }
 */
async function executeRequest(request) {
  const startTime = performance.now()

  // --- Build URL with query params ---
  let fullUrl
  try {
    // If the request carries an auth query param, merge it into params
    const auth = buildAuth(request.auth)
    let mergedParams = request.params

    if (auth.queryParam) {
      const paramEntries = Array.isArray(mergedParams)
        ? [...mergedParams, { key: auth.queryParam.key, value: auth.queryParam.value }]
        : { ...(mergedParams || {}), [auth.queryParam.key]: auth.queryParam.value }
      mergedParams = paramEntries
    }

    fullUrl = buildUrl(request.url, mergedParams)
    // Validate URL parses (will throw on malformed)
    new URL(fullUrl)
  } catch (err) {
    return {
      ok: false,
      message: `Invalid URL: ${err.message}`,
      code: 'INVALID_URL'
    }
  }

  // --- Build headers ---
  const headers = {}
  if (request.headers && typeof request.headers === 'object') {
    Object.assign(headers, request.headers)
  }

  // Set Content-Type from explicit contentType or body presence
  if (request.contentType) {
    headers['Content-Type'] = request.contentType
  } else if (request.body && !headers['Content-Type']) {
    // Don't guess — leave it to the caller
  }

  // Inject auth header (takes precedence over user-supplied Authorization)
  const auth = buildAuth(request.auth)
  if (auth.header) {
    headers['Authorization'] = auth.header
  }

  // --- Build fetch options ---
  const controller = new AbortController()
  const timeoutMs = (request.timeout && Number.isFinite(request.timeout) && request.timeout > 0)
    ? request.timeout
    : DEFAULT_TIMEOUT_MS
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  const fetchOptions = {
    method: request.method || 'GET',
    headers,
    signal: controller.signal
  }

  if (request.body && !['GET', 'HEAD'].includes(fetchOptions.method)) {
    fetchOptions.body = request.body
  }

  // --- Execute ---
  let fetchStart = 0
  let response
  let errorInfo = null

  try {
    fetchStart = performance.now()
    response = await fetch(fullUrl, fetchOptions)
  } catch (err) {
    clearTimeout(timeoutId)

    // Classify the error
    if (err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.code === 20) {
      errorInfo = {
        message: `Request timed out after ${timeoutMs}ms`,
        code: 'TIMEOUT',
        category: 'timeout'
      }
    } else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || err.cause?.code === 'ENOTFOUND') {
      errorInfo = {
        message: `DNS resolution failed: ${err.message}`,
        code: 'DNS_ERROR',
        category: 'network'
      }
    } else if (err.code === 'ECONNREFUSED') {
      errorInfo = {
        message: `Connection refused: ${err.message}`,
        code: 'CONNECTION_REFUSED',
        category: 'network'
      }
    } else if (err.code === 'ECONNRESET') {
      errorInfo = {
        message: `Connection reset: ${err.message}`,
        code: 'CONNECTION_RESET',
        category: 'network'
      }
    } else {
      errorInfo = {
        message: `Network error: ${err.message}`,
        code: 'NETWORK_ERROR',
        category: 'network',
        details: err.code || undefined
      }
    }

    const endTime = performance.now()
    return {
      ok: false,
      message: errorInfo.message,
      code: errorInfo.code,
      value: {
        response: null,
        trace: [{
          step: 'execute',
          duration: Math.round(endTime - startTime),
          error: errorInfo
        }]
      }
    }
  }

  clearTimeout(timeoutId)
  const fetchEnd = performance.now()

  // --- Read response ---
  let body = ''
  try {
    body = await response.text()
  } catch (err) {
    body = `[Error reading response body: ${err.message}]`
  }

  const endTime = performance.now()
  const responseSize = Buffer.byteLength(body, 'utf8')

  // --- Parse response headers ---
  const responseHeaders = {}
  response.headers.forEach((value, name) => {
    responseHeaders[name] = value
  })

  // --- Parse cookies ---
  const cookies = parseCookies(response.headers)

  // --- Build trace ---
  const dnsTime = 0 // fetch() doesn't expose DNS timing separately
  const connectTime = 0
  const ttfb = Math.round(fetchEnd - fetchStart)
  const totalTime = Math.round(endTime - startTime)

  const trace = [{
    step: 'execute',
    duration: totalTime,
    timing: {
      dns: dnsTime,
      connect: connectTime,
      ttfb,
      download: Math.round(endTime - fetchEnd),
      total: totalTime
    }
  }]

  return {
    ok: true,
    value: {
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body,
        cookies,
        size: responseSize
      },
      trace
    }
  }
}

/**
 * Validate and normalize a request object before execution.
 *
 * @param {object} request
 * @returns {{ ok: true, value: object } | { ok: false, message: string, code: string }}
 */
function validateRequest(request) {
  if (!request || typeof request !== 'object') {
    return { ok: false, message: 'Request object is required', code: 'MISSING_REQUEST' }
  }

  if (!request.url || typeof request.url !== 'string' || !request.url.trim()) {
    return { ok: false, message: 'URL is required', code: 'MISSING_URL' }
  }

  const method = (request.method || 'GET').toUpperCase()
  if (!SUPPORTED_METHODS.includes(method)) {
    return { ok: false, message: `Unsupported HTTP method: ${method}`, code: 'INVALID_METHOD' }
  }

  if (request.body && typeof request.body !== 'string') {
    return { ok: false, message: 'Body must be a string', code: 'INVALID_BODY' }
  }

  if (request.body && request.body.length > 10_000_000) {
    return { ok: false, message: 'Body exceeds 10MB size limit', code: 'BODY_TOO_LARGE' }
  }

  if (request.headers && typeof request.headers !== 'object') {
    return { ok: false, message: 'Headers must be an object', code: 'INVALID_HEADERS' }
  }

  if (request.timeout !== undefined && request.timeout !== null) {
    if (!Number.isFinite(request.timeout) || request.timeout < 1 || request.timeout > 120_000) {
      return { ok: false, message: 'Timeout must be between 1ms and 120000ms', code: 'INVALID_TIMEOUT' }
    }
  }

  return {
    ok: true,
    value: {
      ...request,
      method,
      url: request.url.trim(),
      timeout: request.timeout || DEFAULT_TIMEOUT_MS
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  executeRequest,
  validateRequest,
  resolveVariables,
  resolveHeaderVariables,
  buildUrl,
  buildAuth,
  parseCookies,
  SUPPORTED_METHODS,
  DEFAULT_TIMEOUT_MS
}
