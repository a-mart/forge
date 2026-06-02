import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getModelCacheVisualizationEnabled,
  getModelCacheVisualizationSettings,
  setModelCacheVisualizationEnabled,
} from '../model-cache-visualization-settings.js'
import { getModelCacheVisualizationSettingsPath } from '../data-paths.js'

describe('model-cache-visualization-settings', () => {
  let dataDir = ''

  afterEach(async () => {
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true })
      dataDir = ''
    }
  })

  it('defaults to disabled when the settings file is missing', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'model-cache-visualization-settings-'))
    await expect(getModelCacheVisualizationEnabled(dataDir)).resolves.toBe(false)
    await expect(getModelCacheVisualizationSettings(dataDir)).resolves.toEqual({
      enabled: false,
      updatedAt: null,
    })
  })

  it('persists enabled state to shared config', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'model-cache-visualization-settings-'))
    const settings = await setModelCacheVisualizationEnabled(dataDir, true)
    await expect(getModelCacheVisualizationEnabled(dataDir)).resolves.toBe(true)
    expect(settings.enabled).toBe(true)
    expect(settings.updatedAt).toEqual(expect.any(String))

    const raw = await readFile(getModelCacheVisualizationSettingsPath(dataDir), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ enabled: true })
  })

  it('persists disabled state to shared config', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'model-cache-visualization-settings-'))
    await setModelCacheVisualizationEnabled(dataDir, false)
    await expect(getModelCacheVisualizationEnabled(dataDir)).resolves.toBe(false)
  })

  it('treats enabled: false explicitly as disabled', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'model-cache-visualization-settings-'))
    const filePath = getModelCacheVisualizationSettingsPath(dataDir)
    await mkdir(join(dataDir, 'shared', 'config'), { recursive: true })
    await writeFile(filePath, JSON.stringify({ enabled: false }) + '\n', 'utf8')
    await expect(getModelCacheVisualizationEnabled(dataDir)).resolves.toBe(false)
  })

  it('falls back to disabled when the settings file is malformed', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'model-cache-visualization-settings-'))
    const filePath = getModelCacheVisualizationSettingsPath(dataDir)
    await mkdir(join(dataDir, 'shared', 'config'), { recursive: true })
    await writeFile(filePath, '{not-json', 'utf8')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(getModelCacheVisualizationEnabled(dataDir)).resolves.toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[model-cache-visualization-settings] Failed to load settings from'),
    )

    warnSpy.mockRestore()
  })
})
