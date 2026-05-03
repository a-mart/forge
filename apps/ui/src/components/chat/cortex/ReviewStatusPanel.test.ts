/** @vitest-environment jsdom */

import { getAllByText, getByLabelText, getByRole, getByText, queryByLabelText, queryByText } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CortexReviewRunRecord } from '@forge/protocol'
import { ReviewStatusPanel } from './ReviewStatusPanel'

let container: HTMLDivElement
let root: Root | null = null
const originalFetch = globalThis.fetch

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  window.localStorage?.removeItem?.('forge-cortex-review-expanded-profiles')
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
  it('renders recent runs, opens backing sessions, and starts fresh review runs through the Cortex review API', async () => {
    const onOpenSession = vi.fn()
    const reviewRuns: CortexReviewRunRecord[] = [
      {
        runId: 'review-queued',
        trigger: 'manual' as const,
        scope: { mode: 'session', profileId: 'beta', sessionId: 'beta--s2', axes: ['memory'] },
        scopeLabel: 'beta/beta--s2 (memory)',
        requestText: 'Review session beta/beta--s2 (memory freshness)',
        requestedAt: '2026-03-16T23:02:00.000Z',
        status: 'queued',
        sessionAgentId: null,
        activeWorkerCount: 0,
        latestCloseout: null,
        queuePosition: 1,
        blockedReason: null,
        scheduleName: null,
      },
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
        queuePosition: null,
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
                  reviewExcluded: false,
                  reviewExcludedAt: null,
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
                excluded: 0,
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
          queuePosition: null,
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
          onOpenSession,
        }),
      )
    })

    await flushPromises()

    const recentRunsToggle = getByRole(container, 'button', { name: /Recent Runs/i })

    expect(recentRunsToggle.getAttribute('aria-expanded')).toBe('true')
    expect(getByText(container, 'Recent Runs')).toBeTruthy()
    expect(getByText(container, 'All sessions that need attention')).toBeTruthy()
    expect(getByText(container, 'beta/beta--s2 (memory)')).toBeTruthy()
    expect(getByText(container, 'Queued #1')).toBeTruthy()
    expect(getByText(container, '1 queued')).toBeTruthy()
    expect(getByText(container, 'Waiting in queue (#1). Starts automatically after the active review finishes.')).toBeTruthy()
    expect(getByText(container, 'Scheduled')).toBeTruthy()
    expect(getByText(container, 'reviewed, no durable updates')).toBeTruthy()
    expect(getByText(container, 'Memory drift 1')).toBeTruthy()
    expect(getByText(container, 'Feedback drift 1')).toBeTruthy()
    expect(container.textContent).toContain('0 excluded')
    expect(getByRole(container, 'button', { name: /alpha \(1\)/i }).getAttribute('aria-expanded')).toBe('false')
    expect(queryByText(container, 'alpha--s1')).toBeNull()
    expect(container.textContent).toContain('1 needs review')
    expect(container.textContent).toContain('1 need review')

    const alphaToggle = getByRole(container, 'button', { name: /alpha \(1\)/i })
    flushSync(() => {
      alphaToggle.click()
    })
    expect(alphaToggle.getAttribute('aria-expanded')).toBe('true')
    expect(getByText(container, '64 B memory')).toBeTruthy()
    expect(getByText(container, 'feedback updated')).toBeTruthy()
    expect(queryByText(container, 'Up to date')).toBeNull()

    flushSync(() => {
      recentRunsToggle.click()
    })
    expect(recentRunsToggle.getAttribute('aria-expanded')).toBe('false')
    expect(queryByText(container, 'All sessions that need attention')).toBeNull()
    expect(queryByText(container, 'beta/beta--s2 (memory)')).toBeNull()
    expect(getByText(container, '1 queued')).toBeTruthy()

    flushSync(() => {
      recentRunsToggle.click()
    })
    expect(recentRunsToggle.getAttribute('aria-expanded')).toBe('true')
    expect(getByText(container, 'All sessions that need attention')).toBeTruthy()

    const openButton = getByText(container, 'Open').closest('button') as HTMLButtonElement
    flushSync(() => {
      openButton.click()
    })
    expect(onOpenSession).toHaveBeenCalledWith('cortex--s2')

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
    expect(getByText(container, 'Running')).toBeTruthy()
    expect(getAllByText(container, 'Manual').length).toBeGreaterThan(0)
  })

  it('updates the clicked session row immediately when a review run is queued', async () => {
    const onOpenSession = vi.fn()
    const reviewRuns: CortexReviewRunRecord[] = []

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
                  deltaBytes: 120,
                  totalBytes: 240,
                  reviewedBytes: 120,
                  reviewedAt: '2026-03-03T08:00:00.000Z',
                  reviewExcluded: false,
                  reviewExcludedAt: null,
                  memoryDeltaBytes: 0,
                  memoryTotalBytes: 0,
                  memoryReviewedBytes: 0,
                  memoryReviewedAt: null,
                  feedbackDeltaBytes: 0,
                  feedbackTotalBytes: 0,
                  feedbackReviewedBytes: 0,
                  feedbackReviewedAt: null,
                  lastFeedbackAt: null,
                  feedbackTimestampDrift: false,
                  status: 'needs-review',
                },
              ],
              summary: {
                needsReview: 1,
                upToDate: 0,
                excluded: 0,
                totalBytes: 240,
                reviewedBytes: 120,
                transcriptTotalBytes: 240,
                transcriptReviewedBytes: 120,
                memoryTotalBytes: 0,
                memoryReviewedBytes: 0,
                feedbackTotalBytes: 0,
                feedbackReviewedBytes: 0,
                attentionBytes: 120,
                sessionsWithTranscriptDrift: 1,
                sessionsWithMemoryDrift: 0,
                sessionsWithFeedbackDrift: 0,
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
          runId: 'review-queued-1',
          trigger: 'manual',
          scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['transcript'] },
          scopeLabel: 'alpha/alpha--s1 (transcript)',
          requestText: 'Review session alpha/alpha--s1 (transcript freshness)',
          requestedAt: '2026-03-16T23:05:00.000Z',
          status: 'queued',
          sessionAgentId: null,
          activeWorkerCount: 0,
          latestCloseout: null,
          queuePosition: 2,
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
          onOpenSession,
        }),
      )
    })

    await flushPromises()

    const alphaToggle = getByRole(container, 'button', { name: /alpha \(1\)/i })
    flushSync(() => {
      alphaToggle.click()
    })

    expect(queryByText(container, 'Queued #2')).toBeNull()
    expect(getByLabelText(container, 'Review session alpha--s1')).toBeTruthy()

    flushSync(() => {
      ;(getByLabelText(container, 'Review session alpha--s1') as HTMLButtonElement).click()
    })

    await flushPromises()

    expect(getAllByText(container, 'Queued #2').length).toBeGreaterThanOrEqual(1)
    expect(queryByLabelText(container, 'Review session alpha--s1')).toBeNull()
    expect(getByText(container, 'Needs review')).toBeTruthy()
    expect(container.textContent).toContain('alpha--s1')
  })

  it('shows exclude/resume/reprocess controls and sends the expected API payloads', async () => {
    const onOpenSession = vi.fn()
    const reviewRuns: CortexReviewRunRecord[] = []
    const reviewRunBodies: string[] = []
    const reviewControlBodies: string[] = []

    let sessions: Array<{
      profileId: string
      sessionId: string
      deltaBytes: number
      totalBytes: number
      reviewedBytes: number
      reviewedAt: string | null
      reviewExcluded: boolean
      reviewExcludedAt: string | null
      memoryDeltaBytes: number
      memoryTotalBytes: number
      memoryReviewedBytes: number
      memoryReviewedAt: string | null
      feedbackDeltaBytes: number
      feedbackTotalBytes: number
      feedbackReviewedBytes: number
      feedbackReviewedAt: string | null
      lastFeedbackAt: string | null
      feedbackTimestampDrift: boolean
      status: 'never-reviewed' | 'needs-review' | 'up-to-date'
    }> = [
      {
        profileId: 'alpha',
        sessionId: 'alpha--s1',
        deltaBytes: 120,
        totalBytes: 240,
        reviewedBytes: 120,
        reviewedAt: '2026-03-03T08:00:00.000Z',
        reviewExcluded: false,
        reviewExcludedAt: null,
        memoryDeltaBytes: 0,
        memoryTotalBytes: 0,
        memoryReviewedBytes: 0,
        memoryReviewedAt: null,
        feedbackDeltaBytes: 0,
        feedbackTotalBytes: 0,
        feedbackReviewedBytes: 0,
        feedbackReviewedAt: null,
        lastFeedbackAt: null,
        feedbackTimestampDrift: false,
        status: 'needs-review' as const,
      },
      {
        profileId: 'alpha',
        sessionId: 'alpha--s2',
        deltaBytes: 50,
        totalBytes: 50,
        reviewedBytes: 0,
        reviewedAt: null,
        reviewExcluded: true,
        reviewExcludedAt: '2026-03-04T11:00:00.000Z',
        memoryDeltaBytes: 0,
        memoryTotalBytes: 0,
        memoryReviewedBytes: 0,
        memoryReviewedAt: null,
        feedbackDeltaBytes: 0,
        feedbackTotalBytes: 0,
        feedbackReviewedBytes: 0,
        feedbackReviewedAt: null,
        lastFeedbackAt: null,
        feedbackTimestampDrift: false,
        status: 'never-reviewed' as const,
      },
      {
        profileId: 'beta',
        sessionId: 'beta--s1',
        deltaBytes: 30,
        totalBytes: 90,
        reviewedBytes: 60,
        reviewedAt: '2026-03-03T09:00:00.000Z',
        reviewExcluded: false,
        reviewExcludedAt: null,
        memoryDeltaBytes: 0,
        memoryTotalBytes: 20,
        memoryReviewedBytes: 20,
        memoryReviewedAt: '2026-03-03T09:05:00.000Z',
        feedbackDeltaBytes: 0,
        feedbackTotalBytes: 0,
        feedbackReviewedBytes: 0,
        feedbackReviewedAt: null,
        lastFeedbackAt: null,
        feedbackTimestampDrift: false,
        status: 'needs-review' as const,
      },
      {
        profileId: 'gamma',
        sessionId: 'gamma--s1',
        deltaBytes: 0,
        totalBytes: 90,
        reviewedBytes: 90,
        reviewedAt: '2026-03-03T09:00:00.000Z',
        reviewExcluded: false,
        reviewExcludedAt: null,
        memoryDeltaBytes: 0,
        memoryTotalBytes: 20,
        memoryReviewedBytes: 20,
        memoryReviewedAt: '2026-03-03T09:05:00.000Z',
        feedbackDeltaBytes: 0,
        feedbackTotalBytes: 0,
        feedbackReviewedBytes: 0,
        feedbackReviewedAt: null,
        lastFeedbackAt: null,
        feedbackTimestampDrift: false,
        status: 'up-to-date' as const,
      },
    ]

    const buildScanPayload = () => {
      const summary = sessions.reduce(
        (acc, session) => {
          if (session.reviewExcluded) {
            acc.excluded += 1
          } else if (session.status === 'up-to-date') {
            acc.upToDate += 1
          } else {
            acc.needsReview += 1
          }
          return acc
        },
        {
          needsReview: 0,
          upToDate: 0,
          excluded: 0,
          totalBytes: 0,
          reviewedBytes: 0,
          transcriptTotalBytes: 0,
          transcriptReviewedBytes: 0,
          memoryTotalBytes: 0,
          memoryReviewedBytes: 0,
          feedbackTotalBytes: 0,
          feedbackReviewedBytes: 0,
          attentionBytes: 0,
          sessionsWithTranscriptDrift: 0,
          sessionsWithMemoryDrift: 0,
          sessionsWithFeedbackDrift: 0,
        },
      )

      return { scan: { sessions, summary } }
    }

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url.endsWith('/api/cortex/scan')) {
        return {
          ok: true,
          json: async () => buildScanPayload(),
        } as Response
      }

      if (url.endsWith('/api/cortex/review-runs') && method === 'GET') {
        return {
          ok: true,
          json: async () => ({ runs: reviewRuns }),
        } as Response
      }

      if (url.endsWith('/api/cortex/review-controls') && method === 'POST') {
        const body = String(init?.body ?? '')
        reviewControlBodies.push(body)
        const payload = JSON.parse(body) as { sessionId: string; action: 'exclude' | 'resume' }
        sessions = sessions.map((session) =>
          session.sessionId !== payload.sessionId
            ? session
            : {
                ...session,
                reviewExcluded: payload.action === 'exclude',
                reviewExcludedAt: payload.action === 'exclude' ? '2026-03-05T12:00:00.000Z' : null,
              },
        )
        return {
          ok: true,
          json: async () => ({ ok: true }),
        } as Response
      }

      if (url.endsWith('/api/cortex/review-runs') && method === 'POST') {
        const body = String(init?.body ?? '')
        reviewRunBodies.push(body)
        const run: CortexReviewRunRecord = {
          runId: `review-${reviewRunBodies.length}`,
          trigger: 'manual',
          scope: { mode: 'session', profileId: 'beta', sessionId: 'beta--s1' },
          scopeLabel: 'beta/beta--s1',
          requestText: 'Review session beta/beta--s1',
          requestedAt: '2026-03-16T23:05:00.000Z',
          status: 'running',
          sessionAgentId: 'cortex--s9',
          activeWorkerCount: 0,
          latestCloseout: null,
          queuePosition: null,
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
          onOpenSession,
        }),
      )
    })

    await flushPromises()

    flushSync(() => {
      getByRole(container, 'button', { name: /alpha \(2\)/i }).click()
      getByRole(container, 'button', { name: /beta \(1\)/i }).click()
      getByRole(container, 'button', { name: /gamma \(1\)/i }).click()
    })

    expect(container.textContent).toContain('2 need review')
    expect(container.textContent).toContain('1 excluded')
    expect(getByLabelText(container, 'Exclude session alpha--s1 from review')).toBeTruthy()
    expect(getByLabelText(container, 'Exclude session beta--s1 from review')).toBeTruthy()
    expect(getByLabelText(container, 'Resume review for session alpha--s2')).toBeTruthy()
    expect(getByLabelText(container, 'Reprocess session gamma--s1')).toBeTruthy()

    flushSync(() => {
      ;(getByLabelText(container, 'Exclude session alpha--s1 from review') as HTMLButtonElement).click()
    })
    await flushPromises()

    expect(reviewControlBodies[0]).toBe(JSON.stringify({ profileId: 'alpha', sessionId: 'alpha--s1', action: 'exclude' }))
    expect(container.textContent).toContain('2 excluded')

    flushSync(() => {
      ;(getByLabelText(container, 'Exclude session beta--s1 from review') as HTMLButtonElement).click()
    })
    await flushPromises()

    expect(reviewControlBodies[1]).toBe(JSON.stringify({ profileId: 'beta', sessionId: 'beta--s1', action: 'exclude' }))
    expect(container.textContent).toContain('3 excluded')

    flushSync(() => {
      ;(getByLabelText(container, 'Resume review for session alpha--s2') as HTMLButtonElement).click()
    })
    await flushPromises()

    expect(reviewControlBodies[2]).toBe(JSON.stringify({ profileId: 'alpha', sessionId: 'alpha--s2', action: 'resume' }))
    expect(container.textContent).toContain('2 excluded')

    flushSync(() => {
      ;(getByLabelText(container, 'Reprocess session gamma--s1') as HTMLButtonElement).click()
    })
    await flushPromises()

    expect(reviewRunBodies[0]).toBe(JSON.stringify({ scope: { mode: 'session', profileId: 'gamma', sessionId: 'gamma--s1' } }))
  })

  it('treats internal-only transcript growth as non-actionable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/cortex/scan')) {
        return { ok: true, json: async () => ({ scan: { sessions: [{
          profileId: 'alpha', sessionId: 'alpha--internal', deltaBytes: 128, totalBytes: 228, reviewedBytes: 100,
          reviewedAt: '2026-03-03T08:00:00.000Z', sliceStartBytes: 100,
          reviewableTranscriptDeltaBytes: 0, reviewableTranscriptTotalBytes: 0, reviewableTranscriptReviewedBytes: 0,
          ignoredInternalTranscriptDeltaBytes: 128, unknownTranscriptDeltaBytes: 0, malformedTranscriptDeltaBytes: 0,
          transcriptCompacted: false, reviewExcluded: false, reviewExcludedAt: null,
          memoryDeltaBytes: 0, memoryTotalBytes: 0, memoryReviewedBytes: 0, memoryReviewedAt: null,
          feedbackDeltaBytes: 0, feedbackTotalBytes: 0, feedbackReviewedBytes: 0, feedbackReviewedAt: null,
          lastFeedbackAt: null, feedbackTimestampDrift: false, status: 'up-to-date' as const,
        }], summary: {
          needsReview: 0, upToDate: 1, excluded: 0, totalBytes: 228, reviewedBytes: 100,
          transcriptTotalBytes: 228, transcriptReviewedBytes: 100, reviewableTranscriptTotalBytes: 0,
          reviewableTranscriptReviewedBytes: 0, reviewableTranscriptDeltaBytes: 0, ignoredInternalTranscriptDeltaBytes: 128,
          unknownTranscriptDeltaBytes: 0, malformedTranscriptDeltaBytes: 0, memoryTotalBytes: 0, memoryReviewedBytes: 0,
          feedbackTotalBytes: 0, feedbackReviewedBytes: 0, attentionBytes: 0, sessionsWithTranscriptDrift: 0,
          sessionsWithMemoryDrift: 0, sessionsWithFeedbackDrift: 0,
        } } }) } as Response
      }
      if (url.endsWith('/api/cortex/review-runs')) return { ok: true, json: async () => ({ runs: [] }) } as Response
      throw new Error(`Unexpected fetch: ${url}`)
    })
    globalThis.fetch = fetchMock as typeof fetch

    root = createRoot(container)
    flushSync(() => root?.render(createElement(ReviewStatusPanel, { wsUrl: 'ws://127.0.0.1:47187', onOpenSession: vi.fn() })))
    await flushPromises()

    flushSync(() => getByRole(container, 'button', { name: /alpha \(1\)/i }).click())
    expect(container.textContent).toContain('0 need review')
    expect(getByText(container, 'Up to date')).toBeTruthy()
    expect(getByText(container, '128 B internal runtime entries ignored')).toBeTruthy()
    expect(queryByLabelText(container, 'Review session alpha--internal')).toBeNull()
    expect(queryByLabelText(container, 'Exclude session alpha--internal from review')).toBeNull()
  })

  it('sorts recent terminal runs by recency and collapses linked interrupted predecessors', async () => {
    const runs: CortexReviewRunRecord[] = [
      { runId: 'review-old-interrupted', trigger: 'manual', scope: { mode: 'all' }, scopeLabel: 'Old interrupted', requestText: 'Review all sessions that need attention', requestedAt: '2026-03-01T00:00:00.000Z', status: 'interrupted', sessionAgentId: 'cortex--old', activeWorkerCount: 0, latestCloseout: null, interruptedAt: '2026-03-01T00:01:00.000Z', interruptionReason: null, successorRunId: 'review-requeued', queuePosition: null, blockedReason: null, scheduleName: null },
      { runId: 'review-new-completed', trigger: 'manual', scope: { mode: 'all' }, scopeLabel: 'New completed', requestText: 'Review all sessions that need attention', requestedAt: '2026-03-02T00:00:00.000Z', status: 'completed', sessionAgentId: 'cortex--new', activeWorkerCount: 0, latestCloseout: 'done', queuePosition: null, blockedReason: null, scheduleName: null },
      { runId: 'review-requeued', trigger: 'manual', scope: { mode: 'all' }, scopeLabel: 'Requeued successor', requestText: 'Review all sessions that need attention', requestedAt: '2026-03-01T00:02:00.000Z', status: 'completed', sessionAgentId: 'cortex--successor', activeWorkerCount: 0, latestCloseout: 'requeued done', predecessorRunId: 'review-old-interrupted', queuePosition: null, blockedReason: null, scheduleName: null },
      { runId: 'review-session-created', trigger: 'manual', scope: { mode: 'all' }, scopeLabel: 'Reserved run', requestText: 'Review all sessions that need attention', requestedAt: '2026-03-03T00:00:00.000Z', status: 'queued', dispatchState: 'session_created', sessionAgentId: 'cortex--reserved', activeWorkerCount: 0, latestCloseout: null, queuePosition: null, blockedReason: null, scheduleName: null },
    ]
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/cortex/scan')) return { ok: true, json: async () => ({ scan: { sessions: [], summary: { needsReview: 0, upToDate: 0, excluded: 0, totalBytes: 0, reviewedBytes: 0, transcriptTotalBytes: 0, transcriptReviewedBytes: 0, memoryTotalBytes: 0, memoryReviewedBytes: 0, feedbackTotalBytes: 0, feedbackReviewedBytes: 0, attentionBytes: 0, sessionsWithTranscriptDrift: 0, sessionsWithMemoryDrift: 0, sessionsWithFeedbackDrift: 0 } } }) } as Response
      if (url.endsWith('/api/cortex/review-runs')) return { ok: true, json: async () => ({ runs }) } as Response
      throw new Error(`Unexpected fetch: ${url}`)
    })
    globalThis.fetch = fetchMock as typeof fetch

    root = createRoot(container)
    flushSync(() => root?.render(createElement(ReviewStatusPanel, { wsUrl: 'ws://127.0.0.1:47187', onOpenSession: vi.fn() })))
    await flushPromises()

    expect(container.textContent).toContain('Session created; request dispatch will resume automatically.')
    expect(container.textContent).toContain('New completed')
    expect(container.textContent).toContain('Requeued successor')
    expect(container.textContent).not.toContain('Old interrupted')
    expect(container.textContent).toContain('Requeued after interrupted run old-inte')
    expect(container.textContent!.indexOf('New completed')).toBeLessThan(container.textContent!.indexOf('Requeued successor'))
  })

})
