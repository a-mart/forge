export interface StatsSnapshot {
  /** ISO timestamp of when stats were last computed */
  computedAt: string

  /** Server uptime in milliseconds */
  uptimeMs: number

  tokens: TokenStats
  cache: CacheStats
  workers: WorkerStats
  sessions: SessionStats
  activity: ActivityStats
  models: ModelDistributionEntry[]
  dailyUsage: DailyUsageBucket[]
  providers: ProviderUsageStats
  system: SystemStats
}

export interface TokenStats {
  today: number
  todayDate: string
  todayInputTokens: number
  todayOutputTokens: number
  last7Days: number
  last7DaysAvgPerDay: number
  last30Days: number
  last30DaysTotal: number
  allTime: number
}

export interface CacheStats {
  hitRate: number
  hitRatePeriod: string
  cachedTokensSaved: number
  cachedTokensPercentOfPrompt: number
}

export interface WorkerStats {
  totalWorkersRun: number
  totalWorkersRunPeriod: string
  averageTokensPerRun: number
  currentlyActive: number
}

export interface SessionStats {
  totalSessions: number
  activeSessions: number
  totalMessagesSent: number
  totalMessagesPeriod: string
}

export interface ActivityStats {
  longestStreak: number
  streakLabel: string
  activeDays: number
  activeDaysInRange: number
  totalDaysInRange: number
  peakDay: string
  peakDayTokens: number
}

export interface ModelDistributionEntry {
  modelId: string
  displayName: string
  percentage: number
  tokenCount: number
}

export interface DailyUsageBucket {
  date: string
  dateLabel: string
  tokens: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
}

export interface ProviderUsageStats {
  anthropic?: ProviderAccountUsage
  openai?: ProviderAccountUsage
}

export interface ProviderAccountUsage {
  provider: string
  accountEmail?: string
  plan?: string
  sessionUsage?: {
    percent: number
    resetInfo: string
  }
  weeklyUsage?: {
    percent: number
    resetInfo: string
  }
  available: boolean
  error?: string
}

export interface SystemStats {
  uptimeFormatted: string
  totalProfiles: number
  serverVersion: string
  nodeVersion: string
}

export type StatsRange = '7d' | '30d' | 'all'
