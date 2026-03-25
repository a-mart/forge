import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withPlatform } from './test-helpers.js'

const MANAGED_ENV_KEYS = [
  'FORGE_DATA_DIR',
  'MIDDLEMAN_DATA_DIR',
  'FORGE_DAEMONIZED',
  'MIDDLEMAN_DAEMONIZED',
  'FORGE_DESKTOP',
  'LOCALAPPDATA',
] as const

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

async function withEnv(
  overrides: Partial<Record<(typeof MANAGED_ENV_KEYS)[number], string | undefined>>,
  run: () => Promise<void> | void,
): Promise<void> {
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

async function loadMigrationModule(fakeHome: string): Promise<typeof import('../startup-migration.js')> {
  vi.resetModules()
  vi.doMock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>()
    return {
      ...actual,
      homedir: () => fakeHome,
    }
  })

  return await import('../startup-migration.js')
}

function withTTY(
  stdinTTY: boolean,
  stdoutTTY: boolean,
  run: () => Promise<void> | void,
): Promise<void> {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

  Object.defineProperty(process.stdin, 'isTTY', { value: stdinTTY, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTTY, configurable: true })

  return Promise.resolve()
    .then(run)
    .finally(() => {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor)
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor)
      }
    })
}

describe('checkDataDirMigration', () => {
  it('does not prompt when new data dir already exists', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'startup-migration-home-'))
    await mkdir(resolve(fakeHome, '.forge'), { recursive: true })
    await mkdir(resolve(fakeHome, '.middleman'), { recursive: true })

    try {
      const prompt = vi.fn(async () => true)
      const { checkDataDirMigration } = await loadMigrationModule(fakeHome)

      await withEnv({}, async () => {
        await withTTY(true, true, async () => {
          await checkDataDirMigration({ prompt })
        })
      })

      expect(prompt).not.toHaveBeenCalled()
      expect(process.env.FORGE_DATA_DIR).toBeUndefined()
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  it('skips migration when FORGE_DATA_DIR is explicitly set', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'startup-migration-home-'))
    await mkdir(resolve(fakeHome, '.middleman'), { recursive: true })

    try {
      const prompt = vi.fn(async () => true)
      const { checkDataDirMigration } = await loadMigrationModule(fakeHome)

      await withEnv({ FORGE_DATA_DIR: '/tmp/custom-forge' }, async () => {
        await withTTY(true, true, async () => {
          await checkDataDirMigration({ prompt })
        })
      })

      expect(prompt).not.toHaveBeenCalled()
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  it('skips migration when MIDDLEMAN_DATA_DIR is explicitly set', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'startup-migration-home-'))
    await mkdir(resolve(fakeHome, '.middleman'), { recursive: true })

    try {
      const prompt = vi.fn(async () => true)
      const { checkDataDirMigration } = await loadMigrationModule(fakeHome)

      await withEnv({ MIDDLEMAN_DATA_DIR: '/tmp/custom-middleman' }, async () => {
        await withTTY(true, true, async () => {
          await checkDataDirMigration({ prompt })
        })
      })

      expect(prompt).not.toHaveBeenCalled()
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  it('skips prompt in non-TTY mode and pins legacy path', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'startup-migration-home-'))
    const legacyPath = resolve(fakeHome, '.middleman')
    await mkdir(legacyPath, { recursive: true })

    try {
      const prompt = vi.fn(async () => true)
      const { checkDataDirMigration } = await loadMigrationModule(fakeHome)

      await withEnv({}, async () => {
        await withTTY(false, false, async () => {
          await checkDataDirMigration({ prompt })
          expect(process.env.FORGE_DATA_DIR).toBe(legacyPath)
        })
      })

      expect(prompt).not.toHaveBeenCalled()
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  it('skips prompt in daemon mode and pins legacy path', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'startup-migration-home-'))
    const legacyPath = resolve(fakeHome, '.middleman')
    await mkdir(legacyPath, { recursive: true })

    try {
      const prompt = vi.fn(async () => true)
      const { checkDataDirMigration } = await loadMigrationModule(fakeHome)

      await withEnv({ FORGE_DAEMONIZED: '1' }, async () => {
        await withTTY(true, true, async () => {
          await checkDataDirMigration({ prompt })
          expect(process.env.FORGE_DATA_DIR).toBe(legacyPath)
        })
      })

      expect(prompt).not.toHaveBeenCalled()
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  it('auto-migrates when FORGE_DESKTOP=1 even without TTY or explicit confirmation', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'startup-migration-home-desktop-'))
    const legacyPath = resolve(fakeHome, '.middleman')
    await mkdir(legacyPath, { recursive: true })

    try {
      const prompt = vi.fn(async () => false)
      const { checkDataDirMigration } = await loadMigrationModule(fakeHome)

      await withEnv({ FORGE_DESKTOP: '1' }, async () => {
        await withTTY(false, false, async () => {
          await checkDataDirMigration({ isDesktop: true, prompt })
          expect(process.env.FORGE_DATA_DIR).toBe(resolve(fakeHome, '.forge'))
        })
      })

      expect(prompt).not.toHaveBeenCalled()
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  it('uses LOCALAPPDATA/middleman on win32 when that is the only legacy dir', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'startup-migration-win-home-'))
    const localAppData = await mkdtemp(join(tmpdir(), 'startup-migration-win-appdata-'))
    const windowsLegacy = resolve(localAppData, 'middleman')
    await mkdir(windowsLegacy, { recursive: true })

    try {
      const prompt = vi.fn(async () => true)
      const { checkDataDirMigration } = await loadMigrationModule(fakeHome)

      await withPlatform('win32', async () => {
        await withEnv({ LOCALAPPDATA: localAppData }, async () => {
          await withTTY(false, false, async () => {
            await checkDataDirMigration({ prompt })
            expect(process.env.FORGE_DATA_DIR).toBe(windowsLegacy)
          })
        })
      })

      expect(prompt).not.toHaveBeenCalled()
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
      await rm(localAppData, { recursive: true, force: true })
    }
  })

  it('uses ~/.middleman on win32 when appdata legacy dir is absent', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'startup-migration-win-home-'))
    const homeLegacy = resolve(fakeHome, '.middleman')
    const localAppData = await mkdtemp(join(tmpdir(), 'startup-migration-win-appdata-'))
    await mkdir(homeLegacy, { recursive: true })

    try {
      const prompt = vi.fn(async (question: string) => {
        expect(question).toContain(homeLegacy)
        return false
      })
      const { checkDataDirMigration } = await loadMigrationModule(fakeHome)

      await withPlatform('win32', async () => {
        await withEnv({ LOCALAPPDATA: localAppData }, async () => {
          await withTTY(true, true, async () => {
            await checkDataDirMigration({ prompt })
            expect(process.env.FORGE_DATA_DIR).toBe(homeLegacy)
          })
        })
      })

      expect(prompt).toHaveBeenCalledTimes(1)
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
      await rm(localAppData, { recursive: true, force: true })
    }
  })

  it('prefers LOCALAPPDATA/middleman over ~/.middleman on win32 when both exist', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'startup-migration-win-home-'))
    const homeLegacy = resolve(fakeHome, '.middleman')
    const localAppData = await mkdtemp(join(tmpdir(), 'startup-migration-win-appdata-'))
    const windowsLegacy = resolve(localAppData, 'middleman')
    await mkdir(homeLegacy, { recursive: true })
    await mkdir(windowsLegacy, { recursive: true })

    try {
      const prompt = vi.fn(async (question: string) => {
        expect(question).toContain(windowsLegacy)
        expect(question).not.toContain(homeLegacy)
        return false
      })
      const { checkDataDirMigration } = await loadMigrationModule(fakeHome)

      await withPlatform('win32', async () => {
        await withEnv({ LOCALAPPDATA: localAppData }, async () => {
          await withTTY(true, true, async () => {
            await checkDataDirMigration({ prompt })
            expect(process.env.FORGE_DATA_DIR).toBe(windowsLegacy)
          })
        })
      })

      expect(prompt).toHaveBeenCalledTimes(1)
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
      await rm(localAppData, { recursive: true, force: true })
    }
  })

  it('falls back to ~/.middleman in no-TTY win32 mode when appdata legacy dir is absent', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'startup-migration-win-home-'))
    const homeLegacy = resolve(fakeHome, '.middleman')
    const localAppData = await mkdtemp(join(tmpdir(), 'startup-migration-win-appdata-'))
    await mkdir(homeLegacy, { recursive: true })

    try {
      const prompt = vi.fn(async () => true)
      const { checkDataDirMigration } = await loadMigrationModule(fakeHome)

      await withPlatform('win32', async () => {
        await withEnv({ LOCALAPPDATA: localAppData }, async () => {
          await withTTY(false, false, async () => {
            await checkDataDirMigration({ prompt })
            expect(process.env.FORGE_DATA_DIR).toBe(homeLegacy)
          })
        })
      })

      expect(prompt).not.toHaveBeenCalled()
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
      await rm(localAppData, { recursive: true, force: true })
    }
  })
})
