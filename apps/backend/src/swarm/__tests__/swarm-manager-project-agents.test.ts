import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getProjectAgentBackupsDir,
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
const workspaceResolverMockState = vi.hoisted(() => ({
  failNextResolvePassive: undefined as Error | undefined,
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

vi.mock('../project-workspace-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../project-workspace-resolver.js')>('../project-workspace-resolver.js')
  class MockProjectWorkspaceResolver extends actual.ProjectWorkspaceResolver {
    override async resolvePassive(
      ...args: Parameters<InstanceType<typeof actual.ProjectWorkspaceResolver>['resolvePassive']>
    ): ReturnType<InstanceType<typeof actual.ProjectWorkspaceResolver>['resolvePassive']> {
      const failure = workspaceResolverMockState.failNextResolvePassive
      if (failure) {
        workspaceResolverMockState.failNextResolvePassive = undefined
        throw failure
      }
      return super.resolvePassive(...args)
    }
  }
  return {
    ...actual,
    ProjectWorkspaceResolver: MockProjectWorkspaceResolver,
  }
})

import type { AgentDescriptor, ConversationAttachment, SwarmConfig } from '../types.js'
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

async function createRepoProjectAgentDefinition(rootDir: string, options: {
  definitionId: string
  handle?: string
  whenToUse?: string
  prompt?: string
  references?: Record<string, string>
  capabilities?: string[]
}): Promise<void> {
  const definitionDir = join(rootDir, '.forge', 'project-agents', options.definitionId)
  await mkdir(definitionDir, { recursive: true })
  await writeFile(
    join(definitionDir, 'config.json'),
    JSON.stringify({
      version: 1,
      handle: options.handle ?? options.definitionId,
      whenToUse: options.whenToUse ?? 'Use for repository docs.',
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    }),
    'utf8',
  )
  await writeFile(join(definitionDir, 'prompt.md'), options.prompt ?? 'Repo prompt body', 'utf8')
  if (options.references) {
    const referenceDir = join(definitionDir, 'reference')
    await mkdir(referenceDir, { recursive: true })
    for (const [fileName, content] of Object.entries(options.references)) {
      await writeFile(join(referenceDir, fileName), content, 'utf8')
    }
  }
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
  afterEach(() => {
    workspaceResolverMockState.failNextResolvePassive = undefined
  })

  it('activates a repo project-agent definition by creating a backing session without local prompt/reference copies', async () => {
    const config = await makeTempConfig()
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Maintain repository docs.',
      prompt: 'Repo docs prompt',
      references: { 'guide.md': '# Repo guide' },
      capabilities: ['create_session'],
    })
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const result = await manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'create',
      approvedCapabilities: ['create_session'],
    })

    expect(result.agentId).not.toBe('manager')
    const descriptor = manager.getAgent(result.agentId)!
    expect(descriptor.projectAgent).toMatchObject({
      handle: 'docs',
      whenToUse: 'Maintain repository docs.',
      capabilities: ['create_session'],
      sourceKind: 'repo',
    })
    expect(descriptor.projectAgent).not.toHaveProperty('source')
    expect(manager.getAgentForInternalUse(result.agentId)?.projectAgent?.source).toMatchObject({ type: 'repo', definitionId: 'docs' })
    await expect(stat(getProjectAgentDir(config.paths.dataDir, 'manager', 'docs'))).rejects.toMatchObject({ code: 'ENOENT' })
    const snapshot = await manager.getProjectAgentConfig(result.agentId)
    expect(snapshot.systemPrompt).toBe('Repo docs prompt')
    expect(snapshot.references).toEqual(['guide.md'])
    expect(await manager.getProjectAgentReference(result.agentId, 'guide.md')).toBe('# Repo guide')
    expect(snapshot.source).toMatchObject({ status: 'valid', definitionId: 'docs' })
    expect(manager.notifiedProjectAgentProfileIds).toContain('manager')
  })

  it('redacts repo project-agent source metadata from public list/bootstrap/snapshot payloads', async () => {
    const config = await makeTempConfig()
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Maintain repository docs.',
      prompt: 'Repo docs prompt',
    })
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const snapshots: Array<{ agents: AgentDescriptor[] }> = []
    const projectAgentUpdates: Array<{ projectAgent: AgentDescriptor['projectAgent'] | null }> = []
    manager.on('agents_snapshot', (event) => snapshots.push(event as { agents: AgentDescriptor[] }))
    manager.on('session_project_agent_updated', (event) => {
      projectAgentUpdates.push(event as { projectAgent: AgentDescriptor['projectAgent'] | null })
    })

    const result = await manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'create',
    })

    const liveDescriptor = (manager as unknown as { descriptors: Map<string, AgentDescriptor> }).descriptors.get(result.agentId)!
    liveDescriptor.sessionSystemPrompt = 'Private session role instructions from repo prompt composition.'
    ;(manager as unknown as { emitAgentsSnapshot: () => void }).emitAgentsSnapshot()
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    const assertPublicProjectAgent = (projectAgent: AgentDescriptor['projectAgent'] | undefined) => {
      expect(projectAgent).toMatchObject({ handle: 'docs', whenToUse: 'Maintain repository docs.', sourceKind: 'repo' })
      expect(projectAgent).not.toHaveProperty('source')
      expect(projectAgent).not.toHaveProperty('systemPrompt')
      expect(JSON.stringify(projectAgent)).not.toContain('forgeDirRealpath')
      expect(JSON.stringify(projectAgent)).not.toContain('workspaceKey')
      expect(JSON.stringify(projectAgent)).not.toContain('activatedAt')
    }
    const assertPublicDescriptor = (descriptor: AgentDescriptor | undefined) => {
      expect(descriptor).toBeDefined()
      expect(descriptor).not.toHaveProperty('sessionSystemPrompt')
      assertPublicProjectAgent(descriptor?.projectAgent)
    }

    assertPublicProjectAgent(result.projectAgent)
    assertPublicDescriptor(manager.getAgent(result.agentId))
    assertPublicDescriptor(manager.listAgents().find((agent) => agent.agentId === result.agentId))
    assertPublicDescriptor(manager.listBootstrapAgents().find((agent) => agent.agentId === result.agentId))
    assertPublicDescriptor(manager.listManagerAgents().find((agent) => agent.agentId === result.agentId))
    assertPublicDescriptor(snapshots.at(-1)?.agents.find((agent) => agent.agentId === result.agentId))
    assertPublicProjectAgent(projectAgentUpdates.at(-1)?.projectAgent ?? undefined)
    expect(manager.getAgentForInternalUse(result.agentId)?.sessionSystemPrompt).toBe('Private session role instructions from repo prompt composition.')
    expect(manager.getAgentForInternalUse(result.agentId)?.projectAgent?.source).toMatchObject({ type: 'repo', definitionId: 'docs' })
  })

  it('links an existing session to a repo project-agent source while preserving history and ignoring stale local prompt/reference', async () => {
    const config = await makeTempConfig()
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Current repo docs.',
      prompt: 'Current repo prompt',
    })
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const created = await manager.createSession('manager', { label: 'Docs' })
    await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      handle: 'docs',
      whenToUse: 'Old local docs',
      systemPrompt: 'Old local prompt',
    })
    await manager.sendMessage('manager', created.sessionAgent.agentId, 'keep this history')

    const result = await manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'link',
      targetAgentId: created.sessionAgent.agentId,
    })

    expect(result.agentId).toBe(created.sessionAgent.agentId)
    expect(manager.getConversationHistory(created.sessionAgent.agentId).some((entry) => entry.type === 'conversation_message')).toBe(true)
    await expect(stat(getProjectAgentDir(config.paths.dataDir, 'manager', 'docs'))).rejects.toMatchObject({ code: 'ENOENT' })
    const snapshot = await manager.getProjectAgentConfig(created.sessionAgent.agentId)
    expect(snapshot.systemPrompt).toBe('Current repo prompt')
    expect(snapshot.config.whenToUse).toBe('Current repo docs.')

    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Current repo docs.',
      prompt: 'Current repo prompt',
      capabilities: ['create_session'],
    })
    const updatedSnapshot = await manager.getProjectAgentConfig(created.sessionAgent.agentId)
    expect(updatedSnapshot.config.whenToUse).toBe('Current repo docs.')
    expect(updatedSnapshot.config.capabilities).toBeUndefined()

    const repoPromptPath = join(config.defaultCwd, '.forge', 'project-agents', 'docs', 'prompt.md')
    const repoPromptBeforeUnlink = await readFile(repoPromptPath, 'utf8')
    const demoted = await manager.setSessionProjectAgent(created.sessionAgent.agentId, null)
    expect(demoted.projectAgent).toBeNull()
    expect(manager.getAgent(created.sessionAgent.agentId)?.projectAgent).toBeUndefined()
    expect(manager.getConversationHistory(created.sessionAgent.agentId).some((entry) => entry.type === 'conversation_message')).toBe(true)
    expect(await readFile(repoPromptPath, 'utf8')).toBe(repoPromptBeforeUnlink)
    await expect(stat(getProjectAgentDir(config.paths.dataDir, 'manager', 'docs'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recycles repo project-agent runtimes on signature changes and uses the fresh prompt for deliveries', async () => {
    const config = await makeTempConfig()
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Maintain repository docs.',
      prompt: 'Repo docs prompt v1',
    })
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const result = await manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'create',
    })
    const firstRuntime = manager.runtimeByAgentId.get(result.agentId)
    expect(firstRuntime?.getSystemPrompt()).toContain('Repo docs prompt v1')

    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Maintain repository docs.',
      prompt: 'Repo docs prompt v2',
    })

    await manager.sendMessage('manager', result.agentId, 'Use the latest docs prompt.', 'auto')

    expect(firstRuntime?.recycleCalls).toBe(1)
    const freshRuntime = manager.runtimeByAgentId.get(result.agentId)
    expect(freshRuntime).not.toBe(firstRuntime)
    expect(freshRuntime?.getSystemPrompt()).toContain('Repo docs prompt v2')
    expect(freshRuntime?.getSystemPrompt()).not.toContain('Repo docs prompt v1')
    expect(manager.getAgent(result.agentId)?.projectAgent?.whenToUse).toBe('Maintain repository docs.')
  })

  it('blocks repo project-agent delivery and runtime creation when the source is missing or busy-stale', async () => {
    const config = await makeTempConfig()
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, { definitionId: 'docs', prompt: 'Repo prompt v1' })
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const result = await manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'create',
    })

    const runtime = manager.runtimeByAgentId.get(result.agentId)!
    runtime.busy = true
    runtime.descriptor.status = 'streaming'
    const liveState = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    liveState.descriptors.get(result.agentId)!.status = 'streaming'
    await createRepoProjectAgentDefinition(config.defaultCwd, { definitionId: 'docs', prompt: 'Repo prompt v2' })

    await expect(manager.sendMessage('manager', result.agentId, 'stale busy delivery', 'auto')).rejects.toThrow(/changed while .*active runtime/i)
    expect(runtime.sendCalls.some((call) => String(call.message).includes('stale busy delivery'))).toBe(false)

    runtime.busy = false
    runtime.descriptor.status = 'idle'
    liveState.descriptors.get(result.agentId)!.status = 'idle'
    await rm(join(config.defaultCwd, '.forge', 'project-agents', 'docs'), { recursive: true, force: true })
    manager.runtimeByAgentId.delete(result.agentId)
    liveState.descriptors.get(result.agentId)!.contextUsage = undefined

    await expect(manager.handleUserMessage('missing direct user message', { targetAgentId: result.agentId })).rejects.toThrow(/Repository project-agent source docs is missing/i)
    expect(manager.runtimeByAgentId.has(result.agentId)).toBe(false)
    expect(
      manager.getConversationHistory(result.agentId).some(
        (entry) => entry.type === 'conversation_message' && entry.text === 'missing direct user message',
      ),
    ).toBe(false)

    await expect(manager.sendMessage('manager', result.agentId, 'missing delivery', 'auto')).rejects.toThrow(/Repository project-agent source docs is missing/i)
    expect(manager.runtimeByAgentId.has(result.agentId)).toBe(false)
  })

  it('keeps project-agent directory source-aware while preserving approved capabilities', async () => {
    const config = await makeTempConfig()
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Old repo docs blurb.',
      prompt: 'Repo docs prompt',
      capabilities: ['create_session'],
    })
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const result = await manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'create',
      approvedCapabilities: ['create_session'],
    })

    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Updated repo docs blurb.',
      prompt: 'Repo docs prompt',
    })
    const preview = await manager.previewManagerSystemPromptForAgent('manager')
    const content = preview.sections.map((section) => section.content).join('\n')
    expect(content).toContain('Updated repo docs blurb.')
    expect(content).not.toContain('Old repo docs blurb.')
    expect(content).toContain('@docs')
    expect(manager.getAgent(result.agentId)?.projectAgent?.capabilities).toEqual(['create_session'])

    await writeFile(join(config.defaultCwd, '.forge', 'project-agents', 'docs', 'prompt.md'), '   ', 'utf8')
    const invalidPreview = await manager.previewManagerSystemPromptForAgent('manager')
    const invalidContent = invalidPreview.sections.map((section) => section.content).join('\n')
    expect(invalidContent).not.toContain('@docs')
    expect(invalidContent).toContain('Project agents in this profile')
  })

  it('filters shared repo-sourced project agents from external directories unless the source is valid', async () => {
    const config = await makeTempConfig()
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Use for `[docs]`\u202E.',
      prompt: 'Repo docs prompt',
    })
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const target = await manager.createManager('manager', { name: 'target', cwd: config.defaultCwd })
    const result = await manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'create',
    })
    const liveState = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    liveState.descriptors.get(result.agentId)!.sessionLabel = 'Docs\nAgent'
    await manager.setProjectAgentSharing(result.agentId, [target.profileId ?? target.agentId])

    const validEntries = await manager.getProjectAgentExternalDirectory(target.profileId ?? target.agentId)
    expect(validEntries).toHaveLength(1)
    expect(validEntries[0]).toMatchObject({
      agentId: result.agentId,
      handle: 'manager/docs',
      displayName: 'Docs Agent',
      whenToUse: "Use for 'docs'.",
      sourceProjectName: 'manager',
      origin: 'external',
    })
    expect(JSON.stringify(validEntries[0])).not.toContain('forgeDirRealpath')
    expect(JSON.stringify(validEntries[0])).not.toContain('workspaceKey')
    expect(JSON.stringify(validEntries[0])).not.toContain('.forge')

    await rm(join(config.defaultCwd, '.forge', 'project-agents', 'docs'), { recursive: true, force: true })
    await expect(manager.getProjectAgentExternalDirectory(target.profileId ?? target.agentId)).resolves.toEqual([])

    await createRepoProjectAgentDefinition(config.defaultCwd, { definitionId: 'docs', prompt: '   ' })
    await expect(manager.getProjectAgentExternalDirectory(target.profileId ?? target.agentId)).resolves.toEqual([])

    const otherRepo = join(config.paths.dataDir, 'other-repo')
    await mkdir(otherRepo, { recursive: true })
    execFileSync('git', ['init'], { cwd: otherRepo, stdio: 'ignore' })
    liveState.descriptors.get(result.agentId)!.cwd = otherRepo
    await createRepoProjectAgentDefinition(config.defaultCwd, { definitionId: 'docs', prompt: 'Repo docs prompt restored' })
    await expect(manager.getProjectAgentExternalDirectory(target.profileId ?? target.agentId)).resolves.toEqual([])
  })

  it('blocks stale external sends to unavailable repo-sourced shared agents with sanitized errors and target notifications', async () => {
    const config = await makeTempConfig()
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Use for repository docs.',
      prompt: 'Repo docs prompt',
    })
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const target = await manager.createManager('manager', { name: 'target', cwd: config.defaultCwd })
    const result = await manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'create',
    })
    await manager.setProjectAgentSharing(result.agentId, [target.profileId ?? target.agentId])

    await manager.sendMessage(target.agentId, result.agentId, 'valid external delivery', 'auto')
    const sourceRuntime = manager.runtimeByAgentId.get(result.agentId)
    expect(sourceRuntime?.sendCalls.at(-1)?.message).toContain('valid external delivery')
    const sendCallsAfterValidDelivery = sourceRuntime?.sendCalls.length ?? 0

    await rm(join(config.defaultCwd, '.forge', 'project-agents', 'docs'), { recursive: true, force: true })
    manager.notifiedProjectAgentProfileIds.length = 0

    let sendError: unknown
    try {
      await manager.sendMessage(target.agentId, result.agentId, 'stale external delivery', 'auto')
    } catch (error) {
      sendError = error
    }

    expect(sendError).toBeInstanceOf(Error)
    const message = sendError instanceof Error ? sendError.message : String(sendError)
    expect(message).toMatch(/Shared project agent @docs is unavailable because its repository source is missing/i)
    expect(message).not.toContain(config.defaultCwd)
    expect(message).not.toContain('.forge')
    expect(message).not.toContain('forgeDirRealpath')
    expect(message).not.toContain('workspaceKey')
    expect(sourceRuntime?.sendCalls.length ?? 0).toBe(sendCallsAfterValidDelivery)
    expect(manager.notifiedProjectAgentProfileIds).toContain(target.profileId ?? target.agentId)

    await createRepoProjectAgentDefinition(config.defaultCwd, { definitionId: 'docs', prompt: '   ' })
    manager.notifiedProjectAgentProfileIds.length = 0
    let invalidError: unknown
    try {
      await manager.sendMessage(target.agentId, result.agentId, 'invalid external delivery', 'auto')
    } catch (error) {
      invalidError = error
    }

    expect(invalidError).toBeInstanceOf(Error)
    const invalidMessage = invalidError instanceof Error ? invalidError.message : String(invalidError)
    expect(invalidMessage).toMatch(/Shared project agent @docs is unavailable because its repository source is invalid/i)
    expect(invalidMessage).not.toContain(config.defaultCwd)
    expect(invalidMessage).not.toContain('.forge')
    expect(invalidMessage).not.toContain('forgeDirRealpath')
    expect(invalidMessage).not.toContain('workspaceKey')
    expect(sourceRuntime?.sendCalls.length ?? 0).toBe(sendCallsAfterValidDelivery)
    expect(manager.notifiedProjectAgentProfileIds).toContain(target.profileId ?? target.agentId)
    await expect(manager.getProjectAgentExternalDirectory(target.profileId ?? target.agentId)).resolves.toEqual([])
  })

  it('sanitizes external sends when repo source workspace resolution fails', async () => {
    const config = await makeTempConfig()
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Use for repository docs.',
      prompt: 'Repo docs prompt',
    })
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const target = await manager.createManager('manager', { name: 'target', cwd: config.defaultCwd })
    const result = await manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'create',
    })
    await manager.setProjectAgentSharing(result.agentId, [target.profileId ?? target.agentId])
    const liveState = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    const sourceDescriptor = liveState.descriptors.get(result.agentId)
    const source = sourceDescriptor?.projectAgent?.source
    expect(source?.type).toBe('repo')
    manager.notifiedProjectAgentProfileIds.length = 0

    workspaceResolverMockState.failNextResolvePassive = new Error(
      `EACCES: permission denied, scandir '${join(config.defaultCwd, '.forge', 'extensions')}' workspaceKey=${
        source?.type === 'repo' ? source.workspaceKey : 'missing-workspace-key'
      } forgeDirRealpath=${source?.type === 'repo' ? source.forgeDirRealpath : 'missing-forge-dir'}`,
    )

    let sendError: unknown
    try {
      await manager.sendMessage(target.agentId, result.agentId, 'resolver failure delivery', 'auto')
    } catch (error) {
      sendError = error
    }

    expect(sendError).toBeInstanceOf(Error)
    const message = sendError instanceof Error ? sendError.message : String(sendError)
    expect(message).toMatch(/Shared project agent @docs is unavailable because its repository source is unavailable/i)
    expect(message).not.toContain(config.defaultCwd)
    expect(message).not.toContain('.forge')
    expect(message).not.toContain('forgeDirRealpath')
    expect(message).not.toContain('workspaceKey')
    if (source?.type === 'repo') {
      expect(message).not.toContain(source.workspaceKey)
      expect(message).not.toContain(source.forgeDirRealpath)
    }
    expect(manager.runtimeByAgentId.get(result.agentId)?.sendCalls.some((call) => call.message.includes('resolver failure delivery'))).toBe(false)
    expect(manager.notifiedProjectAgentProfileIds).toContain(target.profileId ?? target.agentId)
  })

  it('notifies shared target profiles when repo source preflight live-syncs directory metadata', async () => {
    const config = await makeTempConfig()
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Old repo docs blurb.',
      prompt: 'Repo docs prompt v1',
    })
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const target = await manager.createManager('manager', { name: 'target', cwd: config.defaultCwd })
    const result = await manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'create',
    })
    await manager.setProjectAgentSharing(result.agentId, [target.profileId ?? target.agentId])
    manager.notifiedProjectAgentProfileIds.length = 0

    await createRepoProjectAgentDefinition(config.defaultCwd, {
      definitionId: 'docs',
      whenToUse: 'Updated repo docs blurb.',
      prompt: 'Repo docs prompt v2',
    })
    await manager.validateProjectAgentSourceForRead(result.agentId)

    expect(manager.getAgent(result.agentId)?.projectAgent?.whenToUse).toBe('Updated repo docs blurb.')
    expect(manager.notifiedProjectAgentProfileIds).toContain('manager')
    expect(manager.notifiedProjectAgentProfileIds).toContain(target.profileId ?? target.agentId)
  })

  it('notifies existing shared target profiles after linking a local project agent to a repo source', async () => {
    const config = await makeTempConfig()
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, { definitionId: 'docs', prompt: 'Repo prompt' })
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const target = await manager.createManager('manager', { name: 'target', cwd: config.defaultCwd })
    const created = await manager.createSession('manager', { label: 'Docs' })
    await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      handle: 'docs',
      whenToUse: 'Local docs',
      systemPrompt: 'Local prompt',
    })
    await manager.setProjectAgentSharing(created.sessionAgent.agentId, [target.profileId ?? target.agentId])
    manager.notifiedProjectAgentProfileIds.length = 0

    await manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'link',
      targetAgentId: created.sessionAgent.agentId,
    })

    expect(manager.notifiedProjectAgentProfileIds).toContain(target.profileId ?? target.agentId)
  })

  it('leaves local project agents unaffected by repo source preflights', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const created = await manager.createSession('manager', { label: 'Local Docs' })
    await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      handle: 'local-docs',
      whenToUse: 'Use local docs agent.',
      systemPrompt: 'Local docs prompt.',
    })

    await manager.sendMessage('manager', created.sessionAgent.agentId, 'local delivery', 'auto')

    expect(manager.runtimeByAgentId.get(created.sessionAgent.agentId)?.sendCalls.at(-1)?.message).toContain('local delivery')
    expect(
      manager.getConversationHistory(created.sessionAgent.agentId).some(
        (entry) => entry.type === 'conversation_message' && entry.source === 'project_agent_input' && entry.text === 'local delivery',
      ),
    ).toBe(true)
  })

  it('backs up local project-agent sidecars before linking to a repo source', async () => {
    const config = await makeTempConfig()
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, { definitionId: 'docs', prompt: 'Repo prompt' })
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const created = await manager.createSession('manager', { label: 'Docs' })
    await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      handle: 'docs',
      whenToUse: 'Local docs',
      systemPrompt: 'Local prompt to preserve',
    })

    await manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'link',
      targetAgentId: created.sessionAgent.agentId,
    })

    await expect(stat(getProjectAgentDir(config.paths.dataDir, 'manager', 'docs'))).rejects.toMatchObject({ code: 'ENOENT' })
    const backups = await readdir(getProjectAgentBackupsDir(config.paths.dataDir, 'manager'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(getProjectAgentBackupsDir(config.paths.dataDir, 'manager'), backups[0]!, 'prompt.md'), 'utf8')).toBe('Local prompt to preserve')
  })

  it('rolls back repo project-agent create and link activation when persistence fails', async () => {
    const config = await makeTempConfig()
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, { definitionId: 'docs', prompt: 'Repo prompt' })
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const originalSaveStore = (manager as unknown as { saveStore: () => Promise<void> }).saveStore.bind(manager)
    let failNextSave = false
    ;(manager as unknown as { saveStore: () => Promise<void> }).saveStore = async () => {
      if (failNextSave) {
        failNextSave = false
        throw new Error('save failed')
      }
      await originalSaveStore()
    }

    failNextSave = true
    await expect(manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'create',
    })).rejects.toThrow('save failed')
    expect(manager.listAgents().some((agent) => agent.agentId !== 'manager' && agent.projectAgent?.handle === 'docs')).toBe(false)

    const created = await manager.createSession('manager', { label: 'Docs' })
    await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      handle: 'docs',
      whenToUse: 'Local docs',
      systemPrompt: 'Local prompt',
    })
    failNextSave = true
    await expect(manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'link',
      targetAgentId: created.sessionAgent.agentId,
    })).rejects.toThrow('save failed')
    expect(manager.getAgent(created.sessionAgent.agentId)?.projectAgent).toMatchObject({
      handle: 'docs',
      whenToUse: 'Local docs',
    })
    expect(await readFile(getProjectAgentPromptPath(config.paths.dataDir, 'manager', 'docs'), 'utf8')).toBe('Local prompt')
  })

  it('blocks repo project-agent activation collisions, workspace mismatches, and invalid definitions', async () => {
    const config = await makeTempConfig()
    execFileSync('git', ['init'], { cwd: config.defaultCwd, stdio: 'ignore' })
    await createRepoProjectAgentDefinition(config.defaultCwd, { definitionId: 'docs', prompt: 'Repo prompt' })
    await createRepoProjectAgentDefinition(config.defaultCwd, { definitionId: 'qa', prompt: 'QA prompt' })
    await createRepoProjectAgentDefinition(config.defaultCwd, { definitionId: 'bad', prompt: '   ' })
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const existing = await manager.createSession('manager', { label: 'Docs' })
    await manager.setSessionProjectAgent(existing.sessionAgent.agentId, { handle: 'docs', whenToUse: 'Local docs' })

    await expect(manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'docs',
      mode: 'create',
    })).rejects.toThrow(/already in use/i)
    await expect(manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'bad',
      mode: 'create',
    })).rejects.toThrow(/invalid/i)

    const otherRoot = join(config.paths.rootDir, 'other')
    await mkdir(otherRoot, { recursive: true })
    execFileSync('git', ['init'], { cwd: otherRoot, stdio: 'ignore' })
    const other = await manager.createSessionWithOverrides('manager', { label: 'Other' }, { cwd: otherRoot })
    await expect(manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'qa',
      mode: 'link',
      targetAgentId: other.sessionAgent.agentId,
    })).rejects.toThrow(/workspace does not match/i)
    await expect(manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'qa',
      mode: 'link',
      targetAgentId: other.sessionAgent.agentId,
      explicitBindToSourceWorkspace: true,
    })).rejects.toThrow(/different workspace is not supported/i)
    await expect(manager.activateRepoProjectAgent({
      profileId: 'manager',
      sessionAgentId: 'manager',
      definitionId: 'qa',
      mode: 'link',
      targetAgentId: other.sessionAgent.agentId,
      applyRecommendedModel: true,
    })).rejects.toThrow(/applyRecommendedModel is not supported/i)
  })

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

    await expect(
      manager.setSessionProjectAgent(created.sessionAgent.agentId, {
        handle: 'ship-notes',
        whenToUse: 'Try to rename the handle.',
      }),
    ).rejects.toThrow('Cannot change project agent handle after promotion. Demote and re-promote to change the handle.')
    expect(manager.getAgent(created.sessionAgent.agentId)?.projectAgent?.handle).toBe('releases')
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

  it('preserves project-agent capabilities across later edits', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.createSession('manager', { label: 'QA' })

    const promoted = await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      whenToUse: 'Reproduce issues.',
      capabilities: ['create_session'],
    })
    expect(promoted.projectAgent).toEqual({
      handle: 'qa',
      whenToUse: 'Reproduce issues.',
      capabilities: ['create_session'],
    })

    const updated = await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      whenToUse: 'Reproduce issues and create follow-up sessions.',
    })
    expect(updated.projectAgent).toEqual({
      handle: 'qa',
      whenToUse: 'Reproduce issues and create follow-up sessions.',
      capabilities: ['create_session'],
    })
    expect(JSON.parse(await readFile(getProjectAgentConfigPath(config.paths.dataDir, 'manager', 'qa'), 'utf8'))).toMatchObject({
      agentId: created.sessionAgent.agentId,
      handle: 'qa',
      capabilities: ['create_session'],
    })
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



  it('getProjectAgentConfig falls back to the in-memory descriptor when the mirror record is missing', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.createSession('manager', { label: 'QA' })
    await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      whenToUse: 'Reproduce issues.',
      systemPrompt: 'You are QA.',
      capabilities: ['create_session'],
    })
    await rm(getProjectAgentDir(config.paths.dataDir, 'manager', 'qa'), { recursive: true, force: true })

    const result = await manager.getProjectAgentConfig(created.sessionAgent.agentId)

    expect(result).toEqual({
      config: {
        version: 1,
        agentId: created.sessionAgent.agentId,
        handle: 'qa',
        whenToUse: 'Reproduce issues.',
        capabilities: ['create_session'],
        promotedAt: created.sessionAgent.createdAt,
        updatedAt: expect.any(String),
      },
      systemPrompt: 'You are QA.',
      references: [],
    })
  })

  it('blocks edits to repo-sourced project agents and exposes unavailable source config', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.createSession('manager', { label: 'Docs' })
    const source = {
      type: 'repo' as const,
      workspaceKey: 'manager::/repo',
      forgeDirRealpath: '/repo/.forge',
      definitionId: 'docs',
      activatedAt: '2026-04-03T00:00:00.000Z',
    }
    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    const descriptor = state.descriptors.get(created.sessionAgent.agentId)
    expect(descriptor).toBeDefined()
    descriptor!.projectAgent = {
      handle: 'docs',
      whenToUse: 'Maintain docs.',
      source,
    }

    await expect(
      manager.setSessionProjectAgent(created.sessionAgent.agentId, {
        whenToUse: 'Updated docs.',
        systemPrompt: 'Localized prompt',
      }),
    ).rejects.toThrow('Repository-managed project agents are read-only')

    expect(state.descriptors.get(created.sessionAgent.agentId)?.projectAgent?.source).toEqual(source)
    expect(await manager.getProjectAgentConfig(created.sessionAgent.agentId)).toEqual({
      config: {
        version: 1,
        agentId: created.sessionAgent.agentId,
        handle: 'docs',
        whenToUse: '',
        promotedAt: created.sessionAgent.createdAt,
        updatedAt: expect.any(String),
      },
      systemPrompt: null,
      references: [],
      source: {
        type: 'repo',
        status: 'wrong_workspace',
        problems: expect.arrayContaining([
          expect.objectContaining({ code: 'repo_project_agent_workspace_key_mismatch' }),
          expect.objectContaining({ code: 'repo_project_agent_forge_dir_mismatch', path: 'project-agents' }),
        ]),
        ...source,
      },
    })
  })

  it('rejects project-agent reference path traversal through the manager facade', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.createSession('manager', { label: 'Docs' })
    await manager.setSessionProjectAgent(created.sessionAgent.agentId, {
      whenToUse: 'Maintain docs.',
    })

    await expect(
      manager.setProjectAgentReference(created.sessionAgent.agentId, '../escape.md', 'escaped'),
    ).rejects.toThrow('Invalid path segment')
    await expect(manager.getProjectAgentReference(created.sessionAgent.agentId, '../escape.md')).rejects.toThrow(
      'Invalid path segment',
    )
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
    await rm(getProjectAgentDir(config.paths.dataDir, 'manager', 'release-notes'), { recursive: true, force: true })

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

  it('createAndPromoteProjectAgent preserves unrelated live descriptor changes when provisioning fails', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const creator = await manager.createSession('manager', {
      label: 'Agent Creator',
      sessionPurpose: 'agent_creator',
    })
    const unrelated = await manager.createSession('manager', { label: 'Unrelated Session' })
    const agentIdsBefore = manager.listAgents().map((agent) => agent.agentId).sort()

    vi.spyOn(manager as any, 'createRuntimeForDescriptor').mockImplementationOnce(async () => {
      await manager.renameSession(unrelated.sessionAgent.agentId, 'Unrelated Updated')
      throw new Error('runtime boom')
    })

    await expect(
      manager.createAndPromoteProjectAgent(creator.sessionAgent.agentId, {
        sessionName: 'Release Notes',
        whenToUse: 'Draft release notes.',
        systemPrompt: 'You are the release notes project agent.',
      }),
    ).rejects.toThrow('runtime boom')

    expect(manager.listAgents().map((agent) => agent.agentId).sort()).toEqual(agentIdsBefore)
    expect(manager.getAgent(unrelated.sessionAgent.agentId)?.sessionLabel).toBe('Unrelated Updated')
    await expect(stat(getProjectAgentDir(config.paths.dataDir, 'manager', 'release-notes'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(manager.notifiedProjectAgentProfileIds).toEqual([])
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

    vi.spyOn((manager as any).descriptorStore, 'save').mockRejectedValueOnce(new Error('save boom'))

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

    const attachments: ConversationAttachment[] = [
      {
        type: 'text',
        mimeType: 'text/plain',
        text: 'attachment content that must not be expanded for project-agent delivery',
        fileName: 'notes.txt',
      },
    ]
    const createdRuntimeCountBeforeSend = manager.createdRuntimeIds.length
    const existingSendCallCount = manager.runtimeByAgentId.get(sessionAgent.agentId)?.sendCalls.length ?? 0

    await expect(manager.sendMessage('manager', sessionAgent.agentId, 'Please draft release notes.', 'auto', {
      attachments,
    })).rejects.toThrow(/do not support attachments/i)

    expect(manager.createdRuntimeIds.length).toBe(createdRuntimeCountBeforeSend)

    const recreatedRuntime = manager.runtimeByAgentId.get(sessionAgent.agentId)
    expect(recreatedRuntime?.sendCalls.length ?? 0).toBe(existingSendCallCount)

    const targetHistory = manager.getConversationHistory(sessionAgent.agentId)
    expect(
      targetHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'project_agent_input' &&
          entry.role === 'user' &&
          entry.text === 'Please draft release notes.',
      ),
    ).toBe(false)

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
    ).toBe(false)
  })

  it('does not append target transcript or mark activity when project-agent runtime send fails', async () => {
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
    manager.onCreateRuntime = ({ runtime }) => {
      runtime.sendMessageError = new Error('runtime send failed')
    }
    const updatedAtBeforeSend = manager.getAgent(sessionAgent.agentId)?.updatedAt

    await expect(
      manager.sendMessage('manager', sessionAgent.agentId, 'Please draft release notes.', 'auto'),
    ).rejects.toThrow('runtime send failed')

    expect(manager.getAgent(sessionAgent.agentId)?.updatedAt).toBe(updatedAtBeforeSend)
    expect(
      manager
        .getConversationHistory(sessionAgent.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.source === 'project_agent_input' &&
            entry.text === 'Please draft release notes.',
        ),
    ).toBe(false)
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
    expect(sessionRuntime?.sendCalls.at(-1)?.message).toBe(
      'SYSTEM: closeout reminder\n[assistantOutputTarget] {"kind":"explicit_tool_required","reason":"agent_message"}',
    )

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

  it('allows a different sender session after another sender exhausts its project-agent rate limit', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const senderTwo = await manager.createSession('manager', { label: 'Coordinator Two' })
    const { sessionAgent: target } = await manager.createSession('manager', { label: 'Release Notes' })
    await manager.setSessionProjectAgent(target.agentId, {
      whenToUse: 'Draft release notes.',
    })

    for (let index = 0; index < 6; index += 1) {
      await manager.sendMessage('manager', target.agentId, `sender-one-${index + 1}`, 'auto')
    }
    await expect(manager.sendMessage('manager', target.agentId, 'sender-one-7', 'auto')).rejects.toThrow(
      'Project-agent messaging rate limit exceeded for this session. Batch your message or involve the user before continuing.',
    )

    const receipt = await manager.sendMessage(senderTwo.sessionAgent.agentId, target.agentId, 'sender-two-1', 'auto')

    expect(receipt.targetAgentId).toBe(target.agentId)
    const deliveredMessages = manager
      .getConversationHistory(target.agentId)
      .filter(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'project_agent_input' &&
          entry.role === 'user',
      )
    expect(deliveredMessages.map((entry) => (entry.type === 'conversation_message' ? entry.text : ''))).toContain(
      'sender-two-1',
    )
    expect(deliveredMessages).toHaveLength(7)
  })
})
