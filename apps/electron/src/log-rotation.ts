import { renameSync, statSync } from 'node:fs'

/**
 * Moves an append-only log to a single previous generation (`<path>.1`) once it
 * exceeds `maxBytes`. Returns whether the log was rotated; failures never throw.
 */
export function rotateLogFileIfLarge(
  logPath: string,
  maxBytes: number,
  options: {
    rename?: (from: string, to: string) => void
    onError?: (error: unknown) => void
  } = {},
): boolean {
  try {
    if (statSync(logPath).size <= maxBytes) return false
    ;(options.rename ?? renameSync)(logPath, `${logPath}.1`)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      ;(options.onError ?? ((cause) => console.warn('Failed to rotate log', logPath, cause)))(error)
    }
    return false
  }
}
