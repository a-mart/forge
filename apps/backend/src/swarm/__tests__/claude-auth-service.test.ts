import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAuthService, extractClaudeAuthorizationUrl } from "../runtime/claude/claude-auth-service.js";
import type { SwarmConfig } from "../types.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), signedIn: vi.fn(), env: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../runtime/claude/claude-runtime-environment.js", () => ({
  resolveClaudeExecutable: async () => "/bundled/claude",
  claudeRuntimeEnvironment: mocks.env, isClaudeSignedIn: mocks.signedIn,
}));

class Child extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill = vi.fn((signal: string) => { this.signalCode = signal; queueMicrotask(() => this.emit("close", null)); return true; });
  close(code: number) { this.exitCode = code; this.emit("close", code); }
}
let child: Child;
let service: ClaudeAuthService;
beforeEach(() => {
  child = new Child(); mocks.spawn.mockReset().mockReturnValue(child);
  mocks.signedIn.mockReset().mockResolvedValue(false);
  mocks.env.mockReset().mockResolvedValue({ HOME: "/same-home", CLAUDE_CONFIG_DIR: "/same-config" });
  service = new ClaudeAuthService({} as SwarmConfig);
});
afterEach(async () => { await service.shutdown(); vi.useRealTimers(); });

describe("native Claude sign-in", () => {
  it("owns one login and sends a code only to stdin; confirms the saved credentials after exit", async () => {
    const first = await service.start();
    expect((await service.start()).flowId).toBe(first.flowId);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.spawn).toHaveBeenCalledWith("/bundled/claude", ["auth", "login", "--claudeai"], expect.objectContaining({ env: { HOME: "/same-home", CLAUDE_CONFIG_DIR: "/same-config" } }));
    child.stdout.write("Opening browser\nhttps://claude.ai/oauth/author");
    expect((await service.status()).authorizationUrl).toBeUndefined();
    child.stdout.write("ize?state=fixture&client_id=fixture\nPaste code here if prompted > ");
    expect((await service.status()).phase).toBe("waiting");
    service.submitCode(first.flowId!, "PRIVATE_CODE#fixture");
    expect(child.stdin.read().toString()).toBe("PRIVATE_CODE#fixture\n");
    expect(JSON.stringify(await service.status())).not.toContain("PRIVATE_CODE");
    expect(() => service.submitCode("expired-id", "x#y")).toThrow("has ended");
    mocks.signedIn.mockResolvedValue(true);
    child.close(0);
    await vi.waitFor(async () => expect((await service.status()).connected).toBe(true));
    expect((await service.status()).authorizationUrl).toBeUndefined();
  });
  it("does not report connected when a successful CLI exit failed to persist login", async () => {
    await service.start(); child.close(0);
    await vi.waitFor(async () => expect((await service.status()).phase).toBe("error"));
    expect((await service.status()).message).toContain("cannot read the saved login");
  });
  it("drops raw output on failure and can retry without restarting Forge", async () => {
    await service.start(); child.stderr.write("fetch failed PRIVATE_TOKEN"); child.close(1);
    await vi.waitFor(async () => expect((await service.status()).phase).toBe("error"));
    expect((await service.status()).message).toContain("network connection");
    expect(JSON.stringify(await service.status())).not.toContain("PRIVATE_TOKEN");
    child = new Child(); mocks.spawn.mockReturnValue(child);
    expect((await service.start()).phase).toBe("starting");
  });
  it("cancels only the matching flow and awaits child termination", async () => {
    const first = await service.start();
    await service.cancel("stale-id"); expect(child.kill).not.toHaveBeenCalled();
    await service.cancel(first.flowId!); expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect((await service.status()).phase).toBe("idle");
  });
  it("times out abandoned login processes and removes the transient URL", async () => {
    vi.useFakeTimers(); await service.start();
    child.stdout.write("https://claude.ai/oauth/authorize?state=fixture\n");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect((await service.status()).message).toContain("timed out");
    expect((await service.status()).authorizationUrl).toBeUndefined();
  });
  it("keeps API-key billing explicit", async () => {
    mocks.env.mockResolvedValue({ ANTHROPIC_API_KEY: "PRIVATE_API_KEY" });
    const state = await service.start();
    expect(state.message).toContain("API-key billing");
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(JSON.stringify(state)).not.toContain("PRIVATE_API_KEY");
  });
  it("allows only complete official authorization URLs", () => {
    expect(extractClaudeAuthorizationUrl("https://claude.ai/oauth/authorize?state=partial")).toBeUndefined();
    expect(extractClaudeAuthorizationUrl("https://claude.ai.evil.test/oauth/authorize\n")).toBeUndefined();
    expect(extractClaudeAuthorizationUrl("https://claude.ai/other\n")).toBeUndefined();
    expect(extractClaudeAuthorizationUrl("https://user:pass@claude.ai/oauth/authorize\n")).toBeUndefined();
    expect(extractClaudeAuthorizationUrl("https://claude.ai/oauth/authorize?state=ok\n")).toBe("https://claude.ai/oauth/authorize?state=ok");
    expect(extractClaudeAuthorizationUrl("https://claude.com/cai/oauth/authorize?state=ok\n")).toBe("https://claude.com/cai/oauth/authorize?state=ok");
  });
});
