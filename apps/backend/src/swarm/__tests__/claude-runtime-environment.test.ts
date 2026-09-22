import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertClaudeSetup, claudeRuntimeEnvironment, resolveClaudeExecutable } from "../runtime/claude/claude-runtime-environment.js";
import type { SwarmConfig } from "../types.js";

const exec = vi.hoisted(() => ({ version: "2.1.273 (Claude Code)", loggedIn: false }));
vi.mock("node:child_process", async importOriginal => {
  const { promisify } = await import("node:util");
  const execute = () => {};
  Object.defineProperty(execute, promisify.custom, { value: async (_file: string, args: string[]) => ({
    stdout: args[0] === "--version" ? exec.version : JSON.stringify({ loggedIn: exec.loggedIn }), stderr: "",
  }) });
  return { ...await importOriginal<typeof import("node:child_process")>(), execFile: execute };
});
afterEach(() => { exec.version = "2.1.273 (Claude Code)"; exec.loggedIn = false; });

describe("Claude native setup", () => {
  it("keeps native login separate and removes inherited provider/vault credentials", async () => {
    const env = await claudeRuntimeEnvironment({} as SwarmConfig, { HOME: "/fixture/home", PATH: "/fixture/bin", CLAUDE_CONFIG_DIR: "/fixture/claude",
      ANTHROPIC_API_KEY: "not-in-cli-mode", CLAUDE_CODE_OAUTH_TOKEN: "not-transferred", SECRET_PASSWORD: "not-inherited", OPENAI_API_KEY: "not-inherited" });
    expect(env).toMatchObject({ HOME: "/fixture/home", PATH: "/fixture/bin", CLAUDE_CONFIG_DIR: "/fixture/claude" });
    expect(JSON.stringify(env)).not.toContain("not-");
  });
  it("requires explicit API billing mode and accepts a configured API endpoint only there", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-claude-auth-"));
    try {
      const config = { paths: { dataDir: root, sharedAuthFile: join(root, "auth.json"), authFile: join(root, "legacy-auth.json") } } as SwarmConfig;
      const env = await claudeRuntimeEnvironment(config, { FORGE_CLAUDE_AUTH_MODE: "api_key", ANTHROPIC_API_KEY: "synthetic-api-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:1" });
      expect(env.ANTHROPIC_API_KEY).toBe("synthetic-api-key"); expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:1/");
      await expect(claudeRuntimeEnvironment(config, { FORGE_CLAUDE_AUTH_MODE: "api_key" })).rejects.toThrow("requires ANTHROPIC_API_KEY");
      await expect(claudeRuntimeEnvironment(config, { FORGE_CLAUDE_AUTH_MODE: "auto" })).rejects.toThrow("must be cli");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("provides a copyable login command without disclosing auth payloads", async () => {
    await expect(assertClaudeSetup("/path with space/claude", {})).rejects.toThrow("auth login");
    exec.loggedIn = true; await expect(assertClaudeSetup("/fixture/claude", {})).resolves.toBeUndefined();
  });
  it("provides bundled-runtime recovery and an update command for old overrides", async () => {
    exec.version = "2.1.259 (Claude Code)";
    await expect(assertClaudeSetup("/fixture/claude", {})).rejects.toThrow("claude update");
    exec.version = "unexpected version";
    await expect(assertClaudeSetup("/fixture/claude", {})).rejects.toThrow("unrecognized version response");
  });
  it.each(["C:\\Users\\Adam\\claude.cmd", "C:\\tools\\claude.ps1", "claude.exe"])("rejects an unsafe or ambiguous Windows override: %s", async path => {
    await expect(resolveClaudeExecutable({ CLAUDE_BIN: path }, "win32", "x64")).rejects.toThrow("absolute path to the native Claude executable");
  });
  it("resolves the installed platform package without requiring a global Claude CLI", async () => {
    expect(await resolveClaudeExecutable({})).toMatch(/claude(?:\.exe)?$/);
  });
});
