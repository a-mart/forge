import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { getPhoenixObservabilitySettingsPath } from '../../swarm/data-paths.js'
import {
  PhoenixObservabilitySettingsService,
  sanitizePhoenixProjectName,
  validatePhoenixEndpoint,
} from '../observability-settings.js'

describe('PhoenixObservabilitySettingsService', () => {
  it('loads disabled rich defaults without writing a file', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-phoenix-settings-'))
    const service = new PhoenixObservabilitySettingsService(dataDir)

    const settings = await service.getSettings()

    expect(settings.enabled).toBe(false)
    expect(settings.contentMode).toBe('rich')
    expect(settings.endpoint).toBe('http://127.0.0.1:6006/v1/traces')
    await expect(readFile(getPhoenixObservabilitySettingsPath(dataDir), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('persists normalized non-secret settings', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'forge-phoenix-settings-'))
    const service = new PhoenixObservabilitySettingsService(dataDir)

    const updated = await service.updateSettings({
      enabled: true,
      endpoint: 'http://localhost:16006/v1/traces',
      projectName: 'my-local-project',
      privacy: { extraRedactionPatterns: ['secret-[0-9]+'] },
    })

    expect(updated.enabled).toBe(true)
    expect(updated.projectName).toBe('my-local-project')
    const raw = await readFile(getPhoenixObservabilitySettingsPath(dataDir), 'utf8')
    expect(raw).toContain('my-local-project')
    expect(raw).not.toMatch(/apiKey|authorization|headers/i)
  })

  it('falls back invalid project names to default', () => {
    expect(sanitizePhoenixProjectName('')).toBe('default')
    expect(sanitizePhoenixProjectName('../bad')).toBe('default')
    expect(sanitizePhoenixProjectName('valid project_1')).toBe('valid project_1')
  })
})

describe('validatePhoenixEndpoint', () => {
  it('accepts only http loopback OTLP traces URLs', () => {
    expect(() => validatePhoenixEndpoint('http://127.0.0.1:6006/v1/traces')).not.toThrow()
    expect(() => validatePhoenixEndpoint('http://127.9.8.7:6006/v1/traces')).not.toThrow()
    expect(() => validatePhoenixEndpoint('http://[::1]:6006/v1/traces')).not.toThrow()
    expect(() => validatePhoenixEndpoint('http://localhost:6006/v1/traces')).not.toThrow()
  })

  it('rejects remote, private/LAN, https, credentialed, and wrong-path endpoints', () => {
    for (const endpoint of [
      'https://127.0.0.1:6006/v1/traces',
      'http://192.168.1.5:6006/v1/traces',
      'http://10.0.0.1:6006/v1/traces',
      'http://example.com:6006/v1/traces',
      'http://user:pass@127.0.0.1:6006/v1/traces',
      'http://127.0.0.1:6006/',
    ]) {
      expect(() => validatePhoenixEndpoint(endpoint), endpoint).toThrow()
    }
  })
})
