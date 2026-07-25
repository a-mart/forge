import { describe, expect, it } from 'vitest'
import { ConversationSnapshotCache } from './conversation-snapshot-cache'

const fixtureSeed = 'session-switch-cache-200x1280-v1'
const payload = `${fixtureSeed}:${'x'.repeat(1_250)}`
const rows = (agentId: string) => Array.from({ length: 200 }, (_, index) => ({
  type: 'conversation_message' as const,
  agentId,
  id: `${agentId}-${index}`,
  role: 'assistant' as const,
  text: `${index}:${payload}`,
  timestamp: new Date(1_700_000_000_000 + index).toISOString(),
  source: 'speak_to_user' as const,
}))

describe('session switch snapshot cache synthetic lookup microbenchmark', () => {
  it('measures deterministic warm A↔B cache lookup without claiming browser paint timing', () => {
    const cache = new ConversationSnapshotCache()
    for (const agentId of ['a', 'b']) {
      expect(cache.capture({
        originId: 'benchmark', agentId, servedView: 'web', profileId: 'profile',
        messages: rows(agentId), activityMessages: [], conversationPage: null,
      })).toBe(true)
    }

    const samples: number[] = []
    let wrongKeyCount = 0
    let falseEmptyCount = 0
    for (let index = 0; index < 60; index += 1) {
      const agentId = index % 2 === 0 ? 'a' : 'b'
      const started = performance.now()
      const hit = cache.get({ originId: 'benchmark', agentId, servedView: 'web' })
      const elapsed = performance.now() - started
      if (index >= 10) samples.push(elapsed)
      if (!hit?.messages.length) falseEmptyCount += 1
      if (hit?.agentId !== agentId || hit.messages.some((row) => row.agentId !== agentId)) wrongKeyCount += 1
    }
    samples.sort((left, right) => left - right)
    const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0
    const rawSummary = {
      fixtureSeed,
      fixtureRows: 200,
      fixtureApproxBytes: new TextEncoder().encode(JSON.stringify(rows('a'))).byteLength,
      warmups: 10,
      switches: 50,
      cacheLookupMs: { p50, p95 },
      limitation: 'Node-only cache lookup; does not measure React commit or browser stale-paint timing.',
      wrongKeyCount,
      falseEmptyCount,
      cacheEntries: cache.size,
      cacheEstimatedBytes: cache.totalEstimatedBytes,
      runtime: `${process.platform}/${process.version}`,
    }
    console.info('[session-switch-cache-synthetic-lookup-benchmark]', JSON.stringify(rawSummary))
    expect(rawSummary.fixtureApproxBytes).toBeGreaterThan(240_000)
    expect(p95).toBeLessThan(100)
    expect(wrongKeyCount).toBe(0)
    expect(falseEmptyCount).toBe(0)
    expect(cache.size).toBeLessThanOrEqual(24)
    expect(cache.totalEstimatedBytes).toBeLessThanOrEqual(16 * 1024 * 1024)
  })
})
