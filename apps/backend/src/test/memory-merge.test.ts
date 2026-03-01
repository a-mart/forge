import type { Api, AssistantMessage, Model } from '@mariozechner/pi-ai'
import { describe, expect, it } from 'vitest'
import {
  buildMemoryMergeUserPrompt,
  executeLLMMergeWithFallback,
  extractMergedMemoryText,
  stripWrappingCodeFence,
} from '../swarm/memory-merge.js'

function createTestModel(): Model<Api> {
  return {
    id: 'test-model',
    name: 'Test Model',
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: 'https://example.com',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  }
}

function createAssistantMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'internal' },
      { type: 'text', text },
    ],
    api: 'openai-responses',
    provider: 'openai',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

describe('memory-merge', () => {
  it('builds a prompt containing labeled profile and session memory blocks', () => {
    const prompt = buildMemoryMergeUserPrompt('# Profile', '# Session')

    expect(prompt).toContain('----- BEGIN PROFILE MEMORY -----')
    expect(prompt).toContain('# Profile')
    expect(prompt).toContain('----- BEGIN SESSION MEMORY -----')
    expect(prompt).toContain('# Session')
  })

  it('extracts assistant text and strips outer code fences', () => {
    const extracted = extractMergedMemoryText(createAssistantMessage('```markdown\n# Swarm Memory\n- merged\n```'))

    expect(stripWrappingCodeFence(extracted)).toBe('# Swarm Memory\n- merged')
  })

  it('returns fallback content when the LLM call throws', async () => {
    const result = await executeLLMMergeWithFallback(createTestModel(), '# Profile', '# Session', {
      fallback: () => 'raw-append',
      completeFn: async () => {
        throw new Error('boom')
      },
    })

    expect(result.usedFallback).toBe(true)
    expect(result.mergedContent).toBe('raw-append')
    expect(result.errorMessage).toContain('boom')
  })
})
