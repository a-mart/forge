import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openSessionManagerWithSizeGuard } from '../swarm/session-file-guard.js'

function buildSessionFileContent(extraPayload: string): string {
  return [
    JSON.stringify({
      type: 'session',
      id: 'session-id',
      version: 3,
      timestamp: new Date().toISOString(),
      cwd: '/tmp',
    }),
    JSON.stringify({
      type: 'custom',
      customType: 'swarm_conversation_entry',
      data: {
        type: 'conversation_message',
        agentId: 'manager',
        role: 'user',
        text: extraPayload,
        timestamp: new Date().toISOString(),
        source: 'user_input',
      },
      id: 'entry-1',
      parentId: null,
      timestamp: new Date().toISOString(),
    }),
    '',
  ].join('\n')
}

describe('openSessionManagerWithSizeGuard', () => {
  it('skips opening oversized files when rotation is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-file-guard-'))
    const sessionFile = join(root, 'manager.jsonl')
    await writeFile(sessionFile, buildSessionFileContent('payload-' + 'x'.repeat(128)), 'utf8')

    const sessionManager = openSessionManagerWithSizeGuard(sessionFile, {
      maxSizeBytes: 64,
      rotateOversizedFile: false,
      logWarning: () => {},
    })

    expect(sessionManager).toBeUndefined()

    const content = await readFile(sessionFile, 'utf8')
    expect(content).toContain('"type":"session"')
  })

  it('rotates oversized files and opens a fresh file when rotation is enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-file-guard-'))
    const sessionFile = join(root, 'manager.jsonl')
    await writeFile(sessionFile, buildSessionFileContent('payload-' + 'y'.repeat(128)), 'utf8')

    const sessionManager = openSessionManagerWithSizeGuard(sessionFile, {
      maxSizeBytes: 64,
      rotateOversizedFile: true,
      logWarning: () => {},
    })

    expect(sessionManager).toBeDefined()

    const activeStats = await stat(sessionFile)
    expect(activeStats.size).toBeGreaterThan(0)

    const files = await readdir(root)
    expect(files.some((name) => name.startsWith('manager.jsonl.oversize-') && name.endsWith('.bak'))).toBe(true)
  })
})
