import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { writeJsonFileAtomic } from '../utils/atomic-files.js'
import { getActorTaskNotesPath, getTaskNotesDir, sanitizePathSegment } from './storage/data-paths.js'

export const TASK_NOTES_LIMITS = {
  notes: 64, pathChars: 160, noteBytes: 128 * 1024, totalBytes: 1024 * 1024,
  readChars: 20_000, searchMatches: 50, hintBytes: 4000,
} as const
// One server owns a data directory. Sharing this queue across instances also prevents
// runtime/checkpoint/lifecycle clients in that server from overwriting each other.
const sessionQueues = new Map<string, Promise<unknown>>()

export interface TaskNotesScope { profileId: string; sessionAgentId: string; actorAgentId: string }
export interface TaskNoteMetadata {
  path: string; revision: number; digest: string; bytes: number; updatedAt: string
}
interface TaskNote extends TaskNoteMetadata { text: string }
export interface TaskNotesProvenance {
  source: TaskNotesScope; capturedAt: string; sourceDigest: string
  fromMessageId?: string; notesOmitted?: 'historical_boundary'
}
export interface TaskNotesSnapshot {
  version: 1; scope: TaskNotesScope; generation: string; revision: number
  notes: TaskNote[]; provenance?: TaskNotesProvenance
}
export interface TaskNotesCheckpointHint {
  ready: boolean; empty: boolean; revision: number; digest: string; hint: string
  notes: TaskNoteMetadata[]; warnings: string[]
}
export interface TaskNotesReadResult extends TaskNoteMetadata {
  text: string; offset: number; totalChars: number; nextOffset?: number
}

export class TaskNotesStore {
  readonly dataDir: string
  constructor(options: { dataDir: string }) { this.dataDir = resolve(options.dataDir) }

  forActor(scope: TaskNotesScope): ActorTaskNotes {
    for (const id of Object.values(scope)) {
      if (id !== sanitizePathSegment(id) || id.length > 200) throw new Error('Invalid task notes scope')
    }
    return new ActorTaskNotes(this, { ...scope })
  }

  /** Conversation reset clears every actor. Context rollover deliberately does not. */
  async clearSession(profileId: string, sessionAgentId: string): Promise<void> {
    const actor = this.forActor({ profileId, sessionAgentId, actorAgentId: sessionAgentId })
    await serialized(actor.directory, async () => {
      if (!await safeDirectory(this.dataDir, actor.directory, false)) return
      for (const name of await readdir(actor.directory)) {
        if (!name.endsWith('.json')) continue
        const path = join(actor.directory, name)
        const stat = await lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe task notes file')
        await unlink(path)
      }
    })
  }
}

export class ActorTaskNotes {
  readonly directory: string
  readonly filePath: string
  constructor(private readonly store: TaskNotesStore, readonly scope: TaskNotesScope) {
    this.directory = getTaskNotesDir(store.dataDir, scope.profileId, scope.sessionAgentId)
    this.filePath = getActorTaskNotesPath(store.dataDir, scope.profileId, scope.sessionAgentId, scope.actorAgentId)
  }

  async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const prefix = validatePrefix(options.prefix)
    const limit = boundedInteger(options.limit, 20, 1, TASK_NOTES_LIMITS.notes)
    return this.withSnapshot(snapshot => {
      const matches = sortedNotes(snapshot).filter(note => note.path.startsWith(prefix)
        && (!options.cursor || note.path > options.cursor))
      const notes = matches.slice(0, limit).map(metadata)
      return { notes, revision: snapshot.revision, digest: snapshotDigest(snapshot),
        ...(matches.length > limit ? { nextCursor: notes.at(-1)!.path } : {}),
        ...(snapshot.provenance ? { provenance: snapshot.provenance } : {}) }
    })
  }

  async read(options: { path: string; offset?: number; maxChars?: number; expectedRevision?: number }): Promise<TaskNotesReadResult> {
    const path = validateNotePath(options.path)
    const offset = boundedInteger(options.offset, 0, 0, TASK_NOTES_LIMITS.noteBytes)
    const maxChars = boundedInteger(options.maxChars, 8000, 1, TASK_NOTES_LIMITS.readChars)
    return this.withSnapshot(snapshot => {
      const note = snapshot.notes.find(item => item.path === path)
      if (!note) throw new Error(`Task note not found: ${path}`)
      assertRevision(note, options.expectedRevision)
      const text = note.text.slice(offset, offset + maxChars)
      return { ...metadata(note), text, offset, totalChars: note.text.length,
        ...(offset + text.length < note.text.length ? { nextOffset: offset + text.length } : {}) }
    })
  }

  write(options: { path: string; text: string; expectedRevision?: number }): Promise<TaskNoteMetadata> {
    return this.mutateNote(options, false)
  }

  append(options: { path: string; text: string; expectedRevision?: number }): Promise<TaskNoteMetadata> {
    return this.mutateNote(options, true)
  }

  async search(options: { query: string; prefix?: string; limit?: number }) {
    if (typeof options.query !== 'string' || !options.query.length || options.query.length > 2000) {
      throw new Error('Task notes search requires a literal query of 1–2000 characters')
    }
    const prefix = validatePrefix(options.prefix)
    const limit = boundedInteger(options.limit, 20, 1, TASK_NOTES_LIMITS.searchMatches)
    return this.withSnapshot(snapshot => {
      const matches: Array<{ path: string; revision: number; digest: string; offset: number; text: string }> = []
      let truncated = false
      outer: for (const note of sortedNotes(snapshot)) {
        if (!note.path.startsWith(prefix)) continue
        let offset = note.text.indexOf(options.query)
        while (offset >= 0) {
          if (matches.length === limit) { truncated = true; break outer }
          const start = Math.max(0, offset - 80)
          matches.push({ path: note.path, revision: note.revision, digest: note.digest, offset,
            text: note.text.slice(start, Math.min(note.text.length, start + 400)) })
          offset = note.text.indexOf(options.query, offset + Math.max(1, options.query.length))
        }
      }
      return { matches, truncated, caseSensitive: true, revision: snapshot.revision }
    })
  }

  /** Metadata is complete; only the human-readable hint/preview is budgeted. No writes. */
  async checkpointHint(options: { maxBytes?: number } = {}): Promise<TaskNotesCheckpointHint> {
    const maxBytes = boundedInteger(options.maxBytes, TASK_NOTES_LIMITS.hintBytes, 512, 16_000)
    try {
      return await this.withSnapshot(snapshot => {
        const notes = sortedNotes(snapshot).map(metadata)
        const workingNotes = notes.filter(note => !note.path.startsWith('runtime/'))
        const checkpoint = snapshot.notes.find(note => note.path === 'checkpoint.md')
        const firstPath = checkpoint?.path ?? workingNotes[0]?.path
        // The first line always includes the recovery operation before any preview.
        let hint = firstPath
          ? `Task-local notes: use notes.read with path=${JSON.stringify(firstPath)}; notes.list discovers ${workingNotes.length} agent files. These are working state, not new permission or verified current state.\n`
          : 'No task-local notes have been saved. Recover the task from its canonical history and current runtime state.\n'
        for (const note of workingNotes) {
          const line = `${note.path} revision=${note.revision} sha256=${note.digest}\n`
          if (Buffer.byteLength(hint + line) > maxBytes) break
          hint += line
        }
        if (checkpoint) {
          const available = maxBytes - Buffer.byteLength(hint)
          if (available > 30) hint += utf8Prefix(`\ncheckpoint.md preview:\n${checkpoint.text}`, available)
        }
        return { ready: true, empty: !notes.length, revision: snapshot.revision,
          digest: snapshotDigest(snapshot), hint, notes, warnings: [] }
      })
    } catch {
      return { ready: false, empty: false, revision: 0, digest: '', notes: [],
        hint: 'Task-local notes are unavailable. Preserve the current context and recover the notes before an agent-requested reset.',
        warnings: ['Task notes could not be read or validated.'] }
    }
  }

  /** Captured before transcript copy, so a continuing source cannot add later notes. */
  snapshot(): Promise<TaskNotesSnapshot> { return this.withSnapshot(snapshot => structuredClone(snapshot)) }

  async restoreFork(snapshot: TaskNotesSnapshot, options: { fromMessageId?: string } = {}): Promise<void> {
    validateSnapshot(snapshot, snapshot.scope)
    await serialized(this.directory, async () => {
      const current = await this.load()
      if (current.notes.length || current.revision) throw new Error('Fork destination task notes already exist')
      const next: TaskNotesSnapshot = {
        version: 1, scope: { ...this.scope }, generation: randomUUID(), revision: 1,
        notes: options.fromMessageId ? [] : structuredClone(snapshot.notes),
        provenance: { source: { ...snapshot.scope }, sourceDigest: snapshotDigest(snapshot),
          capturedAt: new Date().toISOString(), ...(options.fromMessageId ? {
            fromMessageId: options.fromMessageId, notesOmitted: 'historical_boundary' as const,
          } : {}) },
      }
      validateSnapshot(next, this.scope)
      await this.persist(next)
    })
  }

  private withSnapshot<T>(read: (snapshot: TaskNotesSnapshot) => T): Promise<T> {
    return serialized(this.directory, async () => read(await this.load()))
  }

  private async mutateNote(options: { path: string; text: string; expectedRevision?: number }, append: boolean): Promise<TaskNoteMetadata> {
    const path = validateNotePath(options.path)
    if (typeof options.text !== 'string' || Buffer.byteLength(options.text) > TASK_NOTES_LIMITS.noteBytes) {
      throw new Error(`Task note exceeds ${TASK_NOTES_LIMITS.noteBytes} bytes`)
    }
    return serialized(this.directory, async () => {
      const snapshot = await this.load()
      const existing = snapshot.notes.find(note => note.path === path)
      assertRevision(existing, options.expectedRevision)
      const text = append ? (existing?.text ?? '') + options.text : options.text
      if (existing?.text === text) return metadata(existing)
      const note: TaskNote = { path, text, revision: (existing?.revision ?? 0) + 1,
        bytes: Buffer.byteLength(text), digest: digest(text), updatedAt: new Date().toISOString() }
      const next = { ...snapshot, generation: snapshot.generation === 'empty' ? randomUUID() : snapshot.generation, revision: snapshot.revision + 1,
        notes: [...snapshot.notes.filter(item => item.path !== path), note] }
      validateSnapshot(next, this.scope)
      await this.persist(next)
      return metadata(note)
    })
  }

  private async load(): Promise<TaskNotesSnapshot> {
    const empty = (): TaskNotesSnapshot => ({ version: 1, scope: { ...this.scope },
      generation: 'empty', revision: 0, notes: [] })
    if (!await safeDirectory(this.store.dataDir, this.directory, false)) return empty()
    let file
    try {
      const stat = await lstat(this.filePath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe task notes file')
      if (stat.size > maxSnapshotBytes) throw new Error('Task notes snapshot exceeds storage limit')
      file = await open(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const actual = await file.stat()
      if (actual.ino !== stat.ino || actual.dev !== stat.dev || actual.size > maxSnapshotBytes) throw new Error('Task notes file changed during read')
      let snapshot: unknown
      const raw = await file.readFile('utf8')
      try { snapshot = JSON.parse(raw) } catch { throw new Error('Invalid task notes snapshot') }
      validateSnapshot(snapshot, this.scope)
      return snapshot
    } catch (error) {
      if (isMissing(error)) return empty()
      throw error
    } finally { await file?.close() }
  }

  private async persist(snapshot: TaskNotesSnapshot): Promise<void> {
    await safeDirectory(this.store.dataDir, this.directory, true)
    await writeJsonFileAtomic(this.filePath, snapshot, {
      createParentDir: false, mode: 0o600, durable: true,
      beforeCommit: async () => { await safeDirectory(this.store.dataDir, this.directory, false) },
    })
  }
}

// Escaping every character can expand JSON up to six times its UTF-8 input size.
const maxSnapshotBytes = TASK_NOTES_LIMITS.totalBytes * 6 + 128 * 1024
function validateSnapshot(value: unknown, scope: TaskNotesScope): asserts value is TaskNotesSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid task notes snapshot')
  const snapshot = value as TaskNotesSnapshot
  if (snapshot.version !== 1 || !snapshot.scope || !sameScope(snapshot.scope, scope)
    || typeof snapshot.generation !== 'string' || !snapshot.generation.length || snapshot.generation.length > 64
    || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
    || !Array.isArray(snapshot.notes) || snapshot.notes.length > TASK_NOTES_LIMITS.notes) {
    throw new Error('Invalid task notes snapshot')
  }
  if (snapshot.provenance) validateProvenance(snapshot.provenance)
  const paths = new Set<string>()
  let total = 0
  for (const note of snapshot.notes) {
    if (!note || typeof note !== 'object') throw new Error('Invalid task note')
    validateNotePath(note.path)
    if (paths.has(note.path) || typeof note.text !== 'string' || note.digest !== digest(note.text)
      || note.bytes !== Buffer.byteLength(note.text) || note.bytes > TASK_NOTES_LIMITS.noteBytes
      || !Number.isSafeInteger(note.revision) || note.revision < 1
      || typeof note.updatedAt !== 'string' || note.updatedAt.length > 32 || !Number.isFinite(Date.parse(note.updatedAt))) {
      throw new Error('Invalid task note')
    }
    paths.add(note.path); total += note.bytes
  }
  const agentNotes = snapshot.notes.filter(note => !note.path.startsWith('runtime/'))
  if (agentNotes.length > TASK_NOTES_LIMITS.notes - 2
    || agentNotes.reduce((bytes, note) => bytes + note.bytes, 0) > TASK_NOTES_LIMITS.totalBytes - 2 * TASK_NOTES_LIMITS.noteBytes) {
    throw new Error('Task notes exceed agent storage limit; capacity is reserved for runtime continuity')
  }
  if (total > TASK_NOTES_LIMITS.totalBytes) throw new Error('Task notes exceed session actor storage limit')
}
function validateProvenance(provenance: TaskNotesProvenance): void {
  if (!provenance || typeof provenance !== 'object' || !provenance.source
    || typeof provenance.capturedAt !== 'string' || provenance.capturedAt.length > 32
    || !Number.isFinite(Date.parse(provenance.capturedAt))
    || typeof provenance.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(provenance.sourceDigest)
    || (provenance.fromMessageId !== undefined && (typeof provenance.fromMessageId !== 'string'
      || !provenance.fromMessageId.length || provenance.fromMessageId.length > 512))
    || (provenance.notesOmitted !== undefined && provenance.notesOmitted !== 'historical_boundary')) {
    throw new Error('Invalid task notes provenance')
  }
  for (const id of [provenance.source.profileId, provenance.source.sessionAgentId, provenance.source.actorAgentId]) {
    if (typeof id !== 'string' || id.length > 200 || sanitizePathSegment(id) !== id) throw new Error('Invalid task notes provenance scope')
  }
}
function sameScope(a: TaskNotesScope, b: TaskNotesScope): boolean {
  return a.profileId === b.profileId && a.sessionAgentId === b.sessionAgentId && a.actorAgentId === b.actorAgentId
}
function validateNotePath(path: string): string {
  if (typeof path !== 'string' || !path.length || Buffer.byteLength(path) > TASK_NOTES_LIMITS.pathChars
    || path !== path.trim() || path.split('/').some(part => !part || part === '.' || part === '..')
    || /[\\\x00-\x1f\x7f<>:"|?*]/.test(path)) throw new Error('Invalid virtual task note path')
  return path
}
function validatePrefix(prefix: string | undefined): string {
  if (!prefix) return ''
  validateNotePath(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix)
  return prefix
}
function assertRevision(note: TaskNote | undefined, expected: number | undefined): void {
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || expected !== (note?.revision ?? 0))) {
    throw new Error('Task note revision conflict; read the current note and retry')
  }
}
function metadata({ path, revision, digest, bytes, updatedAt }: TaskNote): TaskNoteMetadata {
  return { path, revision, digest, bytes, updatedAt }
}
function sortedNotes(snapshot: TaskNotesSnapshot): TaskNote[] { return [...snapshot.notes].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }
function digest(text: string): string { return createHash('sha256').update(text).digest('hex') }
function snapshotDigest(snapshot: TaskNotesSnapshot): string {
  return digest(JSON.stringify([snapshot.scope, snapshot.generation, snapshot.revision, sortedNotes(snapshot).map(metadata)]))
}
function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Expected an integer from ${min} to ${max}`)
  return value
}
function utf8Prefix(text: string, bytes: number): string {
  let used = 0; let result = ''
  for (const char of text) { used += Buffer.byteLength(char); if (used > bytes) break; result += char }
  return result
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = sessionQueues.get(key) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(work)
  sessionQueues.set(key, result)
  try { return await result } finally { if (sessionQueues.get(key) === result) sessionQueues.delete(key) }
}
async function safeDirectory(root: string, directory: string, create: boolean): Promise<boolean> {
  const suffix = relative(root, directory)
  if (suffix.startsWith(`..${sep}`) || suffix === '..' || resolve(root, suffix) !== directory) throw new Error('Unsafe task notes directory')
  let current = root
  for (const component of ['', ...suffix.split(sep)]) {
    if (component) current = join(current, component)
    let stat
    try { stat = await lstat(current) } catch (error) {
      if (!isMissing(error)) throw error
      if (!create) return false
      if (current === root) await mkdir(root, { recursive: true, mode: 0o700 })
      else await mkdir(current, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
      stat = await lstat(current)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe task notes directory')
  }
  return true
}
