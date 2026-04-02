export interface StatsSnapshot {
  /** ISO timestamp of when stats were last computed */
  computedAt: string;

  /** Server uptime in milliseconds */
  uptimeMs: number;

  tokens: TokenStats;
  cache: CacheStats;
  workers: WorkerStats;
  code: CodeStats;
  sessions: SessionStats;
  activity: ActivityStats;
  models: ModelDistributionEntry[];
  /** Untruncated provider set derived from all model usage, not just the top models list. */
  allProviders?: string[];
  dailyUsage: DailyUsageBucket[];
  providers: ProviderUsageStats;
  system: SystemStats;
}

export interface TokenStats {
  today: number;
  yesterday: number;
  todayDate: string;
  todayInputTokens: number;
  todayOutputTokens: number;
  last7Days: number;
  last7DaysAvgPerDay: number;
  last30Days: number;
  allTime: number;
}

export interface CacheStats {
  hitRate: number;
  hitRatePeriod: string;
  cachedTokensSaved: number;
}

export interface WorkerStats {
  totalWorkersRun: number;
  totalWorkersRunPeriod: string;
  averageTokensPerRun: number;
  averageRuntimeMs: number;
  currentlyActive: number;
}

export interface CodeStats {
  linesAdded: number;
  linesDeleted: number;
  commits: number;
  repos: number;
}

export interface SessionStats {
  totalSessions: number;
  activeSessions: number;
  totalMessagesSent: number;
  totalMessagesPeriod: string;
}

export interface ActivityStats {
  longestStreak: number;
  streakLabel: string;
  activeDays: number;
  activeDaysInRange: number;
  totalDaysInRange: number;
  peakDay: string;
  peakDayTokens: number;
}

export interface ModelDistributionEntry {
  modelId: string;
  displayName: string;
  percentage: number;
  tokenCount: number;
  reasoningBreakdown?: ModelReasoningBreakdownEntry[];
}

export interface ModelReasoningBreakdownEntry {
  level: string;
  tokenCount: number;
  percentage: number;
}

export interface DailyUsageBucket {
  date: string;
  dateLabel: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface ProviderUsageStats {
  anthropic?: ProviderAccountUsage;
  openai?: ProviderAccountUsage;
}

export interface ProviderUsageWindow {
  percent: number;
  resetInfo: string;
  resetAtMs?: number;
  windowSeconds?: number;
}

export interface ProviderAccountUsage {
  provider: string;
  accountEmail?: string;
  plan?: string;
  sessionUsage?: ProviderUsageWindow;
  weeklyUsage?: ProviderUsageWindow;
  available: boolean;
  error?: string;
}

export interface SystemStats {
  uptimeFormatted: string;
  totalProfiles: number;
  serverVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  isDesktop: boolean;
  electronVersion: string | null;
}

export type StatsRange = "7d" | "30d" | "all";
