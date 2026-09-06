import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElectronDevelopmentSupervisor } from '../../apps/electron/scripts/run-electron-dev.mjs'

function fixture(platform) {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, exitCode: null, signalCode: null, connected: true,
    send: vi.fn(), kill: vi.fn(),
  })
  const exit = (code = 0) => {
    child.exitCode = code
    child.emit('exit', code, null)
  }
  const logger = { log: vi.fn(), error: vi.fn() }
  const forceTerminate = vi.fn(async () => exit(0))
  const supervisor = createElectronDevelopmentSupervisor({
    platform, child, launchElectron: () => child, signalSource: null,
    logger, forceTerminate, now: () => Date.now(), shutdownTimeoutMs: 100,
  })
  return { child, exit, logger, forceTerminate, supervisor }
}

afterEach(() => vi.useRealTimers())

describe.each(['darwin', 'win32'])('development shutdown on %s', (platform) => {
  it('ignores UI cleanup exits and late force requests after Electron has exited', async () => {
    vi.useFakeTimers()
    const fx = fixture(platform)
    fx.exit()
    expect(await fx.supervisor.completion).toBe(0)
    await fx.supervisor.requestShutdown('UI development server exited from signal SIGKILL', 1)
    await fx.supervisor.forceShutdown('late interrupt', 130)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fx.logger.log).not.toHaveBeenCalled()
    expect(fx.logger.error).not.toHaveBeenCalled()
    expect(fx.child.send).not.toHaveBeenCalled()
    expect(fx.forceTerminate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(await fx.supervisor.completion).toBe(0)
  })

  it('keeps a genuine UI failure fatal while Electron is still running', async () => {
    vi.useFakeTimers()
    const fx = fixture(platform)
    const completion = fx.supervisor.requestShutdown('UI development server exited from signal SIGKILL', 1)
    expect(fx.child.send).toHaveBeenCalledOnce()
    fx.exit()
    expect(await completion).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits after the first interrupt and ignores the forwarded duplicate', async () => {
    vi.useFakeTimers()
    const fx = fixture(platform)
    fx.supervisor.handleSignal('SIGINT')
    fx.supervisor.handleSignal('SIGINT')
    expect(fx.child.send).toHaveBeenCalledOnce()
    expect(fx.forceTerminate).not.toHaveBeenCalled()
    fx.exit()
    expect(await fx.supervisor.completion).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still force-terminates a live child after the grace deadline', async () => {
    vi.useFakeTimers()
    const fx = fixture(platform)
    const completion = fx.supervisor.requestShutdown('interrupt')
    await vi.advanceTimersByTimeAsync(100)
    expect(fx.forceTerminate).toHaveBeenCalledOnce()
    expect(await completion).toBe(1)
  })
})
