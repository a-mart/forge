import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchStats, refreshStats } from './stats-api'

afterEach(() => vi.unstubAllGlobals())

describe('Fuck Meter stats transport', () => {
  it('preserves background counts on both initial fetch and refresh without an opt-in flag', async () => {
    const initial = { fuckMeter: { daily: [{ date: '2026-09-06', count: 3 }] } }
    const refreshed = { fuckMeter: { daily: [{ date: '2026-09-06', count: 8 }] } }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(initial)))
      .mockResolvedValueOnce(new Response(JSON.stringify(refreshed)))
    vi.stubGlobal('fetch', fetchMock)
    expect((await fetchStats('ws://localhost:47187', '7d')).fuckMeter).toEqual(initial.fuckMeter)
    expect((await refreshStats('ws://localhost:47187', '30d')).fuckMeter).toEqual(refreshed.fuckMeter)
    const first = new URL(fetchMock.mock.calls[0][0])
    const second = new URL(fetchMock.mock.calls[1][0])
    expect(first.pathname).toBe('/api/stats')
    expect(first.searchParams.get('range')).toBe('7d')
    expect(second.pathname).toBe('/api/stats/refresh')
    expect(second.searchParams.get('range')).toBe('30d')
    expect([...first.searchParams.keys()].sort()).toEqual(['range', 'tz'])
    expect(fetchMock.mock.calls[1][1]).toEqual({ method: 'POST' })
  })
})
