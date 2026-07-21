/** @vitest-environment jsdom */

import { fireEvent, getByRole, queryByRole, waitFor } from '@testing-library/dom'
import { createElement, type ComponentProps } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteUpdateAwarenessProjectSnapshot } from '@forge/protocol'
import { ChatWorkspace } from './ChatWorkspace'

const api = vi.hoisted(() => ({
  dismissRemoteUpdateAwarenessProjectUpdate: vi.fn(),
  fetchRemoteUpdateAwarenessIncoming: vi.fn(),
  refreshRemoteUpdateAwarenessProject: vi.fn(),
}))

vi.mock('@/components/settings/remote-update-awareness-api', () => api)
vi.mock('@/components/chat/cortex/OnboardingCallout', () => ({ OnboardingCallout: () => null }))
vi.mock('@/components/chat/ChatHeader', () => ({ ChatHeader: () => null }))
vi.mock('@/components/chat/ChatSearchBar', () => ({ ChatSearchBar: () => null }))
vi.mock('@/components/chat/MessageInput', () => ({ MessageInput: () => null }))
vi.mock('@/components/chat/MessageList', () => ({ MessageList: () => null }))
vi.mock('@/components/chat/plan', () => ({ PlanDockIndicator: () => null }))
vi.mock('@/components/chat/goal', () => ({ GoalBar: () => null }))
vi.mock('@/components/chat/SessionAuditDrawer', () => ({ SessionAuditDrawer: () => null }))
vi.mock('@/components/chat/WorkerBackBar', () => ({ WorkerBackBar: () => null }))
vi.mock('@/components/chat/WorkerPillBar', () => ({ WorkerPillBar: () => null }))
vi.mock('@/components/terminal/TerminalPanel', () => ({ TerminalPanel: () => null }))

const snapshot: RemoteUpdateAwarenessProjectSnapshot = {
  projectId: 'project-a',
  override: 'inherit',
  globalEnabled: true,
  effectiveEnabled: true,
  state: 'update_available',
  lastObservedAt: null,
  failureCode: null,
  attentionRequired: true,
  dismissalTarget: { generation: 12 },
}

let root: Root | null = null
let container: HTMLDivElement

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  vi.clearAllMocks()
})

function render(props: Partial<ComponentProps<typeof ChatWorkspace>>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(createElement(ChatWorkspace, {
      headerProps: { wsUrl: 'ws://localhost:47188', activeAgentRole: null, activeAgentId: null } as never,
      lastError: null,
      lastSuccess: null,
      restartRecovery: null,
      onResumeRestartRecovery: vi.fn(),
      onDismissRestartRecovery: vi.fn(),
      chatSearchBarProps: {} as never,
      showWelcomeForm: false,
      showCreateManagerState: false,
      welcomeCalloutProps: {} as never,
      readyCalloutProps: {} as never,
      isMessageListHidden: false,
      messageListRef: { current: null },
      messageListProps: {} as never,
      onGoalAction: vi.fn(),
      terminalPanelProps: {} as never,
      messageInputRef: { current: null },
      messageInputProps: {} as never,
      ...props,
    }))
  })
}

describe('ChatWorkspace remote update awareness', () => {
  it('shows the undismissed active-project update and wires Incoming, refresh, and exact dismissal', async () => {
    const onInspect = vi.fn()
    const onSnapshotChange = vi.fn()
    api.refreshRemoteUpdateAwarenessProject.mockResolvedValue({ snapshot })
    api.dismissRemoteUpdateAwarenessProjectUpdate.mockResolvedValue({
      snapshot: { ...snapshot, attentionRequired: false },
    })

    render({
      remoteUpdateSnapshot: snapshot,
      onOpenRemoteUpdateIncoming: onInspect,
      onRemoteUpdateSnapshotChange: onSnapshotChange,
    })

    expect(container.textContent).toContain('The remote default branch has advanced.')
    fireEvent.click(getByRole(container, 'button', { name: 'Inspect Incoming' }))
    expect(onInspect).toHaveBeenCalledOnce()

    fireEvent.click(getByRole(container, 'button', { name: 'Check now' }))
    await waitFor(() => expect(api.refreshRemoteUpdateAwarenessProject).toHaveBeenCalledWith('ws://localhost:47188', 'project-a'))
    expect(onSnapshotChange).toHaveBeenCalledWith(snapshot)

    fireEvent.click(getByRole(container, 'button', { name: 'Dismiss this exact remote tip' }))
    await waitFor(() => expect(api.dismissRemoteUpdateAwarenessProjectUpdate).toHaveBeenCalledWith('ws://localhost:47188', 'project-a', 12))
    expect(onSnapshotChange).toHaveBeenCalledWith({ ...snapshot, attentionRequired: false })
  })

  it.each([
    ['dismissed update', { ...snapshot, attentionRequired: false }],
    ['stale result', { ...snapshot, state: 'stale' as const }],
    ['disabled project', { ...snapshot, effectiveEnabled: false }],
  ])('stays silent for a $0', (_label, remoteUpdateSnapshot) => {
    render({ remoteUpdateSnapshot })
    expect(queryByRole(container, 'status')).toBeNull()
  })
})
