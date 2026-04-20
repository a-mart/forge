import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionManager } from '@mariozechner/pi-coding-agent'
import { getCatalogModelKey } from '@forge/protocol'
import { getConversationHistoryCacheFilePath } from '../swarm/conversation-history-cache.js'
import {
  getCommonKnowledgePath,
  getCortexReviewRunsPath,
  getProjectAgentConfigPath,
  getProjectAgentDir,
  getProjectAgentPromptPath,
  getSessionDir,
} from '../swarm/data-paths.js'
import { makeTempConfig as buildTempConfig } from '../test-support/index.js'
const memoryMergeMockState = vi.hoisted(() => ({
  executeLLMMerge: vi.fn(async (..._args: any[]) => '# Swarm Memory\n\n## Decisions\n- merged by mock\n'),
}))
const projectAgentAnalysisMockState = vi.hoisted(() => ({
  analyzeSessionForPromotion: vi.fn(async (..._args: any[]) => ({
    whenToUse: 'Use for release coordination.',
    systemPrompt: 'You are the release coordination manager.',
  })),
}))

vi.mock('../swarm/memory-merge.js', async () => {
  const actual = await vi.importActual<typeof import('../swarm/memory-merge.js')>('../swarm/memory-merge.js')
  return {
    ...actual,
    executeLLMMerge: (...args: Parameters<typeof actual.executeLLMMerge>) =>
      memoryMergeMockState.executeLLMMerge(...args),
  }
})

vi.mock('../swarm/project-agent-analysis.js', async () => {
  const actual = await vi.importActual<typeof import('../swarm/project-agent-analysis.js')>('../swarm/project-agent-analysis.js')
  return {
    ...actual,
    analyzeSessionForPromotion: (...args: Parameters<typeof actual.analyzeSessionForPromotion>) =>
      projectAgentAnalysisMockState.analyzeSessionForPromotion(...args),
  }
})

import { readSessionMeta, writeSessionMeta } from '../swarm/session-manifest.js'
import { AgentRuntime } from '../swarm/agent-runtime.js'
import { modelCatalogService } from '../swarm/model-catalog-service.js'
import { loadModelChangeContinuityState } from '../swarm/runtime/model-change-continuity.js'
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SwarmConfig,
} from '../swarm/types.js'
import type {
  RuntimeCreationOptions,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeUserMessage,
  SwarmAgentRuntime,
} from '../swarm/runtime-contracts.js'
import { FakeRuntime, TestSwarmManager as TestSwarmManagerBase, bootWithDefaultManager } from '../test-support/index.js'

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

class FallbackReplaySession {
  isStreaming = false
  promptCalls: string[] = []
  steerCalls: string[] = []
  listener: ((event: any) => void) | undefined
  promptImpl: ((message: string) => Promise<void>) | undefined
  steerImpl: ((message: string) => Promise<void>) | undefined
  private sessionMessages: unknown[] = []

  readonly sessionManager = {
    getEntries: () => [],
    buildSessionContext: () => ({ messages: structuredClone(this.sessionMessages) as unknown[] }),
    resetLeaf: () => {
      this.sessionMessages = []
    },
    appendModelChange: () => {},
    appendThinkingLevelChange: () => {},
    appendMessage: (message: unknown) => {
      this.sessionMessages.push(structuredClone(message))
    },
    appendCustomEntry: () => 'custom-id',
  }

  readonly model = { provider: 'openai-codex', id: 'gpt-5.3-codex' }
  readonly thinkingLevel = 'medium'
  readonly state = { messages: [] as Array<{ role?: string; stopReason?: string }> }
  readonly agent = {
    state: this.state,
  }

  async prompt(message: string): Promise<void> {
    this.promptCalls.push(message)
    if (this.promptImpl) {
      await this.promptImpl(message)
    }
  }

  async steer(message: string): Promise<void> {
    this.steerCalls.push(message)
    if (this.steerImpl) {
      await this.steerImpl(message)
    }
  }

  async sendUserMessage(): Promise<void> {}
  async abort(): Promise<void> {}
  async compact(): Promise<unknown> { return { ok: true } }
  getContextUsage(): AgentContextUsage | undefined { return undefined }
  dispose(): void {}

  subscribe(listener: (event: any) => void): () => void {
    this.listener = listener
    return () => {
      this.listener = undefined
    }
  }

  emit(event: any): void {
    this.listener?.(event)
  }
}

class ForgeRuntimeHookTestManager extends TestSwarmManager {
  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions,
  ): Promise<SwarmAgentRuntime> {
    const runtime = await super.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options)

    if (runtimeToken !== undefined) {
      const forgeExtensionHost = (this as any).forgeExtensionHost
      const bindings = await forgeExtensionHost.prepareRuntimeBindings({
        descriptor,
        runtimeType: 'pi',
        runtimeToken,
      })
      if (bindings) {
        forgeExtensionHost.activateRuntimeBindings(bindings)
      }
    }

    return runtime
  }
}

class RuntimeFallbackReplayTestManager extends TestSwarmManager {
  fallbackReplaySessionByAgentId = new Map<string, FallbackReplaySession>()
  fallbackReplayRuntimeByAgentId = new Map<string, AgentRuntime>()
  fallbackReplayWorkerId: string | undefined

  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions,
  ): Promise<SwarmAgentRuntime> {
    const workerId = this.fallbackReplayWorkerId
    const creationCount = (this.runtimeCreationCountByAgentId.get(descriptor.agentId) ?? 0) + 1

    if (workerId && descriptor.agentId === workerId && creationCount === 1) {
      const session = new FallbackReplaySession()
      const runtime = new AgentRuntime({
        descriptor: structuredClone(descriptor),
        session: session as any,
        systemPrompt,
        callbacks: {
          onStatusChange: async () => {},
          onSessionEvent: async () => {},
          onAgentEnd: async () => {},
          onRuntimeError: async () => {},
        },
      })
      this.runtimeCreationCountByAgentId.set(descriptor.agentId, creationCount)
      this.createdRuntimeIds.push(descriptor.agentId)
      this.fallbackReplaySessionByAgentId.set(descriptor.agentId, session)
      this.fallbackReplayRuntimeByAgentId.set(descriptor.agentId, runtime)
      this.systemPromptByAgentId.set(descriptor.agentId, systemPrompt)
      return runtime as unknown as SwarmAgentRuntime
    }

    return super.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options)
  }
}

class ProjectAgentAwareSwarmManager extends TestSwarmManager {
  readonly notifiedProjectAgentProfileIds: string[] = []

  override async notifyProjectAgentsChanged(profileId: string): Promise<void> {
    this.notifiedProjectAgentProfileIds.push(profileId)
  }
}

function appendSessionConversationMessage(sessionFile: string, agentId: string, text: string): void {
  const sessionManager = SessionManager.open(sessionFile)
  sessionManager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'seed' }],
  } as any)
  sessionManager.appendCustomEntry('swarm_conversation_entry', {
    type: 'conversation_message',
    agentId,
    role: 'assistant',
    text,
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'speak_to_user',
  })
}

async function waitForFileText(path: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error(`Timed out waiting for ${path}`)
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await condition()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  throw new Error('Timed out waiting for async condition')
}

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T) => {}
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })

  return { promise, resolve }
}

function expectStartedReviewRun<T>(run: T | null): T {
  expect(run).not.toBeNull()
  if (!run) {
    throw new Error('Expected Cortex review run to be created')
  }
  return run
}

async function seedNeedsReviewSession(
  config: SwarmConfig,
  profileId = 'alpha',
  sessionId = 'alpha--s1',
): Promise<void> {
  const sessionDir = getSessionDir(config.paths.dataDir, profileId, sessionId)
  const sessionFileContent = '{"type":"message","role":"user","content":[{"type":"text","text":"needs review"}]}\n'

  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.jsonl'), sessionFileContent, 'utf8')
  await writeFile(
    join(sessionDir, 'meta.json'),
    `${JSON.stringify(
      {
        profileId,
        sessionId,
        stats: {
          sessionFileSize: Buffer.byteLength(sessionFileContent, 'utf8'),
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  )
}

function seedManagerDescriptorForRuntimeEventTests(manager: TestSwarmManager, config: SwarmConfig): void {
  const createdAt = '2026-01-01T00:00:00.000Z'
  const state = manager as unknown as {
    descriptors: Map<string, AgentDescriptor>
    conversationEntriesByAgentId: Map<string, unknown[]>
  }

  state.descriptors.set('manager', {
    agentId: 'manager',
    displayName: 'Manager',
    role: 'manager',
    managerId: 'manager',
    status: 'idle',
    createdAt,
    updatedAt: createdAt,
    cwd: config.defaultCwd,
    model: config.defaultModel,
    sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
  })
  state.conversationEntriesByAgentId.set('manager', [])
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

async function installForgeRuntimeErrorLogger(config: SwarmConfig, logPath: string): Promise<void> {
  const extensionsDir = join(config.paths.dataDir, 'extensions')
  await mkdir(extensionsDir, { recursive: true })
  await writeFile(
    join(extensionsDir, 'runtime-error.ts'),
    `
      import { appendFileSync } from "node:fs"
      export default (forge) => {
        forge.on("runtime:error", (event) => {
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


  it('createSession uses slugified names for session agent ids and suffixes duplicates', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const first = await manager.createSession('manager', { name: 'My Cool Session' })
    const second = await manager.createSession('manager', { name: 'My Cool Session' })
    const fallback = await manager.createSession('manager', { name: '   ' })

    expect(first.sessionAgent.agentId).toBe('my-cool-session')
    expect(first.sessionAgent.sessionLabel).toBe('My Cool Session')
    expect(second.sessionAgent.agentId).toBe('my-cool-session-2')
    expect(second.sessionAgent.sessionLabel).toBe('My Cool Session')
    expect(fallback.sessionAgent.agentId).toBe('manager--s2')
  })

  it('renameSession appends rename-history.json entries in the session directory', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.createSession('manager', { label: 'Initial Session Label' })

    await manager.renameSession(created.sessionAgent.agentId, 'Renamed Once')
    await manager.renameSession(created.sessionAgent.agentId, 'Renamed Twice')

    const renameHistoryPath = join(
      getSessionDir(config.paths.dataDir, 'manager', created.sessionAgent.agentId),
      'rename-history.json',
    )

    const history = JSON.parse(await readFile(renameHistoryPath, 'utf8')) as Array<{
      from: string
      to: string
      renamedAt: string
    }>

    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({
      from: 'Initial Session Label',
      to: 'Renamed Once',
    })
    expect(history[1]).toMatchObject({
      from: 'Renamed Once',
      to: 'Renamed Twice',
    })
    expect(typeof history[0]?.renamedAt).toBe('string')
    expect(typeof history[1]?.renamedAt).toBe('string')
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

  it('rejects agent_creator sessions in the cortex profile', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.createSession('cortex', {
        label: 'Agent Creator',
        sessionPurpose: 'agent_creator',
      }),
    ).rejects.toThrow('Agent creator sessions cannot be created in the Cortex profile')

    expect(manager.listAgents().some((agent) => agent.profileId === 'cortex' && agent.sessionPurpose === 'agent_creator')).toBe(
      false,
    )
  })

  it('does not reuse orphaned agent creator session directories when creating a new session', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const orphanedSessionId = 'manager--s2'
    const orphanedSessionDir = getSessionDir(config.paths.dataDir, 'manager', orphanedSessionId)
    await mkdir(orphanedSessionDir, { recursive: true })
    appendSessionConversationMessage(join(orphanedSessionDir, 'session.jsonl'), orphanedSessionId, 'old wizard transcript')
    await writeFile(
      join(orphanedSessionDir, 'meta.json'),
      `${JSON.stringify({
        profileId: 'manager',
        sessionId: orphanedSessionId,
        label: 'Agent Creator',
        stats: {
          sessionFileSize: 0,
          memoryFileSize: 0,
        },
      }, null, 2)}\n`,
      'utf8',
    )

    const created = await manager.createSession('manager', {
      label: 'Agent Creator',
      sessionPurpose: 'agent_creator',
    })

    expect(created.sessionAgent.agentId).toBe('manager--s3')
    expect(manager.getConversationHistory(created.sessionAgent.agentId)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'conversation_message',
          text: 'old wizard transcript',
        }),
      ]),
    )
  })

  it('awaits agent creator context injection before createSession resolves', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const creator = await manager.createSession('manager', {
      label: 'Agent Creator',
      sessionPurpose: 'agent_creator',
    })

    const runtime = manager.runtimeByAgentId.get(creator.sessionAgent.agentId)
    const injectedMessage = typeof runtime?.sendCalls[0]?.message === 'string' ? runtime.sendCalls[0].message : ''

    expect(runtime?.sendCalls).toHaveLength(1)
    expect(injectedMessage).toContain('<agent_creator_seed_context>')
    expect(injectedMessage).toContain('<existing_project_agents>')
    expect(injectedMessage).toContain('</recent_sessions>')
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










  it('spawns unique normalized agent ids on collisions', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const first = await manager.spawnAgent('manager', { agentId: 'Code Scout' })
    const second = await manager.spawnAgent('manager', { agentId: 'Code Scout' })

    expect(first.agentId).toBe('code-scout')
    expect(first.displayName).toBe('code-scout')
    expect(second.agentId).toBe('code-scout-2')
    expect(second.displayName).toBe('code-scout-2')
  })

  it('does not force a worker suffix for normalized ids', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const spawned = await manager.spawnAgent('manager', { agentId: 'Task Owner' })

    expect(spawned.agentId).toBe('task-owner')
    expect(spawned.displayName).toBe('task-owner')
  })

  it('rejects explicit agent ids that would use the reserved manager id', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(manager.spawnAgent('manager', { agentId: 'manager' })).rejects.toThrow(
      'spawn_agent agentId "manager" is reserved',
    )
  })

  it('SYSTEM-prefixes worker initial messages (internal manager->worker input)', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Kickoff Worker',
      initialMessage: 'start implementation',
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()
    expect(workerRuntime?.sendCalls[0]?.message).toBe('SYSTEM: start implementation')
  })

  it('enforces manager-only spawn and kill permissions', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Worker' })

    await expect(manager.spawnAgent(worker.agentId, { agentId: 'Nope' })).rejects.toThrow('Only manager can spawn agents')
    await expect(manager.killAgent(worker.agentId, worker.agentId)).rejects.toThrow('Only manager can kill agents')
  })

  it('returns fire-and-forget receipt and prefixes internal inter-agent deliveries', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Messenger' })

    const receipt = await manager.sendMessage('manager', worker.agentId, 'hi worker', 'auto')

    expect(receipt.targetAgentId).toBe(worker.agentId)
    expect(receipt.deliveryId).toBe('delivery-1')
    expect(receipt.acceptedMode).toBe('prompt')

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('SYSTEM: hi worker')
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

  it('keeps worker-to-manager completion reporting on the generic send path', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Reporter Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    managerRuntime!.sendCalls = []

    await manager.sendMessage(worker.agentId, 'manager', 'status: done', 'auto')

    expect(managerRuntime?.sendCalls.at(-1)?.message).toBe('SYSTEM: status: done')

    const managerHistory = manager.getConversationHistory('manager')
    expect(
      managerHistory.some(
        (entry) =>
          entry.type === 'agent_message' &&
          entry.agentId === 'manager' &&
          entry.fromAgentId === worker.agentId &&
          entry.toAgentId === 'manager' &&
          entry.text === 'status: done',
      ),
    ).toBe(true)
    expect(
      managerHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'project_agent_input' &&
          entry.text === 'status: done',
      ),
    ).toBe(false)
  })

  it('sends manager user input as steer delivery, without SYSTEM prefixing, and with source metadata annotation', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('interrupt current plan')

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    expect(managerRuntime?.sendCalls.at(-1)?.delivery).toBe('steer')
    expect(managerRuntime?.sendCalls.at(-1)?.message).toBe('[sourceContext] {"channel":"web"}\n\ninterrupt current plan')
  })

  it('streams tool_execution_update events live but only persists terminal tool call events', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    const streamedKinds: string[] = []
    manager.on('agent_tool_call', (event: any) => {
      if (event.type === 'agent_tool_call') {
        streamedKinds.push(event.kind)
      }
    })

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_update',
      toolName: 'bash',
      toolCallId: 'tool-call-1',
      partialResult: {
        chunk: 'progress',
      },
    })

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 'tool-call-1',
      result: {
        ok: true,
      },
      isError: false,
    })

    expect(streamedKinds).toContain('tool_execution_update')
    expect(streamedKinds).toContain('tool_execution_end')

    const inMemoryHistory = manager.getConversationHistory('manager')
    expect(
      inMemoryHistory.some(
        (entry) => entry.type === 'agent_tool_call' && entry.kind === 'tool_execution_update',
      ),
    ).toBe(true)

    const sessionManager = SessionManager.open(join(config.paths.sessionsDir, 'manager.jsonl'))
    const persistedConversationEntries = sessionManager
      .getEntries()
      .filter((entry: any) => entry.type === 'custom' && entry.customType === 'swarm_conversation_entry')
      .map((entry: any) => entry.data)

    expect(
      persistedConversationEntries.some(
        (entry: any) => entry?.type === 'agent_tool_call' && entry.kind === 'tool_execution_update',
      ),
    ).toBe(false)
    expect(
      persistedConversationEntries.some(
        (entry: any) => entry?.type === 'agent_tool_call' && entry.kind === 'tool_execution_end',
      ),
    ).toBe(true)
  })

  it('does not recreate worker activity state when workers are no longer streaming', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Late Event Worker' })

    const state = manager as unknown as {
      workerStallState: Map<string, unknown>
      workerActivityState: Map<string, unknown>
      updateWorkerActivity: (agentId: string, event: any) => void
    }

    expect(state.workerStallState.has(worker.agentId)).toBe(false)
    expect(state.workerActivityState.has(worker.agentId)).toBe(false)

    state.updateWorkerActivity(worker.agentId, {
      type: 'turn_end',
      toolResults: [],
    })

    expect(state.workerActivityState.has(worker.agentId)).toBe(false)
    expect(manager.getWorkerActivity(worker.agentId)).toBeUndefined()
  })

  it('records versioning mutations for successful agent write/edit tool events on tracked data-dir files', async () => {
    const config = await makeTempConfig()
    const recordMutation = vi.fn(async () => true)
    const manager = new TestSwarmManager(config, {
      versioningService: {
        isTrackedPath: () => true,
        recordMutation,
        flushPending: async () => {},
        reconcileNow: async () => {},
      },
    })
    await bootWithDefaultManager(manager, config)
    recordMutation.mockClear()

    const commonKnowledgePath = getCommonKnowledgePath(config.paths.dataDir)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_start',
      toolName: 'write',
      toolCallId: 'tool-write-1',
      args: {
        path: commonKnowledgePath,
        content: '# Common Knowledge\n\n- updated\n',
      },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_end',
      toolName: 'write',
      toolCallId: 'tool-write-1',
      result: { ok: true },
      isError: false,
    })

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_start',
      toolName: 'edit',
      toolCallId: 'tool-edit-1',
      args: {
        path: commonKnowledgePath,
        oldText: 'updated',
        newText: 'edited',
      },
    })
    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'tool_execution_end',
      toolName: 'edit',
      toolCallId: 'tool-edit-1',
      result: { ok: true },
      isError: false,
    })

    await waitForCondition(() => recordMutation.mock.calls.length >= 2, 1_000)

    const recordedMutations = (recordMutation.mock.calls as unknown as Array<Array<Record<string, unknown>>>).map(
      (call) => call[0],
    )
    expect(recordedMutations).toHaveLength(2)
    expect(recordedMutations).toEqual(expect.arrayContaining([
      {
        path: commonKnowledgePath,
        action: 'write',
        source: 'agent-write-tool',
        profileId: 'manager',
        sessionId: 'manager',
        agentId: 'manager',
        reviewRunId: undefined,
      },
      {
        path: commonKnowledgePath,
        action: 'write',
        source: 'agent-edit-tool',
        profileId: 'manager',
        sessionId: 'manager',
        agentId: 'manager',
        reviewRunId: undefined,
      },
    ]))
  })


  it('does not bump session updatedAt for worker runtime assistant message_start events', async () => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Runtime Activity Worker' })
    const previousUpdatedAt = manager.getAgent('manager')?.updatedAt

    const snapshots: Array<{ type: string; agents: AgentDescriptor[] }> = []
    manager.on('agents_snapshot', (event) => {
      if (event.type === 'agents_snapshot') {
        snapshots.push(event)
      }
    })

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_start',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'working on it' }],
      },
    })

    const nextUpdatedAt = manager.getAgent('manager')?.updatedAt
    expect(previousUpdatedAt).toBeDefined()
    expect(nextUpdatedAt).toBe(previousUpdatedAt)
    expect(snapshots).toHaveLength(0)
  })

  it('surfaces manager assistant overflow turns as system conversation messages', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage:
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 180186 tokens > 180000 maximum"},"request_id":"req_test"}',
      },
    })

    const history = manager.getConversationHistory('manager')
    const systemEvent = [...history]
      .reverse()
      .find(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.source === 'system' &&
          entry.text.includes('Manager reply failed'),
      )

    expect(systemEvent).toBeDefined()
    if (systemEvent?.type === 'conversation_message') {
      expect(systemEvent.text).toContain('prompt is too long: 180186 tokens > 180000 maximum')
      expect(systemEvent.text).toContain('Try compacting the conversation to free up context space.')
    }
  })

  it('surfaces non-overflow manager runtime errors without overflow wording', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Rate limit exceeded for requests per minute.',
      },
    })

    const history = manager.getConversationHistory('manager')
    const systemEvent = [...history]
      .reverse()
      .find(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.source === 'system' &&
          entry.text.includes('Manager reply failed'),
      )

    expect(systemEvent).toBeDefined()
    if (systemEvent?.type === 'conversation_message') {
      expect(systemEvent.text).toContain('Rate limit exceeded for requests per minute.')
      expect(systemEvent.text).not.toContain('Rate limit exceeded for requests per minute..')
      expect(systemEvent.text).not.toContain('prompt exceeded the model context window')
      expect(systemEvent.text).not.toContain('Try compacting the conversation to free up context space.')
    }
  })

  it('keeps the pending manual stop notice until the abort error arrives', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    ;(manager as any).markPendingManualManagerStopNotice('manager')

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial response before abort' }],
        stopReason: 'stop',
      },
    })

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Request was aborted.',
      },
    })

    const history = manager.getConversationHistory('manager')
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text === 'Session stopped.',
      ),
    ).toBe(true)
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text.includes('Manager reply failed'),
      ),
    ).toBe(false)
  })

  it('handles undefined/null/empty/malformed errorMessage payloads without crashing', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    const malformedErrorMessages: unknown[] = [undefined, null, '', { code: 'invalid_request_error' }]

    for (const errorMessage of malformedErrorMessages) {
      await expect(
        (manager as any).handleRuntimeSessionEvent('manager', {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage,
          },
        }),
      ).resolves.toBeUndefined()
    }

    const history = manager.getConversationHistory('manager')
    const systemErrorEvents = history.filter(
      (entry) =>
        entry.type === 'conversation_message' &&
        entry.role === 'system' &&
        entry.source === 'system' &&
        entry.text.includes('Manager reply failed'),
    )
    expect(systemErrorEvents).toHaveLength(malformedErrorMessages.length)
  })

  it('does not surface normal manager assistant turns as conversation messages', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'normal hidden manager assistant turn' }],
        stopReason: 'stop',
      },
    })

    const history = manager.getConversationHistory('manager')
    expect(history).toHaveLength(0)
  })

  it('does not surface non-error manager turns that mention token limits', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    seedManagerDescriptorForRuntimeEventTests(manager, config)

    await (manager as any).handleRuntimeSessionEvent('manager', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'We should keep the summary short to avoid token limit issues.' }],
        stopReason: 'stop',
      },
    })

    const history = manager.getConversationHistory('manager')
    expect(history).toHaveLength(0)
  })

  it('handles /compact as a manager slash command without forwarding it as a user prompt', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('/compact')

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    expect(managerRuntime?.compactCalls).toEqual([undefined])
    expect(managerRuntime?.sendCalls).toEqual([])

    const history = manager.getConversationHistory('manager')
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text === 'Compacting manager context...',
      ),
    ).toBe(true)
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text === 'Compaction complete.',
      ),
    ).toBe(true)
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' && entry.role === 'user' && entry.text === '/compact',
      ),
    ).toBe(false)
  })

  it('passes optional custom instructions for /compact slash commands', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('/compact focus the summary on open implementation tasks')

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime?.compactCalls).toEqual(['focus the summary on open implementation tasks'])
  })

  it('starts fresh Cortex review runs in dedicated review sessions and records them for the Review tab', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const run = expectStartedReviewRun(await manager.startCortexReviewRun({
      scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory', 'feedback'] },
      trigger: 'manual',
      sourceContext: { channel: 'web' },
    }))

    expect(run.status).toBe('completed')
    expect(run.scopeLabel).toBe('alpha/alpha--s1 (memory, feedback)')
    expect(run.sessionAgentId).toMatch(/^cortex--s\d+$/)

    const reviewSession = manager.listAgents().find((descriptor) => descriptor.agentId === run.sessionAgentId)
    expect(reviewSession).toMatchObject({
      profileId: 'cortex',
      sessionPurpose: 'cortex_review',
    })

    const reviewRuntime = manager.runtimeByAgentId.get(run.sessionAgentId!)
    expect(reviewRuntime?.sendCalls.at(-1)?.delivery).toBe('steer')
    expect(reviewRuntime?.sendCalls.at(-1)?.message).toBe(
      '[sourceContext] {"channel":"web"}\n\nReview session alpha/alpha--s1 (memory, feedback freshness)',
    )

    const storedRuns = JSON.parse(await readFile(getCortexReviewRunsPath(config.paths.dataDir), 'utf8')) as {
      runs: Array<{ sessionAgentId: string | null; trigger: string }>
    }
    expect(storedRuns.runs[0]).toMatchObject({
      sessionAgentId: run.sessionAgentId,
      trigger: 'manual',
    })
  })

  it('routes root Cortex review messages into fresh review-run sessions instead of the interactive root session', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    expect(manager.runtimeByAgentId.get('cortex')).toBeUndefined()

    await manager.handleUserMessage('Review all sessions that need attention', {
      targetAgentId: 'cortex',
      sourceContext: { channel: 'web' },
    })

    expect(manager.runtimeByAgentId.get('cortex')).toBeUndefined()

    const runs = await manager.listCortexReviewRuns()
    expect(runs[0]).toMatchObject({
      trigger: 'manual',
      scope: { mode: 'all' },
    })
    expect(runs[0]?.sessionAgentId).toMatch(/^cortex--s\d+$/)
  })


  it('skips scheduled all-scope review envelopes when deterministic scan finds nothing to review', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    await manager.handleUserMessage(
      '[Scheduled Task: Nightly Review]\n[scheduleContext] {"scheduleId":"sched-1"}\n\nReview all sessions that need attention',
      {
        targetAgentId: 'cortex',
        sourceContext: { channel: 'web' },
      },
    )

    const runs = await manager.listCortexReviewRuns()
    expect(runs).toEqual([])
    expect(manager.listAgents().some((descriptor) => descriptor.sessionPurpose === 'cortex_review')).toBe(false)
  })

  it('routes scheduled review envelopes into the same review-run path with schedule metadata when review is needed', async () => {
    const config = await makeTempConfig()
    await seedNeedsReviewSession(config)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    await manager.handleUserMessage(
      '[Scheduled Task: Nightly Review]\n[scheduleContext] {"scheduleId":"sched-1"}\n\nReview all sessions that need attention',
      {
        targetAgentId: 'cortex',
        sourceContext: { channel: 'web' },
      },
    )

    const runs = await manager.listCortexReviewRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      trigger: 'scheduled',
      scope: { mode: 'all' },
      scheduleName: 'Nightly Review',
      requestText:
        '[Scheduled Task: Nightly Review]\n[scheduleContext] {"scheduleId":"sched-1"}\n\nReview all sessions that need attention',
    })
  })

  it('bypasses precheck and coalescing for scheduled session-scoped review envelopes', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const scheduledMessage =
      '[Scheduled Task: Session Review]\n[scheduleContext] {"scheduleId":"sched-session"}\n\nReview session alpha/alpha--s1 (memory freshness)'

    await manager.handleUserMessage(scheduledMessage, {
      targetAgentId: 'cortex',
      sourceContext: { channel: 'web' },
    })

    await manager.handleUserMessage(scheduledMessage, {
      targetAgentId: 'cortex',
      sourceContext: { channel: 'web' },
    })

    const runs = await manager.listCortexReviewRuns()
    expect(runs.filter((entry) => entry.trigger === 'scheduled' && entry.scope.mode === 'session')).toHaveLength(2)
    expect(runs[0]).toMatchObject({
      trigger: 'scheduled',
      scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory'] },
      scheduleName: 'Session Review',
    })
  })

  it('coalesces scheduled all-scope review envelopes when an all-scope review is already active', async () => {
    const config = await makeTempConfig()
    await seedNeedsReviewSession(config)

    class BlockingReviewRuntime extends FakeRuntime {
      constructor(
        descriptor: AgentDescriptor,
        private readonly release: Promise<void>,
      ) {
        super(descriptor)
      }

      override async sendMessage(message: string | RuntimeUserMessage, delivery: RequestedDeliveryMode = 'auto'): Promise<SendMessageReceipt> {
        if (this.descriptor.sessionPurpose === 'cortex_review') {
          this.descriptor.status = 'streaming'
          void this.release.then(() => {
            this.descriptor.status = 'idle'
          })
        }
        return super.sendMessage(message, delivery)
      }
    }

    let releaseReview!: () => void
    const releaseReviewPromise = new Promise<void>((resolve) => {
      releaseReview = resolve
    })

    class BlockingReviewManager extends TestSwarmManager {
      protected override async createRuntimeForDescriptor(
        descriptor: AgentDescriptor,
        systemPrompt: string,
        _runtimeToken?: number,
      ): Promise<SwarmAgentRuntime> {
        const runtime = new BlockingReviewRuntime(descriptor, releaseReviewPromise)
        this.createdRuntimeIds.push(descriptor.agentId)
        this.runtimeByAgentId.set(descriptor.agentId, runtime)
        this.systemPromptByAgentId.set(descriptor.agentId, systemPrompt)
        return runtime as unknown as SwarmAgentRuntime
      }
    }

    const manager = new BlockingReviewManager(config)
    await manager.boot()

    const scheduledMessage =
      '[Scheduled Task: Nightly Review]\n[scheduleContext] {"scheduleId":"sched-1"}\n\nReview all sessions that need attention'

    await manager.handleUserMessage(scheduledMessage, {
      targetAgentId: 'cortex',
      sourceContext: { channel: 'web' },
    })

    await waitForCondition(() => {
      const activeReviewSession = manager
        .listAgents()
        .find((descriptor) => descriptor.sessionPurpose === 'cortex_review' && descriptor.status === 'streaming')
      return Boolean(activeReviewSession)
    })

    await manager.handleUserMessage(scheduledMessage, {
      targetAgentId: 'cortex',
      sourceContext: { channel: 'web' },
    })

    const runs = await manager.listCortexReviewRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      trigger: 'scheduled',
      scope: { mode: 'all' },
    })

    releaseReview()
  })

  it('coalesces scheduled all-scope review envelopes when an all-scope run is already queued', async () => {
    const config = await makeTempConfig()
    await seedNeedsReviewSession(config)

    class BlockingReviewRuntime extends FakeRuntime {
      constructor(
        descriptor: AgentDescriptor,
        private readonly release: Promise<void>,
      ) {
        super(descriptor)
      }

      override async sendMessage(message: string | RuntimeUserMessage, delivery: RequestedDeliveryMode = 'auto'): Promise<SendMessageReceipt> {
        if (this.descriptor.sessionPurpose === 'cortex_review') {
          this.descriptor.status = 'streaming'
          void this.release.then(() => {
            this.descriptor.status = 'idle'
          })
        }
        return super.sendMessage(message, delivery)
      }
    }

    let releaseReview!: () => void
    const releaseReviewPromise = new Promise<void>((resolve) => {
      releaseReview = resolve
    })

    class BlockingReviewManager extends TestSwarmManager {
      protected override async createRuntimeForDescriptor(
        descriptor: AgentDescriptor,
        systemPrompt: string,
        _runtimeToken?: number,
      ): Promise<SwarmAgentRuntime> {
        const runtime = new BlockingReviewRuntime(descriptor, releaseReviewPromise)
        this.createdRuntimeIds.push(descriptor.agentId)
        this.runtimeByAgentId.set(descriptor.agentId, runtime)
        this.systemPromptByAgentId.set(descriptor.agentId, systemPrompt)
        return runtime as unknown as SwarmAgentRuntime
      }
    }

    const manager = new BlockingReviewManager(config)
    await manager.boot()

    const activeRun = expectStartedReviewRun(await manager.startCortexReviewRun({
      scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory'] },
      trigger: 'manual',
      sourceContext: { channel: 'web' },
    }))

    await waitForCondition(() => {
      const activeReviewSession = manager.getAgent(activeRun.sessionAgentId ?? '')
      return activeReviewSession?.status === 'streaming'
    })

    const scheduledMessage =
      '[Scheduled Task: Nightly Review]\n[scheduleContext] {"scheduleId":"sched-1"}\n\nReview all sessions that need attention'

    await manager.handleUserMessage(scheduledMessage, {
      targetAgentId: 'cortex',
      sourceContext: { channel: 'web' },
    })

    let runs = await manager.listCortexReviewRuns()
    const queuedAllScopeRun = runs.find((entry) => entry.trigger === 'scheduled' && entry.scope.mode === 'all')
    expect(queuedAllScopeRun).toMatchObject({
      status: 'queued',
      sessionAgentId: null,
    })

    await manager.handleUserMessage(scheduledMessage, {
      targetAgentId: 'cortex',
      sourceContext: { channel: 'web' },
    })

    runs = await manager.listCortexReviewRuns()
    expect(runs.filter((entry) => entry.trigger === 'scheduled' && entry.scope.mode === 'all')).toHaveLength(1)

    releaseReview()
  })

  it('queues concurrent review starts FIFO and automatically launches the next run after the active one finishes', async () => {
    const config = await makeTempConfig()

    class BlockingReviewRuntime extends FakeRuntime {
      constructor(
        descriptor: AgentDescriptor,
        private readonly release: Promise<void>,
      ) {
        super(descriptor)
      }

      override async sendMessage(message: string | RuntimeUserMessage, delivery: RequestedDeliveryMode = 'auto'): Promise<SendMessageReceipt> {
        if (this.descriptor.sessionPurpose === 'cortex_review') {
          this.descriptor.status = 'streaming'
          void this.release.then(() => {
            this.descriptor.status = 'idle'
          })
        }
        return super.sendMessage(message, delivery)
      }
    }

    let releaseFirstRun!: () => void
    const releaseFirstRunPromise = new Promise<void>((resolve) => {
      releaseFirstRun = resolve
    })

    class ConcurrentReviewTestSwarmManager extends TestSwarmManager {
      protected override async createRuntimeForDescriptor(
        descriptor: AgentDescriptor,
        systemPrompt: string,
        _runtimeToken?: number,
      ): Promise<SwarmAgentRuntime> {
        const runtime = new BlockingReviewRuntime(descriptor, releaseFirstRunPromise)
        this.createdRuntimeIds.push(descriptor.agentId)
        this.runtimeByAgentId.set(descriptor.agentId, runtime)
        this.systemPromptByAgentId.set(descriptor.agentId, systemPrompt)
        return runtime as unknown as SwarmAgentRuntime
      }
    }

    const manager = new ConcurrentReviewTestSwarmManager(config)
    await manager.boot()

    const firstRunPromise = manager.startCortexReviewRun({
      scope: { mode: 'all' },
      trigger: 'manual',
      sourceContext: { channel: 'web' },
    })

    await waitForCondition(() => {
      const streamingReviewSession = manager
        .listAgents()
        .find((descriptor) => descriptor.sessionPurpose === 'cortex_review' && descriptor.status === 'streaming')
      return Boolean(streamingReviewSession)
    })

    const secondRun = expectStartedReviewRun(await manager.startCortexReviewRun({
      scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory'] },
      trigger: 'manual',
      sourceContext: { channel: 'web' },
    }))

    expect(secondRun.status).toBe('queued')
    expect(secondRun.sessionAgentId).toBeNull()
    expect(secondRun.queuePosition).toBe(1)

    releaseFirstRun()
    const firstRun = expectStartedReviewRun(await firstRunPromise)

    let refreshedRuns = await manager.listCortexReviewRuns()
    let refreshedSecondRun = refreshedRuns.find((entry) => entry.runId === secondRun.runId)
    for (let attempt = 0; attempt < 50 && !refreshedSecondRun?.sessionAgentId; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      refreshedRuns = await manager.listCortexReviewRuns()
      refreshedSecondRun = refreshedRuns.find((entry) => entry.runId === secondRun.runId)
    }

    const refreshedFirstRun = refreshedRuns.find((entry) => entry.runId === firstRun.runId)

    expect(refreshedFirstRun?.status).toBe('completed')
    expect(refreshedSecondRun?.queuePosition ?? null).toBeNull()
    expect(refreshedSecondRun?.sessionAgentId).toMatch(/^cortex--s\d+$/)
    expect(refreshedSecondRun?.sessionAgentId).not.toBe(firstRun.sessionAgentId)

    const storedRuns = JSON.parse(await readFile(getCortexReviewRunsPath(config.paths.dataDir), 'utf8')) as {
      runs: Array<{ runId: string; blockedReason?: string | null; sessionAgentId: string | null }>
    }
    const storedSecondRun = storedRuns.runs.find((entry) => entry.runId === secondRun.runId)
    expect(storedSecondRun?.blockedReason ?? null).toBeNull()
    expect(storedSecondRun?.sessionAgentId).toBe(refreshedSecondRun?.sessionAgentId ?? null)
  })

  it('tags web user messages with default source metadata', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('interrupt current plan')

    const history = manager.getConversationHistory('manager')
    const userEvent = history.find(
      (entry) => entry.type === 'conversation_message' && entry.role === 'user' && entry.text === 'interrupt current plan',
    )

    expect(userEvent).toBeDefined()
    if (userEvent?.type === 'conversation_message') {
      expect(userEvent.sourceContext).toEqual({ channel: 'web' })
    }
  })

  it('includes full sourceContext annotation when forwarding telegram user messages to manager runtime', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('reply in telegram thread', {
      sourceContext: {
        channel: 'telegram',
        channelId: '123456',
        userId: '456789',
        threadTs: '173.456',
        channelType: 'group',
        teamId: 'T789',
      },
    })

    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime?.sendCalls.at(-1)?.message).toBe(
      '[sourceContext] {"channel":"telegram","channelId":"123456","userId":"456789","threadTs":"173.456","channelType":"group","teamId":"T789"}\n\nreply in telegram thread',
    )
  })

  it('defaults speak_to_user routing to web when target is omitted, even after telegram input', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('reply in telegram thread', {
      sourceContext: {
        channel: 'telegram',
        channelId: '123456',
        userId: '456789',
        threadTs: '173.456',
      },
    })

    await manager.publishToUser('manager', 'ack from manager', 'speak_to_user')

    const history = manager.getConversationHistory('manager')
    const assistantEvent = [...history]
      .reverse()
      .find((entry) => entry.type === 'conversation_message' && entry.source === 'speak_to_user')

    expect(assistantEvent).toBeDefined()
    if (assistantEvent?.type === 'conversation_message') {
      expect(assistantEvent.sourceContext).toEqual({ channel: 'web' })
    }
  })

  it('uses explicit speak_to_user targets without inferred fallback behavior', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('reply in telegram thread', {
      sourceContext: {
        channel: 'telegram',
        channelId: '123456',
        userId: '456789',
        threadTs: '173.456',
      },
    })

    await manager.publishToUser('manager', 'ack from manager', 'speak_to_user', {
      channel: 'telegram',
      channelId: '999000',
      userId: '000111',
      threadTs: '999.000',
    })

    const history = manager.getConversationHistory('manager')
    const assistantEvent = [...history]
      .reverse()
      .find((entry) => entry.type === 'conversation_message' && entry.source === 'speak_to_user')

    expect(assistantEvent).toBeDefined()
    if (assistantEvent?.type === 'conversation_message') {
      expect(assistantEvent.sourceContext).toEqual({
        channel: 'telegram',
        channelId: '999000',
        userId: '000111',
        threadTs: '999.000',
      })
    }
  })

  it('requires channelId for explicit telegram speak_to_user targets', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.publishToUser('manager', 'ack from manager', 'speak_to_user', {
        channel: 'telegram',
      }),
    ).rejects.toThrow(
      'speak_to_user target.channelId is required when target.channel is "telegram"',
    )
  })

  it('falls back to web routing when no explicit target context exists', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.publishToUser('manager', 'ack from manager', 'speak_to_user')

    const history = manager.getConversationHistory('manager')
    const assistantEvent = [...history]
      .reverse()
      .find((entry) => entry.type === 'conversation_message' && entry.source === 'speak_to_user')

    expect(assistantEvent).toBeDefined()
    if (assistantEvent?.type === 'conversation_message') {
      expect(assistantEvent.sourceContext).toEqual({ channel: 'web' })
    }
  })

  it('bumps session updatedAt and emits agents_snapshot for speak_to_user messages', async () => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const previousUpdatedAt = manager.getAgent('manager')?.updatedAt

    const snapshots: Array<{ type: string; agents: AgentDescriptor[] }> = []
    manager.on('agents_snapshot', (event) => {
      if (event.type === 'agents_snapshot') {
        snapshots.push(event)
      }
    })

    await manager.publishToUser('manager', 'ack from manager', 'speak_to_user')

    const nextUpdatedAt = manager.getAgent('manager')?.updatedAt
    expect(previousUpdatedAt).toBeDefined()
    expect(nextUpdatedAt).toBeDefined()
    expect(nextUpdatedAt!.localeCompare(previousUpdatedAt!)).toBeGreaterThan(0)
    expect(
      snapshots.some((snapshot) =>
        snapshot.agents.some((agent) => agent.agentId === 'manager' && agent.updatedAt === nextUpdatedAt),
      ),
    ).toBe(true)
  })

  it('does not bump session updatedAt for system publish_to_user messages', async () => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const previousUpdatedAt = manager.getAgent('manager')?.updatedAt

    const snapshots: Array<{ type: string; agents: AgentDescriptor[] }> = []
    manager.on('agents_snapshot', (event) => {
      if (event.type === 'agents_snapshot') {
        snapshots.push(event)
      }
    })

    await manager.publishToUser('manager', 'system-only note', 'system')

    const nextUpdatedAt = manager.getAgent('manager')?.updatedAt
    expect(previousUpdatedAt).toBeDefined()
    expect(nextUpdatedAt).toBe(previousUpdatedAt)
    expect(snapshots).toHaveLength(0)
  })

  it('does not SYSTEM-prefix direct user messages routed to a worker', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'User Routed Worker' })

    await manager.handleUserMessage('hello worker', { targetAgentId: worker.agentId })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('hello worker')
  })

  it('bumps the owning session updatedAt and emits agents_snapshot on worker-targeted user messages', async () => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Activity Worker' })
    const previousUpdatedAt = manager.getAgent('manager')?.updatedAt

    const snapshots: Array<{ type: string; agents: AgentDescriptor[] }> = []
    manager.on('agents_snapshot', (event) => {
      if (event.type === 'agents_snapshot') {
        snapshots.push(event)
      }
    })

    await manager.handleUserMessage('hello worker', { targetAgentId: worker.agentId })

    const nextUpdatedAt = manager.getAgent('manager')?.updatedAt
    expect(previousUpdatedAt).toBeDefined()
    expect(nextUpdatedAt).toBeDefined()
    expect(nextUpdatedAt!.localeCompare(previousUpdatedAt!)).toBeGreaterThan(0)
    expect(
      snapshots.some((snapshot) =>
        snapshot.agents.some((agent) => agent.agentId === 'manager' && agent.updatedAt === nextUpdatedAt),
      ),
    ).toBe(true)
  })

  it('routes user image attachments to worker runtimes and conversation events', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Image Worker' })

    await manager.handleUserMessage('', {
      targetAgentId: worker.agentId,
      attachments: [
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
          fileName: 'diagram.png',
        },
      ],
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()

    const sentMessage = workerRuntime?.sendCalls.at(-1)?.message
    expect(typeof sentMessage).toBe('object')
    if (sentMessage && typeof sentMessage !== 'string') {
      expect(sentMessage.text).toBe('')
      expect(sentMessage.images).toEqual([
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
        },
      ])
    }

    const history = manager.getConversationHistory(worker.agentId)
    const userEvent = history.find(
      (entry) => entry.type === 'conversation_message' && entry.role === 'user' && entry.source === 'user_input',
    )

    expect(userEvent).toBeDefined()
    if (userEvent && userEvent.type === 'conversation_message') {
      expect(userEvent.text).toBe('')
      expect(userEvent.attachments).toHaveLength(1)
      expect(userEvent.attachments?.[0]).toMatchObject({
        type: 'image',
        mimeType: 'image/png',
        fileName: 'diagram.png',
        sizeBytes: 5,
      })
      expect('data' in (userEvent.attachments?.[0] ?? {})).toBe(false)
    }
  })

  it('injects text attachments into the runtime prompt', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Text Attachment Worker' })

    await manager.handleUserMessage('Please review this file.', {
      targetAgentId: worker.agentId,
      attachments: [
        {
          type: 'text',
          mimeType: 'text/markdown',
          fileName: 'notes.md',
          text: '# Notes\n\n- item',
        },
      ],
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()

    const sentMessage = workerRuntime?.sendCalls.at(-1)?.message
    expect(typeof sentMessage).toBe('string')
    if (typeof sentMessage === 'string') {
      expect(sentMessage).toContain('Please review this file.')
      expect(sentMessage).toContain('Name: notes.md')
      expect(sentMessage).toContain('# Notes')
    }
  })

  it('ignores inbound attachment file paths and appends server-persisted paths to runtime text', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Persisted Path Worker' })
    const spoofedImagePath = join(config.paths.dataDir, 'spoofed-image.png')
    const spoofedTextPath = join(config.paths.dataDir, 'spoofed-notes.txt')

    await manager.handleUserMessage('Review these files', {
      targetAgentId: worker.agentId,
      attachments: [
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
          fileName: 'diagram.png',
          filePath: spoofedImagePath,
        },
        {
          type: 'text',
          mimeType: 'text/plain',
          fileName: 'notes.txt',
          filePath: spoofedTextPath,
          text: 'hello from text attachment',
        },
      ],
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()

    const sentMessage = workerRuntime?.sendCalls.at(-1)?.message
    expect(typeof sentMessage).toBe('object')

    if (sentMessage && typeof sentMessage !== 'string') {
      expect(sentMessage.images).toEqual([
        {
          mimeType: 'image/png',
          data: 'aGVsbG8=',
        },
      ])
      expect(sentMessage.text).toContain('Review these files')
      expect(sentMessage.text).not.toContain(spoofedImagePath)
      expect(sentMessage.text).not.toContain(spoofedTextPath)
      expect(sentMessage.text).toContain('hello from text attachment')

      const persistedUploads = await readdir(config.paths.uploadsDir)
      expect(persistedUploads).toHaveLength(2)
    }
  })

  it('writes binary attachments to disk and passes their path to the runtime', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Binary Attachment Worker' })

    await manager.handleUserMessage('', {
      targetAgentId: worker.agentId,
      attachments: [
        {
          type: 'binary',
          mimeType: 'application/pdf',
          fileName: 'spec.pdf',
          data: 'aGVsbG8=',
        },
      ],
    })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()

    const sentMessage = workerRuntime?.sendCalls.at(-1)?.message
    expect(typeof sentMessage).toBe('string')

    if (typeof sentMessage === 'string') {
      const savedPathMatch = sentMessage.match(/Saved to: (.+)/)
      expect(savedPathMatch).toBeTruthy()

      const savedPath = savedPathMatch?.[1]?.trim()
      expect(savedPath).toBeTruthy()

      if (savedPath) {
        const binaryContents = await readFile(savedPath)
        expect(binaryContents.toString('utf8')).toBe('hello')
      }
    }
  })

  it('does not double-prefix internal messages that already start with SYSTEM:', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Already Tagged Worker' })

    await manager.sendMessage('manager', worker.agentId, 'SYSTEM: pre-tagged', 'auto')

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('SYSTEM: pre-tagged')
  })

  it('accepts busy-runtime messages as steer regardless of requested delivery', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Busy Worker' })
    const runtime = manager.runtimeByAgentId.get(worker.agentId)
    expect(runtime).toBeDefined()
    runtime!.busy = true

    const autoReceipt = await manager.sendMessage('manager', worker.agentId, 'queued auto', 'auto')
    const followUpReceipt = await manager.sendMessage('manager', worker.agentId, 'queued followup', 'followUp')
    const steerReceipt = await manager.sendMessage('manager', worker.agentId, 'queued steer', 'steer')

    expect(autoReceipt.acceptedMode).toBe('steer')
    expect(followUpReceipt.acceptedMode).toBe('steer')
    expect(steerReceipt.acceptedMode).toBe('steer')
  })

  it('automatically reports worker completion summaries to the owning manager', async () => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Summary Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Implemented the completion hook and verified the flow.' }],
      },
    })

    await waitForCondition(() =>
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'assistant' &&
            entry.text === 'Implemented the completion hook and verified the flow.',
        ),
    )

    managerRuntime!.sendCalls = []

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]).toMatchObject({
      delivery: 'auto',
      message:
        'SYSTEM: Worker summary-worker completed its turn.\n\nLast assistant message:\nImplemented the completion hook and verified the flow.',
    })
  })

  it('auto-reports worker turn errors with the error context instead of a generic completion signal', async () => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Errored Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage:
          '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
      },
    })

    await waitForCondition(() =>
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text.includes('⚠️ Worker reply failed:'),
        ),
    )

    managerRuntime!.sendCalls = []

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]).toMatchObject({
      delivery: 'auto',
      message:
        'SYSTEM: Worker errored-worker ended its turn with an error.\n\nLast system message:\n⚠️ Worker reply failed: This request would exceed your account\'s rate limit. Please try again later. The manager may need to retry after checking provider auth, quotas, or rate limits.',
    })
  })

  it('dispatches Forge runtime:error before specialist fallback recovery short-circuits the user-facing error path', async () => {
    const config = await makeTempConfig()
    const logPath = join(config.paths.dataDir, 'runtime-error-hook.jsonl')
    await installForgeRuntimeErrorLogger(config, logPath)

    const manager = new ForgeRuntimeHookTestManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)
    await writeFile(logPath, '', 'utf8')

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Hook Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const managerState = manager as unknown as {
      runtimeTokensByAgentId: Map<string, number>
      handleRuntimeError: (runtimeToken: number, agentId: string, error: RuntimeErrorEvent) => Promise<void>
    }
    const workerDescriptor = manager.getAgent(worker.agentId)
    const workerRuntimeToken = managerState.runtimeTokensByAgentId.get(worker.agentId) ?? 101
    managerState.runtimeTokensByAgentId.set(worker.agentId, workerRuntimeToken)
    const forgeExtensionHost = (manager as any).forgeExtensionHost
    if (workerDescriptor && workerRuntimeToken !== undefined) {
      const bindings = await forgeExtensionHost.prepareRuntimeBindings({
        descriptor: workerDescriptor,
        runtimeType: 'pi',
        runtimeToken: workerRuntimeToken,
      })
      if (bindings) {
        forgeExtensionHost.activateRuntimeBindings(bindings)
      }
    }

    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Draft the implementation plan.',
      images: [],
    }
    managerRuntime!.sendCalls = []
    const dispatchRuntimeErrorSpy = vi.spyOn(forgeExtensionHost, 'dispatchRuntimeError')
    const fallbackSpy = vi
      .spyOn(manager as any, 'maybeRecoverWorkerWithSpecialistFallback')
      .mockImplementation(async () => {
        expect(dispatchRuntimeErrorSpy).toHaveBeenCalledTimes(1)
        return true
      })

    await managerState.handleRuntimeError(workerRuntimeToken, worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    expect(dispatchRuntimeErrorSpy).toHaveBeenCalledTimes(1)
    expect(dispatchRuntimeErrorSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        phase: 'prompt_dispatch',
        message: expect.stringContaining('rate limit'),
      }),
    )
    expect(fallbackSpy).toHaveBeenCalledTimes(1)
    expect(managerRuntime?.sendCalls).toHaveLength(0)
    expect(
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text.includes('Worker reply failed:'),
        ),
    ).toBe(false)
  })

  it('reroutes recoverable specialist prompt_dispatch failures to the fallback model without surfacing an error', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Worker',
      specialist: 'planner',
    })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)

    expect(worker.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    })
    const spawnedSessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', 'manager')
    const spawnedWorkerMeta = spawnedSessionMeta?.workers.find((entry) => entry.id === worker.agentId)
    expect(spawnedWorkerMeta?.specialistId).toBe('planner')
    expect(spawnedWorkerMeta?.specialistAttributionKnown).toBe(true)
    expect(managerRuntime).toBeDefined()
    expect(originalRuntime).toBeDefined()

    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Draft the implementation plan.',
      images: [],
    }
    managerRuntime!.sendCalls = []

    await (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    const replacementRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(replacementRuntime).toBeDefined()
    expect(replacementRuntime).not.toBe(originalRuntime)
    expect(originalRuntime?.terminateCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls).toHaveLength(0)
    expect(manager.getAgent(worker.agentId)?.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'high',
    })
    expect(replacementRuntime?.sendCalls).toEqual([
      {
        message: {
          text: 'Draft the implementation plan.',
          images: [],
        },
        delivery: 'auto',
      },
    ])
    expect(
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text.includes('Worker reply failed:'),
        ),
    ).toBe(false)
  })

  it('preserves missing attribution provenance on descriptor-backed worker meta updates', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Legacy Attribution Worker',
    })

    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', 'manager')
    expect(sessionMeta).toBeDefined()
    if (!sessionMeta) {
      throw new Error('Expected session meta')
    }

    await writeSessionMeta(config.paths.dataDir, {
      ...sessionMeta,
      workers: sessionMeta.workers.map((entry) => {
        if (entry.id !== worker.agentId) {
          return entry
        }

        const { specialistAttributionKnown: _ignored, ...legacyEntry } = entry
        return legacyEntry
      }),
    })

    const workerDescriptor = manager.getAgent(worker.agentId)
    expect(workerDescriptor?.role).toBe('worker')
    if (!workerDescriptor || workerDescriptor.role !== 'worker') {
      throw new Error('Expected worker descriptor')
    }

    workerDescriptor.status = 'streaming'
    workerDescriptor.contextUsage = {
      tokens: 321,
      contextWindow: 1000,
      percent: 32.1,
    }

    await (manager as any).updateSessionMetaForWorkerDescriptor(workerDescriptor)

    const updatedMeta = await readSessionMeta(config.paths.dataDir, 'manager', 'manager')
    const updatedWorkerMeta = updatedMeta?.workers.find((entry) => entry.id === worker.agentId)
    expect(updatedWorkerMeta?.status).toBe('streaming')
    expect(updatedWorkerMeta?.tokens.input).toBe(321)
    expect(updatedWorkerMeta?.specialistAttributionKnown).toBeUndefined()
  })

  it('keeps the live worker descriptor healthy after old-runtime terminate mutates its own descriptor during fallback', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Descriptor Isolation Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()

    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry after rate limit.',
      images: [],
    }
    originalRuntime!.terminateMutatesDescriptorStatus = true

    await (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    expect(originalRuntime?.descriptor.status).toBe('terminated')
    expect(manager.getAgent(worker.agentId)?.status).toBe('idle')
    expect(manager.getAgent(worker.agentId)?.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'high',
    })
  })

  it('reroutes recoverable specialist message_end provider failures before they reach the manager', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Error Worker',
      specialist: 'planner',
    })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(originalRuntime).toBeDefined()

    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Revise the rollout plan.',
      images: [],
    }
    managerRuntime!.sendCalls = []

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage:
          '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
      },
    })

    const replacementRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(replacementRuntime).toBeDefined()
    expect(replacementRuntime).not.toBe(originalRuntime)
    expect(originalRuntime?.terminateCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls).toHaveLength(0)
    expect(manager.getAgent(worker.agentId)?.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'high',
    })
    expect(replacementRuntime?.sendCalls).toEqual([
      {
        message: {
          text: 'Revise the rollout plan.',
          images: [],
        },
        delivery: 'auto',
      },
    ])
    expect(
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text.includes('Worker reply failed:'),
        ),
    ).toBe(false)
  })

  it('replays the full accepted turn set when a queued follow-up was already consumed', async () => {
    const config = await makeTempConfig()
    const manager = new RuntimeFallbackReplayTestManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    manager.fallbackReplayWorkerId = 'planner-active-follow-up-worker'
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Active Follow Up Worker',
      specialist: 'planner',
    })
    const activeRuntime = manager.fallbackReplayRuntimeByAgentId.get(worker.agentId)
    const activeSession = manager.fallbackReplaySessionByAgentId.get(worker.agentId)
    expect(activeRuntime).toBeDefined()
    expect(activeSession).toBeDefined()

    const firstPromptStarted = createDeferred<void>()
    const releaseFirstPrompt = createDeferred<void>()
    activeSession!.promptImpl = async (message: string) => {
      if (message === 'first prompt') {
        firstPromptStarted.resolve(undefined)
        await releaseFirstPrompt.promise
      }
    }

    await activeRuntime!.sendMessage('first prompt', 'auto')
    await firstPromptStarted.promise
    await activeRuntime!.sendMessage('second prompt', 'auto')
    releaseFirstPrompt.resolve(undefined)

    activeSession!.emit({
      type: 'message_start',
      message: {
        role: 'user',
        content: 'second prompt',
      },
    })
    await Promise.resolve()

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage:
          '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
      },
    })

    const replacementRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(replacementRuntime).toBeDefined()
    expect(replacementRuntime?.sendCalls).toEqual([
      {
        message: {
          text: 'first prompt',
          images: [],
        },
        delivery: 'auto',
      },
      {
        message: {
          text: 'second prompt',
          images: [],
        },
        delivery: 'steer',
      },
    ])
  })

  it('replays queued specialist follow-up turns after the fallback prompt', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Queue Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()

    originalRuntime!.specialistFallbackReplaySnapshot = {
      messages: [
        {
          text: 'Draft the implementation plan.',
          images: [],
        },
        {
          text: 'Also capture rollout risks.',
          images: [],
        },
        {
          text: 'Summarize open blockers.',
          images: [],
        },
      ],
    }

    await (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    const replacementRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(replacementRuntime).toBeDefined()
    expect(replacementRuntime).not.toBe(originalRuntime)
    expect(replacementRuntime?.sendCalls).toEqual([
      {
        message: {
          text: 'Draft the implementation plan.',
          images: [],
        },
        delivery: 'auto',
      },
      {
        message: {
          text: 'Also capture rollout risks.',
          images: [],
        },
        delivery: 'steer',
      },
      {
        message: {
          text: 'Summarize open blockers.',
          images: [],
        },
        delivery: 'steer',
      },
    ])
  })

  it('surfaces the original worker error when specialist fallback replay fails internally', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Replay Failure Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()

    manager.onCreateRuntime = ({ descriptor, runtime, creationCount }) => {
      if (descriptor.agentId === worker.agentId && creationCount === 2) {
        runtime.sendMessageError = new Error('fallback replay boom')
      }
    }

    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry the implementation plan.',
      images: [],
    }

    await (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    const managerState = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
    }
    expect(managerState.runtimes.get(worker.agentId)).toBe(originalRuntime as unknown as SwarmAgentRuntime)
    expect(manager.getAgent(worker.agentId)?.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    })
    const rolledBackSessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', 'manager')
    expect(rolledBackSessionMeta?.workers.find((entry) => entry.id === worker.agentId)?.model).toBe(
      'anthropic/claude-opus-4-6',
    )
    expect(
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text ===
              '⚠️ Agent error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}. Message may need to be resent.',
        ),
    ).toBe(true)
  })

  it('reconciles buffered old-runtime idle/end callbacks when fallback is unavailable after early handoff suppression', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner No Fallback Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()

    const managerState = manager as unknown as {
      runtimeTokensByAgentId: Map<string, number>
      handleRuntimeStatus: (runtimeToken: number, agentId: string, status: AgentStatus, pendingCount: number) => Promise<void>
      handleRuntimeAgentEnd: (runtimeToken: number, agentId: string) => Promise<void>
      handleRuntimeError: (runtimeToken: number, agentId: string, error: RuntimeErrorEvent) => Promise<void>
      runtimes: Map<string, SwarmAgentRuntime>
    }
    const originalRuntimeToken = managerState.runtimeTokensByAgentId.get(worker.agentId) ?? 101
    managerState.runtimeTokensByAgentId.set(worker.agentId, originalRuntimeToken)

    originalRuntime!.descriptor.status = 'streaming'
    await managerState.handleRuntimeStatus(originalRuntimeToken, worker.agentId, 'streaming', 0)

    const releaseFallbackModel = createDeferred<void>()
    const originalResolveFallbackModel = (manager as any).resolveSpecialistFallbackModelForDescriptor.bind(manager)
    ;(manager as any).resolveSpecialistFallbackModelForDescriptor = async () => {
      await releaseFallbackModel.promise
      return undefined
    }

    const fallbackPromise = managerState.handleRuntimeError(originalRuntimeToken, worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await Promise.resolve()
    originalRuntime!.descriptor.status = 'idle'
    await managerState.handleRuntimeStatus(originalRuntimeToken, worker.agentId, 'idle', 0)
    await managerState.handleRuntimeAgentEnd(originalRuntimeToken, worker.agentId)

    releaseFallbackModel.resolve(undefined)
    await fallbackPromise
    ;(manager as any).resolveSpecialistFallbackModelForDescriptor = originalResolveFallbackModel

    expect(managerState.runtimes.get(worker.agentId)).toBe(originalRuntime as unknown as SwarmAgentRuntime)
    expect(manager.getAgent(worker.agentId)?.status).toBe('idle')
    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', 'manager')
    expect(sessionMeta?.workers.find((entry) => entry.id === worker.agentId)?.status).toBe('idle')
  })

  it('suppresses old-runtime status and end callbacks even before fallback model resolution completes', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Early Suppression Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(originalRuntime).toBeDefined()
    expect(managerRuntime).toBeDefined()

    const managerState = manager as unknown as {
      runtimeTokensByAgentId: Map<string, number>
      handleRuntimeStatus: (runtimeToken: number, agentId: string, status: AgentStatus, pendingCount: number) => Promise<void>
      handleRuntimeAgentEnd: (runtimeToken: number, agentId: string) => Promise<void>
      handleRuntimeError: (runtimeToken: number, agentId: string, error: RuntimeErrorEvent) => Promise<void>
    }
    const originalRuntimeToken = managerState.runtimeTokensByAgentId.get(worker.agentId) ?? 101
    managerState.runtimeTokensByAgentId.set(worker.agentId, originalRuntimeToken)

    originalRuntime!.descriptor.status = 'streaming'
    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry original request.',
      images: [],
    }
    await managerState.handleRuntimeStatus(originalRuntimeToken, worker.agentId, 'streaming', 0)
    managerRuntime!.sendCalls = []

    const originalResolveFallbackModel = (manager as any).resolveSpecialistFallbackModelForDescriptor.bind(manager)
    const releaseFallbackModel = createDeferred<void>()
    ;(manager as any).resolveSpecialistFallbackModelForDescriptor = async (...args: unknown[]) => {
      await releaseFallbackModel.promise
      return await originalResolveFallbackModel(...args)
    }

    const fallbackPromise = managerState.handleRuntimeError(originalRuntimeToken, worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await Promise.resolve()
    await managerState.handleRuntimeStatus(originalRuntimeToken, worker.agentId, 'idle', 0)
    await managerState.handleRuntimeAgentEnd(originalRuntimeToken, worker.agentId)

    expect(manager.getAgent(worker.agentId)?.status).toBe('streaming')
    expect(managerRuntime?.sendCalls).toHaveLength(0)

    releaseFallbackModel.resolve(undefined)
    await fallbackPromise
    ;(manager as any).resolveSpecialistFallbackModelForDescriptor = originalResolveFallbackModel

    expect(managerRuntime?.sendCalls).toHaveLength(0)
  })

  it('restores idle worker status and session meta when old-runtime idle/end callbacks were suppressed during a failed handoff', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Rollback Idle Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()

    const managerState = manager as unknown as {
      runtimeTokensByAgentId: Map<string, number>
      handleRuntimeStatus: (runtimeToken: number, agentId: string, status: AgentStatus, pendingCount: number) => Promise<void>
      handleRuntimeAgentEnd: (runtimeToken: number, agentId: string) => Promise<void>
      handleRuntimeError: (runtimeToken: number, agentId: string, error: RuntimeErrorEvent) => Promise<void>
      runtimes: Map<string, SwarmAgentRuntime>
    }
    const originalRuntimeToken = managerState.runtimeTokensByAgentId.get(worker.agentId) ?? 101
    managerState.runtimeTokensByAgentId.set(worker.agentId, originalRuntimeToken)

    originalRuntime!.descriptor.status = 'streaming'
    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry original request.',
      images: [],
    }
    await managerState.handleRuntimeStatus(originalRuntimeToken, worker.agentId, 'streaming', 0)

    manager.onCreateRuntime = async ({ descriptor, runtime, creationCount }) => {
      if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
        return
      }

      await managerState.handleRuntimeStatus(originalRuntimeToken, worker.agentId, 'idle', 0)
      await managerState.handleRuntimeAgentEnd(originalRuntimeToken, worker.agentId)
      runtime.sendMessageError = new Error('fallback replay boom')
    }

    await managerState.handleRuntimeError(originalRuntimeToken, worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    expect(managerState.runtimes.get(worker.agentId)).toBe(originalRuntime as unknown as SwarmAgentRuntime)
    expect(manager.getAgent(worker.agentId)?.status).toBe('idle')
    const rolledBackSessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', 'manager')
    expect(rolledBackSessionMeta?.workers.find((entry) => entry.id === worker.agentId)?.status).toBe('idle')
  })

  it('does not resurrect a worker with a replacement runtime after stopWorker during delayed fallback handoff', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Stop During Handoff Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()
    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry original request.',
      images: [],
    }

    const replacementCreationStarted = createDeferred<void>()
    const releaseReplacementCreation = createDeferred<void>()
    manager.onCreateRuntime = async ({ descriptor, creationCount }) => {
      if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
        return
      }

      replacementCreationStarted.resolve(undefined)
      await releaseReplacementCreation.promise
    }

    const fallbackPromise = (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await replacementCreationStarted.promise
    await manager.stopWorker(worker.agentId)
    releaseReplacementCreation.resolve(undefined)
    await fallbackPromise

    const managerState = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
    }
    expect(managerState.runtimes.has(worker.agentId)).toBe(false)
    expect(manager.getAgent(worker.agentId)?.status).toBe('idle')
    expect(manager.getAgent(worker.agentId)?.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    })
  })

  it('does not resurrect a worker with a replacement runtime after killAgent during delayed fallback handoff', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Kill During Handoff Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()
    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry original request.',
      images: [],
    }

    const replacementCreationStarted = createDeferred<void>()
    const releaseReplacementCreation = createDeferred<void>()
    manager.onCreateRuntime = async ({ descriptor, creationCount }) => {
      if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
        return
      }

      replacementCreationStarted.resolve(undefined)
      await releaseReplacementCreation.promise
    }

    const fallbackPromise = (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await replacementCreationStarted.promise
    await manager.killAgent('manager', worker.agentId)
    releaseReplacementCreation.resolve(undefined)
    await fallbackPromise

    const managerState = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
    }
    expect(managerState.runtimes.has(worker.agentId)).toBe(false)
    expect(manager.getAgent(worker.agentId)?.status).toBe('terminated')
  })

  it('does not restore a dead original runtime after fallback replay failure during handoff', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Dead Original Runtime Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()
    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry original request.',
      images: [],
    }

    const managerState = manager as unknown as {
      runtimeTokensByAgentId: Map<string, number>
      handleRuntimeStatus: (runtimeToken: number, agentId: string, status: AgentStatus, pendingCount: number) => Promise<void>
      handleRuntimeError: (runtimeToken: number, agentId: string, error: RuntimeErrorEvent) => Promise<void>
      runtimes: Map<string, SwarmAgentRuntime>
    }
    const originalRuntimeToken = managerState.runtimeTokensByAgentId.get(worker.agentId) ?? 101
    managerState.runtimeTokensByAgentId.set(worker.agentId, originalRuntimeToken)

    originalRuntime!.descriptor.status = 'streaming'
    await managerState.handleRuntimeStatus(originalRuntimeToken, worker.agentId, 'streaming', 0)

    manager.onCreateRuntime = async ({ descriptor, runtime, creationCount }) => {
      if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
        return
      }

      originalRuntime!.descriptor.status = 'terminated'
      await managerState.handleRuntimeStatus(originalRuntimeToken, worker.agentId, 'terminated', 0)
      runtime.sendMessageError = new Error('fallback replay boom')
    }

    await managerState.handleRuntimeError(originalRuntimeToken, worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    expect(managerState.runtimes.has(worker.agentId)).toBe(false)
    expect(originalRuntime?.terminateCalls).toHaveLength(1)
    expect(
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text.includes('Message may need to be resent.'),
        ),
    ).toBe(true)
  })

  it('does not restore the old runtime after stopWorker interrupts replacement replay', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Stop During Replay Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()
    originalRuntime!.specialistFallbackReplaySnapshot = {
      messages: [
        { text: 'Replay one', images: [] },
        { text: 'Replay two', images: [] },
      ],
    }

    const secondReplayStarted = createDeferred<void>()
    const releaseSecondReplay = createDeferred<void>()
    let replacementRuntime: FakeRuntime | undefined
    manager.onCreateRuntime = ({ descriptor, runtime, creationCount }) => {
      if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
        return
      }

      replacementRuntime = runtime
      runtime.onSendMessage = async () => {
        if (runtime.sendCalls.length !== 2) {
          return
        }

        secondReplayStarted.resolve(undefined)
        await releaseSecondReplay.promise
      }
    }

    const fallbackPromise = (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await secondReplayStarted.promise
    replacementRuntime!.sendMessageError = new Error('replacement replay interrupted')
    await manager.stopWorker(worker.agentId)
    releaseSecondReplay.resolve(undefined)
    await fallbackPromise

    const managerState = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
    }
    expect(managerState.runtimes.has(worker.agentId)).toBe(false)
    expect(originalRuntime?.terminateCalls).toHaveLength(1)
    expect(manager.getAgent(worker.agentId)?.status).toBe('idle')
    expect(manager.getAgent(worker.agentId)?.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'high',
    })
  })

  it('does not restore the old runtime after killAgent interrupts replacement replay', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Kill During Replay Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()
    originalRuntime!.specialistFallbackReplaySnapshot = {
      messages: [
        { text: 'Replay one', images: [] },
        { text: 'Replay two', images: [] },
      ],
    }

    const secondReplayStarted = createDeferred<void>()
    const releaseSecondReplay = createDeferred<void>()
    let replacementRuntime: FakeRuntime | undefined
    manager.onCreateRuntime = ({ descriptor, runtime, creationCount }) => {
      if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
        return
      }

      replacementRuntime = runtime
      runtime.onSendMessage = async () => {
        if (runtime.sendCalls.length !== 2) {
          return
        }

        secondReplayStarted.resolve(undefined)
        await releaseSecondReplay.promise
      }
    }

    const fallbackPromise = (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await secondReplayStarted.promise
    replacementRuntime!.sendMessageError = new Error('replacement replay interrupted')
    await manager.killAgent('manager', worker.agentId)
    releaseSecondReplay.resolve(undefined)
    await fallbackPromise

    const managerState = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
    }
    expect(managerState.runtimes.has(worker.agentId)).toBe(false)
    expect(originalRuntime?.terminateCalls).toHaveLength(1)
    expect(manager.getAgent(worker.agentId)?.status).toBe('terminated')
    expect(manager.getAgent(worker.agentId)?.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'high',
    })
  })

  it('does not restore the old runtime after delete interrupts replacement replay', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Delete During Replay Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()
    originalRuntime!.specialistFallbackReplaySnapshot = {
      messages: [
        { text: 'Replay one', images: [] },
        { text: 'Replay two', images: [] },
      ],
    }

    const secondReplayStarted = createDeferred<void>()
    const releaseSecondReplay = createDeferred<void>()
    let replacementRuntime: FakeRuntime | undefined
    manager.onCreateRuntime = ({ descriptor, runtime, creationCount }) => {
      if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
        return
      }

      replacementRuntime = runtime
      runtime.onSendMessage = async () => {
        if (runtime.sendCalls.length !== 2) {
          return
        }

        secondReplayStarted.resolve(undefined)
        await releaseSecondReplay.promise
      }
    }

    const fallbackPromise = (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await secondReplayStarted.promise
    replacementRuntime!.sendMessageError = new Error('replacement replay interrupted')
    const managerState = manager as unknown as {
      descriptors: Map<string, AgentDescriptor>
      runtimes: Map<string, SwarmAgentRuntime>
    }
    managerState.runtimes.delete(worker.agentId)
    managerState.descriptors.delete(worker.agentId)
    releaseSecondReplay.resolve(undefined)
    await fallbackPromise

    expect(managerState.runtimes.has(worker.agentId)).toBe(false)
    expect(originalRuntime?.terminateCalls).toHaveLength(1)
    expect(manager.getAgent(worker.agentId)).toBeUndefined()
  })

  it('does not resurrect a deleted worker session with a replacement runtime after delayed fallback handoff', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await bootWithDefaultManager(manager, config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Delete During Handoff Worker',
    })
    const workerDescriptor = manager.getAgent(worker.agentId)
    expect(workerDescriptor).toBeDefined()
    if (!workerDescriptor || workerDescriptor.role !== 'worker') {
      throw new Error('Expected worker descriptor')
    }
    workerDescriptor.specialistId = 'planner'
    workerDescriptor.model = {
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    }

    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()
    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry original request.',
      images: [],
    }

    const releaseFallbackModel = createDeferred<void>()
    const originalResolveFallbackModel = (manager as any).resolveSpecialistFallbackModelForDescriptor.bind(manager)
    ;(manager as any).resolveSpecialistFallbackModelForDescriptor = async (...args: unknown[]) => {
      await releaseFallbackModel.promise
      return await originalResolveFallbackModel(...args)
    }

    const fallbackPromise = (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await Promise.resolve()
    const managerState = manager as unknown as {
      descriptors: Map<string, AgentDescriptor>
      runtimes: Map<string, SwarmAgentRuntime>
    }
    managerState.runtimes.delete(worker.agentId)
    managerState.descriptors.delete(worker.agentId)
    releaseFallbackModel.resolve(undefined)
    await fallbackPromise
    ;(manager as any).resolveSpecialistFallbackModelForDescriptor = originalResolveFallbackModel

    expect(managerState.runtimes.has(worker.agentId)).toBe(false)
    expect(manager.getAgent(worker.agentId)).toBeUndefined()
  })

  it('waits for the replacement runtime during fallback handoff so concurrent sends are not lost on the old runtime', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Handoff Wait Worker',
      specialist: 'planner',
    })
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(originalRuntime).toBeDefined()

    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry original request.',
      images: [],
    }

    const replacementCreationStarted = createDeferred<void>()
    const releaseReplacementCreation = createDeferred<void>()
    manager.onCreateRuntime = async ({ descriptor, creationCount }) => {
      if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
        return
      }

      replacementCreationStarted.resolve(undefined)
      await releaseReplacementCreation.promise
    }

    const fallbackPromise = (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await replacementCreationStarted.promise

    const concurrentSendPromise = manager.sendMessage('manager', worker.agentId, 'mid-handoff follow-up', 'auto', {
      origin: 'internal',
    })

    await Promise.resolve()
    expect(originalRuntime?.sendCalls).toEqual([])

    releaseReplacementCreation.resolve(undefined)
    await fallbackPromise
    await concurrentSendPromise

    const replacementRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(replacementRuntime).toBeDefined()
    expect(replacementRuntime).not.toBe(originalRuntime)
    expect(replacementRuntime?.sendCalls).toEqual([
      {
        message: {
          text: 'Retry original request.',
          images: [],
        },
        delivery: 'auto',
      },
      {
        message: 'SYSTEM: mid-handoff follow-up',
        delivery: 'auto',
      },
    ])
  })

  it('restores the original runtime session state after fallback rollback if replay later fails', async () => {
    const config = await makeTempConfig()
    const manager = new RuntimeFallbackReplayTestManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    manager.fallbackReplayWorkerId = 'planner-rollback-state-worker'
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Rollback State Worker',
      specialist: 'planner',
    })
    const activeRuntime = manager.fallbackReplayRuntimeByAgentId.get(worker.agentId)
    const activeSession = manager.fallbackReplaySessionByAgentId.get(worker.agentId)
    expect(activeRuntime).toBeDefined()
    expect(activeSession).toBeDefined()

    const firstPromptStarted = createDeferred<void>()
    const releaseFirstPrompt = createDeferred<void>()
    activeSession!.promptImpl = async (message: string) => {
      if (message === 'first prompt') {
        firstPromptStarted.resolve(undefined)
        await releaseFirstPrompt.promise
      }
    }

    await activeRuntime!.sendMessage('first prompt', 'auto')
    await firstPromptStarted.promise
    await activeRuntime!.sendMessage('second prompt', 'auto')
    releaseFirstPrompt.resolve(undefined)

    activeSession!.emit({
      type: 'message_start',
      message: {
        role: 'user',
        content: 'second prompt',
      },
    })
    await Promise.resolve()

    activeSession!.state.messages = [
      { role: 'user', content: 'first prompt' },
      { role: 'user', content: 'second prompt' },
      { role: 'assistant', stopReason: 'error', content: [] },
    ] as any
    ;(activeSession as any).sessionMessages = structuredClone(activeSession!.state.messages)
    const originalMessages = structuredClone(activeSession!.state.messages)

    manager.onCreateRuntime = ({ descriptor, runtime, creationCount }) => {
      if (descriptor.agentId === worker.agentId && creationCount === 2) {
        runtime.sendMessageError = new Error('fallback replay boom')
      }
    }

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage:
          '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
      },
    })

    expect(activeSession!.state.messages).toEqual(originalMessages)
  })

  it('suppresses stale old-runtime callbacks while specialist fallback handoff is in progress', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await mkdir(join(config.paths.sharedDir, 'specialists'), { recursive: true })
    await writeFile(
      join(config.paths.sharedDir, 'specialists', 'planner.md'),
      [
        '---',
        'displayName: Planner',
        'color: "#7c3aed"',
        'enabled: true',
        'whenToUse: Planning work.',
        'modelId: claude-opus-4-6',
        'reasoningLevel: high',
        'fallbackModelId: gpt-5.4',
        'fallbackReasoningLevel: high',
        '---',
        'You are the planner specialist.'
      ].join('\n'),
      'utf8',
    )

    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Planner Race Worker',
      specialist: 'planner',
    })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const originalRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(originalRuntime).toBeDefined()

    originalRuntime!.specialistFallbackReplayMessage = {
      text: 'Retry the implementation plan.',
      images: [],
    }

    let releaseReplacementCreation: (() => void) | undefined
    const replacementCreationStarted = new Promise<void>((resolve) => {
      manager.onCreateRuntime = async ({ descriptor, creationCount }) => {
        if (descriptor.agentId !== worker.agentId || creationCount !== 2) {
          return
        }

        resolve()
        await new Promise<void>((continueResolve) => {
          releaseReplacementCreation = continueResolve
        })
      }
    })

    const managerState = manager as unknown as {
      runtimeTokensByAgentId: Map<string, number>
      handleRuntimeError: (runtimeToken: number, agentId: string, error: RuntimeErrorEvent) => Promise<void>
      handleRuntimeSessionEvent: (runtimeToken: number, agentId: string, event: RuntimeSessionEvent) => Promise<void>
      handleRuntimeAgentEnd: (runtimeToken: number, agentId: string) => Promise<void>
    }
    const originalRuntimeToken = managerState.runtimeTokensByAgentId.get(worker.agentId) ?? 101
    managerState.runtimeTokensByAgentId.set(worker.agentId, originalRuntimeToken)
    expect(originalRuntimeToken).toBeTypeOf('number')

    const fallbackPromise = managerState.handleRuntimeError(originalRuntimeToken as number, worker.agentId, {
      phase: 'prompt_dispatch',
      message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    })

    await replacementCreationStarted

    await managerState.handleRuntimeSessionEvent(originalRuntimeToken as number, worker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'late stale runtime error',
      },
    })
    await managerState.handleRuntimeAgentEnd(originalRuntimeToken as number, worker.agentId)

    releaseReplacementCreation?.()
    await fallbackPromise

    expect(managerRuntime?.sendCalls).toHaveLength(0)
    expect(
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text.includes('late stale runtime error'),
        ),
    ).toBe(false)
  })

  it('suppresses duplicate auto-reports when the latest summary was already reported', async () => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Repeat Summary Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Initial completion summary.' }],
      },
    })

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    managerRuntime!.sendCalls = []

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    expect(managerRuntime?.sendCalls).toHaveLength(0)
  })

  it('suppresses duplicate end callbacks after an errored worker turn instead of falling back to a generic completion signal', async () => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Duplicate Error Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage:
          '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
      },
    })

    await waitForCondition(() =>
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text.includes('⚠️ Worker reply failed:'),
        ),
    )

    managerRuntime!.sendCalls = []

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)
    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]).toMatchObject({
      delivery: 'auto',
      message:
        'SYSTEM: Worker duplicate-error-worker ended its turn with an error.\n\nLast system message:\n⚠️ Worker reply failed: This request would exceed your account\'s rate limit. Please try again later. The manager may need to retry after checking provider auth, quotas, or rate limits.',
    })
  })

  it.each([
    {
      label: 'worker reply failures projected from message_end errors',
      trigger: async (manager: TestSwarmManager, workerId: string) => {
        await (manager as any).handleRuntimeSessionEvent(workerId, {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'Prompt is too long for this model context window.',
          },
        })
      },
      expectedSummaryLine:
        '⚠️ Worker reply failed because the prompt exceeded the model context window (Prompt is too long for this model context window.). The manager may need to compact the task context before retrying.',
    },
    {
      label: 'agent runtime errors',
      trigger: async (manager: TestSwarmManager, workerId: string) => {
        await (manager as any).handleRuntimeError(workerId, {
          phase: 'prompt_dispatch',
          message: 'backend socket closed unexpectedly',
        })
      },
      expectedSummaryLine:
        '⚠️ Agent error: backend socket closed unexpectedly. Message may need to be resent.',
    },
    {
      label: 'extension runtime errors',
      trigger: async (manager: TestSwarmManager, workerId: string) => {
        await (manager as any).handleRuntimeError(workerId, {
          phase: 'extension',
          message: 'blocked write outside allowed roots',
          details: {
            extensionPath: '/tmp/protected-paths.ts',
            event: 'tool_call',
          },
        })
      },
      expectedSummaryLine:
        '⚠️ Extension error (protected-paths.ts · tool_call): blocked write outside allowed roots',
    },
    {
      label: 'context guard errors',
      trigger: async (manager: TestSwarmManager, workerId: string) => {
        await (manager as any).handleRuntimeError(workerId, {
          phase: 'context_guard',
          message: 'context guard rejected the pending prompt',
        })
      },
      expectedSummaryLine:
        '⚠️ Context guard error: context guard rejected the pending prompt.',
    },
    {
      label: 'context recovery failures',
      trigger: async (manager: TestSwarmManager, workerId: string) => {
        await (manager as any).handleRuntimeError(workerId, {
          phase: 'compaction',
          message: 'failed to rebuild compacted context',
          details: {
            recoveryStage: 'recovery_failed',
          },
        })
      },
      expectedSummaryLine:
        '🚨 Context recovery failed: failed to rebuild compacted context. Start a new session or manually trim history/compact before continuing.',
    },
  ])('classifies $label as worker turn errors in auto-reports', async ({ trigger, expectedSummaryLine }) => {
    const config = await makeTempConfig()
    let tick = 0
    const now = () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + tick++).toISOString()
    const manager = new TestSwarmManager(config, { now })
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Worker Error Variant' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()

    await trigger(manager, worker.agentId)

    await waitForCondition(() =>
      manager
        .getConversationHistory(worker.agentId)
        .some(
          (entry) =>
            entry.type === 'conversation_message' &&
            entry.role === 'system' &&
            entry.text === expectedSummaryLine,
        ),
    )

    managerRuntime!.sendCalls = []

    await (manager as any).handleRuntimeAgentEnd(worker.agentId)

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]).toMatchObject({
      delivery: 'auto',
      message:
        `SYSTEM: Worker worker-error-variant ended its turn with an error.\n\nLast system message:\n${expectedSummaryLine}`,
    })
  })

  it('does not replay stale worker summaries when recreating an idle worker runtime', async () => {
    const config = await makeTempConfig()

    appendSessionConversationMessage(join(config.paths.sessionsDir, 'worker-idle.jsonl'), 'worker-idle', 'stale summary')

    await writeFile(
      config.paths.agentsStoreFile,
      JSON.stringify(
        {
          agents: [
            {
              agentId: 'manager',
              displayName: 'Manager',
              role: 'manager',
              managerId: 'manager',
              status: 'idle',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              cwd: config.defaultCwd,
              model: config.defaultModel,
              sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
            },
            {
              agentId: 'worker-idle',
              displayName: 'Worker Idle',
              role: 'worker',
              managerId: 'manager',
              status: 'idle',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              cwd: config.defaultCwd,
              model: config.defaultModel,
              sessionFile: join(config.paths.sessionsDir, 'worker-idle.jsonl'),
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    const manager = new TestSwarmManager(config)
    await manager.boot()

    await manager.sendMessage('manager', 'manager', 'bootstrap manager runtime')
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    expect(managerRuntime).toBeDefined()
    managerRuntime!.sendCalls = []

    await manager.sendMessage('manager', 'worker-idle', 'start now')
    await (manager as any).handleRuntimeAgentEnd('worker-idle')

    expect(managerRuntime).toBeDefined()
    expect(managerRuntime?.sendCalls.at(-1)?.message).toBe('SYSTEM: Worker worker-idle completed its turn.')
  })

  it('falls back to watchdog notifications when auto completion reporting fails', async () => {
    vi.useFakeTimers()

    try {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      const worker = await manager.spawnAgent('manager', { agentId: 'Watchdog Worker' })
      const managerRuntime = manager.runtimeByAgentId.get('manager')
      expect(managerRuntime).toBeDefined()

      const originalSendMessage = managerRuntime!.sendMessage.bind(managerRuntime)
      let shouldFailAutoReport = true
      ;(managerRuntime as any).sendMessage = async (
        message: string,
        delivery?: RequestedDeliveryMode,
      ) => {
        if (shouldFailAutoReport && message.includes('completed its turn')) {
          shouldFailAutoReport = false
          throw new Error('synthetic auto-report failure')
        }

        return originalSendMessage(message, delivery)
      }

      await (manager as any).handleRuntimeSessionEvent(worker.agentId, {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
        },
      })

      managerRuntime!.sendCalls = []

      await (manager as any).handleRuntimeAgentEnd(worker.agentId)
      await vi.advanceTimersByTimeAsync(3_800)

      expect(
        managerRuntime?.sendCalls.some(
          (call) =>
            typeof call.message === 'string' && call.message.includes('IDLE WORKER WATCHDOG'),
        ),
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('kills a busy runtime with abort then marks descriptor terminated', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Killable Worker' })
    const runtime = manager.runtimeByAgentId.get(worker.agentId)
    expect(runtime).toBeDefined()

    await manager.killAgent('manager', worker.agentId)

    expect(runtime!.terminateCalls).toEqual([
      expect.objectContaining({ abort: true }),
    ])
    const descriptor = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(descriptor?.status).toBe('terminated')
  })

  it('stops all agents by cancelling in-flight work without terminating runtimes', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Stop-All Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(workerRuntime).toBeDefined()

    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    const managerDescriptor = state.descriptors.get('manager')
    const workerDescriptor = state.descriptors.get(worker.agentId)
    expect(managerDescriptor).toBeDefined()
    expect(workerDescriptor).toBeDefined()

    managerDescriptor!.status = 'streaming'
    workerDescriptor!.status = 'streaming'
    managerRuntime!.busy = true
    workerRuntime!.busy = true

    const stopped = await manager.stopAllAgents('manager', 'manager')

    expect(stopped).toEqual({
      managerId: 'manager',
      stoppedWorkerIds: [worker.agentId],
      managerStopped: true,
      terminatedWorkerIds: [worker.agentId],
      managerTerminated: true,
    })
    expect(managerRuntime!.stopInFlightCalls).toEqual([
      expect.objectContaining({ abort: true }),
    ])
    expect(workerRuntime!.stopInFlightCalls).toEqual([
      expect.objectContaining({ abort: true }),
    ])
    expect(managerRuntime!.terminateCalls).toEqual([])
    expect(workerRuntime!.terminateCalls).toEqual([])

    const managerAfter = manager.listAgents().find((agent) => agent.agentId === 'manager')
    const workerAfter = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(managerAfter?.status).toBe('idle')
    expect(workerAfter?.status).toBe('idle')
    expect(manager.runtimeByAgentId.has('manager')).toBe(true)
    expect(manager.runtimeByAgentId.has(worker.agentId)).toBe(true)
  })

  it('marks the manager stop notice before worker shutdown during stopAllAgents', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Stop-All Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(workerRuntime).toBeDefined()

    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    const managerDescriptor = state.descriptors.get('manager')
    const workerDescriptor = state.descriptors.get(worker.agentId)
    expect(managerDescriptor).toBeDefined()
    expect(workerDescriptor).toBeDefined()

    managerDescriptor!.status = 'streaming'
    workerDescriptor!.status = 'streaming'
    managerRuntime!.busy = true
    workerRuntime!.busy = true

    const originalStopInFlight = workerRuntime!.stopInFlight.bind(workerRuntime)
    workerRuntime!.stopInFlight = async (options) => {
      await (manager as any).handleRuntimeSessionEvent('manager', {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'Request was aborted.',
        },
      })

      await originalStopInFlight(options)
    }

    await manager.stopAllAgents('manager', 'manager')

    const history = manager.getConversationHistory('manager')
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text === 'Session stopped.',
      ),
    ).toBe(true)
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.role === 'system' &&
          entry.text.includes('Manager reply failed'),
      ),
    ).toBe(false)
  })

  it('normalizes persisted streaming workers to idle on restart without recreating runtimes', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-a',
          displayName: 'Worker A',
          role: 'worker',
          managerId: 'manager',
          status: 'streaming',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-a.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const agents = manager.listAgents()
    const worker = agents.find((agent) => agent.agentId === 'worker-a')
    const persistedStore = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
      agents: Array<{ agentId: string; status: AgentDescriptor['status'] }>
    }
    const persistedWorker = persistedStore.agents.find((agent) => agent.agentId === 'worker-a')

    expect(worker?.status).toBe('idle')
    expect(persistedWorker?.status).toBe('idle')
    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.runtimeByAgentId.get('manager')).toBeUndefined()
    expect(manager.runtimeByAgentId.get('worker-a')).toBeUndefined()
  })

  it('migrates persisted stopped_on_restart statuses to stopped at boot', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-stopped',
          displayName: 'Worker Stopped',
          role: 'worker',
          managerId: 'manager',
          status: 'stopped_on_restart',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-stopped.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const migrated = manager.listAgents().find((agent) => agent.agentId === 'worker-stopped')
    const persistedStore = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
      agents: Array<{ agentId: string; status: AgentDescriptor['status'] }>
    }
    const persistedWorker = persistedStore.agents.find((agent) => agent.agentId === 'worker-stopped')

    expect(migrated?.status).toBe('stopped')
    expect(persistedWorker?.status).toBe('stopped')
  })

  it('lazily creates idle runtimes when a restored agent receives work', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-idle',
          displayName: 'Worker Idle',
          role: 'worker',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-idle.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.runtimeByAgentId.get('worker-idle')).toBeUndefined()

    await manager.sendMessage('manager', 'worker-idle', 'start now')

    const runtime = manager.runtimeByAgentId.get('worker-idle')
    expect(runtime).toBeDefined()
    expect(runtime?.sendCalls.at(-1)?.message).toBe('SYSTEM: start now')
    expect(manager.createdRuntimeIds).toEqual(['worker-idle'])
  })

  it('skips terminated histories at boot and lazy-loads them on demand', async () => {
    const config = await makeTempConfig()

    appendSessionConversationMessage(join(config.paths.sessionsDir, 'manager.jsonl'), 'manager', 'manager-history')
    appendSessionConversationMessage(
      join(config.paths.sessionsDir, 'worker-active.jsonl'),
      'worker-active',
      'active-worker-history',
    )
    appendSessionConversationMessage(
      join(config.paths.sessionsDir, 'worker-terminated.jsonl'),
      'worker-terminated',
      'terminated-worker-history',
    )

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'worker-active',
          displayName: 'Worker Active',
          role: 'worker',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-active.jsonl'),
        },
        {
          agentId: 'worker-terminated',
          displayName: 'Worker Terminated',
          role: 'worker',
          managerId: 'manager',
          status: 'terminated',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'worker-terminated.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.getLoadedConversationAgentIdsForTest()).toEqual([])

    const terminatedHistory = manager.getConversationHistory('worker-terminated')
    expect(terminatedHistory.some((entry) => 'text' in entry && entry.text === 'terminated-worker-history')).toBe(true)
    expect(manager.getLoadedConversationAgentIdsForTest()).toEqual(['worker-terminated'])
  })

  it('does not implicitly recreate the configured manager when other agents already exist', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'ops-manager',
          displayName: 'Ops Manager',
          role: 'manager',
          managerId: 'ops-manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'ops-manager.jsonl'),
        },
        {
          agentId: 'ops-worker',
          displayName: 'Ops Worker',
          role: 'worker',
          managerId: 'ops-manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'ops-worker.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const agents = manager.listAgents()
    const restoredWorker = agents.find((agent) => agent.agentId === 'ops-worker')

    expect(agents.some((agent) => agent.agentId === 'manager')).toBe(false)
    expect(restoredWorker?.managerId).toBe('ops-manager')
    expect(manager.createdRuntimeIds).toEqual([])
  })

  it('keeps killed workers terminated across restart', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const worker = await firstBoot.spawnAgent('manager', { agentId: 'Killed Worker' })
    await firstBoot.killAgent('manager', worker.agentId)

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    const restored = secondBoot.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(restored?.status).toBe('terminated')
    expect(secondBoot.createdRuntimeIds).toEqual([])

    await expect(secondBoot.sendMessage('manager', worker.agentId, 'still there?')).rejects.toThrow(
      `Target agent is not running: ${worker.agentId}`,
    )
  })

  it('does not duplicate workers across repeated restarts', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const worker = await firstBoot.spawnAgent('manager', { agentId: 'Repeat Worker' })

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)
    expect(secondBoot.listAgents().filter((agent) => agent.agentId === worker.agentId)).toHaveLength(1)
    expect(secondBoot.createdRuntimeIds).toEqual([])

    const thirdBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(thirdBoot, config)
    expect(thirdBoot.listAgents().filter((agent) => agent.agentId === worker.agentId)).toHaveLength(1)
    expect(thirdBoot.createdRuntimeIds).toEqual([])
  })

  it('preserves the active runtime token when clearing a stale token', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const state = manager as any as {
      runtimeTokensByAgentId: Map<string, number>
      clearRuntimeToken: (agentId: string, runtimeToken?: number) => void
    }

    state.runtimeTokensByAgentId.set('manager', 22)
    state.clearRuntimeToken('manager', 11)

    expect(state.runtimeTokensByAgentId.get('manager')).toBe(22)
  })

  it('does not detach a newer runtime when a stale runtime token is provided', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const descriptor = manager.getAgent('manager')
    expect(descriptor).toBeDefined()
    if (!descriptor) {
      throw new Error('Expected manager descriptor')
    }

    const freshRuntime = new FakeRuntime({ ...descriptor })
    const state = manager as any as {
      runtimes: Map<string, SwarmAgentRuntime>
      runtimeTokensByAgentId: Map<string, number>
      detachRuntime: (agentId: string, runtimeToken?: number) => boolean
    }

    state.runtimes.set('manager', freshRuntime as unknown as SwarmAgentRuntime)
    state.runtimeTokensByAgentId.set('manager', 44)

    expect(state.detachRuntime('manager', 33)).toBe(false)
    expect(state.runtimes.get('manager')).toBe(freshRuntime)
    expect(state.runtimeTokensByAgentId.get('manager')).toBe(44)

    expect(state.detachRuntime('manager', 44)).toBe(true)
    expect(state.runtimes.has('manager')).toBe(false)
    expect(state.runtimeTokensByAgentId.has('manager')).toBe(false)
  })

  it('keeps the winning runtime token current when concurrent runtime creation overlaps', async () => {
    const config = await makeTempConfig()

    let releaseCreation!: () => void
    const creationGate = new Promise<void>((resolve) => {
      releaseCreation = resolve
    })

    class ConcurrentRuntimeCreationSwarmManager extends TestSwarmManager {
      blockAgentId: string | null = null
      observedRuntimeTokens: number[] = []

      protected override async createRuntimeForDescriptor(
        descriptor: AgentDescriptor,
        systemPrompt: string,
        runtimeToken?: number,
      ): Promise<SwarmAgentRuntime> {
        if (descriptor.agentId === this.blockAgentId) {
          this.observedRuntimeTokens.push(runtimeToken ?? -1)
          await creationGate
        }

        return super.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken)
      }
    }

    const manager = new ConcurrentRuntimeCreationSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Runtime Race Worker' })
    const descriptor = manager.getAgent(worker.agentId)
    expect(descriptor).toBeDefined()
    if (!descriptor) {
      throw new Error('Expected worker descriptor')
    }

    const state = manager as any as {
      runtimes: Map<string, SwarmAgentRuntime>
      runtimeTokensByAgentId: Map<string, number>
      getOrCreateRuntimeForDescriptor: (descriptor: AgentDescriptor) => Promise<SwarmAgentRuntime>
      handleRuntimeStatus: (
        runtimeToken: number,
        agentId: string,
        status: AgentStatus,
        pendingCount: number,
      ) => Promise<void>
    }

    state.runtimes.delete(worker.agentId)
    state.runtimeTokensByAgentId.delete(worker.agentId)
    manager.blockAgentId = worker.agentId

    const firstCreation = state.getOrCreateRuntimeForDescriptor(descriptor)
    await waitForCondition(() => manager.observedRuntimeTokens.length === 1)

    const secondCreation = state.getOrCreateRuntimeForDescriptor(descriptor)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(manager.observedRuntimeTokens).toHaveLength(1)

    releaseCreation()

    const [firstRuntime, secondRuntime] = await Promise.all([firstCreation, secondCreation])
    expect(firstRuntime).toBe(secondRuntime)
    expect(manager.observedRuntimeTokens).toHaveLength(1)

    const winningRuntimeToken = manager.observedRuntimeTokens[0]
    expect(state.runtimeTokensByAgentId.get(worker.agentId)).toBe(winningRuntimeToken)

    await state.handleRuntimeStatus(winningRuntimeToken, worker.agentId, 'streaming', 0)
    expect(manager.getAgent(worker.agentId)?.status).toBe('streaming')
  })

  it('persists manager conversation history to disk and reloads it on restart', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    await firstBoot.handleUserMessage('persist this')
    await firstBoot.publishToUser('manager', 'saved reply', 'speak_to_user')

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    const history = secondBoot.getConversationHistory('manager')
    expect(
      history.some(
        (message) =>
          message.type === 'conversation_message' &&
          message.text === 'persist this' &&
          message.source === 'user_input',
      ),
    ).toBe(true)
    expect(
      history.some(
        (message) =>
          message.type === 'conversation_message' &&
          message.text === 'saved reply' &&
          message.source === 'speak_to_user',
      ),
    ).toBe(true)
  })

  it('preserves Unicode speak_to_user text through JSONL persistence and reload', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const unicodeReply = 'Unicode — “quotes” café'
    await firstBoot.publishToUser('manager', unicodeReply, 'speak_to_user')

    const managerDescriptor = firstBoot.getAgent('manager')
    expect(managerDescriptor).toBeDefined()
    const sessionFile = managerDescriptor?.sessionFile ?? join(config.paths.sessionsDir, 'manager.jsonl')
    const sessionText = await readFile(sessionFile, 'utf8')
    expect(sessionText).toContain(unicodeReply)

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    const history = secondBoot.getConversationHistory('manager')
    expect(
      history.some(
        (message) =>
          message.type === 'conversation_message' &&
          message.text === unicodeReply &&
          message.source === 'speak_to_user',
      ),
    ).toBe(true)
  })

  it('does not trust a stale conversation cache after the canonical session file is truncated', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    await firstBoot.handleUserMessage('persist this')
    await firstBoot.publishToUser('manager', 'saved reply', 'speak_to_user')

    const managerDescriptor = firstBoot.getAgent('manager')
    expect(managerDescriptor).toBeDefined()

    const sessionFile = managerDescriptor?.sessionFile ?? join(config.paths.sessionsDir, 'manager.jsonl')
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    const cacheText = await waitForFileText(cacheFile)
    expect(cacheText).toContain('persist this')
    expect(cacheText).toContain('saved reply')

    const sessionManager = SessionManager.open(sessionFile)
    const header = sessionManager.getHeader()
    await writeFile(sessionFile, header ? `${JSON.stringify(header)}\n` : '', 'utf8')

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    const history = secondBoot.getConversationHistory('manager')
    expect(history).toEqual([])
  })

  it('preserves web user and speak_to_user history when internal activity overflows history limits', async () => {
    const config = await makeTempConfig()
    const createdAt = '2026-01-01T00:00:00.000Z'
    await writeFile(
      config.paths.agentsStoreFile,
      JSON.stringify(
        {
          agents: [
            {
              agentId: 'manager',
              displayName: 'Manager',
              role: 'manager',
              managerId: 'manager',
              status: 'idle',
              createdAt,
              updatedAt: createdAt,
              cwd: config.defaultCwd,
              model: config.defaultModel,
              sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    )

    const sessionManager = SessionManager.open(join(config.paths.sessionsDir, 'manager.jsonl'))
    sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed' }],
    } as any)
    sessionManager.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'user',
      text: 'web message that must persist',
      timestamp: new Date(1).toISOString(),
      source: 'user_input',
      sourceContext: {
        channel: 'web',
      },
    })
    sessionManager.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: 'manager',
      role: 'assistant',
      text: 'web reply that must persist',
      timestamp: new Date(2).toISOString(),
      source: 'speak_to_user',
      sourceContext: {
        channel: 'web',
      },
    })
    for (let index = 0; index < 2_200; index += 1) {
      sessionManager.appendCustomEntry('swarm_conversation_entry', {
        type: 'agent_message',
        agentId: 'manager',
        timestamp: new Date(3 + index).toISOString(),
        source: 'agent_to_agent',
        fromAgentId: 'manager',
        toAgentId: 'worker',
        text: `internal-message-${index}`,
      })
    }

    const firstBoot = new TestSwarmManager(config)
    await firstBoot.boot()

    const inMemoryHistory = firstBoot.getConversationHistory('manager')
    expect(
      inMemoryHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'user_input' &&
          entry.text === 'web message that must persist',
      ),
    ).toBe(true)
    expect(
      inMemoryHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'speak_to_user' &&
          entry.text === 'web reply that must persist',
      ),
    ).toBe(true)
    expect(
      inMemoryHistory.some((entry) => entry.type === 'agent_message' && entry.text === 'internal-message-0'),
    ).toBe(false)
    expect(
      inMemoryHistory.some((entry) => entry.type === 'agent_message' && entry.text === 'internal-message-2199'),
    ).toBe(true)

    const secondBoot = new TestSwarmManager(config)
    await secondBoot.boot()

    const restoredHistory = secondBoot.getConversationHistory('manager')
    expect(
      restoredHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'user_input' &&
          entry.text === 'web message that must persist',
      ),
    ).toBe(true)
    expect(
      restoredHistory.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'speak_to_user' &&
          entry.text === 'web reply that must persist',
      ),
    ).toBe(true)
    expect(
      restoredHistory.some((entry) => entry.type === 'agent_message' && entry.text === 'internal-message-0'),
    ).toBe(false)
    expect(
      restoredHistory.some((entry) => entry.type === 'agent_message' && entry.text === 'internal-message-2199'),
    ).toBe(true)
  })

  it('resetManagerSession creates a new session and keeps the source session intact', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.handleUserMessage('before reset')
    expect(manager.getConversationHistory('manager').some((message) => 'text' in message && message.text === 'before reset')).toBe(true)

    const firstRuntime = manager.runtimeByAgentId.get('manager')
    expect(firstRuntime).toBeDefined()

    await manager.resetManagerSession('api_reset')

    const managerSessions = manager.listAgents().filter((agent) => agent.role === 'manager')
    const forkedSession = managerSessions.find(
      (agent) => agent.profileId === 'manager' && agent.agentId !== 'manager',
    )

    expect(firstRuntime!.terminateCalls).toEqual([])
    expect(manager.createdRuntimeIds.filter((id) => id === 'manager')).toHaveLength(1)
    expect(forkedSession?.agentId).toBe('manager--s2')
    expect(forkedSession?.profileId).toBe('manager')
    expect(forkedSession?.sessionLabel).toBe('New chat')
    expect(manager.getConversationHistory('manager').some((message) => 'text' in message && message.text === 'before reset')).toBe(true)
    expect(manager.getConversationHistory('manager--s2')).toHaveLength(0)

    const rebooted = new TestSwarmManager(config)
    await bootWithDefaultManager(rebooted, config)

    expect(rebooted.getConversationHistory('manager').some((message) => 'text' in message && message.text === 'before reset')).toBe(true)
    expect(rebooted.getConversationHistory('manager--s2')).toHaveLength(0)
  })

  it('skips invalid persisted descriptors instead of failing boot', async () => {
    const config = await makeTempConfig()

    const seedAgents = {
      agents: [
        {
          agentId: 'manager',
          displayName: 'Manager',
          role: 'manager',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          model: config.defaultModel,
          sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
        },
        {
          agentId: 'broken-worker',
          displayName: 'Broken Worker',
          role: 'worker',
          managerId: 'manager',
          status: 'idle',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: config.defaultCwd,
          sessionFile: join(config.paths.sessionsDir, 'broken-worker.jsonl'),
        },
      ],
    }

    await writeFile(config.paths.agentsStoreFile, JSON.stringify(seedAgents, null, 2), 'utf8')

    const originalWarn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((entry) => String(entry)).join(' '))
    }

    try {
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      const agentIds = manager.listAgents().map((agent) => agent.agentId)
      expect(agentIds).toContain('manager')
      expect(agentIds).toContain('cortex')
      expect(agentIds).toHaveLength(2)
      expect(warnings.some((entry) => entry.includes('Skipping invalid descriptor'))).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })

  it('prevents creating a second cortex manager', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.createManager('manager', {
        name: 'Cortex',
        cwd: config.defaultCwd,
      }),
    ).rejects.toThrow('The manager name "cortex" is reserved')
  })

  it('prevents deleting the cortex manager', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(manager.deleteManager('manager', 'cortex')).rejects.toThrow('Cortex manager cannot be deleted')
  })

  it('creates secondary managers and deletes them with owned worker cascade', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Ops Manager',
      cwd: config.defaultCwd,
    })

    expect(secondary.role).toBe('manager')
    expect(secondary.managerId).toBe(secondary.agentId)

    const ownedWorker = await manager.spawnAgent(secondary.agentId, { agentId: 'Owned Worker' })
    expect(ownedWorker.managerId).toBe(secondary.agentId)

    const deleted = await manager.deleteManager('manager', secondary.agentId)

    expect(deleted.managerId).toBe(secondary.agentId)
    expect(deleted.terminatedWorkerIds).toContain(ownedWorker.agentId)
    expect(manager.listAgents().some((agent) => agent.agentId === secondary.agentId)).toBe(false)
    expect(manager.listAgents().some((agent) => agent.agentId === ownedWorker.agentId)).toBe(false)
  })

  it('emits Forge session lifecycle hooks for create, rename, fork, and delete with fork source ids', async () => {
    const config = await makeTempConfig()
    const logPath = join(config.paths.dataDir, 'session-lifecycle-matrix.jsonl')
    await installForgeLifecycleLogger(config, logPath)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    await writeFile(logPath, '', 'utf8')

    const created = await manager.createSession('manager', { label: 'QA Session' })
    await manager.renameSession(created.sessionAgent.agentId, 'QA Session Renamed')
    const forked = await manager.forkSession(created.sessionAgent.agentId, { label: 'QA Session Fork' })
    await manager.deleteSession(created.sessionAgent.agentId)

    const events = await readJsonlFile<any>(logPath)
    expect(events).toEqual([
      {
        action: 'created',
        session: {
          sessionAgentId: created.sessionAgent.agentId,
          profileId: 'manager',
          label: 'QA Session',
          cwd: created.sessionAgent.cwd,
        },
      },
      {
        action: 'renamed',
        session: {
          sessionAgentId: created.sessionAgent.agentId,
          profileId: 'manager',
          label: 'QA Session Renamed',
          cwd: created.sessionAgent.cwd,
        },
      },
      {
        action: 'forked',
        session: {
          sessionAgentId: forked.sessionAgent.agentId,
          profileId: 'manager',
          label: 'QA Session Fork',
          cwd: forked.sessionAgent.cwd,
        },
        sourceSessionAgentId: created.sessionAgent.agentId,
      },
      {
        action: 'deleted',
        session: {
          sessionAgentId: created.sessionAgent.agentId,
          profileId: 'manager',
          label: 'QA Session Renamed',
          cwd: created.sessionAgent.cwd,
        },
      },
    ])
  })

  it('emits Forge session lifecycle hooks for root manager create/delete and per-session delete', async () => {
    const config = await makeTempConfig()
    const logPath = join(config.paths.dataDir, 'lifecycle.jsonl')
    await installForgeLifecycleLogger(config, logPath)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const created = await manager.createManager('cortex', {
      name: 'Ops Manager',
      cwd: config.defaultCwd,
    })
    const childSession = await manager.createSession(created.profileId ?? created.agentId, {
      label: 'Ops Child',
    })

    await manager.deleteManager('cortex', created.agentId)

    const events = await readJsonlFile<any>(logPath)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'created',
          session: expect.objectContaining({ sessionAgentId: created.agentId }),
        }),
        expect.objectContaining({
          action: 'deleted',
          session: expect.objectContaining({ sessionAgentId: created.agentId }),
        }),
        expect.objectContaining({
          action: 'deleted',
          session: expect.objectContaining({ sessionAgentId: childSession.sessionAgent.agentId }),
        }),
      ]),
    )
  })

  it('maps create_manager model presets to canonical runtime models with highest reasoning', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const codexManager = await manager.createManager('manager', {
      name: 'Codex Manager',
      cwd: config.defaultCwd,
      model: 'pi-codex',
    })

    const pi54Manager = await manager.createManager('manager', {
      name: 'GPT 5.4 Manager',
      cwd: config.defaultCwd,
      model: 'pi-5.4',
    })

    const opusManager = await manager.createManager('manager', {
      name: 'Opus Manager',
      cwd: config.defaultCwd,
      model: 'pi-opus',
    })

    const codexAppManager = await manager.createManager('manager', {
      name: 'Codex App Manager',
      cwd: config.defaultCwd,
      model: 'codex-app',
    })

    expect(codexManager.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'xhigh',
    })
    expect(pi54Manager.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'xhigh',
    })
    expect(opusManager.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    })
    expect(codexAppManager.model).toEqual({
      provider: 'openai-codex-app-server',
      modelId: 'default',
      thinkingLevel: 'xhigh',
    })
  })

  it('defaults create_manager to pi-codex mapping when model is omitted', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.createManager('manager', {
      name: 'Default Model Manager',
      cwd: config.defaultCwd,
    })

    expect(created.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'xhigh',
    })
  })

  it('rejects invalid create_manager model presets with a clear error', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.createManager('manager', {
        name: 'Invalid Manager',
        cwd: config.defaultCwd,
        model: 'invalid-model' as any,
      }),
     ).rejects.toThrow('create_manager.model must be one of pi-codex|pi-5.4|pi-opus|sdk-opus|sdk-sonnet|pi-grok|codex-app|cursor-acp')
  })

  it('replacement-shuts down idle manager session runtimes after a profile model change and recreates them on the next prompt', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const rootSession = await bootWithDefaultManager(manager, config)
    const { sessionAgent } = await manager.createSession('manager', { label: 'Alt Session' })

    const rootRuntime = manager.runtimeByAgentId.get(rootSession.agentId)
    const sessionRuntime = manager.runtimeByAgentId.get(sessionAgent.agentId)
    const state = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
    }

    expect(rootRuntime).toBeDefined()
    expect(sessionRuntime).toBeDefined()
    expect(state.runtimes.has(rootSession.agentId)).toBe(true)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(true)

    rootRuntime!.terminateMutatesDescriptorStatus = true
    sessionRuntime!.terminateMutatesDescriptorStatus = true

    await manager.updateManagerModel('manager', 'pi-5.4')

    expect(rootRuntime?.shutdownForReplacementCalls).toHaveLength(1)
    expect(sessionRuntime?.shutdownForReplacementCalls).toHaveLength(1)
    expect(rootRuntime?.recycleCalls).toBe(0)
    expect(sessionRuntime?.recycleCalls).toBe(0)
    expect(rootRuntime?.terminateCalls).toHaveLength(0)
    expect(sessionRuntime?.terminateCalls).toHaveLength(0)
    expect(state.runtimes.has(rootSession.agentId)).toBe(false)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(false)
    expect(manager.getAgent(rootSession.agentId)?.status).toBe('idle')
    expect(manager.getAgent(sessionAgent.agentId)?.status).toBe('idle')
    expect(manager.getAgent(rootSession.agentId)?.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'xhigh',
    })
    expect(manager.getAgent(sessionAgent.agentId)?.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'xhigh',
    })

    const createdRuntimeCountBeforePrompt = manager.createdRuntimeIds.length
    await manager.handleUserMessage('Use the new model', { targetAgentId: sessionAgent.agentId })

    expect(manager.createdRuntimeIds.length).toBe(createdRuntimeCountBeforePrompt + 1)
    expect(manager.runtimeByAgentId.get(sessionAgent.agentId)).not.toBe(sessionRuntime)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(true)
  })

  it('defers model-change replacement shutdown for active manager sessions until they return to idle', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const { sessionAgent } = await manager.createSession('manager', { label: 'Streaming Session' })

    const descriptor = manager.getAgent(sessionAgent.agentId)
    const sessionRuntime = manager.runtimeByAgentId.get(sessionAgent.agentId)
    const state = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
      runtimeTokensByAgentId: Map<string, number>
      pendingManagerRuntimeRecycleAgentIds: Set<string>
      handleRuntimeStatus: (
        runtimeToken: number,
        agentId: string,
        status: AgentDescriptor['status'],
        pendingCount: number,
        contextUsage?: AgentContextUsage,
      ) => Promise<void>
    }

    expect(descriptor?.role).toBe('manager')
    expect(sessionRuntime).toBeDefined()

    if (!descriptor || descriptor.role !== 'manager' || !sessionRuntime) {
      throw new Error('Expected manager session runtime to exist')
    }

    descriptor.status = 'streaming'
    descriptor.updatedAt = new Date().toISOString()
    sessionRuntime.busy = true
    sessionRuntime.terminateMutatesDescriptorStatus = true

    await manager.updateManagerModel('manager', 'pi-opus')

    expect(sessionRuntime.shutdownForReplacementCalls).toHaveLength(0)
    expect(sessionRuntime.recycleCalls).toBe(0)
    expect(sessionRuntime.terminateCalls).toHaveLength(0)
    expect(state.pendingManagerRuntimeRecycleAgentIds.has(sessionAgent.agentId)).toBe(true)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(true)

    const runtimeToken = state.runtimeTokensByAgentId.get(sessionAgent.agentId)
    expect(runtimeToken).toBeTypeOf('number')

    sessionRuntime.busy = false
    await state.handleRuntimeStatus(runtimeToken as number, sessionAgent.agentId, 'idle', 0)

    expect(sessionRuntime.shutdownForReplacementCalls).toHaveLength(1)
    expect(sessionRuntime.recycleCalls).toBe(0)
    expect(sessionRuntime.terminateCalls).toHaveLength(0)
    expect(state.pendingManagerRuntimeRecycleAgentIds.has(sessionAgent.agentId)).toBe(false)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(false)
    expect(manager.getAgent(sessionAgent.agentId)?.status).toBe('idle')
    expect(manager.getAgent(sessionAgent.agentId)?.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    })

    const createdRuntimeCountBeforePrompt = manager.createdRuntimeIds.length
    await manager.handleUserMessage('Recreate after idle', { targetAgentId: sessionAgent.agentId })

    expect(manager.createdRuntimeIds.length).toBe(createdRuntimeCountBeforePrompt + 1)
    expect(manager.runtimeByAgentId.get(sessionAgent.agentId)).not.toBe(sessionRuntime)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(true)
  })

  it('injects startup-only recovery context on cross-runtime model changes while leaving prompt metadata and preview base-only', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.updateManagerModel('manager', 'sdk-opus')
    await manager.handleUserMessage('Switch the root session to Claude first', { targetAgentId: 'manager' })

    const { sessionAgent } = await manager.createSession('manager', { label: 'Continuity Session' })
    appendSessionConversationMessage(sessionAgent.sessionFile, sessionAgent.agentId, 'Durable context from Claude.')

    await manager.updateManagerModel('manager', 'pi-5.4')

    const beforeState = await loadModelChangeContinuityState(sessionAgent.sessionFile)
    expect(beforeState.requests).toHaveLength(1)
    expect(beforeState.applied).toHaveLength(0)

    await manager.handleUserMessage('Continue after switching to Pi', { targetAgentId: sessionAgent.agentId })

    const recoveryOptions = manager.runtimeCreationOptionsByAgentId.get(sessionAgent.agentId)
    expect(recoveryOptions?.startupRecoveryContext?.reason).toBe('model_change')
    expect(recoveryOptions?.startupRecoveryContext?.blockText).toContain('# Recovered Forge Conversation Context')
    expect(recoveryOptions?.startupRecoveryContext?.blockText).toContain('Durable context from Claude.')
    expect(manager.systemPromptByAgentId.get(sessionAgent.agentId)).not.toContain('# Recovered Forge Conversation Context')

    const afterState = await loadModelChangeContinuityState(sessionAgent.sessionFile)
    expect(afterState.applied).toHaveLength(1)
    expect(afterState.applied[0]?.requestId).toBe(beforeState.requests[0]?.requestId)

    const meta = await readSessionMeta(config.paths.dataDir, 'manager', sessionAgent.agentId)
    expect(meta?.resolvedSystemPrompt).toBeTypeOf('string')
    expect(meta?.resolvedSystemPrompt).not.toContain('# Recovered Forge Conversation Context')

    const preview = await manager.previewManagerSystemPrompt('manager')
    expect(preview.sections.find((section) => section.label === 'System Prompt')?.content).not.toContain(
      '# Recovered Forge Conversation Context',
    )
  })

  it('consumes inactive-session continuity requests when the runtime is later recreated', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Inactive Continuity Session' })
    appendSessionConversationMessage(sessionAgent.sessionFile, sessionAgent.agentId, 'Durable context from an inactive session.')

    await manager.stopSession(sessionAgent.agentId)
    await manager.updateManagerModel('manager', 'sdk-opus')

    const beforeState = await loadModelChangeContinuityState(sessionAgent.sessionFile)
    expect(beforeState.requests).toHaveLength(1)
    expect(beforeState.applied).toHaveLength(0)

    await manager.resumeSession(sessionAgent.agentId)

    const recoveryOptions = manager.runtimeCreationOptionsByAgentId.get(sessionAgent.agentId)
    expect(recoveryOptions?.startupRecoveryContext?.reason).toBe('model_change')
    expect(recoveryOptions?.startupRecoveryContext?.blockText).toContain('# Recovered Forge Conversation Context')
    expect(recoveryOptions?.startupRecoveryContext?.blockText).toContain('Durable context from an inactive session.')
    expect(manager.systemPromptByAgentId.get(sessionAgent.agentId)).not.toContain('# Recovered Forge Conversation Context')

    const afterState = await loadModelChangeContinuityState(sessionAgent.sessionFile)
    expect(afterState.applied).toHaveLength(1)
    expect(afterState.applied[0]?.requestId).toBe(beforeState.requests[0]?.requestId)
  })

  it('consumes only the latest matching pending continuity request when model changes are deferred twice', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.updateManagerModel('manager', 'sdk-opus')
    await manager.handleUserMessage('Switch the root session to Claude first', { targetAgentId: 'manager' })

    const { sessionAgent } = await manager.createSession('manager', { label: 'Deferred Continuity Session' })
    appendSessionConversationMessage(sessionAgent.sessionFile, sessionAgent.agentId, 'Most recent durable context.')

    await manager.updateManagerModel('manager', 'pi-5.4')
    await manager.updateManagerModel('manager', 'pi-opus')

    const beforeState = await loadModelChangeContinuityState(sessionAgent.sessionFile)
    expect(beforeState.requests).toHaveLength(2)
    expect(beforeState.applied).toHaveLength(0)

    await manager.handleUserMessage('Continue after the second deferred model switch', { targetAgentId: sessionAgent.agentId })

    const afterState = await loadModelChangeContinuityState(sessionAgent.sessionFile)
    expect(afterState.applied).toHaveLength(1)
    expect(afterState.applied[0]?.requestId).toBe(beforeState.requests[1]?.requestId)
    expect(afterState.applied[0]?.requestId).not.toBe(beforeState.requests[0]?.requestId)
    expect(manager.runtimeCreationOptionsByAgentId.get(sessionAgent.agentId)?.startupRecoveryContext?.blockText).toContain(
      'Most recent durable context.',
    )
  })

  it('leaves model-change continuity requests pending when replacement runtime creation fails before attach', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.updateManagerModel('manager', 'sdk-opus')
    await manager.handleUserMessage('Switch the root session to Claude first', { targetAgentId: 'manager' })

    const { sessionAgent } = await manager.createSession('manager', { label: 'Failing Continuity Session' })
    appendSessionConversationMessage(sessionAgent.sessionFile, sessionAgent.agentId, 'Durable context before failure.')

    manager.onCreateRuntime = async ({ descriptor, creationCount }) => {
      if (descriptor.agentId === sessionAgent.agentId && creationCount > 1) {
        throw new Error('simulated continuity startup failure')
      }
    }

    await manager.updateManagerModel('manager', 'pi-5.4')

    await expect(
      manager.handleUserMessage('Try to recreate the failing session', { targetAgentId: sessionAgent.agentId }),
    ).rejects.toThrow('simulated continuity startup failure')

    const afterState = await loadModelChangeContinuityState(sessionAgent.sessionFile)
    expect(afterState.requests).toHaveLength(1)
    expect(afterState.applied).toHaveLength(0)
  })

  it('persists the applied continuity marker before attaching the replacement runtime', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.updateManagerModel('manager', 'sdk-opus')
    await manager.handleUserMessage('Switch the root session to Claude first', { targetAgentId: 'manager' })

    const { sessionAgent } = await manager.createSession('manager', { label: 'Ordered Continuity Session' })
    appendSessionConversationMessage(sessionAgent.sessionFile, sessionAgent.agentId, 'Durable context before ordered attach.')

    await manager.updateManagerModel('manager', 'pi-5.4')

    const state = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
      lifecycleService: {
        options: {
          appendAppliedModelChangeContinuity: (
            descriptor: AgentDescriptor & { role: 'manager'; profileId: string },
            request: any,
            runtime: SwarmAgentRuntime,
          ) => Promise<void>
          attachRuntime: (agentId: string, runtime: SwarmAgentRuntime) => void
        }
      }
    }
    const order: string[] = []
    const originalAppendApplied = state.lifecycleService.options.appendAppliedModelChangeContinuity
    const originalAttachRuntime = state.lifecycleService.options.attachRuntime

    state.lifecycleService.options.appendAppliedModelChangeContinuity = async (descriptor, request, runtime) => {
      order.push('append:start')
      expect(state.runtimes.has(descriptor.agentId)).toBe(false)
      await originalAppendApplied(descriptor, request, runtime)
      order.push('append:end')
      expect(state.runtimes.has(descriptor.agentId)).toBe(false)
    }
    state.lifecycleService.options.attachRuntime = (agentId, runtime) => {
      order.push('attach')
      originalAttachRuntime(agentId, runtime)
    }

    await manager.handleUserMessage('Continue after the ordered handoff', { targetAgentId: sessionAgent.agentId })

    expect(order).toEqual(['append:start', 'append:end', 'attach'])

    const afterState = await loadModelChangeContinuityState(sessionAgent.sessionFile)
    expect(afterState.applied).toHaveLength(1)
  })

  it('does not attach a replacement runtime when applied-marker persistence fails', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.updateManagerModel('manager', 'sdk-opus')
    await manager.handleUserMessage('Switch the root session to Claude first', { targetAgentId: 'manager' })

    const { sessionAgent } = await manager.createSession('manager', { label: 'Applied Write Failure Session' })
    appendSessionConversationMessage(sessionAgent.sessionFile, sessionAgent.agentId, 'Durable context before applied write failure.')

    await manager.updateManagerModel('manager', 'pi-5.4')

    const state = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
      lifecycleService: {
        options: {
          appendAppliedModelChangeContinuity: (
            descriptor: AgentDescriptor & { role: 'manager'; profileId: string },
            request: any,
            runtime: SwarmAgentRuntime,
          ) => Promise<void>
        }
      }
    }
    const originalAppendApplied = state.lifecycleService.options.appendAppliedModelChangeContinuity
    state.lifecycleService.options.appendAppliedModelChangeContinuity = async (descriptor, request, runtime) => {
      if (descriptor.agentId === sessionAgent.agentId) {
        throw new Error('simulated applied write failure')
      }
      await originalAppendApplied(descriptor, request, runtime)
    }

    await expect(
      manager.handleUserMessage('Try to recreate after applied write failure', { targetAgentId: sessionAgent.agentId }),
    ).rejects.toThrow('simulated applied write failure')

    const afterState = await loadModelChangeContinuityState(sessionAgent.sessionFile)
    expect(afterState.requests).toHaveLength(1)
    expect(afterState.applied).toHaveLength(0)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(false)
    expect(manager.runtimeByAgentId.get(sessionAgent.agentId)?.terminateCalls).toHaveLength(1)
  })

  it('recycles only sessions using models whose specific instructions changed, deferring busy sessions until idle', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const rootSession = await bootWithDefaultManager(manager, config)
    const { sessionAgent } = await manager.createSession('manager', { label: 'Streaming Session' })
    const otherManager = await manager.createManager('manager', {
      name: 'Other Manager',
      cwd: config.defaultCwd,
      model: 'pi-opus',
    })

    const rootRuntime = manager.runtimeByAgentId.get(rootSession.agentId)
    const sessionRuntime = manager.runtimeByAgentId.get(sessionAgent.agentId)
    const otherRuntime = manager.runtimeByAgentId.get(otherManager.agentId)
    const descriptor = manager.getAgent(sessionAgent.agentId)
    const rootModel = manager.getAgent(rootSession.agentId)?.model
    const state = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
      runtimeTokensByAgentId: Map<string, number>
      pendingManagerRuntimeRecycleAgentIds: Set<string>
      handleRuntimeStatus: (
        runtimeToken: number,
        agentId: string,
        status: AgentDescriptor['status'],
        pendingCount: number,
        contextUsage?: AgentContextUsage,
      ) => Promise<void>
    }

    expect(rootRuntime).toBeDefined()
    expect(sessionRuntime).toBeDefined()
    expect(otherRuntime).toBeDefined()
    expect(descriptor?.role).toBe('manager')
    expect(rootModel).toBeDefined()

    if (!rootRuntime || !sessionRuntime || !otherRuntime || !descriptor || descriptor.role !== 'manager' || !rootModel) {
      throw new Error('Expected manager session runtimes to exist')
    }

    const catalogModel = modelCatalogService.getModel(rootModel.modelId, rootModel.provider)
    expect(catalogModel).toBeDefined()

    if (!catalogModel) {
      throw new Error('Expected root session model to exist in the model catalog')
    }

    descriptor.status = 'streaming'
    descriptor.updatedAt = new Date().toISOString()
    sessionRuntime.busy = true

    await manager.notifyModelSpecificInstructionsChanged([getCatalogModelKey(catalogModel)])

    expect(rootRuntime.recycleCalls).toBe(1)
    expect(sessionRuntime.recycleCalls).toBe(0)
    expect(otherRuntime.recycleCalls).toBe(0)
    expect(state.runtimes.has(rootSession.agentId)).toBe(false)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(true)
    expect(state.runtimes.has(otherManager.agentId)).toBe(true)
    expect(state.pendingManagerRuntimeRecycleAgentIds.has(sessionAgent.agentId)).toBe(true)
    expect(state.pendingManagerRuntimeRecycleAgentIds.has(otherManager.agentId)).toBe(false)

    const runtimeToken = state.runtimeTokensByAgentId.get(sessionAgent.agentId)
    expect(runtimeToken).toBeTypeOf('number')

    sessionRuntime.busy = false
    await state.handleRuntimeStatus(runtimeToken as number, sessionAgent.agentId, 'idle', 0)

    expect(sessionRuntime.recycleCalls).toBe(1)
    expect(state.pendingManagerRuntimeRecycleAgentIds.has(sessionAgent.agentId)).toBe(false)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(false)
    expect(manager.runtimeByAgentId.get(otherManager.agentId)).toBe(otherRuntime)

    const createdRuntimeCountBeforePrompt = manager.createdRuntimeIds.length
    await manager.handleUserMessage('Use refreshed instructions', { targetAgentId: sessionAgent.agentId })

    expect(manager.createdRuntimeIds.length).toBe(createdRuntimeCountBeforePrompt + 1)
    expect(manager.runtimeByAgentId.get(sessionAgent.agentId)).not.toBe(sessionRuntime)
    expect(manager.runtimeByAgentId.get(otherManager.agentId)).toBe(otherRuntime)
  })

  it('does not recycle manager runtimes when a cwd update resolves to the current cwd', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const rootSession = await bootWithDefaultManager(manager, config)
    const { sessionAgent } = await manager.createSession('manager', { label: 'Alt Session' })

    const rootRuntime = manager.runtimeByAgentId.get(rootSession.agentId)
    const sessionRuntime = manager.runtimeByAgentId.get(sessionAgent.agentId)
    const state = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
    }

    expect(rootRuntime).toBeDefined()
    expect(sessionRuntime).toBeDefined()
    expect(state.runtimes.has(rootSession.agentId)).toBe(true)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(true)

    const unchangedCwd = manager.getAgent(rootSession.agentId)?.cwd
    expect(unchangedCwd).toBeTypeOf('string')

    await expect(manager.updateManagerCwd('manager', unchangedCwd as string)).resolves.toBe(unchangedCwd)

    expect(rootRuntime?.recycleCalls).toBe(0)
    expect(sessionRuntime?.recycleCalls).toBe(0)
    expect(state.runtimes.has(rootSession.agentId)).toBe(true)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(true)
  })

  it('persists cwd updates even when one runtime recycle fails', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const rootSession = await bootWithDefaultManager(manager, config)
    const { sessionAgent } = await manager.createSession('manager', { label: 'Alt Session' })
    const nextCwd = join(config.defaultCwd, 'worktrees', 'next-cwd')

    await mkdir(nextCwd, { recursive: true })

    const originalApplyManagerRuntimeRecyclePolicy = (
      manager as unknown as {
        applyManagerRuntimeRecyclePolicy: (agentId: string, reason: string) => Promise<'recycled' | 'deferred' | 'none'>
      }
    ).applyManagerRuntimeRecyclePolicy.bind(manager)
    const applyManagerRuntimeRecyclePolicySpy = vi
      .spyOn(manager as unknown as { applyManagerRuntimeRecyclePolicy: (agentId: string, reason: string) => Promise<'recycled' | 'deferred' | 'none'> }, 'applyManagerRuntimeRecyclePolicy')
      .mockImplementation(async (agentId, reason) => {
        if (agentId === rootSession.agentId) {
          throw new Error('recycle boom')
        }
        return originalApplyManagerRuntimeRecyclePolicy(agentId, reason)
      })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const resolvedCwd = await manager.updateManagerCwd('manager', nextCwd)

    expect(applyManagerRuntimeRecyclePolicySpy).toHaveBeenCalledTimes(2)
    expect(manager.getAgent(rootSession.agentId)?.cwd).toBe(resolvedCwd)
    expect(manager.getAgent(sessionAgent.agentId)?.cwd).toBe(resolvedCwd)
    expect(manager.runtimeByAgentId.get(rootSession.agentId)?.recycleCalls).toBe(0)
    expect(manager.runtimeByAgentId.get(sessionAgent.agentId)?.recycleCalls).toBe(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('manager:update_cwd:recycle_failed'))

    const store = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as { agents: AgentDescriptor[] }
    expect(store.agents.find((agent) => agent.agentId === rootSession.agentId)?.cwd).toBe(resolvedCwd)
    expect(store.agents.find((agent) => agent.agentId === sessionAgent.agentId)?.cwd).toBe(resolvedCwd)
  })

  it('rejects cwd updates for the Cortex profile', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(manager.updateManagerCwd('cortex', config.defaultCwd)).rejects.toThrow(
      'Cannot change working directory for Cortex profile',
    )
  })

  it('recycles or defers manager runtimes when the project-agent directory changes', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const rootSession = await bootWithDefaultManager(manager, config)
    const { sessionAgent } = await manager.createSession('manager', { label: 'Streaming Session' })

    const rootRuntime = manager.runtimeByAgentId.get(rootSession.agentId)
    const sessionRuntime = manager.runtimeByAgentId.get(sessionAgent.agentId)
    const descriptor = manager.getAgent(sessionAgent.agentId)
    const state = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
      runtimeTokensByAgentId: Map<string, number>
      pendingManagerRuntimeRecycleAgentIds: Set<string>
      handleRuntimeStatus: (
        runtimeToken: number,
        agentId: string,
        status: AgentDescriptor['status'],
        pendingCount: number,
        contextUsage?: AgentContextUsage,
      ) => Promise<void>
    }

    expect(rootRuntime).toBeDefined()
    expect(sessionRuntime).toBeDefined()
    expect(descriptor?.role).toBe('manager')

    if (!rootRuntime || !sessionRuntime || !descriptor || descriptor.role !== 'manager') {
      throw new Error('Expected manager session runtimes to exist')
    }

    descriptor.status = 'streaming'
    descriptor.updatedAt = new Date().toISOString()
    sessionRuntime.busy = true

    await manager.notifyProjectAgentsChanged('manager')

    expect(rootRuntime.recycleCalls).toBe(1)
    expect(sessionRuntime.recycleCalls).toBe(0)
    expect(state.runtimes.has(rootSession.agentId)).toBe(false)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(true)
    expect(state.pendingManagerRuntimeRecycleAgentIds.has(sessionAgent.agentId)).toBe(true)

    const runtimeToken = state.runtimeTokensByAgentId.get(sessionAgent.agentId)
    expect(runtimeToken).toBeTypeOf('number')

    sessionRuntime.busy = false
    await state.handleRuntimeStatus(runtimeToken as number, sessionAgent.agentId, 'idle', 0)

    expect(sessionRuntime.recycleCalls).toBe(1)
    expect(state.pendingManagerRuntimeRecycleAgentIds.has(sessionAgent.agentId)).toBe(false)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(false)
  })

  it.each([
    {
      label: 'profile model changes',
      expectedReason: 'model_change' as const,
      invoke: async (manager: TestSwarmManager, _rootSession: AgentDescriptor, _sessionAgent: AgentDescriptor, _config: SwarmConfig) => {
        await manager.updateManagerModel('manager', 'pi-5.4')
      },
    },
    {
      label: 'model-specific instruction changes',
      expectedReason: 'prompt_mode_change' as const,
      expectedAgentIds: ['cortex', 'manager', 'manager--s2'],
      invoke: async (manager: TestSwarmManager, rootSession: AgentDescriptor, _sessionAgent: AgentDescriptor, _config: SwarmConfig) => {
        const catalogModel = modelCatalogService.getModel(rootSession.model.modelId, rootSession.model.provider)
        expect(catalogModel).toBeDefined()

        if (!catalogModel) {
          throw new Error('Expected root session model to exist in the model catalog')
        }

        await manager.notifyModelSpecificInstructionsChanged([getCatalogModelKey(catalogModel)])
      },
    },
    {
      label: 'working-directory changes',
      expectedReason: 'cwd_change' as const,
      invoke: async (manager: TestSwarmManager, _rootSession: AgentDescriptor, _sessionAgent: AgentDescriptor, config: SwarmConfig) => {
        const nextCwd = join(config.defaultCwd, 'worktrees', 'triggered-recycle')
        await mkdir(nextCwd, { recursive: true })
        await manager.updateManagerCwd('manager', nextCwd)
      },
    },
    {
      label: 'specialist roster changes',
      expectedReason: 'specialist_roster_change' as const,
      invoke: async (manager: TestSwarmManager, _rootSession: AgentDescriptor, _sessionAgent: AgentDescriptor, _config: SwarmConfig) => {
        await manager.notifySpecialistRosterChanged('manager')
      },
    },
    {
      label: 'project-agent directory changes',
      expectedReason: 'project_agent_directory_change' as const,
      invoke: async (manager: TestSwarmManager, _rootSession: AgentDescriptor, _sessionAgent: AgentDescriptor, _config: SwarmConfig) => {
        await manager.notifyProjectAgentsChanged('manager')
      },
    },
  ])('routes manager runtime recycle policy through $label', async ({ invoke, expectedReason, expectedAgentIds }) => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const rootSession = await bootWithDefaultManager(manager, config)
    const { sessionAgent } = await manager.createSession('manager', { label: 'Alt Session' })

    const applyRecyclePolicySpy = vi
      .spyOn(
        manager as unknown as {
          applyManagerRuntimeRecyclePolicy: (
            agentId: string,
            reason:
              | 'model_change'
              | 'cwd_change'
              | 'idle_transition'
              | 'prompt_mode_change'
              | 'project_agent_directory_change'
              | 'specialist_roster_change',
          ) => Promise<'recycled' | 'deferred' | 'none'>
        },
        'applyManagerRuntimeRecyclePolicy',
      )
      .mockResolvedValue('deferred')

    await invoke(manager, rootSession, sessionAgent, config)

    const expectedTargets = expectedAgentIds ?? [rootSession.agentId, sessionAgent.agentId]
    expect(applyRecyclePolicySpy.mock.calls).toEqual(
      expectedTargets.map((agentId) => [agentId, expectedReason]),
    )
  })

  it('maps spawn_agent model presets to canonical runtime models with highest reasoning', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const codexWorker = await manager.spawnAgent('manager', {
      agentId: 'Codex Worker',
      model: 'pi-codex',
    })

    const pi54Worker = await manager.spawnAgent('manager', {
      agentId: 'GPT 5.4 Worker',
      model: 'pi-5.4',
    })

    const opusWorker = await manager.spawnAgent('manager', {
      agentId: 'Opus Worker',
      model: 'pi-opus',
    })

    const codexAppWorker = await manager.spawnAgent('manager', {
      agentId: 'Codex App Worker',
      model: 'codex-app',
    })

    expect(codexWorker.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'xhigh',
    })
    expect(pi54Worker.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.4',
      thinkingLevel: 'xhigh',
    })
    expect(opusWorker.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    })
    expect(codexAppWorker.model).toEqual({
      provider: 'openai-codex-app-server',
      modelId: 'default',
      thinkingLevel: 'xhigh',
    })
  })

  it('applies spawn_agent modelId and reasoningLevel overrides over preset defaults', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const overridden = await manager.spawnAgent('manager', {
      agentId: 'Override Worker',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
      reasoningLevel: 'medium',
    })

    expect(overridden.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex-spark',
      thinkingLevel: 'medium',
    })
  })

  it('maps anthropic reasoning none/xhigh to low/high for spawn_agent', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const lowMapped = await manager.spawnAgent('manager', {
      agentId: 'Opus None Worker',
      model: 'pi-opus',
      reasoningLevel: 'none',
    })

    const highMapped = await manager.spawnAgent('manager', {
      agentId: 'Opus Xhigh Worker',
      model: 'pi-opus',
      reasoningLevel: 'xhigh',
    })

    expect(lowMapped.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'low',
    })
    expect(highMapped.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    })
  })

  it('applies spawn_agent overrides when inheriting manager model fallback', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const overridden = await manager.spawnAgent('manager', {
      agentId: 'Fallback Override Worker',
      modelId: 'gpt-5.3-codex-spark',
      reasoningLevel: 'low',
    })

    expect(overridden.model).toEqual({
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex-spark',
      thinkingLevel: 'low',
    })
  })

  it('formats extension runtime errors with extension basename and event details', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', {
      agentId: 'Extension Error Worker',
    })

    await (manager as any).handleRuntimeError(worker.agentId, {
      phase: 'extension',
      message: 'blocked write outside allowed roots',
      details: {
        extensionPath: '/tmp/protected-paths.ts',
        event: 'tool_call',
      },
    })

    const history = manager.getConversationHistory(worker.agentId)
    const systemEvent = [...history]
      .reverse()
      .find((entry) => entry.type === 'conversation_message' && entry.role === 'system')

    expect(systemEvent).toBeDefined()
    if (systemEvent?.type === 'conversation_message') {
      expect(systemEvent.text).toBe(
        '⚠️ Extension error (protected-paths.ts · tool_call): blocked write outside allowed roots',
      )
    }
  })

  it('reroutes spawn_agent model from spark to codex when spark is temporarily quota-blocked', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const sparkWorker = await manager.spawnAgent('manager', {
      agentId: 'Spark Block Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    await (manager as any).handleRuntimeError(sparkWorker.agentId, {
      phase: 'prompt_dispatch',
      message: 'You have hit your ChatGPT usage limit (pro plan). Try again in ~4307 min.',
    })

    const rerouted = await manager.spawnAgent('manager', {
      agentId: 'Spark Fallback Worker',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    expect(rerouted.model.modelId).toBe('gpt-5.3-codex')
  })

  it('reroutes spawn_agent model from spark to codex when worker message_end stopReason is error', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const sparkWorker = await manager.spawnAgent('manager', {
      agentId: 'Spark Message End Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    await (manager as any).handleRuntimeSessionEvent(sparkWorker.agentId, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'You have hit your ChatGPT usage limit ... in 20 min.',
      },
    })

    const rerouted = await manager.spawnAgent('manager', {
      agentId: 'Spark Message End Fallback Worker',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    expect(rerouted.model.modelId).toBe('gpt-5.3-codex')
  })

  it('reroutes spawn_agent model from spark to gpt-5.4 when spark and codex are blocked', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const sparkWorker = await manager.spawnAgent('manager', {
      agentId: 'Spark Block Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })
    const codexWorker = await manager.spawnAgent('manager', {
      agentId: 'Codex Block Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex',
    })

    await (manager as any).handleRuntimeError(sparkWorker.agentId, {
      phase: 'prompt_start',
      message: 'You have hit your ChatGPT usage limit (pro plan). Try again in 120 min.',
    })
    await (manager as any).handleRuntimeError(codexWorker.agentId, {
      phase: 'prompt_dispatch',
      message: 'Rate limit exceeded for requests per minute. Try again in 30 min.',
    })

    const rerouted = await manager.spawnAgent('manager', {
      agentId: 'Spark Escalation Worker',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    expect(rerouted.model.modelId).toBe('gpt-5.4')
  })

  it('does not reroute spawn_agent model for non-quota runtime errors', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const sparkWorker = await manager.spawnAgent('manager', {
      agentId: 'Spark Non Quota Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    await (manager as any).handleRuntimeError(sparkWorker.agentId, {
      phase: 'prompt_dispatch',
      message: 'Network socket disconnected before secure TLS connection was established.',
    })

    const followup = await manager.spawnAgent('manager', {
      agentId: 'Spark Non Quota Followup',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    expect(followup.model.modelId).toBe('gpt-5.3-codex-spark')
  })

  it('does not apply quota rerouting outside prompt_dispatch/prompt_start phases', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const sparkWorker = await manager.spawnAgent('manager', {
      agentId: 'Spark Steer Delivery Source',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    await (manager as any).handleRuntimeError(sparkWorker.agentId, {
      phase: 'steer_delivery',
      message: 'You have hit your ChatGPT usage limit (pro plan). Try again in 30 min.',
    })

    const followup = await manager.spawnAgent('manager', {
      agentId: 'Spark Steer Delivery Followup',
      model: 'pi-codex',
      modelId: 'gpt-5.3-codex-spark',
    })

    expect(followup.model.modelId).toBe('gpt-5.3-codex-spark')
  })

  it('rejects invalid spawn_agent model presets with a clear error', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.spawnAgent('manager', {
        agentId: 'Invalid Worker',
        model: 'invalid-model' as any,
      }),
     ).rejects.toThrow('spawn_agent.model must be one of pi-codex|pi-5.4|pi-opus|sdk-opus|sdk-sonnet|pi-grok|codex-app|cursor-acp')
  })

  it('rejects invalid spawn_agent reasoning levels with a clear error', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(
      manager.spawnAgent('manager', {
        agentId: 'Invalid Reasoning Worker',
        reasoningLevel: 'ultra' as any,
      }),
    ).rejects.toThrow('spawn_agent.reasoningLevel must be one of none|low|medium|high|xhigh')
  })

  it('allows deleting the default manager when requested', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const deleted = await manager.deleteManager('manager', 'manager')

    expect(deleted.managerId).toBe('manager')
    expect(deleted.terminatedWorkerIds).toEqual([])
    expect(manager.listAgents()).toHaveLength(1)
    expect(manager.listAgents()[0]?.agentId).toBe('cortex')
  })

  it('allows creating a new manager after deleting the default manager', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.deleteManager('manager', 'manager')

    const recreated = await manager.createManager('cortex', {
      name: 'Recreated Manager',
      cwd: config.defaultCwd,
    })

    expect(recreated.role).toBe('manager')
    expect(manager.listAgents().some((agent) => agent.agentId === recreated.agentId)).toBe(true)
  })

  it('enforces strict manager ownership for worker control operations', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Delivery Manager',
      cwd: config.defaultCwd,
    })
    const worker = await manager.spawnAgent(secondary.agentId, { agentId: 'Delivery Worker' })

    await expect(manager.killAgent('manager', worker.agentId)).rejects.toThrow(
      `Only owning manager can kill agent ${worker.agentId}`,
    )
    await expect(manager.sendMessage('manager', worker.agentId, 'cross-manager control')).rejects.toThrow(
      `Manager manager does not own worker ${worker.agentId}`,
    )

    await manager.killAgent(secondary.agentId, worker.agentId)
    const descriptor = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(descriptor?.status).toBe('terminated')
  })

  it('routes user-to-worker delivery through the owning manager context', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Routing Manager',
      cwd: config.defaultCwd,
    })
    const worker = await manager.spawnAgent(secondary.agentId, { agentId: 'Routing Worker' })

    await manager.handleUserMessage('hello owned worker', { targetAgentId: worker.agentId })

    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime?.sendCalls.at(-1)?.message).toBe('hello owned worker')
  })

  it('accepts any existing directory for manager and worker creation', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const outsideDir = await mkdtemp(join(tmpdir(), 'outside-allowlist-'))

    const externalManager = await manager.createManager('manager', {
      name: 'External Manager',
      cwd: outsideDir,
    })

    const externalWorker = await manager.spawnAgent(externalManager.agentId, {
      agentId: 'External Worker',
      cwd: outsideDir,
    })

    const validation = await manager.validateDirectory(outsideDir)
    const listed = await manager.listDirectories(outsideDir)

    expect(externalManager.cwd).toBe(validation.resolvedPath)
    expect(externalWorker.cwd).toBe(validation.resolvedPath)
    expect(validation.valid).toBe(true)
    expect(validation.message).toBeUndefined()
    expect(listed.resolvedPath).toBe(validation.resolvedPath)
    expect(listed.roots).toEqual([])
  })
})
