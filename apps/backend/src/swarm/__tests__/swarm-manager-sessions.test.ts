import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionManager } from '@mariozechner/pi-coding-agent'
import { getCatalogModelKey } from '@forge/protocol'
import { getSessionDir } from '../data-paths.js'
import { readSessionMeta } from '../session-manifest.js'
import { modelCatalogService } from '../model-catalog-service.js'
import { loadModelChangeContinuityState } from '../runtime/model-change-continuity.js'
import type { AgentContextUsage, AgentDescriptor, SwarmConfig } from '../types.js'
import type { RuntimeCreationOptions, SwarmAgentRuntime } from '../runtime-contracts.js'
import { makeTempConfig as buildTempConfig } from '../../test-support/index.js'
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
