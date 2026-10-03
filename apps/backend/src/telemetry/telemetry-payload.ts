import { inferCatalogProvider, type StatsSnapshot, type TelemetryPayload } from '@forge/protocol'
import { getManagedModelProviderCredentialAvailability } from '../swarm/secrets-env-service.js'
import type { SwarmConfig } from '../swarm/types.js'
import { inferProviderFromModelId } from './provider-inference.js'

const SCHEMA_VERSION = 1

const FRIENDLY_PLATFORM_NAMES: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
}

export interface FeatureAdoptionData {
  specialistsConfigured: number
  specialistsPersistedCount: number
  specialistsCustomCount: number
  specialistsEnabledCount: number
  terminalsActive: number
  pinnedMessagesUsed: number
  scheduledTasksCount: number
  forkedSessionsCount: number
  projectAgentsCount: number
  projectAgentsPersistedCount: number
  extensionsLoaded: number
  extensionsDiscoveredCount: number
  skillsConfigured: number
  skillsDiscoveredCount: number
  referenceDocsCount: number
  slashCommandsCount: number
  cortexAutoReviewEnabled: boolean
  mobileDevicesRegistered: number
  mobileDevicesEnabledCount: number
}

export function assembleFullPayload(
  installId: string,
  reportId: string,
  stats: StatsSnapshot,
  features: FeatureAdoptionData,
  providersUsed: string[],
  authProviders: string[],
): TelemetryPayload {
  const topModelRaw = stats.models[0]?.modelId ?? ''
  const normalizedTopModel = topModelRaw.trim().toLowerCase()
  const topModel = inferCatalogProvider(normalizedTopModel) ? normalizedTopModel : ''

  const rawPlatform = stats.system.platform

  return {
    install_id: installId,
    report_id: reportId,
    schema_version: SCHEMA_VERSION,
    snapshot_computed_at: stats.computedAt,

    app_version: stats.system.serverVersion,
    platform: toFriendlyPlatformName(rawPlatform),
    platform_raw: rawPlatform,
    arch: stats.system.arch,
    node_version: stats.system.nodeVersion,
    electron_version: stats.system.electronVersion,
    is_desktop: stats.system.isDesktop,
    locale: resolveLocale(),
    total_profiles: stats.system.totalProfiles,

    total_sessions: stats.sessions.totalSessions,
    total_messages_sent: stats.sessions.totalMessagesSent,
    total_workers_run: stats.workers.totalWorkersRun,
    tokens_all_time: stats.tokens.allTime,
    tokens_last_30_days: stats.tokens.last30Days,
    cache_hit_rate: stats.cache.hitRate,
    active_days: stats.activity.activeDays,
    longest_streak: stats.activity.longestStreak,
    commits: stats.code.commits,
    lines_added: stats.code.linesAdded,
    average_tokens_per_run: stats.workers.averageTokensPerRun,

    specialists_configured: features.specialistsConfigured,
    specialists_persisted_count: features.specialistsPersistedCount,
    specialists_custom_count: features.specialistsCustomCount,
    specialists_enabled_count: features.specialistsEnabledCount,
    terminals_active: features.terminalsActive,
    pinned_messages_used: features.pinnedMessagesUsed,
    scheduled_tasks_count: features.scheduledTasksCount,
    // Deprecated schema-v1 compatibility field. The retired integration is never scanned.
    telegram_configured: false,
    forked_sessions_count: features.forkedSessionsCount,
    project_agents_count: features.projectAgentsCount,
    project_agents_persisted_count: features.projectAgentsPersistedCount,
    extensions_loaded: features.extensionsLoaded,
    extensions_discovered_count: features.extensionsDiscoveredCount,
    skills_configured: features.skillsConfigured,
    skills_discovered_count: features.skillsDiscoveredCount,
    reference_docs_count: features.referenceDocsCount,
    slash_commands_count: features.slashCommandsCount,
    cortex_auto_review_enabled: features.cortexAutoReviewEnabled,
    mobile_devices_registered: features.mobileDevicesRegistered,
    mobile_devices_enabled_count: features.mobileDevicesEnabledCount,

    providers_used: providersUsed.join(','),
    auth_providers: authProviders.join(','),
    top_model: topModel,
  }
}

export function extractProvidersUsed(stats: StatsSnapshot): string[] {
  if (Array.isArray(stats.allProviders)) {
    return Array.from(
      new Set(
        stats.allProviders
          .filter((provider): provider is string => typeof provider === 'string' && provider.trim().length > 0)
          .map((provider) => provider.trim()),
      ),
    ).sort()
  }

  const providers = new Set<string>()

  for (const model of stats.models) {
    const provider = inferProviderFromModelId(model.modelId)
    if (provider) {
      providers.add(provider)
    }
  }

  return Array.from(providers).sort()
}

export async function extractAuthMethodsConfigured(config: SwarmConfig): Promise<string[]> {
  try {
    const availability = await getManagedModelProviderCredentialAvailability(config)
    return Array.from(availability.entries())
      // Native Codex shares the OpenAI Codex credential; it is not a separate auth method.
      .filter(([provider, isConfigured]) => isConfigured && provider !== 'codex-native')
      .map(([provider]) => provider)
      .sort()
  } catch {
    return []
  }
}

function toFriendlyPlatformName(platform: string): string {
  return FRIENDLY_PLATFORM_NAMES[platform] ?? platform
}

function resolveLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale?.split('-')[0] ?? 'unknown'
}
