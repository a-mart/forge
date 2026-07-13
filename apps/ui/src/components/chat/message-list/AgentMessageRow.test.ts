/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentMessageEvent } from '@forge/protocol'
import { AgentMessageRow } from './AgentMessageRow'

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

function renderMessage(message: AgentMessageEvent) {
  flushSync(() => {
    root.render(createElement(AgentMessageRow, {
      message,
      activeAgentId: 'manager',
      fromDisplayName: message.fromAgentId === 'manager' ? 'Manager' : 'Documentation',
      toDisplayName: message.toAgentId === 'manager' ? 'Manager' : 'Documentation',
      projectAgentExchange: true,
    }))
  })
}

describe('AgentMessageRow project-agent exchanges', () => {
  it('uses distinct blue tones and opposing alignment for each direction', () => {
    renderMessage({
      type: 'agent_message',
      agentId: 'manager',
      timestamp: '2026-07-13T20:00:53.824Z',
      source: 'agent_to_agent',
      fromAgentId: 'manager',
      toAgentId: 'documentation',
      text: 'Check whether the docs need an update.',
      projectAgentExchange: true,
    })

    const outgoing = container.querySelector('[data-project-agent-direction="outgoing"]')
    expect(outgoing?.getAttribute('data-project-agent-tone')).toBe('blue')
    expect(outgoing?.firstElementChild?.className).toContain('bg-blue-600')
    expect(outgoing?.firstElementChild?.className).not.toContain('bg-sky-50')
    expect(outgoing?.textContent).toContain('Manager → Documentation')

    renderMessage({
      type: 'agent_message',
      agentId: 'manager',
      timestamp: '2026-07-13T20:01:06.965Z',
      source: 'agent_to_agent',
      fromAgentId: 'documentation',
      toAgentId: 'manager',
      text: 'I am checking the relevant help now.',
      projectAgentExchange: true,
    })

    const incoming = container.querySelector('[data-project-agent-direction="incoming"]')
    expect(incoming?.getAttribute('data-project-agent-tone')).toBe('sky')
    expect(incoming?.firstElementChild?.className).toContain('bg-sky-50')
    expect(incoming?.firstElementChild?.className).not.toContain('bg-blue-600')
    expect(incoming?.textContent).toContain('Documentation → Manager')
  })
})
