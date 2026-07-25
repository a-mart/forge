import { resolveBrowserHostKind } from '@forge/protocol'
import type {
  BrowserAutomationRequest,
  BrowserAutomationResponse,
  BrowserHostKind,
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
  sendHostResponse: (response: BrowserAutomationResponse) => void
}

export function handleBrowserEvent(event: ServerEvent, context: BrowserEventContext): boolean {
  switch (event.type) {
    case 'browser_host_connected': {
      if (event.requestId && context.requestTracker.getPendingRequestType(event.requestId) !== 'browser_host_register') return true
      const registration = context.registration
      if (registration && (
        (event.host.hostKind ?? 'managed-electron') !== (registration.capabilities.hostKind ?? 'managed-electron')
        || (event.host.hostId !== null && event.host.hostId !== registration.hostId)
      )) return true
      const host = normalizeHostSnapshot(event.host)
      const currentHost = context.state.browserHost
      const sameAuthority = host.hostId !== null
        && host.hostId === currentHost.hostId
        && host.hostGeneration === currentHost.hostGeneration
      context.updateState(
        sameAuthority
          ? { browserHost: host }
          : {
              browserHost: host,
              browserHostHydrated: false,
              browserPanelRevealRequest: null,
            },
      )
      if (event.requestId && context.requestTracker.getPendingRequestType(event.requestId) === 'browser_host_register') {
        context.requestTracker.resolve('browser_host_register', event.requestId, host)
      }
      return true
    }
    case 'browser_host_hydration_chunk': {
      if (
        !isCurrentHostEvent(context, event.hostId, event.hostGeneration, event.hostKind)
        || context.requestTracker.getPendingRequestType(event.requestId) !== 'browser_host_hydrate'
      ) return true
      const rawSessions = context.acceptHydrationChunk(event)
      if (!rawSessions) return true
      const sessions = rawSessions.map(normalizeSnapshotHostKinds)
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
      if (!isCurrentHostEvent(context, event.hostId, event.hostGeneration, event.hostKind)) return true
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
      // Bootstrap is authoritative for the new subscription/connection even
      // when its restored revision is lower than retained stale metadata.
      const snapshot = normalizeSnapshotHostKinds(event.snapshot)
      const browserSessions = {
        ...context.state.browserSessions,
        [snapshot.sessionAgentId]: snapshot,
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
      const snapshot = normalizeSnapshotHostKinds(event.snapshot)
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
      const browserSessions = {
        ...context.state.browserSessions,
        [snapshot.sessionAgentId]: snapshot,
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
      const snapshot = normalizeSnapshotHostKinds(event.snapshot)
      const browserSessions = {
        ...context.state.browserSessions,
        [snapshot.sessionAgentId]: snapshot,
      }
      context.updateState({
        browserSessions,
        browserPanelRevealRequest: projectPanelRevealRequest(
          context.state,
          browserSessions,
          context.state.browserHost.hostGeneration,
        ),
      })
      context.requestTracker.resolve('browser_panel_reveal_acknowledge', event.requestId, snapshot)
      return true
    }
    case 'browser_automation_request': {
      const registration = context.registration
      const request = { ...event.request, hostKind: resolveBrowserHostKind(event.request.hostKind) } as BrowserAutomationRequest
      if (
        !registration ||
        request.hostKind !== resolveBrowserHostKind(registration.capabilities.hostKind) ||
        request.hostId !== registration.hostId ||
        request.hostGeneration !== context.state.browserHost.hostGeneration ||
        !context.handleAutomationRequest
      ) return true
      void context.handleAutomationRequest(request)
        .then(context.sendHostResponse)
        .catch((error) => context.sendHostResponse(failureResponse(request, error)))
      return true
    }
    case 'browser_session_command_succeeded': {
      const snapshot = normalizeSnapshotHostKinds(event.snapshot)
      updateSessionFromCommand(context, snapshot)
      context.requestTracker.resolve(event.commandType, event.requestId, snapshot)
      return true
    }
    case 'browser_tab_command_succeeded': {
      const snapshot = normalizeSnapshotHostKinds(event.snapshot)
      updateSessionFromCommand(context, snapshot)
      context.requestTracker.resolve(event.commandType, event.requestId, snapshot)
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

function updateSessionFromCommand(context: BrowserEventContext, rawSnapshot: BrowserSessionSnapshot): void {
  const snapshot = normalizeSnapshotHostKinds(rawSnapshot)
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

function isCurrentHostEvent(context: BrowserEventContext, hostId: string, generation: number, hostKind: BrowserHostKind = 'managed-electron'): boolean {
  return context.registration?.hostId === hostId
    && resolveBrowserHostKind(context.registration.capabilities.hostKind) === resolveBrowserHostKind(hostKind)
    && context.state.browserHost.hostGeneration === generation
}

function isSelectedSession(state: ManagerWsState, sessionAgentId: string): boolean {
  if (state.targetAgentId === sessionAgentId || state.subscribedAgentId === sessionAgentId) return true
  const selectedId = state.targetAgentId ?? state.subscribedAgentId
  const selected = state.agents.find((agent) => agent.agentId === selectedId)
  return selected?.role === 'worker' && selected.managerId === sessionAgentId
}

function indexSessions(sessions: BrowserSessionSnapshot[]): Record<string, BrowserSessionSnapshot> {
  return Object.fromEntries(sessions.map((rawSnapshot) => {
    const snapshot = normalizeSnapshotHostKinds(rawSnapshot)
    return [snapshot.sessionAgentId, snapshot]
  }))
}

function normalizeSnapshotHostKinds(snapshot: BrowserSessionSnapshot): BrowserSessionSnapshot {
  const hostKind = resolveBrowserHostKind(snapshot.hostKind)
  return {
    ...snapshot,
    hostKind,
    tabs: snapshot.tabs.map((tab) => ({ ...tab, hostKind: resolveBrowserHostKind(tab.hostKind ?? hostKind) })),
  }
}

function normalizeHostSnapshot(host: ManagerWsState['browserHost']): ManagerWsState['browserHost'] {
  const hostKind = resolveBrowserHostKind(host.hostKind ?? host.capabilities?.hostKind)
  return {
    ...host,
    hostKind,
    capabilities: host.capabilities ? { ...host.capabilities, hostKind } : null,
  }
}

function normalizeHostStateReportResult(result: BrowserHostStateReportResult): BrowserHostStateReportResult {
  return {
    ...result,
    hostKind: resolveBrowserHostKind(result.hostKind),
    sessions: result.sessions.map((session) => session.snapshot
      ? { ...session, snapshot: normalizeSnapshotHostKinds(session.snapshot) }
      : session),
  } as BrowserHostStateReportResult
}

function projectPanelRevealRequest(
  state: ManagerWsState,
  sessions: Record<string, BrowserSessionSnapshot>,
  hostGeneration: number | null,
): ManagerWsState['browserPanelRevealRequest'] {
  if (hostGeneration === null || resolveBrowserHostKind(state.browserHost.hostKind) !== 'managed-electron') return null
  const snapshot = Object.values(sessions).find((candidate) => isSelectedSession(state, candidate.sessionAgentId)
    && resolveBrowserHostKind(candidate.hostKind) === 'managed-electron')
  const reveal = snapshot?.panelReveal
  if (!snapshot || !reveal || reveal.sequence <= reveal.acknowledgedSequence || reveal.tabId === null) return null
  if (!snapshot.tabs.some((tab) => tab.tabId === reveal.tabId
    && resolveBrowserHostKind(tab.hostKind) === 'managed-electron'
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
  const validCodes = new Set<import('@forge/protocol').BrowserAutomationErrorCode>([
    'unavailable-host', 'unsupported-operation', 'session-not-found', 'tab-not-found', 'tab-session-mismatch',
    'invalid-input', 'invalid-url', 'navigation-failed', 'timeout', 'control-interrupted', 'target-not-found',
    'invalid-selector', 'target-not-editable', 'coordinates-outside-viewport', 'evaluation-failed', 'result-too-large',
    'response-too-large', 'host-disconnected', 'stale-host-generation', 'malformed-response', 'artifact-path-invalid',
    'recording-conflict', 'recording-requires-visible-tab', 'recording-not-found', 'request-cancelled', 'execution-failed',
    'attachment-required', 'lease-conflict', 'lease-lost', 'restricted-target', 'debugger-unavailable',
    'extension-update-required', 'chrome-policy-blocked',
  ])
  const code = typeof candidate?.code === 'string' && validCodes.has(candidate.code as import('@forge/protocol').BrowserAutomationErrorCode)
    ? candidate.code as import('@forge/protocol').BrowserAutomationErrorCode
    : 'execution-failed'
  const details = candidate?.details && typeof candidate.details === 'object' && !Array.isArray(candidate.details)
    ? candidate.details as Record<string, string | number | boolean | null>
    : undefined
  return {
    requestId: request.requestId,
    hostKind: request.hostKind,
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
