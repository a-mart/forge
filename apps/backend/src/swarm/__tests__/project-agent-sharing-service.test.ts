import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagerProfile } from "@forge/protocol";
import { getProjectAgentSharingStorePath } from "../storage/data-paths.js";
import {
  ProjectAgentSharingService,
  deriveProjectAgentShareNamespace,
  sanitizeProjectAgentPromptMetadata,
} from "../project-agent-sharing-service.js";
import type { AgentDescriptor } from "../types.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function makeProfile(profileId: string, overrides: Partial<ManagerProfile> = {}): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: profileId,
    defaultModel: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeProjectAgent(
  agentId: string,
  profileId: string,
  handle: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: "manager",
    managerId: agentId,
    profileId,
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
    projectAgent: {
      handle,
      whenToUse: "Maintains docs",
    },
    ...overrides,
  };
}

async function createService(options: {
  profiles?: ManagerProfile[];
  descriptors?: AgentDescriptor[];
}) {
  const root = await mkdtemp(join(tmpdir(), "project-agent-sharing-service-"));
  tempRoots.push(root);
  const dataDir = join(root, "data");

  const profiles = options.profiles ?? [];
  const descriptors = new Map((options.descriptors ?? []).map((descriptor) => [descriptor.agentId, descriptor]));

  const service = new ProjectAgentSharingService({
    dataDir,
    now: () => "2026-05-31T12:00:00.000Z",
    getProfiles: () => profiles,
    getDescriptor: (agentId) => descriptors.get(agentId),
    getDescriptors: () => descriptors.values(),
  });

  return { service, dataDir, profiles, descriptors };
}

describe("sanitizeProjectAgentPromptMetadata", () => {
  it("strips control characters, bidi controls, and markdown punctuation", () => {
    expect(
      sanitizeProjectAgentPromptMetadata("Ignore\ninstructions`[link](x)`\u202Ehidden", {
        maxLength: 280,
      }),
    ).toBe("Ignore instructions'linkx'hidden");
  });

  it("caps overlong metadata", () => {
    expect(
      sanitizeProjectAgentPromptMetadata("x".repeat(120), {
        maxLength: 80,
      }).length,
    ).toBe(80);
  });
});

describe("deriveProjectAgentShareNamespace", () => {
  it("derives a stable namespace from the source project display name", () => {
    expect(
      deriveProjectAgentShareNamespace({
        sourceProfileDisplayName: "Forge Docs",
        sourceProfileId: "forge-profile",
        sourceHandle: "documentation",
        existingExternalAliases: [],
      }),
    ).toBe("forge-docs");
  });

  it("suffixes deterministically when the alias collides", () => {
    expect(
      deriveProjectAgentShareNamespace({
        sourceProfileDisplayName: "Forge",
        sourceProfileId: "forge-profile",
        sourceHandle: "documentation",
        existingExternalAliases: ["forge/documentation"],
      }),
    ).toBe("forge-rofile");
  });

  it("throws when no deterministic alias remains", () => {
    expect(() =>
      deriveProjectAgentShareNamespace({
        sourceProfileDisplayName: "Forge",
        sourceProfileId: "forge-profile",
        sourceHandle: "documentation",
        existingExternalAliases: ["forge/documentation", "forge-rofile/documentation"],
      }),
    ).toThrow(/unique share alias/i);
  });
});

describe("ProjectAgentSharingService", () => {
  it("starts empty when the store file is missing", async () => {
    const source = makeProjectAgent("docs--s1", "forge", "documentation");
    const { service } = await createService({
      profiles: [makeProfile("forge"), makeProfile("mobile")],
      descriptors: [source],
    });

    const snapshot = await service.getSharingSnapshot("docs--s1");
    expect(snapshot.grants).toEqual([]);
    expect(snapshot.eligibleTargets.map((target) => target.profileId)).toEqual(["mobile"]);
  });

  it("recovers from corrupt JSON by starting empty", async () => {
    const source = makeProjectAgent("docs--s1", "forge", "documentation");
    const { service, dataDir } = await createService({
      profiles: [makeProfile("forge"), makeProfile("mobile")],
      descriptors: [source],
    });

    await mkdir(join(dataDir, "shared", "state"), { recursive: true });
    await writeFile(getProjectAgentSharingStorePath(dataDir), "{not-json", "utf8");

    await service.load();
    const snapshot = await service.getSharingSnapshot("docs--s1");
    expect(snapshot.grants).toEqual([]);
  });

  it("creates, replaces, and revokes sharing targets atomically", async () => {
    const source = makeProjectAgent("docs--s1", "forge", "documentation", {
      sessionLabel: "Documentation",
    });
    const { service } = await createService({
      profiles: [
        makeProfile("forge", { displayName: "Forge" }),
        makeProfile("mobile", { displayName: "Mobile App" }),
        makeProfile("web", { displayName: "Web App" }),
      ],
      descriptors: [source],
    });

    const created = await service.replaceSharingTargets("docs--s1", ["mobile"]);
    expect(created.addedTargetProfileIds).toEqual(["mobile"]);
    expect(created.snapshot.grants).toHaveLength(1);
    expect(created.snapshot.grants[0]?.externalHandle).toBe("forge/documentation");

    const replaced = await service.replaceSharingTargets("docs--s1", ["web"]);
    expect(replaced.addedTargetProfileIds).toEqual(["web"]);
    expect(replaced.removedTargetProfileIds).toEqual(["mobile"]);
    expect(replaced.snapshot.grants).toHaveLength(1);
    expect(replaced.snapshot.grants[0]?.targetProfileId).toBe("web");
  });

  it("excludes cortex, collaboration, system, archived, and self targets", async () => {
    const source = makeProjectAgent("docs--s1", "forge", "documentation");
    const { service } = await createService({
      profiles: [
        makeProfile("forge"),
        makeProfile("mobile"),
        makeProfile("cortex", { profileType: "system" }),
        makeProfile("_collaboration", { profileType: "system" }),
        makeProfile("archived", { archivedAt: "2026-05-01T00:00:00.000Z" }),
      ],
      descriptors: [source],
    });

    const snapshot = await service.getSharingSnapshot("docs--s1");
    expect(snapshot.eligibleTargets.map((target) => target.profileId)).toEqual(["mobile"]);

    await expect(service.replaceSharingTargets("docs--s1", ["cortex"])).rejects.toThrow(/not eligible/i);
    await expect(service.replaceSharingTargets("docs--s1", ["forge"])).rejects.toThrow(/not eligible/i);
  });

  it("projects sanitized external directory entries for target profiles only", async () => {
    const source = makeProjectAgent("docs--s1", "forge", "documentation", {
      sessionLabel: "Docs\nAgent",
      projectAgent: {
        handle: "documentation",
        whenToUse: "Use for `[docs]`\u202E",
      },
    });
    const other = makeProjectAgent("qa--s1", "qa", "qa");
    const { service } = await createService({
      profiles: [makeProfile("forge", { displayName: "Forge" }), makeProfile("mobile"), makeProfile("qa")],
      descriptors: [source, other],
    });

    await service.replaceSharingTargets("docs--s1", ["mobile"]);
    await service.replaceSharingTargets("qa--s1", ["mobile"]);

    const entries = service.getExternalDirectoryEntries("mobile");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      agentId: "docs--s1",
      handle: "forge/documentation",
      displayName: "Docs Agent",
      whenToUse: "Use for 'docs'",
      sourceProjectName: "Forge",
      origin: "external",
    });
    expect(entries.some((entry) => entry.agentId === "qa--s1")).toBe(true);
  });

  it("hides inactive grants from external directory projection", async () => {
    const source = makeProjectAgent("docs--s1", "forge", "documentation");
    const { service, descriptors } = await createService({
      profiles: [makeProfile("forge", { displayName: "Forge" }), makeProfile("mobile")],
      descriptors: [source],
    });

    await service.replaceSharingTargets("docs--s1", ["mobile"]);
    descriptors.set("docs--s1", {
      ...source,
      archivedAt: "2026-05-02T00:00:00.000Z",
    });

    expect(service.getExternalDirectoryEntries("mobile")).toEqual([]);
  });

  it("reconciles stale grants and prunes contacts for missing entities", async () => {
    const source = makeProjectAgent("docs--s1", "forge", "documentation");
    const { service, dataDir, descriptors } = await createService({
      profiles: [makeProfile("forge"), makeProfile("mobile")],
      descriptors: [source],
    });

    await service.replaceSharingTargets("docs--s1", ["mobile"]);
    await service.save();

    descriptors.delete("docs--s1");
    const changed = await service.reconcile();
    expect(changed).toBe(true);

    const raw = JSON.parse(await readFile(getProjectAgentSharingStorePath(dataDir), "utf8")) as {
      grants: unknown[];
      contacts: unknown[];
    };
    expect(raw.grants).toEqual([]);
    expect(raw.contacts).toEqual([]);
  });

  it("authorizes active external access and records consuming sessions", async () => {
    const source = makeProjectAgent("docs--s1", "forge", "documentation");
    const { service, dataDir } = await createService({
      profiles: [makeProfile("forge", { displayName: "Forge" }), makeProfile("mobile")],
      descriptors: [source],
    });

    await service.replaceSharingTargets("docs--s1", ["mobile"]);

    await expect(service.hasActiveExternalAccess("docs--s1", "mobile")).resolves.toBe(true);
    await expect(service.hasActiveExternalAccess("docs--s1", "web")).resolves.toBe(false);
    await expect(service.authorizeExternalDelivery({
      senderAgentId: "mobile-session-1",
      senderProfileId: "mobile",
      targetAgentId: "docs--s1",
    })).resolves.toMatchObject({
      mode: "grant",
      sourceAgentId: "docs--s1",
      sourceProfileId: "forge",
      targetProfileId: "mobile",
    });

    await service.recordExternalContact("docs--s1", "mobile", "mobile-session-1");
    await expect(service.authorizeExternalDelivery({
      senderAgentId: "mobile-session-1",
      senderProfileId: "mobile",
      targetAgentId: "docs--s1",
    })).resolves.toMatchObject({
      mode: "grant",
      sourceAgentId: "docs--s1",
      targetProfileId: "mobile",
    });
    const raw = JSON.parse(await readFile(getProjectAgentSharingStorePath(dataDir), "utf8")) as {
      contacts: Array<{ targetSessionAgentId: string; targetProfileId: string }>;
    };
    expect(raw.contacts).toHaveLength(1);
    expect(raw.contacts[0]).toMatchObject({
      targetSessionAgentId: "mobile-session-1",
      targetProfileId: "mobile",
    });
  });

  it("authorizes direct contact replies back to the originating external session", async () => {
    const source = makeProjectAgent("docs--s1", "forge", "documentation");
    const { service } = await createService({
      profiles: [makeProfile("forge", { displayName: "Forge" }), makeProfile("mobile")],
      descriptors: [source],
    });

    await service.replaceSharingTargets("docs--s1", ["mobile"]);
    await service.recordExternalContact("docs--s1", "mobile", "mobile-session-1");

    await expect(service.authorizeExternalDelivery({
      senderAgentId: "docs--s1",
      senderProfileId: "forge",
      targetAgentId: "mobile-session-1",
    })).resolves.toMatchObject({
      mode: "contact_reply",
      sourceAgentId: "docs--s1",
      sourceProfileId: "forge",
      targetProfileId: "mobile",
    });

    await expect(service.authorizeExternalDelivery({
      senderAgentId: "docs--s1",
      senderProfileId: "forge",
      targetAgentId: "other-mobile-session",
    })).resolves.toBeNull();
  });

  it("source-owned sharing snapshot includes grant topology but external directory does not", async () => {
    const source = makeProjectAgent("docs--s1", "forge", "documentation");
    const { service } = await createService({
      profiles: [makeProfile("forge", { displayName: "Forge" }), makeProfile("mobile")],
      descriptors: [source],
    });

    await service.replaceSharingTargets("docs--s1", ["mobile"]);
    const snapshot = await service.getSharingSnapshot("docs--s1");
    expect(snapshot.grants[0]?.grantId).toBeTruthy();

    const entries = service.getExternalDirectoryEntries("mobile");
    expect(entries[0]).not.toHaveProperty("grantId");
    expect(entries[0]).not.toHaveProperty("targetProfileId");
  });
});
