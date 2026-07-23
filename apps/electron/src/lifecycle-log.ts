import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export type LifecycleLogDetails = Record<string, boolean | number | string | null>

export interface LifecycleLogOptions {
  getLogPath: () => string | null
  now?: () => Date
  appendLine?: (filePath: string, line: string) => void
  onWriteError?: (error: unknown) => void
}

/** Writes compact process lifecycle records without capturing session content. */
export class LifecycleLog {
  private readonly now: () => Date
  private readonly appendLine: (filePath: string, line: string) => void
  private readonly onWriteError: (error: unknown) => void

  constructor(private readonly options: LifecycleLogOptions) {
    this.now = options.now ?? (() => new Date())
    this.appendLine = options.appendLine ?? appendLifecycleLine
    this.onWriteError = options.onWriteError ?? ((error) => {
      console.warn('Failed to write lifecycle log', error)
    })
  }

  record(event: string, details: LifecycleLogDetails = {}): void {
    try {
      const filePath = this.options.getLogPath()
      if (!filePath) return

      const line = JSON.stringify({ at: this.now().toISOString(), event, ...details })
      this.appendLine(filePath, line)
    } catch (error) {
      this.onWriteError(error)
    }
  }
}

function appendLifecycleLine(filePath: string, line: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  appendFileSync(filePath, `${line}\n`, 'utf8')
}
