import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistedProjectAgentConfig } from "@forge/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteProjectAgentRecord,
  readProjectAgentRecord,
  reconcileProjectAgentStorage,
  renameProjectAgentRecord,
  scanProjectAgentRecords,
  writeProjectAgentRecord
} from "../project-agent-storage.js";
import {
  getProjectAgentConfigPath,
  getProjectAgentDir,
  getProjectAgentPromptPath,
  getProjectAgentsDir
} from "../data-paths.js";
import type { AgentDescriptor } from "../types.js";

const tempRoots: string[] = [];

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createTempDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "project-agent-storage-"));
  tempRoots.push(root);
  return root;
}

function makeConfig(overrides: Partial<PersistedProjectAgentConfig> & Pick<PersistedProjectAgentConfig, "agentId" | "handle" | "whenToUse">): PersistedProjectAgentConfig {
  return {
    version: 1,
    agentId: overrides.agentId,
    handle: overrides.handle,
    whenToUse: overrides.whenToUse,
    promotedAt: overrides.promotedAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-02T00:00:00.000Z",
    ...(overrides.creatorSessionId !== undefined ? { creatorSessionId: overrides.creatorSessionId } : {})
  };
}

function makeDescriptor(
  overrides: Partial<AgentDescriptor> & Pick<AgentDescriptor, "agentId">
): AgentDescriptor {
  return {
    agentId: overrides.agentId,
    displayName: overrides.displayName ?? overrides.agentId,
    role: overrides.role ?? "manager",
    managerId: overrides.managerId ?? overrides.agentId,
    status: overrides.status ?? "idle",
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-02T00:00:00.000Z",
    cwd: overrides.cwd ?? "/tmp/project",
    model: overrides.model ?? {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "medium"
    },
    sessionFile: overrides.sessionFile ?? join("/tmp", `${overrides.agentId}.jsonl`),
    profileId: overrides.profileId ?? "profile-a",
    sessionLabel: overrides.sessionLabel,
    projectAgent: overrides.projectAgent
  };
}

describe("project-agent-storage", () => {
  it("writes and reads a project agent record round-trip", async () => {
    const dataDir = await createTempDataDir();
    const config = makeConfig({
      agentId: "agent-1",
      handle: "release-notes",
      whenToUse: "Draft release notes",
      creatorSessionId: "creator-1"
    });

    await writeProjectAgentRecord(dataDir, "profile-a", config, "You are the release notes agent.");

    const record = await readProjectAgentRecord(dataDir, "profile-a", "release-notes");

    expect(record).toEqual({
      config,
      systemPrompt: "You are the release notes agent.",
      dirPath: getProjectAgentDir(dataDir, "profile-a", "release-notes")
    });
    await expect(readFile(getProjectAgentPromptPath(dataDir, "profile-a", "release-notes"), "utf8")).resolves.toBe(
      "You are the release notes agent."
    );
  });

  it("writes null systemPrompt without creating prompt.md", async () => {
    const dataDir = await createTempDataDir();
    const config = makeConfig({
      agentId: "agent-1",
      handle: "qa",
      whenToUse: "Reproduce issues"
    });

    await writeProjectAgentRecord(dataDir, "profile-a", config, null);

    const record = await readProjectAgentRecord(dataDir, "profile-a", "qa");
    expect(record?.systemPrompt).toBeNull();
    await expect(access(getProjectAgentPromptPath(dataDir, "profile-a", "qa"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads missing config.json as null", async () => {
    const dataDir = await createTempDataDir();
    const promptPath = getProjectAgentPromptPath(dataDir, "profile-a", "missing");
    await mkdir(getProjectAgentDir(dataDir, "profile-a", "missing"), { recursive: true });
    await writeFile(promptPath, "orphan prompt", "utf8");

    await expect(readProjectAgentRecord(dataDir, "profile-a", "missing")).resolves.toBeNull();
  });

  it("reads invalid config.json as null", async () => {
    const dataDir = await createTempDataDir();
    const configPath = getProjectAgentConfigPath(dataDir, "profile-a", "broken");
    await mkdir(getProjectAgentDir(dataDir, "profile-a", "broken"), { recursive: true });
    await writeFile(configPath, "{not-json", "utf8");

    await expect(readProjectAgentRecord(dataDir, "profile-a", "broken")).resolves.toBeNull();
  });

  it("scans multiple project agent records", async () => {
    const dataDir = await createTempDataDir();

    await writeProjectAgentRecord(
      dataDir,
      "profile-a",
      makeConfig({ agentId: "agent-1", handle: "alpha", whenToUse: "Alpha tasks" }),
      "Prompt alpha"
    );
    await writeProjectAgentRecord(
      dataDir,
      "profile-a",
      makeConfig({ agentId: "agent-2", handle: "beta", whenToUse: "Beta tasks" }),
      null
    );

    const records = await scanProjectAgentRecords(dataDir, "profile-a");

    expect(records.map((record) => record.config.handle).sort()).toEqual(["alpha", "beta"]);
    expect(records.find((record) => record.config.handle === "alpha")?.systemPrompt).toBe("Prompt alpha");
    expect(records.find((record) => record.config.handle === "beta")?.systemPrompt).toBeNull();
  });

  it("renames a project agent record by writing the new directory and deleting the old one", async () => {
    const dataDir = await createTempDataDir();
    const initialConfig = makeConfig({ agentId: "agent-1", handle: "old-handle", whenToUse: "Old tasks" });
    const renamedConfig = makeConfig({ agentId: "agent-1", handle: "new-handle", whenToUse: "New tasks" });
    await writeProjectAgentRecord(dataDir, "profile-a", initialConfig, "Old prompt");

    await renameProjectAgentRecord(dataDir, "profile-a", "old-handle", "new-handle", renamedConfig, "New prompt");

    await expect(access(getProjectAgentDir(dataDir, "profile-a", "old-handle"))).rejects.toMatchObject({ code: "ENOENT" });
    const record = await readProjectAgentRecord(dataDir, "profile-a", "new-handle");
    expect(record?.config.handle).toBe("new-handle");
    expect(record?.systemPrompt).toBe("New prompt");
  });

  it("deletes a project agent record directory", async () => {
    const dataDir = await createTempDataDir();
    await writeProjectAgentRecord(
      dataDir,
      "profile-a",
      makeConfig({ agentId: "agent-1", handle: "release-notes", whenToUse: "Draft release notes" }),
      "Prompt"
    );

    await deleteProjectAgentRecord(dataDir, "profile-a", "release-notes");

    await expect(access(getProjectAgentDir(dataDir, "profile-a", "release-notes"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconciles rule 1 by materializing missing directories from descriptors", async () => {
    const dataDir = await createTempDataDir();
    const descriptor = makeDescriptor({
      agentId: "agent-1",
      projectAgent: {
        handle: "release-notes",
        whenToUse: "Draft release notes",
        systemPrompt: "Stored in descriptor",
        creatorSessionId: "creator-1"
      }
    });

    const result = await reconcileProjectAgentStorage(dataDir, "profile-a", new Map([[descriptor.agentId, descriptor]]));

    expect(result.materialized).toEqual(["agent-1"]);
    const record = await readProjectAgentRecord(dataDir, "profile-a", "release-notes");
    expect(record).not.toBeNull();
    expect(record?.config.agentId).toBe("agent-1");
    expect(record?.config.handle).toBe("release-notes");
    expect(record?.config.whenToUse).toBe("Draft release notes");
    expect(record?.config.creatorSessionId).toBe("creator-1");
    expect(record?.config.promotedAt).toBe(descriptor.createdAt);
    expect(record?.systemPrompt).toBe("Stored in descriptor");
  });

  it("reconciles rule 2 by hydrating a matching descriptor from disk", async () => {
    const dataDir = await createTempDataDir();
    await writeProjectAgentRecord(
      dataDir,
      "profile-a",
      makeConfig({
        agentId: "agent-1",
        handle: "release-notes",
        whenToUse: "Updated from disk",
        creatorSessionId: "creator-disk"
      }),
      "Disk prompt"
    );

    const descriptor = makeDescriptor({
      agentId: "agent-1",
      projectAgent: {
        handle: "release-notes",
        whenToUse: "Outdated descriptor",
        systemPrompt: "Old prompt",
        creatorSessionId: "creator-old"
      }
    });

    const result = await reconcileProjectAgentStorage(dataDir, "profile-a", new Map([[descriptor.agentId, descriptor]]));

    expect(result.hydrated).toEqual(["agent-1"]);
    expect(descriptor.projectAgent).toEqual({
      handle: "release-notes",
      whenToUse: "Updated from disk",
      systemPrompt: "Disk prompt",
      creatorSessionId: "creator-disk"
    });
  });

  it("reconciles rule 3 by removing orphan directories", async () => {
    const dataDir = await createTempDataDir();
    await writeProjectAgentRecord(
      dataDir,
      "profile-a",
      makeConfig({ agentId: "orphan-agent", handle: "orphan", whenToUse: "Nobody owns this" }),
      "Prompt"
    );

    const result = await reconcileProjectAgentStorage(dataDir, "profile-a", new Map());

    expect(result.orphansRemoved).toEqual(["orphan"]);
    await expect(access(getProjectAgentDir(dataDir, "profile-a", "orphan"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconciles rule 4 by keeping the newest duplicate directory and deleting older ones", async () => {
    const dataDir = await createTempDataDir();
    const descriptor = makeDescriptor({
      agentId: "agent-1",
      projectAgent: {
        handle: "legacy-handle",
        whenToUse: "Outdated descriptor",
        systemPrompt: "Outdated prompt"
      }
    });

    await writeProjectAgentRecord(
      dataDir,
      "profile-a",
      makeConfig({
        agentId: "agent-1",
        handle: "legacy-handle",
        whenToUse: "Legacy data",
        updatedAt: "2026-04-01T00:00:00.000Z"
      }),
      "Legacy prompt"
    );
    await writeProjectAgentRecord(
      dataDir,
      "profile-a",
      makeConfig({
        agentId: "agent-1",
        handle: "current-handle",
        whenToUse: "Current data",
        updatedAt: "2026-04-03T00:00:00.000Z"
      }),
      "Current prompt"
    );

    const result = await reconcileProjectAgentStorage(dataDir, "profile-a", new Map([[descriptor.agentId, descriptor]]));

    expect(result.hydrated).toEqual(["agent-1"]);
    await expect(access(getProjectAgentDir(dataDir, "profile-a", "legacy-handle"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(getProjectAgentDir(dataDir, "profile-a", "current-handle"))).resolves.toBeUndefined();
    expect(descriptor.projectAgent).toEqual({
      handle: "current-handle",
      whenToUse: "Current data",
      systemPrompt: "Current prompt"
    });
  });

  it("scans the profile project-agents directory only", async () => {
    const dataDir = await createTempDataDir();
    await writeProjectAgentRecord(
      dataDir,
      "profile-a",
      makeConfig({ agentId: "agent-1", handle: "alpha", whenToUse: "Alpha tasks" }),
      null
    );
    await writeProjectAgentRecord(
      dataDir,
      "profile-b",
      makeConfig({ agentId: "agent-2", handle: "beta", whenToUse: "Beta tasks" }),
      null
    );

    const records = await scanProjectAgentRecords(dataDir, "profile-a");

    expect(records).toHaveLength(1);
    expect(records[0]?.config.handle).toBe("alpha");
    await expect(access(getProjectAgentsDir(dataDir, "profile-b"))).resolves.toBeUndefined();
  });
});
