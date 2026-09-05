import type { HistoryEntryKind } from "@forge/protocol";
import type {
  AgentDescriptor,
  ManagerProfile,
  SqliteDatabaseConstructor,
  SwarmConfig,
} from "../types.js";

export interface HistorySearchServiceHost {
  config: Pick<SwarmConfig, "paths">;
  getAgent: (agentId: string) => AgentDescriptor | undefined;
  listAgents: () => AgentDescriptor[];
  listProfiles: () => ManagerProfile[];
  loadDatabaseModule: () => Promise<SqliteDatabaseConstructor>;
}

export type HistoryEntryOrigin = "forge_custom" | "native";
export type ProjectionMode = "index" | "read";

export interface ProjectedHistoryEntry {
  entryId: string;
  kind: HistoryEntryKind;
  role?: "user" | "assistant";
  toolName?: string;
  timestamp?: string;
  windowId: string;
  text: string;
  extra: string;
  contentKey: string;
  origin: HistoryEntryOrigin;
  byteOffset: number;
  parentId: string | null;
  replacesEntryId?: string;
  retainsFromEntryId?: string;
}

export interface ContentKeyOccurrences {
  entryId: string;
  origin: HistoryEntryOrigin;
  text: string;
  windowId: string;
  timestamp?: string;
}

export interface ProjectorState {
  windowId: string;
  pendingBoundaryId?: string;
  seenContentKeys: Map<string, ContentKeyOccurrences>;
}

export interface HistorySourceDescriptor {
  sourceId: string;
  profileId: string;
  sessionAgentId: string;
  actorAgentId: string;
  path: string;
  archived: boolean;
  sessionLabel: string;
  actorLabel: string;
}

export interface JsonlCompleteLine {
  byteOffset: number;
  nextOffset: number;
  line: string;
}

export interface JsonlScanResult {
  lines: JsonlCompleteLine[];
  nextOffset: number;
  incomplete: boolean;
  scannedBytes: number;
  skippedOversized: boolean;
  skippingOversized: boolean;
}

export const INITIAL_WINDOW_ID = "window:initial";
export const FORGE_CONTEXT_BOUNDARY_TYPE = "forge_context_boundary";
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;
export const MAX_NEIGHBORS = 5;
export const MAX_INDEX_CATCHUP_BYTES = 1 * 1024 * 1024;
export const MAX_INDEX_CATCHUP_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_INDEX_CATCHUP_SOURCES = 48;
export const MAX_JSONL_CHUNK_BYTES = 64 * 1024;
export const MAX_GENERATION_SCAN_BYTES = 64 * 1024;
