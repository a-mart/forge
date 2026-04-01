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
  it('assembles a flat payload from stats and feature data', () => {
    const stats = createStatsSnapshot()
    const features = {
      ...emptyFeatureAdoption(),
      specialistsConfigured: 2,
      scheduledTasksCount: 4,
      telegramConfigured: true,
      slashCommandsCount: 6,
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
      scheduled_tasks_count: 4,
      telegram_configured: true,
      slash_commands_count: 6,
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

  it('extracts configured auth providers without exposing secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'telemetry-auth-providers-test-'))
    const sharedAuthFile = join(root, 'shared', 'auth', 'auth.json')
    const legacyAuthFile = join(root, 'auth', 'auth.json')

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

    const config = {
      paths: {
        sharedAuthFile,
        authFile: legacyAuthFile,
      },
    } as unknown as SwarmConfig

    expect(await extractAuthMethodsConfigured(config)).toEqual(['anthropic'])
  })
})
