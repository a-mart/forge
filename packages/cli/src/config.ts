import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CliError } from './output.js'
import { EXIT_CODES } from './version.js'

export type CliConfigKey = 'url' | 'apiKey'

export interface CliConfigFile {
  url?: string
  apiKey?: string
  updatedAt?: string
}

export interface CliConfigPathOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDir?: string
}

export interface ResolveCliConfigOptions extends CliConfigPathOptions {
  cwd?: string
  flagUrl?: string
  flagApiKey?: string
  configPath?: string
}

export interface ResolvedCliConfig {
  url?: string
  apiKey?: string
  sources: {
    url?: 'flag' | 'env' | 'dotenv' | 'config'
    apiKey?: 'flag' | 'env' | 'dotenv' | 'config'
  }
  configPath: string
}

export interface SaveCliConfigOptions extends CliConfigPathOptions {
  configPath?: string
}

export interface SaveCliConfigResult {
  configPath: string
  warnings: string[]
}

export function getCliConfigPath(options: CliConfigPathOptions = {}): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(options.homeDir ?? os.homedir(), 'AppData', 'Local')
    return path.join(base, 'forge', 'cli', 'config.json')
  }

  return path.join(options.homeDir ?? os.homedir(), '.forge', 'cli', 'config.json')
}

export async function resolveCliConfig(options: ResolveCliConfigOptions = {}): Promise<ResolvedCliConfig> {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const configPath = options.configPath ?? getCliConfigPath(options)
  const [dotenv, saved] = await Promise.all([loadCurrentDirectoryEnv(cwd), readCliConfig(configPath)])

  const url = firstNonEmpty(options.flagUrl, env.FORGE_URL, dotenv.FORGE_URL, saved.url)
  const apiKey = firstNonEmpty(options.flagApiKey, env.FORGE_CLI_API_KEY, dotenv.FORGE_CLI_API_KEY, saved.apiKey)

  return {
    url,
    apiKey,
    configPath,
    sources: {
      url: sourceFor([options.flagUrl, env.FORGE_URL, dotenv.FORGE_URL, saved.url], ['flag', 'env', 'dotenv', 'config']),
      apiKey: sourceFor(
        [options.flagApiKey, env.FORGE_CLI_API_KEY, dotenv.FORGE_CLI_API_KEY, saved.apiKey],
        ['flag', 'env', 'dotenv', 'config'],
      ),
    },
  }
}

export async function readCliConfig(configPath = getCliConfigPath()): Promise<CliConfigFile> {
  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<CliConfigFile>
    return normalizeCliConfig(parsed)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return {}
    if (error instanceof SyntaxError) {
      throw new CliError(`Invalid Forge CLI config JSON at ${configPath}: ${error.message}`, {
        exitCode: EXIT_CODES.usage,
        code: 'invalid_config_json',
      })
    }
    throw error
  }
}

export async function saveCliConfig(config: CliConfigFile, options: SaveCliConfigOptions = {}): Promise<SaveCliConfigResult> {
  const configPath = options.configPath ?? getCliConfigPath(options)
  const platform = options.platform ?? process.platform
  const warnings: string[] = []
  const normalized = normalizeCliConfig({ ...config, updatedAt: new Date().toISOString() })

  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(configPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 })

  if (platform !== 'win32') {
    try {
      await chmod(configPath, 0o600)
    } catch (error) {
      warnings.push(`Could not restrict config file permissions for ${configPath}: ${errorMessage(error)}`)
    }
  }

  return { configPath, warnings }
}

export async function updateCliConfigValue(
  key: CliConfigKey,
  value: string | undefined,
  options: SaveCliConfigOptions = {},
): Promise<SaveCliConfigResult> {
  const configPath = options.configPath ?? getCliConfigPath(options)
  const current = await readCliConfig(configPath)
  if (value === undefined) {
    delete current[key]
  } else {
    current[key] = value
  }
  return saveCliConfig(current, { ...options, configPath })
}

export async function loadCurrentDirectoryEnv(cwd = process.cwd()): Promise<Record<string, string>> {
  const envPath = path.join(cwd, '.env')
  let raw: string
  try {
    raw = await readFile(envPath, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return {}
    throw error
  }

  const result: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
    if (!match) continue
    result[match[1]!] = unquoteEnvValue(match[2] ?? '')
  }
  return result
}

export function normalizeConfigKey(value: string | undefined): CliConfigKey | null {
  if (value === 'url') return 'url'
  if (value === 'apiKey' || value === 'api-key' || value === 'api_key') return 'apiKey'
  return null
}

function normalizeCliConfig(value: Partial<CliConfigFile>): CliConfigFile {
  return {
    ...(nonEmptyString(value.url) ? { url: value.url.trim() } : {}),
    ...(nonEmptyString(value.apiKey) ? { apiKey: value.apiKey.trim() } : {}),
    ...(nonEmptyString(value.updatedAt) ? { updatedAt: value.updatedAt } : {}),
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find(nonEmptyString)?.trim()
}

function sourceFor<T extends string>(values: Array<string | undefined>, labels: T[]): T | undefined {
  const index = values.findIndex(nonEmptyString)
  return index >= 0 ? labels[index] : undefined
}

function nonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
