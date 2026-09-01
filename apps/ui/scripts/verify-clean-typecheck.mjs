import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const uiRoot = fileURLToPath(new URL('..', import.meta.url))
const routeTreePath = path.join(uiRoot, 'src', 'routeTree.gen.ts')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

let originalRouteTree
try {
  originalRouteTree = await readFile(routeTreePath)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

let passed = false
try {
  await rm(routeTreePath, { force: true })
  const result = spawnSync(pnpm, ['run', 'typecheck'], { cwd: uiRoot, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`UI typecheck exited with status ${result.status}`)

  await access(routeTreePath)
  passed = true
  console.log('Verified UI typecheck regenerates routeTree.gen.ts from a clean checkout.')
} finally {
  if (!passed) {
    if (originalRouteTree) await writeFile(routeTreePath, originalRouteTree)
    else await rm(routeTreePath, { force: true })
  }
}
