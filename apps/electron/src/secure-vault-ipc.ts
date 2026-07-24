import type { ChildProcess } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'

export const SECURE_VAULT_REQUEST_TYPE = 'secure_vault_request'
export const SECURE_VAULT_RESPONSE_TYPE = 'secure_vault_response'
export const SECURE_VAULT_RENDERER_CHANNEL = 'forge:secure-vault'
export const SECURE_VAULT_DEFAULT_REQUEST_TIMEOUT_MS = 5_000
export const SECURE_VAULT_MAX_PLAINTEXT_BYTES = 256 * 1024
export const SECURE_VAULT_MAX_CIPHERTEXT_BYTES = 512 * 1024

const SECURE_VAULT_MAX_REQUEST_ID_LENGTH = 128
const SECURE_VAULT_ENCRYPT_RESPONSE_CACHE_SIZE = 128
const SECURE_VAULT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/

export type SecureVaultOperation = 'status' | 'encrypt' | 'decrypt'

export type SecureVaultErrorCode =
  | 'SECURE_VAULT_INVALID_REQUEST'
  | 'SECURE_VAULT_PAYLOAD_TOO_LARGE'
  | 'SECURE_VAULT_STORAGE_UNAVAILABLE'
  | 'SECURE_VAULT_INSECURE_STORAGE'
  | 'SECURE_VAULT_ENCRYPT_FAILED'
  | 'SECURE_VAULT_DECRYPT_FAILED'

export type SecureVaultRequest =
  | {
      type: typeof SECURE_VAULT_REQUEST_TYPE
      requestId: string
      operation: 'status'
      payload?: never
    }
  | {
      type: typeof SECURE_VAULT_REQUEST_TYPE
      requestId: string
      operation: 'encrypt' | 'decrypt'
      payload: string
    }

export type SecureVaultResponse =
  | {
      type: typeof SECURE_VAULT_RESPONSE_TYPE
      requestId: string
      ok: true
      result: { available: true } | { payload: string }
    }
  | {
      type: typeof SECURE_VAULT_RESPONSE_TYPE
      requestId: string
      ok: false
      errorCode: SecureVaultErrorCode
    }

export type SecureVaultRendererResponse =
  | { ok: true; available: true }
  | { ok: true; encryptedPayloadBase64: string }
  | { ok: false; errorCode: SecureVaultErrorCode }

interface SafeStoragePort {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

interface IpcMainPort {
  handle(channel: string, listener: (event: unknown, request: unknown) => SecureVaultRendererResponse): void
  removeHandler(channel: string): void
}

interface ChildProcessPort {
  connected: boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  once(event: 'disconnect' | 'error' | 'exit', listener: (...args: unknown[]) => void): unknown
  off(event: 'disconnect' | 'error' | 'exit' | 'message', listener: (...args: unknown[]) => void): unknown
  send(message: unknown, callback?: (error: Error | null) => void): boolean
}

type ParsedRequest =
  | { ok: true; request: SecureVaultRequest }
  | { ok: false; requestId: string | null; errorCode: SecureVaultErrorCode }

type DecodedPayload =
  | { ok: true; bytes: Buffer }
  | { ok: false; errorCode: SecureVaultErrorCode }

type EncryptPayloadResult =
  | { ok: true; result: { payload: string } }
  | { ok: false; errorCode: SecureVaultErrorCode }

export function createSecureVaultRequestHandler(options: {
  safeStorage: SafeStoragePort
  platform: NodeJS.Platform
}): {
  handle(message: unknown): SecureVaultResponse | null
  dispose(): void
} {
  const responseCacheKey = randomBytes(32)
  const encryptResponseCache = new Map<string, {
    payloadTag: string
    response: SecureVaultResponse
  }>()

  return {
    handle(message: unknown): SecureVaultResponse | null {
      const parsed = parseSecureVaultRequest(message)
      if (!parsed.ok) {
        return parsed.requestId
          ? createErrorResponse(parsed.requestId, parsed.errorCode)
          : null
      }

      const { request } = parsed
      const cached = encryptResponseCache.get(request.requestId)
      if (cached) {
        if (request.operation !== 'encrypt') {
          return createErrorResponse(request.requestId, 'SECURE_VAULT_INVALID_REQUEST')
        }
        if (request.payload.length > maxBase64Length(SECURE_VAULT_MAX_PLAINTEXT_BYTES)) {
          return createErrorResponse(request.requestId, 'SECURE_VAULT_PAYLOAD_TOO_LARGE')
        }
        if (createPayloadTag(responseCacheKey, request.payload) !== cached.payloadTag) {
          return createErrorResponse(request.requestId, 'SECURE_VAULT_INVALID_REQUEST')
        }
        return cached.response
      }

      const response = handleRequest(request, options)
      if (request.operation === 'encrypt' && response.ok) {
        encryptResponseCache.set(request.requestId, {
          payloadTag: createPayloadTag(responseCacheKey, request.payload),
          response,
        })
        if (encryptResponseCache.size > SECURE_VAULT_ENCRYPT_RESPONSE_CACHE_SIZE) {
          const oldestRequestId = encryptResponseCache.keys().next().value
          if (typeof oldestRequestId === 'string') {
            encryptResponseCache.delete(oldestRequestId)
          }
        }
      }

      return response
    },
    dispose(): void {
      encryptResponseCache.clear()
      responseCacheKey.fill(0)
    },
  }
}

export function installSecureVaultChildBridge(options: {
  child: ChildProcess
  safeStorage: SafeStoragePort
  platform: NodeJS.Platform
}): () => void {
  const child = options.child as unknown as ChildProcessPort
  const handler = createSecureVaultRequestHandler(options)
  let disposed = false

  const onMessage = (message: unknown): void => {
    const response = handler.handle(message)
    if (!response || !child.connected) {
      return
    }

    try {
      child.send(response, () => {
        // The caller owns the request timeout and can retry the same requestId.
      })
    } catch {
      // Never include transport or safeStorage errors in logs or reply payloads.
    }
  }

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    handler.dispose()
    child.off('message', onMessage)
    child.off('disconnect', dispose)
    child.off('error', dispose)
    child.off('exit', dispose)
  }

  child.on('message', onMessage)
  child.once('disconnect', dispose)
  child.once('error', dispose)
  child.once('exit', dispose)

  return dispose
}

export function installSecureVaultRendererIpc(options: {
  ipcMain: IpcMainPort
  safeStorage: SafeStoragePort
  platform: NodeJS.Platform
  isTrustedSender: (event: unknown) => boolean
}): () => void {
  options.ipcMain.handle(SECURE_VAULT_RENDERER_CHANNEL, (event, request) => {
    if (!options.isTrustedSender(event) || !isRecord(request)) {
      return { ok: false, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
    }

    if (request.operation === 'status') {
      if (Object.keys(request).length !== 1) {
        return { ok: false, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
      }
      const availability = getSecureVaultAvailability(options)
      return availability.available
        ? { ok: true, available: true }
        : { ok: false, errorCode: availability.errorCode }
    }

    if (
      request.operation !== 'encrypt' ||
      typeof request.value !== 'string' ||
      Object.keys(request).length !== 2
    ) {
      return { ok: false, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
    }

    const plainTextBytes = Buffer.from(request.value, 'utf8')
    try {
      if (plainTextBytes.byteLength === 0) {
        return { ok: false, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
      }
      if (plainTextBytes.byteLength > SECURE_VAULT_MAX_PLAINTEXT_BYTES) {
        return { ok: false, errorCode: 'SECURE_VAULT_PAYLOAD_TOO_LARGE' }
      }

      const response = encryptPayload(plainTextBytes.toString('base64'), options)
      if (!response.ok) {
        return { ok: false, errorCode: response.errorCode }
      }

      if (!('payload' in response.result)) {
        return { ok: false, errorCode: 'SECURE_VAULT_ENCRYPT_FAILED' }
      }

      return {
        ok: true,
        encryptedPayloadBase64: response.result.payload,
      }
    } finally {
      plainTextBytes.fill(0)
    }
  })

  return () => {
    options.ipcMain.removeHandler(SECURE_VAULT_RENDERER_CHANNEL)
  }
}

function handleRequest(
  request: SecureVaultRequest,
  options: {
    safeStorage: SafeStoragePort
    platform: NodeJS.Platform
  },
): SecureVaultResponse {
  if (request.operation === 'status') {
    const availability = getSecureVaultAvailability(options)
    return availability.available
      ? {
          type: SECURE_VAULT_RESPONSE_TYPE,
          requestId: request.requestId,
          ok: true,
          result: { available: true },
        }
      : createErrorResponse(request.requestId, availability.errorCode)
  }

  if (request.operation === 'encrypt') {
    const response = encryptPayload(request.payload ?? '', options)
    if (!response.ok) {
      return createErrorResponse(request.requestId, response.errorCode)
    }
    return {
      type: SECURE_VAULT_RESPONSE_TYPE,
      requestId: request.requestId,
      ok: true,
      result: response.result,
    }
  }

  return decryptPayload(request.requestId, request.payload ?? '', options)
}

function encryptPayload(
  plainPayload: string,
  options: {
    safeStorage: SafeStoragePort
    platform: NodeJS.Platform
  },
): EncryptPayloadResult {
  const decoded = decodeCanonicalBase64(plainPayload, SECURE_VAULT_MAX_PLAINTEXT_BYTES)
  if (!decoded.ok) {
    return { ok: false, errorCode: decoded.errorCode }
  }
  if (decoded.bytes.byteLength === 0) {
    return { ok: false, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
  }

  try {
    const availability = getSecureVaultAvailability(options)
    if (!availability.available) {
      return { ok: false, errorCode: availability.errorCode }
    }

    const encrypted = options.safeStorage.encryptString(plainPayload)
    if (!Buffer.isBuffer(encrypted) || encrypted.byteLength === 0) {
      return { ok: false, errorCode: 'SECURE_VAULT_ENCRYPT_FAILED' }
    }
    if (encrypted.byteLength > SECURE_VAULT_MAX_CIPHERTEXT_BYTES) {
      return { ok: false, errorCode: 'SECURE_VAULT_PAYLOAD_TOO_LARGE' }
    }

    return {
      ok: true,
      result: { payload: encrypted.toString('base64') },
    }
  } catch {
    return { ok: false, errorCode: 'SECURE_VAULT_ENCRYPT_FAILED' }
  } finally {
    decoded.bytes.fill(0)
  }
}

function decryptPayload(
  requestId: string,
  encryptedPayload: string,
  options: {
    safeStorage: SafeStoragePort
    platform: NodeJS.Platform
  },
): SecureVaultResponse {
  const decoded = decodeCanonicalBase64(encryptedPayload, SECURE_VAULT_MAX_CIPHERTEXT_BYTES)
  if (!decoded.ok) {
    return createErrorResponse(requestId, decoded.errorCode)
  }
  if (decoded.bytes.byteLength === 0) {
    return createErrorResponse(requestId, 'SECURE_VAULT_INVALID_REQUEST')
  }

  try {
    const availability = getSecureVaultAvailability(options)
    if (!availability.available) {
      return createErrorResponse(requestId, availability.errorCode)
    }

    const plainPayload = options.safeStorage.decryptString(decoded.bytes)
    const validatedPlainPayload = decodeCanonicalBase64(plainPayload, SECURE_VAULT_MAX_PLAINTEXT_BYTES)
    if (!validatedPlainPayload.ok) {
      return createErrorResponse(requestId, 'SECURE_VAULT_DECRYPT_FAILED')
    }
    validatedPlainPayload.bytes.fill(0)

    return {
      type: SECURE_VAULT_RESPONSE_TYPE,
      requestId,
      ok: true,
      result: { payload: plainPayload },
    }
  } catch {
    return createErrorResponse(requestId, 'SECURE_VAULT_DECRYPT_FAILED')
  } finally {
    decoded.bytes.fill(0)
  }
}

function getSecureVaultAvailability(options: {
  safeStorage: SafeStoragePort
  platform: NodeJS.Platform
}):
  | { available: true }
  | { available: false; errorCode: 'SECURE_VAULT_STORAGE_UNAVAILABLE' | 'SECURE_VAULT_INSECURE_STORAGE' } {
  try {
    if (!options.safeStorage.isEncryptionAvailable()) {
      return { available: false, errorCode: 'SECURE_VAULT_STORAGE_UNAVAILABLE' }
    }

    if (options.platform === 'linux') {
      if (typeof options.safeStorage.getSelectedStorageBackend !== 'function') {
        return { available: false, errorCode: 'SECURE_VAULT_STORAGE_UNAVAILABLE' }
      }
      if (options.safeStorage.getSelectedStorageBackend() === 'basic_text') {
        return { available: false, errorCode: 'SECURE_VAULT_INSECURE_STORAGE' }
      }
    }

    return { available: true }
  } catch {
    return { available: false, errorCode: 'SECURE_VAULT_STORAGE_UNAVAILABLE' }
  }
}

function parseSecureVaultRequest(value: unknown): ParsedRequest {
  if (!isRecord(value) || value.type !== SECURE_VAULT_REQUEST_TYPE) {
    return { ok: false, requestId: null, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
  }

  const requestId = parseRequestId(value.requestId)
  if (!requestId) {
    return { ok: false, requestId: null, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
  }

  if (value.operation !== 'status' && value.operation !== 'encrypt' && value.operation !== 'decrypt') {
    return { ok: false, requestId, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
  }

  if (value.operation === 'status') {
    if (value.payload !== undefined || Object.keys(value).length !== 3) {
      return { ok: false, requestId, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
    }
    return {
      ok: true,
      request: {
        type: SECURE_VAULT_REQUEST_TYPE,
        requestId,
        operation: 'status',
      },
    }
  }

  if (typeof value.payload !== 'string' || Object.keys(value).length !== 4) {
    return { ok: false, requestId, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
  }

  return {
    ok: true,
    request: {
      type: SECURE_VAULT_REQUEST_TYPE,
      requestId,
      operation: value.operation,
      payload: value.payload,
    },
  }
}

function parseRequestId(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > SECURE_VAULT_MAX_REQUEST_ID_LENGTH ||
    !SECURE_VAULT_REQUEST_ID_PATTERN.test(value)
  ) {
    return null
  }
  return value
}

function decodeCanonicalBase64(value: string, maxBytes: number): DecodedPayload {
  if (value.length > maxBase64Length(maxBytes)) {
    return { ok: false, errorCode: 'SECURE_VAULT_PAYLOAD_TOO_LARGE' }
  }

  const bytes = Buffer.from(value, 'base64')
  if (bytes.byteLength > maxBytes) {
    bytes.fill(0)
    return { ok: false, errorCode: 'SECURE_VAULT_PAYLOAD_TOO_LARGE' }
  }
  if (bytes.toString('base64') !== value) {
    bytes.fill(0)
    return { ok: false, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
  }

  return { ok: true, bytes }
}

function maxBase64Length(maxBytes: number): number {
  return Math.ceil(maxBytes / 3) * 4
}

function createPayloadTag(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload, 'utf8').digest('base64')
}

function createErrorResponse(
  requestId: string,
  errorCode: SecureVaultErrorCode,
): SecureVaultResponse {
  return {
    type: SECURE_VAULT_RESPONSE_TYPE,
    requestId,
    ok: false,
    errorCode,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
