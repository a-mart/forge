import type { AuthCredential } from "@earendil-works/pi-coding-agent";
import type {
  OpenAIAuthBrokerLeaseHandle,
  OpenAIAuthBrokerRuntimeService,
} from "../../openai-auth/openai-auth-broker-runtime-service.js";
import type { RuntimeErrorEvent, RuntimeUserMessage } from "../../runtime-contracts.js";
import { classifyRuntimeCapacityError, normalizeRuntimeError } from "../../runtime-utils.js";

type RuntimeAuthStorage = {
  get?: (key: string) => AuthCredential | undefined;
  set: (key: string, value: AuthCredential) => void;
};

interface OpenAIAuthBrokerRuntimeControllerOptions<TMessage extends RuntimeUserMessage> {
  service: OpenAIAuthBrokerRuntimeService;
  handle?: OpenAIAuthBrokerLeaseHandle;
  getAuthStorage: () => RuntimeAuthStorage | undefined;
  getProvider: () => string | undefined;
  retryPromptLater: (message: TMessage) => void;
  closeStaleOpenAICodexWebSocketSession: (stage: string) => void;
  logRuntimeError: (phase: RuntimeErrorEvent["phase"], error: unknown, details?: Record<string, unknown>) => void;
  reportRuntimeError: (error: RuntimeErrorEvent) => Promise<void>;
}

export class OpenAIAuthBrokerRuntimeController<TMessage extends RuntimeUserMessage = RuntimeUserMessage> {
  private handle: OpenAIAuthBrokerLeaseHandle | undefined;

  constructor(private readonly options: OpenAIAuthBrokerRuntimeControllerOptions<TMessage>) {
    this.handle = options.handle;
  }

  hasLease(): boolean {
    return this.handle !== undefined;
  }

  async beforeDispatch(): Promise<void> {
    const provider = normalizeProviderId(this.options.getProvider());
    if (provider !== "openai-codex") {
      return;
    }

    const brokerModeActive = await this.options.service.isBrokerModeActive();
    if (!brokerModeActive) {
      if (!this.handle) {
        return;
      }
      await this.release("auth_source_change");
      throw new Error("OpenAI/Codex auth source changed to local credentials; recreate this runtime before dispatching another turn.");
    }

    const authStorage = this.options.getAuthStorage();
    if (!this.handle || !authStorage) {
      throw new Error("OpenAI/Codex auth source changed to Forge Auth broker; recreate this runtime before dispatching another turn.");
    }

    try {
      const renewed = await this.options.service.renewIfNeeded(this.handle);
      await this.applyLeaseToAuthStorage(authStorage, renewed, "broker_lease_rotated");
    } catch (error) {
      const normalized = normalizeRuntimeError(error);
      throw new Error(`Forge Auth broker auth renewal failed for OpenAI/Codex: ${normalized.message}`);
    }
  }

  async reportSuccess(): Promise<void> {
    const authStorage = this.options.getAuthStorage();
    if (!this.handle || !authStorage) {
      return;
    }

    try {
      const reported = await this.options.service.report(this.handle, "success");
      await this.applyLeaseToAuthStorage(authStorage, reported, "broker_lease_rotated");
    } catch (error) {
      this.options.logRuntimeError("prompt_dispatch", error, {
        stage: "broker_lease:report_success_failed",
      });
    }
  }

  async release(reason: string): Promise<void> {
    const handle = this.handle;
    if (!handle) {
      return;
    }

    this.handle = undefined;
    await this.options.service.release(handle, reason);
  }

  shouldHandleErrorBeforeGenericRetry(error: unknown): boolean {
    if (!this.handle) {
      return false;
    }

    const normalized = normalizeRuntimeError(error);
    return isLikelyBrokerAuthError(normalized.message) || classifyRuntimeCapacityError(normalized.message).isQuotaOrRateLimit;
  }

  async attemptRecovery(error: unknown, errorMessage: string, message: TMessage): Promise<boolean> {
    const handle = this.handle;
    const authStorage = this.options.getAuthStorage();
    if (!handle || !authStorage) {
      return false;
    }

    const isAuthFailure = isLikelyBrokerAuthError(errorMessage);
    const classification = classifyRuntimeCapacityError(errorMessage);
    const event = isAuthFailure ? "auth_error" : classification.isQuotaOrRateLimit ? "capacity_error" : null;
    if (!event) {
      return false;
    }

    try {
      const reported = await this.options.service.report(handle, event, {
        message: errorMessage,
      });
      const replacementAvailable = brokerLeaseChanged(handle, reported);
      if (replacementAvailable) {
        await this.applyLeaseToAuthStorage(authStorage, reported, "broker_lease_rotated");
        this.options.retryPromptLater(message);
        return true;
      }

      this.handle = reported;

      if (event === "auth_error") {
        return false;
      }

      await this.options.reportRuntimeError({
        phase: "prompt_dispatch",
        message: "Forge Auth broker reported capacity exhaustion for OpenAI/Codex but did not provide a replacement lease.",
        details: {
          stage: "broker_lease:no_replacement_capacity",
          leaseId: handle.leaseId,
        },
      });
      return false;
    } catch (reportError) {
      this.options.logRuntimeError("prompt_dispatch", reportError, {
        stage: "broker_lease:report_failed",
        event,
        message: errorMessage,
        originalError: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async applyLeaseToAuthStorage(
    authStorage: RuntimeAuthStorage,
    handle: OpenAIAuthBrokerLeaseHandle,
    stage: string,
  ): Promise<void> {
    const beforeHandleFingerprint = fingerprintBrokerLease(this.handle);
    const beforeCredentialFingerprint = fingerprintAuthCredential(authStorage.get?.("openai-codex"));
    const applied = await this.options.service.applyLeaseToAuthStorage(authStorage, handle);
    this.handle = applied;

    const afterHandleFingerprint = fingerprintBrokerLease(this.handle);
    const afterCredentialFingerprint = fingerprintAuthCredential(authStorage.get?.("openai-codex"));
    if (beforeHandleFingerprint !== afterHandleFingerprint || beforeCredentialFingerprint !== afterCredentialFingerprint) {
      this.options.closeStaleOpenAICodexWebSocketSession(stage);
    }
  }
}

function brokerLeaseChanged(
  before: OpenAIAuthBrokerLeaseHandle | undefined,
  after: OpenAIAuthBrokerLeaseHandle | undefined,
): boolean {
  return fingerprintBrokerLease(before) !== fingerprintBrokerLease(after);
}

function fingerprintBrokerLease(handle: OpenAIAuthBrokerLeaseHandle | undefined): string | undefined {
  if (!handle) {
    return undefined;
  }

  return stableStringify({
    leaseId: handle.leaseId,
    accountId: handle.lease.accountId,
    credential: handle.lease.credential,
  });
}

function fingerprintAuthCredential(credential: AuthCredential | undefined): string | undefined {
  return credential ? stableStringify(credential) : undefined;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function normalizeProviderId(provider: string | undefined): string | undefined {
  const normalized = provider?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function isLikelyBrokerAuthError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  const authIndicators = [
    "401",
    "403",
    "unauthorized",
    "forbidden",
    "authentication",
    "invalid api key",
    "no api key",
    "missing api key",
    "invalid token",
    "missing auth",
    "no auth",
    "access denied",
    "permission denied",
    "oauth",
    "token expired",
    "expired token",
    "expired credential",
    "login required",
  ];

  return authIndicators.some((indicator) => normalized.includes(indicator));
}
