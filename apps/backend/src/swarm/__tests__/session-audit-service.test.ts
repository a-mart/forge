import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { AgentDescriptor } from '@forge/protocol'
import { getSessionDir, getSessionFilePath, getWorkerSessionFilePath, getWorkersDir } from '../storage/data-paths.js'
import { CONVERSATION_ENTRY_TYPE } from '../session/conversation-timeline.js'
import { SessionAuditService, type SessionAuditServiceHost } from '../session/session-audit-service.js'
import type { SwarmConfig } from '../types.js'

const now = '2026-01-01T00:00:00.000Z'

describe('SessionAuditService', () => {
  it('reads canonical session JSONL pages with malformed lines instead of failing the page', async () => {
    const fixture = await createFixture()
    await writeSessionLines(fixture.dataDir, fixture.manager, [
      sessionHeader(),
      conversationRow('entry-1', { type: 'conversation_message', agentId: fixture.manager.agentId, role: 'user', text: 'hello', timestamp: now, source: 'user_input' }),
      '{not json',
      conversationRow('entry-2', { type: 'agent_tool_call', agentId: fixture.manager.agentId, actorAgentId: fixture.manager.agentId, timestamp: now, kind: 'tool_execution_start', toolName: 'spawn_agent', text: 'spawn' }),
    ])

    const service = new SessionAuditService(fixture.host)
    const page = await service.getSessionAuditPage(fixture.manager.agentId, { limit: 10 })

    expect(page.sourceKind).toBe('canonical_session_jsonl')
    expect(page.items.map((item) => item.category)).toEqual([
      'session_header',
      'conversation_message',
      'malformed',
      'manager_tool_call',
    ])
    expect(page.items[1]).toMatchObject({ conversationSource: 'user_input' })
    expect(page.items[1].id).toMatch(/^canonical_session_jsonl:session:\d+$/)
    expect(page.items[2].parseError).toBeTruthy()
    expect(page.items[3]).toMatchObject({ toolName: 'spawn_agent', renderable: true })
    expect('conversationEntry' in page.items[1]).toBe(false)
  })

  it('paginates by byte cursor without relying on the 2,000-entry projected history cap', async () => {
    const fixture = await createFixture()
    const lines = [sessionHeader()]
    for (let index = 0; index < 2105; index += 1) {
      lines.push(conversationRow(`entry-${index}`, {
        type: index === 2050 ? 'conversation_log' : 'conversation_message',
        agentId: fixture.manager.agentId,
        role: index === 2050 ? 'assistant' : 'user',
        text: `row ${index}`,
        timestamp: now,
        source: index === 2050 ? 'runtime_log' : 'user_input',
        kind: index === 2050 ? 'message_end' : undefined,
      }))
    }
    await writeSessionLines(fixture.dataDir, fixture.manager, lines)

    const service = new SessionAuditService(fixture.host)
    let cursor: string | undefined
    let count = 0
    let sawRuntimeLog = false
    for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
      const page = await service.getSessionAuditPage(fixture.manager.agentId, { limit: 500, cursor })
      count += page.items.length
      sawRuntimeLog ||= page.items.some((item) => item.category === 'runtime_log')
      cursor = page.nextCursor
      if (!cursor) {
        break
      }
    }

    expect(count).toBe(2106)
    expect(sawRuntimeLog).toBe(true)
  })

  it('applies category and type filters while advancing bounded pagination', async () => {
    const fixture = await createFixture()
    await writeSessionLines(fixture.dataDir, fixture.manager, [
      sessionHeader(),
      conversationRow('message', { type: 'conversation_message', agentId: fixture.manager.agentId, role: 'user', text: 'hello', timestamp: now, source: 'user_input' }),
      conversationRow('tool', { type: 'agent_tool_call', agentId: fixture.manager.agentId, actorAgentId: 'worker-1', timestamp: now, kind: 'tool_execution_end', toolName: 'bash', text: 'done' }),
      customRow('custom-1', 'other_custom', { ok: true }),
    ])

    const service = new SessionAuditService(fixture.host)
    const toolPage = await service.getSessionAuditPage(fixture.manager.agentId, { categories: ['worker_tool_call'], limit: 10 })
    const customPage = await service.getSessionAuditPage(fixture.manager.agentId, { types: ['other_custom'], limit: 10 })

    expect(toolPage.items).toHaveLength(1)
    expect(toolPage.items[0]).toMatchObject({ category: 'worker_tool_call', actorAgentId: 'worker-1' })
    expect(customPage.items).toHaveLength(1)
    expect(customPage.items[0]).toMatchObject({ category: 'custom', customType: 'other_custom' })
  })

  it('caps raw and text previews for oversized payloads', async () => {
    const fixture = await createFixture()
    const longText = 'x'.repeat(20_000)
    await writeSessionLines(fixture.dataDir, fixture.manager, [
      sessionHeader(),
      conversationRow('large', { type: 'conversation_message', agentId: fixture.manager.agentId, role: 'user', text: longText, timestamp: now, source: 'user_input' }),
    ])

    const service = new SessionAuditService(fixture.host)
    const page = await service.getSessionAuditPage(fixture.manager.agentId, { limit: 10 })
    const item = page.items.find((candidate) => candidate.wrapperId === 'large')

    expect(item?.previewTruncated).toBe(true)
    expect(item?.rawPreviewTruncated).toBe(true)
    expect(item?.preview.length).toBeLessThan(longText.length)
    expect(item?.rawPreview.length).toBeLessThan(longText.length)
  })

  it('bounds a single huge JSONL line and emits one truncated audit row', async () => {
    const fixture = await createFixture()
    const sessionDir = getSessionDir(fixture.dataDir, fixture.manager.profileId ?? fixture.manager.agentId, fixture.manager.agentId)
    await mkdir(sessionDir, { recursive: true })
    const hugeLine = `{"type":"custom","id":"huge","data":"${'x'.repeat(1024 * 1024 + 128)}"}`
    await writeFile(getSessionFilePath(fixture.dataDir, fixture.manager.profileId ?? fixture.manager.agentId, fixture.manager.agentId), hugeLine, 'utf8')

    const service = new SessionAuditService(fixture.host)
    const page = await service.getSessionAuditPage(fixture.manager.agentId, { limit: 10 })

    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      category: 'unknown',
      hiddenReason: 'payload_truncated',
      byteOffset: 0,
      nextByteOffset: Buffer.byteLength(hugeLine, 'utf8'),
      rawBytes: Buffer.byteLength(hugeLine, 'utf8'),
    })
    expect(page.items[0].rawPreview.length).toBeLessThan(20_000)
    expect(page.items[0].parseError).toContain('parser cap')
  })

  it('derives the canonical session path server-side instead of trusting descriptor paths', async () => {
    const fixture = await createFixture()
    fixture.manager.sessionFile = join(fixture.dataDir, 'outside.jsonl')
    await writeFile(fixture.manager.sessionFile, [sessionHeader(), customRow('outside', 'outside', {})].join('\n'), 'utf8')
    await writeSessionLines(fixture.dataDir, fixture.manager, [
      sessionHeader(),
      conversationRow('canonical', { type: 'conversation_message', agentId: fixture.manager.agentId, role: 'user', text: 'canonical', timestamp: now, source: 'user_input' }),
    ])

    const service = new SessionAuditService(fixture.host)
    const page = await service.getSessionAuditPage(fixture.manager.agentId, { limit: 10 })

    expect(page.items.map((item) => item.wrapperId)).toContain('canonical')
    expect(page.items.map((item) => item.wrapperId)).not.toContain('outside')
  })

  it('reads descriptor-owned worker transcript sources with source-aware pagination and malformed rows', async () => {
    const fixture = await createFixture()
    const worker = createDescriptor({ agentId: 'worker-1', managerId: fixture.manager.agentId, role: 'worker', profileId: fixture.manager.profileId })
    fixture.agents.push(worker)
    await writeSessionLines(fixture.dataDir, fixture.manager, [sessionHeader()])
    await writeWorkerLines(fixture.dataDir, fixture.manager, worker.agentId, [
      conversationRow('worker-message', { type: 'conversation_message', agentId: worker.agentId, role: 'assistant', text: 'worker hello', timestamp: now, source: 'worker' }),
      '{not json',
      conversationRow('worker-tool', { type: 'agent_tool_call', agentId: fixture.manager.agentId, actorAgentId: worker.agentId, timestamp: now, kind: 'tool_execution_end', toolName: 'bash', text: 'done' }),
    ])

    const service = new SessionAuditService(fixture.host)
    const firstPage = await service.getSessionAuditPage(fixture.manager.agentId, { scope: 'worker', workerId: worker.agentId, limit: 2 })

    expect(firstPage).toMatchObject({
      scope: 'worker',
      sourceId: worker.agentId,
      sourceKind: 'canonical_worker_jsonl',
      hasMore: true,
    })
    expect(firstPage.items.map((item) => item.category)).toEqual(['conversation_message', 'malformed'])
    expect(firstPage.items[0]).toMatchObject({
      scope: 'worker',
      sourceId: worker.agentId,
      sourceKind: 'canonical_worker_jsonl',
      relativePath: `workers/${worker.agentId}.jsonl`,
      conversationSource: 'worker',
    })
    expect(firstPage.items[0].id).toMatch(/^canonical_worker_jsonl:worker-1:\d+$/)
    expect(firstPage.items[0].id).not.toBe(`canonical_session_jsonl:session:${firstPage.items[0].byteOffset}`)
    expect(firstPage.items[1].parseError).toBeTruthy()

    const secondPage = await service.getSessionAuditPage(fixture.manager.agentId, { scope: 'worker', workerId: worker.agentId, cursor: firstPage.nextCursor })
    expect(secondPage.items).toEqual([expect.objectContaining({ category: 'worker_tool_call', actorAgentId: worker.agentId, toolName: 'bash' })])
    expect(secondPage.hasMore).toBe(false)
  })

  it('supports safely scoped orphan worker transcript files', async () => {
    const fixture = await createFixture()
    await writeSessionLines(fixture.dataDir, fixture.manager, [sessionHeader()])
    await writeWorkerLines(fixture.dataDir, fixture.manager, 'orphan-worker', [
      conversationRow('orphan-message', { type: 'conversation_message', agentId: 'orphan-worker', role: 'assistant', text: 'orphan hello', timestamp: now, source: 'worker' }),
    ])

    const service = new SessionAuditService(fixture.host)
    const page = await service.getSessionAuditPage(fixture.manager.agentId, { scope: 'worker', workerId: 'orphan-worker', limit: 10 })

    expect(page.sourceId).toBe('orphan-worker')
    expect(page.items).toEqual([expect.objectContaining({ wrapperId: 'orphan-message', sourceId: 'orphan-worker' })])
    expect(page.manifest.workers).toEqual([expect.objectContaining({ workerId: 'orphan-worker', relativePath: 'workers/orphan-worker.jsonl' })])
  })

  it('skips non-regular orphan worker entries and rejects them as audit sources', async () => {
    const fixture = await createFixture()
    await writeSessionLines(fixture.dataDir, fixture.manager, [sessionHeader()])
    const workerId = 'directory-worker'
    await mkdir(getWorkerPath(fixture.dataDir, fixture.manager, workerId), { recursive: true })

    const service = new SessionAuditService(fixture.host)
    const managerPage = await service.getSessionAuditPage(fixture.manager.agentId, { limit: 10 })

    expect(managerPage.manifest.workers.map((worker) => worker.workerId)).not.toContain(workerId)
    await expect(service.getSessionAuditPage(fixture.manager.agentId, { scope: 'worker', workerId })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('rejects symlinked descriptor worker transcript files without following them', async () => {
    if (process.platform === 'win32') {
      return
    }

    const fixture = await createFixture()
    const worker = createDescriptor({ agentId: 'worker-symlink', managerId: fixture.manager.agentId, role: 'worker', profileId: fixture.manager.profileId })
    fixture.agents.push(worker)
    await writeSessionLines(fixture.dataDir, fixture.manager, [sessionHeader()])
    const outsidePath = join(fixture.dataDir, 'outside-worker.jsonl')
    await writeFile(outsidePath, `${conversationRow('outside-worker-message', { type: 'conversation_message', agentId: worker.agentId, role: 'assistant', text: 'outside', timestamp: now, source: 'worker' })}\n`, 'utf8')
    await mkdir(getWorkersDir(fixture.dataDir, fixture.manager.profileId ?? fixture.manager.agentId, fixture.manager.agentId), { recursive: true })
    await symlink(outsidePath, getWorkerPath(fixture.dataDir, fixture.manager, worker.agentId))

    const service = new SessionAuditService(fixture.host)
    const managerPage = await service.getSessionAuditPage(fixture.manager.agentId, { limit: 10 })

    expect(managerPage.manifest.workers.map((summary) => summary.workerId)).not.toContain(worker.agentId)
    await expect(service.getSessionAuditPage(fixture.manager.agentId, { scope: 'worker', workerId: worker.agentId })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('rejects unknown sessions, non-manager agents, invalid worker sources, and invalid cursors', async () => {
    const fixture = await createFixture()
    const worker = createDescriptor({ agentId: 'worker-1', managerId: fixture.manager.agentId, role: 'worker', profileId: fixture.manager.profileId })
    const otherManagerWorker = createDescriptor({ agentId: 'other-worker', managerId: 'other-manager', role: 'worker', profileId: fixture.manager.profileId })
    fixture.agents.push(worker, otherManagerWorker)
    const service = new SessionAuditService(fixture.host)

    await expect(service.getSessionAuditPage('missing')).rejects.toMatchObject({ statusCode: 404 })
    await expect(service.getSessionAuditPage(worker.agentId)).rejects.toMatchObject({ statusCode: 404 })
    await expect(service.getSessionAuditPage(fixture.manager.agentId, { scope: 'worker' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(service.getSessionAuditPage(fixture.manager.agentId, { scope: 'session', workerId: worker.agentId })).rejects.toMatchObject({ statusCode: 400 })
    await expect(service.getSessionAuditPage(fixture.manager.agentId, { scope: 'worker', workerId: '../worker-1' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(service.getSessionAuditPage(fixture.manager.agentId, { scope: 'worker', workerId: 'missing-worker' })).rejects.toMatchObject({ statusCode: 404 })
    await expect(service.getSessionAuditPage(fixture.manager.agentId, { scope: 'worker', workerId: otherManagerWorker.agentId })).rejects.toMatchObject({ statusCode: 404 })
    await expect(service.getSessionAuditPage(fixture.manager.agentId, { scope: 'worker', workerId: worker.agentId, sourceKind: 'canonical_session_jsonl' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(service.getSessionAuditPage(fixture.manager.agentId, { cursor: 'not-base64' })).rejects.toMatchObject({ statusCode: 400 })
  })
})

async function createFixture(): Promise<{
  dataDir: string
  manager: AgentDescriptor
  agents: AgentDescriptor[]
  host: SessionAuditServiceHost
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-audit-'))
  const manager = createDescriptor({ agentId: 'manager-1', managerId: 'manager-1', role: 'manager', profileId: 'profile-1' })
  const agents = [manager]
  const host: SessionAuditServiceHost = {
    getConfig: () => ({ paths: { dataDir } }) as SwarmConfig,
    getAgent: (agentId) => agents.find((agent) => agent.agentId === agentId),
    listAgents: () => agents,
    listWorkersForSession: (sessionAgentId) => agents.filter((agent) => agent.role === 'worker' && agent.managerId === sessionAgentId),
  }
  return { dataDir, manager, agents, host }
}

function createDescriptor(options: { agentId: string; managerId: string; role: 'manager' | 'worker'; profileId?: string }): AgentDescriptor {
  return {
    agentId: options.agentId,
    managerId: options.managerId,
    displayName: options.agentId,
    role: options.role,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    cwd: '/tmp',
    model: { provider: 'openai-codex', modelId: 'gpt-5.4', thinkingLevel: 'medium' },
    sessionFile: '/ignored/session.jsonl',
    profileId: options.profileId,
  }
}

async function writeSessionLines(dataDir: string, descriptor: AgentDescriptor, lines: string[]): Promise<void> {
  const sessionDir = getSessionDir(dataDir, descriptor.profileId ?? descriptor.agentId, descriptor.agentId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(getSessionFilePath(dataDir, descriptor.profileId ?? descriptor.agentId, descriptor.agentId), `${lines.join('\n')}\n`, 'utf8')
}

async function writeWorkerLines(dataDir: string, manager: AgentDescriptor, workerId: string, lines: string[]): Promise<void> {
  const profileId = manager.profileId ?? manager.agentId
  await mkdir(getWorkersDir(dataDir, profileId, manager.agentId), { recursive: true })
  await writeFile(getWorkerPath(dataDir, manager, workerId), `${lines.join('\n')}\n`, 'utf8')
}

function getWorkerPath(dataDir: string, manager: AgentDescriptor, workerId: string): string {
  return getWorkerSessionFilePath(dataDir, manager.profileId ?? manager.agentId, manager.agentId, workerId)
}

function sessionHeader(): string {
  return JSON.stringify({ type: 'session', id: 'session-header', version: 3, timestamp: now, cwd: '/tmp' })
}

function conversationRow(id: string, data: Record<string, unknown>): string {
  return customRow(id, CONVERSATION_ENTRY_TYPE, data)
}

function customRow(id: string, customType: string, data: unknown): string {
  return JSON.stringify({ type: 'custom', id, parentId: null, timestamp: now, customType, data })
}
