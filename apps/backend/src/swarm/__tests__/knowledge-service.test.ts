import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSwarmTools } from "../swarm-tools.js";
import {
  KnowledgeService,
  type KnowledgeEntryScope,
  type KnowledgeEntrySource,
} from "../knowledge-service.js";
import { createKnowledgeConsolidatorApi, type KnowledgeConsolidatorApi } from "../knowledge-consolidator-api.js";
import type { AgentDescriptor } from "../types.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import type { VersioningMutation, VersioningMutationSink } from "../../versioning/versioning-types.js";

const source = (session = "s1"): KnowledgeEntrySource => ({
  kind: "observed",
  session,
  at: "2026-07-05T12:00:00.000Z",
});

describe("KnowledgeService", () => {
  it("validates schema fields and body cap", async () => {
    const service = createService(await tempDir());
    await expect(
      service.upsertEntry({
        type: "preference",
        scope: "global",
        title: "No sources",
        body: "short",
        evidenceTier: "explicit_user",
        sources: [],
      }),
    ).rejects.toMatchObject({ code: "missing_sources" });
    await expect(
      service.upsertEntry({
        type: "preference",
        scope: "bad" as KnowledgeEntryScope,
        title: "Bad scope",
        body: "short",
        evidenceTier: "explicit_user",
        sources: [source()],
      }),
    ).rejects.toMatchObject({ code: "bad_scope" });
    await expect(
      service.upsertEntry({
        type: "gotcha",
        scope: "global",
        title: "Too long",
        body: Array.from({ length: 121 }, (_, i) => `word${i}`).join(" "),
        evidenceTier: "agent_inference",
        sources: [source()],
      }),
    ).rejects.toMatchObject({ code: "body_token_cap" });
  });

  it("rejects optimistic concurrency conflicts", async () => {
    const service = createService(await tempDir());
    const entry = await service.upsertEntry(baseEntry("Conflict"));
    await expect(
      service.upsertEntry({
        ...baseEntry("Conflict"),
        id: entry.frontmatter.id,
        expectedVersion: entry.frontmatter.version - 1,
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });

  it("regenerates an index under cap pressure using importance, support, and recency ordering", async () => {
    const dataDir = await tempDir();
    const service = createService(dataDir, { global: 80, profile: 80 });
    await service.upsertEntry({ ...baseEntry("Normal old"), importance: "normal" });
    await service.upsertEntry({ ...baseEntry("Pinned newest"), importance: "pinned" });
    await service.upsertEntry({ ...baseEntry("High newest"), importance: "high" });

    const index = await service.regenerateIndex("global");
    const content = await readFile(index.path, "utf8");
    expect(content).toContain("pinned-newest");
    expect(content).toContain("high-newest");
    expect(index.demotedEntryIds).toContain("preference-normal-old");
  });

  it("exposes a consolidator API without create and carries source ids on merge", async () => {
    type HasCreate = "create" extends keyof KnowledgeConsolidatorApi ? true : false;
    const hasCreate: HasCreate = false;
    expect(hasCreate).toBe(false);

    const service = createService(await tempDir());
    const first = await service.upsertEntry(baseEntry("Merge A"));
    const second = await service.upsertEntry(baseEntry("Merge B", "s2"));
    const api = createKnowledgeConsolidatorApi(service);
    expect("create" in api).toBe(false);

    const merged = await api.merge([first.frontmatter.id, second.frontmatter.id]);
    expect(merged.frontmatter.source_entry_ids).toEqual(
      expect.arrayContaining([first.frontmatter.id, second.frontmatter.id]),
    );
    await expect(service.readEntry(second.frontmatter.id)).resolves.toMatchObject({
      frontmatter: { status: "superseded", supersedes: [first.frontmatter.id] },
    });
  });

  it("deduplicates save_learning by title and bumps support count", async () => {
    const service = createService(await tempDir());
    const first = await service.saveLearning({
      type: "gotcha",
      scope: "profile:alpha",
      title: "Parallels realpath trust key",
      body: "Use the resolved path for trust checks.",
      evidence: "observed",
      sessionId: "s1",
    });
    const second = await service.saveLearning({
      type: "gotcha",
      scope: "profile:alpha",
      title: "Parallels realpath trust key",
      body: "Use the resolved path for trust checks.",
      evidence: "observed",
      sessionId: "s2",
    });
    expect(second.frontmatter.id).toBe(first.frontmatter.id);
    expect(second.frontmatter.support_count).toBe(2);
    expect((await service.readEntry(first.frontmatter.id)).frontmatter.support_count).toBe(2);
  });

  it("round-trips search and read through the knowledge tool", async () => {
    const service = createService(await tempDir());
    await service.upsertEntry(baseEntry("Tool round trip"));
    const tools = buildSwarmTools(createKnowledgeHost(service, true), descriptor("worker"));
    const knowledge = tools.find((tool) => tool.name === "knowledge");
    expect(knowledge).toBeDefined();

    const search = await knowledge!.execute("tc1", { action: "search", query: "round" });
    expect(search.details).toMatchObject({ results: [expect.objectContaining({ id: "preference-tool-round-trip" })] });
    const read = await knowledge!.execute("tc2", { action: "read", id: "preference-tool-round-trip" });
    expect(JSON.stringify(read.details)).toContain("Tool round trip");
  });

  it("gates knowledge and save_learning tools when the kill switch is off", async () => {
    const service = createService(await tempDir());
    const managerTools = buildSwarmTools(createKnowledgeHost(service, false), descriptor("manager"));
    await expect(
      managerTools.find((tool) => tool.name === "knowledge")!.execute("tc1", { action: "search", query: "x" }),
    ).rejects.toThrow("Knowledge v2 is disabled");
    await expect(
      managerTools.find((tool) => tool.name === "save_learning")!.execute("tc2", {
        type: "preference",
        scope: "global",
        title: "Disabled",
        body: "No write",
        evidence: "user-stated",
      }),
    ).rejects.toThrow("Knowledge v2 is disabled");
  });

  it("records versioning mutations on entry and index writes", async () => {
    const versioning = new RecordingVersioning();
    const service = createService(await tempDir(), undefined, versioning);
    await service.upsertEntry(baseEntry("Versioned write"));
    expect(versioning.mutations.map((mutation) => mutation.source)).toContain("knowledge-v2");
    expect(versioning.mutations.some((mutation) => mutation.path.endsWith("INDEX.md"))).toBe(true);
    expect(versioning.mutations.some((mutation) => mutation.path.endsWith("preference-versioned-write.md"))).toBe(true);
  });
});

function baseEntry(title: string, session = "s1") {
  return {
    type: "preference" as const,
    scope: "global" as const,
    title,
    body: `Remember ${title}.`,
    evidenceTier: "explicit_user" as const,
    sources: [source(session)],
  };
}

function createService(
  dataDir: string,
  caps = { global: 1_500, profile: 800 },
  versioning?: VersioningMutationSink,
): KnowledgeService {
  return new KnowledgeService({
    dataDir,
    settingsService: {
      getSettings: () => ({
        enabled: true,
        legacyCleanupConfirmed: false,
        indexCaps: caps,
        updatedAt: null,
      }),
    },
    versioning,
    now: () => new Date("2026-07-05T12:00:00.000Z"),
  });
}

function createKnowledgeHost(service: KnowledgeService, enabled: boolean): SwarmToolHost {
  const assertEnabled = () => {
    if (!enabled) throw new Error("Knowledge v2 is disabled in Settings.");
  };
  return {
    listAgents: () => [],
    getWorkerActivity: () => undefined,
    spawnAgent: async () => descriptor("worker"),
    killAgent: async () => undefined,
    sendMessage: async () => ({ targetAgentId: "manager", deliveryId: "d1", acceptedMode: "auto" }),
    createSessionFromAgent: async () => ({ sessionAgentId: "s1", sessionLabel: "S", profileId: "manager" }),
    publishToUser: async () => ({ targetContext: { channel: "web" } }),
    requestUserChoice: async () => [],
    updatePlan: async (_agentId, _toolCallId, input) => ({
      sessionAgentId: "manager",
      revision: 1,
      updatedAt: new Date().toISOString(),
      ...input,
    }),
    searchKnowledge: async (_caller, input) => {
      assertEnabled();
      return service.searchEntries(input);
    },
    readKnowledgeEntry: async (_caller, id) => {
      assertEnabled();
      return service.readEntry(id);
    },
    saveLearning: async (_caller, input) => {
      assertEnabled();
      return service.saveLearning({ ...input, sessionId: "manager" });
    },
  };
}

function descriptor(role: "manager" | "worker"): AgentDescriptor {
  return {
    agentId: role,
    role,
    managerId: "manager",
    status: "idle",
    cwd: "/tmp",
    createdAt: "2026-07-05T12:00:00.000Z",
    updatedAt: "2026-07-05T12:00:00.000Z",
    profileId: "manager",
    sessionFile: "/tmp/session.jsonl",
    model: { provider: "openai-codex", modelId: "gpt-5.5", reasoningLevel: "low" },
  } as AgentDescriptor;
}

class RecordingVersioning implements VersioningMutationSink {
  readonly mutations: VersioningMutation[] = [];
  isTrackedPath(): boolean {
    return true;
  }
  async recordMutation(mutation: VersioningMutation): Promise<boolean> {
    this.mutations.push(mutation);
    return true;
  }
  async flushPending(): Promise<void> {}
  async reconcileNow(): Promise<void> {}
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forge-knowledge-service-"));
}
