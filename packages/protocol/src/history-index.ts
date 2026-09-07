/** Local Builder operational diagnostics; never contains transcript content. */
export interface HistoryIndexStatistics {
  discoveredSources: number;
  pendingSources: number;
  runnableSources: number;
  unreadableSources: number;
  omittedSources: number;
  transcriptBytes: number;
  processedBytes: number;
  lastUpdatedAt: string | null;
}

export interface HistoryIndexStatus {
  paused: boolean;
  activity: "starting" | "indexing" | "idle" | "paused" | "unavailable";
  catalogHydration: "partial" | "complete";
  eligibleSources: number | null;
  schemaVersion: string;
  statistics: HistoryIndexStatistics | null;
  storage: { databaseBytes: number | null; walBytes: number | null };
  observedAt: string;
  error: string | null;
}

export interface UpdateHistoryIndexSettingsRequest {
  paused: boolean;
}
