import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { collectRuntimePackageClosure } from '../build-all.mjs'

const suffix = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? '-musl' : ''
const nativePackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${suffix}`

// Use Node's real standalone module resolution, without Vitest's dependency resolver.
function validateStagedClaudeSdkPackageDir(directory) {
  const moduleUrl = new URL('../build-all.mjs', import.meta.url).href
  const script = `import { validateStagedClaudeSdkPackageDir } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(validateStagedClaudeSdkPackageDir(process.argv[1])))`
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, directory], { encoding: 'utf8', timeout: 10_000 }))
}

describe('Claude desktop runtime staging', () => {
  it('includes the matched native package in the real SDK dependency closure', async () => {
    const manifest = fileURLToPath(new URL('../../../backend/package.json', import.meta.url))
    const closure = await collectRuntimePackageClosure([{ packageName: '@anthropic-ai/claude-agent-sdk', optional: false }], manifest)
    const packages = [...closure.hoisted, ...closure.nested]
    const sdk = packages.find(pkg => pkg.name === '@anthropic-ai/claude-agent-sdk')
    const native = packages.find(pkg => pkg.name === nativePackage)
    expect(sdk).toBeDefined()
    expect(native?.manifest.version).toBe(sdk.manifest.version)
  })

  it('rejects missing and mismatched native packages in a standalone staged tree', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forge-claude-staging-'))
    const sdk = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
    const native = path.join(root, 'node_modules', nativePackage)
    try {
      await mkdir(sdk, { recursive: true })
      await writeFile(path.join(sdk, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.280' }))
      expect(validateStagedClaudeSdkPackageDir(sdk)).toMatch(/Missing matched native/)
      await mkdir(native, { recursive: true })
      await writeFile(path.join(native, 'package.json'), JSON.stringify({ name: nativePackage, version: '0.3.272' }))
      expect(validateStagedClaudeSdkPackageDir(sdk)).toMatch(/version mismatch/)
      await writeFile(path.join(native, 'package.json'), JSON.stringify({ name: nativePackage, version: '0.3.280' }))
      expect(validateStagedClaudeSdkPackageDir(sdk)).toMatch(/Missing matched native/)
      await writeFile(path.join(native, process.platform === 'win32' ? 'claude.exe' : 'claude'), '', { mode: 0o755 })
      expect(validateStagedClaudeSdkPackageDir(sdk)).toBeNull()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
