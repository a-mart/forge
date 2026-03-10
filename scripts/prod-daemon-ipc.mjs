import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export function resolveProdDaemonIpcPaths(repoRoot) {
  const repoHash = createHash('sha1').update(repoRoot).digest('hex').slice(0, 10)
  const prefix = path.join(os.tmpdir(), `swarm-prod-daemon-${repoHash}`)

  return {
    prefix,
    pidFile: `${prefix}.pid`,
    restartFile: `${prefix}.restart`,
  }
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM')
  }
}
