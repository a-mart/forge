import {
  EXTERNAL_CHROME_M4_SUPPORTED_OPERATIONS,
  type BrowserAutomationFailure,
  type BrowserAutomationRequest,
  type BrowserAutomationResponse,
  type BrowserAutomationResultByOperation,
  type BrowserTabSnapshot,
} from '@forge/protocol'
import type { BrowserTargetAdapter } from './browser-target-adapter.js'

export type ExternalChromeTransportResult =
  | {
      ok: true
      result: BrowserAutomationResultByOperation[keyof BrowserAutomationResultByOperation]
      updatedTab?: BrowserTabSnapshot
      elapsedMs?: number
    }
  | {
      ok: false
      error: BrowserAutomationFailure
      updatedTab?: BrowserTabSnapshot
      elapsedMs?: number
    }

/** Bounded transport implemented by the authenticated Desktop relay; tests may inject a fake. */
export interface ExternalChromeTransport {
  readonly maxResponseBytes: number
  execute(request: BrowserAutomationRequest): Promise<ExternalChromeTransportResult>
}

export class ExternalChromeTargetAdapter implements BrowserTargetAdapter {
  readonly hostKind = 'external-chrome' as const
  readonly supportedOperations = EXTERNAL_CHROME_M4_SUPPORTED_OPERATIONS

  constructor(
    private readonly transport: ExternalChromeTransport,
    private readonly now: () => number = Date.now,
  ) {}

  async execute(request: BrowserAutomationRequest): Promise<BrowserAutomationResponse> {
    const started = this.now()
    if (request.hostKind !== this.hostKind) {
      return this.failure(request, {
        code: 'invalid-input', message: 'External Chrome adapter received a request for another host kind.', retryable: false,
      }, started)
    }
    if (!(this.supportedOperations as readonly string[]).includes(request.operation)) {
      return this.failure(request, {
        code: 'unsupported-operation',
        message: `External Chrome does not support ${request.operation}.`,
        retryable: false,
        details: { operation: request.operation, hostKind: this.hostKind },
      }, started)
    }
    if (Date.parse(request.deadlineAt) <= this.now()) {
      return this.failure(request, { code: 'timeout', message: 'Browser request deadline has elapsed.', retryable: true }, started)
    }

    let transported: ExternalChromeTransportResult
    try {
      transported = await this.transport.execute(request)
    } catch (error) {
      return this.failure(request, {
        code: 'host-disconnected',
        message: error instanceof Error ? error.message : 'External Chrome transport disconnected.',
        retryable: true,
      }, started)
    }
    const encodedBytes = Buffer.byteLength(JSON.stringify(transported), 'utf8')
    if (encodedBytes > this.transport.maxResponseBytes) {
      return this.failure(request, {
        code: 'response-too-large',
        message: 'External Chrome response exceeded the negotiated size limit.',
        retryable: false,
        details: { responseBytes: encodedBytes, maximumResponseBytes: this.transport.maxResponseBytes },
      }, started)
    }
    const routing = {
      requestId: request.requestId,
      hostKind: this.hostKind,
      sessionAgentId: request.sessionAgentId,
      profileId: request.profileId,
      tabId: request.tabId,
      hostId: request.hostId,
      hostGeneration: request.hostGeneration,
      operation: request.operation,
      elapsedMs: transported.elapsedMs ?? Math.max(0, this.now() - started),
      ...(transported.updatedTab ? { updatedTab: { ...transported.updatedTab, hostKind: this.hostKind } } : {}),
    }
    return transported.ok
      ? { ...routing, ok: true, result: transported.result } as BrowserAutomationResponse
      : { ...routing, ok: false, error: transported.error } as BrowserAutomationResponse
  }

  private failure(request: BrowserAutomationRequest, error: BrowserAutomationFailure, started: number): BrowserAutomationResponse {
    return {
      requestId: request.requestId,
      hostKind: this.hostKind,
      sessionAgentId: request.sessionAgentId,
      profileId: request.profileId,
      tabId: request.tabId,
      hostId: request.hostId,
      hostGeneration: request.hostGeneration,
      operation: request.operation,
      ok: false,
      error,
      elapsedMs: Math.max(0, this.now() - started),
    }
  }
}
