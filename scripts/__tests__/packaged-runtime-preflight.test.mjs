import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadRuntimeModuleFromEntry,
  pickPackageEntryFromExports,
  resolveStagedPackageEntryFromManifest,
  validateStagedPiCodingAgentPackageDir,
} from '../../apps/electron/scripts/build-all.mjs'

describe('validateStagedPiCodingAgentPackageDir', () => {
  it('accepts staged pi-coding-agent dirs with compaction measurement assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-pi-coding-agent-'))

    await mkdir(join(root, 'dist', 'core', 'compaction'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(join(root, 'dist', 'core', 'messages.js'), 'export function convertToLlm() {}')
    await writeFile(join(root, 'dist', 'core', 'compaction', 'utils.js'), 'export function serializeConversation() {}')

    expect(validateStagedPiCodingAgentPackageDir(root)).toBeNull()
  })

  it('reports missing compaction measurement assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-pi-coding-agent-missing-'))

    await mkdir(join(root, 'dist', 'core'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(join(root, 'dist', 'core', 'messages.js'), 'export function convertToLlm() {}')

    expect(validateStagedPiCodingAgentPackageDir(root)).toContain('compaction/utils.js')
  })
})

describe('resolveStagedPackageEntryFromManifest', () => {
  it('resolves import-only package exports to the staged entry path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-esm-only-package-'))

    await mkdir(join(root, 'dist', 'core', 'compaction'), { recursive: true })
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@mariozechner/pi-coding-agent',
        type: 'module',
        exports: {
          '.': {
            types: './dist/index.d.ts',
            import: './dist/index.js',
          },
        },
      }),
    )
    await writeFile(join(root, 'dist', 'index.js'), 'export function compact() {}')
    await writeFile(join(root, 'dist', 'core', 'messages.js'), 'export function convertToLlm() {}')
    await writeFile(join(root, 'dist', 'core', 'compaction', 'utils.js'), 'export function serializeConversation() {}')

    expect(pickPackageEntryFromExports({ import: './dist/index.js' })).toBe('./dist/index.js')
    expect(resolveStagedPackageEntryFromManifest(root)).toBe(join(root, 'dist', 'index.js'))
  })

  it('loads import-only staged package entries via dynamic import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-esm-only-load-'))
    const packageDir = join(root, 'node_modules', '@example', 'esm-only')

    await mkdir(join(packageDir, 'dist'), { recursive: true })
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@example/esm-only',
        type: 'module',
        exports: {
          '.': {
            import: './dist/index.js',
          },
        },
      }),
    )
    await writeFile(join(packageDir, 'dist', 'index.js'), 'export function compact() { return true }')
    await writeFile(join(root, 'bundle.cjs'), 'module.exports = {};\n')

    const resolvedEntry = resolveStagedPackageEntryFromManifest(packageDir)
    expect(resolvedEntry).toBe(join(packageDir, 'dist', 'index.js'))

    const stagedRequire = createRequire(join(root, 'bundle.cjs'))
    expect(() => stagedRequire.resolve('@example/esm-only')).toThrow(/No "exports" main defined/)

    const loadedModule = await loadRuntimeModuleFromEntry(stagedRequire, resolvedEntry)
    expect(typeof loadedModule.compact).toBe('function')
    expect(loadedModule.compact()).toBe(true)
  })

  it('loads pi-coding-agent compaction measurement modules from staged dist paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-pi-measurement-load-'))

    await mkdir(join(root, 'dist', 'core', 'compaction'), { recursive: true })
    await writeFile(join(root, 'dist', 'core', 'messages.js'), 'export function convertToLlm(messages) { return messages }')
    await writeFile(
      join(root, 'dist', 'core', 'compaction', 'utils.js'),
      'export function serializeConversation(messages) { return JSON.stringify(messages) }',
    )

    const stagedRequire = createRequire(join(root, 'package.json'))
    const messagesModule = await loadRuntimeModuleFromEntry(stagedRequire, join(root, 'dist', 'core', 'messages.js'))
    const utilsModule = await loadRuntimeModuleFromEntry(
      stagedRequire,
      join(root, 'dist', 'core', 'compaction', 'utils.js'),
    )

    expect(typeof messagesModule.convertToLlm).toBe('function')
    expect(typeof utilsModule.serializeConversation).toBe('function')
    expect(utilsModule.serializeConversation(messagesModule.convertToLlm([{ role: 'user' }]))).toContain('"role":"user"')
  })
})
