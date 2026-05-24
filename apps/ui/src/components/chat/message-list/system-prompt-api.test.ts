/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

vi.mock('@/lib/api-endpoint', () => ({
  resolveApiEndpoint: (_wsUrl: string | undefined, path: string) => path,
}))

const { fetchAgentSystemPrompt } = await import('./system-prompt-api')

describe('fetchAgentSystemPrompt', () => {
  let fetchSpy: MockInstance

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('surfaces backend JSON error messages', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Repository project-agent source docs changed while active runtime is busy.' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(fetchAgentSystemPrompt('ws://127.0.0.1:47187', 'agent-1')).rejects.toThrow(
      'Repository project-agent source docs changed while active runtime is busy.',
    )
  })

  it('falls back to status when failed response has no readable message', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 500 }))

    await expect(fetchAgentSystemPrompt(undefined, 'agent-1')).rejects.toThrow(
      'Failed to fetch system prompt: 500',
    )
  })
})
