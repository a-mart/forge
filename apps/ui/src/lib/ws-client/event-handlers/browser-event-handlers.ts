import type {
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostRegistration,
  BrowserSessionSnapshot,
  ServerEvent,
} from '@forge/protocol'
import type { ManagerWsState } from '../../ws-state'
import type { RequestTrackerAdapter } from '../types'

export interface BrowserEventContext {
  state: ManagerWsState
  updateState: (patch: Partial<ManagerWsState>) => void
  requestTracker: RequestTrackerAdapter
  acceptHydrationChunk: (event: Extract<ServerEvent, { type: 'browser_host_hydration_chunk' }>) => BrowserSessionSnapshot[] | null
  registration: BrowserHostRegistration | null
  handleAutomationRequest: ((request: BrowserAutomationRequest) => Promise<BrowserAutomationResponse>) | null
  sendHostResponse: (response: BrowserAutomationResponse) => void
}

export function handleBrowserEvent(event: ServerEvent, context: BrowserEventContext): boolean {
  switch (event.type) {
    case 'browser_host_connected': {
      if (event.requestId && context.requestTracker.getPendingRequestType(event.requestId) !== 'browser_host_register') return true
      const registration = context.registration
      if (registration && event.host.hostId !== null && event.host.hostId !== registration.hostId) return true
      const currentHost = context.state.browserHost
      const sameAuthority = event.host.hostId !== null
        && event.host.hostId === currentHost.hostId
        && event.host.hostGeneration === currentHost.hostGeneration
      context.updateState(
        sameAuthority
          ? { browserHost: event.host }
          : {
              browserHost: event.host,
              browserHostHydrated: false,
              browserPanelRevealRequest: null,
            },
      )
      if (event.requestId && context.requestTracker.getPendingRequestType(event.requestId) === 'browser_host_register') {
        context.requestTracker.resolve('browser_host_register', event.requestId, event.host)
      }
      return true
    }
    case 'browser_host_hydration_chunk': {
      if (
        !isCurrentHostEvent(context, event.hostId, event.hostGeneration)
        || context.requestTracker.getPendingRequestType(event.requestId) !== 'browser_host_hydrate'
      ) return true
      const sessions = context.acceptHydrationChunk(event)
      if (!sessions) return true
      const browserSessions = indexSessions(sessions)
      context.updateState({
        browserSessions,
        browserHostHydrated: true,
        browserPanelRevealRequest: projectPanelRevealRequest(context.state, browserSessions, event.hostGeneration),
        browserMetadataStale: false,
      })
      context.requestTracker.resolve('browser_host_hydrate', event.requestId, sessions)
      return true
    }
    case 'browser_host_state_snapshot': {
      if (!isCurrentHostEvent(context, event.hostId, event.hostGeneration)) return true
      const browserSessions = indexSessions(event.sessions)
      context.updateState({
        browserSessions,
        browserHostHydrated: true,
        browserPanelRevealRequest: projectPanelRevealRequest(context.state, browserSessions, event.hostGeneration),
        browserMetadataStale: false,
      })
      return true
    }
    case 'browser_host_state_report_result': {
      context.requestTracker.resolve('browser_host_state_report', event.requestId, event.result)
      return true
    }
    case 'browser_session_snapshot': {
      if (!isSelectedSession(context.state, event.snapshot.sessionAgentId)) return true
      // Bootstrap is authoritative for the new subscription/connection even
      // when its restored revision is lower than retained stale metadata.
      const browserSessions = {
        ...context.state.browserSessions,
        [event.snapshot.sessionAgentId]: event.snapshot,
      }
      context.updateState({
        browserSessions,
        browserPanelRevealRequest: context.state.browserHostHydrated
          ? projectPanelRevealRequest(context.state, browserSessions, context.state.browserHost.hostGeneration)
          : null,
        browserMetadataStale: false,
      })
      return true
    }
    case 'browser_session_changed': {
      if (event.snapshot.hostingState === 'removed') {
        const next = { ...context.state.browserSessions }
        delete next[event.snapshot.sessionAgentId]
        context.updateState({
          browserSessions: next,
          browserPanelRevealRequest: projectPanelRevealRequest(context.state, next, context.state.browserHost.hostGeneration),
          browserMetadataStale: false,
        })
        return true
      }
      const previous = context.state.browserSessions[event.snapshot.sessionAgentId]
      if (previous && event.snapshot.revision <= previous.revision) return true
      const browserSessions = {
        ...context.state.browserSessions,
        [event.snapshot.sessionAgentId]: event.snapshot,
      }
      context.updateState({
        browserSessions,
        browserPanelRevealRequest: projectPanelRevealRequest(
          context.state,
          browserSessions,
          context.state.browserHost.hostGeneration,
        ),
        browserMetadataStale: false,
      })
      return true
    }
    case 'browser_panel_reveal_acknowledged': {
      const browserSessions = {
        ...context.state.browserSessions,
        [event.snapshot.sessionAgentId]: event.snapshot,
      }
      context.updateState({
        browserSessions,
        browserPanelRevealRequest: projectPanelRevealRequest(
          context.state,
          browserSessions,
          context.state.browserHost.hostGeneration,
        ),
      })
      context.requestTracker.resolve('browser_panel_reveal_acknowledge', event.requestId, event.snapshot)
      return true
    }
    case 'browser_automation_request': {
      const registration = context.registration
      const request = event.request
      if (
        !registration ||
        request.hostId !== registration.hostId ||
        request.hostGeneration !== context.state.browserHost.hostGeneration ||
        !context.handleAutomationRequest
      ) return true
      void context.handleAutomationRequest(request)
        .then(context.sendHostResponse)
        .catch((error) => context.sendHostResponse(failureResponse(request, error)))
      return true
    }
    case 'browser_tab_command_succeeded': {
      updateSessionFromCommand(context, event.snapshot)
      context.requestTracker.resolve(event.commandType, event.requestId, event.snapshot)
      return true
    }
    case 'browser_recording_command_succeeded': {
      updateSessionFromCommand(context, event.snapshot)
      if (event.commandType === 'browser_recording_start') {
        context.requestTracker.resolve(event.commandType, event.requestId, event.result)
      } else {
        context.requestTracker.resolve(event.commandType, event.requestId, event.result)
      }
      return true
    }
    default:
      return false
  }
}

function updateSessionFromCommand(context: BrowserEventContext, snapshot: BrowserSessionSnapshot): void {
  const previous = context.state.browserSessions[snapshot.sessionAgentId]
  if (!previous || snapshot.revision >= previous.revision) {
    context.updateState({
      browserSessions: {
        ...context.state.browserSessions,
        [snapshot.sessionAgentId]: snapshot,
      },
    })
  }
}

function isCurrentHostEvent(context: BrowserEventContext, hostId: string, generation: number): boolean {
  return context.registration?.hostId === hostId && context.state.browserHost.hostGeneration === generation
}

function isSelectedSession(state: ManagerWsState, sessionAgentId: string): boolean {
  if (state.targetAgentId === sessionAgentId || state.subscribedAgentId === sessionAgentId) return true
  const selectedId = state.targetAgentId ?? state.subscribedAgentId
  const selected = state.agents.find((agent) => agent.agentId === selectedId)
  return selected?.role === 'worker' && selected.managerId === sessionAgentId
}

function indexSessions(sessions: BrowserSessionSnapshot[]): Record<string, BrowserSessionSnapshot> {
  return Object.fromEntries(sessions.map((snapshot) => [snapshot.sessionAgentId, snapshot]))
}

function projectPanelRevealRequest(
  state: ManagerWsState,
  sessions: Record<string, BrowserSessionSnapshot>,
  hostGeneration: number | null,
): ManagerWsState['browserPanelRevealRequest'] {
  if (hostGeneration === null) return null
  const snapshot = Object.values(sessions).find((candidate) => isSelectedSession(state, candidate.sessionAgentId))
  const reveal = snapshot?.panelReveal
  if (!snapshot || !reveal || reveal.sequence <= reveal.acknowledgedSequence || reveal.tabId === null) return null
  if (!snapshot.tabs.some((tab) => tab.tabId === reveal.tabId && tab.lifecycle !== 'closed')) return null
  return {
    sessionAgentId: snapshot.sessionAgentId,
    profileId: snapshot.profileId,
    tabId: reveal.tabId,
    hostGeneration,
    sequence: reveal.sequence,
  }
}

function failureResponse(request: BrowserAutomationRequest, error: unknown): BrowserAutomationResponse {
  const candidate = error && typeof error === 'object' ? error as Record<string, unknown> : null
  const validCodes = new Set<import('@forge/protocol').BrowserAutomationErrorCode>([
    'unavailable-host', 'unsupported-operation', 'session-not-found', 'tab-not-found', 'tab-session-mismatch',
    'invalid-input', 'invalid-url', 'navigation-failed', 'timeout', 'control-interrupted', 'target-not-found',
    'invalid-selector', 'target-not-editable', 'coordinates-outside-viewport', 'evaluation-failed', 'result-too-large',
    'response-too-large', 'host-disconnected', 'stale-host-generation', 'malformed-response', 'artifact-path-invalid',
    'recording-conflict', 'recording-requires-visible-tab', 'recording-not-found', 'request-cancelled', 'execution-failed',
  ])
  const code = typeof candidate?.code === 'string' && validCodes.has(candidate.code as import('@forge/protocol').BrowserAutomationErrorCode)
    ? candidate.code as import('@forge/protocol').BrowserAutomationErrorCode
    : 'execution-failed'
  const details = candidate?.details && typeof candidate.details === 'object' && !Array.isArray(candidate.details)
    ? candidate.details as Record<string, string | number | boolean | null>
    : undefined
  return {
    requestId: request.requestId,
    sessionAgentId: request.sessionAgentId,
    profileId: request.profileId,
    tabId: request.tabId,
    hostId: request.hostId,
    hostGeneration: request.hostGeneration,
    operation: request.operation,
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : typeof candidate?.message === 'string' ? candidate.message : String(error),
      retryable: candidate?.retryable === true,
      ...(details ? { details } : {}),
    },
    elapsedMs: 0,
  }
}
