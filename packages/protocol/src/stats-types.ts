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
  openai?: ProviderAccountUsage[];
}

export interface ProviderUsagePace {
  mode: 'historical';
  expectedPercent: number;
  deltaPercent: number;
  etaSeconds?: number;
  willLastToReset: boolean;
  runOutProbability?: number;
}

export interface ProviderUsageWindow {
  percent: number;
  resetInfo: string;
  resetAtMs?: number;
  windowSeconds?: number;
  pace?: ProviderUsagePace;
}

export interface ProviderAccountUsage {
  provider: string;
  accountId?: string;
  accountLabel?: string;
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

export interface TokenUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface TokenCostTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type TokenAnalyticsRangePreset = StatsRange | "custom";
export type TokenAnalyticsAttributionKind = "specialist" | "ad_hoc" | "unknown";
export type TokenAnalyticsAttributionFilter = "all" | TokenAnalyticsAttributionKind;
export type TokenAnalyticsCostCoverage = "none" | "partial" | "full";
export type TokenAnalyticsWorkerSort = "startedAt" | "durationMs" | "totalTokens" | "cost";
export type TokenAnalyticsSortDirection = "asc" | "desc";

export interface TokenAnalyticsQuery {
  rangePreset: TokenAnalyticsRangePreset;
  startDate?: string;
  endDate?: string;
  timezone?: string | null;
  profileId?: string;
  provider?: string;
  modelId?: string;
  attribution?: TokenAnalyticsAttributionFilter;
  specialistId?: string;
}

export interface TokenAnalyticsResolvedQuery {
  rangePreset: TokenAnalyticsRangePreset;
  startDate: string | null;
  endDate: string | null;
  timezone: string;
  profileId: string | null;
  provider: string | null;
  modelId: string | null;
  attribution: TokenAnalyticsAttributionFilter;
  specialistId: string | null;
}

export interface TokenAnalyticsWorkerPageQuery extends TokenAnalyticsQuery {
  limit?: number;
  cursor?: string;
  sort?: TokenAnalyticsWorkerSort;
  direction?: TokenAnalyticsSortDirection;
}

export interface TokenAnalyticsWorkerEventsQuery {
  profileId: string;
  sessionId: string;
  workerId: string;
}

export interface TokenAnalyticsCostSummary {
  totals: TokenCostTotals | null;
  costCoverage: TokenAnalyticsCostCoverage;
  costCoveredEventCount: number;
}

export interface TokenAnalyticsProfileFilterOption {
  profileId: string;
  displayName: string;
  runCount: number;
  usage: TokenUsageTotals;
}

export interface TokenAnalyticsProviderFilterOption {
  provider: string;
  displayName: string;
  runCount: number;
  usage: TokenUsageTotals;
}

export interface TokenAnalyticsModelFilterOption {
  modelId: string;
  displayName: string;
  provider: string;
  runCount: number;
  usage: TokenUsageTotals;
}

export interface TokenAnalyticsAttributionFilterOption {
  value: TokenAnalyticsAttributionFilter;
  displayName: string;
  runCount: number;
  usage: TokenUsageTotals;
}

export interface TokenAnalyticsSpecialistFilterOption {
  specialistId: string;
  displayName: string;
  color?: string | null;
  hasProfileVariants?: boolean;
  runCount: number;
  usage: TokenUsageTotals;
}

export interface TokenAnalyticsAvailableFilters {
  profiles: TokenAnalyticsProfileFilterOption[];
  providers: TokenAnalyticsProviderFilterOption[];
  models: TokenAnalyticsModelFilterOption[];
  attributions: TokenAnalyticsAttributionFilterOption[];
  specialists: TokenAnalyticsSpecialistFilterOption[];
}

export interface TokenAnalyticsTotals {
  runCount: number;
  eventCount: number;
  usage: TokenUsageTotals;
  averageTokensPerRun: number;
  averageDurationMs: number | null;
  cost: TokenAnalyticsCostSummary;
}

export interface TokenAnalyticsAttributionBucket {
  attributionKind: TokenAnalyticsAttributionKind;
  runCount: number;
  runPercentage: number;
  usage: TokenUsageTotals;
  tokenPercentage: number;
  cost: TokenAnalyticsCostSummary;
}

export interface TokenAnalyticsAttributionSummary {
  specialist: TokenAnalyticsAttributionBucket;
  adHoc: TokenAnalyticsAttributionBucket;
  unknown: TokenAnalyticsAttributionBucket;
}

export interface TokenAnalyticsSpecialistSummary {
  specialistId: string | null;
  displayName: string;
  color?: string | null;
  attributionKind: TokenAnalyticsAttributionKind;
  hasProfileVariants?: boolean;
  runCount: number;
  eventCount: number;
  usage: TokenUsageTotals;
  averageTokensPerRun: number;
  averageDurationMs: number | null;
  percentOfScopedTokens: number;
  topModelId: string | null;
  topModelProvider: string | null;
  topProfileId: string | null;
  topProfileDisplayName: string | null;
  cost: TokenAnalyticsCostSummary;
}

export interface TokenAnalyticsWorkerRunModelUsage {
  modelId: string;
  provider: string;
  totalTokens: number;
}

export interface TokenAnalyticsWorkerRunSummary {
  profileId: string;
  profileDisplayName: string;
  sessionId: string;
  sessionLabel: string;
  workerId: string;
  specialistId: string | null;
  specialistDisplayName: string | null;
  specialistColor?: string | null;
  attributionKind: TokenAnalyticsAttributionKind;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  eventCount: number;
  usage: TokenUsageTotals;
  reasoningLevels: string[];
  modelsUsed: TokenAnalyticsWorkerRunModelUsage[];
  cost: TokenAnalyticsCostSummary;
}

export interface TokenAnalyticsWorkerEvent {
  timestamp: string;
  modelId: string;
  provider: string;
  reasoningLevel: string | null;
  usage: TokenUsageTotals;
  cost: TokenCostTotals | null;
}

export interface TokenAnalyticsSnapshot {
  computedAt: string;
  query: TokenAnalyticsResolvedQuery;
  availableFilters: TokenAnalyticsAvailableFilters;
  totals: TokenAnalyticsTotals;
  attribution: TokenAnalyticsAttributionSummary;
  specialistBreakdown: TokenAnalyticsSpecialistSummary[];
}

export interface TokenAnalyticsWorkerPage {
  computedAt: string;
  query: TokenAnalyticsResolvedQuery;
  totalCount: number;
  nextCursor: string | null;
  items: TokenAnalyticsWorkerRunSummary[];
}

export interface TokenAnalyticsWorkerEventsResponse {
  computedAt: string;
  worker: TokenAnalyticsWorkerRunSummary;
  events: TokenAnalyticsWorkerEvent[];
}
