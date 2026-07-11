#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildAllManifests,
  stableManifestForCompare,
} from "../pi-upgrade/generate-pi-session-fixture-manifests.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("pi session fixture manifest generator", () => {
  it("check mode equivalent: committed manifests match regenerated provenance", () => {
    const built = buildAllManifests({ generatedAt: "fixed" });
    for (const { manifestPath, manifest } of built) {
      const committed = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(committed.producingCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(committed.producingCommit).not.toMatch(/wp-8/i);
      expect(committed.forgeCommit).toBe(committed.producingCommit);
      expect(committed.generation.script).toBe(
        "scripts/pi-upgrade/generate-pi-session-fixture-manifests.mjs",
      );
      expect(stableManifestForCompare(committed)).toEqual(stableManifestForCompare(manifest));
    }
  });

  it("records absolute patch sha256 files that exist in the repo", () => {
    const [{ manifest }] = buildAllManifests({ generatedAt: "fixed" });
    for (const patch of manifest.generation.targetPi.patches) {
      expect(patch.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(readFileSync(join(repoRoot, patch.patchFile)).length).toBeGreaterThan(0);
    }
  });
});
