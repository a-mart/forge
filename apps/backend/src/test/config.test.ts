import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createConfig, readPlaywrightDashboardEnvOverride, readTelemetryEnvOverride } from '../config.js'
import { resolveRuntimeTargetFromEnv } from '../runtime-target.js'
import { withPlatform } from './test-helpers.js'

const MANAGED_ENV_KEYS = [
  'NODE_ENV',
  'FORGE_HOST',
  'FORGE_PORT',
  'FORGE_DATA_DIR',
  'FORGE_DEBUG',
  'FORGE_RESOURCES_DIR',
  'FORGE_DESKTOP',
  'FORGE_RUNTIME_TARGET',
  'FORGE_PLAYWRIGHT_DASHBOARD_ENABLED',
  'FORGE_TELEMETRY',
  'FORGE_COLLABORATION_ENABLED',
  'FORGE_ADMIN_EMAIL',
  'FORGE_ADMIN_PASSWORD',
  'FORGE_COLLABORATION_AUTH_SECRET',
  'FORGE_COLLABORATION_BASE_URL',
  'FORGE_COLLABORATION_TRUSTED_ORIGINS',

  'MIDDLEMAN_HOST',
  'MIDDLEMAN_PORT',
  'MIDDLEMAN_DATA_DIR',
  'MIDDLEMAN_DEBUG',
  'MIDDLEMAN_RESOURCES_DIR',
  'MIDDLEMAN_RUNTIME_TARGET',
  'MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED',
  'MIDDLEMAN_TELEMETRY',
  'MIDDLEMAN_COLLABORATION_ENABLED',
  'MIDDLEMAN_ADMIN_EMAIL',
  'MIDDLEMAN_ADMIN_PASSWORD',
  'MIDDLEMAN_COLLABORATION_AUTH_SECRET',
  'MIDDLEMAN_COLLABORATION_BASE_URL',
  'MIDDLEMAN_COLLABORATION_TRUSTED_ORIGINS',

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
      expect(config.runtimeTarget).toBe('builder')
      expect(config.paths.dataDir).toBe(dataDir)
      expect(config.paths.sharedConfigDir).toBe(resolve(dataDir, 'shared', 'config'))
      expect(config.paths.sharedCacheDir).toBe(resolve(dataDir, 'shared', 'cache'))
      expect(config.paths.sharedStateDir).toBe(resolve(dataDir, 'shared', 'state'))
      expect(config.paths.collaborationConfigDir).toBe(resolve(dataDir, 'shared', 'config', 'collaboration'))
      expect(config.paths.collaborationAuthDbPath).toBe(resolve(dataDir, 'shared', 'config', 'collaboration', 'auth.db'))
      expect(config.paths.collaborationAuthSecretPath).toBe(resolve(dataDir, 'shared', 'config', 'collaboration', 'auth-secret.key'))
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

  it('uses FORGE_RESOURCES_DIR when set', async () => {
    const resourcesDir = join(tmpdir(), 'forge-resources-dir')

    await withEnv({ FORGE_RESOURCES_DIR: resourcesDir }, () => {
      const config = createConfig()
      expect(config.paths.resourcesDir).toBe(resourcesDir)
      expect(config.paths.repoArchetypesDir).toBe(join(resourcesDir, '.swarm', 'archetypes'))
      expect(config.paths.repoMemorySkillFile).toBe(join(resourcesDir, '.swarm', 'skills', 'memory', 'SKILL.md'))
    })
  })

  it('supports legacy MIDDLEMAN_RESOURCES_DIR when FORGE_RESOURCES_DIR is absent', async () => {
    const resourcesDir = join(tmpdir(), 'legacy-middleman-resources-dir')

    await withEnv({ MIDDLEMAN_RESOURCES_DIR: resourcesDir }, () => {
      const config = createConfig()
      expect(config.paths.resourcesDir).toBe(resourcesDir)
    })
  })

  it('FORGE_RESOURCES_DIR wins when both FORGE_RESOURCES_DIR and MIDDLEMAN_RESOURCES_DIR are set', async () => {
    const forgeResourcesDir = join(tmpdir(), 'forge-resources-preferred')
    const legacyResourcesDir = join(tmpdir(), 'middleman-resources-ignored')

    await withEnv(
      {
        FORGE_RESOURCES_DIR: forgeResourcesDir,
        MIDDLEMAN_RESOURCES_DIR: legacyResourcesDir,
      },
      () => {
        const config = createConfig()
        expect(config.paths.resourcesDir).toBe(forgeResourcesDir)
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

  it('parses telemetry env override values with FORGE_* precedence', async () => {
    await withEnv({ FORGE_TELEMETRY: 'yes' }, () => {
      expect(readTelemetryEnvOverride()).toBe(true)
    })

    await withEnv({ MIDDLEMAN_TELEMETRY: 'off' }, () => {
      expect(readTelemetryEnvOverride()).toBe(false)
    })

    await withEnv(
      {
        FORGE_TELEMETRY: 'true',
        MIDDLEMAN_TELEMETRY: 'off',
      },
      () => {
        expect(readTelemetryEnvOverride()).toBe(true)
      }
    )

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await withEnv({ FORGE_TELEMETRY: 'maybe' }, () => {
        expect(readTelemetryEnvOverride()).toBeUndefined()
      })
      expect(warnSpy).toHaveBeenCalledWith(
        '[config] Ignoring invalid FORGE_TELEMETRY value: maybe',
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('defaults runtime target to builder when no runtime env is set', async () => {
    await withEnv({}, () => {
      expect(resolveRuntimeTargetFromEnv()).toBe('builder')
      expect(createConfig().runtimeTarget).toBe('builder')
    })
  })

  it('parses FORGE_RUNTIME_TARGET when set', async () => {
    await withEnv({ FORGE_RUNTIME_TARGET: 'collaboration-server' }, () => {
      expect(resolveRuntimeTargetFromEnv()).toBe('collaboration-server')
      const config = createConfig()
      expect(config.runtimeTarget).toBe('collaboration-server')
      expect(config.collaborationModules).toBeDefined()
    })
  })

  it('supports legacy MIDDLEMAN_RUNTIME_TARGET when FORGE_RUNTIME_TARGET is absent', async () => {
    await withEnv({ MIDDLEMAN_RUNTIME_TARGET: 'collaboration-server' }, () => {
      expect(resolveRuntimeTargetFromEnv()).toBe('collaboration-server')
      expect(createConfig().runtimeTarget).toBe('collaboration-server')
    })
  })

  it('keeps collaboration loaders disabled in builder runtime', async () => {
    await withEnv({ FORGE_RUNTIME_TARGET: 'builder' }, () => {
      expect(createConfig().collaborationModules).toBeUndefined()
    })
  })

  it('parses collaboration auth env values for collaboration-server runtime', async () => {
    await withEnv(
      {
        FORGE_RUNTIME_TARGET: 'collaboration-server',
        FORGE_ADMIN_EMAIL: ' admin@example.com ',
        FORGE_ADMIN_PASSWORD: ' super-secret ',
        FORGE_COLLABORATION_AUTH_SECRET: ' auth-secret ',
        FORGE_COLLABORATION_BASE_URL: ' https://forge.example.com/collab ',
        FORGE_COLLABORATION_TRUSTED_ORIGINS: ' http://127.0.0.1:47188 , https://app.example.com ',
      },
      () => {
        const config = createConfig()
        expect(config.adminEmail).toBe('admin@example.com')
        expect(config.adminPassword).toBe('super-secret')
        expect(config.collaborationAuthSecret).toBe('auth-secret')
        expect(config.collaborationBaseUrl).toBe('https://forge.example.com/collab')
        expect(config.collaborationTrustedOrigins).toEqual([
          'http://127.0.0.1:47188',
          'https://app.example.com',
        ])
      },
    )
  })

  it('maps legacy collaboration enabled env to collaboration-server only when runtime target is unset', async () => {
    await withEnv({ FORGE_COLLABORATION_ENABLED: 'true' }, () => {
      expect(resolveRuntimeTargetFromEnv()).toBe('collaboration-server')
      expect(createConfig().runtimeTarget).toBe('collaboration-server')
    })

    await withEnv(
      {
        FORGE_RUNTIME_TARGET: 'builder',
        FORGE_COLLABORATION_ENABLED: 'true',
        MIDDLEMAN_COLLABORATION_ENABLED: 'true',
      },
      () => {
        expect(resolveRuntimeTargetFromEnv()).toBe('builder')
        expect(createConfig().runtimeTarget).toBe('builder')
      }
    )
  })

  it('warns and falls back to builder for invalid FORGE_RUNTIME_TARGET values', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await withEnv({ FORGE_RUNTIME_TARGET: 'ship-it' }, () => {
        expect(resolveRuntimeTargetFromEnv()).toBe('builder')
        expect(createConfig().runtimeTarget).toBe('builder')
      })

      expect(warnSpy).toHaveBeenCalledWith(
        '[config] Ignoring invalid FORGE_RUNTIME_TARGET value: ship-it',
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('parses FORGE_DESKTOP as a boolean desktop flag', () => {
    withEnv({ FORGE_DESKTOP: 'true' }, () => {
      const config = createConfig()
      expect(config.isDesktop).toBe(true)
    })

    withEnv({}, () => {
      const config = createConfig()
      expect(config.isDesktop).toBe(false)
    })
  })
})
