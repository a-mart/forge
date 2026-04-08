import { describe, expect, it } from 'vitest'
import {
  classifyRuntimeCapacityError,
  parseRetryAfterMsFromErrorMessage,
} from '../swarm/runtime-utils.js'

describe('runtime capacity error parsing', () => {
  it('classifies quota errors and parses minute retry windows', () => {
    const result = classifyRuntimeCapacityError(
      'You have hit your ChatGPT usage limit (pro plan). Try again in ~4307 min.',
      { nowMs: Date.parse('2026-03-07T18:00:00.000Z') },
    )

    expect(result.isQuotaOrRateLimit).toBe(true)
    expect(result.retryAfterMs).toBe(4_307 * 60_000)
  })

  it('parses second and hour retry windows', () => {
    expect(parseRetryAfterMsFromErrorMessage('Rate limit exceeded. Try again in 10.3s.')).toBe(10_300)
    expect(parseRetryAfterMsFromErrorMessage('Quota reached. Retry in 2 hours.')).toBe(2 * 60 * 60 * 1_000)
  })

  it('parses absolute retry timestamps', () => {
    const nowMs = Date.parse('2026-03-07T18:00:00.000Z')
    const parsed = parseRetryAfterMsFromErrorMessage(
      'Rate limit exceeded. Please retry at <2026-03-07T18:10:30.000Z>.',
      nowMs,
    )

    expect(parsed).toBe(630_000)
  })

  it('parses retry-after header style seconds values', () => {
    expect(parseRetryAfterMsFromErrorMessage('HTTP 429. retry-after: 120')).toBe(120_000)
  })

  it('classifies Anthropic overloaded_error 529 responses as capacity errors', () => {
    const result = classifyRuntimeCapacityError('Request failed with status: 529 {"type":"overloaded_error"}')
    expect(result).toEqual({ isQuotaOrRateLimit: true })
  })

  it('does not classify unrelated mentions of 429 as quota/rate limits', () => {
    const result = classifyRuntimeCapacityError('Parser failed near line 429 in config file.')
    expect(result).toEqual({ isQuotaOrRateLimit: false })
  })

  it('does not classify unrelated runtime errors as quota/rate limits', () => {
    const result = classifyRuntimeCapacityError('Network socket disconnected before TLS handshake.')
    expect(result).toEqual({ isQuotaOrRateLimit: false })
  })
})
