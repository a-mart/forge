import type { IncomingMessage, ServerResponse } from 'node:http'

export type PlaywrightLivePreviewHttpAccessPolicy = 'embedded-only' | 'parent-shell'

interface ValidatedOriginResult {
  ok: boolean
  allowedOrigin: string | null
  errorMessage?: string
}

export function validateLivePreviewHttpOrigin(
  request: IncomingMessage,
  requestUrl: URL,
  policy: PlaywrightLivePreviewHttpAccessPolicy,
): ValidatedOriginResult {
  const rawOrigin = typeof request.headers.origin === 'string' ? request.headers.origin.trim() : ''
  if (!rawOrigin) {
    return { ok: true, allowedOrigin: null }
  }

  const originUrl = parseHttpOrigin(rawOrigin)
  if (!originUrl) {
    return { ok: false, allowedOrigin: null, errorMessage: 'Invalid Origin' }
  }

  if (originUrl.origin === requestUrl.origin) {
    return { ok: true, allowedOrigin: originUrl.origin }
  }

  if (policy === 'parent-shell' && areHostsEquivalent(originUrl.hostname, requestUrl.hostname)) {
    return { ok: true, allowedOrigin: originUrl.origin }
  }

  return { ok: false, allowedOrigin: null, errorMessage: 'Cross-origin live preview access is not allowed' }
}

export function applyLivePreviewCorsHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  methods: string,
  allowedOrigin: string | null,
): void {
  if (!allowedOrigin) {
    if (request.headers.origin) {
      response.setHeader('Vary', 'Origin')
    }
    return
  }

  response.setHeader('Access-Control-Allow-Origin', allowedOrigin)
  response.setHeader('Vary', 'Origin')
  response.setHeader('Access-Control-Allow-Methods', methods)
  response.setHeader('Access-Control-Allow-Headers', 'content-type')
}

export function validateLivePreviewWebSocketOrigin(request: IncomingMessage): { ok: true } | { ok: false; errorMessage: string } {
  const rawOrigin = typeof request.headers.origin === 'string' ? request.headers.origin.trim() : ''
  if (!rawOrigin) {
    return { ok: false, errorMessage: 'Missing Origin' }
  }

  const originUrl = parseHttpOrigin(rawOrigin)
  if (!originUrl) {
    return { ok: false, errorMessage: 'Invalid Origin' }
  }

  const hostHeader = typeof request.headers.host === 'string' ? request.headers.host.trim() : ''
  if (!hostHeader) {
    return { ok: false, errorMessage: 'Missing Host' }
  }

  const expectedProtocol = isEncryptedRequest(request) ? 'https:' : 'http:'
  const expectedUrl = new URL(`${expectedProtocol}//${hostHeader}`)
  if (originUrl.origin !== expectedUrl.origin) {
    return { ok: false, errorMessage: 'Origin not allowed' }
  }

  return { ok: true }
}

function parseHttpOrigin(value: string): URL | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    return url
  } catch {
    return null
  }
}

function areHostsEquivalent(left: string, right: string): boolean {
  const normalizedLeft = normalizeHost(left)
  const normalizedRight = normalizeHost(right)

  if (normalizedLeft === normalizedRight) {
    return true
  }

  return isLoopbackHost(normalizedLeft) && isLoopbackHost(normalizedRight)
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
}

function isLoopbackHost(value: string): boolean {
  return value === 'localhost' || value === '127.0.0.1' || value === '::1'
}

function isEncryptedRequest(request: IncomingMessage): boolean {
  return Boolean((request.socket as { encrypted?: boolean }).encrypted)
}
