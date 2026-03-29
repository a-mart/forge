import { describe, expect, it } from "vitest";
import {
  isTrackedVersionedPath,
  resolveTrackedVersionedPathReference,
  resolveVersionedPathMetadata
} from "../versioned-paths.js";

describe("versioned-paths", () => {
  const dataDir = "/tmp/forge-versioned-paths";

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
    expect(isTrackedVersionedPath(dataDir, `${dataDir}/shared/knowledge/.cortex-review-log.jsonl`)).toBe(false);
    expect(isTrackedVersionedPath(dataDir, `${dataDir}/shared/knowledge/.cortex-review-runs.json`)).toBe(false);
    expect(isTrackedVersionedPath(dataDir, `${dataDir}/shared/knowledge/.cortex-lock.json`)).toBe(false);
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

  it("maps absolute tracked files to git paths and preserves relative tracked paths", () => {
    expect(
      resolveTrackedVersionedPathReference(dataDir, `${dataDir}/profiles/alpha/memory.md`)
    ).toEqual({
      gitPath: "profiles/alpha/memory.md",
      relativePath: "profiles/alpha/memory.md",
      profileId: "alpha",
      surface: "memory"
    });

    expect(resolveTrackedVersionedPathReference(dataDir, "shared/knowledge/common.md")).toEqual({
      gitPath: "shared/knowledge/common.md",
      relativePath: "shared/knowledge/common.md",
      profileId: "cortex",
      surface: "knowledge"
    });
  });

  it("rejects non-tracked and outside-repo path references", () => {
    expect(resolveTrackedVersionedPathReference(dataDir, `${dataDir}/shared/secrets.json`)).toBeUndefined();
    expect(resolveTrackedVersionedPathReference(dataDir, `/etc/passwd`)).toBeUndefined();
    expect(resolveTrackedVersionedPathReference(dataDir, "../outside.md")).toBeUndefined();
  });
});
