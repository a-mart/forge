import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { getPhoenixObservabilitySettingsPath } from '../../swarm/data-paths.js'
import { ObservabilityService } from '../observability-service.js'
import { createDefaultPhoenixObservabilitySettings } from '../observability-settings.js'

describe('ObservabilityService', () => {
  it('is disabled and no-op by default', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-observability-service-'))
    const service = new ObservabilityService({ dataDir, runtimeTarget: 'builder' })

    await service.initialize()
    service.recordFeedback({
      id: 'feedback-1',
      createdAt: new Date().toISOString(),
      profileId: 'profile-1',
      sessionId: 'session-1',
      scope: 'message',
      targetId: 'message-1',
      value: 'up',
      reasonCodes: [],
      comment: '',
      channel: 'web',
      actor: 'user',
    })

    expect(service.getStatus()).toMatchObject({ enabled: false, exporter: { configured: false } })
  })

  it('fails open when exporter construction fails during startup', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-observability-service-'))
    const settingsPath = getPhoenixObservabilitySettingsPath(dataDir)
    await mkdir(dirname(settingsPath), { recursive: true })
    await writeFile(settingsPath, JSON.stringify({ ...createDefaultPhoenixObservabilitySettings(), enabled: true }), 'utf8')
    const service = new ObservabilityService({
      dataDir,
      runtimeTarget: 'builder',
      exporterFactory: () => {
        throw new Error('exporter failed')
      },
    })

    await expect(service.initialize()).resolves.toBeUndefined()

    expect(service.getStatus()).toMatchObject({
      enabled: true,
      exporter: { configured: false, active: false, lastErrorMessage: 'exporter failed' },
    })
  })
})
