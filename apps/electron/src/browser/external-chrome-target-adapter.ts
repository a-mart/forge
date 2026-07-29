import {
  EXTERNAL_CHROME_M4_SUPPORTED_OPERATIONS,
  isExternalChromeDebuggerAttachConflictDetails,
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
  ExternalBrowserInventory,
  ExternalBrowserRevealResult,
  ExternalBrowserTargetAuthority,
} from './browser-target-adapter.js'

export type ExternalChromeTransportResult =
  | { ok: true; result: BrowserAutomationResultByOperation[keyof BrowserAutomationResultByOperation]; updatedTab?: BrowserTabSnapshot; elapsedMs?: number }
  | { ok: false; error: BrowserAutomationFailure; updatedTab?: BrowserTabSnapshot; elapsedMs?: number }

/** Authenticated transport for profile-wide inventory and exact per-tab authority. */
export interface ExternalChromeTransport {
  readonly maxResponseBytes: number
  execute(request: BrowserAutomationRequest): Promise<ExternalChromeTransportResult>
  listEligibleTabs?(session: BrowserTargetSession, deadlineAt?: number): Promise<ExternalBrowserInventory>
  acquireTarget?(input: ExternalBrowserAcquireInput): Promise<ExternalBrowserAcquireResult>
  releaseAuthority?(session: BrowserTargetSession, authority: ExternalBrowserTargetAuthority, reason: string): Promise<void>
  endTurn?(session: BrowserTargetSession, turnId: string): Promise<void>
  releaseSession?(session: BrowserTargetSession, reason: BrowserHostLifecycleReason): Promise<void>
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

  listEligibleTabs(session: BrowserTargetSession, deadlineAt?: number): Promise<ExternalBrowserInventory> {
    return this.transport.listEligibleTabs?.(session, deadlineAt) ?? Promise.resolve({ tabs: [], truncated: false })
  }

  acquireTarget(input: ExternalBrowserAcquireInput): Promise<ExternalBrowserAcquireResult> {
    if (this.transport.acquireTarget) return this.transport.acquireTarget(input)
    return Promise.resolve({
      ok: false,
      error: { code: 'unavailable-host', message: 'Automatic Chrome acquisition is unavailable.', retryable: true },
      metadata: { phase: 'discovery', mutationState: 'not-started', fallbackReason: 'integration-unavailable' },
    })
  }

  async executeWithAuthority(input: { authority: ExternalBrowserTargetAuthority; request: BrowserAutomationRequest }): Promise<BrowserTargetExecution> {
    const response = await this.executeTransported(input.request)
    if (response.ok) return { response }

    const evidence = debuggerAttachConflictEvidence(response.error)
    if (evidence === 'malformed') {
      return {
        response: {
          ...response,
          error: {
            code: 'malformed-response',
            message: 'External Chrome returned malformed execution safety evidence.',
            retryable: false,
          },
        },
        failure: { phase: 'execution', mutationState: mutationDefault(input.request.operation) },
      }
    }
    if (evidence === 'proven') {
      const { details: _privateEvidence, ...error } = response.error
      void _privateEvidence
      return {
        response: { ...response, error },
        failure: { phase: 'acquisition', mutationState: 'not-started', fallbackReason: 'foreign-debugger' },
      }
    }
    return {
      response,
      failure: {
        phase: 'execution',
        mutationState: mutationDefault(input.request.operation),
        ...(response.error.code === 'control-interrupted' ? { fallbackReason: 'authority-conflict' as const } : {}),
      },
    }
  }

  releaseAuthority(session: BrowserTargetSession, authority: ExternalBrowserTargetAuthority, reason: 'idle' | 'operation-failed' | 'turn-ended' | BrowserHostLifecycleReason): Promise<void> {
    return this.transport.releaseAuthority?.(session, authority, reason) ?? Promise.resolve()
  }

  endTurn(session: BrowserTargetSession, turnId: string): Promise<void> {
    return this.transport.endTurn?.(session, turnId) ?? Promise.resolve()
  }

  releaseSession(session: BrowserTargetSession, reason: BrowserHostLifecycleReason): Promise<void> {
    return this.transport.releaseSession?.(session, reason) ?? Promise.resolve()
  }

  revealTarget(session: BrowserTargetSession, tabId: string): Promise<ExternalBrowserRevealResult> {
    if (!this.transport.revealTarget) return Promise.reject(new Error('External Chrome reveal is unavailable'))
    return this.transport.revealTarget(session, tabId)
  }

  async execute(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> {
    const response = await this.executeTransported(request)
    if (response.ok) return response
    const evidence = debuggerAttachConflictEvidence(response.error)
    if (evidence === 'absent') return response
    if (evidence === 'malformed') {
      return {
        ...response,
        error: {
          code: 'malformed-response',
          message: 'External Chrome returned malformed execution safety evidence.',
          retryable: false,
        },
      }
    }
    const { details: _privateEvidence, ...error } = response.error
    void _privateEvidence
    return { ...response, error }
  }

  private async executeTransported(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> {
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

function mutationDefault(operation: BrowserAutomationRequest['operation']): 'not-started' | 'possible' {
  return operation === 'status' || operation === 'snapshot' || operation === 'waitFor' ? 'not-started' : 'possible'
}

function debuggerAttachConflictEvidence(error: BrowserAutomationFailure): 'absent' | 'proven' | 'malformed' {
  const details = error.details
  const hasReservedField = details !== undefined && ['failurePhase', 'mutationState', 'fallbackReason']
    .some((key) => Object.prototype.hasOwnProperty.call(details, key))
  if (!hasReservedField) return 'absent'
  return error.code === 'debugger-unavailable' && isExternalChromeDebuggerAttachConflictDetails(details)
    ? 'proven'
    : 'malformed'
}
