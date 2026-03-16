import { describe, expect, it } from "vitest";
import { isTrackedVersionedPath, resolveVersionedPathMetadata } from "../versioned-paths.js";

describe("versioned-paths", () => {
  const dataDir = "/tmp/middleman-versioned-paths";

  it("tracks the durable allowlisted knowledge, memory, reference, and prompt paths", () => {
    expect(isTrackedVersionedPath(dataDir, `${dataDir}/shared/knowledge/common.md`)).toBe(true);
    expect(isTrackedVersionedPath(dataDir, `${dataDir}/shared/knowledge/.cortex-notes.md`)).toBe(true);
    expect(isTrackedVersionedPath(dataDir, `${dataDir}/shared/knowledge/.cortex-worker-prompts.md`)).toBe(true);
    expect(isTrackedVersionedPath(dataDir, `${dataDir}/shared/knowledge/profiles/alpha.md`)).toBe(true);
    expect(isTrackedVersionedPath(dataDir, `${dataDir}/profiles/alpha/memory.md`)).toBe(true);
    expect(isTrackedVersionedPath(dataDir, `${dataDir}/profiles/alpha/reference/overview.md`)).toBe(true);
    expect(isTrackedVersionedPath(dataDir, `${dataDir}/profiles/alpha/prompts/archetypes/manager.md`)).toBe(true);
    expect(isTrackedVersionedPath(dataDir, `${dataDir}/profiles/alpha/prompts/operational/memory-merge.md`)).toBe(true);
  });

  it("rejects secrets, high-churn files, and backup files", () => {
    expect(isTrackedVersionedPath(dataDir, `${dataDir}/shared/secrets.json`)).toBe(false);
    expect(isTrackedVersionedPath(dataDir, `${dataDir}/shared/auth/auth.json`)).toBe(false);
    expect(isTrackedVersionedPath(dataDir, `${dataDir}/profiles/alpha/sessions/alpha/session.jsonl`)).toBe(false);
    expect(isTrackedVersionedPath(dataDir, `${dataDir}/profiles/alpha/sessions/alpha/meta.json`)).toBe(false);
    expect(isTrackedVersionedPath(dataDir, `${dataDir}/shared/knowledge/.cortex-worker-prompts.md.bak.1`)).toBe(false);
  });

  it("extracts path metadata for tracked prompt files", () => {
    expect(
      resolveVersionedPathMetadata(dataDir, `${dataDir}/profiles/alpha/prompts/archetypes/manager.md`)
    ).toEqual({
      relativePath: "profiles/alpha/prompts/archetypes/manager.md",
      profileId: "alpha",
      promptCategory: "archetype",
      promptId: "manager",
      surface: "prompt"
    });
  });
});
