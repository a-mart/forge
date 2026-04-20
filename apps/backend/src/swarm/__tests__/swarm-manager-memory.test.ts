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
  it('bootstraps profile memory and root-session working memory when missing', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await bootWithDefaultManager(manager, config)

    const profileMemory = await readFile(config.paths.memoryFile!, 'utf8')
    const rootSessionMemory = await readFile(getRootSessionMemoryPath(config.paths.dataDir, 'manager'), 'utf8')

    expect(profileMemory).toContain('# Swarm Memory')
    expect(profileMemory).toContain('## User Preferences')
    expect(rootSessionMemory).toContain('# Swarm Memory')
    expect(rootSessionMemory).toContain('## User Preferences')
  })

  it('preserves existing profile memory content across restart and keeps it in root runtime context', async () => {
    const config = await makeTempConfig()

    const firstBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(firstBoot, config)

    const persistedMemory = '# Swarm Memory\n\n## Project Facts\n- remember me\n'
    await writeFile(config.paths.memoryFile!, persistedMemory, 'utf8')

    const secondBoot = new TestSwarmManager(config)
    await bootWithDefaultManager(secondBoot, config)

    const profileMemory = await readFile(config.paths.memoryFile!, 'utf8')
    expect(profileMemory).toBe(persistedMemory)

    const resources = await secondBoot.getMemoryRuntimeResourcesForTest()
    expect(resources.memoryContextFile.path).toBe(getRootSessionMemoryPath(config.paths.dataDir, 'manager'))
    expect(resources.memoryContextFile.content).toContain(persistedMemory.trim())
    expect(resources.memoryContextFile.content).toContain('# Common Knowledge (maintained by Cortex — read-only reference)')
  })

  it('buildSessionMemoryRuntimeView composes read-only profile memory above writable session memory', () => {
    const combined = buildSessionMemoryRuntimeView(
      '# Swarm Memory\n\n## Decisions\n- profile fact\n',
      '# Swarm Memory\n\n## Open Follow-ups\n- session task\n',
    )

    expect(combined).toContain('# Manager Memory (shared across all sessions — read-only reference)')
    expect(combined).toContain('# Session Memory (this session\'s working memory — your writes go here)')
    expect(combined).toContain('\n---\n')
    expect(combined.indexOf('profile fact')).toBeGreaterThan(combined.indexOf('# Manager Memory'))
    expect(combined.indexOf('profile fact')).toBeLessThan(combined.indexOf('# Session Memory'))
    expect(combined.indexOf('session task')).toBeGreaterThan(combined.indexOf('# Session Memory'))
  })

  it('getMemoryRuntimeResources composes root-session runtime memory from canonical profile memory plus root working memory', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const rootSessionMemoryPath = getRootSessionMemoryPath(config.paths.dataDir, 'manager')

    await writeFile(config.paths.memoryFile!, '# Swarm Memory\n\n## Decisions\n- canonical profile decision\n', 'utf8')
    await writeFile(rootSessionMemoryPath, '# Swarm Memory\n\n## Decisions\n- root working note\n', 'utf8')

    const resources = await manager.getMemoryRuntimeResourcesForTest('manager')
    const managerHeaderIndex = resources.memoryContextFile.content.indexOf(
      '# Manager Memory (shared across all sessions — read-only reference)',
    )
    const sessionHeaderIndex = resources.memoryContextFile.content.indexOf(
      '# Session Memory (this session\'s working memory — your writes go here)',
    )
    const profileDecisionIndex = resources.memoryContextFile.content.indexOf('canonical profile decision')
    const rootWorkingIndex = resources.memoryContextFile.content.indexOf('root working note')

    expect(resources.memoryContextFile.path).toBe(rootSessionMemoryPath)
    expect(managerHeaderIndex).toBeGreaterThanOrEqual(0)
    expect(sessionHeaderIndex).toBeGreaterThan(managerHeaderIndex)
    expect(profileDecisionIndex).toBeGreaterThan(managerHeaderIndex)
    expect(profileDecisionIndex).toBeLessThan(sessionHeaderIndex)
    expect(rootWorkingIndex).toBeGreaterThan(sessionHeaderIndex)
    expect(resources.memoryContextFile.content.match(/canonical profile decision/g)).toHaveLength(1)
    expect(resources.memoryContextFile.content.match(/root working note/g)).toHaveLength(1)
  })

  it('injects shared common knowledge into runtime memory resources', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await writeFile(config.paths.memoryFile!, '# Swarm Memory\n\n## Decisions\n- manager-only\n', 'utf8')
    await writeFile(getCommonKnowledgePath(config.paths.dataDir), '# Common Knowledge\n\n## Working Patterns\n- keep PRs small\n', 'utf8')

    const resources = await manager.getMemoryRuntimeResourcesForTest('manager')
    expect(resources.memoryContextFile.content).toContain('manager-only')
    expect(resources.memoryContextFile.content).toContain(
      '# Common Knowledge (maintained by Cortex — read-only reference)',
    )
    expect(resources.memoryContextFile.content).toContain('keep PRs small')
  })

  it('does not inject profile-specific knowledge blobs into runtime memory resources', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await writeFile(config.paths.memoryFile!, '# Swarm Memory\n\n## Decisions\n- manager-only\n', 'utf8')
    await writeFile(getCommonKnowledgePath(config.paths.dataDir), '# Common Knowledge\n\n## Working Patterns\n- shared\n', 'utf8')

    const resources = await manager.getMemoryRuntimeResourcesForTest('manager')
    const content = resources.memoryContextFile.content

    expect(content).toContain('# Common Knowledge (maintained by Cortex — read-only reference)')
    expect(content).not.toContain('# Project Knowledge for manager (maintained by Cortex — read-only reference)')
  })

  it('migrates legacy profile knowledge blobs into profile reference docs on boot', async () => {
    const config = await makeTempConfig()
    const legacyProfileKnowledgePath = getProfileKnowledgePath(config.paths.dataDir, 'manager')

    await mkdir(dirname(legacyProfileKnowledgePath), { recursive: true })
    await writeFile(
      legacyProfileKnowledgePath,
      '# Project Knowledge: manager\n\n## Architecture\n- detailed legacy architecture note\n',
      'utf8',
    )

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const migratedReferencePath = getProfileReferencePath(config.paths.dataDir, 'manager', 'legacy-profile-knowledge.md')
    const migratedReference = await readFile(migratedReferencePath, 'utf8')
    const referenceIndex = await readFile(getProfileReferencePath(config.paths.dataDir, 'manager', 'index.md'), 'utf8')

    expect(migratedReference).toContain('# manager Legacy Profile Knowledge')
    expect(migratedReference).toContain('detailed legacy architecture note')
    expect(referenceIndex).toContain('./legacy-profile-knowledge.md')
  })

  it('does not inject reference docs into runtime memory resources', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await writeFile(config.paths.memoryFile!, '# Swarm Memory\n\n## Decisions\n- manager-only\n', 'utf8')
    await mkdir(dirname(getProfileReferencePath(config.paths.dataDir, 'manager', 'architecture.md')), { recursive: true })
    await writeFile(
      getProfileReferencePath(config.paths.dataDir, 'manager', 'architecture.md'),
      '# manager Architecture\n\n- deep reference detail\n',
      'utf8',
    )

    const resources = await manager.getMemoryRuntimeResourcesForTest('manager')
    const content = resources.memoryContextFile.content

    expect(content).toContain('manager-only')
    expect(content).not.toContain('deep reference detail')
  })

  it('does not migrate legacy global MEMORY.md into manager memory on boot', async () => {
    const config = await makeTempConfig()
    const legacyMemoryFile = join(config.paths.dataDir, 'MEMORY.md')
    const legacyContent = '# Swarm Memory\n\n## Project Facts\n- migrated legacy memory\n'

    await writeFile(legacyMemoryFile, legacyContent, 'utf8')

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const managerMemory = await readFile(config.paths.memoryFile!, 'utf8')
    expect(managerMemory).toContain('# Swarm Memory')
    expect(managerMemory).not.toBe(legacyContent)

    await expect(readFile(join(config.paths.memoryDir, '.migrated'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('workers load their owning root-session working memory plus canonical profile memory', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Memory Worker' })
    const workerMemoryFile = join(config.paths.memoryDir, `${worker.agentId}.md`)
    const rootSessionMemoryPath = getRootSessionMemoryPath(config.paths.dataDir, 'manager')

    await writeFile(config.paths.memoryFile!, '# Swarm Memory\n\n## Decisions\n- canonical profile memory\n', 'utf8')
    await writeFile(rootSessionMemoryPath, '# Swarm Memory\n\n## Decisions\n- manager working memory\n', 'utf8')
    await mkdir(config.paths.memoryDir, { recursive: true })
    await writeFile(workerMemoryFile, '# Swarm Memory\n\n## Decisions\n- worker memory\n', 'utf8')

    const resources = await manager.getMemoryRuntimeResourcesForTest(worker.agentId)
    expect(resources.memoryContextFile.path).toBe(rootSessionMemoryPath)
    expect(resources.memoryContextFile.content).toContain('canonical profile memory')
    expect(resources.memoryContextFile.content).toContain('manager working memory')
    expect(resources.memoryContextFile.content).not.toContain('worker memory')
  })

  it('loads profile memory as read-only context for non-default sessions', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Memory Session' })
    const profileMemoryPath = config.paths.memoryFile!
    const sessionMemoryPath = getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId)

    await writeFile(profileMemoryPath, '# Swarm Memory\n\n## Decisions\n- shared profile decision\n', 'utf8')
    await writeFile(sessionMemoryPath, '# Swarm Memory\n\n## Decisions\n- session-only decision\n', 'utf8')

    const resources = await manager.getMemoryRuntimeResourcesForTest(sessionAgent.agentId)

    expect(resources.memoryContextFile.path).toBe(sessionMemoryPath)
    expect(resources.memoryContextFile.content).toContain(
      '# Manager Memory (shared across all sessions — read-only reference)',
    )
    expect(resources.memoryContextFile.content).toContain('shared profile decision')
    expect(resources.memoryContextFile.content).toContain(
      '# Session Memory (this session\'s working memory — your writes go here)',
    )
    expect(resources.memoryContextFile.content).toContain('session-only decision')
  })

  it('workers in non-default sessions receive the same combined memory context', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Worker Memory Session' })
    const worker = await manager.spawnAgent(sessionAgent.agentId, { agentId: 'Session Memory Worker' })
    const profileMemoryPath = config.paths.memoryFile!
    const sessionMemoryPath = getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId)
    const workerMemoryPath = join(config.paths.memoryDir, `${worker.agentId}.md`)

    await writeFile(profileMemoryPath, '# Swarm Memory\n\n## Project Facts\n- shared fact\n', 'utf8')
    await writeFile(sessionMemoryPath, '# Swarm Memory\n\n## Project Facts\n- session fact\n', 'utf8')
    await mkdir(config.paths.memoryDir, { recursive: true })
    await writeFile(workerMemoryPath, '# Swarm Memory\n\n## Project Facts\n- worker fact\n', 'utf8')

    const resources = await manager.getMemoryRuntimeResourcesForTest(worker.agentId)

    expect(resources.memoryContextFile.path).toBe(sessionMemoryPath)
    expect(resources.memoryContextFile.content).toContain('shared fact')
    expect(resources.memoryContextFile.content).toContain('session fact')
    expect(resources.memoryContextFile.content).not.toContain('worker fact')
  })

  it('mergeSessionMemory safely promotes session memory into profile memory and records audit/meta state', async () => {
    memoryMergeMockState.executeLLMMerge.mockReset()
    memoryMergeMockState.executeLLMMerge.mockResolvedValue(
      '# Swarm Memory\n\n## Decisions\n- existing profile decision\n- merged by mock\n',
    )

    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Merge Session' })
    const profileMemoryPath = config.paths.memoryFile!
    const sessionMemoryPath = getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId)
    const auditPath = getProfileMergeAuditLogPath(config.paths.dataDir, 'manager')

    await writeFile(profileMemoryPath, '# Swarm Memory\n\n## Decisions\n- existing profile decision\n', 'utf8')
    await writeFile(sessionMemoryPath, '# Swarm Memory\n\n## Decisions\n- session merge detail\n', 'utf8')

    const result = await manager.mergeSessionMemory(sessionAgent.agentId)

    expect(result.status).toBe('applied')
    expect(result.strategy).toBe('llm')
    expect(result.auditPath).toBe(auditPath)

    const mergedProfileMemory = await readFile(profileMemoryPath, 'utf8')
    expect(mergedProfileMemory).toContain('existing profile decision')
    expect(mergedProfileMemory).toContain('merged by mock')
    expect(mergedProfileMemory).not.toContain('## Session Memory Merge —')

    const mergedSessionDescriptor = manager.listAgents().find((agent) => agent.agentId === sessionAgent.agentId)
    expect(mergedSessionDescriptor?.mergedAt).toBeDefined()

    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', sessionAgent.agentId)
    expect(sessionMeta?.memoryMergeAttemptCount).toBe(1)
    expect(sessionMeta?.lastMemoryMergeStatus).toBe('applied')
    expect(sessionMeta?.lastMemoryMergeStrategy).toBe('llm')
    expect(sessionMeta?.lastMemoryMergeAppliedAt).toBe(result.mergedAt)
    expect(sessionMeta?.lastMemoryMergeAttemptId).toEqual(expect.any(String))
    expect(sessionMeta?.lastMemoryMergeError).toBeNull()

    const auditLines = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(auditLines).toHaveLength(1)
    expect(auditLines[0]).toMatchObject({
      sessionAgentId: sessionAgent.agentId,
      profileId: 'manager',
      status: 'applied',
      strategy: 'llm',
      usedFallbackAppend: false,
      appliedChange: true,
    })
    expect(sessionMeta?.lastMemoryMergeAttemptId).toBe(auditLines[0].attemptId)
    expect(sessionMeta?.lastMemoryMergeProfileHashBefore).toBe(auditLines[0].profileContentHashBefore)
    expect(sessionMeta?.lastMemoryMergeProfileHashAfter).toBe(auditLines[0].profileContentHashAfter)
  })

  it('mergeSessionMemory seeds empty profile memory directly from session content', async () => {
    memoryMergeMockState.executeLLMMerge.mockReset()

    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Seed Session' })
    const profileMemoryPath = config.paths.memoryFile!
    const auditPath = getProfileMergeAuditLogPath(config.paths.dataDir, 'manager')

    await writeFile(profileMemoryPath, '', 'utf8')
    await writeFile(
      getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId),
      '# Swarm Memory\n\n## Decisions\n- seed from session\n',
      'utf8',
    )

    const result = await manager.mergeSessionMemory(sessionAgent.agentId)

    expect(result.status).toBe('applied')
    expect(result.strategy).toBe('seed')
    expect(memoryMergeMockState.executeLLMMerge).not.toHaveBeenCalled()
    expect(await readFile(profileMemoryPath, 'utf8')).toBe('# Swarm Memory\n\n## Decisions\n- seed from session\n')

    const auditLines = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(auditLines).toHaveLength(1)
    expect(auditLines[0]).toMatchObject({
      sessionAgentId: sessionAgent.agentId,
      status: 'applied',
      strategy: 'seed',
      model: 'seed',
      appliedChange: true,
    })
  })

  it('mergeSessionMemory skips sessions with only default template memory and records the no-op attempt', async () => {
    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Template Session' })
    const profileMemoryPath = config.paths.memoryFile!

    await writeFile(profileMemoryPath, '# Swarm Memory\n\n## Decisions\n- before merge\n', 'utf8')

    const result = await manager.mergeSessionMemory(sessionAgent.agentId)

    expect(result.status).toBe('skipped')
    expect(result.strategy).toBe('template_noop')

    const profileMemory = await readFile(profileMemoryPath, 'utf8')
    expect(profileMemory).toBe('# Swarm Memory\n\n## Decisions\n- before merge\n')

    const sessionDescriptor = manager.listAgents().find((agent) => agent.agentId === sessionAgent.agentId)
    expect(sessionDescriptor?.mergedAt).toBeUndefined()

    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', sessionAgent.agentId)
    expect(sessionMeta?.memoryMergeAttemptCount).toBe(1)
    expect(sessionMeta?.lastMemoryMergeStatus).toBe('skipped')
    expect(sessionMeta?.lastMemoryMergeStrategy).toBe('template_noop')
  })

  it('mergeSessionMemory skips repeated promotion attempts for unchanged session memory', async () => {
    memoryMergeMockState.executeLLMMerge.mockReset()
    memoryMergeMockState.executeLLMMerge.mockResolvedValue('# Swarm Memory\n\n## Decisions\n- merged once\n')

    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Idempotent Session' })
    await writeFile(config.paths.memoryFile!, '# Swarm Memory\n\n## Decisions\n- existing profile decision\n', 'utf8')
    await writeFile(
      getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId),
      '# Swarm Memory\n\n## Decisions\n- repeatable merge detail\n',
      'utf8',
    )

    const firstResult = await manager.mergeSessionMemory(sessionAgent.agentId)
    const secondResult = await manager.mergeSessionMemory(sessionAgent.agentId)

    expect(firstResult.status).toBe('applied')
    expect(secondResult.status).toBe('skipped')
    expect(secondResult.strategy).toBe('idempotent_noop')
    expect(memoryMergeMockState.executeLLMMerge).toHaveBeenCalledTimes(1)

    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', sessionAgent.agentId)
    expect(sessionMeta?.memoryMergeAttemptCount).toBe(2)
    expect(sessionMeta?.lastMemoryMergeStatus).toBe('skipped')
    expect(sessionMeta?.lastMemoryMergeStrategy).toBe('idempotent_noop')
    expect(sessionMeta?.lastMemoryMergeAppliedAt).toBe(firstResult.mergedAt)
  })

  it('mergeSessionMemory reruns unchanged session content when canonical profile memory has changed since the last attempt', async () => {
    memoryMergeMockState.executeLLMMerge.mockReset()
    memoryMergeMockState.executeLLMMerge
      .mockResolvedValueOnce('# Swarm Memory\n\n## Decisions\n- merged once\n')
      .mockResolvedValueOnce('# Swarm Memory\n\n## Decisions\n- manual edit retained\n- merged after profile change\n')

    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Profile Drift Session' })
    const profileMemoryPath = config.paths.memoryFile!
    const auditPath = getProfileMergeAuditLogPath(config.paths.dataDir, 'manager')

    await writeFile(profileMemoryPath, '# Swarm Memory\n\n## Decisions\n- existing profile decision\n', 'utf8')
    await writeFile(
      getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId),
      '# Swarm Memory\n\n## Decisions\n- repeatable merge detail\n',
      'utf8',
    )

    const firstResult = await manager.mergeSessionMemory(sessionAgent.agentId)
    await writeFile(profileMemoryPath, '# Swarm Memory\n\n## Decisions\n- manual edit retained\n', 'utf8')

    const secondResult = await manager.mergeSessionMemory(sessionAgent.agentId)

    expect(firstResult.status).toBe('applied')
    expect(secondResult.status).toBe('applied')
    expect(secondResult.strategy).toBe('llm')
    expect(memoryMergeMockState.executeLLMMerge).toHaveBeenCalledTimes(2)
    expect(await readFile(profileMemoryPath, 'utf8')).toBe(
      '# Swarm Memory\n\n## Decisions\n- manual edit retained\n- merged after profile change\n',
    )

    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', sessionAgent.agentId)
    expect(sessionMeta?.memoryMergeAttemptCount).toBe(2)
    expect(sessionMeta?.lastMemoryMergeStatus).toBe('applied')
    expect(sessionMeta?.lastMemoryMergeStrategy).toBe('llm')

    const auditLines = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(auditLines).toHaveLength(2)
    expect(auditLines[0]).toMatchObject({ status: 'applied', strategy: 'llm' })
    expect(auditLines[1]).toMatchObject({ status: 'applied', strategy: 'llm' })
    expect(auditLines[1].profileContentHashBefore).not.toBe(auditLines[0].profileContentHashAfter)
    expect(sessionMeta?.lastMemoryMergeProfileHashBefore).toBe(auditLines[1].profileContentHashBefore)
    expect(sessionMeta?.lastMemoryMergeProfileHashAfter).toBe(auditLines[1].profileContentHashAfter)
  })

  it('mergeSessionMemory preserves legacy idempotent behavior when pre-phase5 meta lacks profile-hash fields', async () => {
    memoryMergeMockState.executeLLMMerge.mockReset()
    memoryMergeMockState.executeLLMMerge.mockResolvedValue('# Swarm Memory\n\n## Decisions\n- merged once\n')

    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Legacy Idempotent Session' })
    const profileMemoryPath = config.paths.memoryFile!
    const sessionMemoryPath = getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId)
    const metaPath = join(getSessionDir(config.paths.dataDir, 'manager', sessionAgent.agentId), 'meta.json')

    await writeFile(profileMemoryPath, '# Swarm Memory\n\n## Decisions\n- existing profile decision\n', 'utf8')
    await writeFile(sessionMemoryPath, '# Swarm Memory\n\n## Decisions\n- repeatable merge detail\n', 'utf8')

    await manager.mergeSessionMemory(sessionAgent.agentId)

    const persistedMeta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
    delete persistedMeta.lastMemoryMergeAttemptId
    delete persistedMeta.lastMemoryMergeProfileHashBefore
    delete persistedMeta.lastMemoryMergeProfileHashAfter
    await writeFile(metaPath, `${JSON.stringify(persistedMeta, null, 2)}\n`, 'utf8')

    memoryMergeMockState.executeLLMMerge.mockReset()

    const secondResult = await manager.mergeSessionMemory(sessionAgent.agentId)

    expect(secondResult.status).toBe('skipped')
    expect(secondResult.strategy).toBe('idempotent_noop')
    expect(memoryMergeMockState.executeLLMMerge).not.toHaveBeenCalled()

    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', sessionAgent.agentId)
    expect(sessionMeta?.lastMemoryMergeAttemptId).toEqual(expect.any(String))
    expect(sessionMeta?.lastMemoryMergeProfileHashBefore).toEqual(expect.any(String))
    expect(sessionMeta?.lastMemoryMergeProfileHashAfter).toEqual(expect.any(String))
    expect(sessionMeta?.lastMemoryMergeStatus).toBe('skipped')
    expect(sessionMeta?.lastMemoryMergeStrategy).toBe('idempotent_noop')
  })

  it('mergeSessionMemory records no_change when curated output matches the canonical profile summary', async () => {
    memoryMergeMockState.executeLLMMerge.mockReset()
    memoryMergeMockState.executeLLMMerge.mockResolvedValue('# Swarm Memory\n\n## Decisions\n- unchanged summary\n')

    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'No Change Session' })
    const profileMemoryPath = config.paths.memoryFile!
    const auditPath = getProfileMergeAuditLogPath(config.paths.dataDir, 'manager')

    await writeFile(profileMemoryPath, '# Swarm Memory\n\n## Decisions\n- unchanged summary\n', 'utf8')
    await writeFile(
      getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId),
      '# Swarm Memory\n\n## Decisions\n- new session detail that collapses away\n',
      'utf8',
    )

    const beforeStat = await readFile(profileMemoryPath, 'utf8')
    const result = await manager.mergeSessionMemory(sessionAgent.agentId)

    expect(result.status).toBe('skipped')
    expect(result.strategy).toBe('no_change')
    expect(await readFile(profileMemoryPath, 'utf8')).toBe(beforeStat)

    const auditLines = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(auditLines).toHaveLength(1)
    expect(auditLines[0]).toMatchObject({
      sessionAgentId: sessionAgent.agentId,
      status: 'skipped',
      strategy: 'no_change',
      llmMergeSucceeded: true,
      appliedChange: false,
      model: 'mock/test-model',
    })
  })

  it('mergeSessionMemory fails closed when llm promotion fails and preserves profile memory', async () => {
    memoryMergeMockState.executeLLMMerge.mockReset()
    memoryMergeMockState.executeLLMMerge.mockRejectedValue(new Error('merge model unavailable'))

    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Failure Session' })
    const profileMemoryPath = config.paths.memoryFile!
    const auditPath = getProfileMergeAuditLogPath(config.paths.dataDir, 'manager')

    await writeFile(profileMemoryPath, '# Swarm Memory\n\n## Decisions\n- keep this canonical summary\n', 'utf8')
    await writeFile(
      getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId),
      '# Swarm Memory\n\n## Decisions\n- risky session detail\n',
      'utf8',
    )

    await expect(manager.mergeSessionMemory(sessionAgent.agentId)).rejects.toThrow(
      'Session memory merge failed during llm: merge model unavailable',
    )

    const profileMemory = await readFile(profileMemoryPath, 'utf8')
    expect(profileMemory).toBe('# Swarm Memory\n\n## Decisions\n- keep this canonical summary\n')

    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', sessionAgent.agentId)
    expect(sessionMeta?.memoryMergeAttemptCount).toBe(1)
    expect(sessionMeta?.lastMemoryMergeStatus).toBe('failed')
    expect(sessionMeta?.lastMemoryMergeStrategy).toBe('llm')
    expect(sessionMeta?.lastMemoryMergeError).toContain('merge model unavailable')
    expect(sessionMeta?.lastMemoryMergeAppliedAt).toBeNull()

    const auditLines = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(auditLines).toHaveLength(1)
    expect(auditLines[0]).toMatchObject({
      sessionAgentId: sessionAgent.agentId,
      status: 'failed',
      strategy: 'llm',
      usedFallbackAppend: false,
      appliedChange: false,
    })
  })

  it('mergeSessionMemory surfaces audit append failures explicitly and records the failed stage', async () => {
    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Audit Failure Session' })
    await writeFile(config.paths.memoryFile!, '', 'utf8')
    await writeFile(
      getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId),
      '# Swarm Memory\n\n## Decisions\n- audit failure seed detail\n',
      'utf8',
    )

    ;(manager as any).appendSessionMemoryMergeAuditEntry = async () => {
      throw new Error('audit disk full')
    }

    await expect(manager.mergeSessionMemory(sessionAgent.agentId)).rejects.toThrow(
      'Session memory merge failed during write_audit: audit disk full',
    )

    expect(await readFile(config.paths.memoryFile!, 'utf8')).toBe(
      '# Swarm Memory\n\n## Decisions\n- audit failure seed detail\n',
    )

    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', sessionAgent.agentId)
    expect(sessionMeta?.memoryMergeAttemptCount).toBe(2)
    expect(sessionMeta?.lastMemoryMergeStatus).toBe('failed')
    expect(sessionMeta?.lastMemoryMergeStrategy).toBe('seed')
    expect(sessionMeta?.lastMemoryMergeFailureStage).toBe('write_audit')
    expect(sessionMeta?.lastMemoryMergeAppliedSourceHash).toBe(sessionMeta?.lastMemoryMergeSourceHash)
    expect(sessionMeta?.lastMemoryMergeError).toContain('audit disk full')
  })

  it('mergeSessionMemory retries after a write_audit failure instead of idempotent-skipping recovery', async () => {
    memoryMergeMockState.executeLLMMerge.mockReset()
    memoryMergeMockState.executeLLMMerge
      .mockResolvedValueOnce('# Swarm Memory\n\n## Decisions\n- merged before audit retry\n')
      .mockResolvedValueOnce('# Swarm Memory\n\n## Decisions\n- merged before audit retry\n')

    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Audit Retry Session' })
    const auditPath = getProfileMergeAuditLogPath(config.paths.dataDir, 'manager')
    await writeFile(config.paths.memoryFile!, '# Swarm Memory\n\n## Decisions\n- existing profile decision\n', 'utf8')
    await writeFile(
      getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId),
      '# Swarm Memory\n\n## Decisions\n- detail before audit retry\n',
      'utf8',
    )

    const originalAppendSessionMemoryMergeAuditEntry = (manager as any).appendSessionMemoryMergeAuditEntry.bind(manager)
    let appendFailuresRemaining = 1
    ;(manager as any).appendSessionMemoryMergeAuditEntry = async (...args: any[]) => {
      if (appendFailuresRemaining > 0) {
        appendFailuresRemaining -= 1
        throw new Error('audit disk full')
      }

      return originalAppendSessionMemoryMergeAuditEntry(...args)
    }

    await expect(manager.mergeSessionMemory(sessionAgent.agentId)).rejects.toThrow(
      'Session memory merge failed during write_audit: audit disk full',
    )

    const retryResult = await manager.mergeSessionMemory(sessionAgent.agentId)
    expect(retryResult.status).toBe('applied')
    expect(retryResult.strategy).toBe('llm')
    expect(memoryMergeMockState.executeLLMMerge).toHaveBeenCalledTimes(2)

    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', sessionAgent.agentId)
    expect(sessionMeta?.lastMemoryMergeStatus).toBe('applied')
    expect(sessionMeta?.lastMemoryMergeStrategy).toBe('llm')
    expect(sessionMeta?.lastMemoryMergeError).toBeNull()

    const auditLines = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(auditLines).toHaveLength(1)
    expect(auditLines[0]).toMatchObject({
      sessionAgentId: sessionAgent.agentId,
      status: 'applied',
      strategy: 'llm',
    })
  })

  it('mergeSessionMemory records failed attempts for non-llm save-store failures', async () => {
    memoryMergeMockState.executeLLMMerge.mockReset()
    memoryMergeMockState.executeLLMMerge.mockResolvedValue('# Swarm Memory\n\n## Decisions\n- merged before save failure\n')

    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Save Failure Session' })
    const auditPath = getProfileMergeAuditLogPath(config.paths.dataDir, 'manager')
    await writeFile(config.paths.memoryFile!, '# Swarm Memory\n\n## Decisions\n- existing profile decision\n', 'utf8')
    await writeFile(
      getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId),
      '# Swarm Memory\n\n## Decisions\n- detail before save-store failure\n',
      'utf8',
    )

    ;(manager as any).saveStore = async () => {
      throw new Error('agents store write failed')
    }

    await expect(manager.mergeSessionMemory(sessionAgent.agentId)).rejects.toThrow(
      'Session memory merge failed during save_store: agents store write failed',
    )

    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', sessionAgent.agentId)
    expect(sessionMeta?.memoryMergeAttemptCount).toBe(2)
    expect(sessionMeta?.lastMemoryMergeStatus).toBe('failed')
    expect(sessionMeta?.lastMemoryMergeStrategy).toBe('llm')
    expect(sessionMeta?.lastMemoryMergeFailureStage).toBe('save_store')
    expect(sessionMeta?.lastMemoryMergeAppliedSourceHash).toBe(sessionMeta?.lastMemoryMergeSourceHash)
    expect(sessionMeta?.lastMemoryMergeError).toContain('agents store write failed')

    const auditLines = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(auditLines.at(-1)).toMatchObject({
      sessionAgentId: sessionAgent.agentId,
      status: 'failed',
      strategy: 'llm',
      stage: 'save_store',
      appliedChange: true,
    })
  })

  it('mergeSessionMemory retries after a save_store failure instead of idempotent-skipping recovery', async () => {
    memoryMergeMockState.executeLLMMerge.mockReset()
    memoryMergeMockState.executeLLMMerge
      .mockResolvedValueOnce('# Swarm Memory\n\n## Decisions\n- merged before save retry\n')
      .mockResolvedValueOnce('# Swarm Memory\n\n## Decisions\n- merged before save retry\n')

    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Save Retry Session' })
    const auditPath = getProfileMergeAuditLogPath(config.paths.dataDir, 'manager')
    await writeFile(config.paths.memoryFile!, '# Swarm Memory\n\n## Decisions\n- existing profile decision\n', 'utf8')
    await writeFile(
      getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId),
      '# Swarm Memory\n\n## Decisions\n- detail before save retry\n',
      'utf8',
    )

    const originalSaveStore = (manager as any).saveStore.bind(manager)
    let saveStoreFailuresRemaining = 1
    ;(manager as any).saveStore = async (...args: any[]) => {
      if (saveStoreFailuresRemaining > 0) {
        saveStoreFailuresRemaining -= 1
        throw new Error('agents store write failed')
      }

      return originalSaveStore(...args)
    }

    await expect(manager.mergeSessionMemory(sessionAgent.agentId)).rejects.toThrow(
      'Session memory merge failed during save_store: agents store write failed',
    )

    const retryResult = await manager.mergeSessionMemory(sessionAgent.agentId)
    expect(retryResult.status).toBe('applied')
    expect(retryResult.strategy).toBe('llm')
    expect(memoryMergeMockState.executeLLMMerge).toHaveBeenCalledTimes(2)

    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', sessionAgent.agentId)
    expect(sessionMeta?.lastMemoryMergeStatus).toBe('applied')
    expect(sessionMeta?.lastMemoryMergeStrategy).toBe('llm')
    expect(sessionMeta?.lastMemoryMergeError).toBeNull()

    const auditLines = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(auditLines).toHaveLength(2)
    expect(auditLines[0]).toMatchObject({ status: 'failed', strategy: 'llm', stage: 'save_store' })
    expect(auditLines[1]).toMatchObject({ status: 'applied', strategy: 'llm' })

    const persistedStore = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
      agents: Array<{ agentId: string; mergedAt?: string }>
    }
    expect(persistedStore.agents.find((agent) => agent.agentId === sessionAgent.agentId)?.mergedAt).toBe(
      retryResult.mergedAt,
    )
  })

  it('mergeSessionMemory still records a failed attempt when record-attempt persistence throws', async () => {
    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Record Attempt Failure Session' })
    await writeFile(config.paths.memoryFile!, '', 'utf8')
    await writeFile(
      getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId),
      '# Swarm Memory\n\n## Decisions\n- record attempt failure detail\n',
      'utf8',
    )

    ;(manager as any).recordSessionMemoryMergeAttempt = async () => {
      throw new Error('meta persistence unavailable')
    }

    await expect(manager.mergeSessionMemory(sessionAgent.agentId)).rejects.toThrow(
      'Session memory merge failed during record_attempt: meta persistence unavailable',
    )

    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', sessionAgent.agentId)
    expect(sessionMeta?.memoryMergeAttemptCount).toBe(1)
    expect(sessionMeta?.lastMemoryMergeStatus).toBe('failed')
    expect(sessionMeta?.lastMemoryMergeStrategy).toBe('seed')
    expect(sessionMeta?.lastMemoryMergeFailureStage).toBe('record_attempt')
    expect(sessionMeta?.lastMemoryMergeAppliedSourceHash).toBe(sessionMeta?.lastMemoryMergeSourceHash)
    expect(sessionMeta?.lastMemoryMergeError).toContain('meta persistence unavailable')
  })

  it('mergeSessionMemory retries after a failed attempt instead of skipping idempotently', async () => {
    memoryMergeMockState.executeLLMMerge.mockReset()
    memoryMergeMockState.executeLLMMerge
      .mockRejectedValueOnce(new Error('temporary merge outage'))
      .mockResolvedValueOnce('# Swarm Memory\n\n## Decisions\n- merged after retry\n')

    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Retry Session' })
    const profileMemoryPath = config.paths.memoryFile!
    const auditPath = getProfileMergeAuditLogPath(config.paths.dataDir, 'manager')

    await writeFile(profileMemoryPath, '# Swarm Memory\n\n## Decisions\n- existing summary\n', 'utf8')
    await writeFile(
      getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId),
      '# Swarm Memory\n\n## Decisions\n- retryable session detail\n',
      'utf8',
    )

    await expect(manager.mergeSessionMemory(sessionAgent.agentId)).rejects.toThrow(
      'Session memory merge failed during llm: temporary merge outage',
    )

    const retryResult = await manager.mergeSessionMemory(sessionAgent.agentId)
    expect(retryResult.status).toBe('applied')
    expect(retryResult.strategy).toBe('llm')
    expect(memoryMergeMockState.executeLLMMerge).toHaveBeenCalledTimes(2)
    expect(await readFile(profileMemoryPath, 'utf8')).toBe('# Swarm Memory\n\n## Decisions\n- merged after retry\n')

    const sessionMeta = await readSessionMeta(config.paths.dataDir, 'manager', sessionAgent.agentId)
    expect(sessionMeta?.memoryMergeAttemptCount).toBe(2)
    expect(sessionMeta?.lastMemoryMergeStatus).toBe('applied')
    expect(sessionMeta?.lastMemoryMergeStrategy).toBe('llm')
    expect(sessionMeta?.lastMemoryMergeError).toBeNull()

    const auditLines = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(auditLines).toHaveLength(2)
    expect(auditLines[0]).toMatchObject({ status: 'failed', strategy: 'llm' })
    expect(auditLines[1]).toMatchObject({ status: 'applied', strategy: 'llm' })
  })

  it('mergeSessionMemory serializes concurrent merges for the same profile', async () => {
    memoryMergeMockState.executeLLMMerge.mockReset()
    memoryMergeMockState.executeLLMMerge.mockImplementation(async (profile: string, session: string) => {
      const sessionPayload = session.includes('first merge payload') ? 'first merge payload' : 'second merge payload'
      return `${profile.trimEnd()}\n- ${sessionPayload}\n`
    })

    const config = await makeTempConfig()
    const manager = new MergeEnabledTestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent: firstSession } = await manager.createSession('manager', { label: 'First Merge Session' })
    const { sessionAgent: secondSession } = await manager.createSession('manager', { label: 'Second Merge Session' })
    const profileMemoryPath = config.paths.memoryFile!

    await writeFile(profileMemoryPath, '# Swarm Memory\n\n## Project Facts\n- baseline\n', 'utf8')
    await writeFile(
      getSessionMemoryPath(config.paths.dataDir, 'manager', firstSession.agentId),
      '# Swarm Memory\n\n## Project Facts\n- first merge payload\n',
      'utf8',
    )
    await writeFile(
      getSessionMemoryPath(config.paths.dataDir, 'manager', secondSession.agentId),
      '# Swarm Memory\n\n## Project Facts\n- second merge payload\n',
      'utf8',
    )

    await Promise.all([
      manager.mergeSessionMemory(firstSession.agentId),
      manager.mergeSessionMemory(secondSession.agentId),
    ])

    const profileMemory = await readFile(profileMemoryPath, 'utf8')
    expect(profileMemory).toContain('first merge payload')
    expect(profileMemory).toContain('second merge payload')
  })

  it('rejects mergeSessionMemory for the default profile session', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    await expect(manager.mergeSessionMemory('manager')).rejects.toThrow(
      'Default session working memory merge is not supported',
    )
  })

  it('mergeSessionMemory copies legacy auth forward to canonical shared auth before model resolution', async () => {
    memoryMergeMockState.executeLLMMerge.mockReset()
    memoryMergeMockState.executeLLMMerge.mockResolvedValue('# Swarm Memory\n\n## Decisions\n- merged by mock\n')

    const config = await makeTempConfig()
    const legacyAuthStorage = AuthStorage.create(config.paths.authFile)
    legacyAuthStorage.set('openai-codex', {
      type: 'api_key',
      key: 'sk-legacy-merge-auth',
      access: 'sk-legacy-merge-auth',
      refresh: '',
      expires: '',
    } as any)

    const manager = new AuthFallbackSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const { sessionAgent } = await manager.createSession('manager', { label: 'Legacy Auth Merge Session' })
    await writeFile(config.paths.memoryFile!, '# Swarm Memory\n\n## Decisions\n- existing profile decision\n', 'utf8')
    await writeFile(
      getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId),
      '# Swarm Memory\n\n## Decisions\n- merge detail from session\n',
      'utf8',
    )

    await manager.mergeSessionMemory(sessionAgent.agentId)

    const sharedAuth = JSON.parse(await readFile(config.paths.sharedAuthFile, 'utf8')) as Record<
      string,
      { type: string; key?: string; access?: string }
    >
    expect(sharedAuth['openai-codex']).toMatchObject({ type: 'api_key' })
    expect(sharedAuth['openai-codex'].key ?? sharedAuth['openai-codex'].access).toBe('sk-legacy-merge-auth')

    const mergedProfileMemory = await readFile(config.paths.memoryFile!, 'utf8')
    expect(mergedProfileMemory).toContain('merged by mock')
    expect(memoryMergeMockState.executeLLMMerge).toHaveBeenCalledTimes(1)
  })

  it('injects confirmed onboarding defaults into newly created manager runtime memory', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)

    await manager.boot()
    await loadOnboardingState(config.paths.dataDir)
    await saveOnboardingPreferences(config.paths.dataDir, {
      preferredName: 'Ada',
      technicalLevel: 'developer',
      additionalPreferences: 'Keep responses detailed and proactive.',
    })

    const created = await manager.createManager('cortex', {
      name: 'Project Manager',
      cwd: config.defaultCwd,
    })

    const resources = await manager.getMemoryRuntimeResourcesForTest(created.agentId)
    expect(resources.memoryContextFile.content).toContain('# Onboarding Snapshot (authoritative backend state — read-only reference)')
    expect(resources.memoryContextFile.content).toContain('- preferred name: Ada')
    expect(resources.memoryContextFile.content).toContain('- technical level: developer')
    expect(resources.memoryContextFile.content).toContain('- additional preferences: Keep responses detailed and proactive.')
  })

  it('records versioning mutations when session memory merges update profile memory', async () => {
    const config = await makeTempConfig()
    const recordMutation = vi.fn(async () => true)
    const manager = new MergeEnabledTestSwarmManager(config, {
      versioningService: {
        isTrackedPath: () => true,
        recordMutation,
        flushPending: async () => {},
        reconcileNow: async () => {},
      },
    })
    await bootWithDefaultManager(manager, config)
    recordMutation.mockClear()

    const { sessionAgent } = await manager.createSession('manager', { label: 'Versioned Merge Session' })
    const profileMemoryPath = getProfileMemoryPath(config.paths.dataDir, 'manager')
    const sessionMemoryPath = getSessionMemoryPath(config.paths.dataDir, 'manager', sessionAgent.agentId)
    await mkdir(dirname(sessionMemoryPath), { recursive: true })
    await writeFile(profileMemoryPath, '# Swarm Memory\n\n## Decisions\n- existing profile decision\n', 'utf8')
    await writeFile(sessionMemoryPath, '# Swarm Memory\n\n## Decisions\n- session merge detail\n', 'utf8')

    await manager.mergeSessionMemory(sessionAgent.agentId)

    expect(recordMutation).toHaveBeenCalledWith({
      path: profileMemoryPath,
      action: 'write',
      source: 'profile-memory-merge',
      profileId: 'manager',
      sessionId: sessionAgent.agentId,
    })
  })
})
