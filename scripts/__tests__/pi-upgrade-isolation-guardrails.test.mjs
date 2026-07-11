#!/usr/bin/env node
/**
 * Unit tests for isolation guardrails (no secrets, no network).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertIsolatedBackendPort,
  assertIsolatedForgeDataDir,
  assertIsolatedUiPort,
  assertViteWsUrlMatchesBackend,
} from "../pi-upgrade/assert-isolation.mjs";

const repoRoot = join(import.meta.dirname, "..", "..");

describe("pi-upgrade isolation guardrails", () => {
  it("refuses production ~/.forge data dir", () => {
    expect(() => assertIsolatedForgeDataDir(join(homedir(), ".forge"))).toThrow(/refuses/);
  });

  it("refuses paths nested inside production ~/.forge", () => {
    expect(() => assertIsolatedForgeDataDir(join(homedir(), ".forge", "nested-copy"))).toThrow(
      /inside production|refuses/,
    );
  });

  it("refuses reserved backend ports", () => {
    for (const port of [47187, 47287, 47387]) {
      expect(() => assertIsolatedBackendPort(port)).toThrow(/reserved/);
    }
  });

  it("accepts worktree backend port 47687", () => {
    expect(assertIsolatedBackendPort(47687)).toBe(47687);
  });

  it("refuses reserved UI ports", () => {
    for (const port of [47188, 47189, 47388]) {
      expect(() => assertIsolatedUiPort(port)).toThrow(/reserved/);
    }
  });

  it("requires VITE_FORGE_WS_URL to match backend port", () => {
    expect(() => assertViteWsUrlMatchesBackend("ws://127.0.0.1:47287", 47687)).toThrow(
      /VITE_FORGE_WS_URL/,
    );
    expect(assertViteWsUrlMatchesBackend("ws://127.0.0.1:47687", 47687)).toBe(
      "ws://127.0.0.1:47687",
    );
  });

  it("launcher requires vacant ports and binds health to recorded child identity", () => {
    const script = readFileSync(join(repoRoot, "scripts/pi-upgrade/start-isolated-instance.sh"), "utf8");
    expect(script).toContain("refusing to adopt an existing listener");
    expect(script).toContain("FORGE_PI_UPGRADE_INSTANCE_NONCE");
    expect(script).toContain("backend health did not match recorded child/data/nonce identity");
    expect(script).toContain("isolated identity is empty");
  });

  it("stop script kills only recorded nonce-verified owned PIDs, never arbitrary listeners", () => {
    const script = readFileSync(join(repoRoot, "scripts/pi-upgrade/stop-isolated-instance.sh"), "utf8");
    expect(script).toContain("stop_recorded_pid");
    expect(script).toContain("refusing to stop");
    expect(script).toContain("nonce mismatch");
    expect(script).toContain("refusing arbitrary kill");
    expect(script).not.toMatch(/kill \$pids/);
  });
});
