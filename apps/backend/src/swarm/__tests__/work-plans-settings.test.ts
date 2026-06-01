import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getWorkPlansEnabled,
  resolveActiveWorkPlansGuidance,
  setWorkPlansEnabled,
  ACTIVE_WORK_PLANS_GUIDANCE_ENABLED,
} from '../coordination/work-plans-settings.js'
import { getWorkPlansSettingsPath } from '../data-paths.js'

describe('work-plans-settings', () => {
  let dataDir = ''

  afterEach(async () => {
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true })
      dataDir = ''
    }
  })

  it('defaults to enabled when the settings file is missing', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'work-plans-settings-'))
    await expect(getWorkPlansEnabled(dataDir)).resolves.toBe(true)
  })

  it('persists disabled state to shared config', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'work-plans-settings-'))
    await setWorkPlansEnabled(dataDir, false)
    await expect(getWorkPlansEnabled(dataDir)).resolves.toBe(false)

    const raw = await readFile(getWorkPlansSettingsPath(dataDir), 'utf8')
    expect(JSON.parse(raw)).toEqual({ enabled: false })
  })

  it('treats enabled: true as enabled', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'work-plans-settings-'))
    const filePath = getWorkPlansSettingsPath(dataDir)
    await mkdir(join(dataDir, 'shared', 'config'), { recursive: true })
    await writeFile(filePath, JSON.stringify({ enabled: true }) + '\n', 'utf8')
    await expect(getWorkPlansEnabled(dataDir)).resolves.toBe(true)
  })

  it('falls back to enabled when the settings file is malformed', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'work-plans-settings-'))
    const filePath = getWorkPlansSettingsPath(dataDir)
    await mkdir(join(dataDir, 'shared', 'config'), { recursive: true })
    await writeFile(filePath, '{not-json', 'utf8')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(getWorkPlansEnabled(dataDir)).resolves.toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[work-plans-settings] Failed to load settings from'),
    )

    warnSpy.mockRestore()
  })
})

describe('resolveActiveWorkPlansGuidance', () => {
  it('returns manager guidance when enabled and empty string when disabled', () => {
    expect(resolveActiveWorkPlansGuidance(true)).toBe(ACTIVE_WORK_PLANS_GUIDANCE_ENABLED)
    expect(resolveActiveWorkPlansGuidance(false)).toBe('')
  })
})
