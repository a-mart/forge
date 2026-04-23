import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import WebSocket from 'ws'
import { describe, expect, it } from 'vitest'
import { AuthStorage } from '@mariozechner/pi-coding-agent'
import type { AgentDescriptor } from '../swarm/types.js'
import { DAEMONIZED_ENV_VAR, getControlPidFilePath } from '../reboot/control-pid.js'
import { getCommonKnowledgePath, getProfileUnreadStatePath } from '../swarm/data-paths.js'
import { loadOnboardingState, saveOnboardingPreferences } from '../swarm/onboarding-state.js'
import { SwarmWebSocketServer } from '../ws/server.js'
import type { ServerEvent } from '@forge/protocol'
import { getAvailablePort } from '../test-support/index.js'
import {
  WsServerTestSwarmManager as TestSwarmManager,
  bootWsServerTestManager as bootWithDefaultManager,
  makeWsServerTempConfig as makeTempConfig,
} from '../test-support/ws-integration-harness.js'

async function waitForEvent(
  events: ServerEvent[],
  predicate: (event: ServerEvent) => boolean,
  timeoutMs = 2000,
): Promise<ServerEvent> {
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    const found = events.find(predicate)
    if (found) return found

    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error('Timed out waiting for websocket event')
}

function getUnreadNotifications(
  events: ServerEvent[],
): Array<Extract<ServerEvent, { type: 'unread_notification' }>> {
  return events.filter(
    (event): event is Extract<ServerEvent, { type: 'unread_notification' }> =>
      event.type === 'unread_notification',
  )
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  throw new Error('Timed out waiting for condition')
}

describe('SwarmWebSocketServer', () => {
  it('connect + subscribe + user_message yields manager feed events', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')

    client.send(JSON.stringify({ type: 'subscribe' }))

    await waitForEvent(events, (event) => event.type === 'ready')
    await waitForEvent(events, (event) => event.type === 'agents_snapshot')
    await waitForEvent(events, (event) => event.type === 'conversation_history')

    client.send(JSON.stringify({ type: 'user_message', text: 'hello manager' }))

    const userEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'user_input' &&
        event.text === 'hello manager',
    )

    expect(userEvent.type).toBe('conversation_message')
    if (userEvent.type === 'conversation_message') {
      expect(userEvent.sourceContext).toEqual({ channel: 'web' })
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('bootstrap agents_snapshot excludes streaming workers while preserving manager worker counts', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Hot Worker' })
    const state = manager as unknown as { descriptors: Map<string, AgentDescriptor> }
    const workerDescriptor = state.descriptors.get(worker.agentId)
    expect(workerDescriptor).toBeDefined()
    workerDescriptor!.status = 'streaming'

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))

    const bootstrapSnapshot = await waitForEvent(events, (event) => event.type === 'agents_snapshot')
    expect(bootstrapSnapshot.type).toBe('agents_snapshot')
    if (bootstrapSnapshot.type === 'agents_snapshot') {
      expect(bootstrapSnapshot.agents.some((agent) => agent.agentId === worker.agentId)).toBe(false)
      expect(bootstrapSnapshot.agents.find((agent) => agent.agentId === 'manager')).toMatchObject({
        workerCount: 1,
        activeWorkerCount: 1,
      })
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('broadcasts unread_notification for assistant speak_to_user messages to all subscriptions', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const worker = await manager.spawnAgent('manager', { agentId: 'Unread Worker' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const managerClient = new WebSocket(`ws://${config.host}:${config.port}`)
    const managerEvents: ServerEvent[] = []
    managerClient.on('message', (raw) => {
      managerEvents.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(managerClient, 'open')
    managerClient.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(
      managerEvents,
      (event) => event.type === 'ready' && event.subscribedAgentId === 'manager',
    )
    await waitForEvent(
      managerEvents,
      (event) => event.type === 'conversation_history' && event.agentId === 'manager',
    )

    const workerClient = new WebSocket(`ws://${config.host}:${config.port}`)
    const workerEvents: ServerEvent[] = []
    workerClient.on('message', (raw) => {
      workerEvents.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(workerClient, 'open')
    workerClient.send(JSON.stringify({ type: 'subscribe', agentId: worker.agentId }))
    await waitForEvent(
      workerEvents,
      (event) => event.type === 'ready' && event.subscribedAgentId === worker.agentId,
    )
    await waitForEvent(
      workerEvents,
      (event) => event.type === 'conversation_history' && event.agentId === worker.agentId,
    )

    manager.emit(
      'conversation_message',
      {
        type: 'conversation_message',
        agentId: 'manager',
        role: 'assistant',
        text: 'assistant update',
        timestamp: new Date().toISOString(),
        source: 'speak_to_user',
      } satisfies ServerEvent,
    )

    await waitForEvent(
      managerEvents,
      (event) => event.type === 'conversation_message' && event.agentId === 'manager' && event.text === 'assistant update',
    )
    const managerUnreadEvent = await waitForEvent(
      managerEvents,
      (event) => event.type === 'unread_notification' && event.agentId === 'manager',
    )
    expect(managerUnreadEvent).toEqual({
      type: 'unread_notification',
      agentId: 'manager',
      reason: 'message',
      sessionAgentId: 'manager',
    })

    const workerUnreadEvent = await waitForEvent(
      workerEvents,
      (event) => event.type === 'unread_notification' && event.agentId === 'manager',
    )
    expect(workerUnreadEvent).toEqual({
      type: 'unread_notification',
      agentId: 'manager',
      reason: 'message',
      sessionAgentId: 'manager',
    })

    expect(
      workerEvents.some(
        (event) => event.type === 'conversation_message' && event.agentId === 'manager' && event.text === 'assistant update',
      ),
    ).toBe(false)

    const unreadBefore = workerEvents.filter((event) => event.type === 'unread_notification').length

    manager.emit(
      'conversation_message',
      {
        type: 'conversation_message',
        agentId: 'manager',
        role: 'assistant',
        text: 'system note',
        timestamp: new Date().toISOString(),
        source: 'system',
      } satisfies ServerEvent,
    )

    await waitForEvent(
      managerEvents,
      (event) => event.type === 'conversation_message' && event.agentId === 'manager' && event.text === 'system note',
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    const unreadAfter = workerEvents.filter((event) => event.type === 'unread_notification').length
    expect(unreadAfter).toBe(unreadBefore)

    managerClient.close()
    await once(managerClient, 'close')
    workerClient.close()
    await once(workerClient, 'close')
    await server.stop()
  })

  it('broadcasts unread_notification for inbound project-agent messages and increments unread for inactive target sessions', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const { sessionAgent } = await manager.createSession('manager', { label: 'Release Notes' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })
    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(
      events,
      (event) => event.type === 'ready' && event.subscribedAgentId === 'manager',
    )

    manager.emit(
      'conversation_message',
      {
        type: 'conversation_message',
        agentId: sessionAgent.agentId,
        role: 'user',
        text: 'Please draft release notes.',
        timestamp: new Date().toISOString(),
        source: 'project_agent_input',
        projectAgentContext: {
          fromAgentId: 'qa--s2',
          fromDisplayName: 'QA',
        },
      } satisfies ServerEvent,
    )

    const unreadEvent = await waitForEvent(
      events,
      (event) => event.type === 'unread_notification' && event.agentId === sessionAgent.agentId,
    )
    expect(unreadEvent).toEqual({
      type: 'unread_notification',
      agentId: sessionAgent.agentId,
      reason: 'message',
      sessionAgentId: sessionAgent.agentId,
    })
    await waitForEvent(
      events,
      (event) => event.type === 'unread_count_update' && event.agentId === sessionAgent.agentId && event.count === 1,
    )

    expect(
      events.some(
        (event) =>
          event.type === 'conversation_message' &&
          event.agentId === sessionAgent.agentId &&
          event.text === 'Please draft release notes.',
      ),
    ).toBe(false)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('preserves Unicode conversation_message text over WebSocket delivery', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const client = new WebSocket(`ws://${config.host}:${config.port}`)
      const events: ServerEvent[] = []

      client.on('message', (raw) => {
        events.push(JSON.parse(raw.toString()) as ServerEvent)
      })

      await once(client, 'open')
      client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
      await waitForEvent(
        events,
        (event) => event.type === 'ready' && event.subscribedAgentId === 'manager',
      )
      await waitForEvent(
        events,
        (event) => event.type === 'conversation_history' && event.agentId === 'manager',
      )

      const unicodeReply = 'Unicode — “quotes” café'
      await manager.publishToUser('manager', unicodeReply, 'speak_to_user')

      await waitForEvent(
        events,
        (event) => event.type === 'conversation_message' && event.agentId === 'manager' && event.text === unicodeReply,
      )

      client.close()
      await once(client, 'close')
    } finally {
      await server.stop()
    }
  })

  it('suppresses unread_notification events for cortex review sessions', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const { sessionAgent: reviewSession } = await manager.createSession('manager', {
      label: 'Review Run',
      sessionPurpose: 'cortex_review',
    })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const reviewClient = new WebSocket(`ws://${config.host}:${config.port}`)
    const reviewEvents: ServerEvent[] = []
    reviewClient.on('message', (raw) => {
      reviewEvents.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(reviewClient, 'open')
    reviewClient.send(JSON.stringify({ type: 'subscribe', agentId: reviewSession.agentId }))
    await waitForEvent(
      reviewEvents,
      (event) => event.type === 'ready' && event.subscribedAgentId === reviewSession.agentId,
    )
    await waitForEvent(
      reviewEvents,
      (event) => event.type === 'conversation_history' && event.agentId === reviewSession.agentId,
    )

    const managerClient = new WebSocket(`ws://${config.host}:${config.port}`)
    const managerEvents: ServerEvent[] = []
    managerClient.on('message', (raw) => {
      managerEvents.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(managerClient, 'open')
    managerClient.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(
      managerEvents,
      (event) => event.type === 'ready' && event.subscribedAgentId === 'manager',
    )
    await waitForEvent(
      managerEvents,
      (event) => event.type === 'conversation_history' && event.agentId === 'manager',
    )

    manager.emit(
      'conversation_message',
      {
        type: 'conversation_message',
        agentId: reviewSession.agentId,
        role: 'assistant',
        text: 'review assistant update',
        timestamp: new Date().toISOString(),
        source: 'speak_to_user',
      } satisfies ServerEvent,
    )

    await waitForEvent(
      reviewEvents,
      (event) => event.type === 'conversation_message' && event.agentId === reviewSession.agentId && event.text === 'review assistant update',
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(reviewEvents.some((event) => event.type === 'unread_notification' && event.agentId === reviewSession.agentId)).toBe(false)
    expect(managerEvents.some((event) => event.type === 'unread_notification' && event.agentId === reviewSession.agentId)).toBe(false)

    reviewClient.close()
    await once(reviewClient, 'close')
    managerClient.close()
    await once(managerClient, 'close')
    await server.stop()
  })

  it('includes unread snapshot in bootstrap and marks subscribed session as read', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const { sessionAgent: secondarySession } = await manager.createSession('manager', {
      label: 'Secondary',
    })

    const unreadStatePath = getProfileUnreadStatePath(config.paths.dataDir, 'manager')
    await mkdir(dirname(unreadStatePath), { recursive: true })
    await writeFile(
      unreadStatePath,
      `${JSON.stringify({ counts: { manager: 3, [secondarySession.agentId]: 2 } }, null, 2)}\n`,
      'utf8',
    )

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))

    await waitForEvent(
      events,
      (event) => event.type === 'ready' && event.subscribedAgentId === 'manager',
    )

    await waitForEvent(
      events,
      (event) => event.type === 'unread_count_update' && event.agentId === 'manager' && event.count === 0,
    )

    const snapshot = await waitForEvent(events, (event) => event.type === 'unread_counts_snapshot')
    expect(snapshot.type).toBe('unread_counts_snapshot')
    if (snapshot.type === 'unread_counts_snapshot') {
      expect(snapshot.counts[secondarySession.agentId]).toBe(2)
      expect(snapshot.counts.manager).toBeUndefined()
    }

    client.close()
    await once(client, 'close')
    await server.stop()

    const persisted = JSON.parse(await readFile(unreadStatePath, 'utf8')) as { counts: Record<string, number> }
    expect(persisted).toEqual({ counts: { [secondarySession.agentId]: 2 } })
  })

  it('suppresses unread counts while subscribed to the owning worker session', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const worker = await manager.spawnAgent('manager', { agentId: 'Unread Worker' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: worker.agentId }))
    await waitForEvent(
      events,
      (event) => event.type === 'ready' && event.subscribedAgentId === worker.agentId,
    )

    manager.emit(
      'conversation_message',
      {
        type: 'conversation_message',
        agentId: worker.agentId,
        role: 'assistant',
        text: 'worker update',
        timestamp: new Date().toISOString(),
        source: 'speak_to_user',
      } satisfies ServerEvent,
    )

    await waitForCondition(() => getUnreadNotifications(events).length === 1)
    expect(getUnreadNotifications(events)[0]).toEqual({
      type: 'unread_notification',
      agentId: worker.agentId,
      reason: 'message',
      sessionAgentId: 'manager',
    })
    await new Promise((resolve) => setTimeout(resolve, 75))
    expect(events.some((event) => event.type === 'unread_count_update' && event.agentId === 'manager')).toBe(false)

    manager.emit(
      'choice_request',
      {
        type: 'choice_request',
        agentId: worker.agentId,
        choiceId: 'choice-1',
        status: 'pending',
        questions: [{ id: 'q1', question: 'Pick one' }],
        timestamp: new Date().toISOString(),
      } satisfies ServerEvent,
    )

    await waitForCondition(() => getUnreadNotifications(events).length === 2)
    expect(getUnreadNotifications(events)[1]).toEqual({
      type: 'unread_notification',
      agentId: worker.agentId,
      reason: 'choice_request',
      sessionAgentId: 'manager',
    })
    await new Promise((resolve) => setTimeout(resolve, 75))
    expect(events.some((event) => event.type === 'unread_count_update' && event.agentId === 'manager')).toBe(false)

    const unreadCountBeforeNonPending = getUnreadNotifications(events).length
    manager.emit(
      'choice_request',
      {
        type: 'choice_request',
        agentId: worker.agentId,
        choiceId: 'choice-1',
        status: 'answered',
        questions: [{ id: 'q1', question: 'Pick one' }],
        answers: [{ questionId: 'q1', selectedOptionIds: [], text: 'Option A' }],
        timestamp: new Date().toISOString(),
      } satisfies ServerEvent,
    )

    await new Promise((resolve) => setTimeout(resolve, 75))
    expect(getUnreadNotifications(events)).toHaveLength(unreadCountBeforeNonPending)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('routes mark_unread before subscription checks and broadcasts unread updates', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const observer = new WebSocket(`ws://${config.host}:${config.port}`)
    const observerEvents: ServerEvent[] = []
    observer.on('message', (raw) => {
      observerEvents.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(observer, 'open')
    observer.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(
      observerEvents,
      (event) => event.type === 'ready' && event.subscribedAgentId === 'manager',
    )

    const actor = new WebSocket(`ws://${config.host}:${config.port}`)
    const actorEvents: ServerEvent[] = []
    actor.on('message', (raw) => {
      actorEvents.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(actor, 'open')
    actor.send(JSON.stringify({ type: 'mark_unread', agentId: 'manager', requestId: 'req-mark' }))

    await waitForEvent(
      observerEvents,
      (event) => event.type === 'unread_count_update' && event.agentId === 'manager' && event.count === 1,
    )

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(actorEvents.some((event) => event.type === 'error' && event.code === 'NOT_SUBSCRIBED')).toBe(false)

    actor.close()
    await once(actor, 'close')
    observer.close()
    await once(observer, 'close')
    await server.stop()
  })

  it('ignores mark_unread for unknown agent ids', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const unreadStatePath = getProfileUnreadStatePath(config.paths.dataDir, 'manager')

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const observer = new WebSocket(`ws://${config.host}:${config.port}`)
    const observerEvents: ServerEvent[] = []
    observer.on('message', (raw) => {
      observerEvents.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(observer, 'open')
    observer.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(
      observerEvents,
      (event) => event.type === 'ready' && event.subscribedAgentId === 'manager',
    )

    const actor = new WebSocket(`ws://${config.host}:${config.port}`)
    await once(actor, 'open')
    actor.send(JSON.stringify({ type: 'mark_unread', agentId: 'ghost-session', requestId: 'req-ghost' }))

    await new Promise((resolve) => setTimeout(resolve, 75))
    expect(
      observerEvents.some(
        (event) => event.type === 'unread_count_update' && event.agentId === 'ghost-session',
      ),
    ).toBe(false)

    actor.close()
    await once(actor, 'close')
    observer.close()
    await once(observer, 'close')
    await server.stop()

    await expect(readFile(unreadStatePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans unread counts when sessions are cleared or deleted', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const { sessionAgent: sessionToClear } = await manager.createSession('manager', {
      label: 'Clear me',
    })
    const { sessionAgent: sessionToDelete } = await manager.createSession('manager', {
      label: 'Delete me',
    })

    const unreadStatePath = getProfileUnreadStatePath(config.paths.dataDir, 'manager')

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const actor = new WebSocket(`ws://${config.host}:${config.port}`)
    const actorEvents: ServerEvent[] = []
    actor.on('message', (raw) => {
      actorEvents.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(actor, 'open')
    actor.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(
      actorEvents,
      (event) => event.type === 'ready' && event.subscribedAgentId === 'manager',
    )

    const observer = new WebSocket(`ws://${config.host}:${config.port}`)
    const observerEvents: ServerEvent[] = []
    observer.on('message', (raw) => {
      observerEvents.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(observer, 'open')
    observer.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(
      observerEvents,
      (event) => event.type === 'ready' && event.subscribedAgentId === 'manager',
    )

    actor.send(JSON.stringify({ type: 'mark_unread', agentId: sessionToClear.agentId }))
    await waitForEvent(
      actorEvents,
      (event) => event.type === 'unread_count_update' && event.agentId === sessionToClear.agentId && event.count === 1,
    )

    actor.send(JSON.stringify({ type: 'mark_unread', agentId: sessionToDelete.agentId }))
    await waitForEvent(
      actorEvents,
      (event) => event.type === 'unread_count_update' && event.agentId === sessionToDelete.agentId && event.count === 1,
    )

    actor.send(JSON.stringify({ type: 'clear_session', agentId: sessionToClear.agentId, requestId: 'req-clear' }))
    await waitForEvent(
      actorEvents,
      (event) => event.type === 'session_cleared' && event.agentId === sessionToClear.agentId,
    )
    await waitForEvent(
      observerEvents,
      (event) =>
        event.type === 'unread_count_update' &&
        event.agentId === sessionToClear.agentId &&
        event.count === 0,
    )

    actor.send(JSON.stringify({ type: 'delete_session', agentId: sessionToDelete.agentId, requestId: 'req-delete' }))
    await waitForEvent(
      actorEvents,
      (event) => event.type === 'session_deleted' && event.agentId === sessionToDelete.agentId,
    )
    await waitForEvent(
      observerEvents,
      (event) =>
        event.type === 'unread_count_update' &&
        event.agentId === sessionToDelete.agentId &&
        event.count === 0,
    )

    actor.close()
    await once(actor, 'close')
    observer.close()
    await once(observer, 'close')
    await server.stop()

    const persisted = JSON.parse(await readFile(unreadStatePath, 'utf8')) as { counts: Record<string, number> }
    expect(persisted).toEqual({ counts: {} })
  })

  it('cleans unread counts for deleted manager profiles', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const secondaryManager = await manager.createManager('manager', {
      name: 'Secondary Profile',
      cwd: config.defaultCwd,
    })

    const secondaryUnreadStatePath = getProfileUnreadStatePath(config.paths.dataDir, secondaryManager.agentId)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(
      events,
      (event) => event.type === 'ready' && event.subscribedAgentId === 'manager',
    )

    client.send(JSON.stringify({ type: 'mark_unread', agentId: secondaryManager.agentId }))
    await waitForEvent(
      events,
      (event) =>
        event.type === 'unread_count_update' &&
        event.agentId === secondaryManager.agentId &&
        event.count === 1,
    )

    client.send(
      JSON.stringify({
        type: 'delete_manager',
        managerId: secondaryManager.agentId,
        requestId: 'req-delete-manager',
      }),
    )

    await waitForEvent(
      events,
      (event) => event.type === 'manager_deleted' && event.managerId === secondaryManager.agentId,
    )

    client.close()
    await once(client, 'close')
    await server.stop()

    await expect(readFile(secondaryUnreadStatePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes and removes its control pid file across start/stop', async () => {
    const previousDaemonized = process.env[DAEMONIZED_ENV_VAR]
    delete process.env[DAEMONIZED_ENV_VAR]

    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    const pidFile = getControlPidFilePath(config.paths.rootDir, config.port)
    await rm(pidFile, { force: true })

    try {
      await server.start()

      const pidContents = await readFile(pidFile, 'utf8')
      expect(pidContents.trim()).toBe(String(process.pid))

      await server.stop()
      await expect(readFile(pidFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await server.stop()
      if (previousDaemonized === undefined) {
        delete process.env[DAEMONIZED_ENV_VAR]
      } else {
        process.env[DAEMONIZED_ENV_VAR] = previousDaemonized
      }
    }
  })

  it('emits a Cortex prompt surface change event when POST /api/write-file updates a tracked Cortex file', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
      promptRegistry: manager.promptRegistry,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    const commonKnowledgePath = getCommonKnowledgePath(config.paths.dataDir)
    const content = '# Common Knowledge\n\nUpdated through /api/write-file\n'

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/write-file`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          path: commonKnowledgePath,
          content,
        }),
      })

      expect(response.status).toBe(200)
      expect(await readFile(commonKnowledgePath, 'utf8')).toBe(content)

      await expect(
        waitForEvent(
          events,
          (event) =>
            event.type === 'cortex_prompt_surface_changed' &&
            event.surfaceId === 'common-knowledge-live' &&
            event.filePath === commonKnowledgePath,
        ),
      ).resolves.toBeTruthy()
    } finally {
      client.close()
      await server.stop()
    }
  })


  it('returns onboarding state through GET /api/onboarding/state', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    await saveOnboardingPreferences(config.paths.dataDir, {
      preferredName: 'Ada',
      technicalLevel: 'developer',
      additionalPreferences: 'Keep responses concise.',
    })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const response = await fetch(`http://${config.host}:${config.port}/api/onboarding/state`)
      expect(response.status).toBe(200)

      const payload = (await response.json()) as {
        state: {
          status: string
          completedAt: string | null
          skippedAt: string | null
          preferences: {
            preferredName: string | null
            technicalLevel: string | null
            additionalPreferences: string | null
          } | null
        }
      }

      expect(payload.state.status).toBe('completed')
      expect(payload.state.completedAt).toMatch(/T/)
      expect(payload.state.skippedAt).toBeNull()
      expect(payload.state.preferences).toEqual({
        preferredName: 'Ada',
        technicalLevel: 'developer',
        additionalPreferences: 'Keep responses concise.',
      })
    } finally {
      await server.stop()
    }
  })

  it('saves onboarding preferences and skip state through POST /api/onboarding/preferences', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const saveResponse = await fetch(`http://${config.host}:${config.port}/api/onboarding/preferences`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          preferredName: 'Ada',
          technicalLevel: 'semi_technical',
          additionalPreferences: 'Prefer plain language.',
        }),
      })
      expect(saveResponse.status).toBe(200)

      const savedPayload = (await saveResponse.json()) as {
        state: {
          status: string
          completedAt: string | null
          preferences: {
            preferredName: string | null
            technicalLevel: string | null
            additionalPreferences: string | null
          } | null
        }
      }
      expect(savedPayload.state.status).toBe('completed')
      expect(savedPayload.state.completedAt).toMatch(/T/)
      expect(savedPayload.state.preferences).toEqual({
        preferredName: 'Ada',
        technicalLevel: 'semi_technical',
        additionalPreferences: 'Prefer plain language.',
      })

      const skipResponse = await fetch(`http://${config.host}:${config.port}/api/onboarding/preferences`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'skipped' }),
      })
      expect(skipResponse.status).toBe(200)

      const skippedPayload = (await skipResponse.json()) as {
        state: {
          status: string
          completedAt: string | null
          skippedAt: string | null
          preferences: {
            preferredName: string | null
            technicalLevel: string | null
            additionalPreferences: string | null
          } | null
        }
      }
      expect(skippedPayload.state.status).toBe('skipped')
      expect(skippedPayload.state.completedAt).toBe(savedPayload.state.completedAt)
      expect(skippedPayload.state.skippedAt).toMatch(/T/)
      expect(skippedPayload.state.preferences).toEqual(savedPayload.state.preferences)

      const snapshot = await loadOnboardingState(config.paths.dataDir)
      expect(snapshot.status).toBe('skipped')
      expect(snapshot.preferences).toEqual(savedPayload.state.preferences)
    } finally {
      await server.stop()
    }
  })

  it('rejects onboarding preferences that exceed field length limits', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await manager.boot()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const longNameResponse = await fetch(`http://${config.host}:${config.port}/api/onboarding/preferences`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          preferredName: 'a'.repeat(201),
          technicalLevel: 'developer',
        }),
      })
      expect(longNameResponse.status).toBe(400)
      expect(await longNameResponse.json()).toEqual({
        error: 'preferredName must be 200 characters or fewer.',
      })

      const longPreferencesResponse = await fetch(`http://${config.host}:${config.port}/api/onboarding/preferences`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          preferredName: 'Ada',
          technicalLevel: 'developer',
          additionalPreferences: 'b'.repeat(2001),
        }),
      })
      expect(longPreferencesResponse.status).toBe(400)
      expect(await longPreferencesResponse.json()).toEqual({
        error: 'additionalPreferences must be 2000 characters or fewer.',
      })
    } finally {
      await server.stop()
    }
  })



  it('manages skill env settings through REST endpoints', async () => {
    const previousBraveApiKey = process.env.BRAVE_API_KEY
    delete process.env.BRAVE_API_KEY

    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const initialResponse = await fetch(`http://${config.host}:${config.port}/api/settings/env`)
      expect(initialResponse.status).toBe(200)
      const initialPayload = (await initialResponse.json()) as {
        variables: Array<{ name: string; skillName: string; isSet: boolean }>
      }

      expect(
        initialPayload.variables.find(
          (entry) => entry.name === 'BRAVE_API_KEY' && entry.skillName === 'brave-search',
        ),
      ).toMatchObject({
        isSet: false,
      })

      const updateResponse = await fetch(`http://${config.host}:${config.port}/api/settings/env`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          values: {
            BRAVE_API_KEY: 'bsal-rest-value',
          },
        }),
      })

      expect(updateResponse.status).toBe(200)
      const updatedPayload = (await updateResponse.json()) as {
        variables: Array<{ name: string; skillName: string; isSet: boolean; maskedValue?: string }>
      }

      expect(
        updatedPayload.variables.find(
          (entry) => entry.name === 'BRAVE_API_KEY' && entry.skillName === 'brave-search',
        ),
      ).toMatchObject({
        isSet: true,
        maskedValue: '********',
      })

      expect(process.env.BRAVE_API_KEY).toBe('bsal-rest-value')

      const storedSecrets = JSON.parse(await readFile(config.paths.sharedSecretsFile, 'utf8')) as Record<string, string>
      expect(storedSecrets.BRAVE_API_KEY).toBe('bsal-rest-value')

      const deleteResponse = await fetch(`http://${config.host}:${config.port}/api/settings/env/BRAVE_API_KEY`, {
        method: 'DELETE',
      })

      expect(deleteResponse.status).toBe(200)
      expect(process.env.BRAVE_API_KEY).toBeUndefined()

      const afterDeleteResponse = await fetch(`http://${config.host}:${config.port}/api/settings/env`)
      const afterDeletePayload = (await afterDeleteResponse.json()) as {
        variables: Array<{ name: string; skillName: string; isSet: boolean }>
      }

      expect(
        afterDeletePayload.variables.find(
          (entry) => entry.name === 'BRAVE_API_KEY' && entry.skillName === 'brave-search',
        ),
      ).toMatchObject({
        isSet: false,
      })
    } finally {
      if (previousBraveApiKey === undefined) {
        delete process.env.BRAVE_API_KEY
      } else {
        process.env.BRAVE_API_KEY = previousBraveApiKey
      }

      await server.stop()
    }
  })

  it('manages auth settings through REST endpoints', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const initialResponse = await fetch(`http://${config.host}:${config.port}/api/settings/auth`)
      expect(initialResponse.status).toBe(200)
      const initialPayload = (await initialResponse.json()) as {
        providers: Array<{ provider: string; configured: boolean }>
      }

      expect(initialPayload.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider: 'anthropic', configured: false }),
          expect.objectContaining({ provider: 'openai-codex', configured: false }),
        ]),
      )

      const legacyAuthStorage = AuthStorage.create(config.paths.authFile)
      legacyAuthStorage.set('anthropic', {
        type: 'api_key',
        key: 'sk-legacy-anthropic',
        access: 'sk-legacy-anthropic',
        refresh: '',
        expires: '',
      } as any)

      const updateResponse = await fetch(`http://${config.host}:${config.port}/api/settings/auth`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          anthropic: 'sk-ant-test-1234',
          'openai-codex': 'sk-openai-test-5678',
        }),
      })

      expect(updateResponse.status).toBe(200)
      const updatedPayload = (await updateResponse.json()) as {
        providers: Array<{ provider: string; configured: boolean; maskedValue?: string }>
      }

      const anthropic = updatedPayload.providers.find((entry) => entry.provider === 'anthropic')
      const openai = updatedPayload.providers.find((entry) => entry.provider === 'openai-codex')

      expect(anthropic?.configured).toBe(true)
      expect(anthropic?.maskedValue).toBe('********1234')
      expect(openai?.configured).toBe(true)
      expect(openai?.maskedValue).toBe('********5678')

      const storedAuth = JSON.parse(await readFile(config.paths.sharedAuthFile, 'utf8')) as Record<
        string,
        { type: string; key?: string; access?: string }
      >
      const legacyStoredAuth = JSON.parse(await readFile(config.paths.authFile, 'utf8')) as Record<
        string,
        { type: string; key?: string; access?: string }
      >

      expect(storedAuth.anthropic).toMatchObject({
        type: 'api_key',
      })
      expect(storedAuth.anthropic.key ?? storedAuth.anthropic.access).toBe('sk-ant-test-1234')
      expect(storedAuth['openai-codex']).toMatchObject({
        type: 'api_key',
      })
      expect(storedAuth['openai-codex'].key ?? storedAuth['openai-codex'].access).toBe('sk-openai-test-5678')
      expect(legacyStoredAuth.anthropic.key ?? legacyStoredAuth.anthropic.access).toBe('sk-ant-test-1234')
      expect(legacyStoredAuth['openai-codex'].key ?? legacyStoredAuth['openai-codex'].access).toBe('sk-openai-test-5678')

      const deleteResponse = await fetch(`http://${config.host}:${config.port}/api/settings/auth/openai-codex`, {
        method: 'DELETE',
      })
      expect(deleteResponse.status).toBe(400)

      const deletePayload = (await deleteResponse.json()) as {
        error?: string
      }
      expect(deletePayload.error).toBe('Use pool management to remove OpenAI Codex accounts.')

      const afterDeleteAuth = JSON.parse(await readFile(config.paths.sharedAuthFile, 'utf8')) as Record<string, unknown>
      const afterDeleteLegacyAuth = JSON.parse(await readFile(config.paths.authFile, 'utf8')) as Record<string, unknown>
      expect(afterDeleteAuth['openai-codex']).toBeDefined()
      expect(afterDeleteLegacyAuth['openai-codex']).toBeDefined()
    } finally {
      await server.stop()
    }
  })

  it('filters model presets by configured provider credentials', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    const previousOpenaiApiKey = process.env.OPENAI_API_KEY
    const previousXaiApiKey = process.env.XAI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.XAI_API_KEY

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    try {
      const initialResponse = await fetch(`http://${config.host}:${config.port}/api/settings/models`)
      expect(initialResponse.status).toBe(200)
      const initialPayload = (await initialResponse.json()) as {
        models: Array<{ presetId: string }>
      }

      expect(initialPayload.models.map((model) => model.presetId)).toEqual(['sdk-opus', 'sdk-sonnet'])

      const authUpdateResponse = await fetch(`http://${config.host}:${config.port}/api/settings/auth`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          'openai-codex': 'sk-openai-test-5678',
        }),
      })
      expect(authUpdateResponse.status).toBe(200)

      const envUpdateResponse = await fetch(`http://${config.host}:${config.port}/api/settings/env`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          values: {
            XAI_API_KEY: 'xai-test-1234',
          },
        }),
      })
      expect(envUpdateResponse.status).toBe(200)

      const updatedResponse = await fetch(`http://${config.host}:${config.port}/api/settings/models`)
      expect(updatedResponse.status).toBe(200)
      const updatedPayload = (await updatedResponse.json()) as {
        models: Array<{ presetId: string }>
      }
      const updatedPresetIds = updatedPayload.models.map((model) => model.presetId)

      expect(updatedPresetIds).toContain('pi-codex')
      expect(updatedPresetIds).toContain('pi-5.4')
      expect(updatedPresetIds).toContain('pi-grok')
      expect(updatedPresetIds).not.toContain('codex-app')
      expect(updatedPresetIds).not.toContain('pi-opus')
    } finally {
      if (previousAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey
      }

      if (previousOpenaiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = previousOpenaiApiKey
      }

      if (previousXaiApiKey === undefined) {
        delete process.env.XAI_API_KEY
      } else {
        process.env.XAI_API_KEY = previousXaiApiKey
      }

      await server.stop()
    }
  })

  it('accepts attachment-only user messages and broadcasts attachments', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')

    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'user_message',
        text: '',
        attachments: [
          {
            mimeType: 'image/png',
            data: 'aGVsbG8=',
            fileName: 'diagram.png',
          },
        ],
      }),
    )

    const userEvent = await waitForEvent(
      events,
      (event) => event.type === 'conversation_message' && event.source === 'user_input',
    )

    expect(userEvent.type).toBe('conversation_message')
    if (userEvent.type === 'conversation_message') {
      expect(userEvent.text).toBe('')
      expect(userEvent.attachments).toHaveLength(1)
      const persistedAttachment = userEvent.attachments?.[0]
      expect(persistedAttachment).toMatchObject({
        type: 'image',
        mimeType: 'image/png',
        fileName: 'diagram.png',
        sizeBytes: 5,
      })
      expect('data' in (persistedAttachment ?? {})).toBe(false)
      expect('filePath' in (persistedAttachment ?? {})).toBe(false)
      const persistedFileRef =
        persistedAttachment && 'fileRef' in persistedAttachment && typeof persistedAttachment.fileRef === 'string'
          ? persistedAttachment.fileRef
          : undefined
      expect(typeof persistedFileRef).toBe('string')

      if (persistedFileRef) {
        const attachmentResponse = await fetch(
          `http://${config.host}:${config.port}/api/attachments/${encodeURIComponent(persistedFileRef)}`,
        )
        expect(attachmentResponse.status).toBe(200)
        expect(await attachmentResponse.text()).toBe('hello')
      }
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('accepts text and binary attachments in websocket user messages', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')

    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'user_message',
        text: '',
        attachments: [
          {
            type: 'text',
            mimeType: 'text/markdown',
            text: '# Notes',
            fileName: 'notes.md',
          },
          {
            type: 'binary',
            mimeType: 'application/pdf',
            data: 'aGVsbG8=',
            fileName: 'design.pdf',
          },
        ],
      }),
    )

    const userEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'user_input' &&
        Array.isArray(event.attachments) &&
        event.attachments.length === 2,
    )

    expect(userEvent.type).toBe('conversation_message')
    if (userEvent.type === 'conversation_message') {
      expect(userEvent.attachments).toHaveLength(2)

      const textAttachment = userEvent.attachments?.[0]
      expect(textAttachment).toMatchObject({
        type: 'text',
        mimeType: 'text/markdown',
        fileName: 'notes.md',
        sizeBytes: 7,
      })
      expect('text' in (textAttachment ?? {})).toBe(false)
      expect('filePath' in (textAttachment ?? {})).toBe(false)
      const textFileRef =
        textAttachment && 'fileRef' in textAttachment && typeof textAttachment.fileRef === 'string'
          ? textAttachment.fileRef
          : undefined
      expect(typeof textFileRef).toBe('string')

      const binaryAttachment = userEvent.attachments?.[1]
      expect(binaryAttachment).toMatchObject({
        type: 'binary',
        mimeType: 'application/pdf',
        fileName: 'design.pdf',
        sizeBytes: 5,
      })
      expect('data' in (binaryAttachment ?? {})).toBe(false)
      expect('filePath' in (binaryAttachment ?? {})).toBe(false)
      const binaryFileRef =
        binaryAttachment && 'fileRef' in binaryAttachment && typeof binaryAttachment.fileRef === 'string'
          ? binaryAttachment.fileRef
          : undefined
      expect(typeof binaryFileRef).toBe('string')

      if (textFileRef) {
        const textResponse = await fetch(
          `http://${config.host}:${config.port}/api/attachments/${encodeURIComponent(textFileRef)}`,
        )
        expect(textResponse.status).toBe(200)
        expect(await textResponse.text()).toBe('# Notes')
      }

      if (binaryFileRef) {
        const binaryResponse = await fetch(
          `http://${config.host}:${config.port}/api/attachments/${encodeURIComponent(binaryFileRef)}`,
        )
        expect(binaryResponse.status).toBe(200)
        expect(await binaryResponse.text()).toBe('hello')
      }
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('replays manager conversation history on reconnect', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const clientA = new WebSocket(`ws://${config.host}:${config.port}`)
    const eventsA: ServerEvent[] = []
    clientA.on('message', (raw) => {
      eventsA.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientA, 'open')
    clientA.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(eventsA, (event) => event.type === 'conversation_history')

    clientA.send(JSON.stringify({ type: 'user_message', text: 'remember this' }))
    await waitForEvent(
      eventsA,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'user_input' &&
        event.text === 'remember this',
    )

    clientA.close()
    await once(clientA, 'close')

    const clientB = new WebSocket(`ws://${config.host}:${config.port}`)
    const eventsB: ServerEvent[] = []
    clientB.on('message', (raw) => {
      eventsB.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientB, 'open')
    clientB.send(JSON.stringify({ type: 'subscribe' }))

    const historyEvent = await waitForEvent(eventsB, (event) => event.type === 'conversation_history')
    expect(historyEvent.type).toBe('conversation_history')
    if (historyEvent.type === 'conversation_history') {
      expect(historyEvent.messages.some((message) => 'text' in message && message.text === 'remember this')).toBe(true)
    }

    clientB.close()
    await once(clientB, 'close')
    await server.stop()
  })

  it('handles /new via websocket by creating a new session while preserving existing history', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const clientA = new WebSocket(`ws://${config.host}:${config.port}`)
    const eventsA: ServerEvent[] = []
    clientA.on('message', (raw) => {
      eventsA.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientA, 'open')
    clientA.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(eventsA, (event) => event.type === 'conversation_history')

    clientA.send(JSON.stringify({ type: 'user_message', text: 'keep this' }))
    await waitForEvent(
      eventsA,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'user_input' &&
        event.text === 'keep this',
    )

    clientA.send(JSON.stringify({ type: 'user_message', text: '/new' }))
    const resetEvent = await waitForEvent(
      eventsA,
      (event) => event.type === 'conversation_reset' && event.agentId === 'manager',
    )
    expect(resetEvent.type).toBe('conversation_reset')
    if (resetEvent.type === 'conversation_reset') {
      expect(resetEvent.reason).toBe('user_new_command')
      expect(resetEvent.agentId).toBe('manager')
    }

    const sessionSnapshot = await waitForEvent(
      eventsA,
      (event) =>
        event.type === 'agents_snapshot' &&
        event.agents.some((agent) => agent.role === 'manager' && agent.agentId === 'manager--s2'),
    )
    expect(sessionSnapshot.type).toBe('agents_snapshot')

    expect(
      eventsA.some(
        (event) => event.type === 'conversation_message' && event.source === 'user_input' && event.text === '/new',
      ),
    ).toBe(false)

    clientA.close()
    await once(clientA, 'close')

    const clientB = new WebSocket(`ws://${config.host}:${config.port}`)
    const eventsB: ServerEvent[] = []
    clientB.on('message', (raw) => {
      eventsB.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(clientB, 'open')
    clientB.send(JSON.stringify({ type: 'subscribe' }))
    const historyEvent = await waitForEvent(eventsB, (event) => event.type === 'conversation_history')

    expect(historyEvent.type).toBe('conversation_history')
    if (historyEvent.type === 'conversation_history') {
      expect(historyEvent.messages.some((message) => 'text' in message && message.text === 'keep this')).toBe(true)
    }

    clientB.send(JSON.stringify({ type: 'subscribe', agentId: 'manager--s2' }))
    const forkedHistoryEvent = await waitForEvent(
      eventsB,
      (event) => event.type === 'conversation_history' && event.agentId === 'manager--s2',
    )
    expect(forkedHistoryEvent.type).toBe('conversation_history')
    if (forkedHistoryEvent.type === 'conversation_history') {
      expect(forkedHistoryEvent.messages).toHaveLength(0)
    }

    clientB.close()
    await once(clientB, 'close')
    await server.stop()
  })

  it('handles /compact via websocket by compacting manager context', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'conversation_history')

    client.send(
      JSON.stringify({
        type: 'user_message',
        text: '/compact Keep unresolved work items in the summary.',
      }),
    )

    await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' &&
        event.source === 'system' &&
        event.text === 'Compacting manager context...',
    )
    await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' && event.source === 'system' && event.text === 'Compaction complete.',
    )

    expect(
      events.some(
        (event) =>
          event.type === 'conversation_message' &&
          event.source === 'user_input' &&
          event.text.trim().toLowerCase().startsWith('/compact'),
      ),
    ).toBe(false)

    const runtime = manager.runtimeByAgentId.get('manager')
    expect(runtime?.compactCalls).toEqual(['Keep unresolved work items in the summary.'])

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('supports worker subscriptions and direct user messaging to the selected worker', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Worker Thread' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: worker.agentId }))

    await waitForEvent(
      events,
      (event) => event.type === 'ready' && event.subscribedAgentId === worker.agentId,
    )
    await waitForEvent(
      events,
      (event) => event.type === 'conversation_history' && event.agentId === worker.agentId,
    )

    client.send(JSON.stringify({ type: 'user_message', text: 'hello worker' }))

    const workerEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_message' &&
        event.agentId === worker.agentId &&
        event.source === 'user_input' &&
        event.text === 'hello worker',
    )

    expect(workerEvent.type).toBe('conversation_message')

    ;(manager as any).conversationProjector.emitConversationLog({
      type: 'conversation_log',
      agentId: worker.agentId,
      timestamp: new Date().toISOString(),
      source: 'runtime_log',
      kind: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'call-1',
      text: '{"command":"ls"}',
    })

    const logEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'conversation_log' &&
        event.agentId === worker.agentId &&
        event.kind === 'tool_execution_start' &&
        event.toolName === 'bash',
    )

    expect(logEvent.type).toBe('conversation_log')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('returns session workers on demand over websocket', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Worker Snapshot' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready' && event.subscribedAgentId === 'manager')

    client.send(JSON.stringify({ type: 'get_session_workers', sessionAgentId: 'manager', requestId: 'req-workers' }))

    const workerSnapshotEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'session_workers_snapshot' &&
        event.sessionAgentId === 'manager' &&
        event.requestId === 'req-workers',
    )

    expect(workerSnapshotEvent.type).toBe('session_workers_snapshot')
    if (workerSnapshotEvent.type === 'session_workers_snapshot') {
      expect(workerSnapshotEvent.workers).toHaveLength(1)
      expect(workerSnapshotEvent.workers[0]).toMatchObject({
        agentId: worker.agentId,
        managerId: 'manager',
      })
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('returns an UNKNOWN_SESSION error for unknown get_session_workers requests', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready' && event.subscribedAgentId === 'manager')

    client.send(JSON.stringify({ type: 'get_session_workers', sessionAgentId: 'missing', requestId: 'req-missing' }))

    const errorEvent = await waitForEvent(
      events,
      (event) => event.type === 'error' && event.code === 'UNKNOWN_SESSION' && event.requestId === 'req-missing',
    )
    expect(errorEvent.type).toBe('error')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('returns project-agent config over websocket for promoted sessions', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const { sessionAgent } = await manager.createSession('manager', { label: 'Release Notes' })
    await manager.setSessionProjectAgent(sessionAgent.agentId, {
      whenToUse: 'Draft release notes and changelog copy.',
      systemPrompt: 'You are the release notes project agent.',
    })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready' && event.subscribedAgentId === 'manager')

    client.send(
      JSON.stringify({ type: 'get_project_agent_config', agentId: sessionAgent.agentId, requestId: 'project-config-1' }),
    )

    const configEvent = await waitForEvent(
      events,
      (event) => event.type === 'project_agent_config' && event.requestId === 'project-config-1',
    )

    expect(configEvent.type).toBe('project_agent_config')
    if (configEvent.type === 'project_agent_config') {
      expect(configEvent.agentId).toBe(sessionAgent.agentId)
      expect(configEvent.systemPrompt).toBe('You are the release notes project agent.')
      expect(configEvent.config).toMatchObject({
        version: 1,
        agentId: sessionAgent.agentId,
        handle: 'release-notes',
        whenToUse: 'Draft release notes and changelog copy.',
      })
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('returns NOT_A_PROJECT_AGENT errors for get_project_agent_config on non-project agents', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const { sessionAgent } = await manager.createSession('manager', { label: 'Regular Session' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready' && event.subscribedAgentId === 'manager')

    client.send(
      JSON.stringify({ type: 'get_project_agent_config', agentId: sessionAgent.agentId, requestId: 'project-config-miss' }),
    )

    const errorEvent = await waitForEvent(
      events,
      (event) => event.type === 'error' && event.code === 'NOT_A_PROJECT_AGENT' && event.requestId === 'project-config-miss',
    )
    expect(errorEvent.type).toBe('error')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('returns null systemPrompt from get_project_agent_config when prompt.md is absent', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const { sessionAgent } = await manager.createSession('manager', { label: 'QA' })
    await manager.setSessionProjectAgent(sessionAgent.agentId, {
      whenToUse: 'Verify fixes and regressions.',
    })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready' && event.subscribedAgentId === 'manager')

    client.send(
      JSON.stringify({ type: 'get_project_agent_config', agentId: sessionAgent.agentId, requestId: 'project-config-null' }),
    )

    const configEvent = await waitForEvent(
      events,
      (event) => event.type === 'project_agent_config' && event.requestId === 'project-config-null',
    )

    expect(configEvent.type).toBe('project_agent_config')
    if (configEvent.type === 'project_agent_config') {
      expect(configEvent.agentId).toBe(sessionAgent.agentId)
      expect(configEvent.systemPrompt).toBeNull()
      expect(configEvent.config).toMatchObject({
        version: 1,
        agentId: sessionAgent.agentId,
        handle: 'qa',
        whenToUse: 'Verify fixes and regressions.',
      })
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('kills a worker via kill_agent command and emits updated status + snapshot events', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Disposable Worker' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))

    await waitForEvent(events, (event) => event.type === 'ready')
    const bootstrapSnapshot = await waitForEvent(events, (event) => event.type === 'agents_snapshot')
    expect(bootstrapSnapshot.type).toBe('agents_snapshot')
    if (bootstrapSnapshot.type === 'agents_snapshot') {
      expect(bootstrapSnapshot.agents.some((agent) => agent.agentId === worker.agentId)).toBe(false)
      expect(bootstrapSnapshot.agents.find((agent) => agent.agentId === 'manager')).toMatchObject({
        workerCount: 1,
        activeWorkerCount: 0,
      })
    }

    client.send(JSON.stringify({ type: 'kill_agent', agentId: worker.agentId }))

    const statusEvent = await waitForEvent(
      events,
      (event) => event.type === 'agent_status' && event.agentId === worker.agentId && event.status === 'terminated',
    )
    expect(statusEvent.type).toBe('agent_status')
    if (statusEvent.type === 'agent_status') {
      expect(statusEvent.managerId).toBe('manager')
    }

    const snapshotEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'agents_snapshot' &&
        event.agents.some(
          (agent) =>
            agent.agentId === 'manager' &&
            agent.role === 'manager' &&
            agent.workerCount === 1 &&
            agent.activeWorkerCount === 0,
        ),
    )
    expect(snapshotEvent.type).toBe('agents_snapshot')

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(
      events.some(
        (event) =>
          event.type === 'session_workers_snapshot' &&
          event.sessionAgentId === 'manager' &&
          !('requestId' in event),
      ),
    ).toBe(false)

    const descriptor = manager.listAgents().find((agent) => agent.agentId === worker.agentId)
    expect(descriptor?.status).toBe('terminated')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('stops all agents over websocket by cancelling work and keeping agents alive', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Stop-All Worker' })
    const managerRuntime = manager.runtimeByAgentId.get('manager')
    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(managerRuntime).toBeDefined()
    expect(workerRuntime).toBeDefined()

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready' && event.subscribedAgentId === 'manager')

    client.send(JSON.stringify({ type: 'stop_all_agents', managerId: 'manager' }))

    const resultEvent = await waitForEvent(
      events,
      (event) => event.type === 'stop_all_agents_result' && event.managerId === 'manager',
    )
    expect(resultEvent.type).toBe('stop_all_agents_result')
    if (resultEvent.type === 'stop_all_agents_result') {
      expect(resultEvent.stoppedWorkerIds).toEqual([worker.agentId])
      expect(resultEvent.managerStopped).toBe(true)
      expect(resultEvent.terminatedWorkerIds).toEqual([worker.agentId])
      expect(resultEvent.managerTerminated).toBe(true)
    }

    const snapshotEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'agents_snapshot' &&
        event.agents.some(
          (agent) =>
            agent.agentId === 'manager' &&
            agent.status === 'idle' &&
            agent.workerCount === 1 &&
            agent.activeWorkerCount === 0,
        ),
    )
    expect(snapshotEvent.type).toBe('agents_snapshot')

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(
      events.some(
        (event) =>
          event.type === 'session_workers_snapshot' &&
          event.sessionAgentId === 'manager' &&
          !('requestId' in event),
      ),
    ).toBe(false)

    expect(managerRuntime?.stopInFlightCalls).toEqual([
      expect.objectContaining({ abort: true }),
    ])
    expect(workerRuntime?.stopInFlightCalls).toEqual([
      expect.objectContaining({ abort: true }),
    ])
    expect(managerRuntime?.terminateCalls).toBe(0)
    expect(workerRuntime?.terminateCalls).toBe(0)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('returns stop_all_agents_result even when a worker runtime blocks shutdown', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const worker = await manager.spawnAgent('manager', { agentId: 'Hung Stop Worker' })
    const workerRuntime = manager.runtimeByAgentId.get(worker.agentId)
    expect(workerRuntime).toBeDefined()
    if (!workerRuntime) {
      throw new Error('Expected worker runtime to exist')
    }

    workerRuntime.stopInFlightImpl = async () => {
      await new Promise(() => {})
    }

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready' && event.subscribedAgentId === 'manager')

    client.send(JSON.stringify({ type: 'stop_all_agents', managerId: 'manager', requestId: 'stop-timeout' }))

    const resultEvent = await waitForEvent(
      events,
      (event) => event.type === 'stop_all_agents_result' && event.requestId === 'stop-timeout',
      8_000,
    )
    expect(resultEvent.type).toBe('stop_all_agents_result')
    if (resultEvent.type === 'stop_all_agents_result') {
      expect(resultEvent.stoppedWorkerIds).toContain(worker.agentId)
      expect(resultEvent.managerStopped).toBe(true)
    }

    const statusEvent = await waitForEvent(
      events,
      (event) => event.type === 'agent_status' && event.agentId === worker.agentId && event.status === 'idle',
      8_000,
    )
    expect(statusEvent.type).toBe('agent_status')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('creates managers over websocket with model presets and broadcasts manager_created', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'create_manager',
        name: 'Review Manager',
        cwd: config.defaultCwd,
        model: 'pi-opus',
      }),
    )

    const createdEvent = await waitForEvent(events, (event) => event.type === 'manager_created')
    expect(createdEvent.type).toBe('manager_created')
    if (createdEvent.type === 'manager_created') {
      expect(createdEvent.manager.role).toBe('manager')
      expect(createdEvent.manager.managerId).toBe(createdEvent.manager.agentId)
      expect(createdEvent.manager.model).toEqual({
        provider: 'anthropic',
        modelId: 'claude-opus-4-6',
        thinkingLevel: 'high',
      })
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('creates pi-5.4 managers over websocket', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'create_manager',
        name: 'GPT 5.4 Manager',
        cwd: config.defaultCwd,
        model: 'pi-5.4',
      }),
    )

    const createdEvent = await waitForEvent(events, (event) => event.type === 'manager_created')
    expect(createdEvent.type).toBe('manager_created')
    if (createdEvent.type === 'manager_created') {
      expect(createdEvent.manager.model).toEqual({
        provider: 'openai-codex',
        modelId: 'gpt-5.4',
        thinkingLevel: 'xhigh',
      })
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('creates codex-app managers over websocket', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'create_manager',
        name: 'Codex App Manager',
        cwd: config.defaultCwd,
        model: 'codex-app',
      }),
    )

    const createdEvent = await waitForEvent(events, (event) => event.type === 'manager_created')
    expect(createdEvent.type).toBe('manager_created')
    if (createdEvent.type === 'manager_created') {
      expect(createdEvent.manager.model).toEqual({
        provider: 'openai-codex-app-server',
        modelId: 'default',
        thinkingLevel: 'xhigh',
      })
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('rejects invalid create_manager model presets at websocket protocol validation time', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'create_manager',
        name: 'Invalid Manager',
        cwd: config.defaultCwd,
        model: 'gpt-4o',
      }),
    )

    const errorEvent = await waitForEvent(
      events,
      (event) =>
        event.type === 'error' &&
        event.code === 'INVALID_COMMAND' &&
        event.message.includes('create_manager.model must be one of pi-codex|pi-5.4|pi-5.5|pi-opus|sdk-opus|sdk-sonnet|pi-grok|codex-app|cursor-acp'),
    )

    expect(errorEvent.type).toBe('error')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('deletes managers over websocket and emits manager_deleted', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Delete Me Manager',
      cwd: config.defaultCwd,
    })
    const ownedWorker = await manager.spawnAgent(secondary.agentId, { agentId: 'Delete Me Worker' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(JSON.stringify({ type: 'delete_manager', managerId: secondary.agentId }))

    const deletedEvent = await waitForEvent(
      events,
      (event) => event.type === 'manager_deleted' && event.managerId === secondary.agentId,
    )
    expect(deletedEvent.type).toBe('manager_deleted')
    if (deletedEvent.type === 'manager_deleted') {
      expect(deletedEvent.terminatedWorkerIds).toContain(ownedWorker.agentId)
    }

    expect(manager.listAgents().some((agent) => agent.agentId === secondary.agentId)).toBe(false)
    expect(manager.listAgents().some((agent) => agent.agentId === ownedWorker.agentId)).toBe(false)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('supports deleting the selected last manager and creating a replacement manager', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready' && event.subscribedAgentId === 'manager')

    client.send(JSON.stringify({ type: 'delete_manager', managerId: 'manager' }))

    const deletedEvent = await waitForEvent(
      events,
      (event) => event.type === 'manager_deleted' && event.managerId === 'manager',
    )
    expect(deletedEvent.type).toBe('manager_deleted')

    const postDeleteSnapshot = await waitForEvent(
      events,
      (event) => event.type === 'agents_snapshot' && event.agents.length === 0,
    )
    expect(postDeleteSnapshot.type).toBe('agents_snapshot')

    client.send(
      JSON.stringify({
        type: 'create_manager',
        name: 'Recovered Manager',
        cwd: config.defaultCwd,
      }),
    )

    const recreatedEvent = await waitForEvent(
      events,
      (event) => event.type === 'manager_created' && event.manager.agentId === 'recovered-manager',
    )
    expect(recreatedEvent.type).toBe('manager_created')

    expect(manager.listAgents().some((agent) => agent.agentId === 'recovered-manager')).toBe(true)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('routes kill_agent by the target worker owner instead of the current subscription context', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Owner Manager',
      cwd: config.defaultCwd,
    })
    const ownedWorker = await manager.spawnAgent(secondary.agentId, { agentId: 'Owned Worker' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(JSON.stringify({ type: 'kill_agent', agentId: ownedWorker.agentId }))

    const statusEvent = await waitForEvent(
      events,
      (event) => event.type === 'agent_status' && event.agentId === ownedWorker.agentId && event.status === 'terminated',
    )
    expect(statusEvent.type).toBe('agent_status')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('rejects kill_agent when targeting a manager descriptor', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(JSON.stringify({ type: 'kill_agent', agentId: 'manager' }))

    const errorEvent = await waitForEvent(
      events,
      (event) => event.type === 'error' && event.code === 'KILL_AGENT_FAILED',
    )
    expect(errorEvent.type).toBe('error')
    if (errorEvent.type === 'error') {
      expect(errorEvent.message).toContain('Manager cannot be killed')
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('/new resets the currently selected manager session only', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const secondary = await manager.createManager('manager', {
      name: 'Resettable Manager',
      cwd: config.defaultCwd,
    })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: secondary.agentId }))
    await waitForEvent(
      events,
      (event) => event.type === 'ready' && event.subscribedAgentId === secondary.agentId,
    )

    client.send(JSON.stringify({ type: 'user_message', text: '/new' }))

    const resetEvent = await waitForEvent(
      events,
      (event) => event.type === 'conversation_reset' && event.agentId === secondary.agentId,
    )
    expect(resetEvent.type).toBe('conversation_reset')

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('supports directory picker protocol commands', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const outsideDir = await mkdtemp(join(tmpdir(), 'ws-outside-allowlist-'))
    const rootValidation = await manager.validateDirectory(config.paths.rootDir)
    const expectedRoot = rootValidation.resolvedPath ?? config.paths.rootDir

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []
    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(JSON.stringify({ type: 'list_directories', path: config.paths.rootDir }))

    const listed = await waitForEvent(events, (event) => event.type === 'directories_listed')
    expect(listed.type).toBe('directories_listed')
    if (listed.type === 'directories_listed') {
      expect(listed.roots).toEqual([])
      expect(listed.resolvedPath).toBe(expectedRoot)
    }

    client.send(JSON.stringify({ type: 'validate_directory', path: outsideDir }))

    const validated = await waitForEvent(
      events,
      (event) => event.type === 'directory_validated' && event.requestedPath === outsideDir,
    )
    expect(validated.type).toBe('directory_validated')
    if (validated.type === 'directory_validated') {
      expect(validated.valid).toBe(true)
      expect(validated.message).toBeUndefined()
      expect(validated.roots).toEqual([])
    }

    manager.pickedDirectoryPath = outsideDir
    client.send(JSON.stringify({ type: 'pick_directory', defaultPath: expectedRoot, requestId: 'pick-1' }))

    const picked = await waitForEvent(
      events,
      (event) => event.type === 'directory_picked' && event.requestId === 'pick-1',
    )
    expect(picked.type).toBe('directory_picked')
    if (picked.type === 'directory_picked') {
      expect(picked.path).toBe(outsideDir)
    }
    expect(manager.lastPickedDirectoryDefaultPath).toBe(expectedRoot)

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('includes profiles_snapshot in websocket subscription bootstrap', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))

    const profilesEvent = await waitForEvent(events, (event) => event.type === 'profiles_snapshot')
    expect(profilesEvent.type).toBe('profiles_snapshot')
    if (profilesEvent.type === 'profiles_snapshot') {
      expect(profilesEvent.profiles.some((profile) => profile.profileId === 'manager')).toBe(true)
      expect(profilesEvent.profiles.some((profile) => profile.profileId === 'cortex')).toBe(false)
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('handles session lifecycle websocket commands', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const mergeCalls: string[] = []
    ;(manager as unknown as { mergeSessionMemory: (agentId: string) => Promise<{ agentId: string; status: 'applied'; strategy: 'llm'; mergedAt: string; auditPath: string }> }).mergeSessionMemory = async (
      agentId,
    ) => {
      mergeCalls.push(agentId)
      return {
        agentId,
        status: 'applied',
        strategy: 'llm',
        mergedAt: '2026-03-15T20:00:00.000Z',
        auditPath: '/tmp/merge-audit.log',
      }
    }

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))
    await waitForEvent(events, (event) => event.type === 'ready' && event.subscribedAgentId === 'manager')

    client.send(
      JSON.stringify({
        type: 'create_session',
        profileId: 'manager',
        label: 'Refactor track',
        requestId: 'create-1',
      }),
    )

    const created = await waitForEvent(
      events,
      (event) => event.type === 'session_created' && event.requestId === 'create-1',
    )
    expect(created.type).toBe('session_created')

    let sessionAgentId = 'manager--s2'
    if (created.type === 'session_created') {
      sessionAgentId = created.sessionAgent.agentId
      expect(created.profile.profileId).toBe('manager')
      expect(created.sessionAgent.sessionLabel).toBe('Refactor track')
    }

    await waitForEvent(
      events,
      (event) =>
        event.type === 'agents_snapshot' &&
        event.agents.some((agent) => agent.agentId === sessionAgentId && agent.role === 'manager'),
    )

    const sessionWorker = await manager.spawnAgent(sessionAgentId, { agentId: 'Session Worker' })

    client.send(
      JSON.stringify({
        type: 'stop_session',
        agentId: sessionAgentId,
        requestId: 'stop-1',
      }),
    )

    const stopped = await waitForEvent(
      events,
      (event) => event.type === 'session_stopped' && event.agentId === sessionAgentId && event.requestId === 'stop-1',
    )
    expect(stopped.type).toBe('session_stopped')
    if (stopped.type === 'session_stopped') {
      expect(stopped.terminatedWorkerIds).toContain(sessionWorker.agentId)
      expect(stopped.profileId).toBe('manager')
    }

    client.send(
      JSON.stringify({
        type: 'resume_session',
        agentId: sessionAgentId,
        requestId: 'resume-1',
      }),
    )

    const resumed = await waitForEvent(
      events,
      (event) => event.type === 'session_resumed' && event.agentId === sessionAgentId && event.requestId === 'resume-1',
    )
    expect(resumed.type).toBe('session_resumed')

    client.send(
      JSON.stringify({
        type: 'rename_session',
        agentId: sessionAgentId,
        label: 'Renamed session',
        requestId: 'rename-1',
      }),
    )

    const renamed = await waitForEvent(
      events,
      (event) => event.type === 'session_renamed' && event.agentId === sessionAgentId && event.requestId === 'rename-1',
    )
    expect(renamed.type).toBe('session_renamed')
    if (renamed.type === 'session_renamed') {
      expect(renamed.label).toBe('Renamed session')
    }

    client.send(
      JSON.stringify({
        type: 'pin_session',
        agentId: sessionAgentId,
        pinned: true,
        requestId: 'pin-1',
      }),
    )

    const pinned = await waitForEvent(
      events,
      (event) => event.type === 'session_pinned' && event.agentId === sessionAgentId && event.requestId === 'pin-1',
    )
    expect(pinned.type).toBe('session_pinned')
    if (pinned.type === 'session_pinned') {
      expect(pinned.pinned).toBe(true)
      expect(typeof pinned.pinnedAt).toBe('string')
    }

    await waitForEvent(
      events,
      (event) =>
        event.type === 'agents_snapshot' &&
        event.agents.some((agent) => agent.agentId === sessionAgentId && typeof agent.pinnedAt === 'string'),
    )

    client.send(
      JSON.stringify({
        type: 'fork_session',
        sourceAgentId: sessionAgentId,
        label: 'Forked session',
        requestId: 'fork-1',
      }),
    )

    const forked = await waitForEvent(events, (event) => event.type === 'session_forked' && event.requestId === 'fork-1')
    expect(forked.type).toBe('session_forked')

    let forkedAgentId = ''
    if (forked.type === 'session_forked') {
      forkedAgentId = forked.newSessionAgent.agentId
      expect(forked.sourceAgentId).toBe(sessionAgentId)
      expect(forked.profile.profileId).toBe('manager')
      expect(forked.newSessionAgent.pinnedAt).toBeUndefined()
    }
    expect(forkedAgentId).not.toBe('')

    client.send(
      JSON.stringify({
        type: 'merge_session_memory',
        agentId: sessionAgentId,
        requestId: 'merge-1',
      }),
    )

    const mergeStarted = await waitForEvent(
      events,
      (event) =>
        event.type === 'session_memory_merge_started' && event.agentId === sessionAgentId && event.requestId === 'merge-1',
    )
    expect(mergeStarted.type).toBe('session_memory_merge_started')

    const merged = await waitForEvent(
      events,
      (event) => event.type === 'session_memory_merged' && event.agentId === sessionAgentId && event.requestId === 'merge-1',
    )
    expect(merged.type).toBe('session_memory_merged')
    if (merged.type === 'session_memory_merged') {
      expect(merged.status).toBe('applied')
      expect(merged.strategy).toBe('llm')
      expect(merged.auditPath).toBe('/tmp/merge-audit.log')
    }
    expect(mergeCalls).toEqual([sessionAgentId])

    client.send(
      JSON.stringify({
        type: 'delete_session',
        agentId: forkedAgentId,
        requestId: 'delete-1',
      }),
    )

    const deleted = await waitForEvent(
      events,
      (event) => event.type === 'session_deleted' && event.agentId === forkedAgentId && event.requestId === 'delete-1',
    )
    expect(deleted.type).toBe('session_deleted')

    await waitForEvent(
      events,
      (event) => event.type === 'agents_snapshot' && !event.agents.some((agent) => agent.agentId === forkedAgentId),
    )

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('emits session_memory_merge_failed when merge fails', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    ;(manager as unknown as { mergeSessionMemory: (agentId: string) => Promise<unknown> }).mergeSessionMemory = async () => {
      throw Object.assign(new Error('merge exploded'), {
        strategy: 'llm',
        stage: 'write_audit',
        auditPath: '/tmp/merge-audit.log',
      })
    }

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe' }))
    await waitForEvent(events, (event) => event.type === 'ready')

    client.send(
      JSON.stringify({
        type: 'merge_session_memory',
        agentId: 'manager',
        requestId: 'merge-fail-1',
      }),
    )

    await waitForEvent(
      events,
      (event) => event.type === 'session_memory_merge_started' && event.requestId === 'merge-fail-1',
    )

    const mergeFailed = await waitForEvent(
      events,
      (event) => event.type === 'session_memory_merge_failed' && event.requestId === 'merge-fail-1',
    )
    expect(mergeFailed.type).toBe('session_memory_merge_failed')
    if (mergeFailed.type === 'session_memory_merge_failed') {
      expect(mergeFailed.message).toContain('merge exploded')
      expect(mergeFailed.status).toBe('failed')
      expect(mergeFailed.strategy).toBe('llm')
      expect(mergeFailed.stage).toBe('write_audit')
      expect(mergeFailed.auditPath).toBe('/tmp/merge-audit.log')
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('handles api_proxy websocket commands for mobile + slash-command endpoints', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port, true)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)
    const { sessionAgent } = await manager.createSession('manager', { label: 'Unread Inbox' })

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'manager' }))

    await waitForEvent(
      events,
      (event) => event.type === 'ready' && event.subscribedAgentId === 'manager',
    )

    manager.emit(
      'conversation_message',
      {
        type: 'conversation_message',
        agentId: sessionAgent.agentId,
        role: 'assistant',
        text: 'Unread update for mobile fallback.',
        timestamp: new Date().toISOString(),
        source: 'speak_to_user',
      } satisfies ServerEvent,
    )

    await waitForEvent(
      events,
      (event) => event.type === 'unread_count_update' && event.agentId === sessionAgent.agentId && event.count === 1,
    )

    client.send(
      JSON.stringify({
        type: 'api_proxy',
        requestId: 'proxy-get-1',
        method: 'GET',
        path: '/api/mobile/notification-preferences',
      }),
    )

    const getResponse = await waitForEvent(
      events,
      (event) => event.type === 'api_proxy_response' && event.requestId === 'proxy-get-1',
    )
    expect(getResponse.type).toBe('api_proxy_response')
    if (getResponse.type === 'api_proxy_response') {
      expect(getResponse.status).toBe(200)
      const body = JSON.parse(getResponse.body) as {
        preferences?: {
          unreadMessages?: boolean
          enabled?: boolean
        }
      }
      expect(body.preferences?.enabled).toBe(true)
      expect(body.preferences?.unreadMessages).toBe(true)
    }

    client.send(
      JSON.stringify({
        type: 'api_proxy',
        requestId: 'proxy-put-1',
        method: 'PUT',
        path: '/api/mobile/notification-preferences',
        body: JSON.stringify({ unreadMessages: false }),
      }),
    )

    const putResponse = await waitForEvent(
      events,
      (event) => event.type === 'api_proxy_response' && event.requestId === 'proxy-put-1',
    )
    expect(putResponse.type).toBe('api_proxy_response')
    if (putResponse.type === 'api_proxy_response') {
      expect(putResponse.status).toBe(200)
      const body = JSON.parse(putResponse.body) as {
        preferences?: {
          unreadMessages?: boolean
        }
      }
      expect(body.preferences?.unreadMessages).toBe(false)
    }

    client.send(
      JSON.stringify({
        type: 'api_proxy',
        requestId: 'proxy-slash-1',
        method: 'GET',
        path: '/api/slash-commands',
      }),
    )

    const slashResponse = await waitForEvent(
      events,
      (event) => event.type === 'api_proxy_response' && event.requestId === 'proxy-slash-1',
    )
    expect(slashResponse.type).toBe('api_proxy_response')
    if (slashResponse.type === 'api_proxy_response') {
      expect(slashResponse.status).toBe(200)
      const body = JSON.parse(slashResponse.body) as { commands?: unknown[] }
      expect(Array.isArray(body.commands)).toBe(true)
      expect(body.commands).toHaveLength(0)
    }

    client.send(
      JSON.stringify({
        type: 'api_proxy',
        requestId: 'proxy-unread-1',
        method: 'GET',
        path: '/api/unread',
      }),
    )

    const unreadResponse = await waitForEvent(
      events,
      (event) => event.type === 'api_proxy_response' && event.requestId === 'proxy-unread-1',
    )
    expect(unreadResponse.type).toBe('api_proxy_response')
    if (unreadResponse.type === 'api_proxy_response') {
      expect(unreadResponse.status).toBe(200)
      const body = JSON.parse(unreadResponse.body) as { counts?: Record<string, number> }
      expect(body.counts?.[sessionAgent.agentId]).toBe(1)
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })

  it('rejects non-manager subscription with explicit error', async () => {
    const port = await getAvailablePort()
    const config = await makeTempConfig(port)

    const manager = new TestSwarmManager(config)
    await bootWithDefaultManager(manager, config)

    const server = new SwarmWebSocketServer({
      swarmManager: manager,
      host: config.host,
      port: config.port,
      allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    })

    await server.start()

    const client = new WebSocket(`ws://${config.host}:${config.port}`)
    const events: ServerEvent[] = []

    client.on('message', (raw) => {
      events.push(JSON.parse(raw.toString()) as ServerEvent)
    })

    await once(client, 'open')
    client.send(JSON.stringify({ type: 'subscribe', agentId: 'worker-1' }))

    const errorEvent = await waitForEvent(events, (event) => event.type === 'error')
    expect(errorEvent.type).toBe('error')
    if (errorEvent.type === 'error') {
      expect(errorEvent.code).toBe('SUBSCRIPTION_NOT_SUPPORTED')
    }

    client.close()
    await once(client, 'close')
    await server.stop()
  })
})
