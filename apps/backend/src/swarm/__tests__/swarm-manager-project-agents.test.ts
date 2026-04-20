import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  getProjectAgentConfigPath,
  getProjectAgentDir,
  getProjectAgentPromptPath,
} from '../data-paths.js'
import { makeTempConfig as buildTempConfig } from '../../test-support/index.js'

const memoryMergeMockState = vi.hoisted(() => ({
  executeLLMMerge: vi.fn(async (..._args: any[]) => '# Swarm Memory\n\n## Decisions\n- merged by mock\n'),
}))
const projectAgentAnalysisMockState = vi.hoisted(() => ({
  analyzeSessionForPromotion: vi.fn(async (..._args: any[]) => ({
    whenToUse: 'Use for release coordination.',
    systemPrompt: 'You are the release coordination manager.',
  })),
}))

vi.mock('../memory-merge.js', async () => {
  const actual = await vi.importActual<typeof import('../memory-merge.js')>('../memory-merge.js')
  return {
    ...actual,
    executeLLMMerge: (...args: Parameters<typeof actual.executeLLMMerge>) =>
      memoryMergeMockState.executeLLMMerge(...args),
  }
})

vi.mock('../project-agent-analysis.js', async () => {
  const actual = await vi.importActual<typeof import('../project-agent-analysis.js')>('../project-agent-analysis.js')
  return {
    ...actual,
    analyzeSessionForPromotion: (...args: Parameters<typeof actual.analyzeSessionForPromotion>) =>
      projectAgentAnalysisMockState.analyzeSessionForPromotion(...args),
  }
})

import type { AgentDescriptor, SwarmConfig } from '../types.js'
import type { RuntimeCreationOptions, SwarmAgentRuntime } from '../runtime-contracts.js'
import { FakeRuntime, TestSwarmManager as TestSwarmManagerBase, bootWithDefaultManager } from '../../test-support/index.js'

class TestSwarmManager extends TestSwarmManagerBase {
  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions,
  ): Promise<SwarmAgentRuntime> {
    const runtime = await super.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options)
    ;(runtime as FakeRuntime).terminateMutatesDescriptorStatus = false
    return runtime
  }
}

class ProjectAgentAwareSwarmManager extends TestSwarmManager {
  readonly notifiedProjectAgentProfileIds: string[] = []

  override async notifyProjectAgentsChanged(profileId: string): Promise<void> {
    this.notifiedProjectAgentProfileIds.push(profileId)
  }
}

async function makeTempConfig(port = 8790): Promise<SwarmConfig> {
  return buildTempConfig({
    prefix: 'swarm-manager-test-',
    port,
    omitSharedAuthFile: true,
    omitSharedSecretsFile: true,
    skipRepoMemorySkillPlaceholder: true,
  })
}

async function installForgeLifecycleLogger(config: SwarmConfig, logPath: string): Promise<void> {
  const extensionsDir = join(config.paths.dataDir, 'extensions')
  await mkdir(extensionsDir, { recursive: true })
  await writeFile(
    join(extensionsDir, 'lifecycle.ts'),
    `
      import { appendFileSync } from "node:fs"
      export default (forge) => {
        forge.on("session:lifecycle", (event) => {
          appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(event) + "\\n", "utf8")
        })
      }
    `,
    'utf8',
  )
}

async function readJsonlFile<T>(path: string): Promise<T[]> {
  const content = await readFile(path, 'utf8')
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

describe('SwarmManager', () => {
  it('setSessionProjectAgent promotes, persists, emits, and survives clear_session', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.createSession('manager', { label: 'Release Notes' })
    const updates: Array<{ agentId: string; profileId: string; projectAgent: { handle: string; whenToUse: string } | null }> = []
    manager.on('session_project_agent_updated', (event) => {
      updates.push(event as { agentId: string; profileId: string; projectAgent: { handle: string; whenToUse: string } | null })
    })

    const result = await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      whenToUse: '  Draft release notes and changelog copy.  ',
    })

    expect(result).toEqual({
      profileId: 'manager',
      projectAgent: {
        handle: 'release-notes',
        whenToUse: 'Draft release notes and changelog copy.',
      },
    })
    expect(manager.getAgent(created.sessionAgent.agentId)?.projectAgent).toEqual(result.projectAgent)
    expect(manager.getAgent(created.sessionAgent.agentId)?.projectAgent?.systemPrompt).toBeUndefined()
    expect(
      manager.listAgents().find((agent) => agent.agentId === created.sessionAgent.agentId)?.projectAgent?.systemPrompt,
    ).toBeUndefined()
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      type: 'session_project_agent_updated',
      agentId: created.sessionAgent.agentId,
      profileId: 'manager',
      projectAgent: {
        handle: 'release-notes',
        whenToUse: 'Draft release notes and changelog copy.',
      },
    })
    expect((updates[0]?.projectAgent as { systemPrompt?: string } | null)?.systemPrompt).toBeUndefined()
    expect(manager.notifiedProjectAgentProfileIds).toEqual(['manager'])

    const store = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as { agents: AgentDescriptor[] }
    expect(store.agents.find((agent) => agent.agentId === created.sessionAgent.agentId)?.projectAgent).toEqual({
      handle: 'release-notes',
      whenToUse: 'Draft release notes and changelog copy.',
    })

    await manager.clearSessionConversation(created.sessionAgent.agentId)
    expect(manager.getAgent(created.sessionAgent.agentId)?.projectAgent).toEqual({
      handle: 'release-notes',
      whenToUse: 'Draft release notes and changelog copy.',
    })
  })

  it('uses explicit handles on promotion and preserves them across later edits', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.createSession('manager', { label: 'Release Notes' })

    const promoted = await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      handle: 'releases',
      whenToUse: 'Draft release notes and changelog copy.',
    })

    expect(promoted.projectAgent).toEqual({
      handle: 'releases',
      whenToUse: 'Draft release notes and changelog copy.',
    })

    const updated = await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      whenToUse: 'Owns release notes and changelog QA.',
    })

    expect(updated.projectAgent).toEqual({
      handle: 'releases',
      whenToUse: 'Owns release notes and changelog QA.',
    })
    expect(manager.getAgent(created.sessionAgent.agentId)?.projectAgent).toEqual({
      handle: 'releases',
      whenToUse: 'Owns release notes and changelog QA.',
    })
  })

  it('promotes, demotes, and re-promotes the same handle with on-disk directory cleanup', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.createSession('manager', { label: 'Documentation Writer' })
    const projectAgentDir = getProjectAgentDir(config.paths.dataDir, 'manager', 'docs')
    const configPath = getProjectAgentConfigPath(config.paths.dataDir, 'manager', 'docs')
    const promptPath = getProjectAgentPromptPath(config.paths.dataDir, 'manager', 'docs')

    await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      handle: 'docs',
      whenToUse: 'Owns docs updates.',
      systemPrompt: 'Document the system.',
    })

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      agentId: created.sessionAgent.agentId,
      handle: 'docs',
      whenToUse: 'Owns docs updates.',
      version: 1,
    })
    expect(await readFile(promptPath, 'utf8')).toBe('Document the system.')

    const demoted = await manager.setSessionProjectAgent(created.sessionAgent.agentId, null)
    expect(demoted.projectAgent).toBeNull()
    expect(manager.getAgent(created.sessionAgent.agentId)?.projectAgent).toBeUndefined()
    await expect(stat(projectAgentDir)).rejects.toMatchObject({ code: 'ENOENT' })

    const rePromoted = await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      handle: 'docs',
      whenToUse: 'Owns docs and changelog updates.',
      systemPrompt: 'Document the system better.',
    })

    expect(rePromoted.projectAgent).toEqual({
      handle: 'docs',
      whenToUse: 'Owns docs and changelog updates.',
    })
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      agentId: created.sessionAgent.agentId,
      handle: 'docs',
      whenToUse: 'Owns docs and changelog updates.',
      version: 1,
    })
    expect(await readFile(promptPath, 'utf8')).toBe('Document the system better.')
  })

  it('collapses multiline project-agent when-to-use text before persisting', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.createSession('manager', { label: 'Release Notes' })

    const result = await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      whenToUse: '  Draft release notes\n\nand   changelog\tcopy.  ',
    })

    expect(result.projectAgent).toEqual({
      handle: 'release-notes',
      whenToUse: 'Draft release notes and changelog copy.',
    })
    expect(manager.getAgent(created.sessionAgent.agentId)?.projectAgent).toEqual({
      handle: 'release-notes',
      whenToUse: 'Draft release notes and changelog copy.',
    })

    const store = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as { agents: AgentDescriptor[] }
    expect(store.agents.find((agent) => agent.agentId === created.sessionAgent.agentId)?.projectAgent).toEqual({
      handle: 'release-notes',
      whenToUse: 'Draft release notes and changelog copy.',
    })
  })

  it('rejects empty project-agent when-to-use text after normalization', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.createSession('manager', { label: 'Release Notes' })

    await expect(
      manager.setSessionProjectAgent(created.sessionAgent.agentId, {
        whenToUse: '',
      }),
    ).rejects.toThrow('Project agent "When to use" must be non-empty')

    await expect(
      manager.setSessionProjectAgent(created.sessionAgent.agentId, {
        whenToUse: '   ',
      }),
    ).rejects.toThrow('Project agent "When to use" must be non-empty')

    expect(manager.getAgent(created.sessionAgent.agentId)?.projectAgent).toBeUndefined()
  })

  it('rejects project-agent when-to-use text longer than 280 characters', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.createSession('manager', { label: 'Release Notes' })

    await expect(
      manager.setSessionProjectAgent(created.sessionAgent.agentId, {
        whenToUse: 'a'.repeat(281),
      }),
    ).rejects.toThrow('Project agent "When to use" must be 280 characters or fewer')

    expect(manager.getAgent(created.sessionAgent.agentId)?.projectAgent).toBeUndefined()
  })

  it('persists project-agent system prompts through store reload', async () => {
    const config = await makeTempConfig()
    const firstBoot = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const created = await firstBoot.createSession('manager', { label: 'Release Notes' })
    const expectedProjectAgent = {
      handle: 'release-notes',
      whenToUse: 'Draft release notes and changelog copy.',
      systemPrompt: 'You are the release notes project agent.',
    }

    await firstBoot.setSessionProjectAgent(created.sessionAgent.agentId, {
      whenToUse: expectedProjectAgent.whenToUse,
      systemPrompt: '  You are the release notes project agent.  ',
    })

    // getAgent() returns cloned descriptor — systemPrompt intentionally stripped from snapshots
    expect(firstBoot.getAgent(created.sessionAgent.agentId)?.projectAgent).toEqual({
      handle: expectedProjectAgent.handle,
      whenToUse: expectedProjectAgent.whenToUse,
    })

    // Internal descriptor still has systemPrompt (for agents.json persistence / downgrade safety)
    const firstBootState = firstBoot as unknown as { descriptors: Map<string, AgentDescriptor> }
    expect(firstBootState.descriptors.get(created.sessionAgent.agentId)?.projectAgent).toEqual(expectedProjectAgent)

    // agents.json still has systemPrompt for Electron downgrade safety
    const store = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as { agents: AgentDescriptor[] }
    expect(store.agents.find((agent) => agent.agentId === created.sessionAgent.agentId)?.projectAgent).toEqual(expectedProjectAgent)

    const secondBoot = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    // After second boot, cloned output still omits systemPrompt
    expect(secondBoot.getAgent(created.sessionAgent.agentId)?.projectAgent).toEqual({
      handle: expectedProjectAgent.handle,
      whenToUse: expectedProjectAgent.whenToUse,
    })
    // Internal descriptor should have systemPrompt (hydrated from on-disk or descriptor mirror)
    const secondBootState = secondBoot as unknown as { descriptors: Map<string, AgentDescriptor> }
    expect(secondBootState.descriptors.get(created.sessionAgent.agentId)?.projectAgent).toEqual(expectedProjectAgent)
  })



  it('rejects project-agent promotion collisions and cortex-only sessions', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const first = await manager.createSession('manager', { label: 'Release Notes' })
    const second = await manager.createSession('manager', { label: 'Release Notes!!!' })

    await manager.setSessionProjectAgent(first.sessionAgent.agentId, {
      whenToUse: 'Draft release notes.',
    })

    await expect(
      manager.setSessionProjectAgent(second.sessionAgent.agentId, {
        whenToUse: 'Also draft release notes.',
      }),
    ).rejects.toThrow(
      'Project agent handle "release-notes" is already in use in this profile. Choose a different handle and try again.',
    )

    await expect(
      manager.setSessionProjectAgent('cortex', {
        whenToUse: 'Should fail.',
      }),
    ).rejects.toThrow('Cortex root cannot be promoted to a project agent')

    const reviewSession = await manager.createSession('cortex', {
      label: 'Review',
      sessionPurpose: 'cortex_review',
    })

    await expect(
      manager.setSessionProjectAgent(reviewSession.sessionAgent.agentId, {
        whenToUse: 'Should also fail.',
      }),
    ).rejects.toThrow('Cortex review sessions cannot be promoted to project agents')
  })
  it('emits Forge session lifecycle hooks for createAndPromoteProjectAgent', async () => {
    const config = await makeTempConfig()
    const logPath = join(config.paths.dataDir, 'project-agent-lifecycle.jsonl')
    await installForgeLifecycleLogger(config, logPath)

    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const creator = await manager.createSession('manager', {
      label: 'Agent Creator',
      sessionPurpose: 'agent_creator',
    })

    const result = await manager.createAndPromoteProjectAgent(creator.sessionAgent.agentId, {
      sessionName: 'Release Notes',
      whenToUse: 'Draft release notes',
      systemPrompt: 'You are the release notes project agent.',
    })

    const events = await readJsonlFile<any>(logPath)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'created',
          session: expect.objectContaining({ sessionAgentId: result.agentId, profileId: 'manager' }),
        }),
      ]),
    )
  })

  it('createAndPromoteProjectAgent honors an explicit handle override', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const creator = await manager.createSession('manager', {
      label: 'Agent Creator',
      sessionPurpose: 'agent_creator',
    })

    const result = await manager.createAndPromoteProjectAgent(creator.sessionAgent.agentId, {
      sessionName: 'Documentation Writer',
      handle: 'docs',
      whenToUse: 'Owns docs updates.',
      systemPrompt: 'You are the documentation project agent.',
    })

    expect(result).toEqual({
      agentId: expect.any(String),
      handle: 'docs',
      profileId: 'manager',
    })
    // Cloned output omits systemPrompt
    expect(manager.getAgent(result.agentId)?.projectAgent).toEqual({
      handle: 'docs',
      whenToUse: 'Owns docs updates.',
      creatorSessionId: creator.sessionAgent.agentId,
    })
    expect(manager.getAgent(result.agentId)?.projectAgent?.systemPrompt).toBeUndefined()
    expect(manager.listAgents().find((agent) => agent.agentId === result.agentId)?.projectAgent?.systemPrompt).toBeUndefined()
    // Internal descriptor retains systemPrompt
    const managerState = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    expect(managerState.descriptors.get(result.agentId)?.projectAgent).toEqual({
      handle: 'docs',
      whenToUse: 'Owns docs updates.',
      systemPrompt: 'You are the documentation project agent.',
      creatorSessionId: creator.sessionAgent.agentId,
    })
    expect(
      JSON.parse(await readFile(getProjectAgentConfigPath(config.paths.dataDir, 'manager', 'docs'), 'utf8')),
    ).toMatchObject({
      agentId: result.agentId,
      handle: 'docs',
      whenToUse: 'Owns docs updates.',
      creatorSessionId: creator.sessionAgent.agentId,
      version: 1,
    })
    expect(await readFile(getProjectAgentPromptPath(config.paths.dataDir, 'manager', 'docs'), 'utf8')).toBe(
      'You are the documentation project agent.',
    )
  })

  it('createAndPromoteProjectAgent rolls back descriptors when setup fails before runtime creation', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const creator = await manager.createSession('manager', {
      label: 'Agent Creator',
      sessionPurpose: 'agent_creator',
    })
    const agentIdsBefore = manager.listAgents().map((agent) => agent.agentId).sort()
    const profileSessionsDir = join(config.paths.dataDir, 'profiles', 'manager', 'sessions')
    const sessionDirsBefore = (await readdir(profileSessionsDir)).sort()

    vi.spyOn(manager as any, 'writeInitialSessionMeta').mockRejectedValueOnce(new Error('meta boom'))

    await expect(
      manager.createAndPromoteProjectAgent(creator.sessionAgent.agentId, {
        sessionName: 'Release Notes',
        whenToUse: 'Draft release notes.',
        systemPrompt: 'You are the release notes project agent.',
      }),
    ).rejects.toThrow('meta boom')

    expect(manager.listAgents().map((agent) => agent.agentId).sort()).toEqual(agentIdsBefore)
    expect((await readdir(profileSessionsDir)).sort()).toEqual(sessionDirsBefore)
    await expect(stat(getProjectAgentDir(config.paths.dataDir, 'manager', 'release-notes'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(manager.notifiedProjectAgentProfileIds).toEqual([])

    const retried = await manager.createAndPromoteProjectAgent(creator.sessionAgent.agentId, {
      sessionName: 'Release Notes',
      whenToUse: 'Draft release notes.',
      systemPrompt: 'You are the release notes project agent.',
    })

    expect(retried.handle).toBe('release-notes')
  })

  it('createAndPromoteProjectAgent rolls back descriptors when persistence fails after runtime creation', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const creator = await manager.createSession('manager', {
      label: 'Agent Creator',
      sessionPurpose: 'agent_creator',
    })
    const agentIdsBefore = manager.listAgents().map((agent) => agent.agentId).sort()
    const profileSessionsDir = join(config.paths.dataDir, 'profiles', 'manager', 'sessions')
    const sessionDirsBefore = (await readdir(profileSessionsDir)).sort()

    vi.spyOn(manager as any, 'saveStore').mockRejectedValueOnce(new Error('save boom'))

    await expect(
      manager.createAndPromoteProjectAgent(creator.sessionAgent.agentId, {
        sessionName: 'Release Notes',
        whenToUse: 'Draft release notes.',
        systemPrompt: 'You are the release notes project agent.',
      }),
    ).rejects.toThrow('save boom')

    expect(manager.listAgents().map((agent) => agent.agentId).sort()).toEqual(agentIdsBefore)
    expect((await readdir(profileSessionsDir)).sort()).toEqual(sessionDirsBefore)
    await expect(stat(getProjectAgentDir(config.paths.dataDir, 'manager', 'release-notes'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(manager.notifiedProjectAgentProfileIds).toEqual([])

    const retried = await manager.createAndPromoteProjectAgent(creator.sessionAgent.agentId, {
      sessionName: 'Release Notes',
      whenToUse: 'Draft release notes.',
      systemPrompt: 'You are the release notes project agent.',
    })

    expect(retried.handle).toBe('release-notes')
  })

  it('createAndPromoteProjectAgent rejects invalid creators and collisions before creating a session', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.createAndPromoteProjectAgent('manager', {
        sessionName: 'Release Notes',
        whenToUse: 'Draft release notes.',
        systemPrompt: 'You are the release notes project agent.',
      }),
    ).rejects.toThrow('Only agent_creator sessions can create project agents')

    const creator = await manager.createSession('manager', {
      label: 'Agent Creator',
      sessionPurpose: 'agent_creator',
    })
    const existing = await manager.createSession('manager', { label: 'Release Notes' })
    await manager.setSessionProjectAgent(existing.sessionAgent.agentId, {
      whenToUse: 'Draft release notes.',
    })

    const agentCountBeforeCollision = manager.listAgents().length
    await expect(
      manager.createAndPromoteProjectAgent(creator.sessionAgent.agentId, {
        sessionName: 'Release Notes!!!',
        whenToUse: 'Also draft release notes.',
        systemPrompt: 'You are another release notes project agent.',
      }),
    ).rejects.toThrow(
      'Project agent handle "release-notes" is already in use in this profile. Choose a different handle and try again.',
    )
    expect(manager.listAgents()).toHaveLength(agentCountBeforeCollision)

    await expect(
      manager.createAndPromoteProjectAgent(creator.sessionAgent.agentId, {
        sessionName: '   ',
        whenToUse: 'Draft release notes.',
        systemPrompt: 'You are the release notes project agent.',
      }),
    ).rejects.toThrow('sessionName must be non-empty')

    await expect(
      manager.createAndPromoteProjectAgent(creator.sessionAgent.agentId, {
        sessionName: 'Release Notes 2',
        whenToUse: 'Draft release notes.',
        systemPrompt: '   ',
      }),
    ).rejects.toThrow('systemPrompt must be non-empty')
  })

  it('renameSession keeps project-agent handles stable and deleteSession notifies on removal', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const releases = await manager.createSession('manager', { label: 'Release Notes' })
    const qa = await manager.createSession('manager', { label: 'QA' })

    await manager.setSessionProjectAgent(releases.sessionAgent.agentId, {
      whenToUse: 'Draft release notes.',
    })
    await manager.setSessionProjectAgent(qa.sessionAgent.agentId, {
      whenToUse: 'Verify fixes.',
    })

    await manager.renameSession(releases.sessionAgent.agentId, 'Ship Notes')
    expect(manager.getAgent(releases.sessionAgent.agentId)?.sessionLabel).toBe('Ship Notes')
    expect(manager.getAgent(releases.sessionAgent.agentId)?.projectAgent?.handle).toBe('release-notes')
    expect(
      JSON.parse(await readFile(getProjectAgentConfigPath(config.paths.dataDir, 'manager', 'release-notes'), 'utf8')),
    ).toMatchObject({
      agentId: releases.sessionAgent.agentId,
      handle: 'release-notes',
    })
    await expect(stat(getProjectAgentDir(config.paths.dataDir, 'manager', 'ship-notes'))).rejects.toMatchObject({
      code: 'ENOENT',
    })

    await manager.renameSession(qa.sessionAgent.agentId, 'Ship Notes!!!')
    expect(manager.getAgent(qa.sessionAgent.agentId)?.sessionLabel).toBe('Ship Notes!!!')
    expect(manager.getAgent(qa.sessionAgent.agentId)?.projectAgent?.handle).toBe('qa')
    expect(JSON.parse(await readFile(getProjectAgentConfigPath(config.paths.dataDir, 'manager', 'qa'), 'utf8'))).toMatchObject({
      agentId: qa.sessionAgent.agentId,
      handle: 'qa',
    })

    const notificationsBeforeDelete = manager.notifiedProjectAgentProfileIds.length
    await manager.deleteSession(releases.sessionAgent.agentId)
    expect(manager.notifiedProjectAgentProfileIds.slice(notificationsBeforeDelete)).toEqual(['manager'])
  })

  it('forked sessions are not promoted by default', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const source = await manager.createSession('manager', { label: 'Source Session' })
    await manager.setSessionProjectAgent(source.sessionAgent.agentId, {
      whenToUse: 'Coordinate release work.',
    })

    const forked = await manager.forkSession(source.sessionAgent.agentId, { label: 'Forked Session' })
    expect(forked.sessionAgent.projectAgent).toBeUndefined()
    expect(manager.getAgent(forked.sessionAgent.agentId)?.projectAgent).toBeUndefined()
  })
  it('routes manager-to-promoted-manager sends through project-agent transcript delivery', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Release Notes' })
    await manager.setSessionProjectAgent(sessionAgent.agentId, {
      whenToUse: 'Draft release notes.',
    })

    const state = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
    }

    state.runtimes.delete(sessionAgent.agentId)
    manager.runtimeByAgentId.delete(sessionAgent.agentId)

    const createdRuntimeCountBeforeSend = manager.createdRuntimeIds.length
    const receipt = await manager.sendMessage('manager', sessionAgent.agentId, 'Please draft release notes.', 'auto')

    expect(receipt.targetAgentId).toBe(sessionAgent.agentId)
    expect(manager.createdRuntimeIds.length).toBe(createdRuntimeCountBeforeSend + 1)

    const recreatedRuntime = manager.runtimeByAgentId.get(sessionAgent.agentId)
    expect(recreatedRuntime?.sendCalls.at(-1)?.message).toBe(
      `[projectAgentContext] ${JSON.stringify({
        fromAgentId: 'manager',
        fromDisplayName: 'manager',
      })}\n\nPlease draft release notes.`,
    )

    const targetHistory = manager.getConversationHistory(sessionAgent.agentId)
    const projectAgentMessage = targetHistory.find(
      (entry) =>
        entry.type === 'conversation_message' &&
        entry.source === 'project_agent_input' &&
        entry.role === 'user' &&
        entry.text === 'Please draft release notes.',
    )

    expect(projectAgentMessage).toBeDefined()
    expect(projectAgentMessage?.type).toBe('conversation_message')
    if (projectAgentMessage?.type === 'conversation_message') {
      expect(projectAgentMessage.sourceContext).toBeUndefined()
      expect(projectAgentMessage.projectAgentContext).toEqual({
        fromAgentId: 'manager',
        fromDisplayName: 'manager',
      })
    }

    expect(targetHistory.some((entry) => entry.type === 'agent_message')).toBe(false)

    const senderHistory = manager.getConversationHistory('manager')
    expect(
      senderHistory.some(
        (entry) =>
          entry.type === 'agent_message' &&
          entry.agentId === 'manager' &&
          entry.fromAgentId === 'manager' &&
          entry.toAgentId === sessionAgent.agentId &&
          entry.text === 'Please draft release notes.',
      ),
    ).toBe(true)
  })

  it('keeps promoted-session self-sends on the generic manager path', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Release Notes' })
    await manager.setSessionProjectAgent(sessionAgent.agentId, {
      whenToUse: 'Draft release notes.',
    })

    const receipt = await manager.sendMessage(sessionAgent.agentId, sessionAgent.agentId, 'SYSTEM: closeout reminder', 'auto')

    expect(receipt.targetAgentId).toBe(sessionAgent.agentId)

    const sessionRuntime = manager.runtimeByAgentId.get(sessionAgent.agentId)
    expect(sessionRuntime?.sendCalls.at(-1)?.message).toBe('SYSTEM: closeout reminder')

    const sessionHistory = manager.getConversationHistory(sessionAgent.agentId)
    expect(
      sessionHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'project_agent_input' &&
          entry.text === 'SYSTEM: closeout reminder',
      ),
    ).toBe(false)
  })

  it('rate limits project-agent sends per sender session', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Release Notes' })
    await manager.setSessionProjectAgent(sessionAgent.agentId, {
      whenToUse: 'Draft release notes.',
    })

    for (let index = 0; index < 6; index += 1) {
      await manager.sendMessage('manager', sessionAgent.agentId, `note-${index + 1}`, 'auto')
    }

    await expect(
      manager.sendMessage('manager', sessionAgent.agentId, 'note-7', 'auto'),
    ).rejects.toThrow(
      'Project-agent messaging rate limit exceeded for this session. Batch your message or involve the user before continuing.',
    )

    const deliveredMessages = manager
      .getConversationHistory(sessionAgent.agentId)
      .filter(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'project_agent_input' &&
          entry.role === 'user',
      )

    expect(deliveredMessages).toHaveLength(6)
  })
})
