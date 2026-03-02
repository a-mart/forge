import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SHARED_INTEGRATION_MANAGER_ID,
} from '../integrations/shared-config.js'
import {
  buildSlackProfileId,
  createDefaultSlackConfig,
  getSlackConfigPath,
  hasSlackOverrideConfig,
  loadSlackConfig,
  saveSlackConfig,
} from '../integrations/slack/slack-config.js'
import {
  buildTelegramProfileId,
  createDefaultTelegramConfig,
  getTelegramConfigPath,
  hasTelegramOverrideConfig,
  loadTelegramConfig,
  saveTelegramConfig,
} from '../integrations/telegram/telegram-config.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

describe('shared integration config fallback', () => {
  it('falls back to shared Slack config when manager override is missing or empty', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'shared-slack-config-test-'))

    const sharedSlack = createDefaultSlackConfig(SHARED_INTEGRATION_MANAGER_ID)
    sharedSlack.enabled = true
    sharedSlack.appToken = 'xapp-shared-token'
    sharedSlack.botToken = 'xoxb-shared-token'
    sharedSlack.listen.dm = false

    await saveSlackConfig({
      dataDir,
      managerId: SHARED_INTEGRATION_MANAGER_ID,
      config: sharedSlack,
    })

    const inherited = await loadSlackConfig({ dataDir, managerId: 'manager-a' })
    expect(inherited.enabled).toBe(true)
    expect(inherited.appToken).toBe('xapp-shared-token')
    expect(inherited.botToken).toBe('xoxb-shared-token')
    expect(inherited.listen.dm).toBe(false)
    expect(inherited.profileId).toBe(buildSlackProfileId('manager-a'))

    await writeJson(getSlackConfigPath(dataDir, 'manager-empty'), {})
    expect(
      await hasSlackOverrideConfig({ dataDir, managerId: 'manager-empty' }),
    ).toBe(false)

    const inheritedFromEmpty = await loadSlackConfig({ dataDir, managerId: 'manager-empty' })
    expect(inheritedFromEmpty.appToken).toBe('xapp-shared-token')
    expect(inheritedFromEmpty.profileId).toBe(buildSlackProfileId('manager-empty'))

    const managerOverride = createDefaultSlackConfig('manager-a')
    managerOverride.enabled = true
    managerOverride.appToken = 'xapp-manager-token'
    managerOverride.botToken = 'xoxb-manager-token'

    await saveSlackConfig({
      dataDir,
      managerId: 'manager-a',
      config: managerOverride,
    })

    expect(
      await hasSlackOverrideConfig({ dataDir, managerId: 'manager-a' }),
    ).toBe(true)

    const loadedOverride = await loadSlackConfig({ dataDir, managerId: 'manager-a' })
    expect(loadedOverride.appToken).toBe('xapp-manager-token')
    expect(loadedOverride.botToken).toBe('xoxb-manager-token')
  })

  it('falls back to shared Telegram config when manager override is missing or empty', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'shared-telegram-config-test-'))

    const sharedTelegram = createDefaultTelegramConfig(SHARED_INTEGRATION_MANAGER_ID)
    sharedTelegram.enabled = true
    sharedTelegram.botToken = '123456:shared-token'
    sharedTelegram.polling.limit = 17

    await saveTelegramConfig({
      dataDir,
      managerId: SHARED_INTEGRATION_MANAGER_ID,
      config: sharedTelegram,
    })

    const inherited = await loadTelegramConfig({ dataDir, managerId: 'manager-a' })
    expect(inherited.enabled).toBe(true)
    expect(inherited.botToken).toBe('123456:shared-token')
    expect(inherited.polling.limit).toBe(17)
    expect(inherited.profileId).toBe(buildTelegramProfileId('manager-a'))

    await writeJson(getTelegramConfigPath(dataDir, 'manager-empty'), {})
    expect(
      await hasTelegramOverrideConfig({ dataDir, managerId: 'manager-empty' }),
    ).toBe(false)

    const inheritedFromEmpty = await loadTelegramConfig({ dataDir, managerId: 'manager-empty' })
    expect(inheritedFromEmpty.botToken).toBe('123456:shared-token')
    expect(inheritedFromEmpty.profileId).toBe(buildTelegramProfileId('manager-empty'))

    const managerOverride = createDefaultTelegramConfig('manager-a')
    managerOverride.enabled = true
    managerOverride.botToken = '123456:manager-token'

    await saveTelegramConfig({
      dataDir,
      managerId: 'manager-a',
      config: managerOverride,
    })

    expect(
      await hasTelegramOverrideConfig({ dataDir, managerId: 'manager-a' }),
    ).toBe(true)

    const loadedOverride = await loadTelegramConfig({ dataDir, managerId: 'manager-a' })
    expect(loadedOverride.botToken).toBe('123456:manager-token')
  })
})
