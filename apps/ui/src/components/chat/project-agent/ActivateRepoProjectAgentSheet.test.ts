/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivateRepoProjectAgentSheet } from './ActivateRepoProjectAgentSheet'

const activationMock = vi.hoisted(() => ({
  handleActivate: vi.fn(),
  activatingId: null as string | null,
  activateError: null as string | null,
}))

vi.mock('@/components/settings/repo-project-agent-ui-utils', async () => {
  const actual = await vi.importActual<typeof import('@/components/settings/repo-project-agent-ui-utils')>('@/components/settings/repo-project-agent-ui-utils')
  return {
    ...actual,
    useRepoProjectAgentActivation: () => activationMock,
  }
})

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  activationMock.handleActivate.mockReset()
  activationMock.activatingId = null
  activationMock.activateError = null
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
})

describe('ActivateRepoProjectAgentSheet', () => {
  it('renders activation panel content and wires activate button', () => {
    const onClose = vi.fn()
    const item = {
      definitionId: 'def-docs',
      handle: 'docs',
      path: '/repo/.forge/project-agents/def-docs',
      status: 'valid' as const,
      problems: [],
      whenToUse: 'Documentation help',
      displayName: 'Docs Agent',
    }

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(ActivateRepoProjectAgentSheet, {
        wsUrl: 'ws://127.0.0.1:47187',
        profileId: 'profile-a',
        sessionAgentId: 'session-a',
        item,
        onClose,
      }))
    })

    expect(document.body.textContent).toContain('Activate this repository project agent definition')
    expect(document.body.textContent).toContain('@docs')
    const activateButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent?.includes('Activate'))
    expect(activateButton).toBeTruthy()
    activateButton?.click()
    expect(activationMock.handleActivate).toHaveBeenCalledWith(item)
  })
})
