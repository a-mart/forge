/** @vitest-environment jsdom */

import { getByLabelText, getByText, queryByText } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  it('renders memory and feedback freshness states as actionable review items', async () => {
    const onTriggerReview = vi.fn()

    globalThis.fetch = vi.fn().mockResolvedValue({
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
    }) as typeof fetch

    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(ReviewStatusPanel, {
          wsUrl: 'ws://127.0.0.1:47187',
          onTriggerReview,
        }),
      )
    })

    await flushPromises()

    expect(getByText(container, 'Needs review')).toBeTruthy()
    expect(getByText(container, '64 B memory')).toBeTruthy()
    expect(getByText(container, 'feedback updated')).toBeTruthy()
    expect(getByText(container, 'Memory drift 1')).toBeTruthy()
    expect(getByText(container, 'Feedback drift 1')).toBeTruthy()
    expect(queryByText(container, 'Up to date')).toBeNull()

    const reviewButton = getByLabelText(container, 'Review session alpha--s1')
    flushSync(() => {
      ;(reviewButton as HTMLButtonElement).click()
    })

    expect(onTriggerReview).toHaveBeenCalledWith('Review session alpha/alpha--s1 (memory, feedback freshness)')
  })
})
