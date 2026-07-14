import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanSessionTokenUsage } from '../session/session-token-usage.js'
import { getSessionFilePath, getWorkerSessionFilePath } from '../storage/data-paths.js'

describe('session token usage', () => {
  it('sums manager and parallel worker usage inside the goal window', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-usage-'))
    await writeUsageFile(getSessionFilePath(dataDir, 'profile-1', 'session-1'), [
      usageMessage('2026-07-13T09:59:59.000Z', 100, 10),
      usageMessage('2026-07-13T10:00:10.000Z', 20, 5),
    ])
    await writeUsageFile(getWorkerSessionFilePath(dataDir, 'profile-1', 'session-1', 'worker-a'), [
      usageMessage('2026-07-13T10:00:20.000Z', 30, 7),
    ])
    await writeUsageFile(getWorkerSessionFilePath(dataDir, 'profile-1', 'session-1', 'worker-b'), [
      usageMessage('2026-07-13T10:00:20.000Z', 40, 8),
      usageMessage('2026-07-13T10:01:01.000Z', 500, 50),
    ])

    await expect(scanSessionTokenUsage({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      startAt: '2026-07-13T10:00:00.000Z',
      endAt: '2026-07-13T10:01:00.000Z',
    })).resolves.toMatchObject({
      managerUsage: { input: 20, output: 5, total: 25 },
      workerUsage: { input: 70, output: 15, total: 85 },
      totalUsage: { input: 90, output: 20, total: 110 },
      missingTimestampCount: 0,
    })
  })

  it('marks coverage partial when a usage record has no timestamp', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-usage-partial-'))
    await writeUsageFile(getSessionFilePath(dataDir, 'profile-1', 'session-1'), [{
      type: 'message',
      message: { role: 'assistant', usage: { input: 1, output: 1, totalTokens: 2 } },
    }])

    const result = await scanSessionTokenUsage({
      dataDir,
      profileId: 'profile-1',
      sessionAgentId: 'session-1',
      startAt: '2026-07-13T10:00:00.000Z',
      endAt: '2026-07-13T10:01:00.000Z',
    })
    expect(result.missingTimestampCount).toBe(1)
    expect(result.totalUsage.total).toBe(0)
  })
})

function usageMessage(timestamp: string, input: number, output: number): unknown {
  return {
    type: 'message',
    timestamp,
    message: {
      role: 'assistant',
      usage: { input, output, totalTokens: input + output },
    },
  }
}

async function writeUsageFile(filePath: string, entries: unknown[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
}
