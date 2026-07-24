import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  SECURE_VAULT_MAX_PLAINTEXT_BYTES,
  SECURE_VAULT_RENDERER_CHANNEL,
  createSecureVaultRequestHandler,
  installSecureVaultChildBridge,
  installSecureVaultRendererIpc,
} from '../secure-vault-ipc.js'

function createSafeStorage(options: {
  available?: boolean
  backend?: string
  encrypt?: (value: string) => Buffer
  decrypt?: (value: Buffer) => string
} = {}) {
  return {
    isEncryptionAvailable: vi.fn(() => options.available ?? true),
    getSelectedStorageBackend: vi.fn(() => options.backend ?? 'gnome_libsecret'),
    encryptString: vi.fn(options.encrypt ?? ((value: string) => Buffer.from(`sealed:${value}`, 'utf8'))),
    decryptString: vi.fn(options.decrypt ?? ((value: Buffer) => value.toString('utf8').replace(/^sealed:/, ''))),
  }
}

describe('secure vault backend child IPC', () => {
  it('round-trips arbitrary bytes as base64 without requiring UTF-8 plaintext', () => {
    const safeStorage = createSafeStorage()
    const handler = createSecureVaultRequestHandler({ safeStorage, platform: 'darwin' })
    const plainPayload = Buffer.from([0, 1, 2, 127, 128, 254, 255]).toString('base64')

    const encrypted = handler.handle({
      type: 'secure_vault_request',
      requestId: 'request-1',
      operation: 'encrypt',
      payload: plainPayload,
    })

    expect(encrypted).toMatchObject({
      type: 'secure_vault_response',
      requestId: 'request-1',
      ok: true,
    })
    if (!encrypted?.ok || !('payload' in encrypted.result)) {
      throw new Error('Expected encrypted payload')
    }

    const decrypted = handler.handle({
      type: 'secure_vault_request',
      requestId: 'request-2',
      operation: 'decrypt',
      payload: encrypted.result.payload,
    })

    expect(decrypted).toEqual({
      type: 'secure_vault_response',
      requestId: 'request-2',
      ok: true,
      result: { payload: plainPayload },
    })
  })

  it('rejects Linux basic_text even when Electron reports encryption available', () => {
    const safeStorage = createSafeStorage({ backend: 'basic_text' })
    const handler = createSecureVaultRequestHandler({ safeStorage, platform: 'linux' })

    expect(handler.handle({
      type: 'secure_vault_request',
      requestId: 'status-1',
      operation: 'status',
    })).toEqual({
      type: 'secure_vault_response',
      requestId: 'status-1',
      ok: false,
      errorCode: 'SECURE_VAULT_INSECURE_STORAGE',
    })

    expect(handler.handle({
      type: 'secure_vault_request',
      requestId: 'encrypt-1',
      operation: 'encrypt',
      payload: Buffer.from('secret').toString('base64'),
    })).toEqual({
      type: 'secure_vault_response',
      requestId: 'encrypt-1',
      ok: false,
      errorCode: 'SECURE_VAULT_INSECURE_STORAGE',
    })
    expect(safeStorage.encryptString).not.toHaveBeenCalled()
  })

  it('bounds and validates payloads before safeStorage', () => {
    const safeStorage = createSafeStorage()
    const handler = createSecureVaultRequestHandler({ safeStorage, platform: 'win32' })
    const oversized = Buffer.alloc(SECURE_VAULT_MAX_PLAINTEXT_BYTES + 1).toString('base64')

    expect(handler.handle({
      type: 'secure_vault_request',
      requestId: 'large-1',
      operation: 'encrypt',
      payload: oversized,
    })).toMatchObject({
      ok: false,
      errorCode: 'SECURE_VAULT_PAYLOAD_TOO_LARGE',
    })
    expect(handler.handle({
      type: 'secure_vault_request',
      requestId: 'invalid-1',
      operation: 'encrypt',
      payload: 'not canonical base64',
    })).toMatchObject({
      ok: false,
      errorCode: 'SECURE_VAULT_INVALID_REQUEST',
    })
    expect(handler.handle({
      type: 'secure_vault_request',
      requestId: 'empty-1',
      operation: 'encrypt',
      payload: '',
    })).toMatchObject({
      ok: false,
      errorCode: 'SECURE_VAULT_INVALID_REQUEST',
    })
    expect(safeStorage.encryptString).not.toHaveBeenCalled()
  })

  it('uses stable request IDs to replay one bounded encrypt result', () => {
    let encryptionSequence = 0
    const safeStorage = createSafeStorage({
      encrypt: (value) => Buffer.from(`${++encryptionSequence}:${value}`, 'utf8'),
    })
    const handler = createSecureVaultRequestHandler({ safeStorage, platform: 'darwin' })
    const firstRequest = {
      type: 'secure_vault_request',
      requestId: 'stable-operation-id',
      operation: 'encrypt',
      payload: Buffer.from('first').toString('base64'),
    }

    const first = handler.handle(firstRequest)
    const retry = handler.handle(firstRequest)
    const conflictingRetry = handler.handle({
      ...firstRequest,
      payload: Buffer.from('different').toString('base64'),
    })

    expect(retry).toEqual(first)
    expect(conflictingRetry).toEqual({
      type: 'secure_vault_response',
      requestId: 'stable-operation-id',
      ok: false,
      errorCode: 'SECURE_VAULT_INVALID_REQUEST',
    })
    expect(safeStorage.encryptString).toHaveBeenCalledTimes(1)
    handler.dispose()
  })

  it('maps provider exceptions to fixed errors without reflecting values or messages', () => {
    const canary = 'do-not-reflect-this-value'
    const safeStorage = createSafeStorage({
      encrypt: () => {
        throw new Error(canary)
      },
    })
    const handler = createSecureVaultRequestHandler({ safeStorage, platform: 'darwin' })

    const response = handler.handle({
      type: 'secure_vault_request',
      requestId: 'failure-1',
      operation: 'encrypt',
      payload: Buffer.from(canary).toString('base64'),
    })

    expect(response).toEqual({
      type: 'secure_vault_response',
      requestId: 'failure-1',
      ok: false,
      errorCode: 'SECURE_VAULT_ENCRYPT_FAILED',
    })
    expect(JSON.stringify(response)).not.toContain(canary)
  })

  it('attaches a request/reply listener without consuming unrelated backend messages', () => {
    class FakeChild extends EventEmitter {
      connected = true
      sent: unknown[] = []

      send(message: unknown, callback?: (error: Error | null) => void): boolean {
        this.sent.push(message)
        callback?.(null)
        return true
      }
    }

    const child = new FakeChild()
    const dispose = installSecureVaultChildBridge({
      child: child as never,
      safeStorage: createSafeStorage(),
      platform: 'darwin',
    })

    child.emit('message', { type: 'ready', port: 47287 })
    child.emit('message', {
      type: 'secure_vault_request',
      requestId: 'status-child',
      operation: 'status',
    })

    expect(child.sent).toEqual([{
      type: 'secure_vault_response',
      requestId: 'status-child',
      ok: true,
      result: { available: true },
    }])

    dispose()
    child.emit('message', {
      type: 'secure_vault_request',
      requestId: 'status-after-dispose',
      operation: 'status',
    })
    expect(child.sent).toHaveLength(1)
  })
})

describe('secure vault renderer IPC', () => {
  it('exposes only trusted status and encrypt operations', () => {
    const handlers = new Map<string, (event: unknown, request: unknown) => unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, listener: (event: unknown, request: unknown) => unknown) => {
        handlers.set(channel, listener)
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    }
    const trustedEvent = { sender: 'trusted' }
    const dispose = installSecureVaultRendererIpc({
      ipcMain,
      safeStorage: createSafeStorage(),
      platform: 'darwin',
      isTrustedSender: (event) => event === trustedEvent,
    })
    const invoke = handlers.get(SECURE_VAULT_RENDERER_CHANNEL)
    if (!invoke) throw new Error('Expected secure vault renderer handler')

    expect(invoke(trustedEvent, { operation: 'status' })).toEqual({
      ok: true,
      available: true,
    })
    expect(invoke(trustedEvent, { operation: 'encrypt', value: 'local secret' })).toEqual({
      ok: true,
      encryptedPayloadBase64: Buffer.from(`sealed:${Buffer.from('local secret').toString('base64')}`).toString('base64'),
    })
    expect(invoke(trustedEvent, { operation: 'decrypt', value: 'anything' })).toEqual({
      ok: false,
      errorCode: 'SECURE_VAULT_INVALID_REQUEST',
    })
    expect(invoke({ sender: 'other' }, { operation: 'encrypt', value: 'local secret' })).toEqual({
      ok: false,
      errorCode: 'SECURE_VAULT_INVALID_REQUEST',
    })

    dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(SECURE_VAULT_RENDERER_CHANNEL)
  })
})
