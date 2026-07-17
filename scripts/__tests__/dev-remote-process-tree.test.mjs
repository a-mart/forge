import { describe, expect, it, vi } from 'vitest'
import { terminateDevChild } from '../dev-remote-process-tree.mjs'

function runningChild(pid = 1234) {
  return { pid, exitCode: null, signalCode: null }
}

describe('dev-remote process-tree termination', () => {
  it('immediately targets the full Windows process tree instead of signaling the cmd wrapper', () => {
    const taskkill = { on: vi.fn() }
    const spawnProcess = vi.fn(() => taskkill)
    const killProcess = vi.fn()

    expect(terminateDevChild(runningChild(), {
      platform: 'win32',
      spawnProcess,
      killProcess,
    })).toBe(true)

    expect(spawnProcess).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '1234', '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    )
    expect(taskkill.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(killProcess).not.toHaveBeenCalled()
  })

  it('preserves graceful process-group signaling on POSIX', () => {
    const spawnProcess = vi.fn()
    const killProcess = vi.fn()

    expect(terminateDevChild(runningChild(5678), {
      platform: 'linux',
      signal: 'SIGINT',
      spawnProcess,
      killProcess,
    })).toBe(true)

    expect(killProcess).toHaveBeenCalledWith(-5678, 'SIGINT')
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('does not target a child that has already exited', () => {
    const spawnProcess = vi.fn()
    const killProcess = vi.fn()
    const child = { pid: 1234, exitCode: 0, signalCode: null }

    expect(terminateDevChild(child, {
      platform: 'win32',
      spawnProcess,
      killProcess,
    })).toBe(false)
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(killProcess).not.toHaveBeenCalled()
  })
})
