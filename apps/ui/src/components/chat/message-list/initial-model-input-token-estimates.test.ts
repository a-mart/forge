import { describe, expect, it } from 'vitest'
import {
  estimateInitialModelInputTokens,
  estimateJsonTokens,
  estimateTextTokens,
} from './initial-model-input-token-estimates'

describe('initial model input token estimates', () => {
  it('uses the repository-wide four-characters-per-token heuristic', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens('   ')).toBe(0)
    expect(estimateTextTokens('1234')).toBe(1)
    expect(estimateTextTokens('12345')).toBe(2)
    expect(estimateJsonTokens(['abcd'])).toBe(2)
  })

  it('sums the prompt, messages, and tools while leaving empty categories at zero', () => {
    expect(estimateInitialModelInputTokens({
      systemPrompt: '12345',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    })).toEqual({
      total: 11,
      systemPrompt: 2,
      messages: 9,
      tools: 0,
    })
  })
})
