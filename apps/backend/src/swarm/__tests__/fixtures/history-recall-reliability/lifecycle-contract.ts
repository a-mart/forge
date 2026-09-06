/**
 * Independently authored lifecycle surface the benchmark probes.
 * Signatures match the manager-accepted contract and the live protocol snapshot shape.
 */
export interface HistoryCatalogSource {
  sourceId: string;
  profileId: string;
  sessionAgentId: string;
  actorAgentId: string;
  path: string;
  archived: boolean;
  sessionLabel: string;
  actorLabel: string;
}

export interface HistoryCatalogSnapshot {
  revision: number;
  hydration: "partial" | "complete";
  sources: readonly HistoryCatalogSource[];
}

export interface HistorySourceKey {
  sessionAgentId: string;
  actorAgentId: string;
}

export interface HistorySessionsRequest {
  query?: string;
  scope?: "session" | "project" | "all_local";
  sessionAgentId?: string;
  profileId?: string;
  reason?: string;
  limit?: number;
  cursor?: string;
}

export interface HistoryServiceLifecycle {
  search(callerAgentId: string, request: Record<string, unknown>): Promise<unknown>;
  read(callerAgentId: string, request: Record<string, unknown>): Promise<unknown>;
  invalidateSession?(sessionAgentId: string): Promise<void>;
  dispose(): Promise<void>;
  start?(snapshot: HistoryCatalogSnapshot): Promise<void>;
  replaceCatalog?(snapshot: HistoryCatalogSnapshot): void;
  markSourceDirty?(key: HistorySourceKey): void;
  invalidateSource?(key: HistorySourceKey): Promise<void>;
  sessions?(callerAgentId: string, request: HistorySessionsRequest): Promise<unknown>;
}

export const REQUIRED_LIFECYCLE_METHODS = [
  "start",
  "replaceCatalog",
  "markSourceDirty",
  "invalidateSource",
  "sessions",
] as const;

export function inspectLifecycle(service: object): Record<(typeof REQUIRED_LIFECYCLE_METHODS)[number], boolean> {
  const record = service as Record<string, unknown>;
  return {
    start: typeof record.start === "function",
    replaceCatalog: typeof record.replaceCatalog === "function",
    markSourceDirty: typeof record.markSourceDirty === "function",
    invalidateSource: typeof record.invalidateSource === "function",
    sessions: typeof record.sessions === "function",
  };
}
