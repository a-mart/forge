import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = new URL('../..', import.meta.url).pathname

describe('Pi extension migration scanner/codemod', () => {
  it('rewrites supported legacy specifiers and reports diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-extension-migration-'))
    const file = join(root, 'extension.ts')
    await writeFile(file, "import { defineTool } from '@mariozechner/pi-ai';\nimport '@mariozechner/pi-coding-agent';\n")

    const output = execFileSync('node', ['scripts/pi-extension-migration.mjs', '--write', root], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    const result = JSON.parse(output)
    expect(result.ok).toBe(true)
    expect(result.findings).toHaveLength(2)
    expect(result.findings[0].diagnostic).toContain('does not ship @mariozechner/pi-* shims')
    await expect(readFile(file, 'utf8')).resolves.toContain("'@earendil-works/pi-ai/compat'")
    await expect(readFile(file, 'utf8')).resolves.toContain("'@earendil-works/pi-coding-agent'")
  })

  it('fails unsupported legacy subpaths with targeted diagnostic and no shim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-extension-migration-unsupported-'))
    await writeFile(join(root, 'extension.ts'), "import '@mariozechner/pi-ai/private-subpath';\n")

    const result = spawnSync('node', ['scripts/pi-extension-migration.mjs', root], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    const payload = JSON.parse(result.stdout)
    expect(payload.ok).toBe(false)
    expect(payload.findings[0]).toMatchObject({
      specifier: '@mariozechner/pi-ai/private-subpath',
      supported: false,
      replacement: null,
    })
    expect(payload.findings[0].diagnostic).toContain('Unsupported legacy Pi extension import')
  })
})
