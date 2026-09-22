import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExpoPushClient } from '../mobile/expo-push-client.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function tokenFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-expo-push-'))
  tempDirs.push(dir)
  const path = join(dir, 'token')
  writeFileSync(path, contents, { mode: 0o400 })
  return path
}

describe('ExpoPushClient access token', () => {
  it('authenticates both send and receipt calls when a token file is configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ status: 'ok', id: 'ticket-1' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { 'ticket-1': { status: 'ok' } } }), { status: 200 }))
    const client = new ExpoPushClient({ fetchImpl, accessTokenFile: tokenFile('test-only-token\n') })

    await client.send({ to: 'ExpoPushToken[test-device]', title: 'Test', body: 'Test' })
    await client.getReceipts(['ticket-1'])

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-only-token' })
    }
  })

  it('retains unauthenticated sending when no token file is configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ status: 'ok', id: 'ticket-1' }] }), { status: 200 }),
    )
    const client = new ExpoPushClient({ fetchImpl })

    await client.send({ to: 'ExpoPushToken[test-device]', title: 'Test', body: 'Test' })

    expect(fetchImpl.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization')
  })

  it('rejects a configured but invalid token before sending', () => {
    expect(() => new ExpoPushClient({ accessTokenFile: 'relative/token' })).toThrow('absolute path')
    expect(() => new ExpoPushClient({ accessTokenFile: tokenFile('bad token') })).toThrow('invalid')
    expect(() => new ExpoPushClient({ accessTokenFile: tokenFile('') })).toThrow('nonempty regular file')
  })
})
