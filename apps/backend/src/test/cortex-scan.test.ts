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
        status: 'needs-review',
      },
      {
        profileId: 'beta',
        sessionId: 'beta--s1',
        deltaBytes: 0,
        totalBytes: 500,
        reviewedBytes: 500,
        reviewedAt: '2026-03-01T11:00:00.000Z',
        status: 'up-to-date',
      },
    ])

    expect(result.summary).toEqual({
      needsReview: 1,
      upToDate: 1,
      totalBytes: 1500,
      reviewedBytes: 700,
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

    const neverReviewedIndex = output.indexOf('project-a/project-a--s1: 1,200 new bytes (never reviewed)')
    const compactedIndex = output.indexOf(
      'project-b/project-b--s1: needs re-review (compacted: reviewed 500 > current 300; last reviewed: 2026-03-02)',
    )

    expect(neverReviewedIndex).toBeGreaterThanOrEqual(0)
    expect(compactedIndex).toBeGreaterThanOrEqual(0)
    expect(neverReviewedIndex).toBeLessThan(compactedIndex)
    expect(output).toContain('Summary: 2 sessions need review, 0 up to date')
  })
})
