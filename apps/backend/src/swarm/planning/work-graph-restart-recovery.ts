import type { AgentDescriptor } from '../types.js'
import type { SessionPlanCoordinator } from './session-plan-coordinator.js'

export function isWorkGraphWorkerActive(
  descriptors: ReadonlyMap<string, AgentDescriptor>,
  workerId: string,
): boolean {
  const worker = descriptors.get(workerId)
  return worker?.role === 'worker' && worker.status === 'streaming'
}

export async function blockDismissedWorkGraphWorkers(options: {
  descriptors: ReadonlyMap<string, AgentDescriptor>
  plans: SessionPlanCoordinator
  workerIds: readonly string[]
}): Promise<void> {
  const workerIdsByManager = new Map<string, string[]>()
  for (const workerId of options.workerIds) {
    const worker = options.descriptors.get(workerId)
    if (!worker || worker.role !== 'worker') continue
    const current = workerIdsByManager.get(worker.managerId) ?? []
    current.push(workerId)
    workerIdsByManager.set(worker.managerId, current)
  }
  await Promise.all(Array.from(workerIdsByManager, async ([managerId, workerIds]) => {
    const manager = options.descriptors.get(managerId)
    if (!manager || manager.role !== 'manager' || !manager.profileId) return
    await options.plans.blockInterruptedWorkGraphWorkers({
      agentId: manager.agentId,
      profileId: manager.profileId,
    }, workerIds)
  }))
}
