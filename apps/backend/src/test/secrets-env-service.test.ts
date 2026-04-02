import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuthStorage } from '@mariozechner/pi-coding-agent'
import {
  getManagedModelProviderCredentialAvailability,
  SecretsEnvService,
} from '../swarm/secrets-env-service.js'
import type { SwarmConfig } from '../swarm/types.js'

interface TestPaths {
  sharedDir: string
  sharedAuthFile: string
  sharedSecretsFile: string
  oldSharedAuthFile: string
  oldSharedSecretsFile: string
  authFile: string
  secretsFile: string
}

function buildPaths(root: string): TestPaths {
  const sharedDir = join(root, 'shared')
  return {
    sharedDir,
    sharedAuthFile: join(sharedDir, 'config', 'auth', 'auth.json'),
    sharedSecretsFile: join(sharedDir, 'config', 'secrets.json'),
    oldSharedAuthFile: join(sharedDir, 'auth', 'auth.json'),
    oldSharedSecretsFile: join(sharedDir, 'secrets.json'),
    authFile: join(root, 'auth', 'auth.json'),
    secretsFile: join(root, 'secrets.json'),
  }
}

function createConfig(paths: TestPaths): SwarmConfig {
  return {
    paths: {
      sharedDir: paths.sharedDir,
      sharedAuthFile: paths.sharedAuthFile,
      sharedSecretsFile: paths.sharedSecretsFile,
      authFile: paths.authFile,
      secretsFile: paths.secretsFile,
    },
  } as unknown as SwarmConfig
}

function createService(paths: TestPaths): SecretsEnvService {
  return new SecretsEnvService({
    config: createConfig(paths),
    ensureSkillMetadataLoaded: async () => undefined,
    getSkillMetadata: () => [],
  })
}

describe('SecretsEnvService path migration', () => {
  it('reads legacy flat-root secrets when canonical secrets are missing, then writes to the canonical path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'secrets-env-service-legacy-secrets-'))
    const paths = buildPaths(root)

    const previousBrave = process.env.BRAVE_API_KEY
    const previousGemini = process.env.GEMINI_API_KEY
    delete process.env.BRAVE_API_KEY
    delete process.env.GEMINI_API_KEY

    try {
      await writeFile(
        paths.secretsFile,
        JSON.stringify({ BRAVE_API_KEY: 'legacy-brave-value' }, null, 2),
        'utf8',
      )

      const service = createService(paths)
      await service.loadSecretsStore()
      expect(process.env.BRAVE_API_KEY).toBe('legacy-brave-value')

      await service.updateSettingsEnv({ GEMINI_API_KEY: 'new-gemini-value' })

      const storedCanonicalSecrets = JSON.parse(
        await readFile(paths.sharedSecretsFile, 'utf8'),
      ) as Record<string, string>

      expect(storedCanonicalSecrets).toEqual({
        BRAVE_API_KEY: 'legacy-brave-value',
        GEMINI_API_KEY: 'new-gemini-value',
      })
    } finally {
      if (previousBrave === undefined) {
        delete process.env.BRAVE_API_KEY
      } else {
        process.env.BRAVE_API_KEY = previousBrave
      }

      if (previousGemini === undefined) {
        delete process.env.GEMINI_API_KEY
      } else {
        process.env.GEMINI_API_KEY = previousGemini
      }
    }
  })

  it('reads old shared-flat secrets when canonical secrets are missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'secrets-env-service-old-shared-secrets-'))
    const paths = buildPaths(root)

    const previousXai = process.env.XAI_API_KEY
    delete process.env.XAI_API_KEY

    try {
      await mkdir(join(root, 'shared'), { recursive: true })
      await writeFile(
        paths.oldSharedSecretsFile,
        JSON.stringify({ XAI_API_KEY: 'old-shared-xai-value' }, null, 2),
        'utf8',
      )

      const service = createService(paths)
      await service.loadSecretsStore()

      expect(process.env.XAI_API_KEY).toBe('old-shared-xai-value')

      await service.updateSettingsEnv({ BRAVE_API_KEY: 'new-brave-value' })
      const storedCanonicalSecrets = JSON.parse(
        await readFile(paths.sharedSecretsFile, 'utf8'),
      ) as Record<string, string>

      expect(storedCanonicalSecrets).toEqual({
        XAI_API_KEY: 'old-shared-xai-value',
        BRAVE_API_KEY: 'new-brave-value',
      })
    } finally {
      if (previousXai === undefined) {
        delete process.env.XAI_API_KEY
      } else {
        process.env.XAI_API_KEY = previousXai
      }

      delete process.env.BRAVE_API_KEY
    }
  })

  it('reads old shared-flat auth when canonical auth is missing, then writes updated auth to the canonical path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'secrets-env-service-old-shared-auth-'))
    const paths = buildPaths(root)

    await mkdir(join(root, 'shared', 'auth'), { recursive: true })

    const oldSharedAuthStorage = AuthStorage.create(paths.oldSharedAuthFile)
    oldSharedAuthStorage.set('anthropic', {
      type: 'api_key',
      key: 'old-shared-anthropic-key',
      access: 'old-shared-anthropic-key',
      refresh: '',
      expires: '',
    } as any)

    const service = createService(paths)

    const initialProviders = await service.listSettingsAuth()
    expect(initialProviders.find((provider) => provider.provider === 'anthropic')?.configured).toBe(true)

    await service.updateSettingsAuth({ 'openai-codex': 'new-openai-key' })

    const canonicalAuthStorage = AuthStorage.create(paths.sharedAuthFile)
    const anthropic = canonicalAuthStorage.get('anthropic')
    const openai = canonicalAuthStorage.get('openai-codex')

    expect((anthropic as any)?.key ?? (anthropic as any)?.access).toBe('old-shared-anthropic-key')
    expect((openai as any)?.key ?? (openai as any)?.access).toBe('new-openai-key')
  })

  it('reports managed model provider availability from canonical secrets/auth plus process env fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'secrets-env-service-availability-test-'))
    const paths = buildPaths(root)

    await mkdir(join(root, 'shared', 'config', 'auth'), { recursive: true })
    await writeFile(paths.sharedSecretsFile, JSON.stringify({ XAI_API_KEY: 'xai-secret-key' }, null, 2), 'utf8')

    const sharedAuthStorage = AuthStorage.create(paths.sharedAuthFile)
    sharedAuthStorage.set('openai-codex', {
      type: 'api_key',
      key: 'sk-openai-secret',
      access: 'sk-openai-secret',
      refresh: '',
      expires: '',
    } as any)

    const previousAnthropic = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY

    try {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-secret'

      const availability = await getManagedModelProviderCredentialAvailability(createConfig(paths))

      expect(availability.get('openai-codex')).toBe(true)
      expect(availability.get('xai')).toBe(true)
      expect(availability.get('anthropic')).toBe(true)
    } finally {
      if (previousAnthropic === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropic
      }
    }
  })
})
