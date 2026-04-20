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
  it('auto-creates a singleton cortex manager on boot when the store is empty', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await manager.boot()

    const agents = manager.listAgents()
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      agentId: 'cortex',
      role: 'manager',
      archetypeId: 'cortex',
      profileId: 'cortex',
    })
    expect(manager.createdRuntimeIds).toEqual([])
    expect(manager.runtimeByAgentId.size).toBe(0)
  })

  it('prunes persisted Cortex state on boot when Cortex is disabled', async () => {
    const config = await makeTempConfig()
    config.cortexEnabled = false

    await writeFile(
      config.paths.agentsStoreFile,
      `${JSON.stringify({
        agents: [
          {
            agentId: 'cortex',
            displayName: 'Cortex',
            role: 'manager',
            managerId: 'cortex',
            profileId: 'cortex',
            archetypeId: 'cortex',
            status: 'idle',
            createdAt: '2026-03-27T00:00:00.000Z',
            updatedAt: '2026-03-27T00:00:00.000Z',
            cwd: config.defaultCwd,
            model: config.defaultModel,
            sessionFile: join(config.paths.sessionsDir, 'cortex.jsonl'),
          },
          {
            agentId: 'cortex--review',
            displayName: 'Review Run',
            role: 'manager',
            managerId: 'cortex--review',
            profileId: 'cortex',
            archetypeId: 'cortex',
            sessionPurpose: 'cortex_review',
            status: 'streaming',
            createdAt: '2026-03-27T00:01:00.000Z',
            updatedAt: '2026-03-27T00:01:00.000Z',
            cwd: config.defaultCwd,
            model: config.defaultModel,
            sessionFile: join(config.paths.sessionsDir, 'cortex--review.jsonl'),
          },
          {
            agentId: 'cortex--worker',
            displayName: 'Cortex Worker',
            role: 'worker',
            managerId: 'cortex--review',
            profileId: 'cortex',
            status: 'streaming',
            createdAt: '2026-03-27T00:02:00.000Z',
            updatedAt: '2026-03-27T00:02:00.000Z',
            cwd: config.defaultCwd,
            model: config.defaultModel,
            sessionFile: join(config.paths.sessionsDir, 'cortex--worker.jsonl'),
          },
          {
            agentId: 'manager',
            displayName: 'Manager',
            role: 'manager',
            managerId: 'manager',
            profileId: 'manager',
            archetypeId: 'manager',
            status: 'idle',
            createdAt: '2026-03-27T00:03:00.000Z',
            updatedAt: '2026-03-27T00:03:00.000Z',
            cwd: config.defaultCwd,
            model: config.defaultModel,
            sessionFile: join(config.paths.sessionsDir, 'manager.jsonl'),
          },
        ],
        profiles: [
          {
            profileId: 'cortex',
            displayName: 'Cortex',
            defaultSessionAgentId: 'cortex',
            createdAt: '2026-03-27T00:00:00.000Z',
            updatedAt: '2026-03-27T00:00:00.000Z',
          },
          {
            profileId: 'manager',
            displayName: 'Manager',
            defaultSessionAgentId: 'manager',
            createdAt: '2026-03-27T00:03:00.000Z',
            updatedAt: '2026-03-27T00:03:00.000Z',
          },
        ],
      }, null, 2)}\n`,
      'utf8',
    )

    const manager = new TestSwarmManager(config)
    await manager.boot()

    expect(manager.listAgents().map((descriptor) => descriptor.agentId)).toEqual(['manager'])
    expect(manager.listProfiles().map((profile) => profile.profileId)).toEqual(['manager'])
    await expect(readFile(getCommonKnowledgePath(config.paths.dataDir), 'utf8')).resolves.toContain('# Common Knowledge')

    const persistedStore = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
      agents: Array<{ agentId: string; profileId?: string; sessionPurpose?: string }>
      profiles: Array<{ profileId: string }>
    }
    expect(persistedStore.agents).toEqual([
      expect.objectContaining({ agentId: 'manager', profileId: 'manager' }),
    ])
    expect(persistedStore.profiles).toEqual([
      expect.objectContaining({ profileId: 'manager' }),
    ])
  })

  it('does not materialize manager SYSTEM.md into the data dir on boot', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await manager.boot()

    await expect(readFile(join(config.paths.managerAgentDir, 'SYSTEM.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('bootstraps common Cortex knowledge file when missing', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await manager.boot()

    const commonKnowledge = await readFile(getCommonKnowledgePath(config.paths.dataDir), 'utf8')
    expect(commonKnowledge).toContain('# Common Knowledge')
    expect(commonKnowledge).toContain('Maintained by Cortex')
    const reviewLog = await readFile(getCortexReviewLogPath(config.paths.dataDir), 'utf8')
    expect(reviewLog).toBe('')

    const promotionManifestsDir = getCortexPromotionManifestsDir(config.paths.dataDir)
    await expect(stat(promotionManifestsDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) })
  })

  it('upgrades legacy auto-seeded Cortex worker prompts to the current version on boot', async () => {
    const config = await makeTempConfig()
    const workerPromptsPath = getCortexWorkerPromptsPath(config.paths.dataDir)
    await mkdir(dirname(workerPromptsPath), { recursive: true })
    await writeFile(
      workerPromptsPath,
      [
        '# Cortex Worker Prompt Templates',
        '',
        '## 1. Session Review / Extraction Worker',
        'Read the session file at \\`{{SESSION_JSONL_PATH}}\\` starting from byte offset {{BYTE_OFFSET}}',
        'Return your findings as a structured list.',
        'Workers report back via \\`worker_message\\`.',
        '',
      ].join('\n'),
      'utf8',
    )

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const upgraded = await readFile(workerPromptsPath, 'utf8')
    const backup = await readFile(`${workerPromptsPath}.v1.bak`, 'utf8')

    expect(upgraded).toContain('<!-- Cortex Worker Prompts Version: 4 -->')
    expect(upgraded).toContain('STATUS: DONE | FAILED')
    expect(upgraded).toContain('line-based, NOT byte-based')
    expect(upgraded).toContain('## Promotion Discipline (all templates)')
    expect(backup).toContain('Return your findings as a structured list.')
  })

  it('upgrades v2 Cortex worker prompts to v4 on boot and keeps a v2 backup', async () => {
    const config = await makeTempConfig()
    const workerPromptsPath = getCortexWorkerPromptsPath(config.paths.dataDir)
    await mkdir(dirname(workerPromptsPath), { recursive: true })
    await writeFile(
      workerPromptsPath,
      [
        '# Cortex Worker Prompt Templates — v2',
        '<!-- Cortex Worker Prompts Version: 2 -->',
        '',
        '## Callback Format (all templates)',
        'STATUS: DONE | FAILED',
        '',
      ].join('\n'),
      'utf8',
    )

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const upgraded = await readFile(workerPromptsPath, 'utf8')
    const backup = await readFile(`${workerPromptsPath}.v2.bak`, 'utf8')

    expect(upgraded).toContain('<!-- Cortex Worker Prompts Version: 4 -->')
    expect(upgraded).toContain('## Required Finding Schema (all extraction templates)')
    expect(upgraded).toContain('proposed_outcome')
    expect(upgraded).toContain('Concise completion summary')
    expect(backup).toContain('<!-- Cortex Worker Prompts Version: 2 -->')
  })

  it('materializes descriptor-backed project-agent storage on boot and stays idempotent across reboots', async () => {
    const config = await makeTempConfig()
    const firstBoot = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const created = await firstBoot.createSession('manager', { label: 'Release Notes' })
    await firstBoot.setSessionProjectAgent(created.sessionAgent.agentId, {
      whenToUse: 'Draft release notes and changelog copy.',
      systemPrompt: 'You are the release notes project agent.',
    })

    const agentId = created.sessionAgent.agentId
    const configPath = getProjectAgentConfigPath(config.paths.dataDir, 'manager', 'release-notes')
    const promptPath = getProjectAgentPromptPath(config.paths.dataDir, 'manager', 'release-notes')

    await rm(getProjectAgentDir(config.paths.dataDir, 'manager', 'release-notes'), { recursive: true, force: true })
    await expect(stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' })

    const secondBoot = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      agentId,
      handle: 'release-notes',
      whenToUse: 'Draft release notes and changelog copy.',
      version: 1,
    })
    expect(await readFile(promptPath, 'utf8')).toBe('You are the release notes project agent.')
    expect(secondBoot.getAgent(agentId)?.projectAgent?.systemPrompt).toBeUndefined()

    const storeAfterSecondBoot = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
      agents: AgentDescriptor[]
    }
    expect(storeAfterSecondBoot.agents.find((agent) => agent.agentId === agentId)?.projectAgent).toEqual({
      handle: 'release-notes',
      whenToUse: 'Draft release notes and changelog copy.',
      systemPrompt: 'You are the release notes project agent.',
    })

    const thirdBoot = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(thirdBoot, config)

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      agentId,
      handle: 'release-notes',
      whenToUse: 'Draft release notes and changelog copy.',
      version: 1,
    })
    expect(await readFile(promptPath, 'utf8')).toBe('You are the release notes project agent.')
    expect(thirdBoot.getAgent(agentId)?.projectAgent?.systemPrompt).toBeUndefined()
  })

  it('hydrates stale descriptor mirrors from on-disk project-agent files on boot for downgrade safety', async () => {
    const config = await makeTempConfig()
    const firstBoot = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const created = await firstBoot.createSession('manager', { label: 'Release Notes' })
    await firstBoot.setSessionProjectAgent(created.sessionAgent.agentId, {
      whenToUse: 'Legacy descriptor when-to-use.',
      systemPrompt: 'Legacy descriptor prompt.',
    })

    const agentId = created.sessionAgent.agentId
    const promotedAt = created.sessionAgent.createdAt
    const configPath = getProjectAgentConfigPath(config.paths.dataDir, 'manager', 'release-notes')
    const promptPath = getProjectAgentPromptPath(config.paths.dataDir, 'manager', 'release-notes')

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agentId,
          handle: 'release-notes',
          whenToUse: 'Disk-backed release coordination.',
          promotedAt,
          updatedAt: '2026-04-03T12:34:56.000Z',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    await writeFile(promptPath, 'Disk-backed project-agent prompt.', 'utf8')

    const storeBeforeReboot = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as { agents: AgentDescriptor[] }
    await writeFile(
      config.paths.agentsStoreFile,
      `${JSON.stringify(
        {
          ...storeBeforeReboot,
          agents: storeBeforeReboot.agents.map((agent) =>
            agent.agentId === agentId
              ? {
                  ...agent,
                  projectAgent: {
                    handle: 'release-notes',
                    whenToUse: 'Descriptor is stale and missing prompt mirror.',
                  },
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

    const secondBootState = secondBoot as unknown as { descriptors: Map<string, AgentDescriptor> }
    expect(secondBootState.descriptors.get(agentId)?.projectAgent).toEqual({
      handle: 'release-notes',
      whenToUse: 'Disk-backed release coordination.',
      systemPrompt: 'Disk-backed project-agent prompt.',
    })
    expect(secondBoot.getAgent(agentId)?.projectAgent?.systemPrompt).toBeUndefined()

    const storeAfterReboot = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as { agents: AgentDescriptor[] }
    expect(storeAfterReboot.agents.find((agent) => agent.agentId === agentId)?.projectAgent).toEqual({
      handle: 'release-notes',
      whenToUse: 'Disk-backed release coordination.',
      systemPrompt: 'Disk-backed project-agent prompt.',
    })
  })

  it('createAndPromoteProjectAgent creates a promoted session with the custom prompt on first boot', async () => {
    const config = await makeTempConfig()
    const manager = new ProjectAgentAwareSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const creator = await manager.createSession('manager', {
      label: 'Agent Creator',
      sessionPurpose: 'agent_creator',
    })

    const result = await manager.createAndPromoteProjectAgent(creator.sessionAgent.agentId, {
      sessionName: 'Release Notes',
      whenToUse: '  Draft release notes\n\nand   changelog copy.  ',
      systemPrompt: '  You are the release notes project agent.  ',
    })

    expect(result).toEqual({
      agentId: expect.any(String),
      handle: 'release-notes',
      profileId: 'manager',
    })
    // Cloned output (getAgent) omits systemPrompt — it's fetched via get_project_agent_config
    expect(manager.getAgent(result.agentId)?.projectAgent).toEqual({
      handle: 'release-notes',
      whenToUse: 'Draft release notes and changelog copy.',
      creatorSessionId: creator.sessionAgent.agentId,
    })
    expect(manager.getAgent(result.agentId)?.projectAgent?.systemPrompt).toBeUndefined()
    expect(manager.listAgents().find((agent) => agent.agentId === result.agentId)?.projectAgent?.systemPrompt).toBeUndefined()
    // Internal descriptor retains systemPrompt for agents.json persistence / downgrade safety
    const managerState = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    expect(managerState.descriptors.get(result.agentId)?.projectAgent).toEqual({
      handle: 'release-notes',
      whenToUse: 'Draft release notes and changelog copy.',
      systemPrompt: 'You are the release notes project agent.',
      creatorSessionId: creator.sessionAgent.agentId,
    })
    expect(manager.systemPromptByAgentId.get(result.agentId)).toContain('You are the release notes project agent.')
    expect(manager.notifiedProjectAgentProfileIds).toEqual(['manager'])

    // agents.json still has systemPrompt for Electron downgrade safety
    const store = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as { agents: AgentDescriptor[] }
    expect(store.agents.find((agent) => agent.agentId === result.agentId)?.projectAgent).toEqual({
      handle: 'release-notes',
      whenToUse: 'Draft release notes and changelog copy.',
      systemPrompt: 'You are the release notes project agent.',
      creatorSessionId: creator.sessionAgent.agentId,
    })
    expect(
      JSON.parse(await readFile(getProjectAgentConfigPath(config.paths.dataDir, 'manager', 'release-notes'), 'utf8')),
    ).toMatchObject({
      agentId: result.agentId,
      handle: 'release-notes',
      whenToUse: 'Draft release notes and changelog copy.',
      creatorSessionId: creator.sessionAgent.agentId,
      version: 1,
    })
    expect(await readFile(getProjectAgentPromptPath(config.paths.dataDir, 'manager', 'release-notes'), 'utf8')).toBe(
      'You are the release notes project agent.',
    )
  })

  it('uses repo manager archetype overrides on boot', async () => {
    const config = await makeTempConfig()
    const managerOverride = 'You are the repo manager override.'
    await writeFile(join(config.paths.repoArchetypesDir, 'manager.md'), `${managerOverride}\n`, 'utf8')

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    expect(manager.systemPromptByAgentId.get('manager')).toContain(managerOverride)
  })

  it('restores merger archetype workers with merger prompts on restart', async () => {
    const config = await makeTempConfig()

    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const merger = await firstBoot.spawnAgent('manager', {
      agentId: 'Merger',
      archetypeId: 'merger',
    })

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    expect(secondBoot.systemPromptByAgentId.get(merger.agentId)).toBeUndefined()
    await secondBoot.sendMessage('manager', merger.agentId, 'resume merge')

    expect(secondBoot.systemPromptByAgentId.get(merger.agentId)).toContain(
      'You are the merger agent in a multi-agent swarm.',
    )
  })

  it('reconstructs persisted Cortex review runs after restart, including closeout text', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await firstBoot.boot()

    const run = expectStartedReviewRun(await firstBoot.startCortexReviewRun({
      scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory'] },
      trigger: 'manual',
      sourceContext: { channel: 'web' },
    }))

    expect(run.sessionAgentId).toMatch(/^cortex--s\d+$/)

    const reviewSession = firstBoot.getAgent(run.sessionAgentId!)
    expect(reviewSession?.sessionPurpose).toBe('cortex_review')
    expect(reviewSession).toBeDefined()

    appendSessionConversationMessage(
      reviewSession!.sessionFile,
      reviewSession!.agentId,
      'reviewed profile/session, changed files: NONE',
    )

    const secondBoot = new TestSwarmManager(config)
    await secondBoot.boot()

    const persistedRuns = await secondBoot.listCortexReviewRuns()
    expect(persistedRuns).toHaveLength(1)
    expect(persistedRuns[0]).toMatchObject({
      runId: run.runId,
      sessionAgentId: run.sessionAgentId,
      status: 'completed',
      latestCloseout: 'reviewed profile/session, changed files: NONE',
      scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory'] },
    })

    expect(secondBoot.getAgent(run.sessionAgentId!)?.sessionPurpose).toBe('cortex_review')
  })

  it('reconciles interrupted Cortex review runs on boot and requeues them as fresh entries', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await firstBoot.boot()

    const run = expectStartedReviewRun(await firstBoot.startCortexReviewRun({
      scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory'] },
      trigger: 'manual',
      sourceContext: { channel: 'web' },
    }))

    expect(run.sessionAgentId).toMatch(/^cortex--s\d+$/)

    const firstBootState = firstBoot as unknown as {
      descriptors: Map<string, AgentDescriptor>
      saveStore: () => Promise<void>
    }
    const persistedReviewSession = firstBootState.descriptors.get(run.sessionAgentId!)
    expect(persistedReviewSession).toBeDefined()
    persistedReviewSession!.status = 'streaming'
    firstBootState.descriptors.set(run.sessionAgentId!, persistedReviewSession!)
    await firstBootState.saveStore()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const secondBoot = new TestSwarmManager(config)
      await secondBoot.boot()

      await waitForCondition(async () => {
        const runs = await secondBoot.listCortexReviewRuns()
        return runs.some(
          (entry) =>
            entry.runId !== run.runId &&
            entry.scope.mode === 'session' &&
            entry.scope.profileId === 'alpha' &&
            entry.scope.sessionId === 'alpha--s1' &&
            entry.sessionAgentId !== null,
        )
      })

      const persistedRuns = await secondBoot.listCortexReviewRuns()
      const interruptedRun = persistedRuns.find((entry) => entry.runId === run.runId)
      const resumedRun = persistedRuns.find(
        (entry) =>
          entry.runId !== run.runId &&
          entry.scope.mode === 'session' &&
          entry.scope.profileId === 'alpha' &&
          entry.scope.sessionId === 'alpha--s1',
      )

      expect(interruptedRun).toMatchObject({
        runId: run.runId,
        sessionAgentId: run.sessionAgentId,
        status: 'interrupted',
        interruptionReason: 'Interrupted by backend restart; request requeued automatically.',
        scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory'] },
      })
      expect(resumedRun).toMatchObject({
        trigger: 'manual',
        status: 'completed',
        requestText: 'Review session alpha/alpha--s1 (memory freshness)',
        scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory'] },
      })
      expect(resumedRun?.runId).not.toBe(run.runId)
      expect(resumedRun?.sessionAgentId).toMatch(/^cortex--s\d+$/)
      expect(resumedRun?.sessionAgentId).not.toBe(run.sessionAgentId)

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('cortex:review_runs:reconciled_interrupted'),
        expect.objectContaining({ count: 1 }),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})
