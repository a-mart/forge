import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskNotesStore } from '../task-notes-store.js'
import { createTaskNotesTool } from '../task-notes-tool.js'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const setup = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'forge-notes-tool-')); directories.push(dataDir)
  const notes = new TaskNotesStore({ dataDir }).forActor({ profileId: 'p', sessionAgentId: 's', actorAgentId: 'w' })
  return { notes, tool: createTaskNotesTool(notes) }
}
describe('notes tool', () => {
  it('supports persistence and retrieval through the actor-bound tool', async () => {
    const { tool } = await setup()
    expect((await tool.execute('1', { op: 'write', path: 'checkpoint.md', text: 'Objective: fix it', expectedRevision: 0 })).details).toMatchObject({ path: 'checkpoint.md', revision: 1 })
    await tool.execute('2', { op: 'append', path: 'checkpoint.md', text: '\nNext: verify', expectedRevision: 1 })
    const read = await tool.execute('3', { op: 'read', path: 'checkpoint.md' })
    expect(read.details).toMatchObject({ text: 'Objective: fix it\nNext: verify', revision: 2 })
    expect((await tool.execute('4', { op: 'list' })).details).toMatchObject({ notes: [{ path: 'checkpoint.md' }] })
    expect((await tool.execute('5', { op: 'search', query: 'verify' })).details).toMatchObject({ matches: [{ path: 'checkpoint.md' }] })
    expect(read.content[0]).toEqual({ type: 'text', text: JSON.stringify(read.details) })
  })
  it('permits runtime note reads and rejects agent writes in the reserved namespace', async () => {
    const { tool, notes } = await setup()
    await notes.write({ path: 'runtime/continuity.md', text: 'Runtime entrypoints' })
    expect((await tool.execute('1', { op: 'read', path: 'runtime/continuity.md' })).details).toMatchObject({ text: 'Runtime entrypoints' })
    for (const op of ['write', 'append']) await expect(tool.execute('2', { op, path: 'runtime/continuity.md', text: 'override' })).rejects.toThrow('read-only')
    await expect(tool.execute('3', { op: 'delete', path: 'checkpoint.md' })).rejects.toThrow('Unsupported')
  })
})
