import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  extractPlaywrightInjectedRuntimeSource,
  playwrightInjectedRuntimeInstallExpression,
  resolvePlaywrightCoreBundlePath,
} from '../playwright-injected-runtime.js'

describe('Playwright 1.60 injected locator runtime', () => {
  it('extracts the validated private runtime marker from the pinned package', () => {
    const bundlePath = resolvePlaywrightCoreBundlePath()
    const source = extractPlaywrightInjectedRuntimeSource(readFileSync(bundlePath, 'utf8'), bundlePath)
    expect(source.length).toBeGreaterThan(300_000)
    const expression = playwrightInjectedRuntimeInstallExpression()
    expect(expression).toContain('__forgePlaywrightInjected')
    expect(expression).toContain('module.exports.InjectedScript')
  })

  it('fails closed when the marker changes', () => {
    expect(() => extractPlaywrightInjectedRuntimeSource('source3 = "short";\n  }\n});')).toThrow(/source validation/)
    expect(() => extractPlaywrightInjectedRuntimeSource('missing')).toThrow(/marker/)
  })
})
