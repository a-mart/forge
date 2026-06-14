import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACTIVE_WORK_PLANS_GUIDANCE_ENABLED,
  getWorkPlansEnabled,
  resolveActiveWorkPlansGuidance,
  setWorkPlansEnabled,
} from '../coordination/work-plans-settings.js'
import { getWorkPlansSettingsPath } from '../data-paths.js'

describe('work-plans-settings parked behavior', () => {
  it('always reports disabled without reading/writing settings state', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'work-plans-settings-'))

    await expect(getWorkPlansEnabled(dataDir)).resolves.toBe(false)
    await setWorkPlansEnabled(dataDir, true)
    await expect(getWorkPlansEnabled(dataDir)).resolves.toBe(false)

    await expect(readFile(getWorkPlansSettingsPath(dataDir), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('omits Active Work prompt guidance even when asked to resolve enabled guidance', () => {
    expect(ACTIVE_WORK_PLANS_GUIDANCE_ENABLED).toBe('')
    expect(resolveActiveWorkPlansGuidance(true)).toBe('')
    expect(resolveActiveWorkPlansGuidance(false)).toBe('')
  })
})
