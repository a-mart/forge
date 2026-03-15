import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCortexScan, scanCortexReviewStatus } from '../swarm/scripts/cortex-scan.js'

async function writeMeta(
  dataDir: string,
  profileId: string,
  sessionId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const metaDir = join(dataDir, 'profiles', profileId, 'sessions', sessionId)
  await mkdir(metaDir, { recursive: true })
  await writeFile(join(metaDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
}

describe('cortex-scan script', () => {
  it('returns structured review status with summary totals', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cortex-scan-test-'))

    await writeMeta(dataDir, 'alpha', 'alpha--s1', {
      profileId: 'alpha',
      sessionId: 'alpha--s1',
      stats: { sessionFileSize: '1000' },
      cortexReviewedBytes: 200,
      cortexReviewedAt: '2026-03-01T10:00:00.000Z',
    })

    await writeMeta(dataDir, 'beta', 'beta--s1', {
      profileId: 'beta',
      sessionId: 'beta--s1',
      stats: { sessionFileSize: '500' },
      cortexReviewedBytes: 500,
      cortexReviewedAt: '2026-03-01T11:00:00.000Z',
    })

    await writeMeta(dataDir, 'cortex', 'cortex--s1', {
      profileId: 'cortex',
      sessionId: 'cortex--s1',
      stats: { sessionFileSize: '9999' },
      cortexReviewedBytes: 0,
    })

    const result = await scanCortexReviewStatus(dataDir)

    expect(result.sessions).toEqual([
      {
        profileId: 'alpha',
        sessionId: 'alpha--s1',
        deltaBytes: 800,
        totalBytes: 1000,
        reviewedBytes: 200,
        reviewedAt: '2026-03-01T10:00:00.000Z',
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
      {
        profileId: 'beta',
        sessionId: 'beta--s1',
        deltaBytes: 0,
        totalBytes: 500,
        reviewedBytes: 500,
        reviewedAt: '2026-03-01T11:00:00.000Z',
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
        status: 'up-to-date',
      },
    ])

    expect(result.summary).toEqual({
      needsReview: 1,
      upToDate: 1,
      totalBytes: 1500,
      reviewedBytes: 700,
      transcriptTotalBytes: 1500,
      transcriptReviewedBytes: 700,
      memoryTotalBytes: 0,
      memoryReviewedBytes: 0,
      feedbackTotalBytes: 0,
      feedbackReviewedBytes: 0,
      attentionBytes: 800,
      sessionsWithTranscriptDrift: 1,
      sessionsWithMemoryDrift: 0,
      sessionsWithFeedbackDrift: 0,
    })
  })

  it('flags compacted sessions for re-review and marks missing review fields as never reviewed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cortex-scan-test-'))

    await writeMeta(dataDir, 'project-a', 'project-a--s1', {
      profileId: 'project-a',
      sessionId: 'project-a--s1',
      stats: { sessionFileSize: '1200' },
    })

    await writeMeta(dataDir, 'project-b', 'project-b--s1', {
      profileId: 'project-b',
      sessionId: 'project-b--s1',
      stats: { sessionFileSize: '300' },
      cortexReviewedBytes: 500,
      cortexReviewedAt: '2026-03-02T09:00:00.000Z',
    })

    const output = await runCortexScan(dataDir)

    expect(output).toContain('Sessions needing attention:')

    const neverReviewedIndex = output.indexOf('project-a/project-a--s1: 1,200 new bytes (never reviewed)')
    const compactedIndex = output.indexOf(
      'project-b/project-b--s1: needs re-review (compacted: reviewed 500 > current 300; last reviewed: 2026-03-02)',
    )

    expect(neverReviewedIndex).toBeGreaterThanOrEqual(0)
    expect(compactedIndex).toBeGreaterThanOrEqual(0)
    expect(neverReviewedIndex).toBeLessThan(compactedIndex)
    expect(output).toContain('Summary: 2 sessions need review, 0 up to date')
  })

  it('includes session-memory freshness signals in scan results and output', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cortex-scan-test-'))

    await writeMeta(dataDir, 'alpha', 'alpha--s1', {
      profileId: 'alpha',
      sessionId: 'alpha--s1',
      stats: { sessionFileSize: '100', memoryFileSize: '80' },
      cortexReviewedBytes: 100,
      cortexReviewedAt: '2026-03-01T12:00:00.000Z',
      cortexReviewedMemoryBytes: 50,
      cortexReviewedMemoryAt: '2026-03-01T12:30:00.000Z',
    })

    const result = await scanCortexReviewStatus(dataDir)

    expect(result.sessions).toEqual([
      {
        profileId: 'alpha',
        sessionId: 'alpha--s1',
        deltaBytes: 0,
        totalBytes: 100,
        reviewedBytes: 100,
        reviewedAt: '2026-03-01T12:00:00.000Z',
        memoryDeltaBytes: 30,
        memoryTotalBytes: 80,
        memoryReviewedBytes: 50,
        memoryReviewedAt: '2026-03-01T12:30:00.000Z',
        feedbackDeltaBytes: 0,
        feedbackTotalBytes: 0,
        feedbackReviewedBytes: 0,
        feedbackReviewedAt: null,
        lastFeedbackAt: null,
        feedbackTimestampDrift: false,
        status: 'needs-review',
      },
    ])

    const output = await runCortexScan(dataDir)
    expect(output).toContain('30 new memory bytes')
  })

  it('formats memory compaction as a re-review reason', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cortex-scan-test-'))

    await writeMeta(dataDir, 'alpha', 'alpha--s1', {
      profileId: 'alpha',
      sessionId: 'alpha--s1',
      stats: { sessionFileSize: '100', memoryFileSize: '40' },
      cortexReviewedBytes: 100,
      cortexReviewedAt: '2026-03-01T12:00:00.000Z',
      cortexReviewedMemoryBytes: 70,
      cortexReviewedMemoryAt: '2026-03-01T12:30:00.000Z',
    })

    const result = await scanCortexReviewStatus(dataDir)
    expect(result.sessions[0]?.memoryDeltaBytes).toBe(-30)
    expect(result.sessions[0]?.status).toBe('needs-review')

    const output = await runCortexScan(dataDir)
    expect(output).toContain('memory compacted (reviewed 70 > current 40)')
  })

  it('treats missing memory review fields as a no-drift baseline for back-compat', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cortex-scan-test-'))

    await writeMeta(dataDir, 'gamma', 'gamma--s1', {
      profileId: 'gamma',
      sessionId: 'gamma--s1',
      stats: { sessionFileSize: '100', memoryFileSize: '42' },
      cortexReviewedBytes: 100,
      cortexReviewedAt: '2026-03-02T12:00:00.000Z',
    })

    const result = await scanCortexReviewStatus(dataDir)

    expect(result.sessions[0]?.memoryDeltaBytes).toBe(0)
    expect(result.sessions[0]?.memoryReviewedBytes).toBe(42)
    expect(result.sessions[0]?.status).toBe('up-to-date')
  })

  it('includes feedback review watermarks and feedback delta bytes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cortex-scan-test-'))

    await writeMeta(dataDir, 'alpha', 'alpha--s1', {
      profileId: 'alpha',
      sessionId: 'alpha--s1',
      stats: { sessionFileSize: '100' },
      cortexReviewedBytes: 100,
      cortexReviewedAt: '2026-03-01T12:00:00.000Z',
      feedbackFileSize: '55',
      cortexReviewedFeedbackBytes: 20,
      cortexReviewedFeedbackAt: '2026-03-01T12:30:00.000Z',
      lastFeedbackAt: '2026-03-02T00:00:00.000Z',
    })

    const result = await scanCortexReviewStatus(dataDir)

    expect(result.sessions).toEqual([
      {
        profileId: 'alpha',
        sessionId: 'alpha--s1',
        deltaBytes: 0,
        totalBytes: 100,
        reviewedBytes: 100,
        reviewedAt: '2026-03-01T12:00:00.000Z',
        memoryDeltaBytes: 0,
        memoryTotalBytes: 0,
        memoryReviewedBytes: 0,
        memoryReviewedAt: null,
        feedbackDeltaBytes: 35,
        feedbackTotalBytes: 55,
        feedbackReviewedBytes: 20,
        feedbackReviewedAt: '2026-03-01T12:30:00.000Z',
        lastFeedbackAt: '2026-03-02T00:00:00.000Z',
        feedbackTimestampDrift: true,
        status: 'needs-review',
      },
    ])
  })

  it('marks feedback timestamp drift as needs-review even when feedback bytes are unchanged', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cortex-scan-test-'))

    await writeMeta(dataDir, 'gamma', 'gamma--s1', {
      profileId: 'gamma',
      sessionId: 'gamma--s1',
      stats: { sessionFileSize: '100' },
      cortexReviewedBytes: 100,
      cortexReviewedAt: '2026-03-02T12:00:00.000Z',
      feedbackFileSize: '42',
      cortexReviewedFeedbackBytes: 42,
      cortexReviewedFeedbackAt: '2026-03-01T12:00:00.000Z',
      lastFeedbackAt: '2026-03-03T12:00:00.000Z',
    })

    const result = await scanCortexReviewStatus(dataDir)

    expect(result.sessions[0]?.status).toBe('needs-review')
    expect(result.sessions[0]?.feedbackDeltaBytes).toBe(0)
    expect(result.sessions[0]?.feedbackTimestampDrift).toBe(true)

    const output = await runCortexScan(dataDir)
    expect(output).toContain('feedback updated since last feedback review')
  })

  it('treats malformed feedbackReviewedAt timestamps as review-needed when byte deltas are zero', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cortex-scan-test-'))

    await writeMeta(dataDir, 'delta', 'delta--s1', {
      profileId: 'delta',
      sessionId: 'delta--s1',
      stats: { sessionFileSize: '10' },
      cortexReviewedBytes: 10,
      cortexReviewedAt: '2026-03-01T00:00:00.000Z',
      feedbackFileSize: '3',
      cortexReviewedFeedbackBytes: 3,
      cortexReviewedFeedbackAt: 'not-an-iso-timestamp',
      lastFeedbackAt: '2026-03-03T00:00:00.000Z',
    })

    const result = await scanCortexReviewStatus(dataDir)

    expect(result.sessions[0]?.feedbackTimestampDrift).toBe(true)
    expect(result.sessions[0]?.status).toBe('needs-review')
  })

  it('treats malformed lastFeedbackAt timestamps as review-needed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cortex-scan-test-'))

    await writeMeta(dataDir, 'epsilon', 'epsilon--s1', {
      profileId: 'epsilon',
      sessionId: 'epsilon--s1',
      stats: { sessionFileSize: '10' },
      cortexReviewedBytes: 10,
      cortexReviewedAt: '2026-03-01T00:00:00.000Z',
      feedbackFileSize: '3',
      cortexReviewedFeedbackBytes: 3,
      cortexReviewedFeedbackAt: '2026-03-02T00:00:00.000Z',
      lastFeedbackAt: 'not-an-iso-timestamp',
    })

    const result = await scanCortexReviewStatus(dataDir)

    expect(result.sessions[0]?.feedbackTimestampDrift).toBe(true)
    expect(result.sessions[0]?.status).toBe('needs-review')
  })
})
