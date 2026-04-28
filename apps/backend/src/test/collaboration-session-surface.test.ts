import type { AgentDescriptor as ProtocolAgentDescriptor } from '@forge/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { createTempConfig, type TempConfigHandle, TestSwarmManager as TestSwarmManagerBase, bootWithDefaultManager } from '../test-support/index.js'
import { readSessionMeta } from '../swarm/session-manifest.js'
import {
  assertBuilderSession,
  cloneDescriptor,
  getCollabSessionInfo,
  isCollabSession,
  validateAgentDescriptor,
} from '../swarm/swarm-manager-utils.js'
import type { AgentDescriptor, SwarmConfig } from '../swarm/types.js'
import type { RuntimeCreationOptions, SwarmAgentRuntime } from '../swarm/runtime-contracts.js'

const PROJECT_ROOT = resolve(process.cwd(), '..', '..')
const TEST_TIMESTAMP = '2026-01-01T00:00:00.000Z'
const tempHandles: TempConfigHandle[] = []

afterEach(async () => {
  await Promise.all(tempHandles.splice(0).map((handle) => handle.cleanup()))
})

function createDescriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  const agentId = overrides.agentId ?? 'manager-1'

  return {
    agentId,
    displayName: 'Manager',
    role: 'manager',
    managerId: overrides.managerId ?? agentId,
    status: 'idle',
    createdAt: TEST_TIMESTAMP,
    updatedAt: TEST_TIMESTAMP,
    cwd: overrides.cwd ?? PROJECT_ROOT,
    model: overrides.model ?? {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    sessionFile: overrides.sessionFile ?? join(PROJECT_ROOT, '.tmp', `${agentId}.jsonl`),
    ...overrides,
  }
}

function seedDescriptors(manager: TestSwarmManagerBase, descriptors: AgentDescriptor[]): void {
  const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
  state.descriptors.clear()
  for (const descriptor of descriptors) {
    state.descriptors.set(descriptor.agentId, descriptor)
  }
}

class CollabLazyRuntimeSwarmManager extends TestSwarmManagerBase {
  readonly runtimeCreateCalls: string[] = []

  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions,
  ): Promise<SwarmAgentRuntime> {
    this.runtimeCreateCalls.push(descriptor.agentId)
    if (descriptor.sessionSurface === 'collab') {
      throw new Error(`runtime unavailable for ${descriptor.agentId}`)
    }

    return super.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options)
  }
}

async function makeConfig(): Promise<SwarmConfig> {
  const handle = await createTempConfig({
    prefix: 'collaboration-session-surface-',
    rootDir: PROJECT_ROOT,
    resourcesDir: PROJECT_ROOT,
    defaultCwd: PROJECT_ROOT,
    cwdAllowlistRoots: [PROJECT_ROOT],
  })
  tempHandles.push(handle)
  return handle.config
}

describe('collaboration session surface metadata', () => {
  it('detects collab sessions, preserves collab metadata, and validates protocol-shaped descriptors', () => {
    const collabDescriptor = createDescriptor({
      agentId: 'collab-1',
      sessionSurface: 'collab',
      collab: {
        workspaceId: 'workspace-1',
        channelId: 'channel-1',
      },
    })

    expect(isCollabSession(collabDescriptor)).toBe(true)
    expect(isCollabSession({ sessionSurface: 'builder' })).toBe(false)
    expect(getCollabSessionInfo(collabDescriptor)).toEqual({
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
    })

    const cloned = cloneDescriptor(collabDescriptor)
    expect(cloned.sessionSurface).toBe('collab')
    expect(cloned.collab).toEqual({
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
    })
    expect(cloned.collab).not.toBe(collabDescriptor.collab)

    const protocolDescriptor: ProtocolAgentDescriptor = {
      ...collabDescriptor,
      sessionSurface: 'collab',
      collab: {
        workspaceId: 'workspace-1',
        channelId: 'channel-1',
      },
    }
    const validated = validateAgentDescriptor(JSON.parse(JSON.stringify(protocolDescriptor)) as unknown)
    expect(typeof validated).not.toBe('string')
    if (typeof validated === 'string') {
      throw new Error(validated)
    }
    expect(validated.sessionSurface).toBe('collab')
    expect(validated.collab).toEqual({
      workspaceId: 'workspace-1',
      channelId: 'channel-1',
    })

    expect(validateAgentDescriptor({ ...createDescriptor(), sessionSurface: 'shared' })).toBe(
      'sessionSurface must be "builder" or "collab" when provided',
    )
    expect(() => assertBuilderSession({ agentId: 'collab-1', sessionSurface: 'collab' }, 'reset Builder sessions')).toThrow(
      'Cannot reset Builder sessions for collaboration-backed session collab-1.',
    )
  })

  it('hides collab sessions from Builder-facing manager lists', async () => {
    const manager = new TestSwarmManagerBase(await makeConfig())
    const builderDescriptor = createDescriptor({
      agentId: 'builder-1',
      managerId: 'builder-1',
      profileId: 'profile-1',
      sessionSurface: 'builder',
    })
    const collabDescriptor = createDescriptor({
      agentId: 'collab-1',
      managerId: 'collab-1',
      profileId: 'profile-1',
      sessionSurface: 'collab',
      collab: {
        workspaceId: 'workspace-1',
        channelId: 'channel-1',
      },
    })

    seedDescriptors(manager, [builderDescriptor, collabDescriptor])

    expect(manager.listBootstrapAgents().map((descriptor) => descriptor.agentId)).toEqual(['builder-1'])
    expect(manager.listManagerAgents().map((descriptor) => descriptor.agentId)).toEqual(['builder-1'])
    expect(manager.listAgents().map((descriptor) => descriptor.agentId)).toEqual(['builder-1', 'collab-1'])
  })

  it('creates collab sessions from explicit base descriptors without eagerly initializing a runtime', async () => {
    const manager = new CollabLazyRuntimeSwarmManager(await makeConfig())
    await bootWithDefaultManager(manager, manager.getConfig())
    manager.runtimeCreateCalls.length = 0

    await manager.ensureCollaborationStorageProfile()

    const sessionAgentId = 'collab-channel-session-1'
    const base = {
      model: {
        provider: 'anthropic',
        modelId: 'claude-collab-base',
        thinkingLevel: 'high',
      },
      cwd: join(manager.getConfig().paths.dataDir, 'profiles', '_collaboration', 'sessions', sessionAgentId, 'workspace'),
      archetypeId: 'collaboration-channel',
      sessionSystemPrompt: 'Workspace prompt',
    }

    const created = await manager.createSessionFromBaseDescriptor(
      '_collaboration',
      base,
      {
        label: 'General',
        name: 'General',
        sessionAgentId,
      },
      {
        sessionSurface: 'collab',
        collab: {
          workspaceId: 'workspace-1',
          channelId: 'channel-1',
        },
      },
    )

    expect(created.sessionAgent).toMatchObject({
      agentId: sessionAgentId,
      profileId: '_collaboration',
      sessionSurface: 'collab',
      collab: {
        workspaceId: 'workspace-1',
        channelId: 'channel-1',
      },
      model: base.model,
      cwd: base.cwd,
      archetypeId: base.archetypeId,
      sessionSystemPrompt: base.sessionSystemPrompt,
    })
    expect(manager.runtimeCreateCalls).toEqual([])
    expect(manager.listManagerAgents().some((descriptor) => descriptor.agentId === sessionAgentId)).toBe(false)
    expect(manager.listAgents().find((descriptor) => descriptor.agentId === sessionAgentId)).toMatchObject({
      sessionSurface: 'collab',
    })
    await expect(readSessionMeta(manager.getConfig().paths.dataDir, '_collaboration', sessionAgentId)).resolves.toMatchObject({
      cwd: base.cwd,
      label: 'General',
    })

    await expect(
      manager.dispatchRuntimeUserMessage({
        targetAgentId: created.sessionAgent.agentId,
        text: 'hello',
        sourceContext: { channel: 'web' },
      }),
    ).rejects.toThrow(`runtime unavailable for ${created.sessionAgent.agentId}`)
    expect(manager.runtimeCreateCalls).toEqual([created.sessionAgent.agentId])
  })

  it('does not let returned collab metadata mutation leak back into the live session descriptor', async () => {
    const manager = new CollabLazyRuntimeSwarmManager(await makeConfig())
    await bootWithDefaultManager(manager, manager.getConfig())

    await manager.ensureCollaborationStorageProfile()

    const sessionAgentId = 'collab-channel-session-2'
    const created = await manager.createSessionFromBaseDescriptor(
      '_collaboration',
      {
        model: {
          provider: 'anthropic',
          modelId: 'claude-collab-base',
          thinkingLevel: 'high',
        },
        cwd: join(manager.getConfig().paths.dataDir, 'profiles', '_collaboration', 'sessions', sessionAgentId, 'workspace'),
        archetypeId: 'collaboration-channel',
      },
      {
        label: 'Ops',
        name: 'Ops',
        sessionAgentId,
      },
      {
        sessionSurface: 'collab',
        collab: {
          workspaceId: 'workspace-1',
          channelId: 'channel-2',
        },
      },
    )

    if (!created.sessionAgent.collab) {
      throw new Error('expected collab metadata on created session')
    }
    created.sessionAgent.collab.channelId = 'mutated-channel'
    created.sessionAgent.collab.workspaceId = 'mutated-workspace'

    expect(manager.getAgent(sessionAgentId)).toMatchObject({
      sessionSurface: 'collab',
      collab: {
        workspaceId: 'workspace-1',
        channelId: 'channel-2',
      },
    })
  })

  it('keeps the Builder stop guard while exposing a collab-only stop helper', async () => {
    const manager = new TestSwarmManagerBase(await makeConfig())
    await bootWithDefaultManager(manager, manager.getConfig())

    await manager.ensureCollaborationStorageProfile()

    const sessionAgentId = 'collab-channel-session-stop'
    const created = await manager.createSessionFromBaseDescriptor(
      '_collaboration',
      {
        model: {
          provider: 'anthropic',
          modelId: 'claude-collab-base',
          thinkingLevel: 'high',
        },
        cwd: join(manager.getConfig().paths.dataDir, 'profiles', '_collaboration', 'sessions', sessionAgentId, 'workspace'),
        archetypeId: 'collaboration-channel',
      },
      {
        label: 'Archive target',
        name: 'Archive target',
        sessionAgentId,
      },
      {
        sessionSurface: 'collab',
        collab: {
          workspaceId: 'workspace-1',
          channelId: 'channel-stop',
        },
      },
    )

    await manager.dispatchRuntimeUserMessage({
      targetAgentId: created.sessionAgent.agentId,
      text: 'hello',
      sourceContext: { channel: 'web' },
    })

    const runtime = manager.runtimeByAgentId.get(sessionAgentId)
    expect(runtime).toBeTruthy()

    await expect(manager.stopSession(sessionAgentId)).rejects.toThrow(
      `Cannot stop Builder sessions for collaboration-backed session ${sessionAgentId}.`,
    )

    await expect(manager.stopCollaborationSession(sessionAgentId)).resolves.toEqual({
      terminatedWorkerIds: [],
    })
    expect(runtime?.terminateCalls).toHaveLength(1)
    expect(runtime?.terminateCalls[0]).toMatchObject({ abort: true })
    expect(manager.getAgent(sessionAgentId)).toMatchObject({
      agentId: sessionAgentId,
      sessionSurface: 'collab',
      status: 'idle',
    })
  })
})
