import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { getPhoenixObservabilitySettingsPath } from '../../swarm/data-paths.js'
import { createNoopObservabilityFacade } from '../noop-observability.js'
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

  it('does not construct or configure an exporter outside Builder even when persisted settings are enabled', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-observability-service-'))
    const settingsPath = getPhoenixObservabilitySettingsPath(dataDir)
    await mkdir(dirname(settingsPath), { recursive: true })
    await writeFile(settingsPath, JSON.stringify({ ...createDefaultPhoenixObservabilitySettings(), enabled: true }), 'utf8')
    let exporterConstructed = false
    const service = new ObservabilityService({
      dataDir,
      runtimeTarget: 'collaboration-server',
      exporterFactory: () => {
        exporterConstructed = true
        throw new Error('must not construct')
      },
    })

    await service.initialize()
    const testResult = await service.testConnection()

    expect(exporterConstructed).toBe(false)
    expect(testResult.ok).toBe(false)
    expect(service.getStatus()).toMatchObject({ enabled: false, runtimeTarget: 'collaboration-server', exporter: { configured: false } })
  })

  it('sanitizes invalid persisted endpoints on startup and does not configure exporter', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-observability-service-'))
    const settingsPath = getPhoenixObservabilitySettingsPath(dataDir)
    await mkdir(dirname(settingsPath), { recursive: true })
    await writeFile(settingsPath, JSON.stringify({
      ...createDefaultPhoenixObservabilitySettings(),
      enabled: true,
      endpoint: 'http://127.0.0.1:6006/v1/traces?token=secret',
    }), 'utf8')
    let exporterConstructed = false
    const service = new ObservabilityService({
      dataDir,
      runtimeTarget: 'builder',
      exporterFactory: () => {
        exporterConstructed = true
        throw new Error('must not construct')
      },
    })

    await service.initialize()
    const settings = await service.getSettings()
    const status = service.getStatus()

    expect(exporterConstructed).toBe(false)
    expect(settings).toMatchObject({ enabled: false, endpoint: 'http://127.0.0.1:6006/v1/traces' })
    expect(JSON.stringify(settings)).not.toContain('token=secret')
    expect(JSON.stringify(status)).not.toContain('token=secret')
    expect(status).toMatchObject({ enabled: false, exporter: { configured: false, endpoint: 'http://127.0.0.1:6006/v1/traces' } })
  })

  it('provides an explicit no-op facade for non-owner tests and standalone construction', async () => {
    const facade = createNoopObservabilityFacade('collaboration-server')

    await expect(facade.initialize()).resolves.toBeUndefined()
    expect(facade.getStatus()).toMatchObject({ enabled: false, runtimeTarget: 'collaboration-server', exporter: { configured: false } })
    await expect(facade.updateSettings({ enabled: true })).rejects.toThrow('not available')
    await expect(facade.testConnection()).resolves.toMatchObject({ ok: false })
    expect(() => facade.recordFeedback({
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
    })).not.toThrow()
  })

  it('does not persist enabled settings when exporter construction fails during update', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-observability-service-'))
    const service = new ObservabilityService({
      dataDir,
      runtimeTarget: 'builder',
      exporterFactory: () => {
        throw new Error('exporter failed')
      },
    })
    await service.initialize()

    await expect(service.updateSettings({ enabled: true })).rejects.toThrow('exporter failed')

    await expect(readFile(getPhoenixObservabilitySettingsPath(dataDir), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(service.getStatus()).toMatchObject({ enabled: false, exporter: { configured: false, lastErrorMessage: 'exporter failed' } })
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
