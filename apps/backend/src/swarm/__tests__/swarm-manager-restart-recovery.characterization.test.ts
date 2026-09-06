import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  createTempConfig,
  TestSwarmManager,
  bootWithDefaultManager,
  type FakeRuntime,
} from '../../test-support/index.js'
import type { AgentDescriptor, SwarmConfig } from '../types.js'
import { SessionPlanStore } from '../planning/session-plan-store.js'
import {
  appendTurnLedgerRecord,
  replayTurnLedger,
  type TurnLedgerSessionTarget,
} from '../turn-ledger.js'

const NOW = '2026-07-13T12:00:00.000Z'
const RECOVERED_REPORT = 'Recovered worker result from the persisted ledger.'
const RECOVERED_DELIVERY_ID = 'worker-result:recovery-worker:persisted'

interface RecoveryFixture {
  cleanup: () => Promise<void>
  config: SwarmConfig
  target: TurnLedgerSessionTarget
  workerId: string
}

async function createRecoveryFixture(options?: { withRunningGraph?: boolean }): Promise<RecoveryFixture> {
  const handle = await createTempConfig({
    prefix: 'swarm-manager-restart-recovery-',
    omitSharedAuthFile: true,
    omitSharedSecretsFile: true,
    skipRepoMemorySkillPlaceholder: true,
  })
  const manager = new TestSwarmManager(handle.config, { now: () => NOW })
  await bootWithDefaultManager(manager, handle.config)
  const worker = await manager.spawnAgent('manager', { agentId: 'Recovery Worker' })

  await persistAgentStatuses(handle.config, new Map([
    ['manager', 'streaming'],
    [worker.agentId, 'streaming'],
  ]))
  await persistWorkerParentContext(handle.config, worker.agentId)
  if (options?.withRunningGraph) {
    const planStore = new SessionPlanStore({
      dataDir: handle.config.paths.dataDir,
      profileId: 'manager',
      sessionAgentId: 'manager',
    })
    await planStore.update({
      coordinationMode: 'graph',
      plan: [{ step: 'Resume interrupted validation', status: 'in_progress' }],
      workGraph: {
        maxConcurrency: 1,
        nodes: [{
          id: 'validate',
          title: 'Resume interrupted validation',
          task: 'Finish the interrupted validation run.',
          kind: 'review',
          status: 'running',
          dependsOn: [],
          effort: 'routine',
          attempts: [{
            id: 'attempt-before-restart',
            number: 1,
            status: 'running',
            startedAt: NOW,
            behaviorMode: 'correctness-review',
            executionPolicy: 'routine',
            workerId: worker.agentId,
          }],
        }],
      },
    })
  }

  const target: TurnLedgerSessionTarget = {
    dataDir: handle.config.paths.dataDir,
    profileId: 'manager',
    sessionAgentId: 'manager',
  }
  await appendTurnLedgerRecord(target, {
    t: 'turn_dispatched',
    turnId: 'manager-turn-before-restart',
    agentId: 'manager',
    role: 'manager',
    kind: 'user',
    at: NOW,
  })
  await appendTurnLedgerRecord(target, {
    t: 'turn_dispatched',
    turnId: 'worker-turn-before-restart',
    agentId: worker.agentId,
    role: 'worker',
    kind: 'agent_message',
    at: NOW,
  })
  await appendTurnLedgerRecord(target, {
    t: 'delivery_pending',
    turnId: 'manager-turn-before-restart',
    deliveryId: RECOVERED_DELIVERY_ID,
    from: worker.agentId,
    to: 'manager',
    message: RECOVERED_REPORT,
    assignmentId: 'assignment:recovery-worker:persisted',
    at: NOW,
  })

  return {
    cleanup: handle.cleanup,
    config: handle.config,
    target,
    workerId: worker.agentId,
  }
}

async function persistAgentStatuses(
  config: SwarmConfig,
  statuses: ReadonlyMap<string, AgentDescriptor['status']>,
): Promise<void> {
  const store = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
    agents: AgentDescriptor[]
    profiles?: unknown[]
  }
  store.agents = store.agents.map((agent) => {
    const status = statuses.get(agent.agentId)
    return status ? { ...agent, status, updatedAt: NOW } : agent
  })
  await writeFile(config.paths.agentsStoreFile, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

async function persistWorkerParentContext(
  config: SwarmConfig,
  workerId: string,
  assignmentId = 'assignment:recovery-worker:persisted',
): Promise<void> {
  const store = JSON.parse(await readFile(config.paths.agentsStoreFile, 'utf8')) as {
    agents: AgentDescriptor[]
    profiles?: unknown[]
  }
  store.agents = store.agents.map((agent) => agent.agentId === workerId
    ? {
        ...agent,
        workerParentContext: {
          schemaVersion: 1,
          assignmentId,
          managerId: 'manager',
          assignedAt: NOW,
          outputTarget: { kind: 'internal_only', reason: 'restart_recovery_test' },
        },
      }
    : agent)
  await writeFile(config.paths.agentsStoreFile, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

function sentMessageText(runtime: FakeRuntime | undefined): string[] {
  return runtime?.sendCalls.map(({ message }) => typeof message === 'string' ? message : message.text) ?? []
}

describe('SwarmManager restart recovery characterization', () => {
  it('builds an isolated boot snapshot and records interrupted turns once', async () => {
    const fixture = await createRecoveryFixture()
    try {
      const recovered = new TestSwarmManager(fixture.config, { now: () => NOW })
      await recovered.boot()

      const snapshot = recovered.getRestartRecoverySnapshot()
      expect(snapshot).toEqual({
        bootId: expect.any(String),
        createdAt: NOW,
        interruptedManagers: ['manager'],
        interruptedWorkers: [fixture.workerId],
        undeliveredReports: [{
          deliveryId: RECOVERED_DELIVERY_ID,
          fromAgentId: fixture.workerId,
          toAgentId: 'manager',
          turnId: 'manager-turn-before-restart',
          assignmentId: 'assignment:recovery-worker:persisted',
        }],
      })

      snapshot!.interruptedManagers.push('mutated-manager')
      snapshot!.interruptedWorkers.length = 0
      snapshot!.undeliveredReports[0]!.fromAgentId = 'mutated-worker'
      expect(recovered.getRestartRecoverySnapshot()).toMatchObject({
        interruptedManagers: ['manager'],
        interruptedWorkers: [fixture.workerId],
        undeliveredReports: [{ fromAgentId: fixture.workerId }],
      })

      const ledgerAfterFirstRecovery = await replayTurnLedger(fixture.target)
      const seededInterruptedReceipts = ledgerAfterFirstRecovery.records.filter(
        (record) => record.t === 'recovery_receipt'
          && record.receipt === 'turn_interrupted'
          && (record.turnId === 'manager-turn-before-restart' || record.turnId === 'worker-turn-before-restart'),
      )
      expect(seededInterruptedReceipts).toHaveLength(2)

      await persistAgentStatuses(fixture.config, new Map([
        ['manager', 'streaming'],
        [fixture.workerId, 'streaming'],
      ]))
      const recoveredAgain = new TestSwarmManager(fixture.config, { now: () => NOW })
      await recoveredAgain.boot()

      const ledgerAfterSecondRecovery = await replayTurnLedger(fixture.target)
      expect(ledgerAfterSecondRecovery.records.filter(
        (record) => record.t === 'recovery_receipt'
          && record.receipt === 'turn_interrupted'
          && (record.turnId === 'manager-turn-before-restart' || record.turnId === 'worker-turn-before-restart'),
      )).toHaveLength(2)
    } finally {
      await fixture.cleanup()
    }
  })

  it('reconciles open turns and blocks their running graph attempts when actors persisted as idle', async () => {
    const fixture = await createRecoveryFixture({ withRunningGraph: true })
    try {
      await persistAgentStatuses(fixture.config, new Map([
        ['manager', 'idle'],
        [fixture.workerId, 'idle'],
      ]))
      await appendTurnLedgerRecord(fixture.target, {
        t: 'delivery_acked',
        deliveryId: RECOVERED_DELIVERY_ID,
        at: NOW,
      })

      const recovered = new TestSwarmManager(fixture.config, { now: () => NOW })
      await recovered.boot()

      expect(recovered.getRestartRecoverySnapshot()).toBeNull()
      expect(recovered.runtimeByAgentId.size).toBe(0)
      const ledger = await replayTurnLedger(fixture.target)
      expect(ledger.openTurns.size).toBe(0)
      expect([...ledger.terminalTurns.values()]).toEqual(expect.arrayContaining([
        expect.objectContaining({ turnId: 'manager-turn-before-restart', outcome: 'reconciled' }),
        expect.objectContaining({ turnId: 'worker-turn-before-restart', outcome: 'reconciled' }),
      ]))
      await expect(recovered.getSessionPlanSnapshot('manager')).resolves.toMatchObject({
        plan: [{ step: 'Resume interrupted validation', status: 'pending' }],
        workGraph: { nodes: [{
          id: 'validate',
          status: 'blocked',
          attempts: [{
            status: 'blocked',
            summary: expect.stringContaining('worker stopped'),
          }],
        }] },
      })
    } finally {
      await fixture.cleanup()
    }
  })

  it('keeps dismissal non-delivering across repeated dismiss and resume requests', async () => {
    const fixture = await createRecoveryFixture({ withRunningGraph: true })
    try {
      const recovered = new TestSwarmManager(fixture.config, { now: () => NOW })
      await recovered.boot()

      await expect(recovered.dismissRestartRecovery()).resolves.toMatchObject({ dismissedAt: NOW })
      await expect(recovered.dismissRestartRecovery()).resolves.toMatchObject({ dismissedAt: NOW })
      const resumeAfterDismiss = await recovered.resumeRestartRecovery()
      expect(resumeAfterDismiss).toMatchObject({ dismissedAt: NOW })
      expect(resumeAfterDismiss).not.toHaveProperty('resumedAt')
      expect(recovered.runtimeByAgentId.size).toBe(0)
      await expect(recovered.getSessionPlanSnapshot('manager')).resolves.toMatchObject({
        plan: [{ step: 'Resume interrupted validation', status: 'pending' }],
        workGraph: { nodes: [{
          id: 'validate',
          status: 'blocked',
          attempts: [{
            status: 'blocked',
            summary: expect.stringContaining('recovery was dismissed'),
          }],
        }] },
      })
    } finally {
      await fixture.cleanup()
    }
  })

  it('resumes interrupted agents and redelivers a persisted report only once', async () => {
    const fixture = await createRecoveryFixture()
    try {
      const recovered = new TestSwarmManager(fixture.config, { now: () => NOW })
      await recovered.boot()

      expect(await recovered.resumeRestartRecovery()).toMatchObject({ resumedAt: NOW })

      const workerMessages = sentMessageText(recovered.runtimeByAgentId.get(fixture.workerId))
      const managerMessages = sentMessageText(recovered.runtimeByAgentId.get('manager'))
      expect(workerMessages).toHaveLength(1)
      expect(workerMessages[0]).toContain('backend restarted while you were mid-turn')
      expect(managerMessages).toHaveLength(2)
      expect(managerMessages.some((message) => message.includes('backend restarted while you were mid-turn'))).toBe(true)
      expect(managerMessages.some((message) => message.includes('preserving existing ownership'))).toBe(true)
      expect(managerMessages.some((message) => message.includes('the restart itself is not a reason to delegate'))).toBe(true)
      expect(managerMessages.some((message) => message.includes(RECOVERED_REPORT))).toBe(true)

      const ledgerAfterResume = await replayTurnLedger(fixture.target)
      expect(ledgerAfterResume.pendingDeliveries.has(RECOVERED_DELIVERY_ID)).toBe(false)
      expect(ledgerAfterResume.ackedDeliveries.has(RECOVERED_DELIVERY_ID)).toBe(true)

      const callsAfterFirstResume = {
        manager: managerMessages.length,
        worker: workerMessages.length,
      }
      expect(await recovered.resumeRestartRecovery()).toMatchObject({ resumedAt: NOW })
      expect(recovered.runtimeByAgentId.get('manager')?.sendCalls).toHaveLength(callsAfterFirstResume.manager)
      expect(recovered.runtimeByAgentId.get(fixture.workerId)?.sendCalls).toHaveLength(callsAfterFirstResume.worker)
    } finally {
      await fixture.cleanup()
    }
  })

  it('does not let a stale recovered result consume a newer worker assignment', async () => {
    const fixture = await createRecoveryFixture()
    try {
      await persistWorkerParentContext(
        fixture.config,
        fixture.workerId,
        'assignment:recovery-worker:newer',
      )
      const recovered = new TestSwarmManager(fixture.config, { now: () => NOW })
      await recovered.boot()

      await recovered.resumeRestartRecovery()

      const currentWorker = recovered.listAgentsForInternalUse()
        .find((agent) => agent.agentId === fixture.workerId)
      expect(currentWorker?.workerParentContext?.assignmentId)
        .toBe('assignment:recovery-worker:newer')
      expect(sentMessageText(recovered.runtimeByAgentId.get('manager')))
        .not.toContain(expect.stringContaining(RECOVERED_REPORT))
      const ledger = await replayTurnLedger(fixture.target)
      expect(ledger.pendingDeliveries.has(RECOVERED_DELIVERY_ID)).toBe(false)
      expect(ledger.ackedDeliveries.has(RECOVERED_DELIVERY_ID)).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  it('claims restart recovery before awaiting delivery so concurrent resumes do not duplicate work', async () => {
    const fixture = await createRecoveryFixture()
    try {
      const recovered = new TestSwarmManager(fixture.config, { now: () => NOW })
      await recovered.boot()

      let markCreationStarted!: () => void
      let releaseCreation!: () => void
      const creationStarted = new Promise<void>((resolve) => {
        markCreationStarted = resolve
      })
      const creationGate = new Promise<void>((resolve) => {
        releaseCreation = resolve
      })
      recovered.onCreateRuntime = async ({ descriptor }) => {
        if (descriptor.agentId !== fixture.workerId) return
        markCreationStarted()
        await creationGate
      }

      const firstResume = recovered.resumeRestartRecovery()
      await creationStarted
      expect(recovered.isRestartRecoveryDecisionPendingForTest()).toBe(true)
      await recovered.createGoal('manager', 'recovery-gated-goal', {
        objective: 'Wait for restart recovery to finish',
      })
      const managerCallsBeforeContinuation =
        recovered.runtimeByAgentId.get('manager')?.sendCalls.length ?? 0
      await recovered.runGoalContinuationForTest('manager')
      expect(recovered.runtimeByAgentId.get('manager')?.sendCalls.length ?? 0)
        .toBe(managerCallsBeforeContinuation)
      await recovered.controlSessionGoal('manager', { action: 'pause' })
      const secondResume = recovered.resumeRestartRecovery()
      releaseCreation()
      await Promise.all([firstResume, secondResume])

      expect(sentMessageText(recovered.runtimeByAgentId.get(fixture.workerId))).toHaveLength(1)
      expect(sentMessageText(recovered.runtimeByAgentId.get('manager'))).toHaveLength(2)
      expect(recovered.getRestartRecoverySnapshot()).toMatchObject({ resumedAt: NOW })
      expect(recovered.isRestartRecoveryDecisionPendingForTest()).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })
})
