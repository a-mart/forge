import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskNotesStore, TASK_NOTES_LIMITS } from '../task-notes-store.js'
const failures = vi.hoisted(() => ({ rename: false }))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (failures.rename) { failures.rename = false; throw new Error('simulated atomic replace failure') }
    return actual.rename(...args)
  } }
})
let dataDir: string
const scope = { profileId: 'project', sessionAgentId: 'task', actorAgentId: 'task' }
const actor = (overrides = {}) => new TaskNotesStore({ dataDir }).forActor({ ...scope, ...overrides })
beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'forge-task-notes-')) })
afterEach(async () => { failures.rename = false; await rm(dataDir, { recursive: true, force: true }) })
describe('task-local notes', () => {
  it('restores exact text, revision and digest after restart separately from durable memory', async () => {
    const receipt = await actor().write({ path: 'checkpoint.md', text: 'Objective: fix navigation.\nNext: test ✨', expectedRevision: 0 })
    expect(await actor().read({ path: 'checkpoint.md' })).toMatchObject({ ...receipt, text: 'Objective: fix navigation.\nNext: test ✨' })
    const hint = await actor().checkpointHint()
    expect(hint).toMatchObject({ ready: true, empty: false, revision: 1, notes: [receipt] })
    expect(hint.hint).toContain('notes.read with path="checkpoint.md"')
  })
  it('isolates manager, worker, task, and profile namespaces', async () => {
    await actor().write({ path: 'checkpoint.md', text: 'Manager state' })
    for (const changed of [{ actorAgentId: 'worker' }, { sessionAgentId: 'another' }, { profileId: 'other' }]) {
      expect((await actor(changed).list()).notes).toEqual([])
      await expect(actor(changed).read({ path: 'checkpoint.md' })).rejects.toThrow('not found')
    }
  })
  it('serializes parallel appends through independently constructed store clients', async () => {
    await actor().write({ path: 'log.md', text: '' })
    await Promise.all(Array.from({ length: 30 }, (_, i) => actor().append({ path: 'log.md', text: `[${i}]` })))
    const read = await actor().read({ path: 'log.md' })
    expect(read.revision).toBe(31)
    for (let i = 0; i < 30; i++) expect(read.text.split(`[${i}]`)).toHaveLength(2)
  })
  it('rejects competing replacements and keeps successful state', async () => {
    await actor().write({ path: 'checkpoint.md', text: 'old' })
    const results = await Promise.allSettled([
      actor().write({ path: 'checkpoint.md', text: 'first', expectedRevision: 1 }),
      actor().write({ path: 'checkpoint.md', text: 'second', expectedRevision: 1 }),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect((await actor().read({ path: 'checkpoint.md', expectedRevision: 2 })).text).toBe('first')
    await expect(actor().read({ path: 'checkpoint.md', expectedRevision: 1 })).rejects.toThrow('revision conflict')
  })
  it('keeps unchanged writes idempotent while still enforcing expected revisions', async () => {
    const first = await actor().write({ path: 'runtime/continuity.md', text: 'unchanged' })
    const hint = await actor().checkpointHint()
    expect(await actor().write({ path: 'runtime/continuity.md', text: 'unchanged' })).toEqual(first)
    expect((await actor().checkpointHint()).digest).toBe(hint.digest)
    await expect(actor().write({ path: 'runtime/continuity.md', text: 'unchanged', expectedRevision: 0 })).rejects.toThrow('conflict')
  })
  it('keeps the previous snapshot on failed atomic replacement and recovers on retry', async () => {
    const notes = actor()
    await notes.write({ path: 'checkpoint.md', text: 'durable old state' })
    failures.rename = true
    await expect(notes.write({ path: 'checkpoint.md', text: 'uncommitted state' })).rejects.toThrow('replace failure')
    expect((await actor().read({ path: 'checkpoint.md' })).text).toBe('durable old state')
    await notes.append({ path: 'checkpoint.md', text: '\nretry works' })
    expect((await actor().read({ path: 'checkpoint.md' })).revision).toBe(2)
  })
  it('returns resumable bounded reads and literal case-sensitive matches with exact offsets', async () => {
    await actor().write({ path: 'findings/tests.md', text: 'Alpha foo_bar foo-bar\nAlpha' })
    const first = await actor().read({ path: 'findings/tests.md', maxChars: 8 })
    expect(first).toMatchObject({ text: 'Alpha fo', nextOffset: 8, totalChars: 27 })
    expect((await actor().read({ path: first.path, offset: first.nextOffset })).text).toBe('o_bar foo-bar\nAlpha')
    expect((await actor().search({ query: 'foo-bar' })).matches).toMatchObject([{ path: first.path, offset: 14 }])
    expect((await actor().search({ query: 'alpha' })).matches).toEqual([])
    expect(await actor().search({ query: 'Alpha', limit: 1 })).toMatchObject({ truncated: true, matches: [{ offset: 0 }] })
  })
  it('lists by stable virtual path with prefix and cursor', async () => {
    for (const path of ['z.md', 'findings/b.md', 'findings/a.md']) await actor().write({ path, text: path })
    const first = await actor().list({ prefix: 'findings/', limit: 1 })
    expect(first.notes.map(note => note.path)).toEqual(['findings/a.md'])
    const second = await actor().list({ prefix: 'findings/', cursor: first.nextCursor, limit: 1 })
    expect(second.notes.map(note => note.path)).toEqual(['findings/b.md'])
    expect(second.nextCursor).toBeUndefined()
  })
  it('enforces byte quotas without overwriting state and reserves runtime capacity', async () => {
    await actor().write({ path: 'checkpoint.md', text: 'keep me' })
    await expect(actor().append({ path: 'checkpoint.md', text: 'x'.repeat(TASK_NOTES_LIMITS.noteBytes) })).rejects.toThrow()
    await expect(actor().write({ path: 'wide.md', text: '✨'.repeat(TASK_NOTES_LIMITS.noteBytes / 2) })).rejects.toThrow()
    expect((await actor().read({ path: 'checkpoint.md' })).text).toBe('keep me')
    for (let i = 0; i < 5; i++) await actor().write({ path: `large-${i}.md`, text: 'x'.repeat(TASK_NOTES_LIMITS.noteBytes) })
    await expect(actor().write({ path: 'too-many-bytes.md', text: 'x'.repeat(TASK_NOTES_LIMITS.noteBytes) })).rejects.toThrow('storage limit')
    await actor().write({ path: 'runtime/continuity.md', text: 'r'.repeat(TASK_NOTES_LIMITS.noteBytes) })
    expect((await actor().read({ path: 'runtime/continuity.md' })).bytes).toBe(TASK_NOTES_LIMITS.noteBytes)
  })
  it('reserves a runtime file slot independently of byte capacity', async () => {
    for (let i = 0; i < TASK_NOTES_LIMITS.notes - 2; i++) await actor().write({ path: `${i}.md`, text: '' })
    await expect(actor().write({ path: 'overflow.md', text: '' })).rejects.toThrow('reserved')
    await actor().write({ path: 'runtime/continuity.md', text: 'recovery' })
    await actor().write({ path: 'runtime/continuity-1.md', text: 'next recovery' })
    expect((await actor().list({ limit: 64 })).notes).toHaveLength(64)
  })
  it.each(['../escape', '/absolute', 'a/../b', 'a//b', 'a\\b', 'C:/escape', 'bad\u0000path', 'a/./b'])('rejects unsafe virtual path %j', async path => {
    await expect(actor().write({ path, text: 'denied' })).rejects.toThrow('virtual task note path')
  })
  it('rejects unsafe scope identifiers', () => {
    expect(() => actor({ actorAgentId: '../escape' })).toThrow()
    expect(() => actor({ profileId: ' project' })).toThrow()
  })
  it('rejects symlink files and directories without modifying their target', async () => {
    const notes = actor(); await notes.write({ path: 'checkpoint.md', text: 'safe' })
    const outside = join(dataDir, 'outside.json'); await writeFile(outside, 'private outside payload')
    await rm(notes.filePath); await symlink(outside, notes.filePath)
    expect((await notes.checkpointHint()).ready).toBe(false)
    await expect(notes.write({ path: 'checkpoint.md', text: 'replacement' })).rejects.toThrow('Unsafe')
    expect(await readFile(outside, 'utf8')).toBe('private outside payload')
    await rm(notes.directory, { recursive: true }); await symlink(dataDir, notes.directory, 'dir')
    await expect(notes.list()).rejects.toThrow('Unsafe')
  })
  it('fails readiness closed for corrupt notes and does not overwrite the evidence', async () => {
    const notes = actor(); await notes.write({ path: 'checkpoint.md', text: 'truth' })
    const snapshot = JSON.parse(await readFile(notes.filePath, 'utf8')); snapshot.notes[0].text = 'tampered'
    await writeFile(notes.filePath, JSON.stringify(snapshot))
    expect(await notes.checkpointHint()).toMatchObject({ ready: false, empty: false })
    await expect(notes.append({ path: 'checkpoint.md', text: 'oops' })).rejects.toThrow('Invalid')
    expect(JSON.parse(await readFile(notes.filePath, 'utf8')).notes[0].text).toBe('tampered')
  })
  it('retains the read entrypoint when the notes exceed the hint budget', async () => {
    await actor().write({ path: 'checkpoint.md', text: '✨'.repeat(20_000) })
    for (let i = 0; i < 20; i++) await actor().write({ path: `topic-${i}.md`, text: 'topic' })
    const hint = await actor().checkpointHint({ maxBytes: 512 })
    expect(Buffer.byteLength(hint.hint)).toBeLessThanOrEqual(512)
    expect(hint.hint).toContain('notes.read with path="checkpoint.md"')
    expect(hint.notes).toHaveLength(21)
  })
  it('keeps runtime slot metadata out of the agent hint while retaining complete readiness metadata', async () => {
    await actor().write({ path: 'checkpoint.md', text: 'Continue the task' })
    const before = await actor().checkpointHint()
    await actor().write({ path: 'runtime/continuity-0.md', text: 'Runtime state' })
    await actor().write({ path: 'runtime/continuity-1.md', text: 'Next runtime state' })
    const after = await actor().checkpointHint()
    expect(after.hint).toBe(before.hint)
    expect(after.notes).toHaveLength(3)
    expect(after.hint).not.toContain('runtime/')
  })
  it('forks the captured snapshot with provenance into an independent namespace', async () => {
    await actor().write({ path: 'checkpoint.md', text: 'accepted boundary' })
    const snapshot = await actor().snapshot()
    await actor().write({ path: 'checkpoint.md', text: 'later source state' })
    const fork = actor({ sessionAgentId: 'fork', actorAgentId: 'fork' }); await fork.restoreFork(snapshot)
    expect((await fork.read({ path: 'checkpoint.md' })).text).toBe('accepted boundary')
    expect((await fork.list()).provenance).toMatchObject({ source: scope })
    await fork.write({ path: 'checkpoint.md', text: 'independent fork' })
    expect((await actor().read({ path: 'checkpoint.md' })).text).toBe('later source state')
    await expect(fork.restoreFork(snapshot)).rejects.toThrow('already exist')
  })
  it('historical forks omit later notes and explain the boundary', async () => {
    await actor().write({ path: 'checkpoint.md', text: 'must not leak into past' })
    const fork = actor({ sessionAgentId: 'historical', actorAgentId: 'historical' })
    await fork.restoreFork(await actor().snapshot(), { fromMessageId: 'old-message' })
    expect(await fork.list()).toMatchObject({ notes: [], provenance: { fromMessageId: 'old-message', notesOmitted: 'historical_boundary' } })
  })
  it('conversation clear removes all actors while leaving other tasks intact', async () => {
    await actor().write({ path: 'checkpoint.md', text: 'manager' })
    await actor({ actorAgentId: 'worker' }).write({ path: 'checkpoint.md', text: 'worker' })
    await actor({ sessionAgentId: 'other' }).write({ path: 'checkpoint.md', text: 'unrelated' })
    await new TaskNotesStore({ dataDir }).clearSession(scope.profileId, scope.sessionAgentId)
    expect(await actor().checkpointHint()).toMatchObject({ ready: true, empty: true })
    expect((await actor({ actorAgentId: 'worker' }).list()).notes).toEqual([])
    expect((await actor({ sessionAgentId: 'other' }).read({ path: 'checkpoint.md' })).text).toBe('unrelated')
    await actor().write({ path: 'checkpoint.md', text: 'new conversation' })
    expect((await actor().read({ path: 'checkpoint.md' })).text).toBe('new conversation')
  })
})
