import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentDescriptor } from '@forge/protocol'
import type { SwarmConfig } from '../../../../swarm/types.js'
import { getSessionDir, getSessionFilePath } from '../../../../swarm/storage/data-paths.js'
import { CONVERSATION_ENTRY_TYPE } from '../../../../swarm/session/conversation-timeline.js'
import type { SessionAuditServiceHost } from '../../../../swarm/session/session-audit-service.js'
import { sendJson } from '../../../http-utils.js'
import type { HttpRoute } from '../../shared/http-route.js'
import { createSessionAuditRoutes } from '../session-audit-routes.js'

const now = '2026-01-01T00:00:00.000Z'

describe('session audit routes', () => {
  it('serves paginated canonical session audit pages and category filters', async () => {
    const fixture = await createFixture()
    await writeSessionLines(fixture.dataDir, fixture.manager, [
      sessionHeader(),
      conversationRow('message', { type: 'conversation_message', agentId: fixture.manager.agentId, role: 'user', text: 'hello', timestamp: now, source: 'user_input' }),
      conversationRow('tool', { type: 'agent_tool_call', agentId: fixture.manager.agentId, actorAgentId: fixture.manager.agentId, timestamp: now, kind: 'tool_execution_start', toolName: 'spawn_agent', text: 'spawn' }),
    ])
    const server = await createRouteServer(createSessionAuditRoutes({ swarmManager: fixture.host }))

    try {
      const response = await fetch(`${server.baseUrl}/api/sessions/${fixture.manager.agentId}/audit?limit=2`)
      const firstPage = await response.json() as { items: Array<{ category: string }>; nextCursor?: string; hasMore: boolean }

      expect(response.status).toBe(200)
      expect(firstPage.items.map((item) => item.category)).toEqual(['session_header', 'conversation_message'])
      expect(firstPage.hasMore).toBe(true)
      expect(firstPage.nextCursor).toBeTruthy()

      const nextResponse = await fetch(`${server.baseUrl}/api/sessions/${fixture.manager.agentId}/audit?cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`)
      const nextPage = await nextResponse.json() as { items: Array<{ category: string; toolName?: string }>; hasMore: boolean }
      expect(nextResponse.status).toBe(200)
      expect(nextPage.items).toEqual([expect.objectContaining({ category: 'manager_tool_call', toolName: 'spawn_agent' })])
      expect(nextPage.hasMore).toBe(false)

      const filteredResponse = await fetch(`${server.baseUrl}/api/sessions/${fixture.manager.agentId}/audit?category=manager_tool_call`)
      const filteredPage = await filteredResponse.json() as { items: Array<{ category: string }> }
      expect(filteredResponse.status).toBe(200)
      expect(filteredPage.items.map((item) => item.category)).toEqual(['manager_tool_call'])
    } finally {
      await server.close()
    }
  })

  it('returns 400 for unsupported search, bad cursors, worker scope, and invalid methods', async () => {
    const fixture = await createFixture()
    await writeSessionLines(fixture.dataDir, fixture.manager, [sessionHeader()])
    const server = await createRouteServer(createSessionAuditRoutes({ swarmManager: fixture.host }))

    try {
      const searchResponse = await fetch(`${server.baseUrl}/api/sessions/${fixture.manager.agentId}/audit?q=hello`)
      expect(searchResponse.status).toBe(400)
      await expect(searchResponse.json()).resolves.toMatchObject({ error: expect.stringContaining('search is not supported') })

      const cursorResponse = await fetch(`${server.baseUrl}/api/sessions/${fixture.manager.agentId}/audit?cursor=bad`)
      expect(cursorResponse.status).toBe(400)

      const workerResponse = await fetch(`${server.baseUrl}/api/sessions/${fixture.manager.agentId}/audit?scope=worker&workerId=worker-1`)
      expect(workerResponse.status).toBe(400)

      const postResponse = await fetch(`${server.baseUrl}/api/sessions/${fixture.manager.agentId}/audit`, { method: 'POST' })
      expect(postResponse.status).toBe(405)
      expect(postResponse.headers.get('allow')).toContain('GET')
    } finally {
      await server.close()
    }
  })

  it('returns 404 for unknown or non-manager sessions and supports OPTIONS', async () => {
    const fixture = await createFixture()
    fixture.agents.push(createDescriptor({ agentId: 'worker-1', managerId: fixture.manager.agentId, role: 'worker', profileId: fixture.manager.profileId }))
    const server = await createRouteServer(createSessionAuditRoutes({ swarmManager: fixture.host }))

    try {
      const missingResponse = await fetch(`${server.baseUrl}/api/sessions/missing/audit`)
      expect(missingResponse.status).toBe(404)

      const workerResponse = await fetch(`${server.baseUrl}/api/sessions/worker-1/audit`)
      expect(workerResponse.status).toBe(404)

      const optionsResponse = await fetch(`${server.baseUrl}/api/sessions/${fixture.manager.agentId}/audit`, { method: 'OPTIONS' })
      expect(optionsResponse.status).toBe(204)
    } finally {
      await server.close()
    }
  })
})

async function createFixture(): Promise<{
  dataDir: string
  manager: AgentDescriptor
  agents: AgentDescriptor[]
  host: SessionAuditServiceHost
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'forge-session-audit-route-'))
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

function sessionHeader(): string {
  return JSON.stringify({ type: 'session', id: 'session-header', version: 3, timestamp: now, cwd: '/tmp' })
}

function conversationRow(id: string, data: Record<string, unknown>): string {
  return JSON.stringify({ type: 'custom', id, parentId: null, timestamp: now, customType: CONVERSATION_ENTRY_TYPE, data })
}

async function createRouteServer(routes: HttpRoute[]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void handleRoute(routes, request, response)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

async function handleRoute(routes: HttpRoute[], request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    const route = routes.find((candidate) => candidate.matches(requestUrl.pathname))
    if (!route) {
      sendJson(response, 404, { error: 'Not Found' })
      return
    }
    await route.handle(request, response, requestUrl)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(response, 500, { error: message })
  }
}
