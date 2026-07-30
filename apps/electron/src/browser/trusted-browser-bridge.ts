/* Recording coordination follows T3 Code browserRecording.ts at 9a0a0716 (MIT). */
import type { BrowserAutomationFailure, BrowserAutomationRequest, BrowserAutomationResponse, BrowserHostLifecycleRequest, BrowserHostLifecycleResponse, BrowserTabSnapshot } from '@forge/protocol'
import type { IpcRenderer, IpcRendererEvent } from 'electron'
import {
  BROWSER_IPC,
  browserBridgeCapabilities,
  BROWSER_WORKSPACE_IPC,
  type BrowserAutomationBridge,
  type BrowserPresentationAcknowledgement,
  type BrowserPresentationRequest,
  type BrowserWorkspaceBridge,
  type BrowserWorkspaceCommandRequest,
  type ElectronWindowRole,
  type ManagedBrowserWorkspaceMode,
  type ManagedBrowserWorkspaceProjection,
} from './browser-bridge-contract.js'
import type { BrowserTabRegistration, PreparedRecording } from './browser-automation-manager.js'
import type { BrowserViewportMetrics, ManagedBrowserReconcileInput } from './managed-browser-view-host.js'

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
  const invokeIpc = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const envelope = await ipcRenderer.invoke(channel, ...args) as {
      __forgeBrowserIpcResult?: boolean
      ok?: boolean
      value?: T
      error?: BrowserAutomationFailure
    }
    if (!envelope?.__forgeBrowserIpcResult) {
      throw new BrowserIpcError({ code: 'malformed-response', message: `Browser IPC ${channel} returned no typed envelope`, retryable: false })
    }
    if (!envelope.ok) {
      throw new BrowserIpcError(envelope.error ?? { code: 'execution-failed', message: `Browser IPC ${channel} failed`, retryable: false })
    }
    return envelope.value as T
  }

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
    return invokeIpc<BrowserAutomationResponse>(BROWSER_IPC.execute, request)
  }

  const startRecording = async (request: BrowserAutomationRequest & { operation: 'recordingStart' }): Promise<BrowserAutomationResponse> => {
    if (active) {
      if (active.prepared.tabId === request.tabId && active.phase === 'recording') {
        return invokeIpc<BrowserAutomationResponse>(BROWSER_IPC.execute, request)
      }
      return failure(request, 'recording-conflict', 'Another browser recording is active')
    }
    try {
      const prepared = await invokeIpc<PreparedRecording>(BROWSER_IPC.prepareRecording, request)
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
      const startPromise = invokeIpc<BrowserAutomationResponse>(BROWSER_IPC.execute, { ...request, recordingMimeType: mimeType })
      recording.startPromise = startPromise
      const response = await startPromise
      if (!response.ok) {
        await stopMediaRecorder(recorder)
        active = null
        await invokeIpc<void>(BROWSER_IPC.cancelRecording, prepared.recordingId)
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
      await invokeIpc<void>(BROWSER_IPC.cancelRecording, recordingId).catch(() => undefined)
      return failureFromError(request, error, 'Browser recording failed to start')
    }
  }

  const stopRecording = (request: BrowserAutomationRequest & { operation: 'recordingStop' }): Promise<BrowserAutomationResponse> => {
    const recording = active
    if (!recording || (request.input.recordingId && request.input.recordingId !== recording.prepared.recordingId) || (request.tabId && request.tabId !== recording.prepared.tabId)) {
      return Promise.resolve(failure(request, 'recording-not-found', 'The requested browser recording is not active'))
    }
    if (recording.stopPromise) {
      return Promise.resolve(failure(request, 'recording-conflict', 'Browser recording stop is already in progress', true))
    }
    const stopPromise = (async () => {
      const deadline = Date.parse(request.deadlineAt)
      try {
        ensureDeadline(deadline)
        if (recording.phase === 'starting' && recording.startPromise) {
          const startResponse = await withinDeadline(recording.startPromise, deadline)
          if (!startResponse.ok) return failure(request, startResponse.error.code, startResponse.error.message, startResponse.error.retryable, startResponse.error.details)
        }
        recording.phase = 'stopping'
        await withinDeadline(invokeIpc<PreparedRecording>(BROWSER_IPC.stopRecordingCapture, request), deadline)
        await stopMediaRecorder(recording.recorder, deadline)
        ensureDeadline(deadline)
        const blob = new Blob(recording.chunks, { type: recording.mimeType })
        const bytes = new Uint8Array(await withinDeadline(blob.arrayBuffer(), deadline))
        ensureDeadline(deadline)
        return await withinDeadline(
          invokeIpc<BrowserAutomationResponse>(BROWSER_IPC.saveRecording, { request, mimeType: recording.mimeType, bytes }),
          deadline,
        )
      } catch (error) {
        await invokeIpc<void>(BROWSER_IPC.cancelRecording, recording.prepared.recordingId).catch(() => undefined)
        return failureFromError(request, error, 'Browser recording failed to stop')
      } finally {
        if (active === recording) active = null
      }
    })()
    recording.stopPromise = stopPromise
    return stopPromise
  }

  return {
    capabilities: browserBridgeCapabilities,
    reconcile: (input: ManagedBrowserReconcileInput): Promise<{ applied: boolean; tabCount: number }> => invokeIpc(BROWSER_IPC.reconcile, input),
    ensureProvisional: (registration: BrowserTabRegistration & { workspaceEpoch: number }): Promise<BrowserTabSnapshot> => invokeIpc(BROWSER_IPC.ensureProvisional, { tab: registration.tab, workspaceEpoch: registration.workspaceEpoch }),
    commitProvisional: (tabId: string, workspaceEpoch: number): Promise<void> => invokeIpc(BROWSER_IPC.commitProvisional, { tabId, workspaceEpoch }),
    abortProvisional: (tabId: string): Promise<void> => invokeIpc(BROWSER_IPC.abortProvisional, tabId),
    reportViewport: (metrics: BrowserViewportMetrics): Promise<void> => invokeIpc(BROWSER_IPC.viewport, metrics),
    setTabPresentation: (request: BrowserPresentationRequest): Promise<BrowserPresentationAcknowledgement> => invokeIpc(BROWSER_IPC.presentation, request),
    captureScreenshot: (tabId: string): Promise<string> => invokeIpc(BROWSER_IPC.capture, tabId),
    navigate: (tabId: string, url: string): Promise<BrowserTabSnapshot> => invokeIpc(BROWSER_IPC.humanNavigate, { tabId, url }),
    history: (tabId: string, direction: 'back' | 'forward'): Promise<BrowserTabSnapshot> => invokeIpc(BROWSER_IPC.humanHistory, { tabId, direction }),
    reload: (tabId: string, hard = false): Promise<BrowserTabSnapshot> => invokeIpc(BROWSER_IPC.humanReload, { tabId, hard }),
    setZoom: (tabId: string, factor: number): Promise<BrowserTabSnapshot> => invokeIpc(BROWSER_IPC.humanZoom, { tabId, factor }),
    invoke,
    invokeLifecycle: (request: BrowserHostLifecycleRequest): Promise<BrowserHostLifecycleResponse> => invokeIpc(BROWSER_IPC.lifecycle, request),
    reveal: (sessionAgentId: string, profileId: string, tabId: string): Promise<{ targetAffinity: 'managed-electron' | 'external-chrome'; revealed: boolean; tabId: string }> =>
      invokeIpc(BROWSER_IPC.reveal, { sessionAgentId, profileId, tabId }),
    takeControl: (sessionAgentId: string, profileId: string, tabId: string): Promise<{ released: boolean; tabId: string }> =>
      invokeIpc(BROWSER_IPC.takeControl, { sessionAgentId, profileId, tabId }),
    onStateChanged: (listener: (tab: BrowserTabSnapshot) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, tab: BrowserTabSnapshot): void => listener(tab)
      ipcRenderer.on(BROWSER_IPC.stateChanged, handler)
      return () => ipcRenderer.removeListener(BROWSER_IPC.stateChanged, handler)
    },
  }
}

export function createTrustedBrowserWorkspaceBridge(
  ipcRenderer: IpcRenderer,
  role: ElectronWindowRole,
  popoutAvailable: boolean,
): BrowserWorkspaceBridge {
  const requireMain = (): void => {
    if (role !== 'main') throw new Error('This Managed Browser workspace method requires the authoritative renderer')
  }
  const requirePopout = (): void => {
    if (role !== 'managed-browser-popout') throw new Error('This Managed Browser workspace method requires the pop-out renderer')
  }
  const listen = <T>(channel: string, listener: (value: T) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, value: T): void => listener(value)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
  return {
    capability: { popoutAvailable },
    getSnapshot: async (): Promise<ManagedBrowserWorkspaceProjection | null> => {
      requirePopout()
      return ipcRenderer.invoke(BROWSER_WORKSPACE_IPC.snapshot) as Promise<ManagedBrowserWorkspaceProjection | null>
    },
    ...(role === 'main' ? {
      publish: (projection: ManagedBrowserWorkspaceProjection): Promise<void> => ipcRenderer.invoke(BROWSER_WORKSPACE_IPC.publish, projection),
      onCommand: (listener: (request: BrowserWorkspaceCommandRequest) => void): (() => void) => listen(BROWSER_WORKSPACE_IPC.commandForward, listener),
      replyToCommand: (requestId: string, result: { ok: true; value?: unknown } | { ok: false; error: string }): void => {
        void ipcRenderer.invoke(BROWSER_WORKSPACE_IPC.commandReply, { requestId, ...result })
      },
    } : {
      sendCommand: (request: BrowserWorkspaceCommandRequest): Promise<unknown> => ipcRenderer.invoke(BROWSER_WORKSPACE_IPC.command, request),
    }),
    popOut: async (workspaceEpoch: number): Promise<ManagedBrowserWorkspaceMode> => {
      requireMain()
      return ipcRenderer.invoke(BROWSER_WORKSPACE_IPC.popOut, workspaceEpoch) as Promise<ManagedBrowserWorkspaceMode>
    },
    dock: (workspaceEpoch: number): Promise<ManagedBrowserWorkspaceMode> => ipcRenderer.invoke(BROWSER_WORKSPACE_IPC.dock, workspaceEpoch) as Promise<ManagedBrowserWorkspaceMode>,
    bringToFront: async (): Promise<void> => {
      requireMain()
      await ipcRenderer.invoke(BROWSER_WORKSPACE_IPC.bringToFront)
    },
    reportViewport: async (metrics: BrowserViewportMetrics): Promise<void> => {
      requirePopout()
      await ipcRenderer.invoke(BROWSER_WORKSPACE_IPC.viewport, metrics)
    },
    onProjection: (listener: (projection: ManagedBrowserWorkspaceProjection | null) => void): (() => void) => listen(BROWSER_WORKSPACE_IPC.projection, listener),
    onModeChanged: (listener: (mode: ManagedBrowserWorkspaceMode) => void): (() => void) => listen(BROWSER_WORKSPACE_IPC.mode, listener),
    ...(role === 'main' ? {
      onFocusChanged: (listener: (focused: boolean) => void): (() => void) => listen(BROWSER_WORKSPACE_IPC.focus, listener),
    } : {}),
  }
}

class BrowserIpcError extends Error {
  readonly code: BrowserAutomationFailure['code']
  readonly retryable: boolean
  readonly details?: BrowserAutomationFailure['details']

  constructor(failure: BrowserAutomationFailure) {
    super(failure.message)
    this.name = 'BrowserIpcError'
    this.code = failure.code
    this.retryable = failure.retryable
    this.details = failure.details
  }
}

function preferredMimeType(): string {
  const candidates = ['video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp9', 'video/webm']
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? 'video/webm'
}

async function stopMediaRecorder(recorder: MediaRecorder, deadline?: number): Promise<void> {
  if (recorder.state === 'inactive') return
  const stopped = new Promise<void>((resolve) => {
    recorder.addEventListener('stop', () => resolve(), { once: true })
    recorder.stop()
  })
  await (deadline === undefined ? stopped : withinDeadline(stopped, deadline))
}

function ensureDeadline(deadline: number): void {
  if (!Number.isFinite(deadline) || Date.now() >= deadline) {
    throw new BrowserIpcError({ code: 'timeout', message: 'Browser recording deadline has elapsed', retryable: true })
  }
}

async function withinDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  ensureDeadline(deadline)
  const remaining = Math.max(1, deadline - Date.now())
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BrowserIpcError({ code: 'timeout', message: 'Browser recording deadline has elapsed', retryable: true })), remaining)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function failureFromError(request: BrowserAutomationRequest, error: unknown, fallbackMessage: string): BrowserAutomationResponse {
  if (error instanceof BrowserIpcError) return failure(request, error.code, error.message, error.retryable, error.details)
  return failure(request, 'execution-failed', error instanceof Error ? error.message : fallbackMessage)
}

function failure(
  request: BrowserAutomationRequest,
  code: BrowserAutomationFailure['code'],
  message: string,
  retryable = false,
  details?: BrowserAutomationFailure['details'],
): BrowserAutomationResponse {
  return {
    requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId,
    tabId: request.tabId, hostId: request.hostId, hostGeneration: request.hostGeneration,
    operation: request.operation, ok: false, error: { code, message, retryable, ...(details ? { details } : {}) }, elapsedMs: 0,
  }
}
