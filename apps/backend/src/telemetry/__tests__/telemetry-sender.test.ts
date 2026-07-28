import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendTelemetryPayload } from '../telemetry-sender.js'

const payload = { schema_version: 1, report_id: 'report-1' } as never

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('sendTelemetryPayload', () => {
  it.each([
    [200, true],
    [201, true],
    [400, false],
    [413, false],
  ])('returns %s response success=%s without unnecessary retries', async (status, expected) => {
    const fetch = vi.fn(async () => new Response(null, { status }))
    vi.stubGlobal('fetch', fetch)
    await expect(sendTelemetryPayload(payload)).resolves.toBe(expected)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retries retryable 5xx responses with linear backoff and succeeds', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    const result = sendTelemetryPayload(payload)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(result).resolves.toBe(true)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('retries thrown fetch failures and returns false after the retry budget', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockRejectedValue(new TypeError('network down'))
    vi.stubGlobal('fetch', fetch)
    const result = sendTelemetryPayload(payload)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(result).resolves.toBe(false)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
