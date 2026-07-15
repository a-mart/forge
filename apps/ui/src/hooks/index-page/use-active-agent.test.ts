/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import type { ManagerWsClient } from '@/lib/ws-client'
import { createInitialManagerWsState, type ManagerWsState } from '@/lib/ws-state'
import type { AppRouteState } from './use-route-state'
import { useActiveAgent } from './use-active-agent'

function makeManager(agentId: string, profileId = agentId): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
    sessionFile: `/tmp/${agentId}.jsonl`,
    profileId,
  }
}

function makeProfile(manager: AgentDescriptor, archived = false): ManagerProfile {
  return {
    profileId: manager.profileId ?? manager.agentId,
    displayName: manager.displayName,
    defaultSessionAgentId: manager.agentId,
    defaultModel: manager.model,
    createdAt: manager.createdAt,
    updatedAt: manager.updatedAt,
    ...(archived ? { archivedAt: '2026-01-02T00:00:00.000Z' } : {}),
  }
}

let container: HTMLDivElement
let root: Root | null = null
const reactTestGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean
}

beforeEach(() => {
  reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
    root = null
  }
  container.remove()
  reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = false
})

function renderActiveAgent(input: {
  state: ManagerWsState
  routeAgentId: string
  explicitSelectionAgentId?: string | null
  rejectedSelectionAgentId?: string | null
  explicitSelectionPending?: boolean
}) {
  const subscribeToAgent = vi.fn()
  const navigateToRoute = vi.fn()
  const client = {
    getExplicitSelectionAgentId: () => input.explicitSelectionAgentId ?? null,
    getRejectedExplicitSelectionAgentId: () => input.rejectedSelectionAgentId ?? null,
    isExplicitSelectionPending: () => input.explicitSelectionPending ?? false,
    hasExplicitSelection: () => input.explicitSelectionAgentId != null,
    subscribeToAgent,
  } as unknown as ManagerWsClient
  const coordinator = {
    requestFileEditorTransition: (_action: unknown, run: () => void) => run(),
  }

  function TestComponent() {
    useActiveAgent({
      state: input.state,
      routeState: { view: 'chat', agentId: input.routeAgentId } as AppRouteState,
      navigateToRoute,
      clientRef: { current: client },
      fileEditorCoordinatorRef: { current: coordinator } as never,
      previousAgentsByIdRef: { current: new Map() },
    })
    return null
  }

  root = createRoot(container)
  act(() => root?.render(createElement(TestComponent)))
  return { navigateToRoute, subscribeToAgent }
}

describe('useActiveAgent route subscription', () => {
  it('subscribes a cold explicit worker route before the agents snapshot arrives', () => {
    const state = {
      ...createInitialManagerWsState(null),
      connected: true,
    }

    const { subscribeToAgent } = renderActiveAgent({
      state,
      routeAgentId: 'idle-worker',
    })

    expect(subscribeToAgent).toHaveBeenCalledOnce()
    expect(subscribeToAgent).toHaveBeenCalledWith('idle-worker')
  })

  it('does not abandon an explicit route while its subscription is pending', () => {
    const fallback = makeManager('fallback')
    const state = {
      ...createInitialManagerWsState('idle-worker'),
      connected: true,
      agents: [fallback],
      profiles: [makeProfile(fallback)],
      hasReceivedAgentsSnapshot: true,
      hasReceivedProfilesSnapshot: true,
    }

    const { navigateToRoute, subscribeToAgent } = renderActiveAgent({
      state,
      routeAgentId: 'idle-worker',
      explicitSelectionAgentId: 'idle-worker',
      explicitSelectionPending: true,
    })

    expect(subscribeToAgent).not.toHaveBeenCalled()
    expect(navigateToRoute).not.toHaveBeenCalled()
  })

  it('re-subscribes an explicit route cleared by an earlier managers-only snapshot', () => {
    const fallback = makeManager('fallback')
    const state = {
      ...createInitialManagerWsState('fallback'),
      connected: true,
      agents: [fallback],
      profiles: [makeProfile(fallback)],
      hasReceivedAgentsSnapshot: true,
      hasReceivedProfilesSnapshot: true,
    }

    const { navigateToRoute, subscribeToAgent } = renderActiveAgent({
      state,
      routeAgentId: 'idle-worker',
    })

    expect(subscribeToAgent).toHaveBeenCalledOnce()
    expect(subscribeToAgent).toHaveBeenCalledWith('idle-worker')
    expect(navigateToRoute).not.toHaveBeenCalled()
  })

  it('waits for the targeted descriptor after ready accepts an explicit route', () => {
    const fallback = makeManager('fallback')
    const state = {
      ...createInitialManagerWsState('idle-worker'),
      connected: true,
      agents: [fallback],
      profiles: [makeProfile(fallback)],
      hasReceivedAgentsSnapshot: true,
      hasReceivedProfilesSnapshot: true,
    }

    const { navigateToRoute, subscribeToAgent } = renderActiveAgent({
      state,
      routeAgentId: 'idle-worker',
      explicitSelectionAgentId: 'idle-worker',
      explicitSelectionPending: false,
    })

    expect(subscribeToAgent).not.toHaveBeenCalled()
    expect(navigateToRoute).not.toHaveBeenCalled()
  })

  it('falls back once after rejection and excludes sessions from archived profiles', () => {
    const archivedSession = makeManager('archived--s2', 'archived')
    const fallback = makeManager('fallback')
    const state = {
      ...createInitialManagerWsState('missing-worker'),
      connected: true,
      agents: [archivedSession, fallback],
      profiles: [makeProfile(archivedSession, true), makeProfile(fallback)],
      hasReceivedAgentsSnapshot: true,
      hasReceivedProfilesSnapshot: true,
    }

    const { navigateToRoute, subscribeToAgent } = renderActiveAgent({
      state,
      routeAgentId: 'missing-worker',
      explicitSelectionAgentId: 'missing-worker',
      rejectedSelectionAgentId: 'missing-worker',
    })

    expect(subscribeToAgent).toHaveBeenCalledOnce()
    expect(subscribeToAgent).toHaveBeenCalledWith('fallback', { explicit: false })
    expect(navigateToRoute).toHaveBeenCalledOnce()
    expect(navigateToRoute).toHaveBeenCalledWith(
      { view: 'chat', agentId: 'fallback' },
      true,
    )
  })
})
