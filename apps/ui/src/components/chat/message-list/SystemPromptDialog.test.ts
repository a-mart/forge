/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver

const apiMocks = vi.hoisted(() => ({
  fetchAgentSystemPrompt: vi.fn(),
}))

vi.mock('./system-prompt-api', () => ({
  fetchAgentSystemPrompt: apiMocks.fetchAgentSystemPrompt,
}))

vi.mock('@radix-ui/react-dialog', () => ({
  Content: ({ children }: { children?: unknown }) => children,
  Close: ({ children }: { children?: unknown }) => children,
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children?: unknown }) => children,
  DialogOverlay: () => null,
  DialogPortal: ({ children }: { children?: unknown }) => children,
  DialogTitle: ({ children }: { children?: unknown }) => children,
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children?: unknown }) => children,
}))

const { SystemPromptDialog } = await import('./SystemPromptDialog')

let root: Root
let container: HTMLDivElement

async function flushFetch() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function renderDialog({
  open = true,
  agentId = 'agent-1',
  agentLabel = 'Manager',
}: {
  open?: boolean
  agentId?: string
  agentLabel?: string
} = {}) {
  flushSync(() => {
    root.render(
      createElement(SystemPromptDialog, {
        open,
        onOpenChange: vi.fn(),
        agentId,
        agentLabel,
      }),
    )
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function initialInputResponse(agentId: string, systemPrompt: string) {
  return {
    agentId,
    role: 'manager' as const,
    systemPrompt: 'old preview',
    model: 'openai-codex/gpt-5.4',
    archetypeId: null,
    initialModelInput: {
      status: 'available' as const,
      capture: {
        version: 1 as const,
        runtime: 'pi' as const,
        capturedAt: '2026-01-01T00:00:00.000Z',
        fidelity: {
          capturePoint: 'pi_stream_fn' as const,
          context: 'exact_provider_independent' as const,
          images: 'byte_summary' as const,
          requestMetadata: 'safe_projection' as const,
        },
        systemPrompt,
        messages: [],
        tools: [],
        model: { provider: 'openai-codex', id: 'gpt-5.4' },
        requestMetadata: {},
      },
    },
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  apiMocks.fetchAgentSystemPrompt.mockReset()
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('SystemPromptDialog', () => {
  it('renders the captured initial Pi request, including raw context sections', async () => {
    apiMocks.fetchAgentSystemPrompt.mockResolvedValue({
      agentId: 'agent-1',
      role: 'manager',
      systemPrompt: 'old preview',
      model: 'openai-codex/gpt-5.4',
      archetypeId: null,
      initialModelInput: {
        status: 'available',
        capture: {
          version: 1,
          runtime: 'pi',
          capturedAt: '2026-01-01T00:00:00.000Z',
          fidelity: {
            capturePoint: 'pi_stream_fn',
            context: 'exact_provider_independent',
            images: 'byte_summary',
            requestMetadata: 'safe_projection',
          },
          systemPrompt: 'Final prompt with AGENTS and memory',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
          tools: [{ name: 'read', parameters: { type: 'object' } }],
          model: { provider: 'openai-codex', id: 'gpt-5.4', api: 'openai-codex-responses' },
          requestMetadata: { reasoning: 'high' },
        },
      },
    })

    renderDialog()
    await flushFetch()

    expect(document.body.textContent).toContain('Initial Model Input')
    expect(document.body.textContent).toContain('Final system prompt')
    expect(document.body.textContent).toContain('Final prompt with AGENTS and memory')
    expect(document.body.textContent).toContain('Converted messages')
    expect(document.body.textContent).toContain('Active tools and schemas')
    expect(document.body.textContent).toContain('Safe request metadata')
    expect(document.body.textContent).toContain('Raw capture')
    expect(document.body.textContent).toContain('openai-codex/gpt-5.4')
  })

  it('does not render an older agent capture when its request resolves after a newer agent', async () => {
    const first = deferred<ReturnType<typeof initialInputResponse>>()
    const second = deferred<ReturnType<typeof initialInputResponse>>()
    apiMocks.fetchAgentSystemPrompt
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)

    renderDialog({ agentId: 'agent-a', agentLabel: 'Agent A' })
    await flushFetch()
    renderDialog({ agentId: 'agent-b', agentLabel: 'Agent B' })
    await flushFetch()

    second.resolve(initialInputResponse('agent-b', 'Agent B full context'))
    await flushFetch()
    expect(document.body.textContent).toContain('Agent B full context')

    first.resolve(initialInputResponse('agent-a', 'Agent A full context'))
    await flushFetch()
    expect(document.body.textContent).toContain('Agent B full context')
    expect(document.body.textContent).not.toContain('Agent A full context')
  })

  it('invalidates an in-flight request when the dialog closes', async () => {
    const request = deferred<ReturnType<typeof initialInputResponse>>()
    apiMocks.fetchAgentSystemPrompt.mockImplementationOnce(() => request.promise)

    renderDialog({ agentId: 'agent-a', agentLabel: 'Agent A' })
    await flushFetch()
    renderDialog({ open: false, agentId: 'agent-a', agentLabel: 'Agent A' })
    await flushFetch()

    request.resolve(initialInputResponse('agent-a', 'Closed agent full context'))
    await flushFetch()
    expect(document.body.textContent).not.toContain('Closed agent full context')
  })

  it.each([
    [
      {
        status: 'pending',
        message: 'Available after the first model request.',
      },
      'Available after the first model request.',
    ],
    [
      {
        status: 'unsupported',
        message: 'Initial model-input capture is currently available for Pi runtimes only.',
      },
      'Initial model-input capture is currently available for Pi runtimes only.',
    ],
  ] as const)('renders %s availability without falling back to the stale prompt', async (initialModelInput, expectedMessage) => {
    apiMocks.fetchAgentSystemPrompt.mockResolvedValue({
      agentId: 'agent-1',
      role: 'manager',
      systemPrompt: 'stale persisted system prompt',
      model: 'provider/model',
      archetypeId: null,
      initialModelInput,
    })

    renderDialog()
    await flushFetch()

    expect(document.body.textContent).toContain(expectedMessage)
    expect(document.body.textContent).not.toContain('stale persisted system prompt')
  })
})
