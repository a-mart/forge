import type { ChildProcess } from 'node:child_process'
import {
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'

export const SECURE_VAULT_REQUEST_TYPE = 'secure_vault_request'
export const SECURE_VAULT_RESPONSE_TYPE = 'secure_vault_response'
export const SECURE_VAULT_RENDERER_CHANNEL = 'forge:secure-vault'
export const SECURE_VAULT_MAX_PLAINTEXT_BYTES = 256 * 1024
export const SECURE_VAULT_MAX_CIPHERTEXT_BYTES = 512 * 1024
export const SECURE_VAULT_REMOTE_ENTRY_TTL_MS = 2 * 60_000

const SECURE_VAULT_MAX_REQUEST_ID_LENGTH = 128
const SECURE_VAULT_ENCRYPT_RESPONSE_CACHE_SIZE = 128
const SECURE_VAULT_REMOTE_ENTRY_MAX_CHALLENGES = 256
const SECURE_VAULT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/
const SECURE_VAULT_REMOTE_CONTEXT_BYTES = 1024
const SECURE_VAULT_REMOTE_ENVELOPE_BYTES = 512 * 1024
const SECURE_VAULT_REMOTE_AAD_PREFIX = 'forge-secure-browser-private-entry:v1'

export type SecureVaultErrorCode =
  | 'SECURE_VAULT_INVALID_REQUEST'
  | 'SECURE_VAULT_PAYLOAD_TOO_LARGE'
  | 'SECURE_VAULT_STORAGE_UNAVAILABLE'
  | 'SECURE_VAULT_INSECURE_STORAGE'
  | 'SECURE_VAULT_ENCRYPT_FAILED'
  | 'SECURE_VAULT_DECRYPT_FAILED'

type SecureVaultAvailableResult = { available: true }
type SecureVaultPayloadResult = {
  payload: string
  reEncryptedPayload?: string
}
type SecureVaultRemoteEntryChallengeResult = {
  challengeId: string
  keyId: string
  publicKey: string
  expiresAt: string
}

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
      operation:
        | 'encrypt'
        | 'decrypt'
        | 'remote_entry_challenge'
        | 'remote_entry_encrypt'
      payload: string
    }

export type SecureVaultResponse =
  | {
      type: typeof SECURE_VAULT_RESPONSE_TYPE
      requestId: string
      ok: true
      result:
        | SecureVaultAvailableResult
        | SecureVaultPayloadResult
        | SecureVaultRemoteEntryChallengeResult
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

export interface SafeStoragePort {
  isAsyncEncryptionAvailable(): Promise<boolean>
  getSelectedStorageBackend?(): string
  encryptStringAsync(plainText: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{
    shouldReEncrypt: boolean
    result: string
  }>
}

interface IpcMainPort {
  handle(
    channel: string,
    listener: (
      event: unknown,
      request: unknown,
    ) => SecureVaultRendererResponse | Promise<SecureVaultRendererResponse>,
  ): void
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

type PayloadOperationResult =
  | { ok: true; result: SecureVaultPayloadResult }
  | { ok: false; errorCode: SecureVaultErrorCode }

type SecureVaultAvailability =
  | { available: true }
  | {
      available: false
      errorCode:
        | 'SECURE_VAULT_STORAGE_UNAVAILABLE'
        | 'SECURE_VAULT_INSECURE_STORAGE'
    }

export interface SecureVaultController {
  status(): SecureVaultAvailability
  unlock(): Promise<SecureVaultAvailability>
  encryptPayload(payload: string): Promise<PayloadOperationResult>
  decryptPayload(payload: string): Promise<PayloadOperationResult>
  createRemoteEntryChallenge(
    contextPayload: string,
  ): Promise<
    | { ok: true; result: SecureVaultRemoteEntryChallengeResult }
    | { ok: false; errorCode: SecureVaultErrorCode }
  >
  encryptRemoteEntry(payload: string): Promise<PayloadOperationResult>
}

export async function initializeSecureVaultAtStartup(
  controller: Pick<SecureVaultController, 'unlock'>,
): Promise<void> {
  try {
    await controller.unlock()
  } catch {
    // Startup remains available without private storage. The renderer's manual
    // unlock action provides a bounded retry path if initialization fails.
  }
}

/**
 * Owns Electron safeStorage access for both renderer entry and backend use.
 *
 * `status()` deliberately remains passive: it never initializes the async
 * encryptor—or calls the synchronous availability API—and therefore never
 * opens or blocks on a native credential prompt merely because Settings
 * refreshed. Forge Desktop calls `unlock()` once during startup; the same
 * operation remains available for a manual retry. Encrypt/decrypt use Electron's
 * non-blocking API after initialization succeeds.
 */
export function createSecureVaultController(options: {
  safeStorage: SafeStoragePort
  platform: NodeJS.Platform
}): SecureVaultController {
  let unlockInFlight: Promise<SecureVaultAvailability> | null = null
  let unlockedAvailability: SecureVaultAvailability | null = null
  const remoteEntryKey = createECDH('prime256v1')
  remoteEntryKey.generateKeys()
  const remoteEntryKeyId = randomBytes(18).toString('base64url')
  const remoteEntryChallenges = new Map<string, {
    contextTag: string
    expiresAtMs: number
  }>()
  const status = (): SecureVaultAvailability => {
    return unlockedAvailability ?? {
      available: false,
      errorCode: 'SECURE_VAULT_STORAGE_UNAVAILABLE',
    }
  }

  const unlock = (): Promise<SecureVaultAvailability> => {
    if (unlockInFlight) {
      return unlockInFlight
    }
    unlockInFlight = (async () => {
      try {
        const available = await options.safeStorage.isAsyncEncryptionAvailable()
        if (!available) {
          unlockedAvailability = null
          return {
            available: false,
            errorCode: 'SECURE_VAULT_STORAGE_UNAVAILABLE',
          }
        }
        const availability = getUnlockedSecureVaultAvailability(options)
        unlockedAvailability = availability
        return availability
      } catch {
        unlockedAvailability = null
        return {
          available: false,
          errorCode: 'SECURE_VAULT_STORAGE_UNAVAILABLE',
        }
      } finally {
        unlockInFlight = null
      }
    })()
    return unlockInFlight
  }

  return {
    status,
    unlock,
    encryptPayload: async (plainPayload) => {
      const decoded = decodeCanonicalBase64(
        plainPayload,
        SECURE_VAULT_MAX_PLAINTEXT_BYTES,
      )
      if (!decoded.ok) {
        return { ok: false, errorCode: decoded.errorCode }
      }
      if (decoded.bytes.byteLength === 0) {
        decoded.bytes.fill(0)
        return { ok: false, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
      }

      try {
        const availability = status()
        if (!availability.available) {
          return { ok: false, errorCode: availability.errorCode }
        }

        const encrypted = await options.safeStorage.encryptStringAsync(plainPayload)
        if (!Buffer.isBuffer(encrypted) || encrypted.byteLength === 0) {
          return { ok: false, errorCode: 'SECURE_VAULT_ENCRYPT_FAILED' }
        }
        if (encrypted.byteLength > SECURE_VAULT_MAX_CIPHERTEXT_BYTES) {
          encrypted.fill(0)
          return { ok: false, errorCode: 'SECURE_VAULT_PAYLOAD_TOO_LARGE' }
        }

        try {
          return {
            ok: true,
            result: { payload: encrypted.toString('base64') },
          }
        } finally {
          encrypted.fill(0)
        }
      } catch {
        unlockedAvailability = null
        return { ok: false, errorCode: 'SECURE_VAULT_ENCRYPT_FAILED' }
      } finally {
        decoded.bytes.fill(0)
      }
    },
    decryptPayload: async (encryptedPayload) => {
      const decoded = decodeCanonicalBase64(
        encryptedPayload,
        SECURE_VAULT_MAX_CIPHERTEXT_BYTES,
      )
      if (!decoded.ok) {
        return { ok: false, errorCode: decoded.errorCode }
      }
      if (decoded.bytes.byteLength === 0) {
        decoded.bytes.fill(0)
        return { ok: false, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
      }

      try {
        const availability = status()
        if (!availability.available) {
          return { ok: false, errorCode: availability.errorCode }
        }

        const decrypted = await options.safeStorage.decryptStringAsync(decoded.bytes)
        const validatedPlainPayload = decodeCanonicalBase64(
          decrypted.result,
          SECURE_VAULT_MAX_PLAINTEXT_BYTES,
        )
        if (!validatedPlainPayload.ok || validatedPlainPayload.bytes.byteLength === 0) {
          if (validatedPlainPayload.ok) validatedPlainPayload.bytes.fill(0)
          return { ok: false, errorCode: 'SECURE_VAULT_DECRYPT_FAILED' }
        }
        validatedPlainPayload.bytes.fill(0)

        if (!decrypted.shouldReEncrypt) {
          return {
            ok: true,
            result: { payload: decrypted.result },
          }
        }

        const reEncrypted = await options.safeStorage.encryptStringAsync(decrypted.result)
        if (
          !Buffer.isBuffer(reEncrypted)
          || reEncrypted.byteLength === 0
          || reEncrypted.byteLength > SECURE_VAULT_MAX_CIPHERTEXT_BYTES
        ) {
          reEncrypted?.fill(0)
          return { ok: false, errorCode: 'SECURE_VAULT_DECRYPT_FAILED' }
        }
        try {
          return {
            ok: true,
            result: {
              payload: decrypted.result,
              reEncryptedPayload: reEncrypted.toString('base64'),
            },
          }
        } finally {
          reEncrypted.fill(0)
        }
      } catch {
        unlockedAvailability = null
        return { ok: false, errorCode: 'SECURE_VAULT_DECRYPT_FAILED' }
      } finally {
        decoded.bytes.fill(0)
      }
    },
    createRemoteEntryChallenge: async (contextPayload) => {
      const decoded = decodeCanonicalBase64(
        contextPayload,
        SECURE_VAULT_REMOTE_CONTEXT_BYTES,
      )
      if (!decoded.ok || decoded.bytes.byteLength === 0) {
        if (decoded.ok) decoded.bytes.fill(0)
        return { ok: false, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
      }
      try {
        const availability = status()
        if (!availability.available) {
          return { ok: false, errorCode: availability.errorCode }
        }
        pruneRemoteEntryChallenges(remoteEntryChallenges)
        while (
          remoteEntryChallenges.size >=
          SECURE_VAULT_REMOTE_ENTRY_MAX_CHALLENGES
        ) {
          const oldest = remoteEntryChallenges.keys().next().value
          if (typeof oldest !== 'string') break
          remoteEntryChallenges.delete(oldest)
        }
        const challengeId = randomUUID()
        const expiresAtMs = Date.now() + SECURE_VAULT_REMOTE_ENTRY_TTL_MS
        remoteEntryChallenges.set(challengeId, {
          contextTag: createRemoteContextTag(decoded.bytes),
          expiresAtMs,
        })
        return {
          ok: true,
          result: {
            challengeId,
            keyId: remoteEntryKeyId,
            publicKey: remoteEntryKey.getPublicKey().toString('base64'),
            expiresAt: new Date(expiresAtMs).toISOString(),
          },
        }
      } finally {
        decoded.bytes.fill(0)
      }
    },
    encryptRemoteEntry: async (payload) => {
      const decoded = decodeCanonicalBase64(
        payload,
        SECURE_VAULT_REMOTE_ENVELOPE_BYTES,
      )
      if (!decoded.ok || decoded.bytes.byteLength === 0) {
        if (decoded.ok) decoded.bytes.fill(0)
        return { ok: false, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
      }
      let plaintext: Buffer | null = null
      try {
        const availability = status()
        if (!availability.available) {
          return { ok: false, errorCode: availability.errorCode }
        }
        const envelope = parseRemoteEntryEnvelope(decoded.bytes)
        if (!envelope || envelope.keyId !== remoteEntryKeyId) {
          return { ok: false, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
        }
        pruneRemoteEntryChallenges(remoteEntryChallenges)
        const challenge = remoteEntryChallenges.get(envelope.challengeId)
        if (
          !challenge
          || challenge.contextTag !== createRemoteContextTag(envelope.context)
        ) {
          return { ok: false, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
        }
        remoteEntryChallenges.delete(envelope.challengeId)
        plaintext = decryptRemoteEntry(remoteEntryKey, envelope)
        if (!plaintext || plaintext.byteLength === 0) {
          return { ok: false, errorCode: 'SECURE_VAULT_DECRYPT_FAILED' }
        }
        return await createSecureVaultControllerPayloadResult(
          plaintext,
          options.safeStorage,
          status,
        )
      } catch {
        return { ok: false, errorCode: 'SECURE_VAULT_DECRYPT_FAILED' }
      } finally {
        plaintext?.fill(0)
        decoded.bytes.fill(0)
      }
    },
  }
}

export function createSecureVaultRequestHandler(options: {
  controller: SecureVaultController
}): {
  handle(message: unknown): Promise<SecureVaultResponse | null>
  dispose(): void
} {
  const responseCacheKey = randomBytes(32)
  const encryptResponseCache = new Map<string, {
    payloadTag: string
    response: Promise<SecureVaultResponse>
  }>()

  return {
    async handle(message: unknown): Promise<SecureVaultResponse | null> {
      const parsed = parseSecureVaultRequest(message)
      if (!parsed.ok) {
        return parsed.requestId
          ? createErrorResponse(parsed.requestId, parsed.errorCode)
          : null
      }

      const { request } = parsed
      const cached = encryptResponseCache.get(request.requestId)
      if (cached) {
        if (
          request.operation !== 'encrypt'
          && request.operation !== 'remote_entry_encrypt'
        ) {
          return createErrorResponse(request.requestId, 'SECURE_VAULT_INVALID_REQUEST')
        }
        const maxPayloadBytes = request.operation === 'encrypt'
          ? SECURE_VAULT_MAX_PLAINTEXT_BYTES
          : SECURE_VAULT_REMOTE_ENVELOPE_BYTES
        if (request.payload.length > maxBase64Length(maxPayloadBytes)) {
          return createErrorResponse(request.requestId, 'SECURE_VAULT_PAYLOAD_TOO_LARGE')
        }
        if (createPayloadTag(responseCacheKey, request.payload) !== cached.payloadTag) {
          return createErrorResponse(request.requestId, 'SECURE_VAULT_INVALID_REQUEST')
        }
        return await cached.response
      }

      const responsePromise = handleRequest(request, options.controller)
      if (
        request.operation !== 'encrypt'
        && request.operation !== 'remote_entry_encrypt'
      ) {
        return await responsePromise
      }

      const cacheEntry = {
        payloadTag: createPayloadTag(responseCacheKey, request.payload),
        response: responsePromise,
      }
      encryptResponseCache.set(request.requestId, cacheEntry)
      if (encryptResponseCache.size > SECURE_VAULT_ENCRYPT_RESPONSE_CACHE_SIZE) {
        const oldestRequestId = encryptResponseCache.keys().next().value
        if (typeof oldestRequestId === 'string') {
          encryptResponseCache.delete(oldestRequestId)
        }
      }

      const response = await responsePromise
      if (!response.ok && encryptResponseCache.get(request.requestId) === cacheEntry) {
        encryptResponseCache.delete(request.requestId)
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
  controller: SecureVaultController
}): () => void {
  const child = options.child as unknown as ChildProcessPort
  const handler = createSecureVaultRequestHandler({
    controller: options.controller,
  })
  let disposed = false

  const onMessage = (message: unknown): void => {
    void handler.handle(message)
      .then((response) => {
        if (!response || disposed || !child.connected) {
          return
        }
        try {
          child.send(response, () => {
            // The caller owns the request timeout and can retry the same requestId.
          })
        } catch {
          // Never include transport or safeStorage errors in logs or reply payloads.
        }
      })
      .catch(() => {
        // Never let an unexpected controller failure become an unhandled rejection.
      })
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
  controller: SecureVaultController
  isTrustedSender: (event: unknown) => boolean
}): () => void {
  options.ipcMain.handle(SECURE_VAULT_RENDERER_CHANNEL, async (event, request) => {
    if (!options.isTrustedSender(event) || !isRecord(request)) {
      return { ok: false, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
    }

    if (request.operation === 'status') {
      if (Object.keys(request).length !== 1) {
        return { ok: false, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
      }
      const availability = options.controller.status()
      return availability.available
        ? { ok: true, available: true }
        : { ok: false, errorCode: availability.errorCode }
    }

    if (request.operation === 'unlock') {
      if (Object.keys(request).length !== 1) {
        return { ok: false, errorCode: 'SECURE_VAULT_INVALID_REQUEST' }
      }
      const availability = await options.controller.unlock()
      return availability.available
        ? { ok: true, available: true }
        : { ok: false, errorCode: availability.errorCode }
    }

    if (
      request.operation !== 'encrypt'
      || typeof request.value !== 'string'
      || Object.keys(request).length !== 2
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

      const response = await options.controller.encryptPayload(
        plainTextBytes.toString('base64'),
      )
      if (!response.ok) {
        return { ok: false, errorCode: response.errorCode }
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

async function handleRequest(
  request: SecureVaultRequest,
  controller: SecureVaultController,
): Promise<SecureVaultResponse> {
  if (request.operation === 'status') {
    const availability = controller.status()
    return availability.available
      ? {
          type: SECURE_VAULT_RESPONSE_TYPE,
          requestId: request.requestId,
          ok: true,
          result: { available: true },
        }
      : createErrorResponse(request.requestId, availability.errorCode)
  }

  if (request.operation === 'remote_entry_challenge') {
    const response = await controller.createRemoteEntryChallenge(request.payload)
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

  const response = request.operation === 'encrypt'
    ? await controller.encryptPayload(request.payload)
    : request.operation === 'decrypt'
      ? await controller.decryptPayload(request.payload)
      : await controller.encryptRemoteEntry(request.payload)
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

interface ParsedRemoteEntryEnvelope {
  context: Buffer
  challengeId: string
  keyId: string
  ephemeralPublicKey: Buffer
  iv: Buffer
  ciphertext: Buffer
}

function parseRemoteEntryEnvelope(payload: Buffer): ParsedRemoteEntryEnvelope | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload.toString('utf8'))
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const allowedKeys = new Set([
    'context',
    'challengeId',
    'keyId',
    'ephemeralPublicKey',
    'iv',
    'ciphertext',
  ])
  if (Object.keys(parsed).some((key) => !allowedKeys.has(key))) return null
  if (
    typeof parsed.context !== 'string'
    || typeof parsed.challengeId !== 'string'
    || typeof parsed.keyId !== 'string'
    || typeof parsed.ephemeralPublicKey !== 'string'
    || typeof parsed.iv !== 'string'
    || typeof parsed.ciphertext !== 'string'
    || !/^[0-9a-f-]{36}$/iu.test(parsed.challengeId)
    || !/^[A-Za-z0-9_-]{16,64}$/u.test(parsed.keyId)
  ) {
    return null
  }
  const context = decodeCanonicalBase64(
    parsed.context,
    SECURE_VAULT_REMOTE_CONTEXT_BYTES,
  )
  const publicKey = decodeCanonicalBase64(parsed.ephemeralPublicKey, 65)
  const iv = decodeCanonicalBase64(parsed.iv, 12)
  const ciphertext = decodeCanonicalBase64(
    parsed.ciphertext,
    SECURE_VAULT_MAX_PLAINTEXT_BYTES + 16,
  )
  if (
    !context.ok
    || !publicKey.ok
    || !iv.ok
    || !ciphertext.ok
    || context.bytes.byteLength === 0
    || publicKey.bytes.byteLength !== 65
    || iv.bytes.byteLength !== 12
    || ciphertext.bytes.byteLength <= 16
  ) {
    if (context.ok) context.bytes.fill(0)
    if (publicKey.ok) publicKey.bytes.fill(0)
    if (iv.ok) iv.bytes.fill(0)
    if (ciphertext.ok) ciphertext.bytes.fill(0)
    return null
  }
  return {
    context: context.bytes,
    challengeId: parsed.challengeId,
    keyId: parsed.keyId,
    ephemeralPublicKey: publicKey.bytes,
    iv: iv.bytes,
    ciphertext: ciphertext.bytes,
  }
}

function decryptRemoteEntry(
  key: ReturnType<typeof createECDH>,
  envelope: ParsedRemoteEntryEnvelope,
): Buffer | null {
  let sharedSecret: Buffer | null = null
  let derivedKey: Buffer | null = null
  const additionalData = Buffer.from(
    `${SECURE_VAULT_REMOTE_AAD_PREFIX}:${envelope.keyId}:${envelope.challengeId}`,
    'utf8',
  )
  try {
    sharedSecret = key.computeSecret(envelope.ephemeralPublicKey)
    derivedKey = Buffer.from(hkdfSync(
      'sha256',
      sharedSecret,
      Buffer.alloc(32),
      additionalData,
      32,
    ))
    const tagOffset = envelope.ciphertext.byteLength - 16
    const encrypted = envelope.ciphertext.subarray(0, tagOffset)
    const authTag = envelope.ciphertext.subarray(tagOffset)
    const decipher = createDecipheriv('aes-256-gcm', derivedKey, envelope.iv)
    decipher.setAAD(additionalData)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ])
    return plaintext.byteLength <= SECURE_VAULT_MAX_PLAINTEXT_BYTES
      ? plaintext
      : (plaintext.fill(0), null)
  } catch {
    return null
  } finally {
    envelope.context.fill(0)
    envelope.ephemeralPublicKey.fill(0)
    envelope.iv.fill(0)
    envelope.ciphertext.fill(0)
    sharedSecret?.fill(0)
    derivedKey?.fill(0)
    additionalData.fill(0)
  }
}

async function createSecureVaultControllerPayloadResult(
  plaintext: Buffer,
  safeStoragePort: SafeStoragePort,
  status: () => SecureVaultAvailability,
): Promise<PayloadOperationResult> {
  const availability = status()
  if (!availability.available) {
    return { ok: false, errorCode: availability.errorCode }
  }
  const plainPayload = plaintext.toString('base64')
  const encrypted = await safeStoragePort.encryptStringAsync(plainPayload)
  if (!Buffer.isBuffer(encrypted) || encrypted.byteLength === 0) {
    encrypted?.fill(0)
    return { ok: false, errorCode: 'SECURE_VAULT_ENCRYPT_FAILED' }
  }
  if (encrypted.byteLength > SECURE_VAULT_MAX_CIPHERTEXT_BYTES) {
    encrypted.fill(0)
    return { ok: false, errorCode: 'SECURE_VAULT_PAYLOAD_TOO_LARGE' }
  }
  try {
    return {
      ok: true,
      result: { payload: encrypted.toString('base64') },
    }
  } finally {
    encrypted.fill(0)
  }
}

function createRemoteContextTag(context: Uint8Array): string {
  return createHash('sha256').update(context).digest('hex')
}

function pruneRemoteEntryChallenges(
  challenges: Map<string, { contextTag: string; expiresAtMs: number }>,
): void {
  const now = Date.now()
  for (const [challengeId, challenge] of challenges) {
    if (challenge.expiresAtMs <= now) challenges.delete(challengeId)
  }
}

function getUnlockedSecureVaultAvailability(
  options: {
    safeStorage: Pick<SafeStoragePort, 'getSelectedStorageBackend'>
    platform: NodeJS.Platform
  },
): SecureVaultAvailability {
  try {
    if (options.platform === 'linux') {
      if (typeof options.safeStorage.getSelectedStorageBackend !== 'function') {
        return {
          available: false,
          errorCode: 'SECURE_VAULT_STORAGE_UNAVAILABLE',
        }
      }
      const backend = options.safeStorage.getSelectedStorageBackend()
      if (backend === 'basic_text') {
        return {
          available: false,
          errorCode: 'SECURE_VAULT_INSECURE_STORAGE',
        }
      }
      if (backend === 'unknown') {
        return {
          available: false,
          errorCode: 'SECURE_VAULT_STORAGE_UNAVAILABLE',
        }
      }
    }

    return { available: true }
  } catch {
    return {
      available: false,
      errorCode: 'SECURE_VAULT_STORAGE_UNAVAILABLE',
    }
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

  if (
    value.operation !== 'status'
    && value.operation !== 'encrypt'
    && value.operation !== 'decrypt'
    && value.operation !== 'remote_entry_challenge'
    && value.operation !== 'remote_entry_encrypt'
  ) {
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
    typeof value !== 'string'
    || value.length === 0
    || value.length > SECURE_VAULT_MAX_REQUEST_ID_LENGTH
    || !SECURE_VAULT_REQUEST_ID_PATTERN.test(value)
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
