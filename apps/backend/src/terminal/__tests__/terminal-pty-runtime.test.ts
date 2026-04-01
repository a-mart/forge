import type { TerminalPtyExitEvent, TerminalPtySpawnRequest } from '../terminal-pty-runtime.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodePtyRuntime } from '../terminal-pty-runtime.js'

interface FakePtyProcess {
  pid: number
  onData: (handler: (data: string) => void) => void
  onExit: (handler: (event: { exitCode?: number; signal?: number }) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: (signal?: string) => void
}

function createSpawnRequest(overrides: Partial<TerminalPtySpawnRequest> = {}): TerminalPtySpawnRequest {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    cols: overrides.cols ?? 80,
    rows: overrides.rows ?? 24,
    shell: overrides.shell,
    shellArgs: overrides.shellArgs,
    env: overrides.env,
    onData: overrides.onData ?? (async () => {}),
    onExit: overrides.onExit ?? (async () => {}),
  }
}

function createFakeNodePtyModule() {
  let onDataHandler: ((data: string) => void) | null = null
  let onExitHandler: ((event: { exitCode?: number; signal?: number }) => void) | null = null
  const writes: string[] = []
  const resizes: Array<{ cols: number; rows: number }> = []
  const kills: Array<string | undefined> = []
  const spawn = vi.fn(
    (
      shell: string,
      args: string[],
      options: {
        cols: number
        rows: number
        cwd: string
        env: Record<string, string>
        useConpty?: boolean
      },
    ): FakePtyProcess => ({
      pid: 4242,
      onData: (handler) => {
        onDataHandler = handler
      },
      onExit: (handler) => {
        onExitHandler = handler
      },
      write: (data) => {
        writes.push(data)
      },
      resize: (cols, rows) => {
        resizes.push({ cols, rows })
      },
      kill: (signal) => {
        kills.push(signal)
      },
    }),
  )

  return {
    module: { spawn },
    spawn,
    writes,
    resizes,
    kills,
    emitData(data: string) {
      onDataHandler?.(data)
    },
    emitExit(event: { exitCode?: number; signal?: number }) {
      onExitHandler?.(event)
    },
  }
}

async function flushAsyncWork(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('NodePtyRuntime', () => {
  it('detects the shell for the current platform when spawning', async () => {
    const fake = createFakeNodePtyModule()
    const runtime = new NodePtyRuntime({ outputBatchIntervalMs: 16 })
    ;(runtime as any).nodePtyModulePromise = Promise.resolve(fake.module)

    if (process.platform === 'win32') {
      vi.stubEnv('FORGE_TERMINAL_DEFAULT_SHELL', '')
      vi.stubEnv('MIDDLEMAN_TERMINAL_DEFAULT_SHELL', '')
      vi.stubEnv('COMSPEC', process.env.COMSPEC || 'cmd.exe')
    } else {
      vi.stubEnv('FORGE_TERMINAL_DEFAULT_SHELL', '')
      vi.stubEnv('MIDDLEMAN_TERMINAL_DEFAULT_SHELL', '')
      vi.stubEnv('SHELL', '/bin/sh')
    }

    const handle = await runtime.spawnPty(createSpawnRequest())
    const spawnCall = fake.spawn.mock.calls[0]

    expect(spawnCall).toBeDefined()
    expect(spawnCall?.[0]).toBe(handle.shell)
    expect(spawnCall?.[1]).toEqual(handle.shellArgs)

    if (process.platform === 'win32') {
      expect(handle.shell.toLowerCase()).toContain('cmd')
      expect(handle.shellArgs).toEqual([])
    } else {
      expect(handle.shell).toBe('/bin/sh')
      expect(handle.shellArgs).toEqual(['-i'])
    }
  })

  it('uses the dynamic default shell provider when present', async () => {
    const fake = createFakeNodePtyModule()
    let configuredShell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
    const runtime = new NodePtyRuntime({
      outputBatchIntervalMs: 16,
      defaultShell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
      getDefaultShell: () => configuredShell,
    })
    ;(runtime as any).nodePtyModulePromise = Promise.resolve(fake.module)

    const handleA = await runtime.spawnPty(createSpawnRequest())
    expect(handleA.shell).toBe(configuredShell)

    configuredShell = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
    const handleB = await runtime.spawnPty(createSpawnRequest())
    expect(handleB.shell).toBe(configuredShell)
  })

  it('classifies terminal-dead errors across errno and message shapes', () => {
    const runtime = new NodePtyRuntime({ outputBatchIntervalMs: 16 })

    expect(runtime.isTerminalDeadError(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).toBe(true)
    expect(runtime.isTerminalDeadError(Object.assign(new Error('no such process'), { code: 'ESRCH' }))).toBe(true)
    expect(runtime.isTerminalDeadError(new Error('Terminal already closed'))).toBe(true)
    expect(runtime.isTerminalDeadError(new Error('process exited unexpectedly'))).toBe(true)
    expect(runtime.isTerminalDeadError(new Error('permission denied'))).toBe(false)
  })

  it('gracefully reports node-pty as unavailable when loading fails', async () => {
    const runtime = new NodePtyRuntime({ outputBatchIntervalMs: 16 })
    ;(runtime as any).nodePtyModulePromise = Promise.resolve(null)

    await expect(runtime.isAvailable()).resolves.toBe(false)
    await expect(runtime.spawnPty(createSpawnRequest())).rejects.toMatchObject({ code: 'PTY_UNAVAILABLE' })
  })

  it('batches output within the configured window and flushes pending data on exit', async () => {
    vi.useFakeTimers()
    const fake = createFakeNodePtyModule()
    const runtime = new NodePtyRuntime({ outputBatchIntervalMs: 16, defaultShell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh' })
    ;(runtime as any).nodePtyModulePromise = Promise.resolve(fake.module)

    const flushed: string[] = []
    const exits: TerminalPtyExitEvent[] = []
    await runtime.spawnPty(
      createSpawnRequest({
        onData: async (chunk) => {
          flushed.push(chunk.toString('utf8'))
        },
        onExit: async (event) => {
          exits.push(event)
        },
      }),
    )

    fake.emitData('hello')
    fake.emitData(' world')

    await vi.advanceTimersByTimeAsync(15)
    expect(flushed).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(flushed).toEqual(['hello world'])

    fake.emitData(' tail')
    fake.emitExit({ exitCode: 0, signal: 9 })
    await flushAsyncWork()

    expect(flushed).toEqual(['hello world', ' tail'])
    expect(exits).toEqual([{ exitCode: 0, exitSignal: 9 }])
  })

  it('logs flush errors during stop but still delivers the exit event', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = createFakeNodePtyModule()
    const runtime = new NodePtyRuntime({ outputBatchIntervalMs: 16, defaultShell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh' })
    ;(runtime as any).nodePtyModulePromise = Promise.resolve(fake.module)

    const exits: TerminalPtyExitEvent[] = []
    await runtime.spawnPty(
      createSpawnRequest({
        onData: async () => {
          throw new Error('flush failed')
        },
        onExit: async (event) => {
          exits.push(event)
        },
      }),
    )

    fake.emitData('oops')
    fake.emitExit({ exitCode: 17 })
    await flushAsyncWork()

    expect(warn).toHaveBeenCalledWith('[terminal-pty] Failed to flush batched output for PTY 4242: flush failed')
    expect(exits).toEqual([{ exitCode: 17, exitSignal: null }])
  })
})
