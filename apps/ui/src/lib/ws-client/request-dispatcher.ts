import type { ClientCommand } from '@forge/protocol'
import {
  REQUEST_TIMEOUT_MS,
  WS_REQUEST_ERROR_HINTS,
  WS_REQUEST_TYPES,
} from './runtime-types'
import type { WsRequestResultMap, WsRequestType } from './types'
import { WsRequestTracker } from '../ws-request-tracker'
import { RECONNECTING_SOCKET_ERROR } from './request-definitions'

export interface RequestDispatcherDeps {
  /** Send a command over the WebSocket. Returns false when the socket is not open. */
  send: (command: ClientCommand) => boolean
}

/**
 * Owns request-id generation, request tracking, timeout, and error-fallback
 * resolution for the ManagerWsClient request/response lifecycle.
 *
 * Does **not** own the WebSocket or any socket state — the injected `send`
 * callback is the only transport surface.
 */
export class RequestDispatcher {
  private requestCounter = 0
  readonly tracker: WsRequestTracker<WsRequestResultMap>

  constructor(private readonly deps: RequestDispatcherDeps) {
    this.tracker = new WsRequestTracker<WsRequestResultMap>(
      WS_REQUEST_TYPES,
      REQUEST_TIMEOUT_MS,
    )
  }

  // ---------------------------------------------------------------------------
  // Request-id generation
  // ---------------------------------------------------------------------------

  nextRequestId(prefix: string): string {
    this.requestCounter += 1
    return `${prefix}-${Date.now()}-${this.requestCounter}`
  }

  // ---------------------------------------------------------------------------
  // Enqueue
  // ---------------------------------------------------------------------------

  enqueueRequest<RequestType extends WsRequestType>(
    requestType: RequestType,
    buildCommand: (requestId: string) => ClientCommand,
    options?: { timeoutMs?: number },
  ): Promise<WsRequestResultMap[RequestType]> {
    const requestId = this.nextRequestId(requestType)

    return new Promise<WsRequestResultMap[RequestType]>((resolve, reject) => {
      this.tracker.track(requestType, requestId, resolve, reject, options?.timeoutMs)

      const sent = this.deps.send(buildCommand(requestId))
      if (!sent) {
        this.tracker.reject(
          requestType,
          requestId,
          new Error(RECONNECTING_SOCKET_ERROR),
        )
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Error attribution / rejection
  // ---------------------------------------------------------------------------

  isPendingDirectoryRequest(requestId?: string): boolean {
    const requestType = this.tracker.getPendingRequestType(requestId)
    return requestType === 'list_directories'
      || requestType === 'validate_directory'
      || requestType === 'create_directory'
  }

  rejectPendingFromError(code: string, message: string, requestId?: string): void {
    const fullError = new Error(`${code}: ${message}`)

    if (requestId && this.tracker.rejectByRequestId(requestId, fullError)) {
      return
    }

    const loweredCode = code.toLowerCase()

    for (const hint of WS_REQUEST_ERROR_HINTS) {
      if (!loweredCode.includes(hint.codeFragment)) {
        continue
      }

      if (this.tracker.rejectOldest(hint.requestType, fullError)) {
        return
      }
    }

    this.tracker.rejectOnlyPending(fullError)
  }

  rejectAllPendingRequests(reason: string): void {
    this.tracker.rejectAll(new Error(reason))
  }
}
