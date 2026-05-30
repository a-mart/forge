import { describe, expect, it } from 'vitest'

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}
import { makeTempConfig as buildTempConfig, TestSwarmManager, bootWithDefaultManager } from '../../test-support/index.js'
import type { SwarmConfig } from '../types.js'

class StopFailureSwarmManager extends TestSwarmManager {
  readonly stopSessionCalls: string[] = []
  failAgentId?: string

  constructor(config: SwarmConfig) {
    super(config)

    const originalStopSessionInternal = (this as unknown as {
      stopSessionInternal: (agentId: string, options: unknown) => Promise<{ terminatedWorkerIds: string[] }>
    }).stopSessionInternal.bind(this)

    ;(this as unknown as {
      stopSessionInternal: (agentId: string, options: unknown) => Promise<{ terminatedWorkerIds: string[] }>
    }).stopSessionInternal = async (agentId: string, options: unknown) => {
      this.stopSessionCalls.push(agentId)
      if (agentId === this.failAgentId) {
        expect(this.listProfiles().find((profile) => profile.profileId === 'manager')?.archivedAt).toBeTruthy()
        throw new Error('synthetic stop failure')
      }
      return originalStopSessionInternal(agentId, options)
    }
  }
}

async function makeTempConfig(port = 8791): Promise<SwarmConfig> {
  return buildTempConfig({
    prefix: 'swarm-manager-archive-gates-',
    port,
    omitSharedAuthFile: true,
    omitSharedSecretsFile: true,
    skipRepoMemorySkillPlaceholder: true,
  })
}

describe('SwarmManager archive gates', () => {
  it('places newly created projects at the top of sidebar sort order', async () => {
    const config = await makeTempConfig(8890)
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    await manager.createManager('manager', { name: 'Alpha', cwd: config.defaultCwd })
    await manager.createManager('manager', { name: 'Beta', cwd: config.defaultCwd })

    const visibleOrder = manager
      .listProfiles()
      .filter((profile) => profile.profileId !== 'cortex' && profile.profileType !== 'system' && !profile.archivedAt)
      .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0))
      .map((profile) => profile.profileId)

    expect(visibleOrder[0]).toBe('beta')
    expect(visibleOrder).toEqual(['beta', 'alpha', 'manager'])
  })

  it('reorders visible active profiles without requiring archived profiles in the payload', async () => {
    const config = await makeTempConfig(8891)
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    await manager.createManager('manager', { name: 'Alpha', cwd: config.defaultCwd })
    await manager.createManager('manager', { name: 'Beta', cwd: config.defaultCwd })
    await manager.createManager('manager', { name: 'Gamma', cwd: config.defaultCwd })

    await manager.archiveProfile('beta')
    const archivedSortOrder = manager.listProfiles().find((profile) => profile.profileId === 'beta')?.sortOrder

    await manager.reorderProfiles(['gamma', 'manager', 'alpha'])

    const profiles = manager.listProfiles()
    const sortOrders = profiles.map((profile) => profile.sortOrder)
    expect(new Set(sortOrders).size).toBe(sortOrders.length)
    expect(profiles.find((profile) => profile.profileId === 'beta')?.sortOrder).toBe(archivedSortOrder)
    expect(
      profiles
        .filter((profile) => profile.profileId !== 'cortex' && profile.profileType !== 'system' && !profile.archivedAt)
        .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0))
        .map((profile) => profile.profileId),
    ).toEqual(['gamma', 'manager', 'alpha'])
  })

  it('preserves archived raw sort-order slots after the configured manager was reordered downward', async () => {
    const config = await makeTempConfig(8894)
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    await manager.createManager('manager', { name: 'Alpha', cwd: config.defaultCwd })
    await manager.createManager('manager', { name: 'Beta', cwd: config.defaultCwd })
    await manager.createManager('manager', { name: 'Gamma', cwd: config.defaultCwd })

    await manager.reorderProfiles(['alpha', 'beta', 'manager', 'gamma'])
    await manager.archiveProfile('beta')
    const archivedSortOrder = manager.listProfiles().find((profile) => profile.profileId === 'beta')?.sortOrder

    await manager.reorderProfiles(['gamma', 'alpha', 'manager'])

    const profiles = manager.listProfiles()
    const sortOrders = profiles.map((profile) => profile.sortOrder)
    expect(new Set(sortOrders).size).toBe(sortOrders.length)
    const sortOrderById = new Map(profiles.map((profile) => [profile.profileId, profile.sortOrder]))
    expect(sortOrderById.get('beta')).toBe(archivedSortOrder)
    expect(
      profiles
        .filter((profile) => profile.profileId !== 'cortex' && profile.profileType !== 'system' && !profile.archivedAt)
        .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0))
        .map((profile) => profile.profileId),
    ).toEqual(['gamma', 'alpha', 'manager'])
  })

  it('rejects archived profile IDs in reorder payloads even when the count matches active profiles', async () => {
    const config = await makeTempConfig(8892)
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    await manager.createManager('manager', { name: 'Alpha', cwd: config.defaultCwd })
    await manager.createManager('manager', { name: 'Beta', cwd: config.defaultCwd })
    await manager.createManager('manager', { name: 'Gamma', cwd: config.defaultCwd })

    await manager.archiveProfile('beta')

    await expect(manager.reorderProfiles(['gamma', 'manager', 'beta'])).rejects.toThrow(
      'Unknown or non-reorderable profile ID: beta',
    )
  })

  it('rejects duplicate active profile IDs in reorder payloads', async () => {
    const config = await makeTempConfig(8893)
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    await manager.createManager('manager', { name: 'Alpha', cwd: config.defaultCwd })
    await manager.createManager('manager', { name: 'Gamma', cwd: config.defaultCwd })

    await expect(manager.reorderProfiles(['gamma', 'gamma', 'manager'])).rejects.toThrow(
      'Duplicate profile IDs in reorder request',
    )
  })

  it('blocks user/runtime/message operations for directly archived sessions', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const created = await manager.createSession('manager', { label: 'Archived session' })

    await manager.archiveSession(created.sessionAgent.agentId)

    await expect(manager.handleUserMessage('hello archived session', {
      targetAgentId: created.sessionAgent.agentId,
    })).rejects.toThrow("Archived sessions can’t be used until restored.")
    await expect(manager.resumeSession(created.sessionAgent.agentId)).rejects.toThrow(
      "Archived sessions can’t be used until restored.",
    )
    await expect(manager.sendMessage('manager', created.sessionAgent.agentId, 'ping', 'auto')).rejects.toThrow(
      "Archived sessions can’t be used until restored.",
    )
    await expect(manager.pinMessage(created.sessionAgent.agentId, 'missing-message', false)).rejects.toThrow(
      "Archived sessions can’t be used until restored.",
    )
    await expect(manager.clearAllPins(created.sessionAgent.agentId)).rejects.toThrow(
      "Archived sessions can’t be used until restored.",
    )
    await expect(manager.clearSessionConversation(created.sessionAgent.agentId)).rejects.toThrow(
      "Archived sessions can’t be used until restored.",
    )

    await manager.restoreSession(created.sessionAgent.agentId)
    await expect(manager.handleUserMessage('hello restored session', {
      targetAgentId: created.sessionAgent.agentId,
    })).resolves.toBeUndefined()
  })

  it('blocks user/runtime/message operations for sessions in archived projects', async () => {
    const config = await makeTempConfig(8792)
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const created = await manager.createSession('manager', { label: 'Archived project child' })

    await manager.archiveProfile('manager')

    await expect(manager.handleUserMessage('hello archived project', {
      targetAgentId: created.sessionAgent.agentId,
    })).rejects.toThrow("Archived projects can’t be used until restored.")
    await expect(manager.resumeSession(created.sessionAgent.agentId)).rejects.toThrow(
      "Archived projects can’t be used until restored.",
    )
    await expect(manager.sendMessage('manager', created.sessionAgent.agentId, 'ping', 'auto')).rejects.toThrow(
      "Archived projects can’t be used until restored.",
    )
    await expect(manager.createSession('manager', { label: 'Blocked session' })).rejects.toThrow(
      "Archived projects can’t be used until restored.",
    )
    await expect(manager.pinMessage(created.sessionAgent.agentId, 'missing-message', false)).rejects.toThrow(
      "Archived projects can’t be used until restored.",
    )
    await expect(manager.clearAllPins(created.sessionAgent.agentId)).rejects.toThrow(
      "Archived projects can’t be used until restored.",
    )
    await expect(manager.clearSessionConversation(created.sessionAgent.agentId)).rejects.toThrow(
      "Archived projects can’t be used until restored.",
    )

    const restored = await manager.restoreProfile('manager')
    expect(restored.openAgentId).toBe(created.sessionAgent.agentId)
  })

  it('blocks session/project configuration mutations for directly archived sessions', async () => {
    const config = await makeTempConfig(8793)
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const created = await manager.createSession('manager', { label: 'Archived config session' })

    await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      handle: 'archived-config',
      whenToUse: 'Archived config checks',
    })
    await manager.setProjectAgentReference(created.sessionAgent.agentId, 'notes.md', 'reference content')
    await manager.archiveSession(created.sessionAgent.agentId)

    await expect(manager.updateSessionModel(created.sessionAgent.agentId, 'override', 'pi-5.4')).rejects.toThrow(
      "Archived sessions can’t be used until restored.",
    )
    await expect(
      manager.updateManagerModel(created.sessionAgent.agentId, 'pi-5.4'),
    ).rejects.toThrow("Archived sessions can’t be used until restored.")
    await expect(
      manager.setSessionProjectAgent(created.sessionAgent.agentId, {
        handle: 'archived-config',
        whenToUse: 'Updated archived config checks',
      }),
    ).rejects.toThrow("Archived sessions can’t be used until restored.")
    await expect(
      manager.requestProjectAgentRecommendations(created.sessionAgent.agentId),
    ).rejects.toThrow("Archived sessions can’t be used until restored.")
    await expect(
      manager.setProjectAgentReference(created.sessionAgent.agentId, 'notes.md', 'updated reference'),
    ).rejects.toThrow("Archived sessions can’t be used until restored.")
    await expect(
      manager.deleteProjectAgentReference(created.sessionAgent.agentId, 'notes.md'),
    ).rejects.toThrow("Archived sessions can’t be used until restored.")
  })

  it('awaits terminal suspension before completing project archive', async () => {
    const config = await makeTempConfig(8795)
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const suspendGate = deferred<void>()
    let archiveResolved = false

    manager.setTerminalArchiveHooks({
      suspendProfileTerminals: async () => suspendGate.promise,
      restoreProfileTerminals: async () => undefined,
    })

    const archivePromise = manager.archiveProfile('manager').then(() => {
      archiveResolved = true
    })
    await Promise.resolve()

    expect(archiveResolved).toBe(false)
    suspendGate.resolve()
    await archivePromise
    expect(archiveResolved).toBe(true)
  })

  it('keeps committed project archive successful when a child session stop fails after profile state changes', async () => {
    const config = await makeTempConfig(8797)
    const manager = new StopFailureSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const failing = await manager.createSession('manager', { label: 'Stop fails' })
    const later = await manager.createSession('manager', { label: 'Stop later' })
    manager.failAgentId = failing.sessionAgent.agentId
    let profilesSnapshots = 0
    let archivedEvents = 0
    let terminalSuspendCalls = 0

    manager.on('profiles_snapshot', () => {
      profilesSnapshots += 1
    })
    manager.on('session_lifecycle', (event: { action: string }) => {
      if (event.action === 'archived') archivedEvents += 1
    })
    manager.setTerminalArchiveHooks({
      suspendProfileTerminals: async () => {
        terminalSuspendCalls += 1
      },
      restoreProfileTerminals: async () => undefined,
    })

    await expect(manager.archiveProfile('manager')).resolves.toMatchObject({ profileId: 'manager' })
    expect(manager.listProfiles().find((profile) => profile.profileId === 'manager')?.archivedAt).toBeTruthy()
    expect(manager.stopSessionCalls).toContain(failing.sessionAgent.agentId)
    expect(manager.stopSessionCalls).toContain(later.sessionAgent.agentId)
    expect(manager.stopSessionCalls.indexOf(later.sessionAgent.agentId)).toBeGreaterThan(
      manager.stopSessionCalls.indexOf(failing.sessionAgent.agentId),
    )
    expect(profilesSnapshots).toBeGreaterThan(0)
    expect(archivedEvents).toBe(1)
    expect(terminalSuspendCalls).toBe(1)
  })

  it('keeps committed archive/restore successful when terminal hooks throw after profile state changes', async () => {
    const config = await makeTempConfig(8796)
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    let profilesSnapshots = 0
    let archivedEvents = 0
    let restoredEvents = 0

    manager.on('profiles_snapshot', () => {
      profilesSnapshots += 1
    })
    manager.on('session_lifecycle', (event: { action: string }) => {
      if (event.action === 'archived') archivedEvents += 1
      if (event.action === 'restored') restoredEvents += 1
    })
    manager.setTerminalArchiveHooks({
      suspendProfileTerminals: async () => {
        throw new Error('terminal already closing')
      },
      restoreProfileTerminals: async () => {
        throw new Error('restore failed')
      },
    })

    await expect(manager.archiveProfile('manager')).resolves.toMatchObject({ profileId: 'manager' })
    expect(manager.listProfiles().find((profile) => profile.profileId === 'manager')?.archivedAt).toBeTruthy()
    expect(profilesSnapshots).toBeGreaterThan(0)
    expect(archivedEvents).toBe(1)

    await expect(manager.restoreProfile('manager')).resolves.toMatchObject({ profileId: 'manager' })
    expect(manager.listProfiles().find((profile) => profile.profileId === 'manager')?.archivedAt).toBeUndefined()
    expect(restoredEvents).toBe(1)
  })

  it('blocks project-level configuration mutations for archived projects', async () => {
    const config = await makeTempConfig(8794)
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const created = await manager.createSession('manager', { label: 'Archived project config session' })
    await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      handle: 'archived-project-config',
      whenToUse: 'Archived project config checks',
    })

    await manager.archiveProfile('manager')

    await expect(manager.updateProfileDefaultModel('manager', 'pi-5.4')).rejects.toThrow(
      "Archived projects can’t be used until restored.",
    )
    await expect(manager.updateManagerCwd('manager', config.defaultCwd)).rejects.toThrow(
      "Archived projects can’t be used until restored.",
    )
    await expect(
      manager.setProjectAgentReference(created.sessionAgent.agentId, 'notes.md', 'reference content'),
    ).rejects.toThrow("Archived projects can’t be used until restored.")
    await expect(
      manager.setSessionProjectAgent(created.sessionAgent.agentId, {
        handle: 'archived-project-config',
        whenToUse: 'Updated archived project config checks',
      }),
    ).rejects.toThrow("Archived projects can’t be used until restored.")
  })
})
