import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createConfig, readPlaywrightDashboardEnvOverride } from '../config.js'
import { withPlatform } from './test-helpers.js'

const MANAGED_ENV_KEYS = [
  'NODE_ENV',
  'SWARM_ROOT_DIR',
  'SWARM_DATA_DIR',
  'SWARM_AUTH_FILE',
  'SWARM_HOST',
  'SWARM_PORT',
  'MIDDLEMAN_HOST',
  'MIDDLEMAN_PORT',
  'MIDDLEMAN_DATA_DIR',
  'MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED',
  'LOCALAPPDATA',
  'SWARM_DEBUG',
  'SWARM_ALLOW_NON_MANAGER_SUBSCRIPTIONS',
  'SWARM_MANAGER_ID',
  'SWARM_DEFAULT_CWD',
  'SWARM_MODEL_PROVIDER',
  'SWARM_MODEL_ID',
  'SWARM_THINKING_LEVEL',
  'SWARM_CWD_ALLOWLIST_ROOTS',
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
  const legacyPath = resolve(homedir(), '.middleman')
  if (platform !== 'win32') {
    return legacyPath
  }

  const localAppDataBase = process.env.LOCALAPPDATA?.trim()
    ? resolve(process.env.LOCALAPPDATA)
    : resolve(homedir(), 'AppData', 'Local')
  const windowsDefault = resolve(localAppDataBase, 'middleman')

  if (!existsSync(windowsDefault) && existsSync(legacyPath)) {
    return legacyPath
  }

  return windowsDefault
}

describe('createConfig', () => {
  it('uses fixed defaults for non-host/port config', async () => {
    await withEnv({}, () => {
      const config = createConfig()
      const dataDir = expectedDefaultDataDir(process.platform)

      expect(config.host).toBe('127.0.0.1')
      expect(config.port).toBe(47187)
      expect(config.debug).toBe(true)
      expect(config.allowNonManagerSubscriptions).toBe(true)
      expect(config.managerId).toBeUndefined()
      expect(config.defaultModel).toEqual({
        provider: 'openai-codex',
        modelId: 'gpt-5.3-codex',
        thinkingLevel: 'xhigh',
      })

      expect(config.paths.dataDir).toBe(dataDir)
      expect(config.paths.swarmDir).toBe(resolve(dataDir, 'swarm'))
      expect(config.paths.sessionsDir).toBe(resolve(dataDir, 'sessions'))
      expect(config.paths.uploadsDir).toBe(resolve(dataDir, 'uploads'))
      expect(config.paths.profilesDir).toBe(resolve(dataDir, 'profiles'))
      expect(config.paths.sharedDir).toBe(resolve(dataDir, 'shared'))
      expect(config.paths.sharedAuthDir).toBe(resolve(dataDir, 'shared', 'auth'))
      expect(config.paths.sharedAuthFile).toBe(resolve(dataDir, 'shared', 'auth', 'auth.json'))
      expect(config.paths.sharedSecretsFile).toBe(resolve(dataDir, 'shared', 'secrets.json'))
      expect(config.paths.sharedIntegrationsDir).toBe(resolve(dataDir, 'shared', 'integrations'))
      expect(config.paths.authDir).toBe(resolve(dataDir, 'auth'))
      expect(config.paths.authFile).toBe(resolve(dataDir, 'auth', 'auth.json'))
      expect(config.paths.managerAgentDir).toBe(resolve(dataDir, 'agent', 'manager'))
      expect(config.paths.repoArchetypesDir).toBe(resolve(config.paths.rootDir, '.swarm', 'archetypes'))
      expect(config.paths.memoryDir).toBe(resolve(dataDir, 'memory'))
      expect(config.paths.memoryFile).toBeUndefined()
      expect(config.paths.repoMemorySkillFile).toBe(resolve(config.paths.rootDir, '.swarm', 'skills', 'memory', 'SKILL.md'))
      expect(config.paths.agentsStoreFile).toBe(resolve(dataDir, 'swarm', 'agents.json'))
      expect(config.paths.secretsFile).toBe(resolve(dataDir, 'secrets.json'))
      expect(config.paths.schedulesFile).toBeUndefined()

      expect(config.defaultCwd).toBe(config.paths.rootDir)
      expect(config.cwdAllowlistRoots).toContain(config.paths.rootDir)
      expect(config.cwdAllowlistRoots).toContain(resolve(homedir(), 'worktrees'))
    })
  })

  it('respects MIDDLEMAN_HOST and MIDDLEMAN_PORT', async () => {
    await withEnv({ MIDDLEMAN_HOST: '0.0.0.0', MIDDLEMAN_PORT: '9999' }, () => {
      const config = createConfig()
      expect(config.host).toBe('0.0.0.0')
      expect(config.port).toBe(9999)
    })
  })

  it('respects MIDDLEMAN_DATA_DIR', async () => {
    const dataDir = join(tmpdir(), 'middleman-data')

    await withEnv({ MIDDLEMAN_DATA_DIR: dataDir }, () => {
      const config = createConfig()
      expect(config.paths.dataDir).toBe(dataDir)
      expect(config.paths.swarmDir).toBe(resolve(dataDir, 'swarm'))
      expect(config.paths.profilesDir).toBe(resolve(dataDir, 'profiles'))
      expect(config.paths.sharedDir).toBe(resolve(dataDir, 'shared'))
      expect(config.paths.sharedAuthFile).toBe(resolve(dataDir, 'shared', 'auth', 'auth.json'))
      expect(config.paths.sharedSecretsFile).toBe(resolve(dataDir, 'shared', 'secrets.json'))
      expect(config.paths.sessionsDir).toBe(resolve(dataDir, 'sessions'))
      expect(config.paths.authFile).toBe(resolve(dataDir, 'auth', 'auth.json'))
    })
  })

  it('uses LOCALAPPDATA/middleman by default on mocked win32 when available', async () => {
    const localAppData = await mkdtemp(join(tmpdir(), 'middleman-localappdata-'))
    const windowsDefault = resolve(localAppData, 'middleman')
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

  it('falls back to legacy ~/.middleman on win32 when LOCALAPPDATA/middleman is absent', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'middleman-home-'))
    const legacyPath = resolve(fakeHome, '.middleman')
    const localAppData = await mkdtemp(join(tmpdir(), 'middleman-localappdata-'))
    const windowsDefault = resolve(localAppData, 'middleman')
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
            expect(windowsDefault).not.toBe(legacyPath)
            expect(warnSpy).toHaveBeenCalledWith(
              `[config] Using legacy data dir ${legacyPath} on Windows. Set MIDDLEMAN_DATA_DIR or migrate to ${windowsDefault}.`
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

  it('ignores removed SWARM_* env vars', async () => {
    await withEnv(
      {
        NODE_ENV: 'development',
        SWARM_ROOT_DIR: '/tmp/swarm-root',
        SWARM_DATA_DIR: '/tmp/swarm-data',
        SWARM_AUTH_FILE: '/tmp/swarm-auth/auth.json',
        SWARM_DEBUG: 'false',
        SWARM_ALLOW_NON_MANAGER_SUBSCRIPTIONS: 'false',
        SWARM_MANAGER_ID: 'opus-manager',
        SWARM_DEFAULT_CWD: '/tmp/swarm-cwd',
        SWARM_MODEL_PROVIDER: 'anthropic',
        SWARM_MODEL_ID: 'claude-opus-4-6',
        SWARM_THINKING_LEVEL: 'low',
        SWARM_CWD_ALLOWLIST_ROOTS: '/tmp/swarm-allowlist',
      },
      () => {
        const config = createConfig()

        expect(config.paths.dataDir).toBe(expectedDefaultDataDir(process.platform))
        expect(config.paths.authFile).toBe(resolve(expectedDefaultDataDir(process.platform), 'auth', 'auth.json'))
        expect(config.debug).toBe(true)
        expect(config.allowNonManagerSubscriptions).toBe(true)
        expect(config.managerId).toBeUndefined()
        expect(config.defaultCwd).toBe(config.paths.rootDir)
        expect(config.defaultModel).toEqual({
          provider: 'openai-codex',
          modelId: 'gpt-5.3-codex',
          thinkingLevel: 'xhigh',
        })
        expect(config.cwdAllowlistRoots).not.toContain('/tmp/swarm-allowlist')
      }
    )
  })

  it('parses Playwright Dashboard env override values', async () => {
    await withEnv({ MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED: 'yes' }, () => {
      expect(readPlaywrightDashboardEnvOverride()).toBe(true)
    })

    await withEnv({ MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED: 'off' }, () => {
      expect(readPlaywrightDashboardEnvOverride()).toBe(false)
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await withEnv({ MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED: 'maybe' }, () => {
        expect(readPlaywrightDashboardEnvOverride()).toBeUndefined()
      })
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})
