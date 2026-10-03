import type { AssistantMessage } from '../swarm/pi/pi-ai-compat.js'
import { describe, expect, it } from 'vitest'
import {
  extractMergedMemoryText,
  stripWrappingCodeFence,
} from '../swarm/prompts/memory-merge.js'

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
  it('extracts assistant text and strips outer code fences', () => {
    const extracted = extractMergedMemoryText(createAssistantMessage('```markdown\n# Swarm Memory\n- merged\n```'))

    expect(stripWrappingCodeFence(extracted)).toBe('# Swarm Memory\n- merged')
  })
})
