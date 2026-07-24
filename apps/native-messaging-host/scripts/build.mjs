import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'dist')
const bundlePath = path.join(output, 'host.cjs')

function stableJson(value) {
  return `${JSON.stringify(value, Object.keys(value).sort(), 2)}\n`
}

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await build({
  absWorkingDir: root,
  bundle: true,
  charset: 'utf8',
  entryPoints: ['src/main.ts'],
  format: 'cjs',
  legalComments: 'none',
  logLevel: 'silent',
  minify: false,
  outfile: bundlePath,
  platform: 'node',
  sourcemap: false,
  target: ['node22'],
  treeShaking: true,
})
const bundle = (await readFile(bundlePath, 'utf8')).replace(/\r\n/gu, '\n')
if (bundle.includes(root) || bundle.includes('sourceMappingURL=')) throw new Error('bundle contains non-deterministic build metadata')
await writeFile(bundlePath, bundle.endsWith('\n') ? bundle : `${bundle}\n`, { mode: 0o644 })
const sha256 = createHash('sha256').update(await readFile(bundlePath)).digest('hex')
await writeFile(path.join(output, 'build-manifest.json'), stableJson({
  bundle: 'host.cjs',
  bundleSha256: sha256,
  schemaVersion: 1,
  target: 'node22',
}), { mode: 0o644 })
await chmod(output, 0o755)
process.stdout.write(`${sha256}\n`)
