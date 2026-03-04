import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCortexScan } from '../swarm/scripts/cortex-scan.js'

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
  it('lists sessions by descending delta, skips cortex sessions, and reports unchanged sessions', async () => {
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

    const output = await runCortexScan(dataDir)

    expect(output).toContain('alpha/alpha--s1: 800 new bytes (last reviewed: 2026-03-01)')
    expect(output).toContain('beta/beta--s1: no new content')
    expect(output).not.toContain('cortex/cortex--s1')
    expect(output).toContain('Summary: 1 sessions need review, 1 up to date')
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
    const compactedIndex = output.indexOf('project-b/project-b--s1: needs re-review (compacted: reviewed 500 > current 300; last reviewed: 2026-03-02)')

    expect(neverReviewedIndex).toBeGreaterThanOrEqual(0)
    expect(compactedIndex).toBeGreaterThanOrEqual(0)
    expect(neverReviewedIndex).toBeLessThan(compactedIndex)
    expect(output).toContain('Summary: 2 sessions need review, 0 up to date')
  })
})
