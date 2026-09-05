import { SessionManager } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { makeTempConfig, TestSwarmManager, bootWithDefaultManager } from '../../test-support/index.js'
import { buildSwarmTools } from '../swarm-tools.js'

describe('manager history recall integration', () => {
  it('exposes canonical earlier-window evidence through the real tool and invalidates on clear', async () => {
    const config = await makeTempConfig({ prefix: 'history-integration-', omitSharedAuthFile: true, omitSharedSecretsFile: true })
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    try {
      const { sessionAgent } = await manager.createSession('manager', { name: 'Recall test' })
      const native = SessionManager.open(sessionAgent.sessionFile)
      native.appendMessage({ role: 'user', content: 'Keep the violet sentinel requirement.', timestamp: 1 })
      native.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Acknowledged.' }], timestamp: 1 } as any)
      const anchor = native.appendCustomEntry('forge_context_boundary', { mode: 'fresh' })
      native.appendCompaction('Fresh checkpoint', anchor, 100, { forgeContext: { mode: 'fresh' } }, true)
      native.appendMessage({ role: 'user', content: 'Continue in the new window.', timestamp: 2 })
      const tool = buildSwarmTools(manager, sessionAgent).find(entry => entry.name === 'history')
      expect(tool).toBeDefined()
      const result = await tool!.execute('search-call', { op: 'search', query: '"violet sentinel"' })
      const hits = JSON.parse((result.content[0] as { text: string }).text).results
      expect(hits).toHaveLength(1)
      const read = await tool!.execute('read-call', { op: 'read', ref: hits[0].ref })
      expect(JSON.parse((read.content[0] as { text: string }).text).entry.text).toContain('violet sentinel')
      expect(JSON.stringify(native.buildSessionContext().messages)).not.toContain('violet sentinel')
      await manager.clearSessionConversation(sessionAgent.agentId)
      const cleared = await manager.searchHistory(sessionAgent.agentId, { query: '"violet sentinel"' })
      expect(cleared.results).toHaveLength(0)
      await expect(manager.readHistory(sessionAgent.agentId, { ref: hits[0].ref })).rejects.toThrow()
    } finally {
      await manager.disposeHistoryRecall()
    }
  })
})
