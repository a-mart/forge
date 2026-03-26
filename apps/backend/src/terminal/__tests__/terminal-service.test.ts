import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  TerminalCloseReason,
  TerminalCreateRequest,
  TerminalLifecycleState,
  TerminalMeta,
  TerminalWsServerControlMessage,
} from '@forge/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTerminalMetaPath } from '../../swarm/data-paths.js'
import { TerminalPersistence } from '../terminal-persistence.js'
import type {
  TerminalPtyExitEvent,
  TerminalPtyHandle,
  TerminalPtyRuntime,
  TerminalPtySpawnRequest,
} from '../terminal-pty-runtime.js'
import type { ResolvedTerminalSession, TerminalSessionResolver } from '../terminal-session-resolver.js'
import { TerminalService, TerminalServiceError } from '../terminal-service.js'

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface FakeHandle extends TerminalPtyHandle {
  written: Array<string | Buffer>
  resizeCalls: Array<{ cols: number; rows: number }>
  killCalls: Array<string | undefined>
  disposed: boolean
  emitData: (data: Buffer | string) => Promise<void>
  emitExit: (event: TerminalPtyExitEvent) => Promise<void>
}

class FakePtyRuntime implements TerminalPtyRuntime {
  available = true
  nextPid = 4000
  handles: FakeHandle[] = []
  orphanCleanupCalls: number[][] = []
  killGate: Deferred<void> | null = null

  async isAvailable(): Promise<boolean> {
    return this.available
  }

  async spawnPty(request: TerminalPtySpawnRequest): Promise<FakeHandle> {
    const handle: FakeHandle = {
      pid: this.nextPid++,
      shell: request.shell ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'),
      shellArgs: request.shellArgs ?? (process.platform === 'win32' ? [] : ['-i']),
      written: [],
      resizeCalls: [],
      killCalls: [],
      disposed: false,
      write: (data) => {
        handle.written.push(data)
      },
      resize: (cols, rows) => {
        handle.resizeCalls.push({ cols, rows })
      },
      kill: (signal) => {
        handle.killCalls.push(signal)
      },
      dispose: async () => {
        handle.disposed = true
      },
      emitData: async (data) => {
        await request.onData(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
      },
      emitExit: async (event) => {
        await request.onExit(event)
      },
    }

    this.handles.push(handle)
    return handle
  }

  async resizePty(handle: TerminalPtyHandle, cols: number, rows: number): Promise<void> {
    handle.resize(cols, rows)
  }

  async killPty(handle: TerminalPtyHandle): Promise<void> {
    if (this.killGate) {
      await this.killGate.promise
    }
    handle.kill('SIGHUP')
    await handle.dispose()
  }

  isTerminalDeadError(): boolean {
    return false
  }

  async cleanupOrphanedProcesses(pids: number[]): Promise<number> {
    this.orphanCleanupCalls.push([...pids])
    return pids.length
  }
}

class MapSessionResolver implements TerminalSessionResolver {
  readonly sessions = new Map<string, ResolvedTerminalSession>()

  resolveSession(sessionAgentId: string): ResolvedTerminalSession | undefined {
    return this.sessions.get(sessionAgentId)
  }

  listSessions(): ResolvedTerminalSession[] {
    const scopes = new Map<string, ResolvedTerminalSession>()
    for (const session of this.sessions.values()) {
      if (!scopes.has(session.sessionAgentId)) {
        scopes.set(session.sessionAgentId, session)
      }
    }
    return Array.from(scopes.values())
  }
}

interface Harness {
  dataDir: string
  rootDir: string
  ptyRuntime: FakePtyRuntime
  resolver: MapSessionResolver
  service: TerminalService
}

const harnesses: Harness[] = []

async function createHarness(options: {
  maxTerminalsPerSession?: number
  enabled?: boolean
} = {}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'terminal-service-'))
  const rootDir = join(dataDir, 'workspace')
  const resolver = new MapSessionResolver()
  const ptyRuntime = new FakePtyRuntime()

  await mkdir(join(rootDir, 'session-a'), { recursive: true })
  await mkdir(join(rootDir, 'session-b'), { recursive: true })

  resolver.sessions.set('session-a', {
    sessionAgentId: 'profile-a',
    profileId: 'profile-a',
    cwd: join(rootDir, 'session-a'),
  })
  resolver.sessions.set('session-b', {
    sessionAgentId: 'profile-a',
    profileId: 'profile-a',
    cwd: join(rootDir, 'session-b'),
  })
  resolver.sessions.set('profile-a', {
    sessionAgentId: 'profile-a',
    profileId: 'profile-a',
    cwd: join(rootDir, 'session-a'),
  })

  const persistence = new TerminalPersistence({
    dataDir,
    scrollbackLines: 5_000,
    journalMaxBytes: 1_048_576,
  })

  const service = new TerminalService({
    dataDir,
    runtimeConfig: {
      enabled: options.enabled ?? true,
      maxTerminalsPerSession: options.maxTerminalsPerSession ?? 10,
      defaultCols: 120,
      defaultRows: 30,
      scrollbackLines: 5_000,
      outputBatchIntervalMs: 16,
      snapshotIntervalMs: 60_000,
      journalMaxBytes: 1_048_576,
      shutdownSnapshotTimeoutMs: 1_000,
      restoreStartupConcurrency: 2,
      wsTicketTtlMs: 1_000,
      wsMaxBufferedAmountBytes: 1_048_576,
      defaultShell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    },
    sessionResolver: resolver,
    ptyRuntime,
    persistence,
    cwdPolicy: {
      rootDir,
      allowlistRoots: [rootDir],
    },
  })

  const harness = { dataDir, rootDir, ptyRuntime, resolver, service }
  harnesses.push(harness)
  return harness
}

function createRequest(overrides: Partial<TerminalCreateRequest> = {}): TerminalCreateRequest {
  return {
    sessionAgentId: overrides.sessionAgentId ?? 'session-a',
    name: overrides.name,
    shell: overrides.shell,
    shellArgs: overrides.shellArgs,
    cwd: overrides.cwd,
    cols: overrides.cols,
    rows: overrides.rows,
  }
}

async function createAndInitializeHarness(options: {
  maxTerminalsPerSession?: number
  enabled?: boolean
} = {}): Promise<Harness> {
  const harness = await createHarness(options)
  await harness.service.initialize()
  return harness
}

async function expectTerminalServiceError(
  promise: Promise<unknown>,
  code: TerminalServiceError['code'],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'TerminalServiceError', code })
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(
    harnesses.splice(0).map(async (harness) => {
      await harness.service.shutdown()
      await rm(harness.dataDir, { recursive: true, force: true })
    }),
  )
})

describe('TerminalService', () => {
  it('initializes cleanly with no persisted terminals', async () => {
    const { service } = await createHarness()

    await expect(service.initialize()).resolves.toEqual({
      restoredRunning: 0,
      restoredExited: 0,
      restoreFailed: 0,
      cleanedOrphans: 0,
      skipped: 0,
    })
  })

  it('restores previously running terminals as running shells', async () => {
    const first = await createAndInitializeHarness()
    const created = await first.service.create(createRequest({ name: 'Restored shell' }))

    const secondPtyRuntime = new FakePtyRuntime()
    const secondPersistence = new TerminalPersistence({
      dataDir: first.dataDir,
      scrollbackLines: 5_000,
      journalMaxBytes: 1_048_576,
    })
    const secondService = new TerminalService({
      dataDir: first.dataDir,
      runtimeConfig: {
        enabled: true,
        maxTerminalsPerSession: 10,
        defaultCols: 120,
        defaultRows: 30,
        scrollbackLines: 5_000,
        outputBatchIntervalMs: 16,
        snapshotIntervalMs: 60_000,
        journalMaxBytes: 1_048_576,
        shutdownSnapshotTimeoutMs: 1_000,
        restoreStartupConcurrency: 2,
        wsTicketTtlMs: 1_000,
        wsMaxBufferedAmountBytes: 1_048_576,
        defaultShell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      },
      sessionResolver: first.resolver,
      ptyRuntime: secondPtyRuntime,
      persistence: secondPersistence,
      cwdPolicy: {
        rootDir: first.rootDir,
        allowlistRoots: [first.rootDir],
      },
    })

    try {
      await expect(secondService.initialize()).resolves.toMatchObject({
        restoredRunning: 1,
        restoredExited: 0,
        restoreFailed: 0,
        cleanedOrphans: 0,
        skipped: 0,
      })

      const restored = secondService.getTerminal(created.terminal.terminalId)
      expect(restored).toMatchObject({
        terminalId: created.terminal.terminalId,
        sessionAgentId: created.terminal.sessionAgentId,
        state: 'running',
        recoveredFromPersistence: true,
      })

      await secondService.writeInput({
        terminalId: created.terminal.terminalId,
        sessionAgentId: created.terminal.sessionAgentId,
        data: 'echo hi',
      })
      expect(secondPtyRuntime.handles[0]?.written).toContain('echo hi')
    } finally {
      await secondService.shutdown()
    }
  })

  it('creates terminals, shares them across sessions in the same manager, renames, resizes, and closes them', async () => {
    const { dataDir, service, ptyRuntime } = await createAndInitializeHarness()

    const created = await service.create(createRequest({ name: 'Build shell', cols: 100, rows: 40 }))
    const terminalId = created.terminal.terminalId

    expect(created.terminal).toMatchObject({
      sessionAgentId: 'profile-a',
      profileId: 'profile-a',
      name: 'Build shell',
      cols: 100,
      rows: 40,
      state: 'running',
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    })
    expect(typeof created.ticket).toBe('string')
    expect(service.listTerminals('session-a')).toHaveLength(1)
    expect(service.listTerminals('session-b')).toHaveLength(1)
    expect(service.listTerminals('profile-a')).toHaveLength(1)

    const renamed = await service.renameTerminal({
      terminalId,
      request: { sessionAgentId: 'session-a', name: 'Renamed terminal' },
    })
    expect(renamed.name).toBe('Renamed terminal')

    const resized = await service.resizeTerminal({
      terminalId,
      request: { sessionAgentId: 'session-b', cols: 132, rows: 48 },
    })
    expect(resized.cols).toBe(132)
    expect(resized.rows).toBe(48)
    expect(ptyRuntime.handles[0]?.resizeCalls).toEqual([{ cols: 132, rows: 48 }])

    await service.closeTerminal({ terminalId, sessionAgentId: 'session-b', reason: 'user_closed' })

    expect(service.getTerminal(terminalId)).toBeUndefined()
    await expect(
      stat(getTerminalMetaPath(dataDir, 'profile-a', 'profile-a', terminalId)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows creating terminals outside cwd allowlist roots', async () => {
    const { dataDir, resolver, service } = await createAndInitializeHarness()
    const outsideCwd = join(dataDir, 'outside-workspace')
    await mkdir(outsideCwd, { recursive: true })

    resolver.sessions.set('session-a', {
      sessionAgentId: 'profile-a',
      profileId: 'profile-a',
      cwd: outsideCwd,
    })

    const created = await service.create(createRequest({ sessionAgentId: 'session-a' }))
    expect(created.terminal.cwd).toBe(await realpath(outsideCwd))
  })

  it('falls back to the user home directory when the session cwd is invalid', async () => {
    const { resolver, service } = await createAndInitializeHarness()

    resolver.sessions.set('session-a', {
      sessionAgentId: 'profile-a',
      profileId: 'profile-a',
      cwd: join(tmpdir(), `missing-terminal-cwd-${Date.now()}`),
    })

    const created = await service.create(createRequest({ sessionAgentId: 'session-a' }))
    expect(created.terminal.cwd).toBe(await realpath(homedir()))
  })

  it('enforces the per-session terminal limit', async () => {
    const { service } = await createAndInitializeHarness({ maxTerminalsPerSession: 1 })

    await service.create(createRequest({ name: 'One' }))
    await expectTerminalServiceError(service.create(createRequest({ name: 'Two' })), 'TERMINAL_LIMIT_REACHED')
  })

  it('issues, validates, expires, and rejects websocket tickets', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-25T00:00:00.000Z'))
    const { service } = await createAndInitializeHarness()
    const created = await service.create(createRequest())

    const ticket = await service.issueWsTicket({
      terminalId: created.terminal.terminalId,
      sessionAgentId: created.terminal.sessionAgentId,
    })

    expect(
      service.validateWsTicket({
        terminalId: created.terminal.terminalId,
        sessionAgentId: created.terminal.sessionAgentId,
        ticket: ticket.ticket,
      }),
    ).toBe(true)

    vi.setSystemTime(new Date('2026-03-25T00:00:02.000Z'))
    expect(
      service.validateWsTicket({
        terminalId: created.terminal.terminalId,
        sessionAgentId: created.terminal.sessionAgentId,
        ticket: ticket.ticket,
      }),
    ).toBe(false)

    expect(
      service.validateWsTicket({
        terminalId: created.terminal.terminalId,
        sessionAgentId: created.terminal.sessionAgentId,
        ticket: 'invalid-ticket',
      }),
    ).toBe(false)
    expect(
      service.validateWsTicket({
        terminalId: 'other-terminal',
        sessionAgentId: created.terminal.sessionAgentId,
        ticket: ticket.ticket,
      }),
    ).toBe(false)
  })

  it('does not clean up manager-scoped terminals when a non-root session is deleted', async () => {
    const { service } = await createAndInitializeHarness()
    const first = await service.create(createRequest({ name: 'One' }))
    const second = await service.create(createRequest({ name: 'Two' }))
    const third = await service.create(createRequest({ sessionAgentId: 'session-b', name: 'Other session' }))

    const closedReasons: TerminalCloseReason[] = []
    service.on('terminal_closed', (event: { reason: TerminalCloseReason }) => {
      closedReasons.push(event.reason)
    })

    const removed = await service.cleanupSession('session-a', 'session_deleted')

    expect(removed).toBe(0)
    expect(service.getTerminal(first.terminal.terminalId)).toBeDefined()
    expect(service.getTerminal(second.terminal.terminalId)).toBeDefined()
    expect(service.getTerminal(third.terminal.terminalId)).toBeDefined()
    expect(service.listTerminals('session-b')).toHaveLength(3)
    expect(closedReasons).toEqual([])
  })

  it('transitions running terminals to exited and emits lifecycle events when the PTY exits', async () => {
    const { service, ptyRuntime } = await createAndInitializeHarness()
    const stateChanges: Array<{ previousState: TerminalLifecycleState; nextState: TerminalLifecycleState }> = []
    const updatedStates: TerminalLifecycleState[] = []
    const exitEvents: TerminalPtyExitEvent[] = []
    const controlMessages: TerminalWsServerControlMessage[] = []
    const outputChunks: string[] = []

    service.on('terminal_state_changed', (event: { previousState: TerminalLifecycleState; nextState: TerminalLifecycleState }) => {
      stateChanges.push({ previousState: event.previousState, nextState: event.nextState })
    })
    service.on('terminal_updated', (event: { terminal: { state: TerminalLifecycleState } }) => {
      updatedStates.push(event.terminal.state)
    })
    service.on('terminal_exit', (event: { exitCode: number | null; exitSignal: number | null }) => {
      exitEvents.push({ exitCode: event.exitCode, exitSignal: event.exitSignal })
    })

    const created = await service.create(createRequest({ name: 'Watcher' }))
    const handle = ptyRuntime.handles[0]!

    await service.attachClient({
      terminalId: created.terminal.terminalId,
      sessionAgentId: 'session-a',
      onData: (chunk) => {
        outputChunks.push(chunk.toString('utf8'))
      },
      onControl: (message) => {
        controlMessages.push(message)
      },
    })

    await handle.emitData('hello output')
    await handle.emitExit({ exitCode: 23, exitSignal: 15 })

    expect(service.getTerminal(created.terminal.terminalId)).toMatchObject({
      state: 'exited',
      exitCode: 23,
      exitSignal: 15,
      pid: null,
    })
    expect(stateChanges).toEqual([{ previousState: 'running', nextState: 'exited' }])
    expect(updatedStates).toContain('exited')
    expect(exitEvents).toEqual([{ exitCode: 23, exitSignal: 15 }])
    expect(outputChunks).toContain('hello output')
    expect(controlMessages).toContainEqual({ channel: 'control', type: 'exit', exitCode: 23, exitSignal: 15 })
  })

  it('rejects create requests once shutdown has started', async () => {
    const { service } = await createAndInitializeHarness()

    await service.shutdown()
    await expectTerminalServiceError(service.create(createRequest()), 'SERVICE_SHUTTING_DOWN')
  })

  it('rejects mutating operations while a terminal is already closing', async () => {
    const { service, ptyRuntime } = await createAndInitializeHarness()
    const created = await service.create(createRequest())
    ptyRuntime.killGate = createDeferred<void>()

    const closePromise = service.closeTerminal({
      terminalId: created.terminal.terminalId,
      sessionAgentId: 'session-a',
      reason: 'user_closed',
    })

    await expectTerminalServiceError(
      service.resizeTerminal({
        terminalId: created.terminal.terminalId,
        request: { sessionAgentId: 'session-a', cols: 140, rows: 50 },
      }),
      'TERMINAL_ALREADY_CLOSING',
    )

    ptyRuntime.killGate.resolve()
    await closePromise
  })

  it('returns terminal-not-found errors for operations on missing terminals', async () => {
    const { service } = await createAndInitializeHarness()

    await expectTerminalServiceError(
      service.renameTerminal({ terminalId: 'missing', request: { sessionAgentId: 'session-a', name: 'Nope' } }),
      'TERMINAL_NOT_FOUND',
    )
    await expectTerminalServiceError(
      service.resizeTerminal({ terminalId: 'missing', request: { sessionAgentId: 'session-a', cols: 80, rows: 24 } }),
      'TERMINAL_NOT_FOUND',
    )
    await expectTerminalServiceError(
      service.closeTerminal({ terminalId: 'missing', sessionAgentId: 'session-a', reason: 'user_closed' }),
      'TERMINAL_NOT_FOUND',
    )
  })

  it('rejects ticket issuance when PTY support is unavailable', async () => {
    const { service, ptyRuntime } = await createAndInitializeHarness()
    const created = await service.create(createRequest())
    ptyRuntime.available = false

    await expectTerminalServiceError(
      service.issueWsTicket({ terminalId: created.terminal.terminalId, sessionAgentId: 'session-a' }),
      'PTY_UNAVAILABLE',
    )
  })

  it('reconciles stale manager scopes by closing orphaned terminals', async () => {
    const { resolver, service } = await createAndInitializeHarness()
    const created = await service.create(createRequest())

    resolver.sessions.delete('session-a')
    resolver.sessions.delete('session-b')
    resolver.sessions.delete('profile-a')
    const result = await service.reconcileSessions()

    expect(result).toEqual({ removed: 1 })
    expect(service.getTerminal(created.terminal.terminalId)).toBeUndefined()
  })
})
