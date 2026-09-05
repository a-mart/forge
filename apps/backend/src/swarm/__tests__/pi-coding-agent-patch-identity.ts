import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

export function findRepoRootFromTest(url: string): string {
  return join(dirname(fileURLToPath(url)), "../../../../..");
}

export function findInstalledPiCodingAgentFile(url: string, relativePath: string): string {
  let current = dirname(fileURLToPath(url));
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(current, "node_modules", "@earendil-works", "pi-coding-agent", relativePath);
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      current = dirname(current);
    }
  }
  throw new Error(`Unable to locate installed pi-coding-agent ${relativePath}`);
}

export function readCurrentPiCodingAgentPatchDigest(repoRoot: string): string {
  const patchPath = join(repoRoot, "patches/@earendil-works__pi-coding-agent@0.80.6.patch");
  return createHash("sha256").update(readFileSync(patchPath)).digest("hex");
}

export function readLockfilePiCodingAgentPatchDigest(repoRoot: string): string {
  const lockfile = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const match = lockfile.match(/'@earendil-works\/pi-coding-agent@0\.80\.6':\n\s+hash: ([0-9a-f]{64})/);
  if (!match?.[1]) {
    throw new Error("Unable to read pi-coding-agent patch hash from pnpm-lock.yaml");
  }
  return match[1];
}

export function expectInstalledPiCodingAgentPatchIdentity(url: string, source: string): void {
  const repoRoot = findRepoRootFromTest(url);
  const currentDigest = readCurrentPiCodingAgentPatchDigest(repoRoot);
  expect(currentDigest).toBe(readLockfilePiCodingAgentPatchDigest(repoRoot));
  expect(source).toContain("setFreshContextHandler(handler)");
  expect(source).toContain("_commitCompaction(");
  expect(source).toContain("appendCustomEntry(\"forge_context_boundary\"");
  expect(source).toContain("this.sessionManager.getEntry(compactionId)");
}
