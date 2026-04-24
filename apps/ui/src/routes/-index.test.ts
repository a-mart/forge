/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByLabelText, getByRole, queryByText } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCreateManagerFamilies } from '@forge/protocol'
import { getProjectAgentSuggestions, IndexPage, isCortexDiffViewerSession } from './index'
import { HelpProvider } from '@/components/help/HelpProvider'

const CREATE_MANAGER_FAMILIES = getCreateManagerFamilies()

type ListenerMap = Record<string, Array<(event?: any) => void>>

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly sentPayloads: string[] = []
  readonly listeners: ListenerMap = {}

  readyState = FakeWebSocket.OPEN

  constructor(_url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event?: any) => void): void {
    this.listeners[type] ??= []
    this.listeners[type].push(listener)
  }

  send(payload: string): void {
    this.sentPayloads.push(payload)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close')
  }

  emit(type: string, event?: any): void {
    const handlers = this.listeners[type] ?? []
    for (const handler of handlers) {
      handler(event)
    }
  }
}

function emitServerEvent(socket: FakeWebSocket, event: unknown): void {
  socket.emit('message', {
    data: JSON.stringify(event),
  })
}

function click(element: HTMLElement): void {
  flushSync(() => {
    element.click()
  })
}

function changeValue(element: HTMLInputElement, value: string): void {
  flushSync(() => {
    fireEvent.change(element, {
      target: { value },
    })
  })
}

function buildManager(agentId: string, cwd: string) {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager' as const,
    status: 'idle' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd,
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function buildWorker(agentId: string, managerId: string, cwd: string) {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: 'worker' as const,
    status: 'idle' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd,
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

let container: HTMLDivElement
let root: Root | null = null

const originalWebSocket = globalThis.WebSocket
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
const originalMatchMedia = window.matchMedia

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.useFakeTimers()
  window.history.replaceState(null, '', '/')
  ;(globalThis as any).WebSocket = FakeWebSocket
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  })

  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()

  vi.useRealTimers()
  ;(globalThis as any).WebSocket = originalWebSocket
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: originalScrollIntoView,
  })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  })
})

async function renderPage(): Promise<FakeWebSocket> {
  root = createRoot(container)

  flushSync(() => {
    root?.render(createElement(HelpProvider, null, createElement(IndexPage)))
  })

  await Promise.resolve()
  vi.advanceTimersByTime(60)

  const socket = FakeWebSocket.instances[0]
  expect(socket).toBeDefined()

  socket.emit('open')
  expect(JSON.parse(socket.sentPayloads.at(0) ?? '{}')).toEqual({ type: 'subscribe' })
  emitServerEvent(socket, {
    type: 'ready',
    serverTime: new Date().toISOString(),
    subscribedAgentId: 'manager',
  })

  return socket
}

describe('isCortexDiffViewerSession', () => {
  it('treats cortex review sessions as Cortex diff-viewer sessions', () => {
    expect(
      isCortexDiffViewerSession({
        ...buildManager('review-run', '/tmp/review-run'),
        sessionPurpose: 'cortex_review',
      }),
    ).toBe(true)

    expect(isCortexDiffViewerSession(buildManager('alpha', '/tmp/alpha'))).toBe(false)
  })
})

describe('IndexPage create project model selection', () => {
  it('shows only allowed model presets and defaults to GPT-5.3 Codex', async () => {
    await renderPage()

    click(getAllByRole(container, 'button', { name: 'Add project' })[0])

    const modelSelect = getByRole(document.body, 'combobox', { name: 'Default Model' })
    expect(modelSelect.textContent).toContain('GPT-5.3 Codex')

    click(modelSelect as HTMLElement)

    const optionValues = getAllByRole(document.body, 'option').map((option) => option.textContent?.trim() ?? '')
    expect(optionValues).toContain('GPT-5.4')
    expect(optionValues).not.toContain('Codex App Runtime')
    expect(optionValues).toEqual(CREATE_MANAGER_FAMILIES.map((family) => family.displayName))
  })

  it('sends selected model in create_manager payload', async () => {
    const socket = await renderPage()

    click(getAllByRole(container, 'button', { name: 'Add project' })[0])

    changeValue(getByLabelText(document.body, 'Name') as HTMLInputElement, 'release-manager')
    changeValue(getByLabelText(document.body, 'Working directory') as HTMLInputElement, '/tmp/release')

    const modelSelect = getByRole(document.body, 'combobox', { name: 'Default Model' })
    click(modelSelect as HTMLElement)
    click(getByRole(document.body, 'option', { name: 'Claude Opus 4.6' }))

    click(getByRole(document.body, 'button', { name: 'Create project' }))

    const validatePayload = JSON.parse(socket.sentPayloads.at(-1) ?? '{}')
    expect(validatePayload.type).toBe('validate_directory')
    expect(validatePayload.path).toBe('/tmp/release')

    emitServerEvent(socket, {
      type: 'directory_validated',
      requestId: validatePayload.requestId,
      path: '/tmp/release',
      valid: true,
    })

    await vi.advanceTimersByTimeAsync(0)

    const parsedPayloads = socket.sentPayloads.map((payload) => JSON.parse(payload))
    const createPayload = parsedPayloads.find((payload) => payload.type === 'create_manager')

    expect(createPayload).toMatchObject({
      type: 'create_manager',
      name: 'release-manager',
      cwd: '/tmp/release',
      model: 'pi-opus',
    })
    expect(typeof createPayload?.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'manager_created',
      requestId: createPayload?.requestId,
      manager: buildManager('release-manager', '/tmp/release'),
    })

    await vi.advanceTimersByTimeAsync(0)
  })

  it('hides worker tool calls in all-tab activity for the selected manager context', async () => {
    const socket = await renderPage()

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        buildManager('manager', '/tmp/manager'),
        buildWorker('worker-owned', 'manager', '/tmp/manager'),
        buildManager('other-manager', '/tmp/other-manager'),
        buildWorker('worker-foreign', 'other-manager', '/tmp/other-manager'),
      ],
    })

    emitServerEvent(socket, {
      type: 'conversation_history',
      agentId: 'manager',
      messages: [
        {
          type: 'conversation_message',
          agentId: 'manager',
          role: 'assistant',
          text: 'manager reply',
          timestamp: new Date().toISOString(),
          source: 'speak_to_user',
        },
        {
          type: 'agent_message',
          agentId: 'manager',
          timestamp: new Date().toISOString(),
          source: 'agent_to_agent',
          fromAgentId: 'worker-owned',
          toAgentId: 'worker-owned',
          text: 'owned worker chatter',
        },
        {
          type: 'agent_tool_call',
          agentId: 'manager',
          actorAgentId: 'manager',
          timestamp: new Date().toISOString(),
          kind: 'tool_execution_start',
          toolName: 'speak_to_user',
          toolCallId: 'manager-call',
          text: '{"text":"hello"}',
        },
        {
          type: 'agent_tool_call',
          agentId: 'manager',
          actorAgentId: 'worker-owned',
          timestamp: new Date().toISOString(),
          kind: 'tool_execution_start',
          toolName: 'read',
          toolCallId: 'owned-call',
          text: '{"path":"README.md"}',
        },
        {
          type: 'agent_message',
          agentId: 'manager',
          timestamp: new Date().toISOString(),
          source: 'agent_to_agent',
          fromAgentId: 'worker-foreign',
          toAgentId: 'worker-foreign',
          text: 'foreign worker chatter',
        },
        {
          type: 'agent_tool_call',
          agentId: 'manager',
          actorAgentId: 'worker-foreign',
          timestamp: new Date().toISOString(),
          kind: 'tool_execution_start',
          toolName: 'read',
          toolCallId: 'foreign-call',
          text: '{"path":"SECRET.md"}',
        },
      ],
    })

    await vi.advanceTimersByTimeAsync(0)

    click(getByRole(container, 'button', { name: 'All' }))

    expect(queryByText(container, 'owned worker chatter')).not.toBeNull()
    expect(queryByText(container, /manager-call/)).not.toBeNull()
    expect(queryByText(container, /owned-call/)).toBeNull()
    expect(queryByText(container, 'foreign worker chatter')).toBeNull()
    expect(queryByText(container, /foreign-call/)).toBeNull()
  })

  it('uses sessionLabel for project-agent suggestions when displayName is stale after rename', () => {
    const activeAgent = {
      ...buildManager('manager', '/tmp/manager'),
      profileId: 'manager',
      sessionLabel: 'Main Session',
    }

    const suggestions = getProjectAgentSuggestions(activeAgent, [
      activeAgent,
      {
        ...buildManager('manager--s2', '/tmp/manager'),
        managerId: 'manager--s2',
        profileId: 'manager',
        displayName: 'Old Name',
        sessionLabel: 'Renamed Session',
        projectAgent: {
          handle: 'renamed-session',
          whenToUse: 'Handle release-note drafting',
        },
      },
    ])

    expect(suggestions).toEqual([
      {
        agentId: 'manager--s2',
        handle: 'renamed-session',
        displayName: 'Renamed Session',
        whenToUse: 'Handle release-note drafting',
      },
    ])
  })

  it('keeps the root URL free of query params when the active agent is implicit', async () => {
    const socket = await renderPage()

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [buildManager('manager', '/tmp/manager')],
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(window.location.pathname).toBe('/')
    expect(window.location.search).toBe('')
  })

  it('falls back to the most recent session in the same profile when the explicit target disappears', async () => {
    window.history.replaceState(null, '', '/?agent=alpha--s3')

    const socket = await renderPage()

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        {
          ...buildManager('alpha', '/tmp/alpha'),
          profileId: 'alpha',
          sessionLabel: 'Default',
          updatedAt: '2026-01-01T00:01:00.000Z',
        },
        {
          ...buildManager('alpha--s2', '/tmp/alpha'),
          managerId: 'alpha--s2',
          profileId: 'alpha',
          sessionLabel: 'Session 2',
          updatedAt: '2026-01-01T00:02:00.000Z',
        },
        {
          ...buildManager('alpha--s3', '/tmp/alpha'),
          managerId: 'alpha--s3',
          profileId: 'alpha',
          sessionLabel: 'Session 3',
          updatedAt: '2026-01-01T00:03:00.000Z',
        },
        {
          ...buildManager('beta', '/tmp/beta'),
          profileId: 'beta',
          sessionLabel: 'Beta default',
          updatedAt: '2026-01-01T00:04:00.000Z',
        },
      ],
    })

    await vi.advanceTimersByTimeAsync(0)

    emitServerEvent(socket, {
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'alpha--s3',
    })

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        {
          ...buildManager('alpha', '/tmp/alpha'),
          profileId: 'alpha',
          sessionLabel: 'Default',
          updatedAt: '2026-01-01T00:01:00.000Z',
        },
        {
          ...buildManager('alpha--s2', '/tmp/alpha'),
          managerId: 'alpha--s2',
          profileId: 'alpha',
          sessionLabel: 'Session 2',
          updatedAt: '2026-01-01T00:05:00.000Z',
        },
        {
          ...buildManager('beta', '/tmp/beta'),
          profileId: 'beta',
          sessionLabel: 'Beta default',
          updatedAt: '2026-01-01T00:06:00.000Z',
        },
      ],
    })

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(window.location.pathname).toBe('/')
    expect(window.location.search).toBe('?agent=alpha--s2')

    const payloads = socket.sentPayloads.map((payload) => JSON.parse(payload))
    expect(
      payloads.some(
        (payload) => payload.type === 'subscribe' && payload.agentId === 'alpha--s2',
      ),
    ).toBe(true)
  })
})
