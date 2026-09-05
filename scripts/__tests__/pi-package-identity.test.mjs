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
        sha256: '25adff3dd83f972966c1fdf251b11b28fb2f74b1bea2fa811cbe70acc7910e25',
        lockHash: '25adff3dd83f972966c1fdf251b11b28fb2f74b1bea2fa811cbe70acc7910e25',
      }),
      expect.objectContaining({
        key: '@earendil-works/pi-coding-agent@0.80.6',
        sha256: '257a1476e88f530d489d2bdf7362306be5d4d4fc23698e87b183aef59fbef192',
        lockHash: '257a1476e88f530d489d2bdf7362306be5d4d4fc23698e87b183aef59fbef192',
      }),
    ])
    expect(result.oldScopeAllowlist).toEqual(['@mariozechner/clipboard*'])
  })
})
