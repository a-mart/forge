import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuthStorage } from '@mariozechner/pi-coding-agent'
import type { StatsSnapshot } from '@forge/protocol'
import {
  assembleFullPayload,
  emptyFeatureAdoption,
  extractAuthMethodsConfigured,
  extractProvidersUsed,
} from '../telemetry-payload.js'
import type { SwarmConfig } from '../../swarm/types.js'

function createStatsSnapshot(): StatsSnapshot {
  return {
    computedAt: '2026-04-01T00:00:00.000Z',
    uptimeMs: 123_000,
    tokens: {
      today: 10,
      yesterday: 20,
      todayDate: 'Apr 1',
      todayInputTokens: 6,
      todayOutputTokens: 4,
      last7Days: 70,
      last7DaysAvgPerDay: 10,
      last30Days: 300,
      allTime: 900,
    },
    cache: {
      hitRate: 42.5,
      hitRatePeriod: 'All time',
      cachedTokensSaved: 123,
    },
    workers: {
      totalWorkersRun: 12,
      totalWorkersRunPeriod: 'All time',
      averageTokensPerRun: 75,
      averageRuntimeMs: 900,
      currentlyActive: 1,
    },
    code: {
      linesAdded: 456,
      linesDeleted: 78,
      commits: 9,
      repos: 1,
    },
    sessions: {
      totalSessions: 5,
      activeSessions: 2,
      totalMessagesSent: 99,
      totalMessagesPeriod: 'All time',
    },
    activity: {
      longestStreak: 7,
      streakLabel: 'Across current usage range',
      activeDays: 11,
      activeDaysInRange: 11,
      totalDaysInRange: 30,
      peakDay: 'Apr 1',
      peakDayTokens: 100,
    },
    models: [
      {
        modelId: 'gpt-5.4',
        displayName: 'GPT-5.4',
        percentage: 60,
        tokenCount: 600,
      },
      {
        modelId: 'claude-sonnet-4-5',
        displayName: 'Claude Sonnet 4.5',
        percentage: 40,
        tokenCount: 400,
      },
    ],
    dailyUsage: [],
    providers: {
      anthropic: {
        provider: 'anthropic',
        available: false,
        error: 'No subscription data available',
      },
      openai: {
        provider: 'openai',
        available: false,
        error: 'No subscription data available',
      },
    },
    system: {
      uptimeFormatted: '2m',
      totalProfiles: 3,
      serverVersion: '0.9.0',
      nodeVersion: 'v22.0.0',
      platform: 'darwin',
      arch: 'arm64',
      isDesktop: true,
      electronVersion: '35.1.4',
    },
  }
}

describe('telemetry payload helpers', () => {
  it('assembles a flat payload from stats and feature data, including additive clearer fields', () => {
    const stats = createStatsSnapshot()
    const features = {
      ...emptyFeatureAdoption(),
      specialistsConfigured: 2,
      specialistsPersistedCount: 5,
      specialistsCustomCount: 2,
      specialistsEnabledCount: 4,
      scheduledTasksCount: 4,
      telegramConfigured: true,
      projectAgentsCount: 1,
      projectAgentsPersistedCount: 1,
      extensionsLoaded: 3,
      extensionsDiscoveredCount: 4,
      skillsConfigured: 6,
      skillsDiscoveredCount: 7,
      slashCommandsCount: 6,
      mobileDevicesRegistered: 2,
      mobileDevicesEnabledCount: 1,
    }

    const payload = assembleFullPayload(
      'install-123',
      stats,
      features,
      ['anthropic', 'openai-codex'],
      ['anthropic', 'xai'],
    )

    expect(payload).toMatchObject({
      install_id: 'install-123',
      schema_version: 1,
      app_version: '0.9.0',
      platform: 'darwin',
      arch: 'arm64',
      node_version: 'v22.0.0',
      electron_version: '35.1.4',
      is_desktop: true,
      total_profiles: 3,
      total_sessions: 5,
      total_messages_sent: 99,
      total_workers_run: 12,
      tokens_all_time: 900,
      tokens_last_30_days: 300,
      cache_hit_rate: 42.5,
      active_days: 11,
      longest_streak: 7,
      commits: 9,
      lines_added: 456,
      average_tokens_per_run: 75,
      specialists_configured: 2,
      specialists_persisted_count: 5,
      specialists_custom_count: 2,
      specialists_enabled_count: 4,
      scheduled_tasks_count: 4,
      telegram_configured: true,
      project_agents_count: 1,
      project_agents_persisted_count: 1,
      extensions_loaded: 3,
      extensions_discovered_count: 4,
      skills_configured: 6,
      skills_discovered_count: 7,
      slash_commands_count: 6,
      mobile_devices_registered: 2,
      mobile_devices_enabled_count: 1,
      providers_used: 'anthropic,openai-codex',
      auth_providers: 'anthropic,xai',
      top_model: 'gpt-5.4',
    })
    expect(payload.locale.length).toBeGreaterThan(0)
  })

  it('extracts providers used from catalog lookups and heuristics', () => {
    const stats = createStatsSnapshot()
    stats.models = [
      {
        modelId: 'gpt-5.4',
        displayName: 'GPT-5.4',
        percentage: 25,
        tokenCount: 250,
      },
      {
        modelId: 'openai/gpt-5.4',
        displayName: 'GPT-5.4 (prefixed)',
        percentage: 25,
        tokenCount: 250,
      },
      {
        modelId: 'claude-opus-4-6',
        displayName: 'Claude Opus 4.6',
        percentage: 25,
        tokenCount: 250,
      },
      {
        modelId: 'grok-4',
        displayName: 'Grok 4',
        percentage: 20,
        tokenCount: 200,
      },
      {
        modelId: 'foo/bar',
        displayName: 'Unknown',
        percentage: 5,
        tokenCount: 50,
      },
    ]

    expect(extractProvidersUsed(stats)).toEqual(['anthropic', 'openai-codex', 'xai'])
  })

  it('prefers untruncated provider sets when present on the stats snapshot', () => {
    const stats = createStatsSnapshot()
    stats.models = [
      {
        modelId: 'gpt-5.4',
        displayName: 'GPT-5.4',
        percentage: 100,
        tokenCount: 1000,
      },
    ]
    stats.allProviders = ['xai', 'anthropic', 'openai-codex']

    expect(extractProvidersUsed(stats)).toEqual(['anthropic', 'openai-codex', 'xai'])
  })

  it('omits top_model when the runtime model id is not catalog-known', () => {
    const stats = createStatsSnapshot()
    stats.models = [
      {
        modelId: 'my-company/private-model',
        displayName: 'Private Model',
        percentage: 100,
        tokenCount: 1000,
      },
    ]

    const payload = assembleFullPayload(
      'install-123',
      stats,
      emptyFeatureAdoption(),
      ['anthropic'],
      ['anthropic'],
    )

    expect(payload.top_model).toBe('')
  })

  it('extracts configured auth providers from auth storage and env-backed credentials without exposing secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telemetry-auth-providers-test-'))
    const sharedAuthFile = join(root, 'shared', 'auth', 'auth.json')
    const legacyAuthFile = join(root, 'auth', 'auth.json')
    const sharedSecretsFile = join(root, 'shared', 'secrets.json')
    const legacySecretsFile = join(root, 'secrets.json')

    await mkdir(join(root, 'shared', 'auth'), { recursive: true })

    const authStorage = AuthStorage.create(sharedAuthFile)
    authStorage.set('anthropic', {
      type: 'api_key',
      key: 'sk-ant-secret',
      access: 'sk-ant-secret',
      refresh: '',
      expires: '',
    } as any)
    authStorage.set('xai', {
      type: 'api_key',
      key: '',
      access: '',
      refresh: '',
      expires: '',
    } as any)

    const originalOpenAiApiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'sk-openai-secret'

    try {
      const config = {
        paths: {
          sharedAuthFile,
          authFile: legacyAuthFile,
          sharedSecretsFile,
          secretsFile: legacySecretsFile,
        },
      } as unknown as SwarmConfig

      expect(await extractAuthMethodsConfigured(config)).toEqual(['anthropic', 'openai-codex'])
    } finally {
      if (originalOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiApiKey
      }
    }
  })
})
