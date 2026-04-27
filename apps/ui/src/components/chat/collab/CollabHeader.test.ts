/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationChannel } from '@forge/protocol'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
  DropdownMenuItem: ({ children, onSelect, disabled, className }: { children: React.ReactNode; onSelect?: () => void; disabled?: boolean; className?: string }) =>
    createElement('button', { type: 'button', disabled, className, onClick: onSelect }, children),
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
  Tooltip: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) => createElement('div', {}, children),
}))

vi.mock('@/components/chat/collab-sidebar/UserAvatarPopover', () => ({
  UserAvatarPopover: () => createElement('div', { 'data-testid': 'user-avatar-popover' }),
}))

const { CollabHeader } = await import('./CollabHeader')

const channel: CollaborationChannel = {
  channelId: 'channel-1',
  workspaceId: 'workspace-1',
  sessionAgentId: 'session-1',
  name: 'general',
  slug: 'general',
  aiEnabled: false,
  aiRole: 'channel_assistant',
  position: 0,
  archived: false,
  lastMessageSeq: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
})

describe('CollabHeader', () => {
  it('shows View AI prompt in the header menu and calls the handler', () => {
    const onViewPrompt = vi.fn()

    flushSync(() => {
      root.render(
        createElement(CollabHeader, {
          channel,
          channelView: 'web',
          onChannelViewChange: vi.fn(),
          onViewPrompt,
        }),
      )
    })

    const button = Array.from(document.body.querySelectorAll('button')).find((element) => element.textContent?.includes('View AI prompt')) as HTMLButtonElement | undefined
    expect(button).toBeTruthy()

    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onViewPrompt).toHaveBeenCalledTimes(1)
  })
})
