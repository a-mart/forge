import { afterEach, describe, expect, it, vi } from 'vitest'
import { SIDEBAR_BOOTSTRAP_METRIC } from '../../../../stats/sidebar-perf-metrics.js'
import {
  P0HttpRouteFakeSwarmManager as FakeSwarmManager,
  createP0HttpRouteManagerDescriptor as createManagerDescriptor,
  createP0HttpRoutePerfStub as createPerfStub,
  makeP0HttpRouteTempConfig as makeTempConfig,
  parseP0HttpRouteJsonResponse as parseJsonResponse,
} from '../../../../test-support/ws-integration-harness.js'
import { SwarmWebSocketServer } from '../../../server.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SwarmWebSocketServer P0 endpoints', () => {
  it('exposes sidebar perf metrics via /api/debug/sidebar-perf', async () => {
    const config = await makeTempConfig({ managerId: 'manager' })
    const manager = new FakeSwarmManager(
      config,
      [createManagerDescriptor(config.paths.rootDir, 'manager')],
      {
        perf: createPerfStub({
          readSummary: () => ({
            histograms: {
              [SIDEBAR_BOOTSTRAP_METRIC]: {
                count: 3,
                mean: 42,
                p50: 40,
                p95: 64,
                max: 64,
                min: 20,
                lastSample: {
                  timestamp: '2026-04-17T00:00:00.000Z',
                  labels: { buildMode: 'dev' },
                  durationMs: 64,
                },
              },
            },
            counters: {},
          }),
          readRecentSlowEvents: () => [
            {
              type: 'perf_slow_event',
              surface: 'backend',
              metric: SIDEBAR_BOOTSTRAP_METRIC,
              timestamp: '2026-04-17T00:00:00.000Z',
              durationMs: 900,
              thresholdMs: 750,
              labels: { buildMode: 'dev' },
              fields: { agentId: 'manager' },
            },
          ],
          readRecentSamples: () => ({
            histograms: {
              [SIDEBAR_BOOTSTRAP_METRIC]: [
                {
                  timestamp: '2026-04-17T00:00:00.000Z',
                  labels: { buildMode: 'dev' },
                  durationMs: 20,
                },
                {
                  timestamp: '2026-04-17T00:00:01.000Z',
                  labels: { buildMode: 'dev' },
                  durationMs: 40,
                },
                {
                  timestamp: '2026-04-17T00:00:02.000Z',
                  labels: { buildMode: 'dev' },
                  durationMs: 64,
                },
              ],
            },
          }),
        }),
      },
    )

    const server = new SwarmWebSocketServer({
      swarmManager: manager as unknown as never,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: false,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/debug/sidebar-perf`)
      const payload = await parseJsonResponse(response)

      expect(payload.status).toBe(200)
      expect(payload.json.schemaVersion).toBe(1)
      expect(payload.json.summary).toMatchObject({
        histograms: {
          [SIDEBAR_BOOTSTRAP_METRIC]: {
            count: 3,
            mean: 42,
            p50: 40,
            p95: 64,
            max: 64,
            min: 20,
          },
        },
        counters: {},
      })
      expect(payload.json.slowEvents).toMatchObject([
        {
          metric: SIDEBAR_BOOTSTRAP_METRIC,
          durationMs: 900,
          thresholdMs: 750,
        },
      ])
      expect(payload.json.recentSamples).toMatchObject({
        histograms: {
          [SIDEBAR_BOOTSTRAP_METRIC]: [
            { durationMs: 20, labels: { buildMode: 'dev' } },
            { durationMs: 40, labels: { buildMode: 'dev' } },
            { durationMs: 64, labels: { buildMode: 'dev' } },
          ],
        },
      })
    } finally {
      await server.stop()
    }
  })
})
