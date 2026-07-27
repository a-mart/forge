import { resolveBrowserTargetAffinity } from '@forge/protocol'
import type {
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostLifecycleRequest,
  BrowserHostLifecycleResponse,
  BrowserHostRegistration,
  BrowserHostStateReportResult,
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
  handleLifecycleRequest: ((request: BrowserHostLifecycleRequest) => Promise<BrowserHostLifecycleResponse>) | null
  sendHostResponse: (response: BrowserAutomationResponse) => void
  sendLifecycleResponse: (response: BrowserHostLifecycleResponse) => void
}

export function handleBrowserEvent(event: ServerEvent, context: BrowserEventContext): boolean {
  switch (event.type) {
    case 'browser_host_connected': {
      if (event.requestId && context.requestTracker.getPendingRequestType(event.requestId) !== 'browser_host_register') return true
      const registration = context.registration
      if (registration && event.host.hostId !== null && event.host.hostId !== registration.hostId) return true
      const host = event.host
      const currentHost = context.state.browserHost
      const sameAuthority = host.hostId !== null
        && host.hostId === currentHost.hostId
        && host.hostGeneration === currentHost.hostGeneration
      context.updateState(sameAuthority ? { browserHost: host } : {
        browserHost: host,
        browserHostHydrated: false,
        browserPanelRevealRequest: null,
      })
      if (event.requestId) context.requestTracker.resolve('browser_host_register', event.requestId, host)
      return true
    }
    case 'browser_host_hydration_chunk': {
      if (!isCurrentHostEvent(context, event.hostId, event.hostGeneration)
        || context.requestTracker.getPendingRequestType(event.requestId) !== 'browser_host_hydrate') return true
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
      context.requestTracker.resolve('browser_host_state_report', event.requestId, normalizeHostStateReportResult(event.result))
      return true
    }
    case 'browser_session_snapshot': {
      if (!isSelectedSession(context.state, event.snapshot.sessionAgentId)) return true
      const browserSessions = { ...context.state.browserSessions, [event.snapshot.sessionAgentId]: event.snapshot }
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
      const snapshot = event.snapshot
      if (snapshot.hostingState === 'removed') {
        const next = { ...context.state.browserSessions }
        delete next[snapshot.sessionAgentId]
        context.updateState({
          browserSessions: next,
          browserPanelRevealRequest: projectPanelRevealRequest(context.state, next, context.state.browserHost.hostGeneration),
          browserMetadataStale: false,
        })
        return true
      }
      const previous = context.state.browserSessions[snapshot.sessionAgentId]
      if (previous && snapshot.revision <= previous.revision) return true
      const browserSessions = { ...context.state.browserSessions, [snapshot.sessionAgentId]: snapshot }
      context.updateState({
        browserSessions,
        browserPanelRevealRequest: projectPanelRevealRequest(context.state, browserSessions, context.state.browserHost.hostGeneration),
        browserMetadataStale: false,
      })
      return true
    }
    case 'browser_panel_reveal_acknowledged': {
      const browserSessions = { ...context.state.browserSessions, [event.snapshot.sessionAgentId]: event.snapshot }
      context.updateState({
        browserSessions,
        browserPanelRevealRequest: projectPanelRevealRequest(context.state, browserSessions, context.state.browserHost.hostGeneration),
      })
      context.requestTracker.resolve('browser_panel_reveal_acknowledge', event.requestId, event.snapshot)
      return true
    }
    case 'browser_automation_request': {
      const request = event.request
      const registration = context.registration
      if (!registration || request.hostId !== registration.hostId
        || request.hostGeneration !== context.state.browserHost.hostGeneration
        || !context.handleAutomationRequest) return true
      void context.handleAutomationRequest(request)
        .then(context.sendHostResponse)
        .catch((error) => context.sendHostResponse(failureResponse(request, error)))
      return true
    }
    case 'browser_host_lifecycle_request': {
      const request = event.request
      const registration = context.registration
      if (!registration || request.hostId !== registration.hostId
        || request.hostGeneration !== context.state.browserHost.hostGeneration
        || !context.handleLifecycleRequest) return true
      void context.handleLifecycleRequest(request)
        .then(context.sendLifecycleResponse)
        .catch((error) => context.sendLifecycleResponse(lifecycleFailureResponse(request, error)))
      return true
    }
    case 'browser_tab_command_succeeded': {
      updateSessionFromCommand(context, event.snapshot)
      context.requestTracker.resolve(event.commandType, event.requestId, event.snapshot)
      return true
    }
    case 'browser_recording_command_succeeded': {
      updateSessionFromCommand(context, event.snapshot)
      context.requestTracker.resolve(event.commandType, event.requestId, event.result)
      return true
    }
    default:
      return false
  }
}

function updateSessionFromCommand(context: BrowserEventContext, snapshot: BrowserSessionSnapshot): void {
  const previous = context.state.browserSessions[snapshot.sessionAgentId]
  if (!previous || snapshot.revision >= previous.revision) {
    context.updateState({ browserSessions: { ...context.state.browserSessions, [snapshot.sessionAgentId]: snapshot } })
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

function normalizeHostStateReportResult(result: BrowserHostStateReportResult): BrowserHostStateReportResult {
  return {
    ...result,
    sessions: result.sessions.map((session) => session.snapshot ? { ...session, snapshot: session.snapshot } : session),
  } as BrowserHostStateReportResult
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
  if (!snapshot.tabs.some((tab) => tab.tabId === reveal.tabId
    && resolveBrowserTargetAffinity(tab) === 'managed-electron'
    && tab.lifecycle !== 'closed')) return null
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
      code: 'execution-failed',
      message: error instanceof Error ? error.message : typeof candidate?.message === 'string' ? candidate.message : String(error),
      retryable: candidate?.retryable === true,
    },
    elapsedMs: 0,
  }
}

function lifecycleFailureResponse(request: BrowserHostLifecycleRequest, error: unknown): BrowserHostLifecycleResponse {
  return {
    requestId: request.requestId,
    sessionAgentId: request.sessionAgentId,
    profileId: request.profileId,
    hostId: request.hostId,
    hostGeneration: request.hostGeneration,
    kind: request.kind,
    ok: false,
    error: {
      code: 'execution-failed',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    },
  }
}
