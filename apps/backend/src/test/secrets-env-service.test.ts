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
  sharedAuthDir: string
  sharedAuthFile: string
  sharedSecretsFile: string
  authFile: string
  secretsFile: string
}

function buildPaths(root: string): TestPaths {
  const sharedDir = join(root, 'shared')
  const sharedAuthDir = join(sharedDir, 'config', 'auth')
  return {
    sharedDir,
    sharedAuthDir,
    sharedAuthFile: join(sharedAuthDir, 'auth.json'),
    sharedSecretsFile: join(sharedDir, 'config', 'secrets.json'),
    authFile: join(root, 'auth', 'auth.json'),
    secretsFile: join(root, 'secrets.json'),
  }
}

function createConfig(paths: TestPaths): SwarmConfig {
  return {
    paths: {
      sharedDir: paths.sharedDir,
      sharedAuthDir: paths.sharedAuthDir,
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

function makeOAuthCredential(accessToken = 'anthropic-oauth-token') {
  return {
    type: 'oauth',
    access: accessToken,
    refresh: 'refresh-token',
    expires: new Date(Date.now() + 60_000).toISOString(),
  } as any
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

  it('reads legacy flat-root auth when canonical auth is missing, then writes updated auth to the canonical path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'secrets-env-service-legacy-auth-'))
    const paths = buildPaths(root)

    await mkdir(join(root, 'auth'), { recursive: true })

    const legacyAuthStorage = AuthStorage.create(paths.authFile)
    legacyAuthStorage.set('anthropic', {
      type: 'api_key',
      key: 'legacy-anthropic-key',
      access: 'legacy-anthropic-key',
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

    expect((anthropic as any)?.key ?? (anthropic as any)?.access).toBe('legacy-anthropic-key')
    expect((openai as any)?.key ?? (openai as any)?.access).toBe('new-openai-key')
  })

  it('rejects setting an Anthropic API key while pooled Anthropic OAuth accounts exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'secrets-env-service-pooled-anthropic-'))
    const paths = buildPaths(root)
    const service = createService(paths)

    await mkdir(join(root, 'shared', 'config', 'auth'), { recursive: true })
    await service.getCredentialPoolService().addCredential('anthropic', makeOAuthCredential(), {
      label: 'Anthropic OAuth Account',
    })

    await expect(service.updateSettingsAuth({ anthropic: 'sk-ant-api-key' })).rejects.toThrow(
      'Remove pooled accounts before setting an API key',
    )

    const authStorage = AuthStorage.create(paths.sharedAuthFile)
    expect((authStorage.get('anthropic') as any)?.access).toBe('anthropic-oauth-token')

    const pool = await service.getCredentialPoolService().listPool('anthropic')
    expect(pool.credentials).toHaveLength(1)
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
    const previousOpenRouter = process.env.OPENROUTER_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENROUTER_API_KEY

    try {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-secret'
      process.env.OPENROUTER_API_KEY = 'sk-or-v1-secret'

      const availability = await getManagedModelProviderCredentialAvailability(createConfig(paths))

      expect(availability.get('openai-codex')).toBe(true)
      expect(availability.get('xai')).toBe(true)
      expect(availability.get('anthropic')).toBe(true)
      expect(availability.get('openrouter')).toBe(true)
    } finally {
      if (previousAnthropic === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropic
      }

      if (previousOpenRouter === undefined) {
        delete process.env.OPENROUTER_API_KEY
      } else {
        process.env.OPENROUTER_API_KEY = previousOpenRouter
      }
    }
  })
})
