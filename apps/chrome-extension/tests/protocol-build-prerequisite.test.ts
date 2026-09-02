import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')

describe('protocol build prerequisite', () => {
  it('keeps direct test, typecheck, and build entry points self-sufficient', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts.test).toContain('scripts/ensure-protocol.mjs')
    expect(pkg.scripts.typecheck).toContain('scripts/ensure-protocol.mjs')
    expect(pkg.scripts.build).toBe('node scripts/build.mjs')

    const [ensureSource, buildSource] = await Promise.all([
      readFile(path.join(root, 'scripts/ensure-protocol.mjs'), 'utf8'),
      readFile(path.join(root, 'scripts/build.mjs'), 'utf8'),
    ])
    expect(ensureSource).toContain("['--filter', '@forge/protocol', 'build']")
    expect(ensureSource).toContain("packages', 'protocol', 'dist', 'index.js'")
    expect(buildSource).toContain("import { ensureProtocolDist } from './ensure-protocol.mjs'")
    expect(buildSource).toContain('await ensureProtocolDist()')
  })
})
