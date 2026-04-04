import { describe, expect, it } from 'vitest'
import { toContextWindowUsage } from './use-context-window'

describe('toContextWindowUsage', () => {
  it('rejects implausibly large persisted context usage values', () => {
    expect(
      toContextWindowUsage({
        tokens: 10_649_236,
        contextWindow: 200_000,
        percent: 100,
      }),
    ).toBeNull()
  })

  it('keeps normal context usage values', () => {
    expect(
      toContextWindowUsage({
        tokens: 17_448,
        contextWindow: 200_000,
        percent: 8.724,
      }),
    ).toEqual({
      usedTokens: 17_448,
      contextWindow: 200_000,
    })
  })
})
