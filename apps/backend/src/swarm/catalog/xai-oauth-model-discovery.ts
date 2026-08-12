import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { ForgeModelDefinition, ForgeReasoningLevel } from "@forge/protocol";
import { getSharedAuthFilePath } from "../data-paths.js";
import { modelCatalogService } from "./model-catalog-service.js";
import { getForgeXaiOAuthProxyHeaders } from "./xai-oauth-proxy-compat.js";

export const XAI_OAUTH_MODELS_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/models";
const MAX_CATALOG_BYTES = 1_000_000;
const DISCOVERABLE_MODEL_IDS = new Set([
  "grok-4.6",
  "grok-4.5",
  "grok-build",
  "grok-composer-2.5-fast",
]);
const CHECKED_IN_BASELINE_MODEL_IDS = new Set([
  "grok-4.6",
  "grok-4.5",
]);
const DYNAMIC_MODEL_IDS = new Set([
  "grok-build",
  "grok-composer-2.5-fast",
]);
const REASONING_LEVELS = new Set<ForgeReasoningLevel>(["none", "low", "medium", "high", "xhigh"]);
let latestDiscoveryGeneration = 0;

export interface XaiOAuthDiscoveryOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Refresh entitlement-gated xAI models for the active stored credential.
 * API-key credentials deliberately stop before any proxy request.
 */
export async function refreshXaiOAuthModelDiscovery(
  dataDir: string,
  options: XaiOAuthDiscoveryOptions = {},
): Promise<ForgeModelDefinition[]> {
  const authFilePath = getSharedAuthFilePath(dataDir);
  const generation = ++latestDiscoveryGeneration;
  const authStorage = AuthStorage.create(authFilePath);
  const storedCredential = authStorage.get("xai");
  const storedSnapshot = snapshotCredential(storedCredential);
  if (!storedCredential || storedCredential.type !== "oauth") {
    commitDiscoveryState(generation, authFilePath, storedSnapshot, null);
    return [];
  }

  // Mark OAuth active before discovery so checked-in Grok models use the bounded OAuth fallback
  // even when refresh or discovery is temporarily unavailable.
  if (!commitDiscoveryState(generation, authFilePath, storedSnapshot, [])) {
    return [];
  }

  try {
    const accessToken = await authStorage.getApiKey("xai");
    const refreshedCredential = authStorage.get("xai");
    const refreshedSnapshot = snapshotCredential(refreshedCredential);
    if (
      !accessToken
      || !refreshedCredential
      || refreshedCredential.type !== "oauth"
      || !commitDiscoveryState(generation, authFilePath, refreshedSnapshot, [])
    ) {
      return [];
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
    timeout.unref?.();
    try {
      const response = await (options.fetchImpl ?? fetch)(XAI_OAUTH_MODELS_ENDPOINT, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...getForgeXaiOAuthProxyHeaders(),
        },
      });
      if (!response.ok || response.status < 200 || response.status >= 300) {
        reconcileDiscoveryState(generation, authFilePath);
        return [];
      }

      const raw = await readBoundedResponseText(response);
      if (raw === undefined) {
        reconcileDiscoveryState(generation, authFilePath);
        return [];
      }

      const discovered = parseXaiOAuthModelCatalog(JSON.parse(raw) as unknown);
      return commitDiscoveryState(generation, authFilePath, refreshedSnapshot, discovered)
        ? discovered
        : [];
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Discovery is fail-closed and intentionally does not surface provider/token errors.
    reconcileDiscoveryState(generation, authFilePath);
    return [];
  }
}

function snapshotCredential(credential: unknown): string | undefined {
  return credential === undefined ? undefined : JSON.stringify(credential);
}

function commitDiscoveryState(
  generation: number,
  authFilePath: string,
  expectedCredentialSnapshot: string | undefined,
  models: readonly ForgeModelDefinition[] | null,
): boolean {
  if (generation !== latestDiscoveryGeneration) {
    return false;
  }

  const currentCredential = AuthStorage.create(authFilePath).get("xai");
  if (snapshotCredential(currentCredential) !== expectedCredentialSnapshot) {
    modelCatalogService.setXaiOAuthDiscoveredModels(currentCredential?.type === "oauth" ? [] : null);
    return false;
  }

  modelCatalogService.setXaiOAuthDiscoveredModels(models);
  return true;
}

function reconcileDiscoveryState(generation: number, authFilePath: string): void {
  if (generation !== latestDiscoveryGeneration) {
    return;
  }
  const currentCredential = AuthStorage.create(authFilePath).get("xai");
  modelCatalogService.setXaiOAuthDiscoveredModels(currentCredential?.type === "oauth" ? [] : null);
}

export function parseXaiOAuthModelCatalog(payload: unknown): ForgeModelDefinition[] {
  const rows = readCatalogRows(payload);
  return rows.flatMap((row) => {
    const parsed = parseCatalogRow(row);
    return parsed ? [parsed] : [];
  });
}

function parseCatalogRow(value: unknown): ForgeModelDefinition | undefined {
  const row = readRecord(value);
  const modelId = readString(row?.id) ?? readString(row?.model) ?? readString(row?.model_id);
  if (!row || !modelId || !DISCOVERABLE_MODEL_IDS.has(modelId)) {
    return undefined;
  }

  const baseline = modelCatalogService.getModel(modelId, "xai");
  const contextWindow = readPositiveInteger(
    row.context_window ?? row.contextWindow ?? readRecord(row.limits)?.context_window ?? readRecord(row.limits)?.contextWindow,
  );
  const maxOutputTokens = readPositiveInteger(
    row.max_output_tokens ?? row.maxOutputTokens ?? row.max_tokens ?? readRecord(row.limits)?.max_output_tokens ?? readRecord(row.limits)?.maxOutputTokens,
  );
  const reasoning = readReasoning(row, modelId);

  if (DYNAMIC_MODEL_IDS.has(modelId) && (!contextWindow || !maxOutputTokens || !reasoning)) {
    return undefined;
  }

  const isCheckedInBaseline = CHECKED_IN_BASELINE_MODEL_IDS.has(modelId);
  const effectiveContextWindow = isCheckedInBaseline
    ? baseline?.contextWindow
    : contextWindow;
  const effectiveMaxOutputTokens = isCheckedInBaseline
    ? baseline?.maxOutputTokens
    : maxOutputTokens;
  if (!effectiveContextWindow || !effectiveMaxOutputTokens || !reasoning) {
    return undefined;
  }

  const capabilities = readRecord(row.capabilities);
  const discoveredInputModes = readInputModes(
    row.input_modes ?? row.inputModes ?? row.input_modalities ?? capabilities?.input_modes,
  );
  const discoveredSupportsTools = readBoolean(
    row.supports_tools ?? row.supportsTools ?? capabilities?.tools ?? capabilities?.tool_calling,
  );
  const discoveredSupportsStructuredOutput = readBoolean(
    row.supports_structured_output ?? row.supportsStructuredOutput ?? capabilities?.structured_output ?? capabilities?.structured_outputs,
  );
  const inputModes = isCheckedInBaseline
    ? (baseline?.inputModes ?? ["text", "image"])
    : (discoveredInputModes ?? ["text"]);
  const supportsTools = isCheckedInBaseline
    ? (baseline?.supportsTools ?? true)
    : (discoveredSupportsTools ?? false);
  const supportsStructuredOutput = isCheckedInBaseline
    ? (baseline?.supportsStructuredOutput ?? true)
    : (discoveredSupportsStructuredOutput ?? false);

  return {
    modelId,
    provider: "xai",
    familyId: "pi-grok",
    displayName: readString(row.name) ?? displayNameFor(modelId),
    isFamilyDefault: modelId === "grok-4.6",
    supportsReasoning: reasoning.levels.some((level) => level !== "none"),
    supportedReasoningLevels: reasoning.levels,
    defaultReasoningLevel: reasoning.defaultLevel,
    contextWindow: effectiveContextWindow,
    maxOutputTokens: effectiveMaxOutputTokens,
    inputModes,
    outputModes: ["text"],
    supportsTools,
    supportsStructuredOutput,
    authScope: isCheckedInBaseline ? "any" : "oauth",
    discovered: true,
    webSearchCapability: baseline?.webSearchCapability ?? "native",
    thinkingLevelMap: Object.fromEntries(
      reasoning.levels.map((level) => [level === "none" ? "off" : level, level === "none" ? null : level]),
    ),
    piCompat: baseline?.piCompat,
    piCost: baseline?.piCost,
    enabledByDefault: true,
    piUpstreamId: modelId,
    intentionalDivergenceNotes: "Authenticated xAI OAuth discovery metadata; entitlement-gated to the active account.",
  };
}

function readReasoning(
  row: Record<string, unknown>,
  modelId: string,
): { levels: ForgeReasoningLevel[]; defaultLevel: ForgeReasoningLevel } | undefined {
  const reasoning = readRecord(row.reasoning);
  const rawLevels = row.supported_reasoning_levels
    ?? row.supportedReasoningLevels
    ?? row.reasoning_efforts
    ?? row.reasoningEfforts
    ?? reasoning?.supported_levels
    ?? reasoning?.efforts;
  const levels = Array.isArray(rawLevels)
    ? rawLevels.flatMap((value) => {
        const level = readString(value)?.toLowerCase() as ForgeReasoningLevel | undefined;
        return level && REASONING_LEVELS.has(level) ? [level] : [];
      })
    : [];

  const supportsReasoning = readBoolean(row.supports_reasoning ?? row.supportsReasoning ?? reasoning?.supported);
  const normalizedLevels = [...new Set(levels)]
    .filter((level) => !CHECKED_IN_BASELINE_MODEL_IDS.has(modelId) || level !== "none");
  if (normalizedLevels.length === 0) {
    if (supportsReasoning === false && !CHECKED_IN_BASELINE_MODEL_IDS.has(modelId)) {
      return { levels: ["none"], defaultLevel: "none" };
    }
    return undefined;
  }

  const advertisedDefault = (readString(row.default_reasoning_level)
    ?? readString(row.defaultReasoningLevel)
    ?? readString(reasoning?.default))?.toLowerCase() as ForgeReasoningLevel | undefined;
  const defaultLevel = advertisedDefault && normalizedLevels.includes(advertisedDefault)
    ? advertisedDefault
    : normalizedLevels.includes("high")
      ? "high"
      : normalizedLevels[0];
  return { levels: normalizedLevels, defaultLevel };
}

async function readBoundedResponseText(response: Response): Promise<string | undefined> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_CATALOG_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
  }

  if (!response.body) {
    const raw = await response.text();
    return new TextEncoder().encode(raw).byteLength <= MAX_CATALOG_BYTES ? raw : undefined;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_CATALOG_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function readCatalogRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const object = readRecord(payload);
  if (!object) return [];
  for (const key of ["data", "models", "items"]) {
    if (Array.isArray(object[key])) return object[key] as unknown[];
  }
  return [];
}

function readInputModes(value: unknown): Array<"text" | "image"> | undefined {
  if (!Array.isArray(value)) return undefined;
  const modes: Array<"text" | "image"> = value.flatMap((entry): Array<"text" | "image"> => {
    const mode = readString(entry)?.toLowerCase();
    return mode === "text" || mode === "image" ? [mode] : [];
  });
  return modes.length > 0 ? [...new Set(modes)] : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function displayNameFor(modelId: string): string {
  if (modelId === "grok-4.6") return "Grok 4.6";
  if (modelId === "grok-build") return "Grok Build";
  if (modelId === "grok-composer-2.5-fast") return "Grok Composer 2.5 Fast";
  return "Grok 4.5";
}
