import { mkdir, readFile } from 'node:fs/promises'
import { Value } from '@sinclair/typebox/value'
import { MAX_RECENT_WORK_PLAN_SNAPSHOTS } from '@forge/protocol'
import { describe, expect, it, vi } from 'vitest'
import { buildTaskTool, normalizeTaskToolInput, taskToolSchema, type TaskToolResult } from '../coordination/task-tool.js'
import { WorkPlanImmutableError, WorkPlanItemResolutionError, WorkPlanNotFoundError } from '../coordination/work-plan-service.js'
import { WorkPlanLinkValidationError } from '../coordination/work-plan-link-validation.js'
import { ARCHIVED_PROJECT_OPERATION_MESSAGE } from '../archive/archive-resolver.js'
import { getSessionTasksPath } from '../storage/data-paths.js'
import type { AgentDescriptor, SwarmConfig } from '../types.js'
import type { SwarmToolHost } from '../swarm-tool-host.js'
import type { RuntimeCreationOptions, SwarmAgentRuntime } from '../runtime-contracts.js'
import { FakeRuntime, TestSwarmManager as TestSwarmManagerBase, bootWithDefaultManager, makeTempConfig as buildTempConfig } from '../../test-support/index.js'

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

async function makeTempConfig(port = 8894): Promise<SwarmConfig> {
  return buildTempConfig({
    prefix: 'task-tool-',
    port,
    omitSharedAuthFile: true,
    omitSharedSecretsFile: true,
    skipRepoMemorySkillPlaceholder: true,
  })
}

describe('task tool schema', () => {
  it('keeps provider-facing parameters as a root object schema', () => {
    expect((taskToolSchema as { type?: string }).type).toBe('object')
    expect((taskToolSchema as { anyOf?: unknown }).anyOf).toBeUndefined()

    expect(Value.Check(taskToolSchema, { action: 'get' })).toBe(true)
    expect(Value.Check(taskToolSchema, {
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: '[active] One item',
    })).toBe(true)
    expect(Value.Check(taskToolSchema, {
      action: 'update_item_status',
      planId: 'plan-1',
      itemId: 'item-1',
      status: 'done',
    })).toBe(true)
    expect(Value.Check(taskToolSchema, {
      action: 'link',
      planId: 'plan-1',
      itemId: 'item-1',
      link: { type: 'worker', agentId: 'worker-1' },
    })).toBe(true)
    expect(Value.Check(taskToolSchema, {
      action: 'finish_plan',
      planId: 'plan-1',
      status: 'completed_with_warnings',
      finalSummary: 'Done',
      warnings: ['Needs follow-up'],
    })).toBe(true)

    expect(Value.Check(taskToolSchema, { action: 'unknown' })).toBe(false)
    expect(Value.Check(taskToolSchema, { action: 'get', expectedStateRevision: -1 })).toBe(false)
    expect(Value.Check(taskToolSchema, {
      action: 'upsert_plan',
      title: 'Plan title',
      status: 'not-a-status',
    })).toBe(false)
    expect(Value.Check(taskToolSchema, {
      action: 'upsert_plan',
      title: 'Plan title',
      items: [{ title: 'One item', status: 'active' }],
    })).toBe(false)
    expect(Value.Check(taskToolSchema, {
      action: 'upsert_plan',
      title: 'Plan title',
      items: [],
    })).toBe(false)
    expect(Value.Check(taskToolSchema, {
      action: 'link',
      planId: 'plan-1',
      link: { type: 'worker', agentId: 'worker-1' },
      note: 'not allowed',
    })).toBe(false)
    expect(Value.Check(taskToolSchema, {
      action: 'finish_plan',
      planId: 'plan-1',
      status: 'completed',
      finalSummary: 'Done',
      warnings: [],
    })).toBe(false)
  })

  it('normalization enforces action-specific fields beyond the provider-safe schema', () => {
    expect(() => normalizeTaskToolInput({ action: 'get', expectedStateRevision: 0 })).toThrow(
      'task.get does not accept expectedStateRevision',
    )
    expect(() => normalizeTaskToolInput({
      action: 'link',
      planId: 'plan-1',
      link: { type: 'worker', agentId: 'worker-1' },
      finalSummary: 'not allowed',
    })).toThrow('task.link does not accept finalSummary')
    expect(() => normalizeTaskToolInput({
      action: 'finish_plan',
      planId: 'plan-1',
      status: 'done',
      finalSummary: 'Done',
    })).toThrow('For task.finish_plan, status must be one of:')
    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      planId: 'plan-1',
      status: 'done',
    })).toThrow('For task.upsert_plan, status must be one of:')
  })

  it('documents create-time itemsText as the only provider-facing item-entry shape', () => {
    const tool = buildTaskTool({ runTaskTool: vi.fn() } as unknown as SwarmToolHost, {
      agentId: 'manager',
    } as AgentDescriptor)

    expect(tool.description).toContain('Provider-facing `upsert_plan` supports top-level plan fields plus create-time `itemsText` only')
    expect(tool.description).toContain('update_item_status')
    expect(tool.description).toContain('Expected state conflicts may return `{ ok: false')
    expect(tool.description).toContain('Do not send nested item arrays')
    expect((taskToolSchema as { description?: string }).description).toContain('Recoverable conflicts return ok:false')
  })

  it('normalizes itemsText into bounded item objects and tolerates empty artifact items fields', () => {
    expect(normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: '[active] Create plan',
    })).toMatchObject({
      action: 'upsert_plan',
      title: 'Plan title',
      items: [{ title: 'Create plan', status: 'active' }],
      itemsText: '[active] Create plan',
    })
    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: '[active] Create plan',
      items: [],
    })).toThrow('no longer accepts structured items arrays')
    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      items: [{ title: 'One item' }],
    })).toThrow('no longer accepts structured items arrays')
    expect(normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: '[active] Create plan',
      items: null,
    })).toMatchObject({
      items: [{ title: 'Create plan', status: 'active' }],
    })

    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      planId: 'plan-1',
      itemsText: '[active] Attempt update',
    })).toThrow('itemsText is only allowed when creating a new plan')
    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      items: [{ title: 'One item' }],
      itemsText: '[active] Mixed source',
    })).toThrow('no longer accepts structured items arrays')
    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: '[{"title":"Bad json"}]',
    })).toThrow('itemsText must be plain one-item-per-line text, not JSON')
    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: '[active] {"title":"Bad json"}',
    })).toThrow('line 1 cannot contain JSON-like item text')
    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: '- [{"title":"Bad json"}]',
    })).toThrow('line 1 cannot contain JSON-like item text')
    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: '[active] legit {"title":"bad"}',
    })).toThrow('line 1 cannot contain JSON-like item text')
    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: '[active] legit [{"title":"bad"}]',
    })).toThrow('line 1 cannot contain JSON-like item text')
    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: '[active] legit [1,2]',
    })).toThrow('line 1 cannot contain JSON-like item text')
    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: '[active] legit [true]',
    })).toThrow('line 1 cannot contain JSON-like item text')
    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: '[active] legit [null]',
    })).toThrow('line 1 cannot contain JSON-like item text')
    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: '[later] Unsupported status',
    })).toThrow('uses unknown item status')
    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: '[active] https://example.com',
    })).toThrow('itemsText cannot contain JSON, links, or reference syntax')
    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: Array.from({ length: 26 }, (_, index) => `[todo] Item ${index + 1}`).join('\n'),
    })).toThrow('must contain at most 25 non-empty lines')
    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: 'x'.repeat(6000),
    })).toThrow('itemsText must be at most')
    expect(() => normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      items: '[{"title":"Bad json"}]',
    })).toThrow('no longer accepts items as a string')
  })

  it('normalizes update_item_status and rejects invalid item statuses', () => {
    expect(normalizeTaskToolInput({
      action: 'update_item_status',
      planId: 'plan-1',
      itemId: 'item-1',
      status: 'done',
    })).toEqual({
      action: 'update_item_status',
      planId: 'plan-1',
      itemId: 'item-1',
      status: 'done',
    })

    expect(() => normalizeTaskToolInput({
      action: 'update_item_status',
      planId: 'plan-1',
      itemId: 'item-1',
      status: 'completed',
    })).toThrow('For task.update_item_status, status must be one of:')
  })

  it('normalizes multi-line itemsText into bounded item objects', () => {
    expect(normalizeTaskToolInput({
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: '[done] Create plan\n- [active] Observe snapshot\nPlain fallback item',
    })).toMatchObject({
      action: 'upsert_plan',
      title: 'Plan title',
      items: [
        { title: 'Create plan', status: 'done' },
        { title: 'Observe snapshot', status: 'active' },
        { title: 'Plain fallback item', status: 'todo' },
      ],
    })
  })

  it('delegates raw provider params to host.runTaskTool', async () => {
    const runTaskTool = vi.fn(async () => ({
      action: 'get',
      stateRevision: 3,
      snapshot: {
        sessionAgentId: 'manager',
        profileId: 'profile-1',
        revision: 3,
        activeWorkPlan: null,
        recentWorkPlans: [],
        recentWorkPlanCount: 0,
        recentWorkPlansTruncated: false,
      },
    } satisfies TaskToolResult))

    const host = { runTaskTool } as unknown as SwarmToolHost
    const descriptor = { agentId: 'manager' } as AgentDescriptor
    const tool = buildTaskTool(host, descriptor)

    const result = await tool.execute('tool-1', { action: 'get' }, undefined, undefined, undefined as any)
    await tool.execute('tool-2', {
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: '[active] Create plan',
    }, undefined, undefined, undefined as any)

    expect(runTaskTool).toHaveBeenNthCalledWith(1, 'manager', 'tool-1', { action: 'get' })
    expect(runTaskTool).toHaveBeenNthCalledWith(2, 'manager', 'tool-2', {
      action: 'upsert_plan',
      title: 'Plan title',
      itemsText: '[active] Create plan',
    })
    expect(result.details).toMatchObject({ action: 'get', stateRevision: 3 })
  })
})

describe.skip('SwarmManager.runTaskTool legacy Active Work behavior (parked on rollback branch)', () => {
  it('is manager-only and rejects worker callers directly', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const worker = await manager.spawnAgent('manager', { agentId: 'task-worker' })

    await expect(
      manager.runTaskTool(worker.agentId, 'tool-1', { action: 'get' }),
    ).rejects.toThrow('task is only available to manager sessions.')
  })

  it('creates a plan through buildTaskTool.execute without tripping mixed items/itemsText normalization', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const descriptor = manager.getAgent('manager')!
    const tool = buildTaskTool(manager as unknown as SwarmToolHost, descriptor)
    const result = await tool.execute('tool-build-execute', {
      action: 'upsert_plan',
      title: 'Build tool execute path',
      itemsText: '[active] Create plan through execute',
    }, undefined, undefined, undefined as any)

    expect(result.details).toMatchObject({
      action: 'upsert_plan',
      status: 'active',
      planRevision: 1,
    })
    expect(result.details).not.toHaveProperty('snapshot')
    expect((result.content[0] as { text: string }).text).not.toContain('recentWorkPlans')
  })

  it('finishing a provider-facing plan closes open items but preserves explicit failed/unknown evidence', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.runTaskTool('manager', 'tool-provider-finish-1', {
      action: 'upsert_plan',
      title: 'Provider-facing finish closeout',
      itemsText: '[active] Investigate backend\n[todo] Summarize outcome\n[failed] Known failure\n[unknown] Unknown outcome',
    })

    const worker = await manager.spawnAgent('manager', { agentId: 'provider-finish-worker' })
    const linked = await manager.runTaskTool('manager', 'tool-provider-finish-2', {
      action: 'link',
      expectedStateRevision: created.stateRevision,
      planId: created.planId,
      itemId: created.createdItemIds?.[0],
      link: { type: 'worker', agentId: worker.agentId },
    })

    const finished = await manager.runTaskTool('manager', 'tool-provider-finish-3', {
      action: 'finish_plan',
      expectedStateRevision: linked.stateRevision,
      planId: created.planId,
      status: 'completed',
      finalSummary: 'Done',
    })

    expect(finished).toMatchObject({
      action: 'finish_plan',
      stateRevision: 3,
      planId: created.planId,
      planRevision: 3,
      status: 'completed',
    })
    expect(finished).not.toHaveProperty('snapshot')

    const fetched = await manager.runTaskTool('manager', 'tool-provider-finish-4', { action: 'get' })
    expect(fetched.snapshot.activeWorkPlan).toBeNull()
    expect(fetched.snapshot.recentWorkPlans[0]).toMatchObject({
      planId: created.planId,
      status: 'completed',
      items: [
        { status: 'done', workerLinks: [{ agentId: worker.agentId }] },
        { status: 'done' },
        { status: 'failed' },
        { status: 'unknown' },
      ],
    })
  })

  it('returns recoverable results for stale plan mutations without retargeting another plan', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.runTaskTool('manager', 'tool-stale-1', {
      action: 'upsert_plan',
      title: 'Stale mutation target',
      itemsText: '[active] Keep original item active',
    })

    const staleFinish = await manager.runTaskTool('manager', 'tool-stale-2', {
      action: 'finish_plan',
      planId: 'plan-stale',
      status: 'completed',
      finalSummary: 'Should not retarget',
    })
    expect(staleFinish).toMatchObject({
      action: 'finish_plan',
      ok: false,
      error: {
        code: 'work_plan_not_found',
        recoverable: true,
        suggestedAction: 'task.get',
      },
      stateRevision: created.stateRevision,
      activePlan: {
        planId: created.planId,
        status: 'active',
      },
    })
    expect(staleFinish).not.toHaveProperty('snapshot')

    const staleItem = await manager.runTaskTool('manager', 'tool-stale-3', {
      action: 'update_item_status',
      expectedStateRevision: created.stateRevision,
      planId: created.planId,
      itemId: 'item-stale',
      status: 'done',
    })
    expect(staleItem).toMatchObject({
      action: 'update_item_status',
      ok: false,
      error: {
        code: 'item_resolution_failed',
        recoverable: true,
        suggestedAction: 'task.get',
      },
      stateRevision: created.stateRevision,
      activePlan: {
        planId: created.planId,
        status: 'active',
      },
    })

    const fetched = await manager.runTaskTool('manager', 'tool-stale-4', { action: 'get' })
    expect(fetched.snapshot.activeWorkPlan).toMatchObject({
      planId: created.planId,
      status: 'active',
      items: [{ itemId: created.createdItemIds?.[0], status: 'active' }],
    })
  })

  it('returns recoverable results when an active plan exists or a terminal plan is immutable', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.runTaskTool('manager', 'tool-conflict-1', {
      action: 'upsert_plan',
      title: 'Existing active plan',
      itemsText: '[todo] One item',
    })

    const duplicate = await manager.runTaskTool('manager', 'tool-conflict-2', {
      action: 'upsert_plan',
      title: 'Duplicate active plan',
      itemsText: '[todo] Another item',
    })
    expect(duplicate).toMatchObject({
      action: 'upsert_plan',
      ok: false,
      error: {
        code: 'active_plan_exists',
        recoverable: true,
        suggestedAction: 'task.get',
      },
      stateRevision: created.stateRevision,
      activePlan: { planId: created.planId, status: 'active' },
    })

    const finished = await manager.runTaskTool('manager', 'tool-conflict-3', {
      action: 'finish_plan',
      expectedStateRevision: created.stateRevision,
      planId: created.planId,
      status: 'completed',
      finalSummary: 'Done',
    })
    const immutable = await manager.runTaskTool('manager', 'tool-conflict-4', {
      action: 'update_item_status',
      expectedStateRevision: finished.stateRevision,
      planId: created.planId,
      itemId: created.createdItemIds?.[0]!,
      status: 'done',
    })
    expect(immutable).toMatchObject({
      action: 'update_item_status',
      ok: false,
      error: {
        code: 'work_plan_immutable',
        recoverable: true,
        suggestedAction: 'task.get',
      },
      stateRevision: finished.stateRevision,
    })
    expect(immutable).not.toHaveProperty('activePlan')
  })

  it('emits a durable creation row before live task snapshots after successful task mutations', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const snapshots: Array<Record<string, unknown>> = []
    const creationRows: Array<Record<string, unknown>> = []
    const liveEventOrder: string[] = []
    manager.on('work_plan_created', (event: Record<string, unknown>) => {
      if (event.agentId === 'manager') {
        creationRows.push(event)
        liveEventOrder.push('work_plan_created')
      }
    })
    manager.on('session_task_state_snapshot', (event: Record<string, unknown>) => {
      if (event.sessionAgentId === 'manager') {
        snapshots.push(event)
        liveEventOrder.push('session_task_state_snapshot')
      }
    })

    const created = await manager.runTaskTool('manager', 'tool-live-1', {
      action: 'upsert_plan',
      title: 'Emit live snapshot',
      itemsText: '[active] Create plan',
    })
    expect(created).not.toHaveProperty('workPlan')
    expect(created).not.toHaveProperty('snapshot')
    expect(creationRows).toHaveLength(1)
    expect(creationRows[0]).toMatchObject({
      type: 'work_plan_created',
      agentId: 'manager',
      planId: created.planId,
      stateRevision: created.stateRevision,
      planRevision: created.planRevision,
      plan: { planId: created.planId, title: 'Emit live snapshot', revision: created.planRevision },
    })
    expect(typeof creationRows[0]?.id).toBe('string')
    expect(manager.getConversationHistory('manager').filter((entry) => entry.type === 'work_plan_created')).toHaveLength(1)
    expect(liveEventOrder).toEqual(['work_plan_created', 'session_task_state_snapshot'])
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      sessionAgentId: 'manager',
      revision: created.stateRevision,
      activeWorkPlan: { title: 'Emit live snapshot' },
    })

    const revised = await manager.runTaskTool('manager', 'tool-live-1b', {
      action: 'update_item_status',
      expectedStateRevision: created.stateRevision,
      planId: created.planId,
      itemId: created.createdItemIds?.[0]!,
      status: 'done',
    })
    expect(revised).toMatchObject({
      action: 'update_item_status',
      updatedItemId: created.createdItemIds?.[0],
      status: 'active',
    })
    expect(revised).not.toHaveProperty('snapshot')
    expect(creationRows).toHaveLength(1)
    expect(snapshots).toHaveLength(2)

    const worker = await manager.spawnAgent('manager', { agentId: 'live-linked-worker' })
    const linked = await manager.runTaskTool('manager', 'tool-live-2', {
      action: 'link',
      expectedStateRevision: revised.stateRevision,
      planId: created.planId,
      itemId: created.createdItemIds?.[0],
      link: { type: 'worker', agentId: worker.agentId },
    })
    expect(linked).toMatchObject({
      action: 'link',
      linkedItemId: created.createdItemIds?.[0],
      status: 'active',
    })
    expect(linked).not.toHaveProperty('snapshot')
    expect(creationRows).toHaveLength(1)
    expect(snapshots).toHaveLength(3)
    expect(snapshots[2]).toMatchObject({
      sessionAgentId: 'manager',
      revision: linked.stateRevision,
      activeWorkPlan: { items: [{ workerLinks: [{ agentId: worker.agentId }] }] },
    })

    const finished = await manager.runTaskTool('manager', 'tool-live-3', {
      action: 'finish_plan',
      expectedStateRevision: linked.stateRevision,
      planId: created.planId,
      status: 'completed',
      finalSummary: 'Done',
    })
    expect(finished).toMatchObject({
      action: 'finish_plan',
      status: 'completed',
    })
    expect(finished).not.toHaveProperty('snapshot')
    expect(creationRows).toHaveLength(1)
    expect(snapshots).toHaveLength(4)
    expect(snapshots[3]).toMatchObject({
      sessionAgentId: 'manager',
      revision: finished.stateRevision,
      activeWorkPlan: null,
    })
  })

  it.each([8, 24, 100])(
    'creates a new task tool plan after %i retained terminal historical plans',
    async (historyCount) => {
      const config = await makeTempConfig()
      const manager = new TestSwarmManager(config)
      await bootWithDefaultManager(manager, config)
      let expectedStateRevision: number | undefined
      let firstHistoricalPlanId: string | undefined

      for (let index = 1; index <= historyCount; index += 1) {
        const created = await manager.runTaskTool('manager', `tool-history-${historyCount}-create-${index}`, {
          action: 'upsert_plan',
          expectedStateRevision,
          title: `Historical plan ${index}`,
          itemsText: `[active] Historical item ${index}`,
        })
        firstHistoricalPlanId ??= created.planId
        const finished = await manager.runTaskTool('manager', `tool-history-${historyCount}-finish-${index}`, {
          action: 'finish_plan',
          expectedStateRevision: created.stateRevision,
          planId: created.planId,
          status: 'completed',
          finalSummary: `Finished ${index}`,
        })
        expectedStateRevision = finished.stateRevision
      }

      const createdNext = await manager.runTaskTool('manager', `tool-history-${historyCount}-create-next`, {
        action: 'upsert_plan',
        expectedStateRevision,
        title: `Plan ${historyCount + 1}`,
        itemsText: '[active] Continue after retained history',
      })

      expect(createdNext).toMatchObject({
        action: 'upsert_plan',
        status: 'active',
      })
      expect(createdNext).not.toHaveProperty('snapshot')

      const fetched = await manager.runTaskTool('manager', `tool-history-${historyCount}-get`, { action: 'get' })
      expect(fetched.snapshot.activeWorkPlan?.planId).toBe(createdNext.planId)
      expect(fetched.snapshot.recentWorkPlanCount).toBe(historyCount)
      expect(fetched.snapshot.recentWorkPlans).toHaveLength(Math.min(historyCount, MAX_RECENT_WORK_PLAN_SNAPSHOTS))
      expect(fetched.snapshot.recentWorkPlansTruncated).toBe(historyCount > MAX_RECENT_WORK_PLAN_SNAPSHOTS)

      const tasksFile = JSON.parse(await readFile(getSessionTasksPath(config.paths.dataDir, 'manager', 'manager'), 'utf8')) as {
        workPlans: Array<{ planId: string }>
      }
      expect(tasksFile.workPlans).toHaveLength(historyCount + 1)
      expect(tasksFile.workPlans[0]?.planId).toBe(firstHistoricalPlanId)
      expect(tasksFile.workPlans.map((plan) => plan.planId)).toContain(createdNext.planId)
    },
  )

  it('creates, gets, links, finishes, and CAS-protects the current session work plan', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.runTaskTool('manager', 'tool-1', {
      action: 'upsert_plan',
      title: 'Implement WP4',
      itemsText: '[active] Build task tool',
      revisionNote: 'Created plan',
    })

    expect(created).toMatchObject({
      action: 'upsert_plan',
      stateRevision: 1,
      planRevision: 1,
      status: 'active',
    })
    expect(created).not.toHaveProperty('snapshot')
    expect(created.createdItemIds).toHaveLength(1)

    const fetched = await manager.runTaskTool('manager', 'tool-2', { action: 'get' })
    expect(fetched).toMatchObject({ action: 'get', stateRevision: 1, snapshot: { activeWorkPlan: { title: 'Implement WP4' } } })

    const worker = await manager.spawnAgent('manager', { agentId: 'linked-worker' })
    const linked = await manager.runTaskTool('manager', 'tool-3', {
      action: 'link',
      expectedStateRevision: created.stateRevision,
      planId: created.planId,
      itemId: created.createdItemIds?.[0],
      link: { type: 'worker', agentId: worker.agentId },
    })

    expect(linked).toMatchObject({
      action: 'link',
      stateRevision: 2,
      linkedItemId: created.createdItemIds?.[0],
      status: 'active',
    })
    expect(linked).not.toHaveProperty('snapshot')

    const revised = await manager.runTaskTool('manager', 'tool-4', {
      action: 'update_item_status',
      expectedStateRevision: linked.stateRevision,
      planId: created.planId,
      itemId: created.createdItemIds?.[0]!,
      status: 'done',
    })

    expect(revised).toMatchObject({
      action: 'update_item_status',
      stateRevision: 3,
      updatedItemId: created.createdItemIds?.[0],
      status: 'active',
    })
    expect(revised).not.toHaveProperty('snapshot')

    const unsafeRewrite = await manager.runTaskTool('manager', 'tool-5', {
      action: 'upsert_plan',
      expectedStateRevision: revised.stateRevision,
      planId: created.planId,
      itemsText: '[done] Attempt unsafe rewrite',
    })
    expect(unsafeRewrite).toMatchObject({
      action: 'upsert_plan',
      ok: false,
      error: {
        code: 'validation_error',
        message: 'task.upsert_plan itemsText is only allowed when creating a new plan. Provider-facing task calls cannot revise an existing plan item list in v1.',
        recoverable: true,
        suggestedAction: 'retry',
      },
      stateRevision: revised.stateRevision,
      activePlan: { planId: created.planId, status: 'active' },
    })

    const conflict = await manager.runTaskTool('manager', 'tool-6', {
      action: 'upsert_plan',
      expectedStateRevision: 0,
      planId: created.planId,
      title: 'Conflicting update',
    })
    expect(conflict).toMatchObject({
      action: 'upsert_plan',
      ok: false,
      error: {
        code: 'state_revision_conflict',
        message: 'Active Work changed since your last snapshot. Call `task.get` to refresh, then retry with the latest `stateRevision`.',
        recoverable: true,
        suggestedAction: 'task.get',
      },
      stateRevision: revised.stateRevision,
      activePlan: { planId: created.planId, status: 'active' },
    })
    expect(conflict).not.toHaveProperty('snapshot')

    const finished = await manager.runTaskTool('manager', 'tool-7', {
      action: 'finish_plan',
      expectedStateRevision: revised.stateRevision,
      planId: created.planId,
      status: 'completed',
      finalSummary: 'Done',
    })

    expect(finished).toMatchObject({
      action: 'finish_plan',
      stateRevision: 4,
      planId: created.planId,
      planRevision: 4,
      status: 'completed',
    })
    expect(finished).not.toHaveProperty('snapshot')
  })

  it('keeps disabled Active Work Plans as a hard task tool failure', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    await manager.applyWorkPlansSettingsChange(false)

    await expect(
      manager.runTaskTool('manager', 'tool-disabled', { action: 'get' }),
    ).rejects.toThrow('Active Work Plans are disabled in Settings.')
  })

  it('rejects archived and non-running manager task mutations before mutating task state', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.runTaskTool('manager', 'tool-gate-1', {
      action: 'upsert_plan',
      title: 'Gate task mutations',
      itemsText: '[active] Preserve state',
    })
    const tasksPath = getSessionTasksPath(config.paths.dataDir, 'manager', 'manager')
    const before = await readFile(tasksPath, 'utf8')

    const profiles = (manager as unknown as { profiles: Map<string, { archivedAt?: string }> }).profiles
    profiles.get('manager')!.archivedAt = '2026-05-30T00:00:00.000Z'
    await expect(
      manager.runTaskTool('manager', 'tool-gate-2', {
        action: 'finish_plan',
        planId: created.planId,
        status: 'completed',
        finalSummary: 'Should be blocked',
      }),
    ).rejects.toThrow(ARCHIVED_PROJECT_OPERATION_MESSAGE)
    expect(await readFile(tasksPath, 'utf8')).toBe(before)

    profiles.get('manager')!.archivedAt = undefined
    const descriptors = (manager as unknown as { descriptors: Map<string, AgentDescriptor> }).descriptors
    descriptors.get('manager')!.status = 'stopped'
    await expect(
      manager.runTaskTool('manager', 'tool-gate-3', {
        action: 'finish_plan',
        planId: created.planId,
        status: 'completed',
        finalSummary: 'Should still be blocked',
      }),
    ).rejects.toThrow('Manager is not running: manager')
    expect(await readFile(tasksPath, 'utf8')).toBe(before)
  })

  it('maps store-unavailable failures to the safe generic tool error', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const { sessionAgent } = await manager.createSession('manager', { label: 'Unavailable Task Session' })

    await mkdir(getSessionTasksPath(config.paths.dataDir, 'manager', sessionAgent.agentId), { recursive: true })

    await expect(
      manager.runTaskTool(sessionAgent.agentId, 'tool-1', { action: 'get' }),
    ).rejects.toThrow(
      'Active Work is temporarily unavailable because Forge could not safely read or preserve the saved task state. No changes were applied.',
    )
  })

  it('rejects Cortex sessions directly at the host seam', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const rootDescriptor = manager.getAgent('manager')!
    const { sessionAgent } = await manager.createSessionFromBaseDescriptor(
      'manager',
      {
        model: rootDescriptor.model,
        cwd: rootDescriptor.cwd,
        archetypeId: 'cortex',
      },
      { label: 'Cortex Task Session' },
    )

    await expect(
      manager.runTaskTool(sessionAgent.agentId, 'tool-cortex', { action: 'get' }),
    ).rejects.toThrow('task is not available for Cortex sessions.')
  })

  it('returns recoverable validation results for provider input-shape and warnings-rule errors', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const invalidNegativeRevision = await manager.runTaskTool('manager', 'tool-1', {
      action: 'upsert_plan',
      expectedStateRevision: -1 as never,
      title: 'Invalid revision',
      itemsText: '[todo] One item',
    } as never)
    expect(invalidNegativeRevision).toMatchObject({
      action: 'upsert_plan',
      ok: false,
      error: {
        code: 'validation_error',
        message: 'expectedStateRevision must be a non-negative integer',
        recoverable: true,
        suggestedAction: 'retry',
      },
      stateRevision: 0,
    })

    const invalidFractionalRevision = await manager.runTaskTool('manager', 'tool-2', {
      action: 'upsert_plan',
      expectedStateRevision: 1.5 as never,
      title: 'Invalid revision',
      itemsText: '[todo] One item',
    } as never)
    expect(invalidFractionalRevision).toMatchObject({
      action: 'upsert_plan',
      ok: false,
      error: {
        code: 'validation_error',
        message: 'expectedStateRevision must be a non-negative integer',
        recoverable: true,
        suggestedAction: 'retry',
      },
      stateRevision: 0,
    })

    const mixedItems = await manager.runTaskTool('manager', 'tool-3', {
      action: 'upsert_plan',
      title: 'Mixed source',
      items: [{ title: 'One item' }],
      itemsText: '[todo] One item',
    } as never)
    expect(mixedItems).toMatchObject({
      action: 'upsert_plan',
      ok: false,
      error: {
        code: 'validation_error',
        message: 'task.upsert_plan no longer accepts structured items arrays. Use create-time itemsText or task.update_item_status for item status changes.',
        recoverable: true,
        suggestedAction: 'retry',
      },
      stateRevision: 0,
    })

    const created = await manager.runTaskTool('manager', 'tool-4', {
      action: 'upsert_plan',
      title: 'Warnings required',
      itemsText: '[todo] One item',
    })

    const missingWarnings = await manager.runTaskTool('manager', 'tool-5', {
      action: 'finish_plan',
      expectedStateRevision: created.stateRevision,
      planId: created.planId,
      status: 'completed_with_warnings',
      finalSummary: 'Done',
    })
    expect(missingWarnings).toMatchObject({
      action: 'finish_plan',
      ok: false,
      error: {
        code: 'validation_error',
        message: 'warnings must include at least one entry when status is completed_with_warnings',
        recoverable: true,
        suggestedAction: 'retry',
      },
      stateRevision: created.stateRevision,
      activePlan: { planId: created.planId, status: 'active' },
    })
  })

  it('sanitizes unexpected read-path failures instead of leaking raw OS text or absolute paths', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const unsafeMessage = 'EACCES: permission denied, open /private/tmp/active-work/tasks.json'
    ;(manager as unknown as {
      createWorkPlanServiceForDescriptor: () => { get: () => Promise<never> }
    }).createWorkPlanServiceForDescriptor = () => ({
      get: async () => {
        throw new Error(unsafeMessage)
      },
    })

    const error = await manager.runTaskTool('manager', 'tool-read-unknown', { action: 'get' }).catch((cause) => cause)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Active Work failed unexpectedly. No changes were applied.')
    expect((error as Error).message).not.toContain('EACCES')
    expect((error as Error).message).not.toContain('/private/tmp/active-work/tasks.json')
  })

  it('sanitizes unexpected mutation-path failures instead of leaking raw OS text or absolute paths', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const unsafeMessage = 'ENOSPC: failed to rename /var/folders/tmp/tasks.json'
    ;(manager as unknown as {
      createWorkPlanServiceForDescriptor: () => { upsertPlan: () => Promise<never> }
    }).createWorkPlanServiceForDescriptor = () => ({
      upsertPlan: async () => {
        throw new Error(unsafeMessage)
      },
    })

    const error = await manager.runTaskTool('manager', 'tool-write-unknown', {
      action: 'upsert_plan',
      title: 'Should fail safely',
      itemsText: '[todo] One item',
    }).catch((cause) => cause)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Active Work failed unexpectedly. No changes were applied.')
    expect((error as Error).message).not.toContain('ENOSPC')
    expect((error as Error).message).not.toContain('/var/folders/tmp/tasks.json')
  })

  it('sanitizes reflected planId and worker agentId values in task-tool error mapping', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const unsafePlanId = 'https://example.invalid/plans/private?token=abc'
    const unsafeTerminalPlanId = '/Users/adam/private/tasks.json'
    const unsafeWorkerAgentId = 'file:///private/tmp/not-a-session-worker'
    const unsafeItemId = 'https://example.invalid/items/private?token=abc'

    ;(manager as unknown as {
      createWorkPlanServiceForDescriptor: () => {
        upsertPlan: (actor: unknown, input: { planId?: string }) => Promise<never>
        finishPlan: (actor: unknown, input: { planId: string }) => Promise<never>
        link: (actor: unknown, input: { link: { agentId: string }; itemId?: string }) => Promise<never>
      }
    }).createWorkPlanServiceForDescriptor = () => ({
      upsertPlan: async (_actor, input) => {
        throw new WorkPlanNotFoundError(input.planId ?? unsafePlanId)
      },
      finishPlan: async (_actor, input) => {
        throw new WorkPlanImmutableError(input.planId)
      },
      link: async (_actor, input) => {
        if (input.itemId === unsafeItemId) {
          throw new WorkPlanItemResolutionError(`Unknown work plan item: ${input.itemId}`)
        }
        throw new WorkPlanLinkValidationError(`Worker ${input.link.agentId} does not belong to this manager session.`)
      },
    })

    const notFoundResult = await manager.runTaskTool('manager', 'tool-not-found', {
      action: 'upsert_plan',
      planId: unsafePlanId,
      title: 'Existing title',
    })
    expect(notFoundResult).toMatchObject({
      action: 'upsert_plan',
      ok: false,
      error: {
        code: 'work_plan_not_found',
        message: 'The requested work plan no longer exists. Call `task.get` to refresh before retrying.',
        recoverable: true,
        suggestedAction: 'task.get',
      },
    })
    expect(JSON.stringify(notFoundResult)).not.toContain(unsafePlanId)

    const immutableResult = await manager.runTaskTool('manager', 'tool-immutable', {
      action: 'finish_plan',
      planId: unsafeTerminalPlanId,
      status: 'completed',
      finalSummary: 'Done',
    })
    expect(immutableResult).toMatchObject({
      action: 'finish_plan',
      ok: false,
      error: {
        code: 'work_plan_immutable',
        message: 'This work plan is already terminal and cannot be modified.',
        recoverable: true,
        suggestedAction: 'task.get',
      },
    })
    expect(JSON.stringify(immutableResult)).not.toContain(unsafeTerminalPlanId)

    const itemResolutionResult = await manager.runTaskTool('manager', 'tool-item-resolution', {
      action: 'link',
      planId: 'plan-1',
      itemId: unsafeItemId,
      link: { type: 'worker', agentId: 'worker-1' },
    })
    expect(itemResolutionResult).toMatchObject({
      action: 'link',
      ok: false,
      error: {
        code: 'item_resolution_failed',
        message: 'The requested work plan item could not be resolved. Call `task.get` to refresh before retrying.',
        recoverable: true,
        suggestedAction: 'task.get',
      },
    })
    expect(JSON.stringify(itemResolutionResult)).not.toContain(unsafeItemId)

    const invalidLinkError = await manager.runTaskTool('manager', 'tool-invalid-link', {
      action: 'link',
      planId: 'plan-1',
      itemId: 'item-1',
      link: { type: 'worker', agentId: unsafeWorkerAgentId },
    }).catch((cause) => cause)
    expect(invalidLinkError).toBeInstanceOf(Error)
    expect((invalidLinkError as Error).message).toBe('Worker links must target an existing worker owned by this manager session.')
    expect((invalidLinkError as Error).message).not.toContain(unsafeWorkerAgentId)
  })

  it('rejects non-worker link refs without introducing workflow semantics', async () => {
    const config = await makeTempConfig()
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const created = await manager.runTaskTool('manager', 'tool-1', {
      action: 'upsert_plan',
      title: 'Link only workers',
      itemsText: '[todo] One item',
    })

    await expect(
      manager.runTaskTool('manager', 'tool-2', {
        action: 'link',
        expectedStateRevision: created.stateRevision,
        planId: created.planId,
        itemId: created.createdItemIds?.[0],
        link: { type: 'artifact' as never, artifactId: 'artifact-1' } as never,
      }),
    ).rejects.toThrow('Only worker links are supported in Active Work v1.')
  })
})
