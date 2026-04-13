import { inferCatalogProvider, type StatsSnapshot, type TelemetryPayload } from '@forge/protocol'
import { getManagedModelProviderCredentialAvailability } from '../swarm/secrets-env-service.js'
import type { SwarmConfig } from '../swarm/types.js'
import { inferProviderFromModelId } from './provider-inference.js'

const SCHEMA_VERSION = 1
const UNKNOWN_APP_VERSION = 'unknown'

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
  telegramConfigured: boolean
  playwrightEnabled: boolean
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

export function emptyFeatureAdoption(): FeatureAdoptionData {
  return {
    specialistsConfigured: 0,
    specialistsPersistedCount: 0,
    specialistsCustomCount: 0,
    specialistsEnabledCount: 0,
    terminalsActive: 0,
    pinnedMessagesUsed: 0,
    scheduledTasksCount: 0,
    telegramConfigured: false,
    playwrightEnabled: false,
    forkedSessionsCount: 0,
    projectAgentsCount: 0,
    projectAgentsPersistedCount: 0,
    extensionsLoaded: 0,
    extensionsDiscoveredCount: 0,
    skillsConfigured: 0,
    skillsDiscoveredCount: 0,
    referenceDocsCount: 0,
    slashCommandsCount: 0,
    cortexAutoReviewEnabled: false,
    mobileDevicesRegistered: 0,
    mobileDevicesEnabledCount: 0,
  }
}

export async function assembleSkeletonPayload(
  installId: string,
  reportId: string,
  snapshotComputedAt: string,
  config: SwarmConfig,
): Promise<TelemetryPayload> {
  const rawPlatform = process.platform

  return {
    install_id: installId,
    report_id: reportId,
    schema_version: SCHEMA_VERSION,
    snapshot_computed_at: snapshotComputedAt,

    app_version: process.env.FORGE_APP_VERSION?.trim() || UNKNOWN_APP_VERSION,
    platform: toFriendlyPlatformName(rawPlatform),
    platform_raw: rawPlatform,
    arch: process.arch,
    node_version: process.version,
    electron_version: process.env.FORGE_ELECTRON_VERSION ?? null,
    is_desktop: config.isDesktop,
    locale: resolveLocale(),
    total_profiles: 0,

    total_sessions: 0,
    total_messages_sent: 0,
    total_workers_run: 0,
    tokens_all_time: 0,
    tokens_last_30_days: 0,
    cache_hit_rate: 0,
    active_days: 0,
    longest_streak: 0,
    commits: 0,
    lines_added: 0,
    average_tokens_per_run: 0,

    specialists_configured: 0,
    specialists_persisted_count: 0,
    specialists_custom_count: 0,
    specialists_enabled_count: 0,
    terminals_active: 0,
    pinned_messages_used: 0,
    scheduled_tasks_count: 0,
    telegram_configured: false,
    playwright_enabled: false,
    forked_sessions_count: 0,
    project_agents_count: 0,
    project_agents_persisted_count: 0,
    extensions_loaded: 0,
    extensions_discovered_count: 0,
    skills_configured: 0,
    skills_discovered_count: 0,
    reference_docs_count: 0,
    slash_commands_count: 0,
    cortex_auto_review_enabled: false,
    mobile_devices_registered: 0,
    mobile_devices_enabled_count: 0,

    providers_used: '',
    auth_providers: '',
    top_model: '',
  }
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
    telegram_configured: features.telegramConfigured,
    playwright_enabled: features.playwrightEnabled,
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
      .filter(([provider, isConfigured]) => isConfigured && provider !== "claude-sdk")
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
