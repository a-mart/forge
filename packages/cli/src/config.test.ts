import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  getCliConfigPath,
  loadCurrentDirectoryEnv,
  readCliConfig,
  resolveCliConfig,
  saveCliConfig,
  updateCliConfigValue,
} from './config.js'
import { EXIT_CODES } from './version.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }))
  }))
})

describe('CLI config paths', () => {
  it('uses ~/.forge/cli/config.json on POSIX platforms', () => {
    expect(getCliConfigPath({ platform: 'darwin', homeDir: '/Users/adam' })).toBe('/Users/adam/.forge/cli/config.json')
    expect(getCliConfigPath({ platform: 'linux', homeDir: '/home/adam' })).toBe('/home/adam/.forge/cli/config.json')
  })

  it('uses LOCALAPPDATA on Windows', () => {
    expect(getCliConfigPath({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Adam\\AppData\\Local' }, homeDir: 'C:\\Users\\Adam' })).toBe(
      path.join('C:\\Users\\Adam\\AppData\\Local', 'forge', 'cli', 'config.json'),
    )
  })
})

describe('CLI config resolution', () => {
  it('loads only the current directory .env file', async () => {
    const root = await makeTempDir()
    const child = path.join(root, 'child')
    await mkdir(child)
    await writeFile(path.join(root, '.env'), 'FORGE_URL=http://parent\nFORGE_CLI_API_KEY=parent\n')
    await writeFile(path.join(child, '.env'), 'FORGE_URL="http://child"\nFORGE_CLI_API_KEY=child\n')

    await expect(loadCurrentDirectoryEnv(child)).resolves.toEqual({
      FORGE_URL: 'http://child',
      FORGE_CLI_API_KEY: 'child',
    })
  })

  it('applies flag, process env, cwd .env, then saved config precedence', async () => {
    const root = await makeTempDir()
    const configPath = path.join(root, 'config.json')
    await saveCliConfig({ url: 'http://saved', apiKey: 'saved' }, { configPath })
    await writeFile(path.join(root, '.env'), 'FORGE_URL=http://dotenv\nFORGE_CLI_API_KEY=dotenv\n')

    await expect(resolveCliConfig({ cwd: root, configPath, env: {}, flagUrl: 'http://flag', flagApiKey: 'flag' })).resolves.toMatchObject({
      url: 'http://flag',
      apiKey: 'flag',
      sources: { url: 'flag', apiKey: 'flag' },
    })
    await expect(resolveCliConfig({ cwd: root, configPath, env: { FORGE_URL: 'http://env', FORGE_CLI_API_KEY: 'env' } })).resolves.toMatchObject({
      url: 'http://env',
      apiKey: 'env',
      sources: { url: 'env', apiKey: 'env' },
    })
    await expect(resolveCliConfig({ cwd: root, configPath, env: {} })).resolves.toMatchObject({
      url: 'http://dotenv',
      apiKey: 'dotenv',
      sources: { url: 'dotenv', apiKey: 'dotenv' },
    })
  })

  it('stores local config with restricted POSIX permissions and graceful Windows behavior', async () => {
    const root = await makeTempDir()
    const configPath = path.join(root, 'config.json')
    const posix = await saveCliConfig({ apiKey: 'secret' }, { configPath, platform: 'linux' })
    expect(posix.warnings).toEqual([])
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    await expect(readCliConfig(configPath)).resolves.toMatchObject({ apiKey: 'secret' })

    const windowsPath = path.join(root, 'windows-config.json')
    const windows = await saveCliConfig({ apiKey: 'secret' }, { configPath: windowsPath, platform: 'win32' })
    expect(windows.warnings).toEqual([])
  })

  it('updates and unsets config values', async () => {
    const root = await makeTempDir()
    const configPath = path.join(root, 'config.json')
    await updateCliConfigValue('url', 'http://forge', { configPath })
    await updateCliConfigValue('apiKey', 'key', { configPath })
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({ url: 'http://forge', apiKey: 'key' })
    await updateCliConfigValue('apiKey', undefined, { configPath })
    expect(await readCliConfig(configPath)).toMatchObject({ url: 'http://forge' })
    expect((await readCliConfig(configPath)).apiKey).toBeUndefined()
  })

  it('throws a typed error for invalid config JSON', async () => {
    const root = await makeTempDir()
    const configPath = path.join(root, 'config.json')
    await writeFile(configPath, '{broken')
    await expect(readCliConfig(configPath)).rejects.toMatchObject({
      code: 'invalid_config_json',
      exitCode: EXIT_CODES.usage,
    })
  })
})

async function makeTempDir(): Promise<string> {
  const dir = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'forge-cli-config-')))
  tempDirs.push(dir)
  return dir
}
