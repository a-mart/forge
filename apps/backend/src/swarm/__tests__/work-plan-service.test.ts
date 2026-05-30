import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEmptySessionCoordinationState, type WorkPlanRecord } from '../coordination/session-coordination-state.js'
import {
  SessionCoordinationStateRevisionConflictError,
  SessionCoordinationStore,
  SessionCoordinationStoreUnavailableError,
} from '../coordination/session-coordination-store.js'
import {
  toWorkPlanServiceErrorDescriptor,
  WorkPlanActiveInvariantError,
  WorkPlanImmutableError,
  WorkPlanItemResolutionError,
  WorkPlanService,
  WorkPlanServiceAuthorizationError,
  WorkPlanServiceValidationError,
  type WorkPlanLinkInput,
} from '../coordination/work-plan-service.js'
import { REDACTED_WORK_PLAN_TEXT } from '../coordination/work-plan-snapshot.js'
import { WorkPlanLinkValidationError, type WorkPlanActorContext } from '../coordination/work-plan-link-validation.js'
import type { AgentDescriptor } from '../types.js'
import { getSessionTasksPath } from '../storage/data-paths.js'
import { MAX_RECENT_WORK_PLAN_SNAPSHOTS } from '@forge/protocol'

const PROFILE_ID = 'profile-a'
const SESSION_ID = 'manager-a'
const FIXED_TIMESTAMP = '2026-05-29T12:00:00.000Z'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('work-plan-service', () => {
  it('returns an empty default snapshot when no sidecar exists', async () => {
    const dataDir = await createDataDir()
    const { service } = createHarness(dataDir)

    const snapshot = await service.loadSnapshot()

    expect(snapshot).toMatchObject({
      sessionAgentId: SESSION_ID,
      profileId: PROFILE_ID,
      revision: 0,
      activeWorkPlan: null,
      recentWorkPlans: [],
      recentWorkPlanCount: 0,
      recentWorkPlansTruncated: false,
      diagnostics: { state: 'defaulted' },
    })
  })

  it('projects bounded item/link/warning/recent-plan metadata honestly', async () => {
    const dataDir = await createDataDir()
    const { service, store } = createHarness(dataDir)

    await store.replace({
      ...createEmptySessionCoordinationState(),
      workPlans: [
        createPlan('Active plan', {
          revision: 3,
          items: Array.from({ length: 15 }, (_, index) =>
            createItem(`item-${index + 1}`, {
              status: index === 0 ? 'active' : 'todo',
              workerLinks: index === 0
                ? Array.from({ length: 6 }, (_, linkIndex) => ({
                    type: 'worker' as const,
                    linkId: `link-${linkIndex + 1}`,
                    agentId: `worker-${linkIndex + 1}`,
                    label: `Worker ${linkIndex + 1}`,
                    specialistId: linkIndex === 0 ? 'backend-specialist' : undefined,
                    linkedAt: FIXED_TIMESTAMP,
                  }))
                : [],
            }),
          ),
          revisionNotes: [
            { revision: 1, note: 'Initial plan', createdAt: FIXED_TIMESTAMP },
            { revision: 3, note: 'Latest revision note', createdAt: FIXED_TIMESTAMP },
          ],
          warnings: Array.from({ length: 6 }, (_, index) => `Warning ${index + 1}`),
        }),
        ...Array.from({ length: MAX_RECENT_WORK_PLAN_SNAPSHOTS + 2 }, (_, index) =>
          createPlan(`Recent ${index + 1}`, {
            planId: `recent-${index + 1}`,
            status: 'completed',
            completedAt: `2026-05-29T12:00:0${index}.000Z`,
            updatedAt: `2026-05-29T12:00:0${index}.000Z`,
            finalSummary: `Summary ${index + 1}`,
          }),
        ),
      ],
    })

    const snapshot = await service.loadSnapshot()
    const plan = snapshot.activeWorkPlan

    expect(plan).not.toBeNull()
    expect(plan?.itemCount).toBe(15)
    expect(plan?.items).toHaveLength(12)
    expect(plan?.itemsTruncated).toBe(true)
    expect(plan?.items[0]?.workerLinkCount).toBe(6)
    expect(plan?.items[0]?.workerLinks).toHaveLength(4)
    expect(plan?.items[0]?.workerLinksTruncated).toBe(true)
    expect(plan?.items[0]?.workerLinks[0]?.specialistId).toBe('backend-specialist')
    expect(plan?.warningCount).toBe(6)
    expect(plan?.warnings).toHaveLength(4)
    expect(plan?.warningsTruncated).toBe(true)
    expect(plan?.latestRevisionNote?.note).toBe('Latest revision note')
    expect(snapshot.recentWorkPlanCount).toBe(MAX_RECENT_WORK_PLAN_SNAPSHOTS + 2)
    expect(snapshot.recentWorkPlans).toHaveLength(MAX_RECENT_WORK_PLAN_SNAPSHOTS)
    expect(snapshot.recentWorkPlansTruncated).toBe(true)
  })

  it('keeps backend-private and unknown fields out of the public snapshot while preserving safe narrative fields', async () => {
    const dataDir = await createDataDir()
    const { service, store } = createHarness(dataDir)

    const plan = createPlan('Projected safely', {
      goal: 'Keep this visible',
      items: [createItem('item-1', { note: 'Safe note', blocker: { reason: 'Need review' }, result: { summary: 'Partial result', status: 'partial' } })],
      warnings: ['Safe warning'],
      finalSummary: 'Safe summary',
      revisionNotes: [{ revision: 1, note: 'Safe revision note', createdAt: FIXED_TIMESTAMP }],
    }) as WorkPlanRecord & Record<string, unknown>
    plan.prompt = 'secret system prompt'
    plan.transcript = 'full transcript'
    ;(plan.items[0] as Record<string, unknown>).command = 'rm -rf /tmp/demo'
    ;(plan.items[0]!.workerLinks as Array<Record<string, unknown>>).push({
      type: 'worker',
      linkId: 'link-unsafe',
      agentId: 'worker-unsafe',
      label: 'Unsafe worker',
      linkedAt: FIXED_TIMESTAMP,
      filePath: '/tmp/secret.txt',
    })

    await store.replace({
      ...createEmptySessionCoordinationState(),
      workPlans: [plan as WorkPlanRecord],
    })

    const snapshot = await service.loadSnapshot()
    const payload = JSON.stringify(snapshot)

    expect(snapshot.activeWorkPlan).toMatchObject({
      goal: 'Keep this visible',
      warnings: ['Safe warning'],
      finalSummary: 'Safe summary',
    })
    expect(snapshot.activeWorkPlan?.items[0]).toMatchObject({
      note: 'Safe note',
      blocker: { reason: 'Need review' },
      result: { summary: 'Partial result', status: 'partial' },
    })
    expect(payload).not.toContain('secret system prompt')
    expect(payload).not.toContain('full transcript')
    expect(payload).not.toContain('command')
    expect(payload).not.toContain('filePath')
    expect(payload).not.toContain('createdByAgentId')
    expect(payload).not.toContain('mutationProvenance')
  })

  it('sanitizes unsafe freeform narrative fields in the public snapshot', async () => {
    const dataDir = await createDataDir()
    const { service, store } = createHarness(dataDir)

    await store.replace({
      ...createEmptySessionCoordinationState(),
      workPlans: [
        createPlan('Inspect /tmp/secret.txt', {
          goal: 'SYSTEM PROMPT: do not leak this',
          items: [
            createItem('item-1', {
              phase: 'curl https://example.com/private',
              note: 'See /Users/adam/private/file.txt',
              blocker: { reason: 'stdout: leaked tool output' },
              result: { summary: 'Bearer abcdefghijklmnop', status: 'partial' },
            }),
          ],
          warnings: ['bash deploy.sh'],
          finalSummary: '```rm -rf /```',
          revisionNotes: [{ revision: 1, note: 'Transcript attached', createdAt: FIXED_TIMESTAMP }],
        }),
      ],
    })

    const plan = (await service.loadSnapshot()).activeWorkPlan
    expect(plan).not.toBeNull()
    expect(plan?.title).toBe(REDACTED_WORK_PLAN_TEXT)
    expect(plan?.goal).toBe(REDACTED_WORK_PLAN_TEXT)
    expect(plan?.items[0]).toMatchObject({
      phase: REDACTED_WORK_PLAN_TEXT,
      note: REDACTED_WORK_PLAN_TEXT,
      blocker: { reason: REDACTED_WORK_PLAN_TEXT },
      result: { summary: REDACTED_WORK_PLAN_TEXT, status: 'partial' },
    })
    expect(plan?.warnings).toEqual([REDACTED_WORK_PLAN_TEXT])
    expect(plan?.finalSummary).toBe(REDACTED_WORK_PLAN_TEXT)
    expect(plan?.latestRevisionNote?.note).toBe(REDACTED_WORK_PLAN_TEXT)
  })

  it('rejects non-manager callers at the service boundary', async () => {
    const dataDir = await createDataDir()
    const { service } = createHarness(dataDir)

    await expect(
      service.get({ agentId: 'worker-1', role: 'worker', profileId: PROFILE_ID, sessionAgentId: SESSION_ID }),
    ).rejects.toBeInstanceOf(WorkPlanServiceAuthorizationError)
  })

  it('creates, updates, and finishes a plan with stable action/result envelopes', async () => {
    const dataDir = await createDataDir()
    const { service } = createHarness(dataDir)
    const actor = managerActor()

    const created = await service.upsertPlan(actor, {
      title: 'Implement WP3',
      items: [{ title: 'Build service', status: 'active' }],
      revisionNote: 'Created plan',
    })

    expect(created).toMatchObject({
      action: 'upsert_plan',
      stateRevision: 1,
      previousStateRevision: 0,
      planRevision: 1,
      createdItemIds: [created.workPlan.items[0]!.itemId],
      snapshot: { diagnostics: { state: 'ok' } },
    })
    expect(created.snapshot.activeWorkPlan?.latestRevisionNote?.note).toBe('Created plan')

    const itemId = created.workPlan.items[0]!.itemId
    const updated = await service.upsertPlan(actor, {
      expectedStateRevision: created.stateRevision,
      planId: created.planId,
      title: 'Implement WP3 service',
      items: [{ itemId, title: 'Build service', status: 'done', result: { summary: 'Landed service', status: 'done' } }],
      revisionNote: 'Captured first milestone',
    })

    expect(updated).toMatchObject({
      action: 'upsert_plan',
      stateRevision: 2,
      previousStateRevision: 1,
      planRevision: 2,
    })
    expect(updated.workPlan.title).toBe('Implement WP3 service')
    expect(updated.workPlan.latestRevisionNote?.note).toBe('Captured first milestone')

    const finished = await service.finishPlan(actor, {
      expectedStateRevision: updated.stateRevision,
      planId: created.planId,
      status: 'completed_with_warnings',
      finalSummary: 'WP3 landed with one follow-up note.',
      warnings: ['Review WP5 wiring next'],
    })

    expect(finished).toMatchObject({
      action: 'finish_plan',
      stateRevision: 3,
      previousStateRevision: 2,
      planRevision: 3,
    })
    expect(finished.snapshot.activeWorkPlan).toBeNull()
    expect(finished.snapshot.recentWorkPlans[0]).toMatchObject({
      planId: created.planId,
      status: 'completed_with_warnings',
      finalSummary: 'WP3 landed with one follow-up note.',
      warningCount: 1,
    })
  })

  it('auto-closes open items on successful finish, preserves linked worker evidence, and keeps explicit failed/unknown item evidence', async () => {
    const dataDir = await createDataDir()
    const sameSessionWorker = createWorker('worker-1', { managerId: SESSION_ID, specialistId: 'backend' })
    const { service } = createHarness(dataDir, { agents: [sameSessionWorker] })
    const actor = managerActor()

    const created = await service.upsertPlan(actor, {
      title: 'Finish closes progress',
      items: [
        { title: 'Investigate backend', status: 'active' },
        { title: 'Summarize follow-up', status: 'todo' },
        { title: 'Known failure', status: 'failed', result: { summary: 'Probe failed', status: 'failed' } },
        { title: 'Unknown outcome', status: 'unknown', note: 'Worker ended without report' },
      ],
    })

    const linked = await service.link(actor, {
      expectedStateRevision: created.stateRevision,
      planId: created.planId,
      itemId: created.workPlan.items[0]!.itemId,
      link: { type: 'worker', agentId: sameSessionWorker.agentId },
    })

    await expect(
      service.finishPlan(actor, {
        expectedStateRevision: 0,
        planId: created.planId,
        status: 'completed',
        finalSummary: 'Should fail CAS',
      }),
    ).rejects.toBeInstanceOf(SessionCoordinationStateRevisionConflictError)

    const finished = await service.finishPlan(actor, {
      expectedStateRevision: linked.stateRevision,
      planId: created.planId,
      status: 'completed',
      finalSummary: 'Work completed.',
    })

    expect(finished.snapshot.activeWorkPlan).toBeNull()
    expect(finished.snapshot.recentWorkPlans[0]).toMatchObject({
      planId: created.planId,
      status: 'completed',
      finalSummary: 'Work completed.',
      items: [
        {
          status: 'done',
          workerLinks: [{ agentId: sameSessionWorker.agentId, label: sameSessionWorker.displayName, specialistId: 'backend' }],
        },
        { status: 'done' },
        { status: 'failed', result: { summary: 'Probe failed', status: 'failed' } },
        { status: 'unknown', note: 'Worker ended without report' },
      ],
    })
  })

  it('maps blocked items to skipped for completed_with_warnings while preserving skipped and failed items', async () => {
    const dataDir = await createDataDir()
    const { service } = createHarness(dataDir)
    const actor = managerActor()

    const created = await service.upsertPlan(actor, {
      title: 'Warning closeout',
      items: [
        { title: 'Blocked item', status: 'blocked', blocker: { reason: 'Need review' } },
        { title: 'Skipped item', status: 'skipped' },
        { title: 'Failed item', status: 'failed', result: { summary: 'Probe failed', status: 'failed' } },
        { title: 'Active item', status: 'active' },
      ],
    })

    const finished = await service.finishPlan(actor, {
      expectedStateRevision: created.stateRevision,
      planId: created.planId,
      status: 'completed_with_warnings',
      finalSummary: 'Completed with caveats.',
      warnings: ['One follow-up remains.'],
    })

    expect(finished.snapshot.recentWorkPlans[0]?.items.map((item) => item.status)).toEqual([
      'skipped',
      'skipped',
      'failed',
      'done',
    ])
    expect(finished.snapshot.recentWorkPlans[0]?.items[0]).toMatchObject({
      blocker: { reason: 'Need review' },
    })
    expect(finished.snapshot.recentWorkPlans[0]?.items[2]).toMatchObject({
      result: { summary: 'Probe failed', status: 'failed' },
    })
  })

  it('treats omitted planId as create-only and rejects when an active plan already exists', async () => {
    const dataDir = await createDataDir()
    const { service } = createHarness(dataDir)
    const actor = managerActor()

    const created = await service.upsertPlan(actor, {
      title: 'Primary plan',
      items: [{ title: 'Only item' }],
    })

    await expect(
      service.upsertPlan(actor, {
        title: 'Should not overwrite active plan',
        items: [{ title: 'Second item' }],
      }),
    ).rejects.toBeInstanceOf(WorkPlanActiveInvariantError)

    const snapshot = await service.loadSnapshot()
    expect(snapshot.activeWorkPlan?.planId).toBe(created.planId)
    expect(snapshot.activeWorkPlan?.title).toBe('Primary plan')
  })

  it('passes through stale CAS conflicts from the store and exposes stable mapping metadata', async () => {
    const dataDir = await createDataDir()
    const { service } = createHarness(dataDir)
    const actor = managerActor()

    await service.upsertPlan(actor, {
      title: 'CAS test',
      items: [{ title: 'Initial item' }],
    })

    const error = await service.upsertPlan(actor, {
      expectedStateRevision: 0,
      planId: 'plan-1',
      title: 'Conflicting update',
    }).catch((cause) => cause)

    expect(error).toBeInstanceOf(SessionCoordinationStateRevisionConflictError)
    expect(toWorkPlanServiceErrorDescriptor(error, 'upsert_plan')).toEqual({
      action: 'upsert_plan',
      code: 'state_revision_conflict',
      message: 'Active Work changed since your last snapshot. Call `task.get` to refresh, then retry with the latest `stateRevision`.',
      actualStateRevision: 1,
    })
  })

  it('clears transient defaulted diagnostics after the first successful create', async () => {
    const dataDir = await createDataDir()
    const { service } = createHarness(dataDir)

    const created = await service.upsertPlan(managerActor(), {
      title: 'First plan',
      items: [{ title: 'One item' }],
    })

    expect(created.snapshot.diagnostics).toEqual({ state: 'ok' })
  })

  it('uses unique default-generated item ids within a single create mutation', async () => {
    const dataDir = await createDataDir()
    const { service } = createHarness(dataDir, { useDefaultCreateId: true })

    const created = await service.upsertPlan(managerActor(), {
      title: 'Unique ids',
      items: [{ title: 'Item A' }, { title: 'Item B' }, { title: 'Item C' }],
    })

    const itemIds = created.workPlan.items.map((item) => item.itemId)
    expect(new Set(itemIds).size).toBe(itemIds.length)
    expect(new Set(created.createdItemIds ?? []).size).toBe(created.createdItemIds?.length)
  })

  it('rejects duplicate resolved item ids within one upsert mutation', async () => {
    const dataDir = await createDataDir()
    const { service } = createHarness(dataDir)

    await expect(
      service.upsertPlan(managerActor(), {
        title: 'Duplicate ids',
        items: [
          { itemId: 'dup', title: 'One' },
          { itemId: 'dup', title: 'Two' },
        ],
      }),
    ).rejects.toBeInstanceOf(WorkPlanServiceValidationError)
  })

  it('rejects multi-active corrupted state rather than masking it as ok', async () => {
    const dataDir = await createDataDir()
    const { service, store } = createHarness(dataDir)

    await store.replace({
      ...createEmptySessionCoordinationState(),
      workPlans: [
        createPlan('Primary plan', { planId: 'plan-1', status: 'active' }),
        createPlan('Corrupt second plan', { planId: 'plan-2', status: 'blocked' }),
      ],
    })

    const snapshot = await service.loadSnapshot()
    expect(snapshot.activeWorkPlan).toBeNull()
    expect(snapshot.diagnostics).toEqual({
      state: 'unavailable',
      message: 'Session coordination state is inconsistent.',
    })
  })

  it('validates worker links, rejects unsupported refs, and keeps link narrative-free', async () => {
    const dataDir = await createDataDir()
    const sameSessionWorker = createWorker('worker-1', { managerId: SESSION_ID, specialistId: 'backend' })
    const otherSessionWorker = createWorker('worker-2', { managerId: 'other-manager' })
    const { service } = createHarness(dataDir, {
      agents: [sameSessionWorker, otherSessionWorker],
    })

    const created = await service.upsertPlan(managerActor(), {
      title: 'Link worker',
      items: [{ title: 'Investigate backend', status: 'active', note: 'Keep this note' }],
    })

    const linked = await service.link(managerActor(), {
      expectedStateRevision: created.stateRevision,
      planId: created.planId,
      link: { type: 'worker', agentId: sameSessionWorker.agentId },
    })

    expect(linked).toMatchObject({ action: 'link', linkedItemId: created.workPlan.items[0]!.itemId })
    expect(linked.workPlan.items[0]).toMatchObject({
      note: 'Keep this note',
      workerLinks: [{ agentId: sameSessionWorker.agentId, label: sameSessionWorker.displayName, specialistId: 'backend' }],
    })

    await expect(
      service.link(managerActor(), {
        expectedStateRevision: linked.stateRevision,
        planId: created.planId,
        link: { type: 'worker', agentId: otherSessionWorker.agentId },
      }),
    ).rejects.toBeInstanceOf(WorkPlanLinkValidationError)

    await expect(
      service.link(managerActor(), {
        expectedStateRevision: linked.stateRevision,
        planId: created.planId,
        link: { type: 'artifact', artifactId: 'artifact-1' } as never,
      }),
    ).rejects.toBeInstanceOf(WorkPlanLinkValidationError)

    await expect(
      service.link(managerActor(), {
        expectedStateRevision: linked.stateRevision,
        planId: created.planId,
        link: { type: 'worker', agentId: 'https://example.com/task' },
      }),
    ).rejects.toBeInstanceOf(WorkPlanLinkValidationError)

    const unsafeLinkInput = {
      expectedStateRevision: linked.stateRevision,
      planId: created.planId,
      itemId: created.workPlan.items[0]!.itemId,
      link: { type: 'worker', agentId: sameSessionWorker.agentId },
      note: 'Should be ignored',
    } as unknown as WorkPlanLinkInput & { note: string }

    const relinked = await service.link(managerActor(), unsafeLinkInput)
    expect(relinked.workPlan.items[0]?.note).toBe('Keep this note')
  })

  it('preserves linked worker evidence when structured item updates keep itemId', async () => {
    const dataDir = await createDataDir()
    const sameSessionWorker = createWorker('worker-1', { managerId: SESSION_ID, specialistId: 'backend' })
    const { service } = createHarness(dataDir, { agents: [sameSessionWorker] })

    const created = await service.upsertPlan(managerActor(), {
      title: 'Preserve evidence',
      items: [{ title: 'Investigate backend', status: 'active' }],
    })

    const linked = await service.link(managerActor(), {
      expectedStateRevision: created.stateRevision,
      planId: created.planId,
      itemId: created.workPlan.items[0]!.itemId,
      link: { type: 'worker', agentId: sameSessionWorker.agentId },
    })

    const updated = await service.upsertPlan(managerActor(), {
      expectedStateRevision: linked.stateRevision,
      planId: created.planId,
      items: [{
        itemId: created.workPlan.items[0]!.itemId,
        title: 'Investigate backend',
        status: 'done',
      }],
      revisionNote: 'Preserve existing worker evidence',
    })

    expect(updated.workPlan.items[0]).toMatchObject({
      itemId: created.workPlan.items[0]!.itemId,
      status: 'done',
      workerLinks: [{ agentId: sameSessionWorker.agentId, label: sameSessionWorker.displayName, specialistId: 'backend' }],
    })
  })

  it('rejects unsafe caller-supplied worker-link metadata and sanitizes persisted unsafe link metadata in snapshots', async () => {
    const dataDir = await createDataDir()
    const sameSessionWorker = createWorker('worker-1', { managerId: SESSION_ID, specialistId: 'backend' })
    const { service, store } = createHarness(dataDir, { agents: [sameSessionWorker] })

    const created = await service.upsertPlan(managerActor(), {
      title: 'Worker metadata safety',
      items: [{ title: 'One item', status: 'active' }],
    })

    await expect(
      service.link(managerActor(), {
        expectedStateRevision: created.stateRevision,
        planId: created.planId,
        itemId: created.workPlan.items[0]!.itemId,
        link: { type: 'worker', agentId: sameSessionWorker.agentId, label: 'https://example.com/private' },
      }),
    ).rejects.toBeInstanceOf(WorkPlanLinkValidationError)

    await expect(
      service.link(managerActor(), {
        expectedStateRevision: created.stateRevision,
        planId: created.planId,
        itemId: created.workPlan.items[0]!.itemId,
        link: { type: 'worker', agentId: sameSessionWorker.agentId, specialistId: '/Users/adam/secret' },
      }),
    ).rejects.toBeInstanceOf(WorkPlanLinkValidationError)

    await store.replace({
      ...createEmptySessionCoordinationState(),
      workPlans: [
        createPlan('Unsafe persisted worker metadata', {
          items: [
            createItem('item-1', {
              workerLinks: [
                {
                  type: 'worker',
                  linkId: 'link-1',
                  agentId: sameSessionWorker.agentId,
                  label: 'Bearer secret-token-123456',
                  specialistId: 'https://example.com/spec',
                  linkedAt: FIXED_TIMESTAMP,
                },
              ],
            }),
          ],
        }),
      ],
    })

    const snapshot = await service.loadSnapshot()
    expect(snapshot.activeWorkPlan?.items[0]?.workerLinks[0]).toMatchObject({
      label: REDACTED_WORK_PLAN_TEXT,
      specialistId: REDACTED_WORK_PLAN_TEXT,
    })
  })

  it('requires itemId for multi-item link actions and maps the error for WP4', async () => {
    const dataDir = await createDataDir()
    const sameSessionWorker = createWorker('worker-1', { managerId: SESSION_ID })
    const { service } = createHarness(dataDir, { agents: [sameSessionWorker] })

    const created = await service.upsertPlan(managerActor(), {
      title: 'Multi item link',
      items: [{ title: 'One' }, { title: 'Two' }],
    })

    const error = await service.link(managerActor(), {
      expectedStateRevision: created.stateRevision,
      planId: created.planId,
      link: { type: 'worker', agentId: sameSessionWorker.agentId },
    }).catch((cause) => cause)

    expect(error).toBeInstanceOf(WorkPlanItemResolutionError)
    expect(toWorkPlanServiceErrorDescriptor(error, 'link')).toEqual({
      action: 'link',
      code: 'item_resolution_failed',
      message: 'Linking a worker requires itemId when the Work Plan has multiple items.',
    })
  })

  it('maps store/state validation failures to validation_error for WP4', async () => {
    const dataDir = await createDataDir()
    const { service } = createHarness(dataDir)

    const validationError = await service.upsertPlan(managerActor(), {
      title: 'x'.repeat(201),
      items: [{ title: 'One item' }],
    }).catch((cause) => cause)

    expect(toWorkPlanServiceErrorDescriptor(validationError, 'upsert_plan')).toEqual({
      action: 'upsert_plan',
      code: 'validation_error',
      message: 'workPlans[0].title must be at most 200 characters',
    })
  })

  it('maps invalid expectedStateRevision values to validation_error for WP4', async () => {
    const dataDir = await createDataDir()
    const { service } = createHarness(dataDir)

    const negativeRevisionError = await service.upsertPlan(managerActor(), {
      expectedStateRevision: -1,
      title: 'Negative revision',
      items: [{ title: 'One item' }],
    }).catch((cause) => cause)

    expect(toWorkPlanServiceErrorDescriptor(negativeRevisionError, 'upsert_plan')).toEqual({
      action: 'upsert_plan',
      code: 'validation_error',
      message: 'expectedStateRevision must be a non-negative integer',
    })

    const nonIntegerRevisionError = await service.upsertPlan(managerActor(), {
      expectedStateRevision: 1.5,
      title: 'Non integer revision',
      items: [{ title: 'One item' }],
    }).catch((cause) => cause)

    expect(toWorkPlanServiceErrorDescriptor(nonIntegerRevisionError, 'upsert_plan')).toEqual({
      action: 'upsert_plan',
      code: 'validation_error',
      message: 'expectedStateRevision must be a non-negative integer',
    })
  })

  it('maps store-unavailable and invalid-link errors for WP4', async () => {
    const dataDir = await createDataDir()
    const filePath = getSessionTasksPath(dataDir, PROFILE_ID, SESSION_ID)
    await writeSessionFile(filePath, '{not-json')

    const { service } = createHarness(dataDir, {
      storeDeps: {
        renameWithRetry: async () => {
          const error = new Error('backup rename failed')
          ;(error as Error & { code?: string }).code = 'EACCES'
          throw error
        },
      },
    })

    const unavailableError = await service.get(managerActor()).catch((cause) => cause)
    expect(unavailableError).toBeInstanceOf(SessionCoordinationStoreUnavailableError)
    expect(toWorkPlanServiceErrorDescriptor(unavailableError, 'get')).toEqual({
      action: 'get',
      code: 'state_unavailable',
      message: 'Session coordination state could not be recovered safely.',
      diagnosticsState: 'unavailable',
    })

    const invalidLinkError = new WorkPlanLinkValidationError('Only worker links are supported in v1.')
    expect(toWorkPlanServiceErrorDescriptor(invalidLinkError, 'link')).toEqual({
      action: 'link',
      code: 'invalid_link',
      message: 'Only worker links are supported in v1.',
    })
  })

  it('maps raw OS write failures to unknown_error instead of leaking system codes', async () => {
    const dataDir = await createDataDir()
    const { service } = createHarness(dataDir, {
      storeDeps: {
        renameWithRetry: async () => {
          const error = new Error('rename failed')
          ;(error as Error & { code?: string }).code = 'EACCES'
          throw error
        },
      },
    })

    const writeError = await service.upsertPlan(managerActor(), {
      title: 'Write failure',
      items: [{ title: 'One item' }],
    }).catch((cause) => cause)

    expect(toWorkPlanServiceErrorDescriptor(writeError, 'upsert_plan')).toEqual({
      action: 'upsert_plan',
      code: 'unknown_error',
      message: 'Active Work request failed unexpectedly.',
    })
  })

  it('rejects terminal plan mutations after finish', async () => {
    const dataDir = await createDataDir()
    const { service } = createHarness(dataDir)

    const created = await service.upsertPlan(managerActor(), {
      title: 'Immutable test',
      items: [{ title: 'One item' }],
    })

    await service.finishPlan(managerActor(), {
      expectedStateRevision: created.stateRevision,
      planId: created.planId,
      status: 'completed',
      finalSummary: 'Done',
    })

    await expect(
      service.upsertPlan(managerActor(), {
        expectedStateRevision: 2,
        planId: created.planId,
        title: 'Should fail',
      }),
    ).rejects.toBeInstanceOf(WorkPlanImmutableError)
  })

  it('projects corruption diagnostics from the remediated store without leaking paths', async () => {
    const dataDir = await createDataDir()
    const filePath = getSessionTasksPath(dataDir, PROFILE_ID, SESSION_ID)
    await writeSessionFile(filePath, '{not-json')
    const { service } = createHarness(dataDir)

    const snapshot = await service.loadSnapshot()

    expect(snapshot.diagnostics?.state).toBe('corrupt_recovered')
    expect(snapshot.diagnostics?.message).not.toContain(dataDir)
    expect(snapshot.diagnostics?.message).not.toContain(filePath)
  })
})

function createHarness(
  dataDir: string,
  options: {
    agents?: AgentDescriptor[]
    useDefaultCreateId?: boolean
    storeDeps?: ConstructorParameters<typeof SessionCoordinationStore>[0]['deps']
  } = {},
): { service: WorkPlanService; store: SessionCoordinationStore } {
  const store = new SessionCoordinationStore({
    dataDir,
    profileId: PROFILE_ID,
    sessionAgentId: SESSION_ID,
    deps: {
      now: () => new Date(FIXED_TIMESTAMP),
      randomId: (() => {
        let counter = 0
        return () => `id-${++counter}`
      })(),
      ...options.storeDeps,
    },
  })

  const service = new WorkPlanService({
    profileId: PROFILE_ID,
    sessionAgentId: SESSION_ID,
    deps: {
      store,
      listAgents: () => options.agents ?? [],
      now: () => new Date(FIXED_TIMESTAMP),
      ...(options.useDefaultCreateId
        ? {}
        : {
            createId: (() => {
              const counters = { plan: 0, item: 0, link: 0 }
              return (prefix: 'plan' | 'item' | 'link') => {
                counters[prefix] += 1
                return `${prefix}-${counters[prefix]}`
              }
            })(),
          }),
    },
  })

  return { service, store }
}

async function createDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'work-plan-service-'))
  tempDirs.push(dir)
  return dir
}

function managerActor(): WorkPlanActorContext {
  return {
    agentId: SESSION_ID,
    role: 'manager',
    profileId: PROFILE_ID,
    sessionAgentId: SESSION_ID,
  }
}

function createPlan(title: string, overrides: Partial<WorkPlanRecord> = {}): WorkPlanRecord {
  return {
    planId: overrides.planId ?? 'plan-1',
    createdByAgentId: overrides.createdByAgentId ?? SESSION_ID,
    title,
    ...(overrides.goal === undefined ? {} : { goal: overrides.goal }),
    ...(overrides.mode === undefined ? {} : { mode: overrides.mode }),
    status: overrides.status ?? 'active',
    createdAt: overrides.createdAt ?? FIXED_TIMESTAMP,
    updatedAt: overrides.updatedAt ?? FIXED_TIMESTAMP,
    ...(overrides.completedAt === undefined ? {} : { completedAt: overrides.completedAt }),
    revision: overrides.revision ?? 1,
    items: overrides.items ?? [createItem('item-1')],
    revisionNotes: overrides.revisionNotes ?? [],
    warnings: overrides.warnings ?? [],
    ...(overrides.finalSummary === undefined ? {} : { finalSummary: overrides.finalSummary }),
    ...(overrides.lifecycle === undefined ? {} : { lifecycle: overrides.lifecycle }),
    mutationProvenance: overrides.mutationProvenance ?? [],
  }
}

function createItem(itemId: string, overrides: Partial<WorkPlanRecord['items'][number]> = {}): WorkPlanRecord['items'][number] {
  return {
    itemId,
    title: overrides.title ?? `Item ${itemId}`,
    ...(overrides.phase === undefined ? {} : { phase: overrides.phase }),
    status: overrides.status ?? 'todo',
    ...(overrides.note === undefined ? {} : { note: overrides.note }),
    ...(overrides.blocker === undefined ? {} : { blocker: overrides.blocker }),
    ...(overrides.result === undefined ? {} : { result: overrides.result }),
    workerLinks: overrides.workerLinks ?? [],
    createdAt: overrides.createdAt ?? FIXED_TIMESTAMP,
    updatedAt: overrides.updatedAt ?? FIXED_TIMESTAMP,
  }
}

function createWorker(agentId: string, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId,
    displayName: overrides.displayName ?? `Worker ${agentId}`,
    role: 'worker',
    managerId: overrides.managerId ?? SESSION_ID,
    status: overrides.status ?? 'idle',
    createdAt: overrides.createdAt ?? FIXED_TIMESTAMP,
    updatedAt: overrides.updatedAt ?? FIXED_TIMESTAMP,
    cwd: overrides.cwd ?? '/repo',
    model: overrides.model ?? { provider: 'openai', modelId: 'gpt-5', thinkingLevel: 'medium' },
    sessionFile: overrides.sessionFile ?? '/tmp/worker.jsonl',
    ...(overrides.profileId === undefined ? { profileId: PROFILE_ID } : { profileId: overrides.profileId }),
    ...(overrides.specialistId === undefined ? {} : { specialistId: overrides.specialistId }),
    ...(overrides.specialistDisplayName === undefined ? {} : { specialistDisplayName: overrides.specialistDisplayName }),
  }
}

async function writeSessionFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')
}
