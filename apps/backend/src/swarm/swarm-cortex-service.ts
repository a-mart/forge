import type {
  CortexChangelogEntry,
  CortexConsolidationRunRecord,
  CortexConsolidationSnapshot,
  CortexConsolidationTrigger,
} from "@forge/protocol";
import { createKnowledgeConsolidatorApi } from "./knowledge-consolidator-api.js";
import type { KnowledgeEntry, KnowledgeService } from "./knowledge-service.js";
import type { KnowledgeV2SettingsService } from "./knowledge-v2-settings-service.js";
import { normalizeArchetypeId } from "./prompt-registry.js";
import {
  appendCortexConsolidationRun,
  createCortexConsolidationRunId,
  readCortexConsolidationRuns,
} from "./cortex-consolidation-runs.js";
import { appendCortexReviewLogEntry } from "./scripts/cortex-review-state.js";
import type { AgentDescriptor, MessageSourceContext, SwarmConfig } from "./types.js";

const CORTEX_ARCHETYPE_ID = "cortex";
const CORTEX_PROFILE_ID = "cortex";
const DEFAULT_THRESHOLD_NEW_OR_UPDATED_ENTRIES = 15;
const DEFAULT_DAILY_CADENCE_HOURS = 24;

export interface SwarmCortexServiceOptions {
  config: SwarmConfig;
  now: () => string;
  descriptors: Map<string, AgentDescriptor>;
  knowledgeService: KnowledgeService;
  knowledgeV2SettingsService: KnowledgeV2SettingsService;
  handleCaptureCascade?: (descriptor: AgentDescriptor, trigger: "idle") => void | Promise<void>;
  logDebug: (message: string, details?: unknown) => void;
}

export class SwarmCortexService {
  constructor(private readonly options: SwarmCortexServiceOptions) {}

  isCortexRootInteractiveSession(descriptor: AgentDescriptor): boolean {
    return (
      descriptor.role === "manager" &&
      descriptor.agentId === CORTEX_PROFILE_ID &&
      descriptor.profileId === CORTEX_PROFILE_ID &&
      normalizeArchetypeId(descriptor.archetypeId ?? "") === CORTEX_ARCHETYPE_ID &&
      descriptor.sessionPurpose !== "agent_creator"
    );
  }

  async listConsolidationRuns(): Promise<CortexConsolidationRunRecord[]> {
    return readCortexConsolidationRuns(this.options.config.paths.dataDir);
  }

  async getConsolidationSnapshot(): Promise<CortexConsolidationSnapshot> {
    const runs = await this.listConsolidationRuns();
    const entries = await this.options.knowledgeService.listEntries({ includeArchived: false });
    return {
      lastRun: runs[0] ?? null,
      nextTrigger: {
        thresholdNewOrUpdatedEntries: DEFAULT_THRESHOLD_NEW_OR_UPDATED_ENTRIES,
        dailyCadenceHours: DEFAULT_DAILY_CADENCE_HOURS,
      },
      promotionQueue: buildPromotionQueue(entries),
    };
  }

  async runConsolidation(trigger: CortexConsolidationTrigger): Promise<CortexConsolidationRunRecord | null> {
    if (!this.options.config.cortexEnabled || !this.options.knowledgeV2SettingsService.getSettings().enabled) {
      return null;
    }

    const runId = createCortexConsolidationRunId();
    const requestedAt = this.options.now();
    const changelog: CortexChangelogEntry[] = [];
    const api = createKnowledgeConsolidatorApi(this.options.knowledgeService);

    try {
      const entries = await this.options.knowledgeService.listEntries({ includeArchived: false });
      const active = entries.filter((entry) => entry.frontmatter.status === "active");

      const duplicateGroups = groupDuplicates(active);
      for (const group of duplicateGroups) {
        const merged = await api.merge(group.map((entry) => entry.frontmatter.id));
        changelog.push(await this.log(runId, "merged", merged.frontmatter.id, group.map((entry) => entry.frontmatter.id), "duplicate title/body similarity"));
      }

      const refreshed = await this.options.knowledgeService.listEntries({ includeArchived: false });
      const contradictionPairs = findContradictions(refreshed.filter((entry) => entry.frontmatter.status === "active"));
      for (const [winner, loser] of contradictionPairs) {
        const superseded = await this.options.knowledgeService.supersedeEntry(loser.frontmatter.id, [winner.frontmatter.id]);
        changelog.push(await this.log(runId, "superseded", superseded.frontmatter.id, [winner.frontmatter.id], "newer and better-supported entry wins contradiction"));
      }

      const afterContradictions = await this.options.knowledgeService.listEntries({ includeArchived: false });
      for (const entry of afterContradictions.filter((candidate) => candidate.frontmatter.status === "active")) {
        if (shouldDecay(entry, requestedAt)) {
          const archived = await api.archive(entry.frontmatter.id);
          changelog.push(await this.log(runId, "archived", archived.frontmatter.id, undefined, "last_confirmed exceeded decay_after_days"));
        }
      }

      await api.reindex();
      const reindexedScopes = Array.from(new Set(afterContradictions.map((entry) => entry.frontmatter.scope)));
      for (const scope of reindexedScopes) {
        changelog.push(await this.log(runId, "reindexed", undefined, undefined, `regenerated ${scope} INDEX under cap`));
      }

      const run: CortexConsolidationRunRecord = {
        runId,
        trigger,
        status: "completed",
        requestedAt,
        completedAt: this.options.now(),
        merged: changelog.filter((entry) => entry.action === "merged").length,
        archived: changelog.filter((entry) => entry.action === "archived").length,
        superseded: changelog.filter((entry) => entry.action === "superseded").length,
        reindexedScopes,
        changelog,
      };
      await appendCortexConsolidationRun(this.options.config.paths.dataDir, run);
      return run;
    } catch (error) {
      const run: CortexConsolidationRunRecord = {
        runId,
        trigger,
        status: "failed",
        requestedAt,
        completedAt: this.options.now(),
        merged: changelog.filter((entry) => entry.action === "merged").length,
        archived: changelog.filter((entry) => entry.action === "archived").length,
        superseded: changelog.filter((entry) => entry.action === "superseded").length,
        reindexedScopes: [],
        changelog,
        error: error instanceof Error ? error.message : String(error),
      };
      await appendCortexConsolidationRun(this.options.config.paths.dataDir, run);
      throw error;
    }
  }

  async maybeRunConsolidationFromIncomingMessage(
    text: string,
    target: AgentDescriptor,
    _sourceContext: MessageSourceContext,
  ): Promise<boolean> {
    if (!this.isCortexRootInteractiveSession(target)) {
      return false;
    }
    if (!/\b(consolidate|reindex)\b/i.test(text)) {
      return false;
    }
    await this.runConsolidation("manual");
    return true;
  }

  handleManagerStatusTransition(descriptor: AgentDescriptor, status: unknown, pendingCount: number): void {
    if (descriptor.role === "manager" && status === "idle" && pendingCount === 0) {
      void this.options.handleCaptureCascade?.(descriptor, "idle");
    }
  }

  private async log(
    runId: string,
    action: CortexChangelogEntry["action"],
    entryId: string | undefined,
    sourceEntryIds: string[] | undefined,
    why: string,
  ): Promise<CortexChangelogEntry> {
    return appendCortexReviewLogEntry({
      dataDir: this.options.config.paths.dataDir,
      entry: { runId, action, entryId, sourceEntryIds, why, recordedAt: this.options.now() },
    });
  }
}

function groupDuplicates(entries: KnowledgeEntry[]): KnowledgeEntry[][] {
  const groups = new Map<string, KnowledgeEntry[]>();
  for (const entry of entries) {
    const key = normalizeComparable(entry.frontmatter.title || entry.body);
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }
  return Array.from(groups.values()).filter((group) => group.length > 1);
}

function findContradictions(entries: KnowledgeEntry[]): Array<[KnowledgeEntry, KnowledgeEntry]> {
  const pairs: Array<[KnowledgeEntry, KnowledgeEntry]> = [];
  const byTopic = new Map<string, KnowledgeEntry[]>();
  for (const entry of entries) {
    const topic = normalizeComparable(entry.frontmatter.title.replace(/\b(do not|don't|never|avoid|use|prefer|always)\b/gi, ""));
    const bucket = byTopic.get(topic);
    if (bucket) bucket.push(entry);
    else byTopic.set(topic, [entry]);
  }
  for (const group of byTopic.values()) {
    const positive = group.filter((entry) => !isNegative(entry));
    const negative = group.filter(isNegative);
    if (positive.length === 0 || negative.length === 0) continue;
    const sorted = [...group].sort(compareWinner);
    const winner = sorted[0];
    for (const loser of sorted.slice(1)) {
      if (isNegative(loser) !== isNegative(winner)) {
        pairs.push([winner, loser]);
      }
    }
  }
  return pairs;
}

function shouldDecay(entry: KnowledgeEntry, nowIso: string): boolean {
  const days = entry.frontmatter.decay_after_days;
  if (days === null || entry.frontmatter.importance === "pinned") return false;
  return Date.parse(nowIso) - Date.parse(entry.frontmatter.last_confirmed) > days * 24 * 60 * 60 * 1000;
}

function compareWinner(left: KnowledgeEntry, right: KnowledgeEntry): number {
  return (
    right.frontmatter.support_count - left.frontmatter.support_count ||
    Date.parse(right.frontmatter.last_confirmed) - Date.parse(left.frontmatter.last_confirmed)
  );
}

function isNegative(entry: KnowledgeEntry): boolean {
  return /\b(do not|don't|never|avoid)\b/i.test(`${entry.frontmatter.title} ${entry.body}`);
}

function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/u).slice(0, 8).join(" ");
}

function buildPromotionQueue(entries: KnowledgeEntry[]): CortexConsolidationSnapshot["promotionQueue"] {
  const byTitle = new Map<string, KnowledgeEntry[]>();
  for (const entry of entries) {
    if (entry.frontmatter.scope === "global" || entry.frontmatter.evidence_tier === "agent_inference") continue;
    const key = normalizeComparable(entry.frontmatter.title);
    const bucket = byTitle.get(key);
    if (bucket) bucket.push(entry);
    else byTitle.set(key, [entry]);
  }
  return Array.from(byTitle.values())
    .map((group) => ({
      id: normalizeComparable(group[0]?.frontmatter.title ?? "").replace(/\s+/g, "-"),
      title: group[0]?.frontmatter.title ?? "",
      profileScopes: Array.from(new Set(group.map((entry) => entry.frontmatter.scope))).sort(),
      supportCount: group.reduce((sum, entry) => sum + entry.frontmatter.support_count, 0),
    }))
    .filter((item) => item.profileScopes.length >= 3);
}
