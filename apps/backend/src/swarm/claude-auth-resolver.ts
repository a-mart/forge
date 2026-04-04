import { access, readFile } from "node:fs/promises";
import { AuthStorage, type AuthCredential } from "@mariozechner/pi-coding-agent";
import { ensureCanonicalAuthFilePath } from "./auth-storage-paths.js";
import { isEnoentError } from "./claude-utils.js";
import { getLegacyAuthFilePath, getLegacySecretsFilePath, getSharedAuthFilePath, getSharedSecretsFilePath } from "./data-paths.js";
import type { SwarmConfig } from "./types.js";

const ANTHROPIC_PROVIDER = "anthropic";
const MISSING_ANTHROPIC_CREDENTIALS_ERROR =
  "Anthropic credentials not configured. Add them in Settings → Providers.";

export interface ClaudeAuthCredentials {
  type: "oauth" | "api-key";
  token: string;
}

export class ClaudeAuthResolver {
  constructor(private readonly dataDir: string) {}

  async resolve(): Promise<ClaudeAuthCredentials> {
    const authFilePath = await ensureCanonicalAuthFilePath(this.buildAuthConfig());
    const authStorage = AuthStorage.create(authFilePath);
    const credential = authStorage.get(ANTHROPIC_PROVIDER) as AuthCredential | undefined;

    const oauthToken = extractOAuthToken(credential);
    if (oauthToken) {
      return {
        type: "oauth",
        token: oauthToken
      };
    }

    const storedApiKey = extractApiKey(credential);
    if (storedApiKey) {
      return {
        type: "api-key",
        token: storedApiKey
      };
    }

    const settingsApiKey = await this.readManagedAnthropicApiKey();
    if (settingsApiKey) {
      return {
        type: "api-key",
        token: settingsApiKey
      };
    }

    const envApiKey = normalizeToken(process.env.ANTHROPIC_API_KEY);
    if (envApiKey) {
      return {
        type: "api-key",
        token: envApiKey
      };
    }

    throw new Error(MISSING_ANTHROPIC_CREDENTIALS_ERROR);
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.resolve();
      return true;
    } catch {
      return false;
    }
  }

  async buildEnv(_sessionDataDir: string): Promise<Record<string, string>> {
    // Claude Code resolves its own OAuth credentials from the inherited process
    // environment plus the user's existing Claude Code auth storage
    // (default ~/.claude or a user-provided CLAUDE_CONFIG_DIR). Do not inject
    // ANTHROPIC_API_KEY or override CLAUDE_CONFIG_DIR here, or we can
    // accidentally force the SDK onto the wrong auth path.
    return {};
  }

  private buildAuthConfig(): Pick<SwarmConfig, "paths"> {
    return {
      paths: {
        sharedAuthFile: getSharedAuthFilePath(this.dataDir),
        authFile: getLegacyAuthFilePath(this.dataDir)
      }
    } as Pick<SwarmConfig, "paths">;
  }

  private async readManagedAnthropicApiKey(): Promise<string | undefined> {
    for (const candidatePath of [getSharedSecretsFilePath(this.dataDir), getLegacySecretsFilePath(this.dataDir)]) {
      const raw = await readTextIfExists(candidatePath);
      if (!raw) {
        continue;
      }

      const parsed = parseSecretsStore(raw);
      const apiKey = normalizeToken(parsed.ANTHROPIC_API_KEY);
      if (apiKey) {
        return apiKey;
      }
    }

    return undefined;
  }
}

function extractOAuthToken(credential: AuthCredential | undefined): string | undefined {
  if (!credential || typeof credential !== "object" || credential.type !== "oauth") {
    return undefined;
  }

  const accessToken = normalizeToken((credential as { accessToken?: unknown }).accessToken);
  if (accessToken) {
    return accessToken;
  }

  return normalizeToken((credential as { access?: unknown }).access);
}

function extractApiKey(credential: AuthCredential | undefined): string | undefined {
  if (!credential || typeof credential !== "object" || credential.type === "oauth") {
    return undefined;
  }

  const apiKey = normalizeToken((credential as { key?: unknown }).key);
  if (apiKey) {
    return apiKey;
  }

  return normalizeToken((credential as { access?: unknown }).access);
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    await access(path);
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return undefined;
    }

    throw error;
  }
}

function parseSecretsStore(raw: string): Record<string, string> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const normalized: Record<string, string> = {};

  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      continue;
    }

    const normalizedValue = value.trim();
    if (!normalizedValue) {
      continue;
    }

    normalized[name] = normalizedValue;
  }

  return normalized;
}

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

