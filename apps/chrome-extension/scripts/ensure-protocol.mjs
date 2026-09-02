import { access } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const protocolDistEntry = path.join(repoRoot, 'packages', 'protocol', 'dist', 'index.js')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

export async function ensureProtocolDist() {
  try {
    await access(protocolDistEntry)
    return { built: false, path: protocolDistEntry }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const result = spawnSync(pnpm, ['--filter', '@forge/protocol', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`@forge/protocol build failed with status ${result.status}`)
  }
  await access(protocolDistEntry)
  return { built: true, path: protocolDistEntry }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await ensureProtocolDist()
}
