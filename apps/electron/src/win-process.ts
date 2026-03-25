import { spawn } from 'node:child_process'

/**
 * Force-kills a Windows process tree.
 * Uses taskkill so child processes are terminated as well.
 */
export async function taskkillProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
    })

    child.once('error', () => {
      // Ignore failures: process may already be gone.
      resolve()
    })

    child.once('exit', () => {
      resolve()
    })
  })
}
