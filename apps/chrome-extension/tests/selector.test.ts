import { describe, expect, it } from 'vitest'
import { parsePayloadSelector } from '../src/shell/selector.js'

const hash = 'a'.repeat(64)

describe('versioned local payload selector', () => {
  it('binds the selected directory to shell ABI, version, and hash', () => {
    expect(parsePayloadSelector({
      schemaVersion: 1,
      shellAbi: 1,
      payloadVersion: 'm1-spike.1',
      payloadSha256: hash,
      payloadDirectory: `m1-spike.1-${hash}`,
    })).toMatchObject({ payloadVersion: 'm1-spike.1', payloadSha256: hash })
  })

  it.each([
    { schemaVersion: 1, shellAbi: 2, payloadVersion: 'm1', payloadSha256: hash, payloadDirectory: `m1-${hash}` },
    { schemaVersion: 1, shellAbi: 1, payloadVersion: '../escape', payloadSha256: hash, payloadDirectory: `../escape-${hash}` },
    { schemaVersion: 1, shellAbi: 1, payloadVersion: 'm1', payloadSha256: 'bad', payloadDirectory: 'm1-bad' },
    { schemaVersion: 1, shellAbi: 1, payloadVersion: 'm1', payloadSha256: hash, payloadDirectory: `other-${hash}` },
  ])('rejects malformed or path-escaping selector %#', (selector) => {
    expect(() => parsePayloadSelector(selector)).toThrow()
  })
})
