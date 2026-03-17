import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type {
  GetPlaywrightLivePreviewSessionsResponse,
  PlaywrightControllerBootstrap,
  PlaywrightDiscoveredSession,
  PlaywrightLivePreviewCandidate,
  PlaywrightLivePreviewHandle,
  PlaywrightLivePreviewMode,
  ReleasePlaywrightLivePreviewResponse,
  StartPlaywrightLivePreviewRequest,
} from '@forge/protocol'
import type { PlaywrightDiscoveryService } from './playwright-discovery-service.js'
import {
  PlaywrightDevtoolsBridge,
  PlaywrightDevtoolsBridgeError,
  type PlaywrightDevtoolsBridgeLike,
} from './playwright-devtools-bridge.js'

const DEFAULT_PREVIEW_TTL_MS = 5 * 60_000
const DEFAULT_CLEANUP_INTERVAL_MS = 30_000

interface PlaywrightPreviewLeaseRecord {
  previewId: string
  sessionId: string
  sessionName: string
  mode: PlaywrightLivePreviewMode
  createdAtMs: number
  lastUsedAtMs: number
  expiresAtMs: number
  upstreamControllerUrl: string
  sessionSnapshot: PlaywrightDiscoveredSession
}

export class PlaywrightLivePreviewUnavailableError extends Error {
  readonly statusCode: number

  constructor(message = 'Playwright live preview service is unavailable') {
    super(message)
    this.name = 'PlaywrightLivePreviewUnavailableError'
    this.statusCode = 503
  }
}

export class PlaywrightLivePreviewError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'PlaywrightLivePreviewError'
    this.statusCode = statusCode
  }
}

export class PlaywrightLivePreviewService extends EventEmitter {
  private readonly discoveryService: PlaywrightDiscoveryService | null
  private readonly devtoolsBridge: PlaywrightDevtoolsBridgeLike
  private readonly now: () => Date
  private readonly previewTtlMs: number
  private readonly cleanupIntervalMs: number
  private readonly generatePreviewId: () => string

  private readonly previews = new Map<string, PlaywrightPreviewLeaseRecord>()
  private readonly previewIdBySessionId = new Map<string, string>()
  private readonly previewCleanupHandlers = new Map<string, Set<() => void>>()
  private cleanupTimer: NodeJS.Timeout | null = null

  constructor(options: {
    discoveryService: PlaywrightDiscoveryService | null
    devtoolsBridge?: PlaywrightDevtoolsBridgeLike
    now?: () => Date
    previewTtlMs?: number
    cleanupIntervalMs?: number
    generatePreviewId?: () => string
  }) {
    super()
    this.discoveryService = options.discoveryService
    this.devtoolsBridge = options.devtoolsBridge ?? new PlaywrightDevtoolsBridge()
    this.now = options.now ?? (() => new Date())
    this.previewTtlMs = options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS
    this.generatePreviewId = options.generatePreviewId ?? (() => randomUUID())
  }

  async start(): Promise<void> {
    if (this.cleanupTimer) {
      return
    }

    this.cleanupTimer = setInterval(() => {
      this.pruneExpiredPreviews()
    }, this.cleanupIntervalMs)
    this.cleanupTimer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }

    for (const previewId of Array.from(this.previews.keys())) {
      this.deletePreview(previewId, 'shutdown')
    }
    this.previews.clear()
    this.previewIdBySessionId.clear()
    this.previewCleanupHandlers.clear()
  }

  isAvailable(): boolean {
    return this.discoveryService !== null
  }

  getPreviewableSessions(): GetPlaywrightLivePreviewSessionsResponse {
    const snapshot = this.getDiscoverySnapshot()
    return {
      sessions: snapshot.sessions.map((session) => this.buildPreviewCandidate(session)),
      updatedAt: snapshot.updatedAt,
    }
  }

  getPreviewCandidate(sessionId: string): PlaywrightLivePreviewCandidate {
    const session = this.getDiscoveredSession(sessionId)
    return this.buildPreviewCandidate(session)
  }

  async startPreview(
    request: StartPlaywrightLivePreviewRequest,
    backendOrigin: string,
  ): Promise<PlaywrightLivePreviewHandle> {
    this.pruneExpiredPreviews()

    const sessionId = request.sessionId.trim()
    if (!sessionId) {
      throw new PlaywrightLivePreviewError('sessionId is required', 400)
    }

    const session = this.getDiscoveredSession(sessionId)
    const previewCandidate = this.buildPreviewCandidate(session)
    if (!previewCandidate.previewable) {
      throw new PlaywrightLivePreviewError(
        previewCandidate.unavailableReason ?? `Session ${session.sessionName} is not previewable`,
        409,
      )
    }

    const existingPreviewId = this.previewIdBySessionId.get(sessionId)
    if (request.reuseIfActive !== false && existingPreviewId) {
      const existingPreview = this.touchPreview(existingPreviewId, request.mode ?? 'embedded')
      if (existingPreview) {
        return this.toPublicHandle(existingPreview, backendOrigin)
      }
    }

    const bridgeResult = await this.devtoolsBridge.startPreviewController(session)
    const nowMs = this.now().getTime()
    const previewId = this.generatePreviewId()
    const record: PlaywrightPreviewLeaseRecord = {
      previewId,
      sessionId: session.id,
      sessionName: session.sessionName,
      mode: request.mode ?? 'embedded',
      createdAtMs: nowMs,
      lastUsedAtMs: nowMs,
      expiresAtMs: nowMs + this.previewTtlMs,
      upstreamControllerUrl: bridgeResult.upstreamControllerUrl,
      sessionSnapshot: session,
    }

    if (existingPreviewId) {
      this.deletePreview(existingPreviewId)
    }

    this.previews.set(previewId, record)
    this.previewIdBySessionId.set(session.id, previewId)
    this.emit('preview_started', {
      previewId: record.previewId,
      sessionId: record.sessionId,
      mode: record.mode,
      upstreamControllerUrl: record.upstreamControllerUrl,
    })
    return this.toPublicHandle(record, backendOrigin)
  }

  getBootstrap(previewId: string, backendOrigin: string): PlaywrightControllerBootstrap {
    const preview = this.requireActivePreview(previewId)
    if (!preview) {
      throw new PlaywrightLivePreviewError(`Unknown or expired preview ${previewId.trim()}`, 410)
    }

    const session = this.getDiscoveredSessionOrFallback(preview.sessionId, preview.sessionSnapshot)
    const publicPreview = this.toPublicHandle(preview, backendOrigin)

    return {
      preview: publicPreview,
      previewId: publicPreview.previewId,
      sessionId: publicPreview.sessionId,
      controllerWsUrl: publicPreview.controllerWsUrl,
      controllerProxyUrl: publicPreview.controllerProxyUrl,
      inspectorWsUrl: null,
      inspectorProxyUrl: null,
      sessionName: session.sessionName,
      browserName: session.browserName,
      initialUrl: null,
      backendOrigin,
      session,
    }
  }

  getUpstreamControllerUrl(previewId: string): string | null {
    const preview = this.requireActivePreview(previewId, { suppressThrow: true })
    return preview?.upstreamControllerUrl ?? null
  }

  registerPreviewCleanup(previewId: string, cleanup: () => void): () => void {
    const normalizedPreviewId = previewId.trim()
    const existing = this.previewCleanupHandlers.get(normalizedPreviewId)
    if (existing) {
      existing.add(cleanup)
    } else {
      this.previewCleanupHandlers.set(normalizedPreviewId, new Set([cleanup]))
    }

    return () => {
      const handlers = this.previewCleanupHandlers.get(normalizedPreviewId)
      if (!handlers) {
        return
      }
      handlers.delete(cleanup)
      if (handlers.size === 0) {
        this.previewCleanupHandlers.delete(normalizedPreviewId)
      }
    }
  }

  touchPreview(previewId: string, nextMode?: PlaywrightLivePreviewMode): PlaywrightPreviewLeaseRecord | null {
    const preview = this.requireActivePreview(previewId, { suppressThrow: true })
    if (!preview) {
      return null
    }

    const nowMs = this.now().getTime()
    preview.lastUsedAtMs = nowMs
    preview.expiresAtMs = nowMs + this.previewTtlMs
    if (nextMode) {
      preview.mode = nextMode
    }
    return preview
  }

  releasePreview(previewId: string): ReleasePlaywrightLivePreviewResponse {
    const normalizedPreviewId = previewId.trim()
    const released = this.deletePreview(normalizedPreviewId)
    return {
      ok: true,
      previewId: normalizedPreviewId,
      released,
    }
  }

  pruneExpiredPreviews(): void {
    const nowMs = this.now().getTime()
    for (const preview of this.previews.values()) {
      if (preview.expiresAtMs <= nowMs) {
        this.deletePreview(preview.previewId, 'expired')
      }
    }
  }

  private getDiscoverySnapshot() {
    if (!this.discoveryService) {
      throw new PlaywrightLivePreviewUnavailableError()
    }

    return this.discoveryService.getSnapshot()
  }

  private getDiscoveredSession(sessionId: string): PlaywrightDiscoveredSession {
    if (!this.discoveryService) {
      throw new PlaywrightLivePreviewUnavailableError()
    }

    const session = this.discoveryService.getSessionById(sessionId)
    if (!session) {
      throw new PlaywrightLivePreviewError(`Unknown Playwright session ${sessionId}`, 404)
    }

    return session
  }

  private getDiscoveredSessionOrFallback(
    sessionId: string,
    fallback: PlaywrightDiscoveredSession,
  ): PlaywrightDiscoveredSession {
    if (!this.discoveryService) {
      return fallback
    }

    return this.discoveryService.getSessionById(sessionId) ?? fallback
  }

  private requireActivePreview(
    previewId: string,
    options: { suppressThrow?: boolean } = {},
  ): PlaywrightPreviewLeaseRecord | null {
    this.pruneExpiredPreviews()

    const normalizedPreviewId = previewId.trim()
    const preview = this.previews.get(normalizedPreviewId) ?? null
    if (preview) {
      return preview
    }

    if (options.suppressThrow) {
      return null
    }

    throw new PlaywrightLivePreviewError(`Unknown or expired preview ${normalizedPreviewId}`, 410)
  }

  private deletePreview(previewId: string, reason: 'released' | 'expired' | 'shutdown' = 'released'): boolean {
    const preview = this.previews.get(previewId)
    if (!preview) {
      return false
    }

    this.previews.delete(previewId)
    if (this.previewIdBySessionId.get(preview.sessionId) === previewId) {
      this.previewIdBySessionId.delete(preview.sessionId)
    }

    const cleanupHandlers = this.previewCleanupHandlers.get(previewId)
    this.previewCleanupHandlers.delete(previewId)
    if (cleanupHandlers) {
      for (const cleanup of cleanupHandlers) {
        try {
          cleanup()
        } catch {
          // ignore cleanup handler failures while tearing down preview leases
        }
      }
    }

    this.emit('preview_closed', {
      previewId,
      sessionId: preview.sessionId,
      reason,
    })
    return true
  }

  private buildPreviewCandidate(session: PlaywrightDiscoveredSession): PlaywrightLivePreviewCandidate {
    const previewability =
      session.previewability ??
      inferPreviewabilityFromSession(session)

    const activePreviewId = this.previewIdBySessionId.get(session.id) ?? null
    return {
      session,
      previewable: previewability.previewable,
      unavailableReason: previewability.unavailableReason,
      activePreviewId,
    }
  }

  private toPublicHandle(preview: PlaywrightPreviewLeaseRecord, backendOrigin: string): PlaywrightLivePreviewHandle {
    const iframeSrc = `${backendOrigin}/playwright-live/embed?previewId=${encodeURIComponent(preview.previewId)}`
    const controllerProxyUrl = `${toWebSocketOrigin(backendOrigin)}/playwright-live/ws/controller/${encodeURIComponent(preview.previewId)}`

    return {
      previewId: preview.previewId,
      sessionId: preview.sessionId,
      sessionName: preview.sessionName,
      mode: preview.mode,
      status: 'active',
      createdAt: new Date(preview.createdAtMs).toISOString(),
      lastUsedAt: new Date(preview.lastUsedAtMs).toISOString(),
      expiresAt: new Date(preview.expiresAtMs).toISOString(),
      inspectorAvailable: false,
      iframeSrc,
      controllerProxyUrl,
      embedUrl: iframeSrc,
      bootstrapUrl: `${backendOrigin}/playwright-live/api/previews/${encodeURIComponent(preview.previewId)}/bootstrap`,
      controllerWsUrl: controllerProxyUrl,
    }
  }
}

function inferPreviewabilityFromSession(session: PlaywrightDiscoveredSession): {
  previewable: boolean
  unavailableReason: string | null
} {
  if (!session.preferredInDuplicateGroup) {
    return {
      previewable: false,
      unavailableReason: `Session ${session.sessionName} shares a Playwright daemon with a preferred duplicate`,
    }
  }

  if (session.liveness !== 'active') {
    return {
      previewable: false,
      unavailableReason: `Session ${session.sessionName} is ${session.liveness}`,
    }
  }

  if (!session.socketPath || !session.socketExists || session.socketResponsive !== true) {
    return {
      previewable: false,
      unavailableReason: `Session ${session.sessionName} does not have a responsive Playwright socket`,
    }
  }

  return {
    previewable: true,
    unavailableReason: null,
  }
}

function toWebSocketOrigin(backendOrigin: string): string {
  const url = new URL(backendOrigin)
  if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  }
  return url.origin
}

export function asPlaywrightLivePreviewError(error: unknown): PlaywrightLivePreviewError | PlaywrightLivePreviewUnavailableError {
  if (error instanceof PlaywrightLivePreviewError || error instanceof PlaywrightLivePreviewUnavailableError) {
    return error
  }

  if (error instanceof PlaywrightDevtoolsBridgeError) {
    return new PlaywrightLivePreviewError(error.message, error.statusCode)
  }

  const message = error instanceof Error ? error.message : String(error)
  return new PlaywrightLivePreviewError(message, 500)
}
