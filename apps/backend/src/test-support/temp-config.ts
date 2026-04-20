import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { getScheduleFilePath } from '../scheduler/schedule-storage.js'
import { getProfileMemoryPath } from '../swarm/data-paths.js'
import type { AgentModelDescriptor, SwarmConfig } from '../swarm/types.js'
import { getAvailablePort } from './network.js'

const DEFAULT_MODEL: AgentModelDescriptor = {
  provider: 'openai-codex',
  modelId: 'gpt-5.3-codex',
  thinkingLevel: 'medium',
}

export interface TempConfigOptions {
  prefix?: string
  port?: number
  host?: string
  debug?: boolean
  isDesktop?: boolean
  cortexEnabled?: boolean
  allowNonManagerSubscriptions?: boolean
  managerId?: string
  managerDisplayName?: string
  defaultModel?: AgentModelDescriptor
  rootDir?: string
  tempRootDir?: string
  resourcesDir?: string
  defaultCwd?: string
  cwdAllowlistRoots?: string[]
  repoArchetypesDir?: string
  repoMemorySkillFile?: string
  sharedAuthContent?: Record<string, unknown>
  authContent?: Record<string, unknown>
  sharedSecretsContent?: Record<string, unknown>
  secretsContent?: Record<string, unknown>
  agentsStoreContent?: { agents: unknown[]; profiles?: unknown[] }
  /**
   * When set, skips creating `shared/config/auth/auth.json` so callers can exercise
   * legacy auth forward / `ensureCanonicalAuthFilePath` copy behavior (file absent until copy).
   */
  omitSharedAuthFile?: boolean
  /**
   * When set, skips creating `shared/config/secrets.json` so legacy `data/secrets.json` is the
   * first secrets store hit for `readSecretsStoreFromConfig`-style reads.
   */
  omitSharedSecretsFile?: boolean
  /**
   * When set, does not seed `repoMemorySkillFile` with a placeholder — missing file matches
   * older tests that relied on builtin skill discovery instead of a stub repo override.
   */
  skipRepoMemorySkillPlaceholder?: boolean
}

export interface TempConfigHandle {
  config: SwarmConfig
  tempRootDir: string
  cleanup: () => Promise<void>
}

async function ensureJsonFile(path: string, content: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(content, null, 2)}\n`, 'utf8')
}

export async function createTempConfig(options: TempConfigOptions = {}): Promise<TempConfigHandle> {
  const tempRootDir = options.tempRootDir
    ? resolve(options.tempRootDir)
    : await mkdtemp(join(tmpdir(), options.prefix ?? 'forge-test-'))

  const rootDir = resolve(options.rootDir ?? tempRootDir)
  const dataDir = join(tempRootDir, 'data')
  const swarmDir = join(dataDir, 'swarm')
  const sessionsDir = join(dataDir, 'sessions')
  const uploadsDir = join(dataDir, 'uploads')
  const profilesDir = join(dataDir, 'profiles')
  const sharedDir = join(dataDir, 'shared')
  const sharedConfigDir = join(sharedDir, 'config')
  const sharedCacheDir = join(sharedDir, 'cache')
  const sharedStateDir = join(sharedDir, 'state')
  const sharedAuthDir = join(sharedConfigDir, 'auth')
  const sharedAuthFile = join(sharedAuthDir, 'auth.json')
  const sharedSecretsFile = join(sharedConfigDir, 'secrets.json')
  const sharedIntegrationsDir = join(sharedConfigDir, 'integrations')
  const authDir = join(dataDir, 'auth')
  const authFile = join(authDir, 'auth.json')
  const secretsFile = join(dataDir, 'secrets.json')
  const agentDir = join(dataDir, 'agent')
  const managerAgentDir = join(agentDir, 'manager')
  const repoArchetypesDir = resolve(options.repoArchetypesDir ?? join(rootDir, '.swarm', 'archetypes'))
  const memoryDir = join(dataDir, 'memory')
  const managerId = options.managerId ?? 'manager'
  const memoryFile = getProfileMemoryPath(dataDir, managerId)
  const repoMemorySkillFile = resolve(
    options.repoMemorySkillFile ?? join(rootDir, '.swarm', 'skills', 'memory', 'SKILL.md'),
  )

  await Promise.all([
    mkdir(swarmDir, { recursive: true }),
    mkdir(sessionsDir, { recursive: true }),
    mkdir(uploadsDir, { recursive: true }),
    mkdir(profilesDir, { recursive: true }),
    mkdir(sharedAuthDir, { recursive: true }),
    mkdir(sharedIntegrationsDir, { recursive: true }),
    mkdir(sharedCacheDir, { recursive: true }),
    mkdir(sharedStateDir, { recursive: true }),
    mkdir(authDir, { recursive: true }),
    mkdir(memoryDir, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(managerAgentDir, { recursive: true }),
    mkdir(repoArchetypesDir, { recursive: true }),
    mkdir(dirname(repoMemorySkillFile), { recursive: true }),
  ])

  await Promise.all([
    ...(options.omitSharedAuthFile
      ? []
      : [ensureJsonFile(sharedAuthFile, options.sharedAuthContent ?? {})]),
    ensureJsonFile(authFile, options.authContent ?? {}),
    ...(options.omitSharedSecretsFile
      ? []
      : [ensureJsonFile(sharedSecretsFile, options.sharedSecretsContent ?? {})]),
    ensureJsonFile(secretsFile, options.secretsContent ?? {}),
    ensureJsonFile(join(swarmDir, 'agents.json'), options.agentsStoreContent ?? { agents: [] }),
  ])

  if (!options.skipRepoMemorySkillPlaceholder) {
    try {
      await access(repoMemorySkillFile)
    } catch {
      await writeFile(repoMemorySkillFile, '# Memory\n', 'utf8')
    }
  }

  const config: SwarmConfig = {
    host: options.host ?? '127.0.0.1',
    port: options.port ?? (await getAvailablePort(options.host ?? '127.0.0.1')),
    debug: options.debug ?? false,
    isDesktop: options.isDesktop ?? false,
    cortexEnabled: options.cortexEnabled ?? true,
    allowNonManagerSubscriptions: options.allowNonManagerSubscriptions ?? false,
    managerId,
    managerDisplayName: options.managerDisplayName ?? 'Manager',
    defaultModel: options.defaultModel ?? DEFAULT_MODEL,
    defaultCwd: resolve(options.defaultCwd ?? rootDir),
    cwdAllowlistRoots: options.cwdAllowlistRoots?.map((entry) => resolve(entry)) ?? [rootDir, join(rootDir, 'worktrees')],
    paths: {
      rootDir,
      resourcesDir: options.resourcesDir ? resolve(options.resourcesDir) : undefined,
      dataDir,
      swarmDir,
      uploadsDir,
      agentsStoreFile: join(swarmDir, 'agents.json'),
      profilesDir,
      sharedDir,
      sharedConfigDir,
      sharedCacheDir,
      sharedStateDir,
      sharedAuthDir,
      sharedAuthFile,
      sharedSecretsFile,
      sharedIntegrationsDir,
      sessionsDir,
      memoryDir,
      authDir,
      authFile,
      secretsFile,
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      memoryFile,
      repoMemorySkillFile,
      schedulesFile: getScheduleFilePath(dataDir, managerId),
    },
  }

  let cleanedUp = false
  return {
    config,
    tempRootDir,
    cleanup: async () => {
      if (cleanedUp) {
        return
      }
      cleanedUp = true
      await rm(tempRootDir, { recursive: true, force: true })
    },
  }
}

export async function makeTempConfig(options: TempConfigOptions = {}): Promise<SwarmConfig> {
  const handle = await createTempConfig(options)
  return handle.config
}
