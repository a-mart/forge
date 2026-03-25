import { spawn } from 'node:child_process'

const TASKKILL_TIMEOUT_MS = 3_000

/**
 * Force-kills a Windows process tree.
 * Uses taskkill so child processes are terminated as well.
 */
export async function taskkillProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false
    let timeout: NodeJS.Timeout | null = null

    const finish = (): void => {
      if (settled) {
        return
      }

      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }
      resolve()
    }

    const child = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
    })

    timeout = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Ignore failures while cleaning up taskkill.
      }
      finish()
    }, TASKKILL_TIMEOUT_MS)

    child.once('error', () => {
      // Ignore failures: process may already be gone.
      finish()
    })

    child.once('exit', () => {
      finish()
    })
  })
}
