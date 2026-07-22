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
  registration: BrowserHostRegistration | null
  handleAutomationRequest: ((request: BrowserAutomationRequest) => Promise<BrowserAutomationResponse>) | null
  sendHostResponse: (response: BrowserAutomationResponse) => void
}

export function handleBrowserEvent(event: ServerEvent, context: BrowserEventContext): boolean {
  switch (event.type) {
    case 'browser_host_connected': {
      const registration = context.registration
      if (registration && event.host.hostId !== null && event.host.hostId !== registration.hostId) return true
      context.updateState({ browserHost: event.host })
      return true
    }
    case 'browser_host_state_snapshot': {
      if (!isCurrentHostEvent(context, event.hostId, event.hostGeneration)) return true
      context.updateState({
        browserSessions: indexSessions(event.sessions),
        browserHostHydrated: true,
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
      context.updateState({
        browserSessions: {
          ...context.state.browserSessions,
          [event.snapshot.sessionAgentId]: event.snapshot,
        },
        browserMetadataStale: false,
      })
      return true
    }
    case 'browser_session_changed': {
      if (event.snapshot.hostingState === 'removed') {
        const next = { ...context.state.browserSessions }
        delete next[event.snapshot.sessionAgentId]
        context.updateState({ browserSessions: next, browserMetadataStale: false })
        return true
      }
      const previous = context.state.browserSessions[event.snapshot.sessionAgentId]
      if (previous && event.snapshot.revision <= previous.revision) return true
      context.updateState({
        browserSessions: {
          ...context.state.browserSessions,
          [event.snapshot.sessionAgentId]: event.snapshot,
        },
        browserMetadataStale: false,
      })
      return true
    }
    case 'browser_panel_reveal_requested':
      if (!isSelectedSession(context.state, event.sessionAgentId)) return true
      if (context.state.browserHost.hostGeneration !== event.hostGeneration) return true
      if ((context.state.browserSessions[event.sessionAgentId]?.revision ?? -1) > event.revision) return true
      context.updateState({ browserPanelRevealRequest: event })
      return true
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

function failureResponse(request: BrowserAutomationRequest, error: unknown): BrowserAutomationResponse {
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
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    },
    elapsedMs: 0,
  }
}
