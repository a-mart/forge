import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalMeta } from '@forge/protocol'
import { TerminalPersistence } from '../terminal-persistence.js'
import { TerminalServiceRuntimeController } from '../terminal-service-runtime.js'
import type { ActiveTerminalRuntime, TerminalServiceContext } from '../terminal-service-types.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function createMeta(overrides: Partial<TerminalMeta> = {}): TerminalMeta {
  return {
    version: 1, terminalId: 'terminal-1', sessionAgentId: 'session-1', profileId: 'profile-1', name: 'Shell',
    shell: '/bin/sh', shellArgs: [], cwd: '/tmp', cols: 80, rows: 24, state: 'running', pid: 1,
    exitCode: null, exitSignal: null, checkpointSeq: 0, nextSeq: 1, recoveredFromPersistence: false,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

function runtime(meta: TerminalMeta): ActiveTerminalRuntime {
  return {
    meta,
    descriptor: { ...meta, state: meta.state },
    session: { sessionAgentId: meta.sessionAgentId, profileId: meta.profileId, cwd: meta.cwd },
    pty: null,
    closing: false,
    closed: false,
    published: true,
    finalizePromise: null,
    snapshotInterval: null,
    attachedClients: new Set(),
    journalBytes: 0,
    lock: Promise.resolve(),
  } as ActiveTerminalRuntime
}

function controllerFor(
  persistence: TerminalPersistence,
  active: ActiveTerminalRuntime,
  overrides: Partial<TerminalServiceContext> = {},
): TerminalServiceRuntimeController {
  const context = {
    persistence,
    runtimeConfig: {
      journalMaxBytes: 1,
      snapshotIntervalMs: 60_000,
      shutdownSnapshotTimeoutMs: 1_000,
    },
    terminals: new Map([[active.meta.terminalId, active]]),
    timestamp: () => '2026-01-01T00:00:01.000Z',
    withRuntimeLock: async <T>(_runtime: ActiveTerminalRuntime, fn: () => Promise<T>) => fn(),
    emit: vi.fn(),
    transitionDescriptorState: (descriptor: ActiveTerminalRuntime['descriptor']) => descriptor,
    ...overrides,
  } as unknown as TerminalServiceContext
  return new TerminalServiceRuntimeController(context)
}

describe('terminal checkpoint failure and restart recovery', () => {
  it('keeps the previous snapshot valid when snapshot writing fails, and replays journal output after restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'terminal-checkpoint-failure-'))
    dirs.push(dataDir)
    const persistence = new TerminalPersistence({ dataDir, scrollbackLines: 5_000, journalMaxBytes: 1 })
    const meta = createMeta()
    persistence.createMirror(meta)
    await persistence.writeToMirror(meta.terminalId, Buffer.from('before\r\n'))
    await persistence.writeSnapshot(meta)
    await persistence.saveMeta(meta)

    const active = runtime(meta)
    const failing = Object.create(persistence) as TerminalPersistence
    failing.writeSnapshot = vi.fn(async () => { throw new Error('snapshot disk full') })
    const controller = controllerFor(failing, active)
    await expect(controller.handlePtyOutput(meta.terminalId, Buffer.from('after\r\n'))).rejects.toThrow('snapshot disk full')

    const restart = new TerminalPersistence({ dataDir, scrollbackLines: 5_000, journalMaxBytes: 1 })
    const restored = await restart.restoreMirror(meta)
    expect(restored.replay.toString()).toContain('before')
    expect(restored.replay.toString()).toContain('after')
    expect(restored.lastSeq).toBe(1)
  })

  it.each(['truncateJournal', 'saveMeta'] as const)('surfaces %s checkpoint failures without swallowing them', async (operation) => {
    const dataDir = await mkdtemp(join(tmpdir(), `terminal-checkpoint-${operation}-`))
    dirs.push(dataDir)
    const persistence = new TerminalPersistence({ dataDir, scrollbackLines: 5_000, journalMaxBytes: 1 })
    const meta = createMeta()
    persistence.createMirror(meta)
    const active = runtime(meta)
    const failing = Object.create(persistence) as TerminalPersistence
    failing[operation] = vi.fn(async () => { throw new Error(`${operation} failed`) })
    const controller = controllerFor(failing, active)
    await expect(controller.snapshotRuntime(active)).rejects.toThrow(`${operation} failed`)
    expect(failing[operation]).toHaveBeenCalledTimes(1)
  })
})
