import type { BrowserAutomationRequest, BrowserAutomationResponse } from '@forge/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_IPC } from '../browser-bridge-contract.js'
import { createTrustedBrowserBridge } from '../trusted-browser-bridge.js'

class FakeMediaRecorder {
  static isTypeSupported(): boolean { return true }
  state: RecordingState = 'inactive'
  private readonly listeners = new Map<string, Array<(event: Event & { data?: Blob }) => void>>()

  constructor(_stream: MediaStream, readonly mimeType: string) {}
  addEventListener(type: string, listener: (event: Event & { data?: Blob }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  start(): void { this.state = 'recording' }
  stop(): void {
    this.state = 'inactive'
    for (const listener of this.listeners.get('dataavailable') ?? []) listener({ data: new Blob([new Uint8Array([1])]) } as Event & { data: Blob })
    for (const listener of this.listeners.get('stop') ?? []) listener(new Event('stop'))
  }
}

const originalDocument = globalThis.document
const originalMediaRecorder = globalThis.MediaRecorder
const originalImage = globalThis.Image

afterEach(() => {
  Object.assign(globalThis, { document: originalDocument, MediaRecorder: originalMediaRecorder, Image: originalImage })
})

describe('trusted browser recording bridge', () => {
  it('rejects a concurrent stop with its own retryable envelope while the first stop completes with its own routing', async () => {
    let releaseCapture!: () => void
    const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve })
    let captureStarted!: () => void
    const captureCalled = new Promise<void>((resolve) => { captureStarted = resolve })
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const ipcRenderer = {
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => { listeners.set(channel, listener) }),
      removeListener: vi.fn(),
      invoke: vi.fn(async (channel: string, input: unknown) => {
        if (channel === BROWSER_IPC.prepareRecording) return ok({ recordingId: 'recording-1', tabId: 'tab-1', startedAt: new Date(0).toISOString(), width: 10, height: 10 })
        if (channel === BROWSER_IPC.execute) return ok(success(input as BrowserAutomationRequest))
        if (channel === BROWSER_IPC.stopRecordingCapture) {
          captureStarted()
          await captureGate
          return ok({ recordingId: 'recording-1', tabId: 'tab-1', startedAt: new Date(0).toISOString(), width: 10, height: 10 })
        }
        if (channel === BROWSER_IPC.saveRecording) return ok(success((input as { request: BrowserAutomationRequest }).request))
        if (channel === BROWSER_IPC.cancelRecording) return ok(undefined)
        throw new Error(`unexpected IPC ${channel}`)
      }),
    }
    Object.assign(globalThis, {
      document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), captureStream: () => ({}) }) },
      MediaRecorder: FakeMediaRecorder,
      Image: class {},
    })

    const bridge = createTrustedBrowserBridge(ipcRenderer as never)
    await bridge.invoke(request('start-1', 'recordingStart'))
    const firstRequest = request('stop-1', 'recordingStop')
    const secondRequest = request('stop-2', 'recordingStop')
    const first = bridge.invoke(firstRequest)
    await captureCalled
    const second = await bridge.invoke(secondRequest)
    expect(second).toMatchObject({
      requestId: 'stop-2', hostId: 'host-1', hostGeneration: 3, sessionAgentId: 'session-1', profileId: 'profile-1', tabId: 'tab-1', operation: 'recordingStop',
      ok: false, error: { code: 'recording-conflict', retryable: true },
    })
    releaseCapture()
    await expect(first).resolves.toMatchObject({
      requestId: 'stop-1', hostId: 'host-1', hostGeneration: 3, sessionAgentId: 'session-1', profileId: 'profile-1', tabId: 'tab-1', operation: 'recordingStop', ok: true,
    })
  })
})

function request(requestId: string, operation: 'recordingStart' | 'recordingStop'): BrowserAutomationRequest {
  return {
    requestId,
    hostKind: 'managed-electron',
    sessionAgentId: 'session-1',
    profileId: 'profile-1',
    tabId: 'tab-1',
    hostId: 'host-1',
    hostGeneration: 3,
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    artifactDirectory: '/approved',
    operation,
    input: operation === 'recordingStop' ? { recordingId: 'recording-1' } : {},
  } as BrowserAutomationRequest
}

function success(request: BrowserAutomationRequest): BrowserAutomationResponse {
  if (request.operation === 'recordingStart') {
    return { ...request, ok: true, result: { recordingId: 'recording-1', tabId: 'tab-1', recording: true, startedAt: new Date(0).toISOString(), mimeType: 'video/webm', width: 10, height: 10 }, elapsedMs: 1 }
  }
  return { ...request, ok: true, result: { recordingId: 'recording-1', tabId: 'tab-1', path: '/approved/recording-1.webm', mimeType: 'video/webm', extension: 'webm', sizeBytes: 1, width: 10, height: 10, createdAt: new Date(0).toISOString() }, elapsedMs: 1 }
}

function ok<T>(value: T) {
  return { __forgeBrowserIpcResult: true, ok: true, value }
}
