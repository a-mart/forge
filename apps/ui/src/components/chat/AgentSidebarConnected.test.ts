/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import { AgentSidebarConnected } from './AgentSidebarConnected'
import { HelpProvider } from '@/components/help/HelpProvider'
import { LOCAL_ORIGIN_ID, originRegistry } from '@/lib/origin-store'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  originRegistry.destroyAll()
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }
  root = null
  container.remove()
  originRegistry.destroyAll()
})

function manager(agentId: string, profileId: string): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    profileId,
    sessionLabel: agentId,
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function profile(profileId: string): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: `${profileId}--main`,
    defaultModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'high',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function renderConnectedSidebar(overrides: { onDeleteManager?: (managerId: string) => void } = {}): void {
  const store = originRegistry.createOrigin({
    originId: LOCAL_ORIGIN_ID,
    wsUrl: 'ws://local.test',
    offline: true,
  })
  store.ingest({
    type: 'snapshot',
    state: {
      agents: [manager('profile-a--main', 'profile-a')],
      profiles: [profile('profile-a')],
      statuses: {},
      unreadCounts: {},
      connected: true,
    },
  })

  root = createRoot(container)
  flushSync(() => {
    root?.render(
      createElement(
        HelpProvider,
        null,
        createElement(AgentSidebarConnected, {
          wsUrl: 'ws://local.test',
          selectedAgentId: 'remote-session',
          activeOriginId: 'remote-a',
          localTreeReadOnly: true,
          isSettingsActive: false,
          onAddManager: vi.fn(),
          onSelectAgent: vi.fn(),
          onDeleteAgent: vi.fn(),
          onDeleteManager: overrides.onDeleteManager ?? vi.fn(),
          onOpenSettings: vi.fn(),
          onCreateSession: vi.fn(),
          onRenameSession: vi.fn(),
          onForkSession: vi.fn(),
          onUpdateSessionModel: vi.fn(),
        }),
      ),
    )
  })
}

describe('AgentSidebarConnected', () => {
  it('routes the local profile Delete Manager context-menu action while a remote origin is active', () => {
    const onDeleteManager = vi.fn()
    renderConnectedSidebar({ onDeleteManager })

    const profileButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('profile-a') && !button.textContent?.includes('profile-a--main'),
    )
    const trigger = profileButton?.closest('[data-slot="context-menu-trigger"]')
    expect(trigger).not.toBeNull()
    flushSync(() => {
      trigger!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
    })

    const deleteItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('Delete Manager'),
    ) as HTMLElement | undefined
    expect(deleteItem).toBeDefined()
    flushSync(() => {
      deleteItem!.click()
    })

    expect(onDeleteManager).toHaveBeenCalledTimes(1)
    expect(onDeleteManager).toHaveBeenCalledWith('profile-a')
  })

  it('keeps local session context menu actions when a remote origin is active', () => {
    renderConnectedSidebar()

    const sessionButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('profile-a--main'),
    )
    const trigger = sessionButton?.closest('[data-slot="context-menu-trigger"]')
    expect(trigger).not.toBeNull()
    flushSync(() => {
      trigger!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
    })

    const text = document.body.textContent ?? ''
    expect(text).toContain('Rename')
    expect(text).toContain('Fork')
    expect(text).toContain('Override Session Model')
  })
})
