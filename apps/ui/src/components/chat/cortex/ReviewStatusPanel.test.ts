/** @vitest-environment jsdom */

import { getByLabelText, getByText, queryByText } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CortexReviewRunRecord } from '@middleman/protocol'
import { ReviewStatusPanel } from './ReviewStatusPanel'

let container: HTMLDivElement
let root: Root | null = null
const originalFetch = globalThis.fetch

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
})

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync(() => {})
}

describe('ReviewStatusPanel', () => {
  it('renders recent runs and starts fresh review runs through the Cortex review API', async () => {
    const reviewRuns: CortexReviewRunRecord[] = [
      {
        runId: 'review-1',
        trigger: 'scheduled' as const,
        scope: { mode: 'all' as const },
        scopeLabel: 'All sessions that need attention',
        requestText: 'Review all sessions that need attention',
        requestedAt: '2026-03-16T23:00:00.000Z',
        status: 'completed',
        sessionAgentId: 'cortex--s2',
        activeWorkerCount: 0,
        latestCloseout: 'reviewed, no durable updates',
        blockedReason: null,
        scheduleName: 'Nightly review',
      },
    ]

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url.endsWith('/api/cortex/scan')) {
        return {
          ok: true,
          json: async () => ({
            scan: {
              sessions: [
                {
                  profileId: 'alpha',
                  sessionId: 'alpha--s1',
                  deltaBytes: 0,
                  totalBytes: 100,
                  reviewedBytes: 100,
                  reviewedAt: '2026-03-01T10:00:00.000Z',
                  memoryDeltaBytes: 64,
                  memoryTotalBytes: 128,
                  memoryReviewedBytes: 64,
                  memoryReviewedAt: '2026-03-01T10:30:00.000Z',
                  feedbackDeltaBytes: 0,
                  feedbackTotalBytes: 10,
                  feedbackReviewedBytes: 10,
                  feedbackReviewedAt: '2026-03-01T11:00:00.000Z',
                  lastFeedbackAt: '2026-03-02T11:00:00.000Z',
                  feedbackTimestampDrift: true,
                  status: 'needs-review',
                },
              ],
              summary: {
                needsReview: 1,
                upToDate: 0,
                totalBytes: 100,
                reviewedBytes: 100,
                transcriptTotalBytes: 100,
                transcriptReviewedBytes: 100,
                memoryTotalBytes: 128,
                memoryReviewedBytes: 64,
                feedbackTotalBytes: 10,
                feedbackReviewedBytes: 10,
                attentionBytes: 64,
                sessionsWithTranscriptDrift: 0,
                sessionsWithMemoryDrift: 1,
                sessionsWithFeedbackDrift: 1,
              },
            },
          }),
        } as Response
      }

      if (url.endsWith('/api/cortex/review-runs') && method === 'GET') {
        return {
          ok: true,
          json: async () => ({ runs: reviewRuns }),
        } as Response
      }

      if (url.endsWith('/api/cortex/review-runs') && method === 'POST') {
        const run: CortexReviewRunRecord = {
          runId: 'review-2',
          trigger: 'manual',
          scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory', 'feedback'] },
          scopeLabel: 'alpha/alpha--s1 (memory, feedback)',
          requestText: 'Review session alpha/alpha--s1 (memory, feedback freshness)',
          requestedAt: '2026-03-16T23:05:00.000Z',
          status: 'running',
          sessionAgentId: 'cortex--s3',
          activeWorkerCount: 0,
          latestCloseout: null,
          blockedReason: null,
          scheduleName: null,
        }
        reviewRuns.unshift(run)

        return {
          ok: true,
          json: async () => ({ run }),
        } as Response
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`)
    })

    globalThis.fetch = fetchMock as typeof fetch

    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(ReviewStatusPanel, {
          wsUrl: 'ws://127.0.0.1:47187',
          onOpenSession: vi.fn(),
        }),
      )
    })

    await flushPromises()

    expect(getByText(container, 'Recent Runs')).toBeTruthy()
    expect(getByText(container, 'All sessions that need attention')).toBeTruthy()
    expect(getByText(container, 'Scheduled')).toBeTruthy()
    expect(getByText(container, 'reviewed, no durable updates')).toBeTruthy()
    expect(getByText(container, '64 B memory')).toBeTruthy()
    expect(getByText(container, 'feedback updated')).toBeTruthy()
    expect(getByText(container, 'Memory drift 1')).toBeTruthy()
    expect(getByText(container, 'Feedback drift 1')).toBeTruthy()
    expect(queryByText(container, 'Up to date')).toBeNull()

    const reviewButton = getByLabelText(container, 'Review session alpha--s1')
    flushSync(() => {
      ;(reviewButton as HTMLButtonElement).click()
    })

    await flushPromises()

    const postCall = fetchMock.mock.calls.find((call) => {
      const url = String(call[0])
      const method = (call[1] as RequestInit | undefined)?.method ?? 'GET'
      return url.endsWith('/api/cortex/review-runs') && method === 'POST'
    })

    expect(postCall).toBeTruthy()
    expect((postCall?.[1] as RequestInit).body).toBe(
      JSON.stringify({
        scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory', 'feedback'] },
      }),
    )
    expect(getByText(container, 'alpha/alpha--s1 (memory, feedback)')).toBeTruthy()
    expect(getByText(container, 'Manual')).toBeTruthy()
  })
})
