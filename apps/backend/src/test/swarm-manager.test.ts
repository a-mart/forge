import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AuthStorage, SessionManager } from '@mariozechner/pi-coding-agent'
import { getScheduleFilePath } from '../scheduler/schedule-storage.js'
import { getConversationHistoryCacheFilePath } from '../swarm/conversation-history-cache.js'
import {
  getCommonKnowledgePath,
  getCortexPromotionManifestsDir,
  getCortexReviewLogPath,
  getCortexReviewRunsPath,
  getCortexWorkerPromptsPath,
  getProfileKnowledgePath,
  getProfileMemoryPath,
  getProfileMergeAuditLogPath,
  getProfileReferencePath,
  getRootSessionMemoryPath,
  getSessionDir,
  getSessionMemoryPath,
} from '../swarm/data-paths.js'
const memoryMergeMockState = vi.hoisted(() => ({
  executeLLMMerge: vi.fn(async (..._args: any[]) => '# Swarm Memory\n\n## Decisions\n- merged by mock\n'),
}))

vi.mock('../swarm/memory-merge.js', async () => {
  const actual = await vi.importActual<typeof import('../swarm/memory-merge.js')>('../swarm/memory-merge.js')
  return {
    ...actual,
    executeLLMMerge: (...args: Parameters<typeof actual.executeLLMMerge>) =>
      memoryMergeMockState.executeLLMMerge(...args),
  }
})

import { readSessionMeta } from '../swarm/session-manifest.js'
import { loadOnboardingState, saveOnboardingPreferences } from '../swarm/onboarding-state.js'
import { buildSessionMemoryRuntimeView, SwarmManager } from '../swarm/swarm-manager.js'
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SwarmConfig,
} from '../swarm/types.js'
import type { RuntimeUserMessage, SwarmAgentRuntime } from '../swarm/runtime-types.js'

class FakeRuntime {
  readonly descriptor: AgentDescriptor
  private readonly sessionManager: SessionManager
  terminateCalls: Array<{ abort?: boolean; shutdownTimeoutMs?: number; drainTimeoutMs?: number } | undefined> = []
  stopInFlightCalls: Array<{ abort?: boolean; shutdownTimeoutMs?: number; drainTimeoutMs?: number } | undefined> = []
  recycleCalls = 0
  sendCalls: Array<{ message: string | RuntimeUserMessage; delivery: RequestedDeliveryMode }> = []
  compactCalls: Array<string | undefined> = []
  nextDeliveryId = 0
  busy = false

  constructor(descriptor: AgentDescriptor) {
    this.descriptor = descriptor
    this.sessionManager = SessionManager.open(descriptor.sessionFile)
  }

  getStatus(): AgentDescriptor['status'] {
    return this.descriptor.status
  }

  getPendingCount(): number {
    return this.busy ? 1 : 0
  }

  getContextUsage(): AgentContextUsage | undefined {
    return undefined
  }

  async sendMessage(message: string | RuntimeUserMessage, delivery: RequestedDeliveryMode = 'auto'): Promise<SendMessageReceipt> {
    this.sendCalls.push({ message, delivery })
    this.nextDeliveryId += 1
    this.sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ack' }],
    } as any)

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId: `delivery-${this.nextDeliveryId}`,
      acceptedMode: this.busy ? 'steer' : 'prompt',
    }
  }

  async terminate(options?: { abort?: boolean; shutdownTimeoutMs?: number; drainTimeoutMs?: number }): Promise<void> {
    this.terminateCalls.push(options)
  }

  async recycle(): Promise<void> {
    this.recycleCalls += 1
  }

  async stopInFlight(options?: { abort?: boolean; shutdownTimeoutMs?: number; drainTimeoutMs?: number }): Promise<void> {
    this.stopInFlightCalls.push(options)
    this.busy = false
    this.descriptor.status = 'idle'
  }

  async compact(customInstructions?: string): Promise<unknown> {
    this.compactCalls.push(customInstructions)
    return {
      status: 'ok',
      customInstructions: customInstructions ?? null,
    }
  }

  getCustomEntries(customType: string): unknown[] {
    const entries = this.sessionManager.getEntries()
    return entries
      .filter((entry) => entry.type === 'custom' && entry.customType === customType)
      .map((entry) => (entry.type === 'custom' ? entry.data : undefined))
      .filter((entry) => entry !== undefined)
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    return this.sessionManager.appendCustomEntry(customType, data)
  }
}

class TestSwarmManager extends SwarmManager {
  readonly runtimeByAgentId = new Map<string, FakeRuntime>()
  readonly createdRuntimeIds: string[] = []
  readonly systemPromptByAgentId = new Map<string, string>()

  async getMemoryRuntimeResourcesForTest(agentId = 'manager'): Promise<{
    memoryContextFile: { path: string; content: string }
    additionalSkillPaths: string[]
  }> {
    const descriptor = this.getAgent(agentId)
    if (!descriptor) {
      throw new Error(`Unknown test agent: ${agentId}`)
    }

    return this.getMemoryRuntimeResources(descriptor)
  }

  async getSwarmContextFilesForTest(cwd: string): Promise<Array<{ path: string; content: string }>> {
    return this.getSwarmContextFiles(cwd)
  }

  getLoadedConversationAgentIdsForTest(): string[] {
    const state = this as unknown as {
      conversationEntriesByAgentId: Map<string, unknown>
    }

    return Array.from(state.conversationEntriesByAgentId.keys()).sort((left, right) => left.localeCompare(right))
  }

  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    _runtimeToken?: number,
  ): Promise<SwarmAgentRuntime> {
    const runtime = new FakeRuntime(descriptor)
    this.createdRuntimeIds.push(descriptor.agentId)
    this.runtimeByAgentId.set(descriptor.agentId, runtime)
    this.systemPromptByAgentId.set(descriptor.agentId, systemPrompt)
    return runtime as unknown as SwarmAgentRuntime
  }

  protected override async executeSessionMemoryLLMMerge(
    _descriptor: AgentDescriptor,
    _profileMemoryContent: string,
    _sessionMemoryContent: string,
  ): Promise<{ mergedContent: string; model: string }> {
    throw new Error('LLM merge disabled in tests')
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

class AuthFallbackSwarmManager extends SwarmManager {
  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    _systemPrompt: string,
    _runtimeToken?: number,
  ): Promise<SwarmAgentRuntime> {
    return new FakeRuntime(descriptor) as unknown as SwarmAgentRuntime
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
  const root = await mkdtemp(join(tmpdir(), 'swarm-manager-test-'))
  const dataDir = join(root, 'data')
  const swarmDir = join(dataDir, 'swarm')
  const sessionsDir = join(dataDir, 'sessions')
  const uploadsDir = join(dataDir, 'uploads')
  const profilesDir = join(dataDir, 'profiles')
  const sharedDir = join(dataDir, 'shared')
  const sharedAuthDir = join(sharedDir, 'auth')
  const sharedAuthFile = join(sharedAuthDir, 'auth.json')
  const sharedSecretsFile = join(sharedDir, 'secrets.json')
  const sharedIntegrationsDir = join(sharedDir, 'integrations')
  const authDir = join(dataDir, 'auth')
  const agentDir = join(dataDir, 'agent')
  const managerAgentDir = join(agentDir, 'manager')
  const repoArchetypesDir = join(root, '.swarm', 'archetypes')
  const memoryDir = join(dataDir, 'memory')
  const memoryFile = getProfileMemoryPath(dataDir, 'manager')
  const repoMemorySkillFile = join(root, '.swarm', 'skills', 'memory', 'SKILL.md')

  await mkdir(swarmDir, { recursive: true })
  await mkdir(sessionsDir, { recursive: true })
  await mkdir(uploadsDir, { recursive: true })
  await mkdir(profilesDir, { recursive: true })
  await mkdir(sharedAuthDir, { recursive: true })
  await mkdir(sharedIntegrationsDir, { recursive: true })
  await mkdir(authDir, { recursive: true })
  await mkdir(memoryDir, { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await mkdir(managerAgentDir, { recursive: true })
  await mkdir(repoArchetypesDir, { recursive: true })

  return {
    host: '127.0.0.1',
    port,
    debug: false,
    allowNonManagerSubscriptions: false,
    managerId: 'manager',
    managerDisplayName: 'Manager',
    defaultModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    defaultCwd: root,
    cwdAllowlistRoots: [root, join(root, 'worktrees')],
    paths: {
      rootDir: root,
      dataDir,
      swarmDir,
      uploadsDir,
      agentsStoreFile: join(swarmDir, 'agents.json'),
      profilesDir,
      sharedDir,
      sharedAuthDir,
      sharedAuthFile,
      sharedSecretsFile,
      sharedIntegrationsDir,
      sessionsDir,
      memoryDir,
      authDir,
      authFile: join(authDir, 'auth.json'),
      secretsFile: join(dataDir, 'secrets.json'),
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      memoryFile,
      repoMemorySkillFile,
      schedulesFile: getScheduleFilePath(dataDir, 'manager'),
    },
  }
}

async function bootWithDefaultManager(
  manager: SwarmManager & { runtimeByAgentId?: Map<string, FakeRuntime> },
  config: SwarmConfig,
): Promise<AgentDescriptor> {
  await manager.boot()
  const managerId = config.managerId ?? 'manager'
  const managerName = config.managerDisplayName ?? managerId

  const existingManager = manager.listAgents().find(
    (descriptor) => descriptor.agentId === managerId && descriptor.role === 'manager',
  )
  if (existingManager) {
    return existingManager
  }

  const callerAgentId =
    manager
      .listAgents()
      .find((descriptor) => descriptor.role === 'manager')
      ?.agentId ?? managerId

  const createdManager = await manager.createManager(callerAgentId, {
    name: managerName,
    cwd: config.defaultCwd,
  })

  // `createManager` sends an internal bootstrap message; clear fake runtime calls for deterministic assertions.
  const createdRuntime = manager.runtimeByAgentId?.get(createdManager.agentId)
  if (createdRuntime) {
    createdRuntime.sendCalls = []
    createdRuntime.nextDeliveryId = 0
  }

  return createdManager
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
    expect(managerPrompt).toContain('You are the manager agent in a multi-agent swarm.')
    expect(managerPrompt).toContain('End users only see two things')
    expect(managerPrompt).toContain('prefixed with "SYSTEM:"')
    expect(managerPrompt).toContain('${SWARM_MEMORY_FILE}')

    const worker = await manager.spawnAgent('manager', { agentId: 'Prompt Worker' })
    const workerPrompt = manager.systemPromptByAgentId.get(worker.agentId)

    expect(workerPrompt).toBeDefined()
    expect(workerPrompt).toContain('End users only see messages they send and manager speak_to_user outputs.')
    expect(workerPrompt).toContain('Incoming messages prefixed with "SYSTEM:"')
    expect(workerPrompt).toContain('Persistent memory for this runtime is at ${SWARM_MEMORY_FILE}')
    expect(workerPrompt).toContain('Workers read their owning manager\'s memory file.')
    expect(workerPrompt).toContain('Follow the memory skill workflow before editing the memory file')
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

    it('auto-loads per-runtime memory context and wires built-in memory + brave-search + cron-scheduling + agent-browser + image-generation + slash-commands + chrome-cdp skills', async () => {
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
    expect(resources.additionalSkillPaths.length).toBeGreaterThanOrEqual(7)

    const memorySkillPath = resources.additionalSkillPaths.find((path) => path.endsWith(join('memory', 'SKILL.md')))
    expect(memorySkillPath).toBeDefined()
    const memorySkill = await readFile(memorySkillPath!, 'utf8')
    expect(memorySkill).toContain('name: memory')
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

  it('uses repo manager archetype overrides on boot', async () => {
    const config = await makeTempConfig()
    const managerOverride = 'You are the repo manager override.'
    await writeFile(join(config.paths.repoArchetypesDir, 'manager.md'), `${managerOverride}\n`, 'utf8')

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    expect(manager.systemPromptByAgentId.get('manager')).toBe(managerOverride)
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

    expect(recordMutation).toHaveBeenNthCalledWith(1, {
      path: commonKnowledgePath,
      action: 'write',
      source: 'agent-write-tool',
      profileId: 'manager',
      sessionId: 'manager',
      agentId: 'manager',
    })
    expect(recordMutation).toHaveBeenNthCalledWith(2, {
      path: commonKnowledgePath,
      action: 'write',
      source: 'agent-edit-tool',
      profileId: 'manager',
      sessionId: 'manager',
      agentId: 'manager',
    })
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
        errorMessage: 'Rate limit exceeded for requests per minute',
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
      expect(systemEvent.text).toContain('Rate limit exceeded for requests per minute')
      expect(systemEvent.text).not.toContain('prompt exceeded the model context window')
      expect(systemEvent.text).not.toContain('Try compacting the conversation to free up context space.')
    }
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

    const run = await manager.startCortexReviewRun({
      scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory', 'feedback'] },
      trigger: 'manual',
      sourceContext: { channel: 'web' },
    })

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

  it('reconstructs persisted Cortex review runs after restart, including closeout text', async () => {
    const config = await makeTempConfig()
    const firstBoot = new TestSwarmManager(config)
    await firstBoot.boot()

    const run = await firstBoot.startCortexReviewRun({
      scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory'] },
      trigger: 'manual',
      sourceContext: { channel: 'web' },
    })

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

    const run = await firstBoot.startCortexReviewRun({
      scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory'] },
      trigger: 'manual',
      sourceContext: { channel: 'web' },
    })

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

  it('routes scheduled review envelopes into the same review-run path with schedule metadata', async () => {
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
    expect(runs[0]).toMatchObject({
      trigger: 'scheduled',
      scope: { mode: 'all' },
      scheduleName: 'Nightly Review',
      requestText:
        '[Scheduled Task: Nightly Review]\n[scheduleContext] {"scheduleId":"sched-1"}\n\nReview all sessions that need attention',
    })
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

    const secondRun = await manager.startCortexReviewRun({
      scope: { mode: 'session', profileId: 'alpha', sessionId: 'alpha--s1', axes: ['memory'] },
      trigger: 'manual',
      sourceContext: { channel: 'web' },
    })

    expect(secondRun.status).toBe('queued')
    expect(secondRun.sessionAgentId).toBeNull()
    expect(secondRun.queuePosition).toBe(1)

    releaseFirstRun()
    const firstRun = await firstRunPromise

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

  it('falls back to a generic completion signal when the latest summary was already reported', async () => {
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

    expect(managerRuntime?.sendCalls).toHaveLength(1)
    expect(managerRuntime?.sendCalls[0]).toMatchObject({
      delivery: 'auto',
      message: 'SYSTEM: Worker repeat-summary-worker completed its turn.',
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

  it('reloads manager history from conversation cache when session entries are unavailable', async () => {
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
    ).rejects.toThrow('Cortex manager already exists')
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
      thinkingLevel: 'xhigh',
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
    ).rejects.toThrow('create_manager.model must be one of pi-codex|pi-5.4|pi-opus|codex-app')
  })

  it('recycles idle manager session runtimes after a profile model change and recreates them on the next prompt', async () => {
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

    await manager.updateManagerModel('manager', 'pi-5.4')

    expect(rootRuntime?.recycleCalls).toBe(1)
    expect(sessionRuntime?.recycleCalls).toBe(1)
    expect(state.runtimes.has(rootSession.agentId)).toBe(false)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(false)
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

  it('defers runtime recycle for active manager sessions until they return to idle', async () => {
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

    await manager.updateManagerModel('manager', 'pi-opus')

    expect(sessionRuntime.recycleCalls).toBe(0)
    expect(state.pendingManagerRuntimeRecycleAgentIds.has(sessionAgent.agentId)).toBe(true)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(true)

    const runtimeToken = state.runtimeTokensByAgentId.get(sessionAgent.agentId)
    expect(runtimeToken).toBeTypeOf('number')

    sessionRuntime.busy = false
    await state.handleRuntimeStatus(runtimeToken as number, sessionAgent.agentId, 'idle', 0)

    expect(sessionRuntime.recycleCalls).toBe(1)
    expect(state.pendingManagerRuntimeRecycleAgentIds.has(sessionAgent.agentId)).toBe(false)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(false)
    expect(manager.getAgent(sessionAgent.agentId)?.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'xhigh',
    })

    const createdRuntimeCountBeforePrompt = manager.createdRuntimeIds.length
    await manager.handleUserMessage('Recreate after idle', { targetAgentId: sessionAgent.agentId })

    expect(manager.createdRuntimeIds.length).toBe(createdRuntimeCountBeforePrompt + 1)
    expect(manager.runtimeByAgentId.get(sessionAgent.agentId)).not.toBe(sessionRuntime)
    expect(state.runtimes.has(sessionAgent.agentId)).toBe(true)
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
    ).rejects.toThrow('spawn_agent.model must be one of pi-codex|pi-5.4|pi-opus|codex-app')
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
