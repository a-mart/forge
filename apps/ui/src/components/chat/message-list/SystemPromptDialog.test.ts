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
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('SystemPromptDialog', () => {
  it('renders one readable prompt flow with provenance labels and formatted tools', async () => {
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
          systemPrompt: [
            'Base manager instructions.',
            '<project_context>',
            'Project-specific instructions and guidelines:',
            '<project_instructions path="/repo/AGENTS.md">',
            'Repository guidance.',
            '</project_instructions>',
            '<project_instructions path="/profile/memory.md">',
            'Remembered preference.',
            '</project_instructions>',
            '</project_context>',
            'The following skills provide specialized instructions for specific tasks.',
            '<available_skills>',
            '<skill><name>review &amp; verify</name><description>Review &lt;changes&gt; safely.</description><location>/skills/review/SKILL.md</location></skill>',
            '</available_skills>',
            'Current date: 2026-01-01\nCurrent working directory: /repo',
          ].join('\n\n'),
          messages: [{ role: 'user', content: [{ type: 'text', text: 'raw-only user message' }] }],
          tools: [{
            name: 'read',
            description: 'Read a file from disk.',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Absolute file path.' },
                offset: { type: 'number', description: 'First line to read.' },
              },
              required: ['path'],
            },
          }],
          model: { provider: 'openai-codex', id: 'gpt-5.4', api: 'openai-codex-responses' },
          requestMetadata: { reasoning: 'high', maxTokens: 128000 },
        },
        tokenUsage: {
          source: 'provider_reported',
          inputTokens: 1_234,
          uncachedInputTokens: 234,
          cacheReadInputTokens: 1_000,
          cacheWriteInputTokens: 0,
        },
      },
    })

    renderDialog()
    await flushFetch()

    expect(document.body.textContent).toContain('Initial Model Input')
    expect(container.querySelector('[aria-label="Initial model input tokens"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="System prompt token estimate"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="System instructions token estimate"]')).not.toBeNull()
    expect(container.querySelector('[aria-label$="skill token estimate"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="read tool token estimate"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Tools token estimate"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Provider-reported input')
    expect(document.body.textContent).toContain('1.2k tokens')
    expect(document.body.textContent).toContain('Estimated breakdown')
    expect(document.body.textContent).toContain('Total comes from the actual first response')
    expect(document.body.textContent).toContain('System prompt')
    expect(document.body.textContent).toContain('System instructions')
    expect(document.body.textContent).toContain('Project instructions')
    expect(document.body.textContent).toContain('/repo/AGENTS.md')
    expect(document.body.textContent).toContain('Memory')
    expect(document.body.textContent).toContain('/profile/memory.md')
    expect(document.body.textContent).toContain('Skills')
    expect(document.body.textContent).toContain('1 skill')
    expect(document.body.textContent).toContain('review & verify')
    expect(document.body.textContent).toContain('Review <changes> safely.')
    expect(document.body.textContent).toContain('/skills/review/SKILL.md')
    expect(document.body.textContent).not.toContain('<skill>')
    expect(document.body.textContent).not.toContain('<name>')
    expect(document.body.textContent).toContain('Runtime')
    expect(document.body.textContent).toContain('Tools sent to the model')
    expect(document.body.textContent).toContain('Read a file from disk.')
    expect(document.body.textContent).toContain('Absolute file path.')
    expect(document.body.textContent).toContain('required')
    expect(document.body.textContent).not.toContain('Converted messages')
    expect(document.body.textContent).not.toContain('Safe request metadata')
    expect(document.body.textContent).not.toContain('raw-only user message')
    expect(container.querySelectorAll('.overflow-y-auto')).toHaveLength(1)
    expect(container.querySelector('.overflow-auto')).toBeNull()
  })

  it('keeps malformed skill markup out of Prompt view', async () => {
    apiMocks.fetchAgentSystemPrompt.mockResolvedValue(initialInputResponse(
      'agent-1',
      [
        'Skill guidance.',
        '<available_skills>',
        '<skill><name>missing-location</name></skill>',
        '</available_skills>',
      ].join('\n'),
    ))

    renderDialog()
    await flushFetch()

    expect(document.body.textContent).toContain('One skill entry could not be formatted')
    expect(document.body.textContent).toContain('Open Raw JSON')
    expect(document.body.textContent).toContain('Rough input estimate')
    expect(document.body.textContent).toContain('Provider usage is unavailable')
    expect(document.body.textContent).not.toContain('<skill>')
    expect(document.body.textContent).not.toContain('missing-location')
  })

  it('preserves custom prompt text and does not infer recovery context from an arbitrary path', async () => {
    const baseResponse = initialInputResponse('agent-1', 'unused')
    apiMocks.fetchAgentSystemPrompt.mockResolvedValue({
      ...baseResponse,
      initialModelInput: {
        ...baseResponse.initialModelInput,
        capture: {
          ...baseResponse.initialModelInput.capture,
          systemPrompt: [
            'Project-specific instructions and guidelines:',
            'Current date: user-authored value',
            '<project_context>',
            'Project-specific instructions and guidelines:',
            '<project_instructions path="/repo/recovery-service/AGENTS.md">',
            'Recovery service project guidance.',
            '</project_instructions>',
            '</project_context>',
          ].join('\n'),
          tools: [null, 'legacy-tool-shape'],
        },
      },
    })

    renderDialog()
    await flushFetch()

    expect(document.body.textContent).toContain('Project-specific instructions and guidelines:')
    expect(document.body.textContent).toContain('Current date: user-authored value')
    expect(document.body.textContent).toContain('/repo/recovery-service/AGENTS.md')
    expect(document.body.textContent).toContain('Project instructions')
    expect(document.body.textContent).not.toContain('Recovery context')
    expect(document.body.textContent).toContain('Tool 1')
    expect(document.body.textContent).toContain('Tool 2')
  })

  it('shows the complete capture only after switching to Raw JSON', async () => {
    const baseResponse = initialInputResponse('agent-1', 'Readable system prompt')
    const response = {
      ...baseResponse,
      initialModelInput: {
        ...baseResponse.initialModelInput,
        capture: {
          ...baseResponse.initialModelInput.capture,
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'raw-only user message' }] },
          ],
          requestMetadata: { maxTokens: 128000 },
        },
      },
    }
    apiMocks.fetchAgentSystemPrompt.mockResolvedValue(response)

    renderDialog()
    await flushFetch()
    await flushFetch()
    expect(document.body.textContent).not.toContain('raw-only user message')

    const promptCopyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Copy system prompt"]')
    expect(promptCopyButton).not.toBeNull()
    flushSync(() => {
      promptCopyButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushFetch()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Readable system prompt')
    expect(container.querySelector('.text-emerald-600')).not.toBeNull()

    const rawButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Raw JSON')
    const scrollContainer = container.querySelector<HTMLElement>('.overflow-y-auto')
    expect(rawButton).toBeDefined()
    expect(scrollContainer).not.toBeNull()
    scrollContainer!.scrollTop = 500
    flushSync(() => {
      rawButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(scrollContainer!.scrollTop).toBe(0)
    expect(container.querySelector('.text-emerald-600')).toBeNull()
    expect(document.body.textContent).toContain('Raw JSON')
    expect(container.querySelector('[aria-label="Initial model input tokens"]')).not.toBeNull()
    expect(document.body.textContent).toContain('raw-only user message')
    expect(document.body.textContent).toContain('maxTokens')
    expect(document.body.textContent).not.toContain('Tools sent to the model')
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
