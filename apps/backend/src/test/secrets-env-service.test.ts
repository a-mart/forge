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

function createService(paths: {
  sharedAuthFile: string
  sharedSecretsFile: string
  authFile: string
  secretsFile: string
}): SecretsEnvService {
  const config = {
    paths: {
      sharedAuthFile: paths.sharedAuthFile,
      sharedSecretsFile: paths.sharedSecretsFile,
      authFile: paths.authFile,
      secretsFile: paths.secretsFile,
    },
  } as unknown as SwarmConfig

  return new SecretsEnvService({
    config,
    ensureSkillMetadataLoaded: async () => undefined,
    getSkillMetadata: () => [],
  })
}

describe('SecretsEnvService path migration', () => {
  it('reads legacy secrets when shared secrets are missing, then writes to shared path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'secrets-env-service-test-'))
    const sharedSecretsFile = join(root, 'shared', 'secrets.json')
    const legacySecretsFile = join(root, 'secrets.json')
    const sharedAuthFile = join(root, 'shared', 'auth', 'auth.json')
    const legacyAuthFile = join(root, 'auth', 'auth.json')

    const previousBrave = process.env.BRAVE_API_KEY
    const previousGemini = process.env.GEMINI_API_KEY
    delete process.env.BRAVE_API_KEY
    delete process.env.GEMINI_API_KEY

    try {
      await writeFile(
        legacySecretsFile,
        JSON.stringify({ BRAVE_API_KEY: 'legacy-brave-value' }, null, 2),
        'utf8',
      )

      const service = createService({
        sharedAuthFile,
        sharedSecretsFile,
        authFile: legacyAuthFile,
        secretsFile: legacySecretsFile,
      })

      await service.loadSecretsStore()
      expect(process.env.BRAVE_API_KEY).toBe('legacy-brave-value')

      await service.updateSettingsEnv({ GEMINI_API_KEY: 'new-gemini-value' })

      const storedSharedSecrets = JSON.parse(
        await readFile(sharedSecretsFile, 'utf8'),
      ) as Record<string, string>

      expect(storedSharedSecrets).toEqual({
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

  it('reads legacy auth when shared auth is missing, then writes updated auth to shared path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'secrets-env-service-auth-test-'))
    const sharedSecretsFile = join(root, 'shared', 'secrets.json')
    const legacySecretsFile = join(root, 'secrets.json')
    const sharedAuthFile = join(root, 'shared', 'auth', 'auth.json')
    const legacyAuthFile = join(root, 'auth', 'auth.json')

    await mkdir(join(root, 'auth'), { recursive: true })

    const legacyAuthStorage = AuthStorage.create(legacyAuthFile)
    legacyAuthStorage.set('anthropic', {
      type: 'api_key',
      key: 'legacy-anthropic-key',
      access: 'legacy-anthropic-key',
      refresh: '',
      expires: '',
    } as any)

    const service = createService({
      sharedAuthFile,
      sharedSecretsFile,
      authFile: legacyAuthFile,
      secretsFile: legacySecretsFile,
    })

    const initialProviders = await service.listSettingsAuth()
    expect(initialProviders.find((provider) => provider.provider === 'anthropic')?.configured).toBe(true)

    await service.updateSettingsAuth({ 'openai-codex': 'new-openai-key' })

    const sharedAuthStorage = AuthStorage.create(sharedAuthFile)
    const legacyAuthAfterUpdate = AuthStorage.create(legacyAuthFile)
    const anthropic = sharedAuthStorage.get('anthropic')
    const openai = sharedAuthStorage.get('openai-codex')
    const legacyOpenai = legacyAuthAfterUpdate.get('openai-codex')

    expect((anthropic as any)?.key ?? (anthropic as any)?.access).toBe('legacy-anthropic-key')
    expect((openai as any)?.key ?? (openai as any)?.access).toBe('new-openai-key')
    expect((legacyOpenai as any)?.key ?? (legacyOpenai as any)?.access).toBe('new-openai-key')

    await service.deleteSettingsAuth('openai-codex')

    const sharedAuthAfterDelete = AuthStorage.create(sharedAuthFile)
    const legacyAuthAfterDelete = AuthStorage.create(legacyAuthFile)
    const sharedOpenaiAfterDelete = sharedAuthAfterDelete.get('openai-codex')
    const legacyOpenaiAfterDelete = legacyAuthAfterDelete.get('openai-codex')

    expect(sharedOpenaiAfterDelete).toBeUndefined()
    expect(legacyOpenaiAfterDelete).toBeUndefined()
  })

  it('reports managed model provider availability from stored env, auth, and process env', async () => {
    const root = await mkdtemp(join(tmpdir(), 'secrets-env-service-availability-test-'))
    const sharedSecretsFile = join(root, 'shared', 'secrets.json')
    const legacySecretsFile = join(root, 'secrets.json')
    const sharedAuthFile = join(root, 'shared', 'auth', 'auth.json')
    const legacyAuthFile = join(root, 'auth', 'auth.json')

    await mkdir(join(root, 'shared', 'auth'), { recursive: true })
    await writeFile(sharedSecretsFile, JSON.stringify({ XAI_API_KEY: 'xai-secret-key' }, null, 2), 'utf8')

    const sharedAuthStorage = AuthStorage.create(sharedAuthFile)
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

      const config = {
        paths: {
          sharedAuthFile,
          sharedSecretsFile,
          authFile: legacyAuthFile,
          secretsFile: legacySecretsFile,
        },
      } as unknown as SwarmConfig

      const availability = await getManagedModelProviderCredentialAvailability(config)

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
