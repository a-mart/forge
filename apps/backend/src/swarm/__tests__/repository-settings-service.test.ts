import { access, constants as fsConstants, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getRepositorySettingsPath } from '../data-paths.js'
import {
  RepositorySettingsService,
  RepositorySettingsValidationError,
} from '../repository-settings-service.js'

describe('RepositorySettingsService', () => {
  let dataDir = ''

  afterEach(async () => {
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true })
      dataDir = ''
    }
  })

  it('defaults effective base to home when nothing is configured', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'repo-settings-default-'))
    const home = join(dataDir, 'home')
    await mkdir(home)
    const service = new RepositorySettingsService({ dataDir, homeDir: home })
    await service.load()
    expect(service.getSettings()).toMatchObject({
      configuredHome: null,
      lastUsedBasePath: null,
      effectiveBasePath: home,
      source: 'default',
    })
  })

  it('prefers configured home over last-used and default', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'repo-settings-configured-'))
    const home = join(dataDir, 'home')
    const configured = join(dataDir, 'configured')
    const lastUsed = join(dataDir, 'last-used')
    await mkdir(home)
    await mkdir(configured)
    await mkdir(lastUsed)

    const service = new RepositorySettingsService({ dataDir, homeDir: home })
    await service.load()
    await service.recordLastUsedBasePath(lastUsed)
    expect(service.getSettings().source).toBe('last_used')
    expect(service.getSettings().effectiveBasePath).toBe(await real(lastUsed))

    await service.updateConfiguredHome(configured)
    expect(service.getSettings()).toMatchObject({
      source: 'configured',
      effectiveBasePath: await real(configured),
      lastUsedBasePath: await real(lastUsed),
    })
  })

  it('updates last-used without changing configured home', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'repo-settings-last-used-'))
    const home = join(dataDir, 'home')
    const configured = join(dataDir, 'configured')
    const lastUsed = join(dataDir, 'last-used')
    await mkdir(home)
    await mkdir(configured)
    await mkdir(lastUsed)

    const service = new RepositorySettingsService({ dataDir, homeDir: home })
    await service.updateConfiguredHome(configured)
    await service.recordLastUsedBasePath(lastUsed)

    const settings = service.getSettings()
    expect(settings.configuredHome).toBe(await real(configured))
    expect(settings.lastUsedBasePath).toBe(await real(lastUsed))
    expect(settings.source).toBe('configured')

    const raw = JSON.parse(await readFile(getRepositorySettingsPath(dataDir), 'utf8')) as {
      configuredHome: string
      lastUsedBasePath: string
    }
    expect(raw.configuredHome).toBe(await real(configured))
    expect(raw.lastUsedBasePath).toBe(await real(lastUsed))
  })

  it('rejects non-directory configured homes', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'repo-settings-invalid-'))
    const home = join(dataDir, 'home')
    await mkdir(home)
    const filePath = join(dataDir, 'not-a-dir')
    await writeFile(filePath, 'x', 'utf8')

    const service = new RepositorySettingsService({ dataDir, homeDir: home })
    await expect(service.updateConfiguredHome(filePath)).rejects.toBeInstanceOf(
      RepositorySettingsValidationError,
    )
  })

  it('accepts symlink repository homes via realpath', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'repo-settings-symlink-'))
    const home = join(dataDir, 'home')
    const target = join(dataDir, 'real-home')
    const link = join(dataDir, 'link-home')
    await mkdir(home)
    await mkdir(target)
    try {
      await symlink(target, link, 'dir')
    } catch {
      // Some CI environments disallow symlinks; skip.
      return
    }

    const service = new RepositorySettingsService({ dataDir, homeDir: home })
    const settings = await service.updateConfiguredHome(link)
    expect(settings.configuredHome).toBe(await real(target))
    expect(settings.effectiveBasePath).toBe(await real(target))
  })

  it('serializes concurrent GET reload and PUT so committed state wins', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'repo-settings-race-'))
    const home = join(dataDir, 'home')
    const configuredA = join(dataDir, 'a')
    const configuredB = join(dataDir, 'b')
    await mkdir(home)
    await mkdir(configuredA)
    await mkdir(configuredB)

    const service = new RepositorySettingsService({ dataDir, homeDir: home })
    await service.load()

    const putA = service.updateConfiguredHome(configuredA)
    const getDuring = service.getSettingsAsync()
    const putB = service.updateConfiguredHome(configuredB)

    const [a, mid, b] = await Promise.all([putA, getDuring, putB])
    expect(a.configuredHome).toBe(await real(configuredA))
    expect(b.configuredHome).toBe(await real(configuredB))
    // Mid-flight read must observe a committed value, never a torn write.
    expect([await real(configuredA), await real(configuredB), null]).toContain(mid.configuredHome)
    expect(service.getSettings().configuredHome).toBe(await real(configuredB))

    const raw = JSON.parse(await readFile(getRepositorySettingsPath(dataDir), 'utf8')) as {
      configuredHome: string
    }
    expect(raw.configuredHome).toBe(await real(configuredB))
  })

  it('falls back when the settings file is missing', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'repo-settings-missing-'))
    const home = join(dataDir, 'home')
    await mkdir(home)
    const service = new RepositorySettingsService({ dataDir, homeDir: home })
    await service.load()
    expect(service.getSettings().source).toBe('default')
    await expect(access(getRepositorySettingsPath(dataDir), fsConstants.F_OK)).rejects.toBeTruthy()
  })
})

async function real(pathValue: string): Promise<string> {
  const { realpath } = await import('node:fs/promises')
  return realpath(pathValue)
}
