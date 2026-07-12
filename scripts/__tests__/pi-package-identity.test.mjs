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
        sha256: '706a3210681dd037b19828165082826b1f82d2d5a279b0e800612fca66f9a46d',
      }),
      expect.objectContaining({
        key: '@earendil-works/pi-coding-agent@0.80.6',
        sha256: 'fa749eff036cc1af3c08757e8f7c523f3f0cd867f36d928ff519005e8c9ed5f1',
      }),
    ])
    expect(result.oldScopeAllowlist).toEqual(['@mariozechner/clipboard*'])
  })
})
