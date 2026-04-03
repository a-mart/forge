export interface PersistedTelemetryConfig {
  /** Random UUIDv4 install identifier. Generated on first run. */
  installId: string
  /** ISO 8601 timestamp of the last successful telemetry send, or null if never sent. */
  lastSuccessfulSendAt: string | null
  /** ISO 8601 timestamp of the last failed telemetry send attempt, or null if none. */
  lastFailedAttemptAt: string | null
}

export interface TelemetryPayload {
  install_id: string
  report_id: string
  schema_version: number
  snapshot_computed_at: string

  // System info
  app_version: string
  platform: string
  platform_raw?: string
  arch: string
  node_version: string
  electron_version: string | null
  is_desktop: boolean
  locale: string
  total_profiles: number

  // Usage stats
  total_sessions: number
  total_messages_sent: number
  total_workers_run: number
  tokens_all_time: number
  tokens_last_30_days: number
  cache_hit_rate: number
  active_days: number
  longest_streak: number
  commits: number
  lines_added: number
  average_tokens_per_run: number

  // Feature adoption
  specialists_configured: number
  specialists_persisted_count?: number
  specialists_custom_count?: number
  specialists_enabled_count?: number
  terminals_active: number
  pinned_messages_used: number
  scheduled_tasks_count: number
  telegram_configured: boolean
  playwright_enabled: boolean
  forked_sessions_count: number
  project_agents_count: number
  project_agents_persisted_count?: number
  extensions_loaded: number
  extensions_discovered_count?: number
  skills_configured: number
  skills_discovered_count?: number
  reference_docs_count: number
  slash_commands_count: number
  cortex_auto_review_enabled: boolean
  mobile_devices_registered: number
  mobile_devices_enabled_count?: number

  // Provider / model info
  providers_used: string
  auth_providers: string
  top_model: string
}
