import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  TerminalCloseReason,
  TerminalCreateRequest,
  TerminalLifecycleState,
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
  killError: Error | null = null
  killErrorPids = new Set<number>()

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
    if (this.killError && (this.killErrorPids.size === 0 || this.killErrorPids.has(handle.pid))) {
      throw this.killError
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
  maxTerminalsPerManager?: number
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
      maxTerminalsPerManager: options.maxTerminalsPerManager ?? 10,
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
  maxTerminalsPerManager?: number
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
        maxTerminalsPerManager: 10,
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
    expect(service.validateWsTicket({
      terminalId,
      sessionAgentId: 'profile-a',
      requesterAgentId: 'session-a',
      ticket: created.ticket,
    })).toBe(true)
    expect(service.validateWsTicket({
      terminalId,
      sessionAgentId: 'profile-a',
      requesterAgentId: 'profile-a',
      ticket: created.ticket,
    })).toBe(false)
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

  it('does not emit terminal_created or terminal_updated when archive suspend races before initial ticket issuance', async () => {
    const { resolver, service } = await createAndInitializeHarness()
    const createdEvents: unknown[] = []
    const updatedEvents: unknown[] = []
    service.on('terminal_created', (event) => createdEvents.push(event))
    service.on('terminal_updated', (event) => updatedEvents.push(event))

    const persistence = (service as unknown as { persistence: TerminalPersistence }).persistence
    const originalSaveMeta = persistence.saveMeta.bind(persistence)
    const saveSpy = vi.spyOn(persistence, 'saveMeta')
    let raced = false
    saveSpy.mockImplementation(async (meta) => {
      await originalSaveMeta(meta)
      if (!raced && meta.state === 'running') {
        raced = true
        await expect(service.suspendSessionPreserving('profile-a')).resolves.toBe(0)
        const requester = resolver.sessions.get('session-a')
        if (requester) {
          resolver.sessions.set('session-a', { ...requester, archived: true })
        }
      }
    })

    try {
      await expect(service.create(createRequest({ sessionAgentId: 'session-a' }))).rejects.toMatchObject({
        code: 'SESSION_ARCHIVED',
      })
      expect(createdEvents).toEqual([])
      expect(updatedEvents).toEqual([])
      expect(service.listTerminals('session-b')).toEqual([])
      expect(Array.from((service as unknown as { terminals: Map<string, unknown> }).terminals.values())).toEqual([])
    } finally {
      saveSpy.mockRestore()
    }
  })

  it('suspends running terminals for archived project scopes while preserving terminal persistence', async () => {
    const { dataDir, service, ptyRuntime } = await createAndInitializeHarness()

    const created = await service.create(createRequest({ sessionAgentId: 'session-a' }))
    const terminalId = created.terminal.terminalId
    await ptyRuntime.handles[0]?.emitData('before archive')

    await expect(service.suspendSessionPreserving('profile-a')).resolves.toBe(1)

    expect(ptyRuntime.handles[0]?.killCalls).toEqual(['SIGHUP'])
    expect(ptyRuntime.handles[0]?.disposed).toBe(true)
    expect(service.getTerminal(terminalId)).toMatchObject({ state: 'exited', pid: null })
    const persisted = JSON.parse(await readFile(getTerminalMetaPath(dataDir, 'profile-a', 'profile-a', terminalId), 'utf8'))
    expect(persisted).toMatchObject({ state: 'exited', pid: null })
  })

  it('does not mark a terminal exited when archive suspension fails to kill the PTY', async () => {
    const { service, ptyRuntime } = await createAndInitializeHarness()
    const created = await service.create(createRequest({ sessionAgentId: 'session-a' }))
    ptyRuntime.killError = new Error('kill failed')

    await expect(service.suspendSessionPreserving('profile-a')).resolves.toBe(0)

    expect(service.getTerminal(created.terminal.terminalId)).toMatchObject({ state: 'running' })
    expect(ptyRuntime.handles[0]?.disposed).toBe(false)
  })

  it('continues suspending later terminals when one PTY kill fails', async () => {
    const { service, ptyRuntime } = await createAndInitializeHarness()
    const first = await service.create(createRequest({ sessionAgentId: 'session-a', name: 'first' }))
    const second = await service.create(createRequest({ sessionAgentId: 'session-a', name: 'second' }))
    ptyRuntime.killError = new Error('kill failed')
    ptyRuntime.killErrorPids.add(ptyRuntime.handles[0]!.pid)

    await expect(service.suspendSessionPreserving('profile-a')).resolves.toBe(1)

    expect(service.getTerminal(first.terminal.terminalId)).toMatchObject({ state: 'running' })
    expect(service.getTerminal(second.terminal.terminalId)).toMatchObject({ state: 'exited', pid: null })
    expect(ptyRuntime.handles[0]?.disposed).toBe(false)
    expect(ptyRuntime.handles[1]?.disposed).toBe(true)
  })

  it('repairs persisted metadata when first suspended terminal save fails once and continues later terminals', async () => {
    const { dataDir, service } = await createAndInitializeHarness()
    const first = await service.create(createRequest({ sessionAgentId: 'session-a', name: 'first' }))
    const second = await service.create(createRequest({ sessionAgentId: 'session-a', name: 'second' }))
    const persistence = (service as unknown as { persistence: TerminalPersistence }).persistence
    const originalSaveMeta = persistence.saveMeta.bind(persistence)
    const saveSpy = vi.spyOn(persistence, 'saveMeta')
    let failed = false
    saveSpy.mockImplementation(async (meta) => {
      if (!failed && meta.terminalId === first.terminal.terminalId && meta.state === 'exited') {
        failed = true
        throw new Error('save failed once')
      }
      return originalSaveMeta(meta)
    })

    try {
      await expect(service.suspendSessionPreserving('profile-a')).resolves.toBe(2)
      expect(service.getTerminal(first.terminal.terminalId)).toMatchObject({ state: 'exited', pid: null })
      expect(service.getTerminal(second.terminal.terminalId)).toMatchObject({ state: 'exited', pid: null })
      const firstMeta = JSON.parse(await readFile(getTerminalMetaPath(dataDir, 'profile-a', 'profile-a', first.terminal.terminalId), 'utf8'))
      expect(firstMeta).toMatchObject({ state: 'exited', pid: null })
    } finally {
      saveSpy.mockRestore()
    }
  })

  it('continues suspending later terminals when an earlier terminal is already closing', async () => {
    const { service } = await createAndInitializeHarness()
    const first = await service.create(createRequest({ sessionAgentId: 'session-a', name: 'closing' }))
    const second = await service.create(createRequest({ sessionAgentId: 'session-a', name: 'running' }))
    const runtimes = (service as unknown as { terminals: Map<string, { closing: boolean }> }).terminals
    runtimes.get(first.terminal.terminalId)!.closing = true
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      await expect(service.suspendSessionPreserving('profile-a')).resolves.toBe(1)
      expect(service.getTerminal(first.terminal.terminalId)).toMatchObject({ state: 'running' })
      expect(service.getTerminal(second.terminal.terminalId)).toMatchObject({ state: 'exited', pid: null })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to suspend archived terminal'))
    } finally {
      runtimes.get(first.terminal.terminalId)!.closing = false
      warnSpy.mockRestore()
    }
  })

  it('preserves already-exited terminal exit metadata across archive suspension and restore', async () => {
    const { dataDir, rootDir, service, ptyRuntime } = await createAndInitializeHarness()
    const created = await service.create(createRequest({ sessionAgentId: 'session-a' }))
    await ptyRuntime.handles[0]?.emitExit({ exitCode: 7, exitSignal: null })

    await expect(service.suspendSessionPreserving('profile-a')).resolves.toBe(0)
    expect(service.getTerminal(created.terminal.terminalId)).toMatchObject({ state: 'exited', exitCode: 7 })
    await service.shutdown()

    const resolver = new MapSessionResolver()
    resolver.sessions.set('profile-a', {
      sessionAgentId: 'profile-a',
      profileId: 'profile-a',
      cwd: join(rootDir, 'session-a'),
    })
    const restoredService = new TerminalService({
      dataDir,
      runtimeConfig: {
        enabled: true,
        maxTerminalsPerManager: 10,
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
      ptyRuntime: new FakePtyRuntime(),
      persistence: new TerminalPersistence({ dataDir, scrollbackLines: 5_000, journalMaxBytes: 1_048_576 }),
      cwdPolicy: { rootDir, allowlistRoots: [rootDir] },
    })

    try {
      await restoredService.initialize()
      expect(restoredService.getTerminal(created.terminal.terminalId)).toMatchObject({ state: 'exited', exitCode: 7 })
    } finally {
      await restoredService.shutdown()
    }
  })

  it('rehydrates preserved persisted terminals after an archived project is restored', async () => {
    const { dataDir, rootDir, service, ptyRuntime } = await createAndInitializeHarness()
    const created = await service.create(createRequest({ sessionAgentId: 'session-a' }))
    await ptyRuntime.handles[0]?.emitData('persisted output')
    await service.suspendSessionPreserving('profile-a')
    await service.shutdown()
    const metaPath = getTerminalMetaPath(dataDir, 'profile-a', 'profile-a', created.terminal.terminalId)
    const persistedBeforeArchivedBoot = JSON.parse(await readFile(metaPath, 'utf8'))
    await writeFile(
      metaPath,
      `${JSON.stringify({ ...persistedBeforeArchivedBoot, state: 'running', pid: 9999 }, null, 2)}\n`,
      'utf8',
    )

    const resolver = new MapSessionResolver()
    resolver.sessions.set('profile-a', {
      sessionAgentId: 'profile-a',
      profileId: 'profile-a',
      cwd: join(rootDir, 'session-a'),
      archived: true,
    })
    const archivedBootPtyRuntime = new FakePtyRuntime()
    const restoredService = new TerminalService({
      dataDir,
      runtimeConfig: {
        enabled: true,
        maxTerminalsPerManager: 10,
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
      ptyRuntime: archivedBootPtyRuntime,
      persistence: new TerminalPersistence({ dataDir, scrollbackLines: 5_000, journalMaxBytes: 1_048_576 }),
      cwdPolicy: { rootDir, allowlistRoots: [rootDir] },
    })

    try {
      await expect(restoredService.initialize()).resolves.toMatchObject({ skipped: 1 })
      expect(restoredService.getTerminal(created.terminal.terminalId)).toBeUndefined()
      const converted = JSON.parse(await readFile(metaPath, 'utf8'))
      expect(converted).toMatchObject({ state: 'exited', pid: null })
      expect(archivedBootPtyRuntime.orphanCleanupCalls).toEqual([[9999]])
      resolver.sessions.set('profile-a', {
        sessionAgentId: 'profile-a',
        profileId: 'profile-a',
        cwd: join(rootDir, 'session-a'),
      })
      await expect(restoredService.restorePersistedSession('profile-a')).resolves.toBe(1)
      expect(restoredService.getTerminal(created.terminal.terminalId)).toMatchObject({ state: 'exited' })
    } finally {
      await restoredService.shutdown()
    }
  })

  it('normalizes directly archived session-scoped terminals to active profile scope on startup', async () => {
    const { dataDir, rootDir, service } = await createAndInitializeHarness()
    const created = await service.create(createRequest({ sessionAgentId: 'session-a' }))
    await service.suspendSessionPreserving('profile-a')
    await service.shutdown()

    const profileMetaPath = getTerminalMetaPath(dataDir, 'profile-a', 'profile-a', created.terminal.terminalId)
    const legacyMetaPath = getTerminalMetaPath(dataDir, 'profile-a', 'session-a', created.terminal.terminalId)
    const persisted = JSON.parse(await readFile(profileMetaPath, 'utf8'))
    await rm(dirname(profileMetaPath), { recursive: true, force: true })
    await mkdir(dirname(legacyMetaPath), { recursive: true })
    await writeFile(
      legacyMetaPath,
      `${JSON.stringify({ ...persisted, sessionAgentId: 'session-a', state: 'exited', pid: null }, null, 2)}\n`,
      'utf8',
    )

    const resolver = new MapSessionResolver()
    resolver.sessions.set('session-a', {
      sessionAgentId: 'profile-a',
      profileId: 'profile-a',
      cwd: join(rootDir, 'session-a'),
      archived: true,
    })
    resolver.sessions.set('profile-a', {
      sessionAgentId: 'profile-a',
      profileId: 'profile-a',
      cwd: join(rootDir, 'session-a'),
      archived: false,
    })
    const restoredService = new TerminalService({
      dataDir,
      runtimeConfig: {
        enabled: true,
        maxTerminalsPerManager: 10,
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
      ptyRuntime: new FakePtyRuntime(),
      persistence: new TerminalPersistence({ dataDir, scrollbackLines: 5_000, journalMaxBytes: 1_048_576 }),
      cwdPolicy: { rootDir, allowlistRoots: [rootDir] },
    })

    try {
      await expect(restoredService.initialize()).resolves.toMatchObject({ restoredExited: 1, skipped: 0 })
      await expect(stat(legacyMetaPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(restoredService.getTerminal(created.terminal.terminalId)).toMatchObject({
        sessionAgentId: 'profile-a',
        state: 'exited',
      })
    } finally {
      await restoredService.shutdown()
    }
  })

  it('normalizes mis-scoped archived terminal metadata during startup repair', async () => {
    const { dataDir, rootDir, service } = await createAndInitializeHarness()
    const created = await service.create(createRequest({ sessionAgentId: 'session-a' }))
    await service.suspendSessionPreserving('profile-a')
    await service.shutdown()

    const profileMetaPath = getTerminalMetaPath(dataDir, 'profile-a', 'profile-a', created.terminal.terminalId)
    const legacyMetaPath = getTerminalMetaPath(dataDir, 'profile-a', 'session-a', created.terminal.terminalId)
    const persisted = JSON.parse(await readFile(profileMetaPath, 'utf8'))
    await rm(dirname(profileMetaPath), { recursive: true, force: true })
    await mkdir(dirname(legacyMetaPath), { recursive: true })
    await writeFile(
      legacyMetaPath,
      `${JSON.stringify({ ...persisted, sessionAgentId: 'session-a', state: 'running', pid: 2468 }, null, 2)}\n`,
      'utf8',
    )

    const resolver = new MapSessionResolver()
    resolver.sessions.set('session-a', {
      sessionAgentId: 'profile-a',
      profileId: 'profile-a',
      cwd: join(rootDir, 'session-a'),
      archived: true,
    })
    resolver.sessions.set('profile-a', {
      sessionAgentId: 'profile-a',
      profileId: 'profile-a',
      cwd: join(rootDir, 'session-a'),
      archived: true,
    })
    const restoredService = new TerminalService({
      dataDir,
      runtimeConfig: {
        enabled: true,
        maxTerminalsPerManager: 10,
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
      ptyRuntime: new FakePtyRuntime(),
      persistence: new TerminalPersistence({ dataDir, scrollbackLines: 5_000, journalMaxBytes: 1_048_576 }),
      cwdPolicy: { rootDir, allowlistRoots: [rootDir] },
    })

    try {
      await expect(restoredService.initialize()).resolves.toMatchObject({ skipped: 1 })
      await expect(stat(legacyMetaPath)).rejects.toMatchObject({ code: 'ENOENT' })
      const repaired = JSON.parse(await readFile(profileMetaPath, 'utf8'))
      expect(repaired).toMatchObject({ sessionAgentId: 'profile-a', state: 'exited', pid: null })
      resolver.sessions.set('profile-a', {
        sessionAgentId: 'profile-a',
        profileId: 'profile-a',
        cwd: join(rootDir, 'session-a'),
      })
      await expect(restoredService.restorePersistedSession('profile-a')).resolves.toBe(1)
      expect(restoredService.getTerminal(created.terminal.terminalId)).toMatchObject({ state: 'exited' })
    } finally {
      await restoredService.shutdown()
    }
  })

  it('does not reject startup when archived terminal repair save fails and later restore can retry', async () => {
    const { dataDir, rootDir, service } = await createAndInitializeHarness()
    const created = await service.create(createRequest({ sessionAgentId: 'session-a' }))
    await service.suspendSessionPreserving('profile-a')
    await service.shutdown()
    const metaPath = getTerminalMetaPath(dataDir, 'profile-a', 'profile-a', created.terminal.terminalId)
    const persistedBeforeArchivedBoot = JSON.parse(await readFile(metaPath, 'utf8'))
    await writeFile(metaPath, `${JSON.stringify({ ...persistedBeforeArchivedBoot, state: 'running', pid: 4321 }, null, 2)}\n`, 'utf8')

    const resolver = new MapSessionResolver()
    resolver.sessions.set('profile-a', {
      sessionAgentId: 'profile-a',
      profileId: 'profile-a',
      cwd: join(rootDir, 'session-a'),
      archived: true,
    })
    const persistence = new TerminalPersistence({ dataDir, scrollbackLines: 5_000, journalMaxBytes: 1_048_576 })
    const originalSaveMeta = persistence.saveMeta.bind(persistence)
    const saveSpy = vi.spyOn(persistence, 'saveMeta')
    let failed = false
    saveSpy.mockImplementation(async (meta) => {
      if (!failed && meta.terminalId === created.terminal.terminalId && meta.state === 'exited') {
        failed = true
        throw new Error('repair save failed')
      }
      return originalSaveMeta(meta)
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const archivedBootPtyRuntime = new FakePtyRuntime()
    const restoredService = new TerminalService({
      dataDir,
      runtimeConfig: {
        enabled: true,
        maxTerminalsPerManager: 10,
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
      ptyRuntime: archivedBootPtyRuntime,
      persistence,
      cwdPolicy: { rootDir, allowlistRoots: [rootDir] },
    })

    try {
      await expect(restoredService.initialize()).resolves.toMatchObject({ skipped: 1 })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to repair archived terminal'))
      expect(archivedBootPtyRuntime.orphanCleanupCalls).toEqual([[4321]])
      const stillStale = JSON.parse(await readFile(metaPath, 'utf8'))
      expect(stillStale).toMatchObject({ state: 'running', pid: 4321 })
      resolver.sessions.set('profile-a', {
        sessionAgentId: 'profile-a',
        profileId: 'profile-a',
        cwd: join(rootDir, 'session-a'),
      })
      await expect(restoredService.restorePersistedSession('profile-a')).resolves.toBe(1)
      expect(restoredService.getTerminal(created.terminal.terminalId)).toMatchObject({ state: 'exited', pid: null })
    } finally {
      warnSpy.mockRestore()
      saveSpy.mockRestore()
      await restoredService.shutdown()
    }
  })

  it('continues restoring preserved terminals when one persisted terminal restore fails', async () => {
    const { dataDir, rootDir, service } = await createAndInitializeHarness()
    const bad = await service.create(createRequest({ sessionAgentId: 'session-a', name: 'bad' }))
    const good = await service.create(createRequest({ sessionAgentId: 'session-a', name: 'good' }))
    await service.suspendSessionPreserving('profile-a')
    await service.shutdown()

    const resolver = new MapSessionResolver()
    resolver.sessions.set('profile-a', {
      sessionAgentId: 'profile-a',
      profileId: 'profile-a',
      cwd: join(rootDir, 'session-a'),
    })
    const persistence = new TerminalPersistence({ dataDir, scrollbackLines: 5_000, journalMaxBytes: 1_048_576 })
    const originalRestoreMirror = persistence.restoreMirror.bind(persistence)
    const restoreMirror = vi.spyOn(persistence, 'restoreMirror')
    restoreMirror.mockImplementation(async (meta) => {
      if (meta.terminalId === bad.terminal.terminalId) {
        throw new Error('restore failed')
      }
      return await originalRestoreMirror(meta)
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const restoredService = new TerminalService({
      dataDir,
      runtimeConfig: {
        enabled: true,
        maxTerminalsPerManager: 10,
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
      ptyRuntime: new FakePtyRuntime(),
      persistence,
      cwdPolicy: { rootDir, allowlistRoots: [rootDir] },
    })

    try {
      await expect(restoredService.restorePersistedSession('profile-a')).resolves.toBe(1)
      expect(restoredService.getTerminal(bad.terminal.terminalId)).toBeUndefined()
      expect(restoredService.getTerminal(good.terminal.terminalId)).toMatchObject({ state: 'exited' })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to restore preserved terminal'))
    } finally {
      warnSpy.mockRestore()
      restoreMirror.mockRestore()
      await restoredService.shutdown()
    }
  })

  it('rejects terminal operations for archived sessions without deleting existing terminals', async () => {
    const { service, resolver } = await createAndInitializeHarness()

    const created = await service.create(createRequest({ sessionAgentId: 'session-a' }))
    const archivedSession = resolver.sessions.get('session-a')
    const archivedScope = resolver.sessions.get('profile-a')
    if (archivedSession) {
      resolver.sessions.set('session-a', { ...archivedSession, archived: true })
    }
    if (archivedScope) {
      resolver.sessions.set('profile-a', {
        ...archivedScope,
        archived: false,
        terminalScopeArchived: false,
      })
    }

    await expect(service.create(createRequest({ sessionAgentId: 'session-a' }))).rejects.toMatchObject({
      code: 'SESSION_ARCHIVED',
    })
    await expect(
      service.issueWsTicket({
        terminalId: created.terminal.terminalId,
        sessionAgentId: created.terminal.sessionAgentId,
        requesterAgentId: 'session-a',
      }),
    ).rejects.toMatchObject({ code: 'SESSION_ARCHIVED' })
    await expect(
      service.closeTerminal({ terminalId: created.terminal.terminalId, sessionAgentId: 'session-a', reason: 'user_closed' }),
    ).rejects.toMatchObject({ code: 'SESSION_ARCHIVED' })
    const missingRequesterTicketRequest = {
      terminalId: created.terminal.terminalId,
      sessionAgentId: created.terminal.sessionAgentId,
    } as unknown as Parameters<typeof service.issueWsTicket>[0]
    await expect(
      service.issueWsTicket(missingRequesterTicketRequest),
    ).rejects.toMatchObject({ code: 'TERMINAL_SESSION_MISMATCH' })
    await expect(
      service.attachClient({
        terminalId: created.terminal.terminalId,
        sessionAgentId: 'session-a',
        onData: () => undefined,
        onControl: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_ARCHIVED' })
    await expect(
      service.issueWsTicket({
        terminalId: created.terminal.terminalId,
        sessionAgentId: created.terminal.sessionAgentId,
        requesterAgentId: 'session-b',
      }),
    ).resolves.toMatchObject({ ticket: expect.any(String) })
    await expect(
      service.issueWsTicket({
        terminalId: created.terminal.terminalId,
        sessionAgentId: created.terminal.sessionAgentId,
        requesterAgentId: 'profile-a',
      }),
    ).resolves.toMatchObject({ ticket: expect.any(String) })
    expect(service.listTerminals('session-a')).toHaveLength(1)
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
    const { service } = await createAndInitializeHarness({ maxTerminalsPerManager: 1 })

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
      requesterAgentId: 'session-a',
    })

    expect(
      service.validateWsTicket({
        terminalId: created.terminal.terminalId,
        sessionAgentId: created.terminal.sessionAgentId,
        requesterAgentId: 'session-a',
        ticket: ticket.ticket,
      }),
    ).toBe(true)

    vi.setSystemTime(new Date('2026-03-25T00:00:02.000Z'))
    expect(
      service.validateWsTicket({
        terminalId: created.terminal.terminalId,
        sessionAgentId: created.terminal.sessionAgentId,
        requesterAgentId: 'session-a',
        ticket: ticket.ticket,
      }),
    ).toBe(false)

    expect(
      service.validateWsTicket({
        terminalId: created.terminal.terminalId,
        sessionAgentId: created.terminal.sessionAgentId,
        requesterAgentId: 'session-a',
        ticket: 'invalid-ticket',
      }),
    ).toBe(false)
    expect(
      service.validateWsTicket({
        terminalId: 'other-terminal',
        sessionAgentId: created.terminal.sessionAgentId,
        requesterAgentId: 'session-a',
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

  it('cleans all terminals when manager scope is deleted', async () => {
    const { service } = await createAndInitializeHarness()
    const first = await service.create(createRequest({ name: 'One' }))
    const second = await service.create(createRequest({ sessionAgentId: 'session-b', name: 'Two' }))

    const closedReasons: TerminalCloseReason[] = []
    service.on('terminal_closed', (event: { reason: TerminalCloseReason }) => {
      closedReasons.push(event.reason)
    })

    const removed = await service.cleanupSession('profile-a', 'manager_deleted')

    expect(removed).toBe(2)
    expect(service.getTerminal(first.terminal.terminalId)).toBeUndefined()
    expect(service.getTerminal(second.terminal.terminalId)).toBeUndefined()
    expect(closedReasons).toEqual(['manager_deleted', 'manager_deleted'])
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
      service.issueWsTicket({
        terminalId: created.terminal.terminalId,
        sessionAgentId: created.terminal.sessionAgentId,
        requesterAgentId: 'session-a',
      }),
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
