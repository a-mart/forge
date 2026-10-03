import { AuthStorage, type AuthCredential } from "@earendil-works/pi-coding-agent";
import { ensureCanonicalAuthFilePath } from "../../storage/auth-storage-paths.js";
import type { CredentialPoolService } from "../../credential-pool.js";
import {
  buildOpenAICodexAuthCredentialFromLease,
  extractChatGptAccountIdFromAccessToken,
  type OpenAIAuthBrokerLeaseHandle,
  type OpenAIAuthBrokerRuntimeService,
} from "../../openai-auth/openai-auth-broker-runtime-service.js";
import type { AgentDescriptor, SwarmConfig } from "../../types.js";
import type { CodexAppServerClientPort } from "../../codex-app-server/types.js";

const PROVIDER = "openai-codex";

/** Forge owns account selection and refresh; app-server receives no refresh token. */
export class CodexRuntimeAuth {
  private storage?: AuthStorage;
  private credentialId?: string;
  private lease?: OpenAIAuthBrokerLeaseHandle;
  private previousAccess?: string;
  private released = false;

  constructor(private readonly options: {
    config: SwarmConfig;
    descriptor: AgentDescriptor;
    pool?: CredentialPoolService;
    broker?: OpenAIAuthBrokerRuntimeService;
  }) {}

  async initialize(): Promise<void> {
    const { broker, pool } = this.options;
    if (broker && await broker.isBrokerModeActive()) {
      const acquired = await broker.acquireForRuntime(this.options.descriptor);
      this.lease = acquired.handle;
      this.storage = acquired.authStorage;
      return;
    }
    if (pool && await pool.getTotalPoolSize(PROVIDER) > 0) {
      const selected = await pool.select(PROVIDER);
      if (!selected) throw new Error("No enabled OpenAI/Codex account is available. Check Forge Auth settings.");
      this.credentialId = selected.credentialId;
      this.storage = AuthStorage.inMemory(await pool.buildRuntimeAuthData(PROVIDER, selected.credentialId));
      await pool.markUsed(PROVIDER, selected.credentialId);
      return;
    }
    this.storage = AuthStorage.create(await ensureCanonicalAuthFilePath(this.options.config));
  }

  async login(client: CodexAppServerClientPort): Promise<void> {
    const credential = await this.readCredential();
    const access = credential.type === "api_key" ? credential.key : credential.access;
    if (access === this.previousAccess) return;
    const params = credential.type === "api_key"
      ? { type: "apiKey", apiKey: credential.key }
      : { type: "chatgptAuthTokens", ...externalTokens(credential) };
    try {
      await client.request("account/login/start", params);
    } catch {
      throw new Error("Codex native could not accept the selected Forge credential. Check Forge Auth settings.");
    }
    this.previousAccess = access;
  }

  async refresh(): Promise<{ accessToken: string; chatgptAccountId: string }> {
    if (this.lease && this.options.broker) {
      this.lease = await this.options.broker.report(this.lease, "auth_error", { requestReplacement: true });
    }
    const credential = await this.readCredential(true);
    if (credential.type !== "oauth") throw new Error("Selected Forge account is not a ChatGPT login.");
    const tokens = externalTokens(credential);
    if (tokens.accessToken === this.previousAccess) throw new Error("The selected Forge login was rejected. Reconnect it in Forge Auth settings.");
    this.previousAccess = tokens.accessToken;
    return tokens;
  }

  async release(): Promise<void> {
    if (this.released) return;
    if (this.lease) await this.options.broker?.release(this.lease, "native_runtime_shutdown");
    this.released = true;
    this.previousAccess = undefined;
    this.storage = undefined;
  }

  private async readCredential(forceRefresh = false): Promise<AuthCredential> {
    if (!this.storage || this.released) throw new Error("Codex native authentication is not initialized.");
    try {
      if (this.lease && this.options.broker) {
        this.lease = await this.options.broker.renewIfNeeded(this.lease);
        this.storage.set(PROVIDER, buildOpenAICodexAuthCredentialFromLease(this.lease.lease));
      } else if (this.credentialId && this.options.pool) {
        const data = await this.options.pool.buildRuntimeAuthData(PROVIDER, this.credentialId, { forceRefresh });
        this.storage.set(PROVIDER, data[PROVIDER]!);
      } else {
        this.storage.reload();
        await this.storage.getApiKey(PROVIDER);
      }
      const credential = this.storage.get(PROVIDER);
      if (credential?.type === "oauth" || credential?.type === "api_key") return credential;
      const key = await this.storage.getApiKey(PROVIDER);
      if (key) return { type: "api_key", key };
    } catch {
      throw new Error("Could not refresh the selected Forge OpenAI/Codex account. Check Forge Auth settings.");
    }
    throw new Error("Codex native requires an OpenAI/Codex login in Forge Auth settings.");
  }
}

function externalTokens(credential: AuthCredential & { type: "oauth" }): { accessToken: string; chatgptAccountId: string } {
  const accountId = (typeof credential.accountId === "string" ? credential.accountId : undefined)
    || extractChatGptAccountIdFromAccessToken(credential.access);
  if (!accountId || !credential.access) throw new Error("The selected Forge ChatGPT login has no account identity.");
  return { accessToken: credential.access, chatgptAccountId: accountId };
}

/** Never inherit Forge's provider keys, vault values, or the desktop Codex home. */
export function nativeCodexEnvironment(codexHome: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"]);
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toUpperCase()) || /^LC_[A-Z_]+$/.test(key))),
    CODEX_HOME: codexHome,
  };
}
