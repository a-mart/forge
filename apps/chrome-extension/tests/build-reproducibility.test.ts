import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')

async function files(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const relative = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...await files(directory, relative))
    else result.push(relative)
  }
  return result
}

async function digest(directory: string): Promise<string> {
  const hash = createHash('sha256')
  for (const relative of await files(directory)) {
    const content = await readFile(path.join(directory, relative))
    hash.update(`${relative}\0${content.byteLength}\0`).update(content)
  }
  return hash.digest('hex')
}

describe('deterministic MV3 package', () => {
  it('registers worker listeners synchronously before selector I/O', async () => {
    const source = await readFile(path.join(root, 'src/shell/service-worker-bootstrap.ts'), 'utf8')
    const firstRegister = source.indexOf("register(chromeApi.runtime.onInstalled")
    const boot = source.indexOf('async function boot')
    const bootInvocation = source.indexOf('void boot()')
    expect(firstRegister).toBeGreaterThan(0)
    expect(firstRegister).toBeLessThan(boot)
    expect(boot).toBeLessThan(bootInvocation)
    expect(source).toContain("register(chromeApi.debugger.onDetach, 'debugger.detach')")
  })

  it('builds twice byte-for-byte with normalized inventory and no source maps', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'forge-extension-repro-'))
    const first = path.join(temporary, 'first')
    const second = path.join(temporary, 'second')
    try {
      await execFileAsync(process.execPath, ['scripts/build.mjs', '--out-dir', first], { cwd: root })
      await execFileAsync(process.execPath, ['scripts/build.mjs', '--out-dir', second], { cwd: root })
      expect(await digest(first)).toBe(await digest(second))
      const firstFiles = await files(first)
      expect(firstFiles).toEqual(await files(second))
      expect(firstFiles).toContain('extension/manifest.json')
      expect(firstFiles).toContain('package-manifest.json')
      expect(firstFiles.some((file) => file.endsWith('.map'))).toBe(false)
      const selector = JSON.parse(await readFile(path.join(first, 'extension/current.json'), 'utf8')) as Record<string, unknown>
      expect(selector.payloadDirectory).toBe(`${String(selector.payloadVersion)}-${String(selector.payloadSha256)}`)
      const payloadFiles = selector.payloadFiles as Record<string, string>
      expect(Object.keys(payloadFiles).sort()).toEqual(['content-script.js', 'service-worker.js', 'side-panel.js'])
      for (const [file, expectedHash] of Object.entries(payloadFiles)) {
        const content = await readFile(path.join(first, 'extension/payloads', String(selector.payloadDirectory), file))
        expect(createHash('sha256').update(content).digest('hex')).toBe(expectedHash)
      }
      const payloadWorker = await readFile(path.join(first, 'extension/payloads', String(selector.payloadDirectory), 'service-worker.js'), 'utf8')
      expect(payloadWorker).not.toContain('var import_meta = {}')
      expect(payloadWorker).toContain('payload directory does not match runtime version and hash')
      const workerBootstrap = await readFile(path.join(first, 'extension/shell/service-worker-bootstrap.js'), 'utf8')
      const indentedPayloadWorker = payloadWorker.trimEnd().split('\n').map((line) => `    ${line}`).join('\n')
      expect(workerBootstrap).toContain(indentedPayloadWorker)
      expect(workerBootstrap).not.toContain('importScripts')
      expect(workerBootstrap).toContain(JSON.stringify(selector.payloadDirectory))
      expect(workerBootstrap).toContain(JSON.stringify(payloadFiles['service-worker.js']))
      expect(workerBootstrap).toContain('selected payload does not match the installed shell')
      expect(workerBootstrap).toContain('directory: selector.payloadDirectory, sha256: selector.payloadSha256')
      const verification = workerBootstrap.indexOf('await loadVerifiedPayloadSelector')
      const payloadInitialization = workerBootstrap.indexOf('loadBundledServiceWorkerPayload();', verification)
      expect(verification).toBeGreaterThan(0)
      expect(payloadInitialization).toBeGreaterThan(verification)
      expect(workerBootstrap).not.toMatch(/\b(?:eval|Function)\s*\(|blob:|\bimport\s*\(/)
      const packageManifest = JSON.parse(await readFile(path.join(first, 'package-manifest.json'), 'utf8')) as {
        extension: { shellFiles: Record<string, string>; payloadFiles: Record<string, string> }
        capabilities: Record<string, boolean>
      }
      expect(packageManifest).toMatchObject({ capabilities: { desktopIntegration: false, testSideLoadOnly: true, resize: false, recording: false, downloadArtifacts: false, downloadOpen: false } })
      expect(Object.keys(packageManifest.extension.shellFiles).sort()).toEqual([
        'manifest.json', 'shell/service-worker-bootstrap.js', 'shell/side-panel-bootstrap.js',
        'shell/side-panel.css', 'shell/side-panel.html',
      ])
      expect(packageManifest.extension.payloadFiles).toEqual(payloadFiles)
      for (const relative of firstFiles) {
        expect((await stat(path.join(first, relative))).mode & 0o777).toBe(0o644)
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }, 60_000)
})
