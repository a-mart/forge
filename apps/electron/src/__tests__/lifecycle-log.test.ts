import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LifecycleLog } from '../lifecycle-log.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('LifecycleLog', () => {
  it('appends structured lifecycle records to a dedicated log', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'forge-electron-lifecycle-'))
    temporaryDirectories.push(directory)
    const logPath = path.join(directory, 'nested', 'lifecycle.log')
    const logger = new LifecycleLog({
      getLogPath: () => logPath,
      now: () => new Date('2026-07-23T02:53:20.705Z'),
    })

    logger.record('backend_exited', {
      code: null,
      ready: true,
      signal: 'SIGHUP',
      stopping: false,
    })

    expect(readFileSync(logPath, 'utf8')).toBe(
      '{"at":"2026-07-23T02:53:20.705Z","event":"backend_exited","code":null,"ready":true,"signal":"SIGHUP","stopping":false}\n',
    )
  })

  it('does not throw when lifecycle logging fails', () => {
    const onWriteError = vi.fn()
    const logger = new LifecycleLog({
      getLogPath: () => '/unwritable/lifecycle.log',
      appendLine: () => {
        throw new Error('disk unavailable')
      },
      onWriteError,
    })

    expect(() => logger.record('electron_started')).not.toThrow()
    expect(onWriteError).toHaveBeenCalledOnce()
  })

  it('does not throw when resolving the log path fails during shutdown', () => {
    const onWriteError = vi.fn()
    const logger = new LifecycleLog({
      getLogPath: () => {
        throw new Error('application path unavailable')
      },
      onWriteError,
    })

    expect(() => logger.record('electron_process_exit', { code: 1 })).not.toThrow()
    expect(onWriteError).toHaveBeenCalledOnce()
  })
})
