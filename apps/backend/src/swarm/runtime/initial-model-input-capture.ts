import type {
  InitialModelInputJsonValue,
  PiInitialModelInputCaptureV1,
} from "@forge/protocol";

/** One versioned, session-local record of the first real Pi provider request. */
export const PI_INITIAL_MODEL_INPUT_CAPTURE_ENTRY_TYPE = "swarm_pi_initial_model_input";

const OMITTED_REQUEST_METADATA_KEYS = new Set([
  "auth",
  "token",
  "apikey",
  "xapikey",
  "accesstoken",
  "authorization",
  "headers",
  "env",
  "signal",
  "credential",
  "credentials",
  "cookie",
  "cookies",
  "password",
  "secret",
  "privatekey",
  "clientsecret",
  "refreshtoken",
  "idtoken",
  "bearertoken",
  "sessiontoken",
]);

export interface CreatePiInitialModelInputCaptureOptions {
  model: unknown;
  context: unknown;
  streamOptions: unknown;
  capturedAt: string;
}

/**
 * Converts the provider-independent values received by Pi's public streamFn
 * seam to durable JSON. The context is captured before provider conversion;
 * request credentials and binary image payloads are intentionally excluded.
 */
export function createPiInitialModelInputCapture(
  options: CreatePiInitialModelInputCaptureOptions,
): PiInitialModelInputCaptureV1 {
  const model = readRecord(options.model);
  const context = readRecord(options.context);
  const streamOptions = readRecord(options.streamOptions);

  return {
    version: 1,
    runtime: "pi",
    capturedAt: options.capturedAt,
    fidelity: {
      capturePoint: "pi_stream_fn",
      context: "exact_provider_independent",
      images: "byte_summary",
      requestMetadata: "safe_projection",
    },
    systemPrompt: typeof context?.systemPrompt === "string" ? context.systemPrompt : "",
    messages: projectArray(context?.messages),
    tools: projectArray(context?.tools),
    model: {
      provider: readNonEmptyString(model?.provider) ?? "unknown",
      id: readNonEmptyString(model?.id) ?? "unknown",
      ...(readNonEmptyString(model?.api) ? { api: readNonEmptyString(model?.api)! } : {}),
    },
    requestMetadata: projectRequestMetadata(streamOptions),
  };
}

export function findPiInitialModelInputCapture(entries: readonly unknown[]): PiInitialModelInputCaptureV1 | undefined {
  for (const entry of entries) {
    if (isPiInitialModelInputCapture(entry)) {
      return entry;
    }
  }
  return undefined;
}

export function findPiInitialModelInputCaptureInSessionEntries(
  entries: readonly unknown[],
): PiInitialModelInputCaptureV1 | undefined {
  return findPiInitialModelInputCapture(entries.flatMap((entry) => {
    const custom = readRecord(entry);
    return custom?.type === "custom" && custom.customType === PI_INITIAL_MODEL_INPUT_CAPTURE_ENTRY_TYPE
      ? [custom.data]
      : [];
  }));
}

export function isPiInitialModelInputCapture(value: unknown): value is PiInitialModelInputCaptureV1 {
  const record = readRecord(value);
  const fidelity = readRecord(record?.fidelity);
  const model = readRecord(record?.model);
  return record?.version === 1
    && record.runtime === "pi"
    && typeof record.capturedAt === "string"
    && fidelity?.capturePoint === "pi_stream_fn"
    && fidelity.context === "exact_provider_independent"
    && fidelity.images === "byte_summary"
    && fidelity.requestMetadata === "safe_projection"
    && typeof record.systemPrompt === "string"
    && Array.isArray(record.messages)
    && Array.isArray(record.tools)
    && typeof model?.provider === "string"
    && typeof model?.id === "string"
    && readRecord(record.requestMetadata) !== undefined;
}

function projectRequestMetadata(value: Record<string, unknown> | undefined): { [key: string]: InitialModelInputJsonValue } {
  if (!value) return {};

  const metadata: { [key: string]: InitialModelInputJsonValue } = {};
  for (const [key, entry] of Object.entries(value)) {
    if (shouldOmitRequestMetadataKey(key)) continue;
    const projected = projectJsonValue(entry, new WeakSet(), true);
    if (projected !== undefined) {
      metadata[key] = projected;
    }
  }
  return metadata;
}

function projectArray(value: unknown): InitialModelInputJsonValue[] {
  if (!Array.isArray(value)) return [];

  const projected: InitialModelInputJsonValue[] = [];
  for (const entry of value) {
    const converted = projectJsonValue(entry, new WeakSet());
    if (converted !== undefined) {
      projected.push(converted);
    }
  }
  return projected;
}

function projectJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
  omitRequestMetadataKeys = false,
): InitialModelInputJsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "function" || typeof value === "undefined" || typeof value === "symbol" || typeof value === "bigint") {
    return undefined;
  }
  if (Array.isArray(value)) {
    const result: InitialModelInputJsonValue[] = [];
    for (const entry of value) {
      const projected = projectJsonValue(entry, ancestors, omitRequestMetadataKeys);
      if (projected !== undefined) result.push(projected);
    }
    return result;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (ancestors.has(value)) {
    return "[Circular]";
  }

  ancestors.add(value);
  try {
    const record = value as Record<string, unknown>;
    const result: { [key: string]: InitialModelInputJsonValue } = {};
    const isImage = record.type === "image" && typeof record.data === "string";

    for (const [key, entry] of Object.entries(record)) {
      if ((omitRequestMetadataKeys && shouldOmitRequestMetadataKey(key)) || (isImage && key === "data")) continue;
      const projected = projectJsonValue(entry, ancestors, omitRequestMetadataKeys);
      if (projected !== undefined) {
        result[key] = projected;
      }
    }

    if (isImage) {
      result.dataBytes = countImagePayloadBytes(record.data as string);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function shouldOmitRequestMetadataKey(key: string): boolean {
  const normalized = key.replace(/[-_]/gu, "").toLowerCase();
  return OMITTED_REQUEST_METADATA_KEYS.has(normalized);
}

function countImagePayloadBytes(data: string): number {
  const commaIndex = data.indexOf(",");
  const base64 = data.startsWith("data:") && commaIndex >= 0 ? data.slice(commaIndex + 1) : data;
  return Buffer.byteLength(base64, "base64");
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
