import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { CLI_EXIT_CODES, CLI_PROTOCOL_VERSION as PROTOCOL_CLI_VERSION } from '@forge/protocol/cli'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

import { CLI_PROTOCOL_VERSION, CLI_VERSION, EXIT_CODES } from './version.js'

interface PackageJson {
  name: string
  version: string
  private?: boolean
  bin?: Record<string, string>
  files?: string[]
  publishConfig?: { access?: string }
  scripts?: Record<string, string>
}

interface ProtocolPackageJson {
  exports?: Record<string, { types?: string; default?: string }>
}

describe('@forge/cli package contract', () => {
  it('is publishable with a stable forge bin and curated files', async () => {
    const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as PackageJson
    expect(packageJson.name).toBe('@forge/cli')
    expect(packageJson.version).toBe(CLI_VERSION)
    expect(packageJson.private).not.toBe(true)
    expect(packageJson.bin?.forge).toBe('./dist/cli.js')
    expect(packageJson.files).toEqual(['dist/cli.js', 'README.md', 'LICENSE'])
    expect(packageJson.scripts?.prepack).toBe('pnpm run build')
    expect(packageJson.scripts?.['test:pack-clean']).toBe('node scripts/verify-pack-clean.mjs')
    expect(packageJson.publishConfig?.access).toBe('public')
  })

  it('consumes protocol-owned wire and exit-code constants', () => {
    expect(CLI_PROTOCOL_VERSION).toBe(PROTOCOL_CLI_VERSION)
    expect(EXIT_CODES).toBe(CLI_EXIT_CODES)
  })

  it('uses published protocol leaf exports for runtime values', async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve('../protocol/package.json'), 'utf8'),
    ) as ProtocolPackageJson

    expect(packageJson.exports?.['./choices']).toEqual({
      types: './src/choices.ts',
      default: './dist/choices.js',
    })
    expect(packageJson.exports?.['./cli']).toEqual({
      types: './src/cli.ts',
      default: './dist/cli.js',
    })
  })

  it('bundles only the protocol runtime leaves used by the CLI', async () => {
    const result = await build({
      entryPoints: [path.resolve('src/cli.ts')],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent',
    })
    const output = Object.values(result.metafile.outputs)[0]
    if (!output) throw new Error('Expected esbuild metadata for the CLI bundle.')

    const bundledProtocolLeaves = Object.entries(output.inputs)
      .filter(([input, metadata]) =>
        input.replaceAll('\\', '/').includes('/protocol/src/') && metadata.bytesInOutput > 0,
      )
      .map(([input]) => input.replaceAll('\\', '/').split('/').at(-1))
      .sort()

    expect(bundledProtocolLeaves).toEqual(['choices.ts', 'cli.ts'])
    expect(result.outputFiles?.[0]?.text).not.toContain('@forge/protocol')
  })
})
