import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentDescriptor } from '../swarm/types.js'
import { getNotificationSettingsPath } from '../swarm/data-paths.js'
import {
  isCliOriginatedSession,
  NotificationSettingsService,
  shouldMuteCliOriginatedNotifications,
} from '../swarm/notification-settings-service.js'

function createManagerDescriptor(sessionFile: string, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: 'manager',
    managerId: 'manager',
    displayName: 'Manager',
    role: 'manager',
    status: 'idle',
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    cwd: '/tmp/project',
    model: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
    sessionFile,
    ...overrides,
  }
}

describe('NotificationSettingsService', () => {
  it('defaults CLI-originated notification mute to false and persists updates', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'notification-settings-'))
    const service = new NotificationSettingsService({ dataDir, now: () => new Date('2026-05-12T00:00:00.000Z') })

    await service.load()
    expect(service.getSettings()).toEqual({ muteCliOriginatedNotifications: false, updatedAt: null })

    await service.update({ muteCliOriginatedNotifications: true })
    expect(service.getSettings()).toEqual({
      muteCliOriginatedNotifications: true,
      updatedAt: '2026-05-12T00:00:00.000Z',
    })

    const reloaded = new NotificationSettingsService({ dataDir })
    await reloaded.load()
    expect(reloaded.getSettings().muteCliOriginatedNotifications).toBe(true)
  })

  it('classifies forge-cli-created sessions as CLI-originated', async () => {
    const descriptor = createManagerDescriptor('/tmp/missing-session.jsonl', {
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-05-12T00:00:00.000Z' },
    })

    await expect(isCliOriginatedSession(descriptor)).resolves.toBe(true)
  })

  it('uses the latest user_input sourceContext channel for regular sessions', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'notification-origin-'))
    const sessionFile = join(dataDir, 'session.jsonl')
    const descriptor = createManagerDescriptor(sessionFile)

    await writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: 'conversation_message',
          agentId: 'manager',
          role: 'user',
          text: 'from web first',
          timestamp: '2026-05-12T00:00:00.000Z',
          source: 'user_input',
          sourceContext: { channel: 'web' },
        }),
        JSON.stringify({
          type: 'conversation_message',
          agentId: 'manager',
          role: 'user',
          text: 'from cli latest',
          timestamp: '2026-05-12T00:01:00.000Z',
          source: 'user_input',
          sourceContext: { channel: 'cli' },
        }),
      ].join('\n') + '\n',
      'utf8',
    )
    await expect(isCliOriginatedSession(descriptor)).resolves.toBe(true)

    await writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: 'conversation_message',
          agentId: 'manager',
          role: 'user',
          text: 'from cli first',
          timestamp: '2026-05-12T00:00:00.000Z',
          source: 'user_input',
          sourceContext: { channel: 'cli' },
        }),
        JSON.stringify({
          type: 'conversation_message',
          agentId: 'manager',
          role: 'user',
          text: 'from web latest',
          timestamp: '2026-05-12T00:01:00.000Z',
          source: 'user_input',
          sourceContext: { channel: 'web' },
        }),
      ].join('\n') + '\n',
      'utf8',
    )
    await expect(isCliOriginatedSession(descriptor)).resolves.toBe(false)
  })

  it('only mutes CLI-originated sessions when the setting is enabled', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'notification-settings-'))
    const settingsPath = getNotificationSettingsPath(dataDir)
    await mkdir(dirname(settingsPath), { recursive: true })
    await writeFile(
      settingsPath,
      JSON.stringify({ version: 1, muteCliOriginatedNotifications: true, updatedAt: '2026-05-12T00:00:00.000Z' }),
      'utf8',
    )
    const service = new NotificationSettingsService({ dataDir })
    await service.load()

    const descriptor = createManagerDescriptor('/tmp/missing-session.jsonl', {
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-05-12T00:00:00.000Z' },
    })

    await expect(shouldMuteCliOriginatedNotifications({ settingsService: service, descriptor })).resolves.toBe(true)
  })
})
