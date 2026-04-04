import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { ClaudeAuthResolver } from "../claude-auth-resolver.js";
import { claudeConfigDir, claudeSessionDir, claudeWorkerDir } from "../claude-data-paths.js";
import { getSharedAuthFilePath, getSharedSecretsFilePath } from "../data-paths.js";

const PROFILE_ID = "profile-alpha";
const SESSION_ID = "session-bravo";
const WORKER_ID = "worker-charlie";

const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
    return;
  }

  process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
});

describe("ClaudeAuthResolver", () => {
  it("resolves the stored Anthropic OAuth token", async () => {
    const dataDir = await createTempDataDir("claude-auth-oauth-");
    await writeAnthropicCredential(dataDir, {
      type: "oauth",
      accessToken: "oauth-access-token",
      refreshToken: "oauth-refresh-token"
    });
    process.env.ANTHROPIC_API_KEY = "sk-ant-env-fallback";

    const resolver = new ClaudeAuthResolver(dataDir);

    await expect(resolver.resolve()).resolves.toEqual({
      type: "oauth",
      token: "oauth-access-token"
    });
    await expect(resolver.isAvailable()).resolves.toBe(true);
  });

  it("falls back to the stored Anthropic API key when OAuth is unavailable", async () => {
    const dataDir = await createTempDataDir("claude-auth-api-key-");
    await writeAnthropicCredential(dataDir, {
      type: "api_key",
      key: "sk-ant-settings-key",
      access: "sk-ant-settings-key",
      refresh: "",
      expires: ""
    });

    const resolver = new ClaudeAuthResolver(dataDir);

    await expect(resolver.resolve()).resolves.toEqual({
      type: "api-key",
      token: "sk-ant-settings-key"
    });
  });

  it("throws a clear error when Anthropic credentials are missing", async () => {
    const dataDir = await createTempDataDir("claude-auth-missing-");
    delete process.env.ANTHROPIC_API_KEY;

    const resolver = new ClaudeAuthResolver(dataDir);

    await expect(resolver.resolve()).rejects.toThrow(
      "Anthropic credentials not configured. Add them in Settings → Providers."
    );
    await expect(resolver.isAvailable()).resolves.toBe(false);
  });

  it("builds Claude SDK env with isolated session storage", async () => {
    const dataDir = await createTempDataDir("claude-auth-build-env-");
    await writeSharedSecrets(dataDir, { ANTHROPIC_API_KEY: "sk-ant-managed-env" });

    const resolver = new ClaudeAuthResolver(dataDir);
    const sessionDataDir = claudeSessionDir(dataDir, PROFILE_ID, SESSION_ID);

    await expect(resolver.buildEnv(sessionDataDir)).resolves.toEqual({
      CLAUDE_CONFIG_DIR: sessionDataDir,
      ANTHROPIC_API_KEY: "sk-ant-managed-env"
    });
  });
});

describe("claude-data-paths", () => {
  it("resolves Claude config, session, and worker paths under the Forge data directory", async () => {
    const dataDir = await createTempDataDir("claude-data-paths-");

    expect(claudeConfigDir(dataDir)).toBe(join(dataDir, "shared", "claude-sdk"));
    expect(claudeSessionDir(dataDir, PROFILE_ID, SESSION_ID)).toBe(
      join(dataDir, "profiles", PROFILE_ID, "sessions", SESSION_ID, "claude")
    );
    expect(claudeWorkerDir(dataDir, PROFILE_ID, SESSION_ID, WORKER_ID)).toBe(
      join(dataDir, "profiles", PROFILE_ID, "sessions", SESSION_ID, "workers", WORKER_ID, "claude")
    );
  });
});

async function createTempDataDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeAnthropicCredential(dataDir: string, credential: Record<string, unknown>): Promise<void> {
  const authFilePath = getSharedAuthFilePath(dataDir);
  await mkdir(dirname(authFilePath), { recursive: true });
  const authStorage = AuthStorage.create(authFilePath);
  authStorage.set("anthropic", credential as never);
}

async function writeSharedSecrets(dataDir: string, values: Record<string, string>): Promise<void> {
  const secretsPath = getSharedSecretsFilePath(dataDir);
  await mkdir(dirname(secretsPath), { recursive: true });
  await writeFile(secretsPath, `${JSON.stringify(values, null, 2)}\n`, "utf8");
}
