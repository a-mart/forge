/*
 * Private Playwright runtime extraction is adapted from T3 Code's
 * apps/desktop/src/preview/PlaywrightInjectedRuntime.ts at 9a0a0716 (MIT).
 * The exact markers are intentionally tested so Playwright upgrades fail closed.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'

const require = createRequire(__filename)
export const PLAYWRIGHT_CORE_VERSION = '1.60.0'
export const PLAYWRIGHT_SOURCE_MARKER = 'source3 = '
export const PLAYWRIGHT_SOURCE_TERMINATOR = ';\n  }\n});'
export const PLAYWRIGHT_SOURCE_MINIMUM_LENGTH = 100_000
let cachedInstallExpression: string | null = null

export function extractPlaywrightInjectedRuntimeSource(coreBundle: string, bundlePath = '<memory>'): string {
  const start = coreBundle.indexOf(PLAYWRIGHT_SOURCE_MARKER)
  if (start < 0) throw new Error(`Playwright injected runtime marker was not found in ${bundlePath}`)
  const literalStart = start + PLAYWRIGHT_SOURCE_MARKER.length
  const literalEnd = coreBundle.indexOf(PLAYWRIGHT_SOURCE_TERMINATOR, literalStart)
  if (literalEnd < 0) throw new Error(`Playwright injected runtime terminator was not found in ${bundlePath}`)

  const source: unknown = vm.runInNewContext(
    coreBundle.slice(literalStart, literalEnd),
    Object.create(null) as object,
    { timeout: 1_000 },
  )
  if (typeof source !== 'string' || source.length < PLAYWRIGHT_SOURCE_MINIMUM_LENGTH) {
    throw new Error(`Playwright injected runtime from ${bundlePath} failed source validation`)
  }
  return source
}

export function resolvePlaywrightCoreBundlePath(): string {
  let packageJsonPath: string
  try {
    packageJsonPath = require.resolve('playwright-core/package.json')
  } catch (error) {
    const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : null
    if (!resourcesPath) throw error
    packageJsonPath = path.join(resourcesPath, 'browser-runtime', 'playwright-core', 'package.json')
  }
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string }
  if (manifest.version !== PLAYWRIGHT_CORE_VERSION) {
    throw new Error(`Expected playwright-core ${PLAYWRIGHT_CORE_VERSION}, found ${manifest.version ?? 'unknown'}`)
  }
  return path.join(path.dirname(packageJsonPath), 'lib', 'coreBundle.js')
}

export function playwrightInjectedRuntimeInstallExpression(): string {
  if (cachedInstallExpression) return cachedInstallExpression
  const bundlePath = resolvePlaywrightCoreBundlePath()
  const source = extractPlaywrightInjectedRuntimeSource(readFileSync(bundlePath, 'utf8'), bundlePath)
  const options = JSON.stringify({
    isUnderTest: false,
    sdkLanguage: 'javascript',
    testIdAttributeName: 'data-testid',
    stableRafCount: 1,
    browserName: 'chromium',
    shouldPrependErrorPrefix: false,
    isUtilityWorld: false,
    customEngines: [],
  })
  cachedInstallExpression = `(() => {
    if (globalThis.__forgePlaywrightInjected) return true;
    const module = { exports: {} };
    ${source}
    globalThis.__forgePlaywrightInjected = new (module.exports.InjectedScript())(globalThis, ${options});
    return true;
  })()`
  return cachedInstallExpression
}
