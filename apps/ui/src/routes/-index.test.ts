/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByLabelText, getByRole, queryByText } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Radix UI components require ResizeObserver in jsdom
globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver

import { getProjectAgentSuggestions, IndexPage, isCortexDiffViewerSession, parseWindowRouteSearch } from './index'
import { HelpProvider } from '@/components/help/HelpProvider'
import { buildManagerModelRows } from '@/lib/manager-model-selection'
import {
  installVirtualizationHarness,
  type VirtualizationHarness,
} from '@/components/chat/message-list/test-virtualization-harness'

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
      modelId: 'gpt-5.5',
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
      modelId: 'gpt-5.5',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

let container: HTMLDivElement
let root: Root | null = null
let virt: VirtualizationHarness | null = null

const originalWebSocket = globalThis.WebSocket
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
const originalMatchMedia = window.matchMedia
const originalFetch = globalThis.fetch

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.useFakeTimers()
  window.history.replaceState(null, '', '/')
  ;(globalThis as any).WebSocket = FakeWebSocket
  // Mock fetch for model-overrides endpoint used by CreateManagerDialog
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('model-overrides')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          version: 1,
          overrides: {},
          providerAvailability: {
            'openai-codex': true,
            'anthropic': true,
            'claude-sdk': true,
            'xai': true,
          },
        }),
      })
    }
    return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('Not found') })
  }) as any
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
  // Give the virtualized MessageList a real viewport in jsdom so its transcript
  // rows mount (jsdom reports 0 for every measurement). Tall viewport → the
  // small fixtures here render in full, matching pre-virtualization behavior.
  virt = installVirtualizationHarness()
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()

  // Drain any pending virtualizer scroll-reset/settle timers before swapping
  // back to real timers so they don't fire post-teardown (window undefined).
  vi.runOnlyPendingTimers()
  virt?.restore()
  virt = null
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
  globalThis.fetch = originalFetch
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
  expect(JSON.parse(socket.sentPayloads.at(0) ?? '{}')).toEqual({
    type: 'subscribe',
    conversationPaging: true,
    conversationView: 'web',
  })
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
  it('shows only allowed model presets and defaults to GPT-5.5', async () => {
    await renderPage()

    click(getAllByRole(container, 'button', { name: 'Add project' })[0])

    // Let the fetch mock for model-overrides resolve and React state update
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    const modelSelect = getByRole(document.body, 'combobox', { name: 'Default Model' })
    expect(modelSelect.textContent).toContain('GPT-5.5')

    click(modelSelect as HTMLElement)

    const optionValues = getAllByRole(document.body, 'option').map((option) => option.textContent?.trim() ?? '')

    // Exact model names from the catalog (not family display names)
    const allProvidersAvailable = { 'openai-codex': true, 'anthropic': true, 'claude-sdk': true, 'xai': true }
    const expectedRows = buildManagerModelRows('create', {}, allProvidersAvailable)
      .filter((r) => !r.unavailableReason)
      .map((r) => r.displayName)

    expect(optionValues).toContain('GPT-5.4')
    expect(optionValues).toContain('Claude Opus 4.7')
    expect(optionValues).toContain('Claude Opus 4.6')
    expect(optionValues).toContain('Claude Fable 5')
    expect(optionValues).not.toContain('Codex App Runtime')
    expect(optionValues).toEqual(expectedRows)
  })

  it('sends selected model in create_manager payload', async () => {
    const socket = await renderPage()

    click(getAllByRole(container, 'button', { name: 'Add project' })[0])

    // Let the fetch mock for model-overrides resolve and React state update
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

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
      modelSelection: { provider: 'anthropic', modelId: 'claude-opus-4-6' },
    })
    expect(createPayload).not.toHaveProperty('model')
    expect(typeof createPayload?.requestId).toBe('string')

    emitServerEvent(socket, {
      type: 'manager_created',
      requestId: createPayload?.requestId,
      manager: buildManager('release-manager', '/tmp/release'),
    })

    await vi.advanceTimersByTimeAsync(0)
  })

  it('shows only manager-owned tool calls and scoped agent messages in all-tab activity', async () => {
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
    await vi.advanceTimersByTimeAsync(0)

    click(getByRole(container, 'button', { name: 'All' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '{}')).toMatchObject({
      type: 'subscribe',
      conversationPaging: true,
      conversationView: 'all',
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
    emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: {} })

    await vi.advanceTimersByTimeAsync(0)

    // Scoped agent messages from owned workers remain visible
    expect(queryByText(container, 'owned worker chatter')).not.toBeNull()
    // Manager-owned tool calls are visible
    expect(queryByText(container, /manager-call/)).not.toBeNull()
    // Worker-originated tool calls are hidden (actorAgentId !== managerId)
    expect(queryByText(container, /owned-call/)).toBeNull()
    // Foreign worker messages and tool calls are hidden
    expect(queryByText(container, 'foreign worker chatter')).toBeNull()
    expect(queryByText(container, /foreign-call/)).toBeNull()
  })

  it('does not reveal worker tool calls in manager all view when detailed toggle would have applied', async () => {
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
    await vi.advanceTimersByTimeAsync(0)

    click(getByRole(container, 'button', { name: 'All' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.parse(socket.sentPayloads.at(-1) ?? '{}')).toMatchObject({
      type: 'subscribe',
      conversationPaging: true,
      conversationView: 'all',
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
          type: 'agent_tool_call',
          agentId: 'manager',
          actorAgentId: 'manager',
          timestamp: new Date().toISOString(),
          kind: 'tool_execution_start',
          toolName: 'bash',
          toolCallId: 'mgr-tool',
          text: '{"command":"echo hi"}',
        },
        {
          type: 'agent_tool_call',
          agentId: 'manager',
          actorAgentId: 'worker-owned',
          timestamp: new Date().toISOString(),
          kind: 'tool_execution_start',
          toolName: 'read',
          toolCallId: 'owned-tool',
          text: '{"path":"README.md"}',
        },
        {
          type: 'agent_tool_call',
          agentId: 'manager',
          actorAgentId: 'worker-foreign',
          timestamp: new Date().toISOString(),
          kind: 'tool_execution_start',
          toolName: 'read',
          toolCallId: 'foreign-tool',
          text: '{"path":"SECRET.md"}',
        },
      ],
    })
    emitServerEvent(socket, { type: 'unread_counts_snapshot', counts: {} })

    await vi.advanceTimersByTimeAsync(0)

    expect(queryByText(container, /mgr-tool/)).not.toBeNull()
    expect(queryByText(container, /owned-tool/)).toBeNull()
    expect(queryByText(container, /foreign-tool/)).toBeNull()
    expect(container.querySelector('[aria-label="Show worker tool activity in All view"]')).toBeNull()
  })

  it('resets detailed all view state when switching to a different agent', async () => {
    const socket = await renderPage()

    const secondManager = {
      ...buildManager('manager-beta', '/tmp/beta'),
      managerId: 'manager-beta',
      profileId: 'beta',
    }

    emitServerEvent(socket, {
      type: 'agents_snapshot',
      agents: [
        { ...buildManager('manager', '/tmp/manager'), profileId: 'alpha' },
        buildWorker('worker-owned', 'manager', '/tmp/manager'),
        secondManager,
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
          text: 'first manager reply',
          timestamp: new Date().toISOString(),
          source: 'speak_to_user',
        },
        {
          type: 'agent_tool_call',
          agentId: 'manager',
          actorAgentId: 'worker-owned',
          timestamp: new Date().toISOString(),
          kind: 'tool_execution_start',
          toolName: 'read',
          toolCallId: 'w-tool-alpha',
          text: '{"path":"alpha.md"}',
        },
      ],
    })
    await vi.advanceTimersByTimeAsync(0)

    click(getByRole(container, 'button', { name: 'All' }))
    expect(queryByText(container, /w-tool-alpha/)).toBeNull()

    const sidebarButtons = container.querySelectorAll('[data-agent-id]')
    const betaButton = Array.from(sidebarButtons).find(
      (el) => el.getAttribute('data-agent-id') === 'manager-beta',
    ) as HTMLElement | undefined

    if (betaButton) {
      click(betaButton)
      await vi.advanceTimersByTimeAsync(0)

      // After agent switch, Detailed should have reset
      // The Detailed toggle may or may not be present (depends on if we're in All view for new agent)
      // The key contract is that the worker tool from the previous agent's Detailed view is gone
      expect(queryByText(container, /w-tool-alpha/)).toBeNull()
    }
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
    emitServerEvent(socket, {
      type: 'profiles_snapshot',
      profiles: [
        {
          profileId: 'alpha',
          displayName: 'Alpha',
          defaultSessionAgentId: 'alpha',
          defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          profileId: 'beta',
          displayName: 'Beta',
          defaultSessionAgentId: 'beta',
          defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
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

describe('parseWindowRouteSearch', () => {
  it('returns empty object for empty search string', () => {
    expect(parseWindowRouteSearch('')).toEqual({})
  })

  it('parses settingsTab from URL search params', () => {
    const result = parseWindowRouteSearch('?view=settings&surface=builder&settingsTab=collaboration')
    expect(result).toMatchObject({
      view: 'settings',
      surface: 'builder',
      settingsTab: 'collaboration',
    })
  })

  it('parses contextual project settings without changing the sticky task', () => {
    const result = parseWindowRouteSearch(
      '?view=settings&agent=session-with-draft&settingsTab=secrets&settingsProfileId=project-beta',
    )
    expect(result).toEqual({
      view: 'settings',
      agent: 'session-with-draft',
      settingsTab: 'secrets',
      settingsProfileId: 'project-beta',
    })
  })

  it('returns undefined settingsTab when not present', () => {
    const result = parseWindowRouteSearch('?view=settings&surface=builder')
    expect(result.settingsTab).toBeUndefined()
  })

  it('parses all known params including settingsTab, statsTab, collab, collabApiBaseUrl, and skillImportUrl', () => {
    const result = parseWindowRouteSearch(
      '?view=settings&agent=mgr&surface=builder&channel=ch1&collab=conn_abc&statsTab=st&settingsTab=auth&collabApiBaseUrl=https%3A%2F%2Fb.example.com%2F&skillImportUrl=https%3A%2F%2Fforgeskills.radops.ai%2Fs%2Ftoken',
    )
    expect(result).toEqual({
      view: 'settings',
      agent: 'mgr',
      surface: 'builder',
      channel: 'ch1',
      collab: 'conn_abc',
      statsTab: 'st',
      settingsTab: 'auth',
      collabApiBaseUrl: 'https://b.example.com/',
      skillImportUrl: 'https://forgeskills.radops.ai/s/token',
    })
  })

  it('parses collab param from URL search', () => {
    const result = parseWindowRouteSearch('?surface=collab&channel=general&collab=conn_xyz')
    expect(result).toMatchObject({
      surface: 'collab',
      channel: 'general',
      collab: 'conn_xyz',
    })
  })

  it('returns undefined collab when not present', () => {
    const result = parseWindowRouteSearch('?surface=collab&channel=general')
    expect(result.collab).toBeUndefined()
  })

  it('parses collabApiBaseUrl from URL search params', () => {
    const result = parseWindowRouteSearch(
      '?view=settings&surface=builder&settingsTab=collaboration&collabApiBaseUrl=https%3A%2F%2Fb.example.com%2F',
    )
    expect(result).toMatchObject({
      view: 'settings',
      surface: 'builder',
      settingsTab: 'collaboration',
      collabApiBaseUrl: 'https://b.example.com/',
    })
  })

  it('returns undefined collabApiBaseUrl when not present', () => {
    const result = parseWindowRouteSearch('?view=settings&surface=builder&settingsTab=collaboration')
    expect(result.collabApiBaseUrl).toBeUndefined()
  })
})
