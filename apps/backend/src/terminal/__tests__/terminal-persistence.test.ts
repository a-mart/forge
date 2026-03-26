import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { TerminalMeta } from '@forge/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getTerminalLogPath,
  getTerminalMetaPath,
  getTerminalSnapshotPath,
} from '../../swarm/data-paths.js'
import { TerminalPersistence } from '../terminal-persistence.js'

const createdDirs: string[] = []

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function createMeta(overrides: Partial<TerminalMeta> = {}): TerminalMeta {
  return {
    version: 1,
    terminalId: overrides.terminalId ?? 'terminal-1',
    sessionAgentId: overrides.sessionAgentId ?? 'manager-1',
    profileId: overrides.profileId ?? 'profile-1',
    name: overrides.name ?? 'Terminal 1',
    shell: overrides.shell ?? '/bin/sh',
    shellArgs: overrides.shellArgs ?? ['-i'],
    cwd: overrides.cwd ?? '/tmp',
    cols: overrides.cols ?? 80,
    rows: overrides.rows ?? 24,
    state: overrides.state ?? 'running',
    pid: overrides.pid ?? 123,
    exitCode: overrides.exitCode ?? null,
    exitSignal: overrides.exitSignal ?? null,
    checkpointSeq: overrides.checkpointSeq ?? 0,
    nextSeq: overrides.nextSeq ?? 1,
    recoveredFromPersistence: overrides.recoveredFromPersistence ?? false,
    createdAt: overrides.createdAt ?? '2026-03-25T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-03-25T00:00:00.000Z',
  }
}

async function createPersistence(): Promise<{ dataDir: string; persistence: TerminalPersistence }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'terminal-persistence-'))
  createdDirs.push(dataDir)
  return {
    dataDir,
    persistence: new TerminalPersistence({
      dataDir,
      scrollbackLines: 5_000,
      journalMaxBytes: 1_048_576,
    }),
  }
}

describe('TerminalPersistence', () => {
  it('creates a headless mirror and writes snapshot content from PTY output', async () => {
    const { dataDir, persistence } = await createPersistence()
    const meta = createMeta()

    persistence.createMirror(meta)
    await persistence.writeToMirror(meta.terminalId, Buffer.from('hello\r\nworld', 'utf8'))
    await persistence.writeSnapshot(meta)

    const snapshot = await persistence.readSnapshot(meta)
    expect(snapshot).toContain('hello')
    expect(snapshot).toContain('world')
    expect(await readFile(getTerminalSnapshotPath(dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId), 'utf8')).toBe(
      snapshot,
    )
  })

  it('serializes and deserializes snapshot state through restoreMirror', async () => {
    const first = await createPersistence()
    const second = await createPersistence()
    const meta = createMeta({ checkpointSeq: 0 })

    first.persistence.createMirror(meta)
    await first.persistence.writeToMirror(meta.terminalId, Buffer.from('line 1\r\nline 2', 'utf8'))
    await first.persistence.writeSnapshot(meta)

    const snapshotPath = getTerminalSnapshotPath(first.dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId)
    const copiedSnapshotPath = getTerminalSnapshotPath(second.dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId)
    await mkdir(dirname(copiedSnapshotPath), { recursive: true })
    await writeFile(copiedSnapshotPath, await readFile(snapshotPath, 'utf8'), 'utf8')

    const restored = await second.persistence.restoreMirror(meta)
    await second.persistence.writeSnapshot(meta)
    const secondSnapshot = await second.persistence.readSnapshot(meta)

    expect(restored.replay.toString('utf8')).toContain('line 1')
    expect(restored.replay.toString('utf8')).toContain('line 2')
    expect(secondSnapshot).toContain('line 1')
    expect(secondSnapshot).toContain('line 2')
  })

  it('appends journal entries with sequence numbers and reads deltas after a given seq', async () => {
    const { dataDir, persistence } = await createPersistence()
    const meta = createMeta()

    const firstBytes = await persistence.appendJournal(meta, 1, Buffer.from('one', 'utf8'))
    const secondBytes = await persistence.appendJournal(meta, 2, Buffer.from('two', 'utf8'))
    const thirdBytes = await persistence.appendJournal(meta, 3, Buffer.from('three', 'utf8'))

    const entries = await persistence.readJournalDelta(meta, 1)

    expect(entries).toEqual([
      { seq: 2, dataBase64: Buffer.from('two').toString('base64') },
      { seq: 3, dataBase64: Buffer.from('three').toString('base64') },
    ])
    expect(await persistence.getJournalSize(meta)).toBe(firstBytes + secondBytes + thirdBytes)
    expect(await readFile(getTerminalLogPath(dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId), 'utf8')).toContain(
      '"seq":3',
    )
  })

  it('truncates the rolling journal after checkpointing', async () => {
    const { persistence } = await createPersistence()
    const meta = createMeta()

    await persistence.appendJournal(meta, 1, Buffer.from('one', 'utf8'))
    await persistence.appendJournal(meta, 2, Buffer.from('two', 'utf8'))
    expect(await persistence.getJournalSize(meta)).toBeGreaterThan(0)

    await persistence.truncateJournal(meta)

    expect(await persistence.getJournalSize(meta)).toBe(0)
    expect(await persistence.readJournalDelta(meta, 0)).toEqual([])
  })

  it('restores state by replaying snapshot data plus journal delta after checkpointSeq', async () => {
    const source = await createPersistence()
    const restored = await createPersistence()
    const meta = createMeta({ checkpointSeq: 2, nextSeq: 5 })

    source.persistence.createMirror(meta)
    await source.persistence.writeToMirror(meta.terminalId, Buffer.from('snapshot line\r\n', 'utf8'))
    await source.persistence.writeSnapshot(meta)
    await source.persistence.appendJournal(meta, 1, Buffer.from('ignored-before-checkpoint', 'utf8'))
    await source.persistence.appendJournal(meta, 3, Buffer.from('delta a\r\n', 'utf8'))
    await source.persistence.appendJournal(meta, 4, Buffer.from('delta b', 'utf8'))

    const restoredSnapshotPath = getTerminalSnapshotPath(restored.dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId)
    const restoredLogPath = getTerminalLogPath(restored.dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId)
    await mkdir(dirname(restoredSnapshotPath), { recursive: true })
    await writeFile(restoredSnapshotPath, (await source.persistence.readSnapshot(meta)) ?? '', 'utf8')
    await writeFile(
      restoredLogPath,
      await readFile(getTerminalLogPath(source.dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId), 'utf8'),
      'utf8',
    )

    const replayed = await restored.persistence.restoreMirror(meta)
    const text = replayed.replay.toString('utf8')

    expect(text).toContain('snapshot line')
    expect(text).toContain('delta a')
    expect(text).toContain('delta b')
    expect(text).not.toContain('ignored-before-checkpoint')
    expect(replayed.lastSeq).toBe(4)
  })

  it('restores cleanly when the journal is empty', async () => {
    const { persistence } = await createPersistence()
    const meta = createMeta({ checkpointSeq: 7 })

    persistence.createMirror(meta)
    await persistence.writeToMirror(meta.terminalId, Buffer.from('snapshot only', 'utf8'))
    await persistence.writeSnapshot(meta)

    const restored = await persistence.restoreMirror(meta)

    expect(restored.replay.toString('utf8')).toContain('snapshot only')
    expect(restored.lastSeq).toBe(7)
  })

  it('restores from journal-only state when no snapshot exists', async () => {
    const { persistence } = await createPersistence()
    const meta = createMeta({ checkpointSeq: 0 })

    await persistence.appendJournal(meta, 1, Buffer.from('journal a\r\n', 'utf8'))
    await persistence.appendJournal(meta, 2, Buffer.from('journal b', 'utf8'))

    const restored = await persistence.restoreMirror(meta)

    expect(restored.replay.toString('utf8')).toContain('journal a')
    expect(restored.replay.toString('utf8')).toContain('journal b')
    expect(restored.lastSeq).toBe(2)
  })

  it('handles missing and non-VT snapshot content without crashing restore', async () => {
    const { dataDir, persistence } = await createPersistence()
    const meta = createMeta({ checkpointSeq: 0 })

    await persistence.appendJournal(meta, 1, Buffer.from('journal only', 'utf8'))
    const missingSnapshotRestore = await persistence.restoreMirror(meta)
    expect(missingSnapshotRestore.replay.toString('utf8')).toContain('journal only')

    await writeFile(
      getTerminalSnapshotPath(dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId),
      'not-valid-vt-\u0000-data',
      'utf8',
    )

    const corruptSnapshotRestore = await persistence.restoreMirror(meta)
    expect(corruptSnapshotRestore.replay.toString('utf8')).toContain('not-valid-vt')
    expect(corruptSnapshotRestore.replay.toString('utf8')).toContain('journal only')
  })

  it('saves and loads terminal meta round-trip', async () => {
    const { dataDir, persistence } = await createPersistence()
    const meta = createMeta({ terminalId: 'terminal-meta', name: 'Build terminal', nextSeq: 42 })

    await persistence.saveMeta(meta)
    const loaded = await persistence.loadMeta(
      getTerminalMetaPath(dataDir, meta.profileId, meta.sessionAgentId, meta.terminalId),
    )

    expect(loaded).toEqual(meta)
  })

  it('serializes large scrollback snapshots without pathological slowdown', async () => {
    const { persistence } = await createPersistence()
    const meta = createMeta({ terminalId: 'terminal-big', cols: 120, rows: 40 })

    persistence.createMirror(meta)
    const payload = Array.from({ length: 1_500 }, (_, index) => `line-${index} ${'x'.repeat(80)}\r\n`).join('')
    await persistence.writeToMirror(meta.terminalId, Buffer.from(payload, 'utf8'))

    const start = performance.now()
    await persistence.writeSnapshot(meta)
    const elapsedMs = performance.now() - start
    const snapshot = await persistence.readSnapshot(meta)

    expect(snapshot).toContain('line-1499')
    expect(elapsedMs).toBeLessThan(500)
  })
})
