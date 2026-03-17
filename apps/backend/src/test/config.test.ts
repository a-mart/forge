import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createConfig, readPlaywrightDashboardEnvOverride } from '../config.js'
import { withPlatform } from './test-helpers.js'

const MANAGED_ENV_KEYS = [
  'NODE_ENV',
  'FORGE_HOST',
  'FORGE_PORT',
  'FORGE_DATA_DIR',
  'FORGE_DEBUG',
  'FORGE_PLAYWRIGHT_DASHBOARD_ENABLED',
  'MIDDLEMAN_HOST',
  'MIDDLEMAN_PORT',
  'MIDDLEMAN_DATA_DIR',
  'MIDDLEMAN_DEBUG',
  'MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED',
  'LOCALAPPDATA',
] as const

async function withEnv(overrides: Partial<Record<(typeof MANAGED_ENV_KEYS)[number], string>>, run: () => Promise<void> | void) {
  const previous = new Map<string, string | undefined>()

  for (const key of MANAGED_ENV_KEYS) {
    previous.set(key, process.env[key])
    delete process.env[key]
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  try {
    await run()
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

function expectedDefaultDataDir(platform: NodeJS.Platform): string {
  const forgePath = resolve(homedir(), '.forge')
  const legacyPath = resolve(homedir(), '.middleman')

  if (platform !== 'win32') {
    if (existsSync(forgePath)) {
      return forgePath
    }

    if (existsSync(legacyPath)) {
      return legacyPath
    }

    return forgePath
  }

  const localAppDataBase = process.env.LOCALAPPDATA?.trim()
    ? resolve(process.env.LOCALAPPDATA)
    : resolve(homedir(), 'AppData', 'Local')
  const windowsDefault = resolve(localAppDataBase, 'forge')
  const windowsLegacy = resolve(localAppDataBase, 'middleman')

  if (existsSync(windowsDefault)) {
    return windowsDefault
  }

  if (existsSync(windowsLegacy)) {
    return windowsLegacy
  }

  if (existsSync(legacyPath)) {
    return legacyPath
  }

  return windowsDefault
}

describe('createConfig', () => {
  it('uses defaults', async () => {
    await withEnv({}, () => {
      const config = createConfig()
      const dataDir = expectedDefaultDataDir(process.platform)

      expect(config.host).toBe('127.0.0.1')
      expect(config.port).toBe(47187)
      expect(config.debug).toBe(false)
      expect(config.paths.dataDir).toBe(dataDir)
    })
  })

  it('respects FORGE_* env vars', async () => {
    const dataDir = join(tmpdir(), 'forge-data-dir')

    await withEnv(
      {
        FORGE_HOST: '0.0.0.0',
        FORGE_PORT: '9999',
        FORGE_DEBUG: 'true',
        FORGE_DATA_DIR: dataDir,
      },
      () => {
        const config = createConfig()
        expect(config.host).toBe('0.0.0.0')
        expect(config.port).toBe(9999)
        expect(config.debug).toBe(true)
        expect(config.paths.dataDir).toBe(dataDir)
      }
    )
  })

  it('supports legacy MIDDLEMAN_* env vars when FORGE_* is absent', async () => {
    const dataDir = join(tmpdir(), 'legacy-middleman-data-dir')

    await withEnv(
      {
        MIDDLEMAN_HOST: '0.0.0.0',
        MIDDLEMAN_PORT: '7777',
        MIDDLEMAN_DEBUG: 'true',
        MIDDLEMAN_DATA_DIR: dataDir,
      },
      () => {
        const config = createConfig()
        expect(config.host).toBe('0.0.0.0')
        expect(config.port).toBe(7777)
        expect(config.debug).toBe(true)
        expect(config.paths.dataDir).toBe(dataDir)
      }
    )
  })

  it('FORGE_* values win when both FORGE_* and MIDDLEMAN_* are set', async () => {
    const forgeDataDir = join(tmpdir(), 'forge-data-dir-win')

    await withEnv(
      {
        FORGE_HOST: '127.0.0.2',
        FORGE_PORT: '1234',
        FORGE_DEBUG: 'true',
        FORGE_DATA_DIR: forgeDataDir,
        MIDDLEMAN_HOST: '127.0.0.3',
        MIDDLEMAN_PORT: '9876',
        MIDDLEMAN_DEBUG: 'false',
        MIDDLEMAN_DATA_DIR: join(tmpdir(), 'middleman-ignored'),
      },
      () => {
        const config = createConfig()
        expect(config.host).toBe('127.0.0.2')
        expect(config.port).toBe(1234)
        expect(config.debug).toBe(true)
        expect(config.paths.dataDir).toBe(forgeDataDir)
      }
    )
  })

  it('uses LOCALAPPDATA/forge by default on mocked win32 when available', async () => {
    const localAppData = await mkdtemp(join(tmpdir(), 'forge-localappdata-'))
    const windowsDefault = resolve(localAppData, 'forge')
    await mkdir(windowsDefault, { recursive: true })

    try {
      await withPlatform('win32', async () => {
        await withEnv({ LOCALAPPDATA: localAppData }, () => {
          const config = createConfig()
          expect(config.paths.dataDir).toBe(windowsDefault)
        })
      })
    } finally {
      await rm(localAppData, { recursive: true, force: true })
    }
  })

  it('falls back to LOCALAPPDATA/middleman on win32 when forge dir is absent', async () => {
    const localAppData = await mkdtemp(join(tmpdir(), 'forge-localappdata-legacy-'))
    const windowsLegacy = resolve(localAppData, 'middleman')
    await mkdir(windowsLegacy, { recursive: true })

    try {
      await withPlatform('win32', async () => {
        await withEnv({ LOCALAPPDATA: localAppData }, () => {
          const config = createConfig()
          expect(config.paths.dataDir).toBe(windowsLegacy)
        })
      })
    } finally {
      await rm(localAppData, { recursive: true, force: true })
    }
  })

  it('falls back to ~/.middleman on win32 when appdata dirs are absent', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'forge-home-'))
    const legacyPath = resolve(fakeHome, '.middleman')
    const localAppData = await mkdtemp(join(tmpdir(), 'forge-localappdata-absent-'))
    const windowsDefault = resolve(localAppData, 'forge')
    await mkdir(legacyPath, { recursive: true })

    try {
      await withPlatform('win32', async () => {
        await withEnv({ LOCALAPPDATA: localAppData }, async () => {
          const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
          vi.resetModules()
          vi.doMock('node:os', async (importOriginal) => {
            const actual = await importOriginal<typeof import('node:os')>()
            return {
              ...actual,
              homedir: () => fakeHome,
            }
          })

          try {
            const { createConfig: createConfigWithMockedHome } = await import('../config.js')
            const config = createConfigWithMockedHome()
            expect(config.paths.dataDir).toBe(legacyPath)
            expect(warnSpy).toHaveBeenCalledWith(
              `[config] Using legacy data dir ${legacyPath} on Windows. Set FORGE_DATA_DIR or migrate to ${windowsDefault}.`
            )
          } finally {
            warnSpy.mockRestore()
            vi.doUnmock('node:os')
            vi.resetModules()
          }
        })
      })
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
      await rm(localAppData, { recursive: true, force: true })
    }
  })

  it('parses Playwright Dashboard env override values with FORGE_* precedence', async () => {
    await withEnv({ FORGE_PLAYWRIGHT_DASHBOARD_ENABLED: 'yes' }, () => {
      expect(readPlaywrightDashboardEnvOverride()).toBe(true)
    })

    await withEnv({ MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED: 'off' }, () => {
      expect(readPlaywrightDashboardEnvOverride()).toBe(false)
    })

    await withEnv(
      {
        FORGE_PLAYWRIGHT_DASHBOARD_ENABLED: 'true',
        MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED: 'off',
      },
      () => {
        expect(readPlaywrightDashboardEnvOverride()).toBe(true)
      }
    )

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await withEnv({ FORGE_PLAYWRIGHT_DASHBOARD_ENABLED: 'maybe' }, () => {
        expect(readPlaywrightDashboardEnvOverride()).toBeUndefined()
      })
      expect(warnSpy).toHaveBeenCalledWith(
        '[config] Ignoring invalid FORGE_PLAYWRIGHT_DASHBOARD_ENABLED value: maybe',
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})
