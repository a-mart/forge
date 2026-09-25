import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { bootWithDefaultManager, createTempConfig, TestSwarmManager } from '../../test-support/index.js'

// Actual manager, lifecycle, shutdown quarantine, admission and durable session store.
// Only the provider is substituted so failed/late cleanup can be reproduced reliably.
async function fixture() {
  const handle = await createTempConfig({ prefix: 'forge-stop-recovery-', omitSharedAuthFile: true, omitSharedSecretsFile: true })
  const manager = new TestSwarmManager(handle.config)
  await bootWithDefaultManager(manager, handle.config)
  await manager.handleUserMessage('Original work', { targetAgentId: 'manager' })
  const runtime = manager.runtimeByAgentId.get('manager')!
  runtime.terminateMutatesDescriptorStatus = false
  let clean = false
  const cleanup = vi.fn(async () => { if (!clean) throw new Error('Provider cleanup is still pending') })
  runtime.stopInFlight = cleanup
  runtime.terminate = cleanup
  await manager.stopAllAgents('manager', 'manager')
  expect(manager.getAgent('manager')?.status).toBe('stopped')
  return { ...handle, manager, runtime, cleanupAttempt: cleanup, settle: () => { clean = true } }
}

describe('Stopped session recovery acceptance', () => {
  it('retries Stop all on the retained owner and clears stopped state only after cleanup succeeds', async () => {
    const f = await fixture()
    try {
      await f.manager.stopAllAgents('manager', 'manager')
      expect(f.cleanupAttempt).toHaveBeenCalledTimes(2)
      expect(f.manager.getAgent('manager')?.status).toBe('stopped')
      expect(f.manager.runtimeCreationCountByAgentId.get('manager')).toBe(1)
      f.settle()
      await f.manager.stopAllAgents('manager', 'manager')
      expect(f.cleanupAttempt).toHaveBeenCalledTimes(3)
      expect(f.manager.getAgent('manager')?.status).toBe('idle')
      await f.manager.handleUserMessage('New work after stop', { targetAgentId: 'manager' })
      expect(f.manager.runtimeCreationCountByAgentId.get('manager')).toBe(2)
      expect(f.manager.runtimeByAgentId.get('manager')?.sendCalls).toHaveLength(1)
    } finally { f.settle(); await f.manager.stopSession('manager'); await f.cleanup() }
  })

  it('recovers on new user input, rejects while cleanup is unsafe, and coalesces concurrent replacement creation', async () => {
    const f = await fixture()
    try {
      const before = await readFile(f.runtime.descriptor.sessionFile, 'utf8')
      await expect(f.manager.handleUserMessage('Unsafe retry', { targetAgentId: 'manager' })).rejects.toThrow('cleanup')
      expect(await readFile(f.runtime.descriptor.sessionFile, 'utf8')).toBe(before)
      expect(f.manager.runtimeCreationCountByAgentId.get('manager')).toBe(1)
      f.settle()
      await Promise.all([
        f.manager.handleUserMessage('First new input', { targetAgentId: 'manager' }),
        f.manager.handleUserMessage('Second new input', { targetAgentId: 'manager' }),
      ])
      expect(f.manager.runtimeCreationCountByAgentId.get('manager')).toBe(2)
      const replacement = f.manager.runtimeByAgentId.get('manager')!
      expect(replacement).not.toBe(f.runtime)
      expect(replacement.sendCalls).toHaveLength(2)
      expect((await readFile(f.runtime.descriptor.sessionFile, 'utf8')).startsWith(before)).toBe(true)
    } finally { f.settle(); await f.manager.stopSession('manager'); await f.cleanup() }
  })

  it('recovers a persisted stopped manager after boot without replaying the interrupted work', async () => {
    const f = await fixture()
    // The provider process has gone away across the simulated application restart.
    f.settle()
    const rebooted = new TestSwarmManager(f.config)
    try {
      await rebooted.boot()
      expect(rebooted.getAgent('manager')?.status).toBe('stopped')
      expect(rebooted.runtimeByAgentId.has('manager')).toBe(false)
      const before = await readFile(f.runtime.descriptor.sessionFile, 'utf8')
      await rebooted.handleUserMessage('Continue with the new instruction only', { targetAgentId: 'manager' })
      expect(rebooted.runtimeByAgentId.get('manager')?.sendCalls).toHaveLength(1)
      expect((await readFile(f.runtime.descriptor.sessionFile, 'utf8')).startsWith(before)).toBe(true)
      await rebooted.stopSession('manager')
    } finally { await f.cleanup() }
  })
  it('holds a concurrent Stop all until admitted replacement creation settles', async () => {
    const f = await fixture()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    f.settle()
    f.manager.onCreateRuntime = async ({ creationCount }) => {
      if (creationCount > 1) { entered(); await held }
    }
    try {
      const sending = f.manager.handleUserMessage('New instruction', { targetAgentId: 'manager' }).then(
        () => 'sent', error => String(error),
      )
      await started
      let stopFinished = false
      const stopping = f.manager.stopAllAgents('manager', 'manager').then(() => { stopFinished = true })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(stopFinished).toBe(false)
      release()
      await Promise.all([sending, stopping])
      expect(f.manager.getAgent('manager')?.status).toBe('idle')
      const replacement = f.manager.runtimeByAgentId.get('manager')!
      expect(replacement.stopInFlightCalls.length + replacement.terminateCalls.length).toBe(1)
      expect(replacement.sendCalls).toHaveLength(0)
    } finally { release(); await f.manager.stopSession('manager'); await f.cleanup() }
  })

  it('retries stopped workers as well as their manager without reviving terminated workers', async () => {
    const f = await fixture()
    f.settle()
    try {
      await f.manager.stopAllAgents('manager', 'manager')
      const worker = await f.manager.spawnAgent('manager', { agentId: 'worker-recovery' })
      const runtime = f.manager.runtimeByAgentId.get(worker.agentId)!
      let clean = false
      const stop = vi.fn(async () => { if (!clean) throw new Error('Worker cleanup pending') })
      runtime.stopInFlight = stop
      await f.manager.stopAllAgents('manager', 'manager')
      expect(f.manager.getAgent(worker.agentId)?.status).toBe('stopped')
      clean = true
      await f.manager.stopAllAgents('manager', 'manager')
      expect(stop).toHaveBeenCalledTimes(2)
      expect(f.manager.getAgent(worker.agentId)?.status).toBe('idle')
      await f.manager.killAgent('manager', worker.agentId)
      await f.manager.stopAllAgents('manager', 'manager')
      expect(f.manager.getAgent(worker.agentId)?.status).toBe('terminated')
    } finally { await f.manager.stopSession('manager'); await f.cleanup() }
  })

})
