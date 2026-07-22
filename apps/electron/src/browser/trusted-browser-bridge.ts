/* Recording coordination follows T3 Code browserRecording.ts at 9a0a0716 (MIT). */
import type { BrowserAutomationRequest, BrowserAutomationResponse, BrowserTabSnapshot, BrowserViewportSetting } from '@forge/protocol'
import type { IpcRenderer, IpcRendererEvent } from 'electron'
import { BROWSER_IPC, browserBridgeCapabilities, type BrowserAutomationBridge, type BrowserBridgeConfig } from './browser-bridge-contract.js'
import type { BrowserWebviewRegistration, PreparedRecording } from './browser-automation-manager.js'

interface RendererRecording {
  prepared: PreparedRecording
  canvas: HTMLCanvasElement
  context: CanvasRenderingContext2D
  recorder: MediaRecorder
  chunks: Blob[]
  mimeType: string
  phase: 'starting' | 'recording' | 'stopping'
  startPromise: Promise<BrowserAutomationResponse> | null
  stopPromise: Promise<BrowserAutomationResponse> | null
}

export function createTrustedBrowserBridge(ipcRenderer: IpcRenderer): BrowserAutomationBridge {
  let active: RendererRecording | null = null

  const drawFrame = (_event: IpcRendererEvent, payload: unknown): void => {
    if (!active || !payload || typeof payload !== 'object') return
    const frame = payload as { recordingId?: unknown; data?: unknown }
    if (frame.recordingId !== active.prepared.recordingId || typeof frame.data !== 'string') return
    const recording = active
    const image = new Image()
    image.addEventListener('load', () => {
      if (active === recording) recording.context.drawImage(image, 0, 0, recording.canvas.width, recording.canvas.height)
    }, { once: true })
    image.src = `data:image/jpeg;base64,${frame.data}`
  }
  ipcRenderer.on(BROWSER_IPC.recordingFrame, drawFrame)

  const invoke = async (request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> => {
    if (request.operation === 'recordingStart') return startRecording(request)
    if (request.operation === 'recordingStop') return stopRecording(request)
    return ipcRenderer.invoke(BROWSER_IPC.execute, request) as Promise<BrowserAutomationResponse>
  }

  const startRecording = async (request: BrowserAutomationRequest & { operation: 'recordingStart' }): Promise<BrowserAutomationResponse> => {
    if (active) {
      if (active.prepared.tabId === request.tabId && active.phase === 'recording') {
        return ipcRenderer.invoke(BROWSER_IPC.execute, request) as Promise<BrowserAutomationResponse>
      }
      return failure(request, 'recording-conflict', 'Another browser recording is active')
    }
    try {
      const prepared = await ipcRenderer.invoke(BROWSER_IPC.prepareRecording, request) as PreparedRecording
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, prepared.width)
      canvas.height = Math.max(1, prepared.height)
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('Browser recording canvas is unavailable')
      const mimeType = preferredMimeType()
      const recorder = new MediaRecorder(canvas.captureStream(12), { mimeType, videoBitsPerSecond: 4_000_000 })
      const chunks: Blob[] = []
      recorder.addEventListener('dataavailable', (event) => { if (event.data.size > 0) chunks.push(event.data) })
      const recording: RendererRecording = { prepared, canvas, context, recorder, chunks, mimeType, phase: 'starting', startPromise: null, stopPromise: null }
      active = recording
      recorder.start(1_000)
      const startPromise = ipcRenderer.invoke(BROWSER_IPC.execute, { ...request, recordingMimeType: mimeType }) as Promise<BrowserAutomationResponse>
      recording.startPromise = startPromise
      const response = await startPromise
      if (!response.ok) {
        await stopMediaRecorder(recorder)
        active = null
        await ipcRenderer.invoke(BROWSER_IPC.cancelRecording, prepared.recordingId)
        return response
      }
      if (active !== recording) throw new Error('Browser recording startup was interrupted')
      recording.phase = 'recording'
      if (response.ok && response.operation === 'recordingStart') response.result.mimeType = mimeType
      return response
    } catch (error) {
      const recordingId = active?.prepared.recordingId
      if (active) await stopMediaRecorder(active.recorder).catch(() => undefined)
      active = null
      await ipcRenderer.invoke(BROWSER_IPC.cancelRecording, recordingId).catch(() => undefined)
      return failure(request, 'execution-failed', error instanceof Error ? error.message : 'Browser recording failed to start')
    }
  }

  const stopRecording = (request: BrowserAutomationRequest & { operation: 'recordingStop' }): Promise<BrowserAutomationResponse> => {
    const recording = active
    if (!recording || (request.input.recordingId && request.input.recordingId !== recording.prepared.recordingId) || (request.tabId && request.tabId !== recording.prepared.tabId)) {
      return Promise.resolve(failure(request, 'recording-not-found', 'The requested browser recording is not active'))
    }
    if (recording.stopPromise) return recording.stopPromise
    const stopPromise = (async () => {
      try {
        if (recording.phase === 'starting' && recording.startPromise) {
          const startResponse = await recording.startPromise
          if (!startResponse.ok) return startResponse
        }
        recording.phase = 'stopping'
        await ipcRenderer.invoke(BROWSER_IPC.stopRecordingCapture, request)
        await stopMediaRecorder(recording.recorder)
        const blob = new Blob(recording.chunks, { type: recording.mimeType })
        const bytes = new Uint8Array(await blob.arrayBuffer())
        return await ipcRenderer.invoke(BROWSER_IPC.saveRecording, { request, mimeType: recording.mimeType, bytes }) as BrowserAutomationResponse
      } catch (error) {
        await ipcRenderer.invoke(BROWSER_IPC.cancelRecording, recording.prepared.recordingId).catch(() => undefined)
        return failure(request, 'execution-failed', error instanceof Error ? error.message : 'Browser recording failed to stop')
      } finally {
        if (active === recording) active = null
      }
    })()
    recording.stopPromise = stopPromise
    return stopPromise
  }

  return {
    capabilities: browserBridgeCapabilities,
    getWebviewConfig: (profileId: string): Promise<BrowserBridgeConfig> => ipcRenderer.invoke(BROWSER_IPC.config, profileId),
    registerWebview: (registration: BrowserWebviewRegistration): Promise<BrowserTabSnapshot> => ipcRenderer.invoke(BROWSER_IPC.register, registration),
    unregisterWebview: (tabId: string, webContentsId?: number): Promise<void> => ipcRenderer.invoke(BROWSER_IPC.unregister, { tabId, webContentsId }),
    setTabPresentation: (tabId: string, visible: boolean, viewportSetting?: BrowserViewportSetting): Promise<BrowserTabSnapshot> => ipcRenderer.invoke(BROWSER_IPC.presentation, { tabId, visible, viewportSetting }),
    invoke,
    onStateChanged: (listener: (tab: BrowserTabSnapshot) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, tab: BrowserTabSnapshot): void => listener(tab)
      ipcRenderer.on(BROWSER_IPC.stateChanged, handler)
      return () => ipcRenderer.removeListener(BROWSER_IPC.stateChanged, handler)
    },
  }
}

function preferredMimeType(): string {
  const candidates = ['video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp9', 'video/webm']
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? 'video/webm'
}

async function stopMediaRecorder(recorder: MediaRecorder): Promise<void> {
  if (recorder.state === 'inactive') return
  await new Promise<void>((resolve) => {
    recorder.addEventListener('stop', () => resolve(), { once: true })
    recorder.stop()
  })
}

function failure(request: BrowserAutomationRequest, code: 'recording-conflict' | 'recording-not-found' | 'execution-failed', message: string): BrowserAutomationResponse {
  return {
    requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId,
    tabId: request.tabId, hostId: request.hostId, hostGeneration: request.hostGeneration,
    operation: request.operation, ok: false, error: { code, message, retryable: false }, elapsedMs: 0,
  }
}
