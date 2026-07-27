import {
  EXTERNAL_CHROME_M4_SUPPORTED_OPERATIONS,
  type BrowserAutomationFailure,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
  type BrowserAutomationResultByOperation,
  type BrowserHostLifecycleReason,
  type BrowserTabSnapshot,
} from '@forge/protocol'
import type {
  AutomaticExternalBrowserAdapter,
  BrowserTargetExecution,
  BrowserTargetSession,
  ExternalBrowserAcquireInput,
  ExternalBrowserAcquireResult,
  ExternalBrowserRevealResult,
  ExternalBrowserTargetAuthority,
} from './browser-target-adapter.js'

export type ExternalChromeTransportResult =
  | { ok: true; result: BrowserAutomationResultByOperation[keyof BrowserAutomationResultByOperation]; updatedTab?: BrowserTabSnapshot; elapsedMs?: number }
  | { ok: false; error: BrowserAutomationFailure; updatedTab?: BrowserTabSnapshot; elapsedMs?: number }

/** Automatic policy transport. It exposes one target authority, never profiles or candidates. */
export interface ExternalChromeTransport {
  readonly maxResponseBytes: number
  execute(request: BrowserAutomationRequest): Promise<ExternalChromeTransportResult>
  acquireTarget?(input: ExternalBrowserAcquireInput): Promise<ExternalBrowserAcquireResult>
  releaseAuthority?(session: BrowserTargetSession, authority: ExternalBrowserTargetAuthority, reason: string): Promise<void>
  revealTarget?(session: BrowserTargetSession, tabId: string): Promise<ExternalBrowserRevealResult>
}

export class ExternalChromeTargetAdapter implements AutomaticExternalBrowserAdapter {
  readonly targetAffinity = 'external-chrome' as const
  get capabilities() {
    return {
      supportedOperations: EXTERNAL_CHROME_M4_SUPPORTED_OPERATIONS,
      physicalViewport: false,
      recording: false,
      reveal: typeof this.transport.revealTarget === 'function',
    } as const
  }

  constructor(private readonly transport: ExternalChromeTransport, private readonly now: () => number = Date.now) {}

  acquireTarget(input: ExternalBrowserAcquireInput): Promise<ExternalBrowserAcquireResult> {
    if (this.transport.acquireTarget) return this.transport.acquireTarget(input)
    return Promise.resolve({
      ok: false,
      error: { code: 'unavailable-host', message: 'Automatic Chrome acquisition is unavailable.', retryable: true },
      metadata: { phase: 'discovery', mutationState: 'not-started', fallbackReason: 'integration-unavailable' },
    })
  }

  async executeWithAuthority(input: { authority: ExternalBrowserTargetAuthority; request: BrowserAutomationRequest }): Promise<BrowserTargetExecution> {
    const response = await this.execute(input.request)
    return {
      response,
      ...(!response.ok ? { failure: response.error.code === 'debugger-unavailable'
        ? {
            // The extension emits debugger-unavailable only before it dispatches the
            // requested page operation. A DevTools/foreign-debugger race is therefore
            // safe for the automatic host's one dedicated-target retry.
            phase: 'acquisition' as const,
            mutationState: 'not-started' as const,
            fallbackReason: 'foreign-debugger' as const,
          }
        : {
            phase: 'execution' as const,
            mutationState: ['status', 'snapshot', 'waitFor'].includes(input.request.operation) ? 'not-started' as const : 'possible' as const,
            ...(response.error.code === 'control-interrupted' ? { fallbackReason: 'authority-conflict' as const } : {}),
          } } : {}),
    }
  }

  releaseAuthority(session: BrowserTargetSession, authority: ExternalBrowserTargetAuthority, reason: 'idle' | 'operation-failed' | 'turn-ended' | BrowserHostLifecycleReason): Promise<void> {
    return this.transport.releaseAuthority?.(session, authority, reason) ?? Promise.resolve()
  }

  revealTarget(session: BrowserTargetSession, tabId: string): Promise<ExternalBrowserRevealResult> {
    if (!this.transport.revealTarget) return Promise.reject(new Error('External Chrome reveal is unavailable'))
    return this.transport.revealTarget(session, tabId)
  }

  async execute(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> {
    const started = this.now()
    if (!(this.capabilities.supportedOperations as readonly string[]).includes(request.operation)) {
      return this.failure(request, { code: 'unsupported-operation', message: `External Chrome does not support ${request.operation}.`, retryable: false }, started)
    }
    if (Date.parse(request.deadlineAt) <= this.now()) return this.failure(request, { code: 'timeout', message: 'Browser request deadline has elapsed.', retryable: true }, started)
    let transported: ExternalChromeTransportResult
    try { transported = await this.transport.execute(request) }
    catch (error) { return this.failure(request, { code: 'host-disconnected', message: error instanceof Error ? error.message : 'External Chrome transport disconnected.', retryable: true }, started) }
    const encodedBytes = Buffer.byteLength(JSON.stringify(transported), 'utf8')
    if (encodedBytes > this.transport.maxResponseBytes) return this.failure(request, { code: 'response-too-large', message: 'External Chrome response exceeded the negotiated size limit.', retryable: false }, started)
    const routing = {
      requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId,
      tabId: request.tabId, hostId: request.hostId, hostGeneration: request.hostGeneration,
      operation: request.operation, elapsedMs: transported.elapsedMs ?? Math.max(0, this.now() - started),
      ...(transported.updatedTab ? { updatedTab: { ...transported.updatedTab, targetAffinity: this.targetAffinity } } : {}),
    }
    return transported.ok ? { ...routing, ok: true, result: transported.result } as BrowserAutomationResponse : { ...routing, ok: false, error: transported.error } as BrowserAutomationResponse
  }

  private failure(request: BrowserAutomationRequest, error: BrowserAutomationFailure, started: number): BrowserAutomationResponse {
    return { requestId: request.requestId, sessionAgentId: request.sessionAgentId, profileId: request.profileId, tabId: request.tabId, hostId: request.hostId, hostGeneration: request.hostGeneration, operation: request.operation, ok: false, error, elapsedMs: Math.max(0, this.now() - started) }
  }
}
