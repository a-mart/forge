import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isSessionContextArtifacts } from '@forge/protocol'
import { SwarmManagerDelegationFacade } from '../swarm-manager-delegation-facade.js'
import { TaskNotesStore } from '../task-notes-store.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'forge-context-artifacts-'))
  directories.push(dataDir)
  const mode = { sessionAgentId: 'manager', profileId: 'project', projectDefault: 'summary',
    effectiveMode: 'fresh', appliedMode: 'fresh', freshSupported: true }
  const facade = { getSessionContextMode: () => mode, getFacadeServices: () => ({ host: { config: { paths: { dataDir } } } }) }
  const read = (id = 'manager') => SwarmManagerDelegationFacade.prototype.getSessionContextArtifacts.call(
    facade as unknown as SwarmManagerDelegationFacade, id)
  const actor = (actorAgentId = 'manager', sessionAgentId = 'manager') => new TaskNotesStore({ dataDir })
    .forActor({ profileId: 'project', sessionAgentId, actorAgentId })
  return { read, actor, dataDir }
}
describe('context artifacts canonical read projection', () => {
  it('reads complete notes after store restart and excludes other actors and sessions', async () => {
    const { actor, read } = await setup()
    const text = '# Handoff\n' + 'full content '.repeat(2000)
    await actor().write({ path: 'checkpoint.md', text })
    await actor().write({ path: 'decisions.md', text: 'Keep the existing owner.' })
    await actor().write({ path: 'runtime/continuity-0.md', text: 'Recovery record' })
    await actor('worker').write({ path: 'private.md', text: 'Worker state' })
    await actor('other', 'other').write({ path: 'other.md', text: 'Other session' })
    const before = await actor().snapshot()
    const result = await read()
    expect(isSessionContextArtifacts(result)).toBe(true)
    expect(result.files.map(file => [file.path, file.kind])).toEqual([
      ['checkpoint.md', 'checkpoint'], ['decisions.md', 'working'], ['runtime/continuity-0.md', 'recovery'],
    ])
    expect(result.files[0].text).toBe(text)
    expect(await actor().snapshot()).toEqual(before)
  })
  it('returns new revisions and reflects a conversation clear without stale files', async () => {
    const { actor, read, dataDir } = await setup()
    expect((await read()).files).toEqual([])
    await actor().write({ path: 'checkpoint.md', text: 'first' })
    await actor().write({ path: 'checkpoint.md', text: 'second' })
    expect((await read()).files[0]).toMatchObject({ text: 'second', revision: 2 })
    await new TaskNotesStore({ dataDir }).clearSession('project', 'manager')
    expect((await read()).files).toEqual([])
  })
  it('does not substitute manager notes for a worker request', async () => {
    const { read } = await setup()
    await expect(read('worker')).rejects.toThrow('only available for manager sessions')
  })
})
