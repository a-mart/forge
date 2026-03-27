import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EmbeddedGitVersioningService } from "../embedded-git-versioning-service.js";
import { parseVersioningCommitMetadata } from "../versioning-commit-metadata.js";

describe("parseVersioningCommitMetadata", () => {
  it("parses actual versioning-service bodies that use Source", async () => {
    const body = await buildCommitBody(
      ["shared/knowledge/common.md"],
      [
        {
          path: "shared/knowledge/common.md",
          action: "write",
          source: "api-write-file",
          profileId: "cortex",
          sessionId: "cortex--s1",
          agentId: "cortex-worker-1",
          promptCategory: "archetype",
          promptId: "review"
        }
      ],
      "manual"
    );

    expect(parseVersioningCommitMetadata(body)).toEqual({
      reason: "manual",
      source: "api-write-file",
      sources: ["api-write-file"],
      profileId: "cortex",
      sessionId: "cortex--s1",
      agentId: "cortex-worker-1",
      promptCategory: "archetype",
      promptId: "review",
      paths: ["shared/knowledge/common.md"]
    });
  });

  it("parses actual versioning-service bodies that use Sources", async () => {
    const body = await buildCommitBody(
      ["profiles/alpha/memory.md", "profiles/alpha/reference/guide.md"],
      [
        {
          path: "profiles/alpha/memory.md",
          action: "write",
          source: "profile-memory-merge",
          profileId: "alpha",
          sessionId: "alpha--s1"
        },
        {
          path: "profiles/alpha/reference/guide.md",
          action: "write",
          source: "reference-doc",
          profileId: "alpha"
        }
      ],
      "interval"
    );

    expect(parseVersioningCommitMetadata(body)).toEqual({
      reason: "interval",
      sources: ["profile-memory-merge", "reference-doc"],
      profileId: "alpha",
      sessionId: "alpha--s1",
      paths: ["profiles/alpha/memory.md", "profiles/alpha/reference/guide.md"]
    });
  });

  it("parses Paths lists directly", () => {
    const body = [
      "Reason: manual",
      "Source: reconcile",
      "Paths:",
      "- shared/knowledge/common.md",
      "- profiles/alpha/memory.md",
      "",
      "ignored trailing text"
    ].join("\n");

    expect(parseVersioningCommitMetadata(body)).toEqual({
      reason: "manual",
      source: "reconcile",
      sources: ["reconcile"],
      paths: ["shared/knowledge/common.md", "profiles/alpha/memory.md"]
    });
  });

  it("returns null for empty or unrecognized bodies", () => {
    expect(parseVersioningCommitMetadata("")).toBeNull();
    expect(parseVersioningCommitMetadata("plain commit body without structured fields")).toBeNull();
  });
});

async function buildCommitBody(
  stagedPaths: string[],
  mutations: Array<{
    path: string;
    action: "write" | "delete";
    source: string;
    profileId?: string;
    sessionId?: string;
    promptCategory?: "archetype" | "operational";
    promptId?: string;
    agentId?: string;
  }>,
  reason: string
): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "versioning-commit-metadata-"));
  const service = new EmbeddedGitVersioningService({
    dataDir,
    debounceMs: 10,
    reconcileIntervalMs: 0
  });

  await service.start();
  try {
    const built = await (service as any).buildCommitMessage(stagedPaths, mutations, reason);
    return built.body;
  } finally {
    await service.stop();
  }
}
