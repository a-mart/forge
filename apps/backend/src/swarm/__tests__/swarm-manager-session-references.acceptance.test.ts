import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootWithDefaultManager, createTempConfig, TestSwarmManager } from '../../test-support/index.js'

// Real manager, dispatcher, and durable agents store; only the provider runtime is faked.
// Failure modes covered:
// - peer messages stay anonymous, so the referenced session cannot identify or answer the sender
// - the referencing session is not told the referenced agent id
// - the referenced session cannot reply to the referencing session
// - the link is lost across a restart
// - self, unknown, and worker ids are silently turned into links
async function fixture() {
  const handle = await createTempConfig({ prefix: 'forge-session-references-', omitSharedAuthFile: true, omitSharedSecretsFile: true })
  const manager = new TestSwarmManager(handle.config)
  await bootWithDefaultManager(manager, handle.config)
  const otherCwd = join(handle.config.defaultCwd, 'other-project')
  await mkdir(otherCwd, { recursive: true })
  const other = await manager.createManager('manager', { name: 'Other Project', cwd: otherCwd })
  return { ...handle, manager, otherAgentId: other.agentId }
}

function lastRuntimeText(manager: TestSwarmManager, agentId: string): string {
  const calls = manager.runtimeByAgentId.get(agentId)?.sendCalls ?? []
  const last = calls.at(-1)?.message
  return typeof last === 'string' ? last : last?.text ?? ''
}

describe('Session references acceptance', () => {
  it('lets a referenced session in another project and the referencing session message each other', async () => {
    const f = await fixture()
    try {
      // Without a reference the recipient gets an anonymous internal message it cannot reply to.
      await f.manager.sendMessage('manager', f.otherAgentId, 'unreferenced', 'auto')
      expect(lastRuntimeText(f.manager, f.otherAgentId)).not.toContain('[projectAgentContext]')

      await f.manager.handleUserMessage('Ask [@Other Project] about the API', {
        targetAgentId: 'manager',
        sessionReferenceAgentIds: [f.otherAgentId, 'manager', 'missing-session'],
      })
      const guidance = lastRuntimeText(f.manager, 'manager')
      expect(guidance).toContain('[sessionReferences]')
      expect(guidance).toContain(f.otherAgentId)
      expect(guidance).toContain('Other Project')
      expect(guidance).not.toContain('missing-session')

      await f.manager.sendMessage('manager', f.otherAgentId, 'What is the API shape?', 'auto')
      const inbound = lastRuntimeText(f.manager, f.otherAgentId)
      expect(inbound).toContain('[projectAgentContext]')
      expect(inbound).toContain('"fromAgentId":"manager"')
      expect(inbound).toContain('"external":false')
      expect(inbound).toContain('What is the API shape?')

      await f.manager.sendMessage(f.otherAgentId, 'manager', 'It is REST.', 'auto')
      expect(lastRuntimeText(f.manager, 'manager')).toContain('It is REST.')
      // Peer links stay private to the backend; public snapshots never carry them.
      expect(f.manager.getAgent('manager')?.sessionReferenceAgentIds).toBeUndefined()

      const rebooted = new TestSwarmManager(f.config)
      await rebooted.boot()
      await rebooted.sendMessage(f.otherAgentId, 'manager', 'Still linked after restart', 'auto')
      expect(lastRuntimeText(rebooted, 'manager')).toContain('Still linked after restart')
    } finally {
      await f.cleanup()
    }
  })
})
