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
        sha256: 'b7d32b9a0353a182d1a3097259a41acfbe61c3d5aa13580f78fa39d74fd3a101',
        lockHash: 'b7d32b9a0353a182d1a3097259a41acfbe61c3d5aa13580f78fa39d74fd3a101',
      }),
      expect.objectContaining({
        key: '@earendil-works/pi-coding-agent@0.80.6',
        sha256: '1f14bfba039f9e17ebfb3d34d6250fefa141ca44f6de3678360033007e132c66',
        lockHash: '1f14bfba039f9e17ebfb3d34d6250fefa141ca44f6de3678360033007e132c66',
      }),
    ])
    expect(result.oldScopeAllowlist).toEqual(['@mariozechner/clipboard*'])
  })
})
