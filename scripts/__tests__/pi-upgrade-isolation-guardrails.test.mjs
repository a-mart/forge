#!/usr/bin/env node
/**
 * Unit tests for isolation guardrails (no secrets, no network).
 */
import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertIsolatedBackendPort,
  assertIsolatedForgeDataDir,
  assertIsolatedUiPort,
  assertViteWsUrlMatchesBackend,
} from "../pi-upgrade/assert-isolation.mjs";

describe("pi-upgrade isolation guardrails", () => {
  it("refuses production ~/.forge data dir", () => {
    expect(() => assertIsolatedForgeDataDir(join(homedir(), ".forge"))).toThrow(/refuses/);
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
});
