import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const repoRoot = new URL('../..', import.meta.url).pathname

describe('Pi package identity gate', () => {
  it('emits deterministic four-package/patch identity and old-scope allowlist', () => {
    const output = execFileSync('node', ['scripts/pi-package-identity.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    const result = JSON.parse(output)
    expect(result.ok).toBe(true)
    expect(result.expectedVersion).toBe('0.80.6')
    expect(result.installed.map((entry) => entry.name)).toEqual([
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-ai',
      '@earendil-works/pi-coding-agent',
      '@earendil-works/pi-tui',
    ])
    for (const entry of result.installed) {
      expect(entry.version).toBe('0.80.6')
      expect(entry.integrity).toMatch(/^sha512-/)
      expect(entry.realpath).toContain('/node_modules/')
    }
    expect(result.patches).toEqual([
      expect.objectContaining({
        key: '@earendil-works/pi-ai@0.80.6',
        sha256: '89209b363e4e576cbbb686175e0db6ee260035784bbc564b5192bd674de55626',
      }),
      expect.objectContaining({
        key: '@earendil-works/pi-coding-agent@0.80.6',
        sha256: '39f5f02939e5b9eed7ccf6892f263051c9d56587c5933645f555f70dc344ab84',
      }),
    ])
    expect(result.oldScopeAllowlist).toEqual(['@mariozechner/clipboard*'])
  })
})
