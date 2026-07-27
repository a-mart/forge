import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { loadVerifiedPayloadSelector, parsePayloadSelector, payloadResourcePath } from '../src/shell/selector.js'

const hash = 'a'.repeat(64)
const payloadFiles = { 'content-script.js': hash, 'service-worker.js': hash }

describe('versioned local payload selector', () => {
  it('binds the selected directory to shell ABI, version, and hash', () => {
    expect(parsePayloadSelector({
      schemaVersion: 1,
      shellAbi: 1,
      payloadVersion: 'm1-spike.1',
      payloadSha256: hash,
      payloadDirectory: `m1-spike.1-${hash}`,
      payloadFiles,
    })).toMatchObject({ payloadVersion: 'm1-spike.1', payloadSha256: hash })
  })

  it('resolves the service worker to the selector-bound extension-root path', () => {
    const selector = parsePayloadSelector({
      schemaVersion: 1, shellAbi: 1, payloadVersion: 'm1', payloadSha256: hash,
      payloadDirectory: `m1-${hash}`, payloadFiles,
    })
    expect(payloadResourcePath(selector, 'service-worker.js')).toBe(`payloads/m1-${hash}/service-worker.js`)
  })

  it.each([
    { schemaVersion: 1, shellAbi: 2, payloadVersion: 'm1', payloadSha256: hash, payloadDirectory: `m1-${hash}`, payloadFiles },
    { schemaVersion: 1, shellAbi: 1, payloadVersion: '../escape', payloadSha256: hash, payloadDirectory: `../escape-${hash}`, payloadFiles },
    { schemaVersion: 1, shellAbi: 1, payloadVersion: 'm1', payloadSha256: 'bad', payloadDirectory: 'm1-bad', payloadFiles },
    { schemaVersion: 1, shellAbi: 1, payloadVersion: 'm1', payloadSha256: hash, payloadDirectory: `other-${hash}`, payloadFiles },
    { schemaVersion: 1, shellAbi: 1, payloadVersion: 'm1', payloadSha256: hash, payloadDirectory: `m1-${hash}`, payloadFiles: { ...payloadFiles, 'unexpected.js': hash } },
  ])('rejects malformed or path-escaping selector %#', (selector) => {
    expect(() => parsePayloadSelector(selector)).toThrow()
  })

  it.each(['content-script.js', 'service-worker.js'])('fails closed before loading when %s is corrupt or missing', async (corruptFile) => {
    const bytes = new TextEncoder().encode('verified payload')
    const goodHash = createHash('sha256').update(bytes).digest('hex')
    const selector = {
      schemaVersion: 1, shellAbi: 1, payloadVersion: 'm1', payloadSha256: hash, payloadDirectory: `m1-${hash}`,
      payloadFiles: { 'content-script.js': goodHash, 'service-worker.js': goodHash },
    }
    const fetchValue = async (url: string | URL | Request): Promise<Response> => {
      const path = String(url)
      if (path.endsWith('current.json')) return new Response(JSON.stringify(selector))
      if (path.endsWith(corruptFile)) return new Response(null, { status: 404 })
      return new Response(bytes)
    }
    await expect(loadVerifiedPayloadSelector((path) => `chrome-extension://fixture/${path}`, 'service-worker.js', fetchValue as typeof fetch)).rejects.toThrow(/payload (file unavailable|integrity mismatch)/)
  })

  it('returns only after every declared payload file hash verifies', async () => {
    const bytes = new TextEncoder().encode('verified payload')
    const goodHash = createHash('sha256').update(bytes).digest('hex')
    const selector = {
      schemaVersion: 1, shellAbi: 1, payloadVersion: 'm1', payloadSha256: hash, payloadDirectory: `m1-${hash}`,
      payloadFiles: { 'content-script.js': goodHash, 'service-worker.js': goodHash },
    }
    const fetched: string[] = []
    const fetchValue = async (url: string | URL | Request): Promise<Response> => {
      fetched.push(String(url))
      return String(url).endsWith('current.json') ? new Response(JSON.stringify(selector)) : new Response(bytes)
    }
    await expect(loadVerifiedPayloadSelector((path) => `chrome-extension://fixture/${path}`, 'service-worker.js', fetchValue as typeof fetch)).resolves.toEqual(selector)
    expect(fetched.filter((url) => url.includes('/payloads/'))).toHaveLength(2)
  })
})
