import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  SECURE_VAULT_MAX_PLAINTEXT_BYTES,
  SECURE_VAULT_RENDERER_CHANNEL,
  createSecureVaultController,
  createSecureVaultRequestHandler,
  installSecureVaultChildBridge,
  installSecureVaultRendererIpc,
} from '../secure-vault-ipc.js'

function createSafeStorage(options: {
  available?: boolean
  asyncAvailable?: boolean | (() => Promise<boolean>)
  backend?: string
  encrypt?: (value: string) => Buffer | Promise<Buffer>
  decrypt?: (
    value: Buffer,
  ) =>
    | { shouldReEncrypt: boolean; result: string }
    | Promise<{ shouldReEncrypt: boolean; result: string }>
} = {}) {
  return {
    isEncryptionAvailable: vi.fn(() => options.available ?? true),
    isAsyncEncryptionAvailable: vi.fn(
      typeof options.asyncAvailable === 'function'
        ? options.asyncAvailable
        : async () => options.asyncAvailable ?? true,
    ),
    getSelectedStorageBackend: vi.fn(() => options.backend ?? 'gnome_libsecret'),
    encryptStringAsync: vi.fn(
      options.encrypt
      ?? (async (value: string) => Buffer.from(`sealed:${value}`, 'utf8')),
    ),
    decryptStringAsync: vi.fn(
      options.decrypt
      ?? (async (value: Buffer) => ({
        shouldReEncrypt: false,
        result: value.toString('utf8').replace(/^sealed:/, ''),
      })),
    ),
  }
}

function createController(
  safeStorage = createSafeStorage(),
  platform: NodeJS.Platform = 'darwin',
) {
  return createSecureVaultController({ safeStorage, platform })
}

describe('secure vault controller', () => {
  it('keeps status passive and initializes only for an explicit unlock', async () => {
    const safeStorage = createSafeStorage({ available: false })
    const controller = createController(safeStorage)

    expect(controller.status()).toEqual({
      available: false,
      errorCode: 'SECURE_VAULT_STORAGE_UNAVAILABLE',
    })
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorage.isAsyncEncryptionAvailable).not.toHaveBeenCalled()

    expect(await controller.unlock()).toEqual({ available: true })
    expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(1)
    expect(controller.status()).toEqual({ available: true })
  })

  it('coalesces concurrent native unlock prompts and permits a clean retry', async () => {
    let resolveFirst: ((available: boolean) => void) | undefined
    const first = new Promise<boolean>((resolve) => {
      resolveFirst = resolve
    })
    const safeStorage = createSafeStorage({
      available: false,
      asyncAvailable: vi.fn()
        .mockImplementationOnce(() => first)
        .mockResolvedValueOnce(true),
    })
    const controller = createController(safeStorage)

    const unlockOne = controller.unlock()
    const unlockTwo = controller.unlock()
    expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(1)
    resolveFirst?.(false)

    expect(await unlockOne).toMatchObject({ available: false })
    expect(await unlockTwo).toMatchObject({ available: false })
    expect(await controller.unlock()).toEqual({ available: true })
    expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(2)
  })

  it('round-trips arbitrary bytes and returns replacement ciphertext on key rotation', async () => {
    const safeStorage = createSafeStorage({
      decrypt: async (value) => ({
        shouldReEncrypt: true,
        result: value.toString('utf8').replace(/^sealed:/, ''),
      }),
      encrypt: async (value) => Buffer.from(`current:${value}`, 'utf8'),
    })
    const controller = createController(safeStorage)
    const plainPayload = Buffer.from([0, 1, 2, 127, 128, 254, 255]).toString('base64')
    const legacyCiphertext = Buffer.from(`sealed:${plainPayload}`).toString('base64')

    expect(await controller.unlock()).toEqual({ available: true })
    const decrypted = await controller.decryptPayload(legacyCiphertext)

    expect(decrypted).toEqual({
      ok: true,
      result: {
        payload: plainPayload,
        reEncryptedPayload:
          Buffer.from(`current:${plainPayload}`).toString('base64'),
      },
    })
  })
})

describe('secure vault backend child IPC', () => {
  it('rejects Linux basic_text even when Electron reports encryption available', async () => {
    const safeStorage = createSafeStorage({ backend: 'basic_text' })
    const controller = createController(safeStorage, 'linux')
    const handler = createSecureVaultRequestHandler({
      controller,
    })

    expect(await controller.unlock()).toEqual({
      available: false,
      errorCode: 'SECURE_VAULT_INSECURE_STORAGE',
    })
    expect(await handler.handle({
      type: 'secure_vault_request',
      requestId: 'status-1',
      operation: 'status',
    })).toEqual({
      type: 'secure_vault_response',
      requestId: 'status-1',
      ok: false,
      errorCode: 'SECURE_VAULT_INSECURE_STORAGE',
    })

    expect(await handler.handle({
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
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled()
  })

  it('bounds and validates payloads before safeStorage', async () => {
    const safeStorage = createSafeStorage()
    const handler = createSecureVaultRequestHandler({
      controller: createController(safeStorage, 'win32'),
    })
    const oversized = Buffer.alloc(
      SECURE_VAULT_MAX_PLAINTEXT_BYTES + 1,
    ).toString('base64')

    expect(await handler.handle({
      type: 'secure_vault_request',
      requestId: 'large-1',
      operation: 'encrypt',
      payload: oversized,
    })).toMatchObject({
      ok: false,
      errorCode: 'SECURE_VAULT_PAYLOAD_TOO_LARGE',
    })
    expect(await handler.handle({
      type: 'secure_vault_request',
      requestId: 'invalid-1',
      operation: 'encrypt',
      payload: 'not canonical base64',
    })).toMatchObject({
      ok: false,
      errorCode: 'SECURE_VAULT_INVALID_REQUEST',
    })
    expect(await handler.handle({
      type: 'secure_vault_request',
      requestId: 'empty-1',
      operation: 'encrypt',
      payload: '',
    })).toMatchObject({
      ok: false,
      errorCode: 'SECURE_VAULT_INVALID_REQUEST',
    })
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled()
  })

  it('uses stable request IDs to replay one bounded async encrypt result', async () => {
    let encryptionSequence = 0
    const safeStorage = createSafeStorage({
      encrypt: async (value) =>
        Buffer.from(`${++encryptionSequence}:${value}`, 'utf8'),
    })
    const controller = createController(safeStorage)
    expect(await controller.unlock()).toEqual({ available: true })
    const unlockedHandler = createSecureVaultRequestHandler({ controller })
    const firstRequest = {
      type: 'secure_vault_request',
      requestId: 'stable-operation-id',
      operation: 'encrypt',
      payload: Buffer.from('first').toString('base64'),
    }

    const [first, retry] = await Promise.all([
      unlockedHandler.handle(firstRequest),
      unlockedHandler.handle(firstRequest),
    ])
    const conflictingRetry = await unlockedHandler.handle({
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
    expect(safeStorage.encryptStringAsync).toHaveBeenCalledTimes(1)
    unlockedHandler.dispose()
  })

  it('maps provider exceptions to fixed errors without reflecting values or messages', async () => {
    const canary = 'do-not-reflect-this-value'
    const safeStorage = createSafeStorage({
      encrypt: async () => {
        throw new Error(canary)
      },
    })
    const controller = createController(safeStorage)
    expect(await controller.unlock()).toEqual({ available: true })
    const handler = createSecureVaultRequestHandler({ controller })

    const response = await handler.handle({
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

  it('attaches a request/reply listener without consuming unrelated backend messages', async () => {
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
    const controller = createController()
    expect(await controller.unlock()).toEqual({ available: true })
    const dispose = installSecureVaultChildBridge({
      child: child as never,
      controller,
    })

    child.emit('message', { type: 'ready', port: 47287 })
    child.emit('message', {
      type: 'secure_vault_request',
      requestId: 'status-child',
      operation: 'status',
    })
    await vi.waitFor(() => expect(child.sent).toHaveLength(1))

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
    await Promise.resolve()
    expect(child.sent).toHaveLength(1)
  })
})

describe('secure vault renderer IPC', () => {
  it('exposes trusted passive status, explicit unlock, and encrypt operations', async () => {
    const handlers = new Map<
      string,
      (event: unknown, request: unknown) => unknown
    >()
    const ipcMain = {
      handle: vi.fn((
        channel: string,
        listener: (event: unknown, request: unknown) => unknown,
      ) => {
        handlers.set(channel, listener)
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    }
    const trustedEvent = { sender: 'trusted' }
    const safeStorage = createSafeStorage({ available: false })
    const controller = createController(safeStorage)
    const dispose = installSecureVaultRendererIpc({
      ipcMain,
      controller,
      isTrustedSender: (event) => event === trustedEvent,
    })
    const invoke = handlers.get(SECURE_VAULT_RENDERER_CHANNEL)
    if (!invoke) throw new Error('Expected secure vault renderer handler')

    expect(await invoke(trustedEvent, { operation: 'status' })).toEqual({
      ok: false,
      errorCode: 'SECURE_VAULT_STORAGE_UNAVAILABLE',
    })
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorage.isAsyncEncryptionAvailable).not.toHaveBeenCalled()
    expect(await invoke(trustedEvent, { operation: 'unlock' })).toEqual({
      ok: true,
      available: true,
    })
    expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(1)

    expect(await invoke(
      trustedEvent,
      { operation: 'encrypt', value: 'local secret' },
    )).toEqual({
      ok: true,
      encryptedPayloadBase64: Buffer.from(
        `sealed:${Buffer.from('local secret').toString('base64')}`,
      ).toString('base64'),
    })
    expect(await invoke(
      trustedEvent,
      { operation: 'decrypt', value: 'anything' },
    )).toEqual({
      ok: false,
      errorCode: 'SECURE_VAULT_INVALID_REQUEST',
    })
    expect(await invoke(
      { sender: 'other' },
      { operation: 'encrypt', value: 'local secret' },
    )).toEqual({
      ok: false,
      errorCode: 'SECURE_VAULT_INVALID_REQUEST',
    })

    dispose()
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(
      SECURE_VAULT_RENDERER_CHANNEL,
    )
  })
})
