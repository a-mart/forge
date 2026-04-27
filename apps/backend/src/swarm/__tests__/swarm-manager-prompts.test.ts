/* eslint-disable @typescript-eslint/no-unused-vars -- harness duplicated from test/swarm-manager.test.ts for split suites */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AuthStorage, SessionManager } from '@mariozechner/pi-coding-agent'
import { getCatalogModelKey } from '@forge/protocol'
import { getConversationHistoryCacheFilePath } from '../conversation-history-cache.js'
import {
  getCommonKnowledgePath,
  getCortexPromotionManifestsDir,
  getCortexReviewLogPath,
  getCortexReviewRunsPath,
  getCortexWorkerPromptsPath,
  getProfileKnowledgePath,
  getProfileMemoryPath,
  getProfilePiSkillsDir,
  getProfileMergeAuditLogPath,
  getProfileReferencePath,
  getProjectAgentConfigPath,
  getProjectAgentDir,
  getProjectAgentPromptPath,
  getRootSessionMemoryPath,
  getSessionDir,
  getSessionMemoryPath,
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

import { readSessionMeta, writeSessionMeta } from '../session-manifest.js'
import { loadOnboardingState, saveOnboardingPreferences } from '../onboarding-state.js'
import { AgentRuntime } from '../agent-runtime.js'
import { modelCatalogService } from '../model-catalog-service.js'
import { loadModelChangeContinuityState } from '../runtime/model-change-continuity.js'
import { buildSessionMemoryRuntimeView, SwarmManager } from '../swarm-manager.js'
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SwarmConfig,
} from '../types.js'
import type {
  RuntimeCreationOptions,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeUserMessage,
  SwarmAgentRuntime,
} from '../runtime-contracts.js'
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

class MergeEnabledTestSwarmManager extends TestSwarmManager {
  protected override async executeSessionMemoryLLMMerge(
    _descriptor: AgentDescriptor,
    profileMemoryContent: string,
    sessionMemoryContent: string,
  ): Promise<{ mergedContent: string; model: string }> {
    const mergedContent = await memoryMergeMockState.executeLLMMerge(profileMemoryContent, sessionMemoryContent)
    return {
      mergedContent,
      model: 'mock/test-model',
    }
  }
}

class ProjectAgentAwareSwarmManager extends TestSwarmManager {
  readonly notifiedProjectAgentProfileIds: string[] = []

  override async notifyProjectAgentsChanged(profileId: string): Promise<void> {
    this.notifiedProjectAgentProfileIds.push(profileId)
  }
}

class AuthFallbackSwarmManager extends SwarmManager {
  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    _runtimeToken?: number,
    _options?: RuntimeCreationOptions,
  ): Promise<SwarmAgentRuntime> {
    const runtime = new FakeRuntime(structuredClone(descriptor), systemPrompt)
    runtime.terminateMutatesDescriptorStatus = false
    return runtime
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
  it('recycles manager runtimes through project-agent directory refresh when a project-agent system prompt is saved', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const rootSession = await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Release Notes' })
    const rootRuntime = manager.runtimeByAgentId.get(rootSession.agentId)
    const sessionRuntime = manager.runtimeByAgentId.get(sessionAgent.agentId)
    const state = manager as unknown as {
      runtimes: Map<string, SwarmAgentRuntime>
    }

    expect(rootRuntime).toBeDefined()
    expect(sessionRuntime).toBeDefined()
    expect(state.runtimes.has(rootSession.agentId)).toBe(true)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(true)

    await manager.setSessionProjectAgent(sessionAgent.agentId, {
      whenToUse: 'Draft release notes and changelog copy.',
      systemPrompt: '  You are the release notes project agent.  ',
    })

    expect(rootRuntime?.recycleCalls).toBe(1)
    expect(sessionRuntime?.recycleCalls).toBe(1)
    expect(state.runtimes.has(rootSession.agentId)).toBe(false)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(false)

    const createdRuntimeCountBeforePrompt = manager.createdRuntimeIds.length
    await manager.handleUserMessage('Use the refreshed prompt', { targetAgentId: sessionAgent.agentId })

    expect(manager.createdRuntimeIds.length).toBe(createdRuntimeCountBeforePrompt + 1)
    expect(manager.runtimeByAgentId.get(sessionAgent.agentId)).not.toBe(sessionRuntime)
    expect(manager.systemPromptByAgentId.get(sessionAgent.agentId)).toContain('You are the release notes project agent.')
    expect(manager.systemPromptByAgentId.get(sessionAgent.agentId)).toContain('Project agents in this profile')
  })

  it('includes promoted peer sessions in manager prompt preview and excludes the current session from its own directory', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.setSessionProjectAgent('manager', {
      whenToUse: 'Coordinate the main manager session.',
    })

    const { sessionAgent } = await manager.createSession('manager', { label: 'Release Notes' })
    await manager.setSessionProjectAgent(sessionAgent.agentId, {
      whenToUse: 'Draft release notes and changelog copy.',
    })

    const preview = await manager.previewManagerSystemPrompt('manager')
    const systemPrompt = preview.sections.find((section) => section.label === 'System Prompt')?.content

    expect(systemPrompt).toBeDefined()
    expect(systemPrompt).toContain('Project agents in this profile')
    expect(systemPrompt).toContain('Release Notes (`@release-notes`, agentId: `' + sessionAgent.agentId + '`)')
    expect(systemPrompt).toContain('Draft release notes and changelog copy.')
    expect(systemPrompt).not.toContain('Coordinate the main manager session.')
    expect(systemPrompt).not.toContain('`@manager`')
  })

  it('includes GPT-5 model-specific instructions in the resolved manager prompt', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const preview = await manager.previewManagerSystemPrompt('manager')
    const systemPrompt = preview.sections.find((section) => section.label === 'System Prompt')?.content

    expect(systemPrompt).toContain('# Model-Specific Instructions')
    expect(systemPrompt).toContain('Return the requested sections only, in the requested order.')
    expect(systemPrompt).toContain('Do not use em dashes unless the user explicitly asks for them')
  })

  it('includes Claude model-specific instructions for pi-opus managers', async () => {
    const config = await makeTempConfig()
    config.defaultModel = {
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    }
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const preview = await manager.previewManagerSystemPrompt('manager')
    const systemPrompt = preview.sections.find((section) => section.label === 'System Prompt')?.content

    expect(systemPrompt).toContain('# Model-Specific Instructions')
    expect(systemPrompt).toContain('Prefer concise, direct answers over essay-style framing.')
    expect(systemPrompt).toContain('When evidence is sufficient, state the conclusion plainly instead of over-hedging.')
  })

  it('includes the model-specific instructions block for Claude SDK managers in prompt preview', async () => {
    const config = await makeTempConfig()
    config.defaultModel = {
      provider: 'claude-sdk',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    }
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const preview = await manager.previewManagerSystemPrompt('manager')
    const systemPrompt = preview.sections.find((section) => section.label === 'System Prompt')?.content

    expect(systemPrompt).toContain('# Model-Specific Instructions')
    expect(systemPrompt).toContain('Prefer concise, direct answers over essay-style framing.')
    expect(systemPrompt).toContain('When evidence is sufficient, state the conclusion plainly instead of over-hedging.')
  })

  it('leaves custom manager prompts unchanged when they do not opt into model-specific instructions', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.setSessionProjectAgent('manager', {
      whenToUse: 'Coordinate the main manager session.',
      systemPrompt: 'You are a custom manager prompt without the model instructions slot.',
    })

    const preview = await manager.previewManagerSystemPrompt('manager')
    const systemPrompt = preview.sections.find((section) => section.label === 'System Prompt')?.content

    expect(systemPrompt).toContain('You are a custom manager prompt without the model instructions slot.')
    expect(systemPrompt).not.toContain('# Model-Specific Instructions')
    expect(systemPrompt).not.toContain('Return the requested sections only, in the requested order.')
  })

  it('labels prompt preview sections with the project-agent system prompt source when overridden', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await manager.setSessionProjectAgent('manager', {
      whenToUse: 'Coordinate the main manager session.',
      systemPrompt: '  You are the release planning project agent.  ',
    })

    const preview = await manager.previewManagerSystemPrompt('manager')
    const systemPromptSection = preview.sections.find((section) => section.label === 'System Prompt')

    expect(systemPromptSection).toMatchObject({
      source: getProjectAgentPromptPath(config.paths.dataDir, 'manager', 'manager'),
    })
    expect(systemPromptSection?.content).toContain('You are the release planning project agent.')
    expect(systemPromptSection?.content).not.toContain('You are the manager agent in a multi-agent swarm.')
  })

  it('previews promoted sessions even when their saved archetype no longer exists', async () => {
    const config = await makeTempConfig()
    const firstBoot = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    await firstBoot.setSessionProjectAgent('manager', {
      whenToUse: 'Coordinate the main manager session.',
      systemPrompt: '  You are the release planning project agent.  ',
    })

    const store = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as { agents: AgentDescriptor[] }
    await writeFile(
      config.paths.agentsStoreFile,
      `${JSON.stringify(
        {
          ...store,
          agents: store.agents.map((agent) =>
            agent.agentId === 'manager'
              ? {
                  ...agent,
                  archetypeId: 'missing-preview-archetype',
                }
              : agent,
          ),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const secondBoot = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    const preview = await secondBoot.previewManagerSystemPrompt('manager')
    const systemPromptSection = preview.sections.find((section) => section.label === 'System Prompt')

    expect(systemPromptSection).toMatchObject({
      source: getProjectAgentPromptPath(config.paths.dataDir, 'manager', 'manager'),
    })
    expect(systemPromptSection?.content).toContain('You are the release planning project agent.')
  })

  it('refreshes persisted session prompt metadata when a project-agent prompt changes', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    const { agentId } = await bootWithDefaultManager(manager, config)

    await manager.setSessionProjectAgent(agentId, {
      whenToUse: 'Coordinate the main manager session.',
      systemPrompt: '  You are the release planning project agent.  ',
    })

    const meta = await readSessionMeta(config.paths.dataDir, 'manager', agentId)

    expect(meta?.resolvedSystemPrompt).toContain('You are the release planning project agent.')
    expect(meta?.resolvedSystemPrompt).toContain('Project agents in this profile')
  })

  it('requestProjectAgentRecommendations analyzes against the base manager prompt without reusing the old override', async () => {
    projectAgentAnalysisMockState.analyzeSessionForPromotion.mockReset()
    projectAgentAnalysisMockState.analyzeSessionForPromotion.mockResolvedValue({
      whenToUse: 'Use for release coordination.',
      systemPrompt: 'You are the release coordination manager.',
    })

    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY

    try {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)

      const sharedAuthStorage = AuthStorage.create(config.paths.sharedAuthFile)
      sharedAuthStorage.set('openai-codex', {
        type: 'api_key',
        key: 'sk-openai-project-agent-analysis',
      } as any)

      const { sessionAgent } = await manager.createSession('manager', { label: 'Release Notes' })
      await manager.setSessionProjectAgent(sessionAgent.agentId, {
        whenToUse: 'Draft release notes and changelog copy.',
        systemPrompt: 'You are the old release-notes override prompt.',
      })

      appendSessionConversationMessage(sessionAgent.sessionFile, sessionAgent.agentId, 'Draft the release notes.')

      const result = await manager.requestProjectAgentRecommendations(sessionAgent.agentId)

      expect(result).toEqual({
        whenToUse: 'Use for release coordination.',
        systemPrompt: 'You are the release coordination manager.',
      })
      expect(projectAgentAnalysisMockState.analyzeSessionForPromotion).toHaveBeenCalledTimes(1)
      const [model, options] = projectAgentAnalysisMockState.analyzeSessionForPromotion.mock.calls[0] ?? []
      expect([
        { provider: 'anthropic', id: 'claude-opus-4-6' },
        { provider: 'openai-codex', id: 'gpt-5.4' },
      ]).toContainEqual(expect.objectContaining({ provider: model?.provider, id: model?.id }))
      expect(options).toMatchObject({
        sessionAgentId: sessionAgent.agentId,
        sessionLabel: 'Release Notes',
        displayName: 'Release Notes',
        profileId: 'manager',
        sessionCwd: expect.stringContaining('swarm-manager-test-'),
      })
      expect(options.currentSystemPrompt).toContain('Every user-facing message MUST go through `speak_to_user`.')
      expect(options.currentSystemPrompt).not.toContain('old release-notes override prompt')
    } finally {
      if (previousAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey
      }
    }
  })

  it('loads SWARM.md context files from the cwd ancestor chain', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    const rootSwarmPath = join(config.paths.rootDir, 'SWARM.md')
    const nestedDir = join(config.paths.rootDir, 'nested', 'deeper')
    const nestedSwarmPath = join(config.paths.rootDir, 'nested', 'SWARM.md')

    await mkdir(nestedDir, { recursive: true })
    await writeFile(rootSwarmPath, '# root swarm policy\n', 'utf8')
    await writeFile(nestedSwarmPath, '# nested swarm policy\n', 'utf8')

    const files = await manager.getSwarmContextFilesForTest(nestedDir)

    expect(files).toEqual([
      {
        path: rootSwarmPath,
        content: '# root swarm policy\n',
      },
      {
        path: nestedSwarmPath,
        content: '# nested swarm policy\n',
      },
    ])
  })

  it('returns no SWARM.md context files when none are present', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    const files = await manager.getSwarmContextFilesForTest(config.paths.rootDir)

    expect(files).toEqual([])
  })

  it('uses manager and default worker prompts with explicit visibility guidance', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const managerPrompt = manager.systemPromptByAgentId.get('manager')
    const managerMemoryPath = getRootSessionMemoryPath(config.paths.dataDir, 'manager')
    expect(managerPrompt).toContain('You are the manager agent in a multi-agent swarm.')
    expect(managerPrompt).toContain('Every user-facing message MUST go through `speak_to_user`.')
    expect(managerPrompt).toContain('End users only see:')
    expect(managerPrompt).toContain('Non-user/internal inbound messages may be prefixed with `SYSTEM:`.')
    expect(managerPrompt).toContain('Project agents in this profile — none configured.')
    expect(managerPrompt).toContain('Workers do not receive this directory.')
    expect(managerPrompt).toContain('[projectAgentContext] { ... }')
    expect(managerPrompt).toContain(managerMemoryPath)

    const worker = await manager.spawnAgent('manager', { agentId: 'Prompt Worker' })
    const workerPrompt = manager.systemPromptByAgentId.get(worker.agentId)

    expect(workerPrompt).toBeDefined()
    expect(workerPrompt).toContain('End users only see messages they send and manager speak_to_user outputs.')
    expect(workerPrompt).toContain('Incoming messages prefixed with "SYSTEM:"')
    // eslint-disable-next-line no-template-curly-in-string
    expect(workerPrompt).toContain('Persistent memory for this runtime is at ${SWARM_MEMORY_FILE}')
    expect(workerPrompt).toContain('Workers read their owning manager\'s memory file.')
    expect(workerPrompt).toContain('Follow the memory skill workflow before editing the memory file')
  })

    it('auto-loads per-runtime memory context and wires built-in memory + brave-search + cron-scheduling + agent-browser + image-generation + slash-commands + chrome-cdp + create-skill skills', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const persistedMemory = '# Swarm Memory\n\n## Project Facts\n- release train: friday\n'
    const rootSessionMemoryPath = getRootSessionMemoryPath(config.paths.dataDir, 'manager')
    await writeFile(config.paths.memoryFile!, persistedMemory, 'utf8')

    const resources = await manager.getMemoryRuntimeResourcesForTest()
    expect(resources.memoryContextFile.path).toBe(rootSessionMemoryPath)
    expect(resources.memoryContextFile.content).toContain(persistedMemory.trim())
    expect(resources.memoryContextFile.content).toContain('# Common Knowledge (maintained by Cortex — read-only reference)')
    expect(resources.additionalSkillPaths.length).toBeGreaterThanOrEqual(8)

    const memorySkillPath = resources.additionalSkillPaths.find((path) => path.endsWith(join('memory', 'SKILL.md')))
    expect(memorySkillPath).toBeDefined()
    const memorySkill = await readFile(memorySkillPath!, 'utf8')
    expect(memorySkill).toContain('name: memory')
    // eslint-disable-next-line no-template-curly-in-string
    expect(memorySkill).toContain('${SWARM_MEMORY_FILE}')

    const braveSkillPath = resources.additionalSkillPaths.find((path) => path.endsWith(join('brave-search', 'SKILL.md')))
    expect(braveSkillPath).toBeDefined()
    const braveSkill = await readFile(braveSkillPath!, 'utf8')
    expect(braveSkill).toContain('name: brave-search')
    expect(braveSkill).toContain('BRAVE_API_KEY')

    const cronSkillPath = resources.additionalSkillPaths.find((path) => path.endsWith(join('cron-scheduling', 'SKILL.md')))
    expect(cronSkillPath).toBeDefined()
    const cronSkill = await readFile(cronSkillPath!, 'utf8')
    expect(cronSkill).toContain('name: cron-scheduling')
    expect(cronSkill).toContain('schedule.js add')

    const agentBrowserSkillPath = resources.additionalSkillPaths.find((path) => path.endsWith(join('agent-browser', 'SKILL.md')))
    expect(agentBrowserSkillPath).toBeDefined()
    const agentBrowserSkill = await readFile(agentBrowserSkillPath!, 'utf8')
    expect(agentBrowserSkill).toContain('name: agent-browser')
    expect(agentBrowserSkill).toContain('agent-browser snapshot -i --json')

    const imageGenerationSkillPath = resources.additionalSkillPaths.find((path) => path.endsWith(join('image-generation', 'SKILL.md')))
    expect(imageGenerationSkillPath).toBeDefined()
    const imageGenerationSkill = await readFile(imageGenerationSkillPath!, 'utf8')
    expect(imageGenerationSkill).toContain('name: image-generation')
    expect(imageGenerationSkill).toContain('GEMINI_API_KEY')

    const slashCommandsSkillPath = resources.additionalSkillPaths.find((path) => path.endsWith(join('slash-commands', 'SKILL.md')))
    expect(slashCommandsSkillPath).toBeDefined()
    const slashCommandsSkill = await readFile(slashCommandsSkillPath!, 'utf8')
    expect(slashCommandsSkill).toContain('name: slash-commands')
    expect(slashCommandsSkill).toContain('slash-commands.js create')

    const chromeCdpSkillPath = resources.additionalSkillPaths.find((path) => path.endsWith(join('chrome-cdp', 'SKILL.md')))
    expect(chromeCdpSkillPath).toBeDefined()
    const chromeCdpSkill = await readFile(chromeCdpSkillPath!, 'utf8')
    expect(chromeCdpSkill).toContain('name: chrome-cdp')
    expect(chromeCdpSkill).toContain('scripts/cdp.mjs')

    const createSkillPath = resources.additionalSkillPaths.find((path) => path.endsWith(join('create-skill', 'SKILL.md')))
    expect(createSkillPath).toBeDefined()
    const createSkill = await readFile(createSkillPath!, 'utf8')
    expect(createSkill).toContain('name: create-skill')
    expect(createSkill).toContain('scripts/scaffold-skill.mjs')
    // eslint-disable-next-line no-template-curly-in-string
    expect(createSkill).toContain('${SWARM_DATA_DIR}/skills/<name>')
  })

  it('lists only profile-scoped skill metadata when a profile is selected', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await manager.boot()

    const profileId = 'profile-a'
    const profileSkillsDir = getProfilePiSkillsDir(config.paths.dataDir, profileId)
    await mkdir(join(profileSkillsDir, 'custom-profile-skill'), { recursive: true })
    await writeFile(
      join(profileSkillsDir, 'custom-profile-skill', 'SKILL.md'),
      [
        '---',
        'name: custom-profile-skill',
        'description: Profile-only custom skill',
        'env:',
        '  - name: PROFILE_ONLY_API_KEY',
        '    description: Profile-only API key',
        '---',
        '',
        '# Custom profile skill',
      ].join('\n'),
      'utf8',
    )

    const profileSkills = await manager.listSkillMetadata(profileId)
    const customSkill = profileSkills.find((skill) => skill.directoryName === 'custom-profile-skill')

    expect(profileSkills).toHaveLength(1)
    expect(customSkill).toMatchObject({
      name: 'custom-profile-skill',
      directoryName: 'custom-profile-skill',
      description: 'Profile-only custom skill',
      envCount: 1,
      hasRichConfig: false,
      sourceKind: 'profile',
      profileId,
      isInherited: false,
      isEffective: true,
    })
    expect(typeof customSkill?.skillId).toBe('string')
    expect(profileSkills.some((skill) => skill.directoryName === 'memory')).toBe(false)

    const globalSkills = await manager.listSkillMetadata()
    expect(globalSkills.some((skill) => skill.directoryName === 'custom-profile-skill')).toBe(false)
    expect(globalSkills.some((skill) => skill.directoryName === 'memory')).toBe(true)
  })

  it('applies skill precedence profile > machine-local > repo > builtin and collapses duplicate directory names', async () => {
    const config = await makeTempConfig()
    const profileId = 'profile-a'
    const localBraveSkillDir = join(config.paths.dataDir, 'skills', 'brave-search')
    const repoBraveSkillDir = join(config.paths.rootDir, '.swarm', 'skills', 'brave-search')
    const profileBraveSkillDir = join(getProfilePiSkillsDir(config.paths.dataDir, profileId), 'brave-search')

    await mkdir(localBraveSkillDir, { recursive: true })
    await mkdir(repoBraveSkillDir, { recursive: true })
    await mkdir(profileBraveSkillDir, { recursive: true })

    await writeFile(
      join(localBraveSkillDir, 'SKILL.md'),
      [
        '---',
        'name: Brave Search Local',
        'description: Machine-local brave-search workflow.',
        '---',
        '',
        '# Local brave-search override',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      join(repoBraveSkillDir, 'SKILL.md'),
      [
        '---',
        'name: Brave Search Repo',
        'description: Repo brave-search workflow.',
        '---',
        '',
        '# Repo brave-search override',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      join(profileBraveSkillDir, 'SKILL.md'),
      [
        '---',
        'name: Brave Search Profile',
        'description: Profile brave-search workflow.',
        '---',
        '',
        '# Profile brave-search override',
      ].join('\n'),
      'utf8',
    )

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const globalSkills = await manager.listSkillMetadata()
    const globalBraveSkills = globalSkills.filter((skill) => skill.directoryName === 'brave-search')
    expect(globalBraveSkills).toHaveLength(1)
    expect(globalBraveSkills[0]).toMatchObject({
      name: 'Brave Search Local',
      directoryName: 'brave-search',
      description: 'Machine-local brave-search workflow.',
      sourceKind: 'machine-local',
      isInherited: false,
      isEffective: true,
    })

    const profileSkills = await manager.listSkillMetadata(profileId)
    const profileBraveSkills = profileSkills.filter((skill) => skill.directoryName === 'brave-search')
    expect(profileBraveSkills).toHaveLength(1)
    expect(profileBraveSkills[0]).toMatchObject({
      name: 'Brave Search Profile',
      directoryName: 'brave-search',
      description: 'Profile brave-search workflow.',
      sourceKind: 'profile',
      profileId,
      isInherited: false,
      isEffective: true,
    })
  })

  it('rescans skill metadata when a skill moves from machine-local scope into a profile scope', async () => {
    const config = await makeTempConfig()
    const profileId = 'profile-a'
    const localSkillDir = join(config.paths.dataDir, 'skills', 'movable-skill')
    const profileSkillDir = join(getProfilePiSkillsDir(config.paths.dataDir, profileId), 'movable-skill')

    await mkdir(localSkillDir, { recursive: true })
    await writeFile(
      join(localSkillDir, 'SKILL.md'),
      [
        '---',
        'name: Movable Skill Local',
        'description: Machine-local skill before move.',
        '---',
        '',
        '# Movable skill',
      ].join('\n'),
      'utf8',
    )

    const manager = new TestSwarmManager(config)
    await manager.boot()

    expect(await manager.listSkillMetadata()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          directoryName: 'movable-skill',
          name: 'Movable Skill Local',
          sourceKind: 'machine-local',
        }),
      ]),
    )

    await mkdir(profileSkillDir, { recursive: true })
    await writeFile(
      join(profileSkillDir, 'SKILL.md'),
      [
        '---',
        'name: Movable Skill Profile',
        'description: Profile-scoped skill after move.',
        '---',
        '',
        '# Movable skill',
      ].join('\n'),
      'utf8',
    )
    await rm(localSkillDir, { recursive: true, force: true })

    const globalSkills = await manager.listSkillMetadata()
    expect(globalSkills.some((skill) => skill.directoryName === 'movable-skill')).toBe(false)

    const profileSkills = await manager.listSkillMetadata(profileId)
    expect(profileSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          directoryName: 'movable-skill',
          name: 'Movable Skill Profile',
          sourceKind: 'profile',
          profileId,
          isInherited: false,
          isEffective: true,
        }),
      ]),
    )
  })

  it('loads skill env requirements and persists secrets to the settings store', async () => {
    const previousBraveApiKey = process.env.BRAVE_API_KEY
    const previousGeminiApiKey = process.env.GEMINI_API_KEY
    delete process.env.BRAVE_API_KEY
    delete process.env.GEMINI_API_KEY

    try {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await manager.boot()

      const initial = await manager.listSettingsEnv()
      const braveRequirement = initial.find(
        (requirement) => requirement.name === 'BRAVE_API_KEY' && requirement.skillName === 'brave-search',
      )
      const geminiRequirement = initial.find(
        (requirement) => requirement.name === 'GEMINI_API_KEY' && requirement.skillName === 'image-generation',
      )

      expect(braveRequirement).toMatchObject({
        description: 'Brave Search API key',
        required: true,
        helpUrl: 'https://api-dashboard.search.brave.com/register',
        isSet: false,
      })
      expect(geminiRequirement).toMatchObject({
        description: 'Google AI Studio / Gemini API key',
        required: true,
        isSet: false,
      })

      await manager.updateSettingsEnv({ BRAVE_API_KEY: 'bsal-test-value' })

      const secretsRaw = await readFile(config.paths.sharedSecretsFile, 'utf8')
      expect(JSON.parse(secretsRaw)).toEqual({ BRAVE_API_KEY: 'bsal-test-value' })
      expect(process.env.BRAVE_API_KEY).toBe('bsal-test-value')

      const afterUpdate = await manager.listSettingsEnv()
      expect(
        afterUpdate.find(
          (requirement) => requirement.name === 'BRAVE_API_KEY' && requirement.skillName === 'brave-search',
        ),
      ).toMatchObject({
        isSet: true,
        maskedValue: '********',
      })

      await manager.deleteSettingsEnv('BRAVE_API_KEY')

      const afterDelete = await manager.listSettingsEnv()
      expect(
        afterDelete.find(
          (requirement) => requirement.name === 'BRAVE_API_KEY' && requirement.skillName === 'brave-search',
        ),
      ).toMatchObject({
        isSet: false,
      })
      expect(process.env.BRAVE_API_KEY).toBeUndefined()
    } finally {
      if (previousBraveApiKey === undefined) {
        delete process.env.BRAVE_API_KEY
      } else {
        process.env.BRAVE_API_KEY = previousBraveApiKey
      }

      if (previousGeminiApiKey === undefined) {
        delete process.env.GEMINI_API_KEY
      } else {
        process.env.GEMINI_API_KEY = previousGeminiApiKey
      }
    }
  })

  it('restores existing process env values when deleting a secret override', async () => {
    const previousBraveApiKey = process.env.BRAVE_API_KEY
    process.env.BRAVE_API_KEY = 'fallback-value'

    try {
      const config = await makeTempConfig()
      await writeFile(config.paths.secretsFile, JSON.stringify({ BRAVE_API_KEY: 'override-value' }, null, 2), 'utf8')

      const manager = new TestSwarmManager(config)
      await manager.boot()

      expect(process.env.BRAVE_API_KEY).toBe('override-value')

      await manager.deleteSettingsEnv('BRAVE_API_KEY')
      expect(process.env.BRAVE_API_KEY).toBe('fallback-value')
    } finally {
      if (previousBraveApiKey === undefined) {
        delete process.env.BRAVE_API_KEY
      } else {
        process.env.BRAVE_API_KEY = previousBraveApiKey
      }
    }
  })

  it('prefers repo memory skill override when present', async () => {
    const config = await makeTempConfig()
    await mkdir(join(config.paths.rootDir, '.swarm', 'skills', 'memory'), { recursive: true })
    await writeFile(
      config.paths.repoMemorySkillFile,
      ['---', 'name: memory', 'description: Repo override memory workflow.', '---', '', '# Repo memory override', ''].join('\n'),
      'utf8',
    )

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const resources = await manager.getMemoryRuntimeResourcesForTest()
    expect(resources.additionalSkillPaths.length).toBeGreaterThanOrEqual(7)
    expect(resources.additionalSkillPaths).toContain(config.paths.repoMemorySkillFile)
    expect(resources.additionalSkillPaths.some((path) => path.endsWith(join('brave-search', 'SKILL.md')))).toBe(true)
    expect(resources.additionalSkillPaths.some((path) => path.endsWith(join('cron-scheduling', 'SKILL.md')))).toBe(true)
    expect(resources.additionalSkillPaths.some((path) => path.endsWith(join('agent-browser', 'SKILL.md')))).toBe(true)
    expect(resources.additionalSkillPaths.some((path) => path.endsWith(join('image-generation', 'SKILL.md')))).toBe(true)
    expect(resources.additionalSkillPaths.some((path) => path.endsWith(join('slash-commands', 'SKILL.md')))).toBe(true)
    expect(resources.additionalSkillPaths.some((path) => path.endsWith(join('chrome-cdp', 'SKILL.md')))).toBe(true)
  })

  it('prefers repo brave-search skill override when present', async () => {
    const config = await makeTempConfig()
    const repoBraveSkillFile = join(config.paths.rootDir, '.swarm', 'skills', 'brave-search', 'SKILL.md')

    await mkdir(join(config.paths.rootDir, '.swarm', 'skills', 'brave-search'), { recursive: true })
    await writeFile(
      repoBraveSkillFile,
      [
        '---',
        'name: brave-search',
        'description: Repo override brave-search workflow.',
        '---',
        '',
        '# Repo brave-search override',
        '',
      ].join('\n'),
      'utf8',
    )

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const resources = await manager.getMemoryRuntimeResourcesForTest()
    expect(resources.additionalSkillPaths.length).toBeGreaterThanOrEqual(7)
    expect(resources.additionalSkillPaths.some((path) => path.endsWith(join('memory', 'SKILL.md')))).toBe(true)
    expect(resources.additionalSkillPaths).toContain(repoBraveSkillFile)
    expect(resources.additionalSkillPaths.some((path) => path.endsWith(join('cron-scheduling', 'SKILL.md')))).toBe(true)
    expect(resources.additionalSkillPaths.some((path) => path.endsWith(join('agent-browser', 'SKILL.md')))).toBe(true)
    expect(resources.additionalSkillPaths.some((path) => path.endsWith(join('image-generation', 'SKILL.md')))).toBe(true)
    expect(resources.additionalSkillPaths.some((path) => path.endsWith(join('slash-commands', 'SKILL.md')))).toBe(true)
    expect(resources.additionalSkillPaths.some((path) => path.endsWith(join('chrome-cdp', 'SKILL.md')))).toBe(true)
  })

  it('prefers machine-local data-dir skill overrides over repo skills', async () => {
    const config = await makeTempConfig()
    const localBraveSkillFile = join(config.paths.dataDir, 'skills', 'brave-search', 'SKILL.md')
    const repoBraveSkillFile = join(config.paths.rootDir, '.swarm', 'skills', 'brave-search', 'SKILL.md')

    await mkdir(join(config.paths.dataDir, 'skills', 'brave-search'), { recursive: true })
    await mkdir(join(config.paths.rootDir, '.swarm', 'skills', 'brave-search'), { recursive: true })
    await writeFile(
      localBraveSkillFile,
      [
        '---',
        'name: brave-search',
        'description: Machine-local brave-search workflow.',
        '---',
        '',
        '# Local brave-search override',
        '',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      repoBraveSkillFile,
      [
        '---',
        'name: brave-search',
        'description: Repo brave-search workflow.',
        '---',
        '',
        '# Repo brave-search override',
        '',
      ].join('\n'),
      'utf8',
    )

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const resources = await manager.getMemoryRuntimeResourcesForTest()
    expect(resources.additionalSkillPaths).toContain(localBraveSkillFile)
    expect(resources.additionalSkillPaths).not.toContain(repoBraveSkillFile)
  })

  it('injects GPT-5 model-specific instructions into the default manager prompt', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const prompt = manager.systemPromptByAgentId.get('manager')

    expect(prompt).toContain('# Model-Specific Instructions')
    expect(prompt).toContain('Return the requested sections only, in the requested order.')
    expect(prompt).toContain('Do not use em dashes unless the user explicitly asks for them')
  })

  it('injects Claude model-specific instructions for pi-opus managers', async () => {
    const config = await makeTempConfig()
    config.defaultModel = {
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    }

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const prompt = manager.systemPromptByAgentId.get('manager')

    expect(prompt).toContain('# Model-Specific Instructions')
    expect(prompt).toContain('Prefer concise, direct answers over essay-style framing.')
    expect(prompt).toContain('When evidence is sufficient, state the conclusion plainly instead of over-hedging.')
  })

  it('omits model-specific instructions when the manager model has no built-in default', async () => {
    const config = await makeTempConfig()
    config.defaultModel = {
      provider: 'xai',
      modelId: 'grok-4',
      thinkingLevel: 'high',
    }

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const prompt = manager.systemPromptByAgentId.get('manager')

    expect(prompt).not.toContain('# Model-Specific Instructions')
    expect(prompt).not.toContain('Return the requested sections only, in the requested order.')
    expect(prompt).not.toContain('Prefer concise, direct answers over essay-style framing.')
  })

  it('does not inject model-specific instructions when a custom manager prompt omits the placeholder', async () => {
    const config = await makeTempConfig()
    await writeFile(
      join(config.paths.repoArchetypesDir, 'manager.md'),
      'You are the repo manager override.\n\n${SPECIALIST_ROSTER}\n', // eslint-disable-line no-template-curly-in-string
      'utf8',
    )

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const prompt = manager.systemPromptByAgentId.get('manager')

    expect(prompt).toContain('You are the repo manager override.')
    expect(prompt).not.toContain('# Model-Specific Instructions')
    expect(prompt).not.toContain('Return the requested sections only, in the requested order.')
  })

  it('uses merger archetype prompt for merger workers', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const merger = await manager.spawnAgent('manager', {
      agentId: 'Release Merger',
      archetypeId: 'merger',
    })

    const mergerPrompt = manager.systemPromptByAgentId.get(merger.agentId)
    expect(mergerPrompt).toContain('You are the merger agent in a multi-agent swarm.')
    expect(mergerPrompt).toContain('Own branch integration and merge execution tasks.')
    // eslint-disable-next-line no-template-curly-in-string
    expect(mergerPrompt).toContain('This runtime memory file is `${SWARM_MEMORY_FILE}`')
  })

  it('applies deterministic merger archetype mapping for merger-* worker ids', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const merger = await manager.spawnAgent('manager', { agentId: 'Merger Agent' })

    const mergerPrompt = manager.systemPromptByAgentId.get(merger.agentId)
    expect(merger.agentId).toBe('merger-agent')
    expect(mergerPrompt).toContain('You are the merger agent in a multi-agent swarm.')
  })
})
