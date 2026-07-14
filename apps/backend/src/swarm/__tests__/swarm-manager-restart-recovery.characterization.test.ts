import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  createTempConfig,
  TestSwarmManager,
  bootWithDefaultManager,
  type FakeRuntime,
} from '../../test-support/index.js'
import type { AgentDescriptor, SwarmConfig } from '../types.js'
import {
  appendTurnLedgerRecord,
  replayTurnLedger,
  type TurnLedgerSessionTarget,
} from '../turn-ledger.js'

const NOW = '2026-07-13T12:00:00.000Z'
const RECOVERED_REPORT = 'Recovered worker result from the persisted ledger.'

interface RecoveryFixture {
  cleanup: () => Promise<void>
  config: SwarmConfig
  target: TurnLedgerSessionTarget
  workerId: string
}

async function createRecoveryFixture(): Promise<RecoveryFixture> {
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
    deliveryId: 'persisted-worker-report',
    from: worker.agentId,
    to: 'manager',
    message: RECOVERED_REPORT,
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
          deliveryId: 'persisted-worker-report',
          fromAgentId: fixture.workerId,
          toAgentId: 'manager',
          turnId: 'manager-turn-before-restart',
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

  it('keeps dismissal non-delivering across repeated dismiss and resume requests', async () => {
    const fixture = await createRecoveryFixture()
    try {
      const recovered = new TestSwarmManager(fixture.config, { now: () => NOW })
      await recovered.boot()

      expect(recovered.dismissRestartRecovery()).toMatchObject({ dismissedAt: NOW })
      expect(recovered.dismissRestartRecovery()).toMatchObject({ dismissedAt: NOW })
      const resumeAfterDismiss = await recovered.resumeRestartRecovery()
      expect(resumeAfterDismiss).toMatchObject({ dismissedAt: NOW })
      expect(resumeAfterDismiss).not.toHaveProperty('resumedAt')
      expect(recovered.runtimeByAgentId.size).toBe(0)
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
      expect(managerMessages.some((message) => message.includes(RECOVERED_REPORT))).toBe(true)

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
