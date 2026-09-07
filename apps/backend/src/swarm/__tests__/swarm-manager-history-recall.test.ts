import { SessionManager } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { getHistoryRecallIndexPath } from '../storage/data-paths.js'
import { makeTempConfig, TestSwarmManager, bootWithDefaultManager } from '../../test-support/index.js'
import { buildSwarmTools } from '../swarm-tools.js'

describe('manager history recall integration', () => {
  it('indexes new-session native appends without a search clock and exposes session discovery after boot/restart', async () => {
    const config = await makeTempConfig({ prefix: 'history-autonomous-', omitSharedAuthFile: true, omitSharedSecretsFile: true })
    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    let restarted: TestSwarmManager | undefined
    try {
      const { sessionAgent } = await manager.createSession('manager', { name: 'Autonomous recall' })
      const native = SessionManager.open(sessionAgent.sessionFile)
      native.appendMessage({ role: 'user', content: 'autonomouschartreuse evidence', timestamp: Date.now() })
      native.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Persisted.' }], timestamp: Date.now() } as any)
      // Read only the derived database: neither search nor sessions may drive catch-up.
      await expect.poll(() => {
        const db = new Database(getHistoryRecallIndexPath(config.paths.dataDir), { readonly: true })
        try { return (db.prepare("SELECT count(*) AS n FROM entry_payload WHERE text LIKE '%autonomouschartreuse%'").get() as { n: number }).n }
        finally { db.close() }
      }, { timeout: 5000 }).toBeGreaterThan(0)
      const tool = buildSwarmTools(manager, sessionAgent).find(entry => entry.name === 'history')!
      const found = await tool.execute('discover', { op: 'sessions', query: 'Autonomous' })
      expect(JSON.stringify(found)).toContain(sessionAgent.agentId)
      await manager.disposeHistoryRecall()
      restarted = new TestSwarmManager(config)
      await restarted.boot()
      const response = await restarted.searchHistory(sessionAgent.agentId, { query: 'autonomouschartreuse' })
      expect(response.coverage?.catalogHydration).toBe('complete')
      expect(response.results).toHaveLength(1)
    } finally {
      await manager.disposeHistoryRecall()
      await restarted?.disposeHistoryRecall()
    }
  })
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
      const windowPage = await tool!.execute('windows-call', { op: 'windows', actorAgentId: sessionAgent.agentId })
      const windows = JSON.parse((windowPage.content[0] as { text: string }).text).results
      expect(windows.some((window: { windowId: string }) => window.windowId === 'window:initial')).toBe(true)
      const itemPage = await tool!.execute('items-call', { op: 'items', actorAgentId: sessionAgent.agentId, role: 'user', windowId: 'window:initial' })
      expect(JSON.stringify(itemPage)).toContain('violet sentinel')
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
