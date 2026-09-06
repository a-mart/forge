import Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import type { AgentDescriptor, ManagerProfile } from "../../../types.js";
import { HistorySearchService } from "../../../history-recall/history-search-service.js";
import { locateCheckpointEvidence } from "../../../history-recall/checkpoint-references.js";
import { readSourceGeneration, readSourceStat } from "../../../history-recall/jsonl-reader.js";
import { getSessionFilePath, getWorkerSessionFilePath } from "../../../storage/data-paths.js";
import { createHost } from "./catalog.js";
import type { GoldenCase } from "./goldens.js";
import {
  inspectLifecycle,
  type HistoryCatalogSnapshot,
  type HistoryServiceLifecycle,
} from "./lifecycle-contract.js";
import { NEEDLE, SESSION } from "./ids.js";
import { classifyCursor, type ObservedHit, type ObservedResponse } from "./scoring.js";

export function loadBetterSqlite3(): () => Promise<typeof Database> {
  return async () => Database;
}

export function createBenchmarkService(
  dataDir: string,
  agents: AgentDescriptor[],
  profiles: ManagerProfile[],
): HistorySearchService {
  return new HistorySearchService(createHost(dataDir, agents, profiles, loadBetterSqlite3()) as never);
}

export function catalogSnapshot(
  dataDir: string,
  agents: AgentDescriptor[],
  hydration: HistoryCatalogSnapshot["hydration"] = "complete",
  revision = 1,
  keep?: (agent: AgentDescriptor) => boolean,
): HistoryCatalogSnapshot {
  return {
    revision,
    hydration,
    sources: agents.filter((agent) => keep ? keep(agent) : true).map((agent) => {
      const sessionAgentId = agent.role === "manager" ? agent.agentId : agent.managerId;
      const path = agent.role === "manager"
        ? getSessionFilePath(dataDir, agent.profileId ?? sessionAgentId, agent.agentId)
        : getWorkerSessionFilePath(dataDir, agent.profileId ?? sessionAgentId, sessionAgentId, agent.agentId);
      return {
        sourceId: `${sessionAgentId}:${agent.agentId}`,
        profileId: agent.profileId ?? sessionAgentId,
        sessionAgentId,
        actorAgentId: agent.agentId,
        path,
        archived: Boolean(agent.archivedAt),
        sessionLabel: agent.sessionLabel ?? agent.displayName ?? agent.agentId,
        actorLabel: agent.displayName ?? agent.agentId,
      };
    }),
  };
}

export async function executeGolden(
  service: HistoryServiceLifecycle,
  golden: GoldenCase,
  dataDir: string,
  agents: AgentDescriptor[],
): Promise<ObservedResponse> {
  const started = performance.now();
  const lifecycle = inspectLifecycle(service);
  if (golden.op === "lifecycle" || golden.op === "sessions") {
    return executeLifecycle(service, golden, dataDir, agents, started, lifecycle);
  }
  if (golden.op === "read") {
    return executeRead(service, golden, dataDir, agents, started);
  }
  return executeSearch(service, golden, started, lifecycle);
}

async function executeSearch(
  service: HistoryServiceLifecycle,
  golden: GoldenCase,
  started: number,
  lifecycle: Record<string, boolean>,
): Promise<ObservedResponse> {
  try {
    const request: Record<string, unknown> = {
      query: golden.query,
      scope: golden.scope,
      sessionAgentId: golden.sessionAgentId,
      profileId: golden.profileId,
      reason: golden.reason,
      kinds: golden.kinds,
      toolName: golden.toolName,
      window: golden.window,
      limit: golden.limit,
      since: golden.since,
      until: golden.until,
      order: golden.order,
      includeHistoryArtifacts: golden.includeHistoryArtifacts,
    };
    const result = await service.search(golden.callerAgentId, request) as {
      results?: Array<{
        ref?: { sessionAgentId?: string; actorAgentId?: string; entryId?: string; partId?: string };
        kind?: string;
        timestamp?: string;
        snippet?: string;
        score?: number;
        toolName?: string;
      }>;
      complete?: boolean;
      coverage?: { state?: string };
      warnings?: string[];
      nextCursor?: string;
    };
    const hits: ObservedHit[] = (result.results ?? []).map((hit) => ({
      sessionAgentId: hit.ref?.sessionAgentId,
      actorAgentId: hit.ref?.actorAgentId,
      entryId: hit.ref?.entryId,
      partId: hit.ref?.partId,
      kind: hit.kind,
      timestamp: hit.timestamp,
      snippet: hit.snippet,
      score: hit.score,
      toolName: hit.toolName,
    }));
    return {
      op: "search",
      hits,
      complete: result.complete,
      coverageState: result.coverage?.state,
      warnings: result.warnings,
      nextCursor: result.nextCursor,
      cursorKind: classifyCursor(result.nextCursor),
      lifecycle,
      durationMs: performance.now() - started,
    };
  } catch (error) {
    return fail("search", started, lifecycle, error);
  }
}

async function executeLifecycle(
  service: HistoryServiceLifecycle,
  golden: GoldenCase,
  dataDir: string,
  agents: AgentDescriptor[],
  started: number,
  lifecycle: Record<string, boolean>,
): Promise<ObservedResponse> {
  if (golden.id === "sessions-discovery-by-label") {
    if (typeof service.sessions !== "function") {
      return { op: golden.op, hits: [], lifecycle, error: "required lifecycle methods are absent", durationMs: performance.now() - started };
    }
    try {
      const result = await service.sessions(golden.callerAgentId, {
        query: golden.query,
        scope: golden.scope,
        reason: golden.reason,
      }) as { results?: Array<{ sessionAgentId?: string }> };
      return {
        op: golden.op,
        hits: (result.results ?? []).map((row) => ({
          sessionAgentId: row.sessionAgentId,
          actorAgentId: row.sessionAgentId,
          entryId: row.sessionAgentId,
        })),
        lifecycle,
        durationMs: performance.now() - started,
      };
    } catch (error) {
      return fail(golden.op, started, lifecycle, error);
    }
  }

  if (golden.id === "cold-tail-without-search-clock") {
    if (typeof service.start !== "function") {
      return { op: golden.op, hits: [], lifecycle, error: "required lifecycle methods are absent", durationMs: performance.now() - started };
    }
    await service.start(catalogSnapshot(dataDir, agents, "complete", 1));
    await yieldBackground(8);
    return executeSearch(service, {
      ...golden,
      op: "search",
      query: NEEDLE.coldTail,
      scope: "session",
      sessionAgentId: SESSION.recent,
    }, started, lifecycle);
  }

  if (golden.id === "partial-catalog-no-purge") {
    if (typeof service.start !== "function" || typeof service.replaceCatalog !== "function") {
      return { op: golden.op, hits: [], lifecycle, error: "required lifecycle methods are absent", durationMs: performance.now() - started };
    }
    await service.start(catalogSnapshot(dataDir, agents, "complete", 1));
    await service.search(golden.callerAgentId, { query: NEEDLE.coldTail, scope: "session", sessionAgentId: SESSION.recent });
    service.replaceCatalog(catalogSnapshot(dataDir, agents, "partial", 2, (agent) => agent.agentId !== SESSION.recent));
    return executeSearch(service, {
      ...golden,
      op: "search",
      query: NEEDLE.absent,
      scope: "project",
    }, started, lifecycle);
  }

  if (golden.id === "invalidate-source-not-session") {
    if (typeof service.invalidateSource !== "function") {
      return { op: golden.op, hits: [], lifecycle, error: "required lifecycle methods are absent", durationMs: performance.now() - started };
    }
    if (typeof service.start === "function") {
      await service.start(catalogSnapshot(dataDir, agents, "complete", 1));
      await service.search(SESSION.worker, { query: NEEDLE.workerOnly, scope: "session", sessionAgentId: SESSION.worker });
    }
    await service.invalidateSource({ sessionAgentId: SESSION.worker, actorAgentId: SESSION.worker });
    return executeSearch(service, {
      ...golden,
      op: "search",
      query: NEEDLE.workerOnly,
      scope: "session",
      sessionAgentId: SESSION.worker,
    }, started, lifecycle);
  }

  if (golden.id === "provisional-seam-replay") {
    if (typeof service.start !== "function") {
      return { op: golden.op, hits: [], lifecycle, error: "required lifecycle methods are absent", durationMs: performance.now() - started };
    }
    await service.start(catalogSnapshot(dataDir, agents, "complete", 1));
    return executeSearch(service, {
      ...golden,
      op: "search",
      query: "HRR_SEAM_MIRROR_TEXT",
      scope: "session",
      sessionAgentId: SESSION.multipart,
    }, started, lifecycle);
  }

  return {
    op: golden.op,
    hits: [],
    lifecycle,
    error: Object.values(lifecycle).every(Boolean) ? undefined : "required lifecycle methods are absent",
    durationMs: performance.now() - started,
  };
}

async function executeRead(
  service: HistoryServiceLifecycle,
  golden: GoldenCase,
  dataDir: string,
  agents: AgentDescriptor[],
  started: number,
): Promise<ObservedResponse> {
  const expected = golden.expectedRefs[0];
  if (!expected) {
    return { op: "read", hits: [], durationMs: performance.now() - started };
  }
  const agent = agents.find((entry) => entry.agentId === expected.actorAgentId);
  if (!agent) {
    return { op: "read", hits: [], error: "actor missing from catalog", durationMs: performance.now() - started };
  }
  const path = agent.role === "manager"
    ? getSessionFilePath(dataDir, agent.profileId ?? expected.sessionAgentId, agent.agentId)
    : getWorkerSessionFilePath(dataDir, agent.profileId ?? expected.sessionAgentId, expected.sessionAgentId, agent.agentId);
  const located = locateCheckpointEvidence({
    sessionFile: path,
    sessionAgentId: expected.sessionAgentId,
    actorAgentId: expected.actorAgentId,
    entryIds: [expected.entryId],
  });
  const stat = readSourceStat(path);
  const sourceVersion = located.refs[0]?.sourceVersion ?? (stat ? readSourceGeneration(path, stat) : "missing");
  const ref = {
    sessionAgentId: expected.sessionAgentId,
    actorAgentId: expected.actorAgentId,
    entryId: expected.entryId,
    sourceVersion,
    ...(located.refs[0]?.byteOffset !== undefined ? { byteOffset: located.refs[0].byteOffset } : {}),
  };
  try {
    const result = await service.read(golden.callerAgentId, { ref, maxChars: 20_000 }) as {
      entry?: { text?: string; kind?: string; ref?: { entryId?: string; partId?: string }; parts?: Array<{ text?: string; partId?: string }> };
    };
    const text = [result.entry?.text, ...(result.entry?.parts ?? []).map((part) => part.text)].filter(Boolean).join("\n");
    return {
      op: "read",
      hits: [{
        sessionAgentId: expected.sessionAgentId,
        actorAgentId: expected.actorAgentId,
        entryId: result.entry?.ref?.entryId ?? expected.entryId,
        partId: result.entry?.ref?.partId,
        kind: result.entry?.kind,
        text,
      }],
      durationMs: performance.now() - started,
    };
  } catch (error) {
    return fail("read", started, inspectLifecycle(service), error);
  }
}

function fail(op: ObservedResponse["op"], started: number, lifecycle: Record<string, boolean>, error: unknown): ObservedResponse {
  const err = error as { message?: string; statusCode?: number };
  return {
    op,
    hits: [],
    error: err?.message ?? String(error),
    errorStatus: err?.statusCode,
    lifecycle,
    durationMs: performance.now() - started,
  };
}

async function yieldBackground(turns: number): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
