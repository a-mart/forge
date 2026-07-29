import type { IncomingMessage, ServerResponse } from "node:http";
import {
  SECURE_SECRET_RETENTIONS,
  SecureSessionsContractError,
  parseSecureSecretBinding,
  parseSecureSecretAutomaticGrantPolicy,
  parseSecureSecretScope,
  type SecureSecretAutomaticGrantPolicy,
  type SecureSecretBinding,
  type SecureSecretProviderSummary,
  type SecureSecretProviderTestResult,
  type SecureSecretProjectDefaultSummary,
  type SecureSecretRetention,
  type SecureSecretScope,
  type SecureSecretSummary,
} from "@forge/protocol";
import { applyCorsHeaders, readJsonBody, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const SECURE_SECRETS_PATH = "/api/secure-secrets";
const SECURE_SECRET_PROVIDERS_PATH = `${SECURE_SECRETS_PATH}/providers`;
const MAX_SECURE_REQUEST_BYTES = 256 * 1024;
const MAX_ID_LENGTH = 256;
const MAX_LABEL_LENGTH = 256;
const MAX_NOTE_LENGTH = 2_000;
const MAX_ENCRYPTED_PAYLOAD_LENGTH = 2 * 1024 * 1024;

export const SECURE_ROUTE_ERROR_CODES = [
  "SECURE_BUILDER_ONLY",
  "SECURE_PRIVATE_API_UNAVAILABLE",
  "SECURE_REQUEST_INVALID",
  "SECURE_SOURCE_LOCKED",
  "SECURE_SOURCE_UNAVAILABLE",
  "SECURE_PROVIDER_AUTH_REQUIRED",
  "SECURE_SECRET_NOT_FOUND",
  "SECURE_SECRET_ALIAS_CONFLICT",
  "SECURE_PROJECT_DEFAULT_LIMIT_REACHED",
  "SECURE_STALE_REVISION",
  "SECURE_OPERATION_FAILED",
] as const;

export type SecureRouteErrorCode = (typeof SECURE_ROUTE_ERROR_CODES)[number];

export interface CreateLocalSecureSecretInput {
  displayAlias: string;
  displayName?: string;
  note?: string;
  encryptedMaterial: string;
  bindings?: SecureSecretBinding[];
  scope?: SecureSecretScope;
  retention?: SecureSecretRetention;
}

export interface UpdateSecureSecretInput {
  displayAlias?: string;
  displayName?: string | null;
  note?: string | null;
  encryptedMaterial?: string;
  bindings?: SecureSecretBinding[];
  scope?: SecureSecretScope;
  retention?: SecureSecretRetention;
}

export interface ConnectBitwardenSecureSecretProviderInput {
  displayName: string;
  serverOrigin: string;
  organizationId?: string;
  projectId?: string;
  encryptedAccessToken: string;
}

export interface ImportBitwardenSecureSecretInput {
  sourceLocator: string;
  displayAlias: string;
  displayName?: string;
  bindings?: SecureSecretBinding[];
  scope?: SecureSecretScope;
  retention?: SecureSecretRetention;
}

export interface UpdateBitwardenSecureSecretProviderCredentialInput {
  encryptedAccessToken: string;
}

export interface SecureSecretTransportService {
  listSecureSecretProviders(): Promise<SecureSecretProviderSummary[]> | SecureSecretProviderSummary[];
  connectBitwardenSecureSecretProvider(
    input: ConnectBitwardenSecureSecretProviderInput,
  ): Promise<SecureSecretProviderSummary>;
  testSecureSecretProvider(providerId: string): Promise<SecureSecretProviderTestResult>;
  updateBitwardenSecureSecretProviderCredential(
    providerId: string,
    input: UpdateBitwardenSecureSecretProviderCredentialInput,
  ): Promise<SecureSecretProviderSummary>;
  deleteSecureSecretProvider(providerId: string): Promise<void>;
  importBitwardenSecureSecret(
    providerId: string,
    input: ImportBitwardenSecureSecretInput,
  ): Promise<SecureSecretSummary>;
  listSecureSecrets(): Promise<SecureSecretSummary[]> | SecureSecretSummary[];
  listSecureSecretProjectDefaults(
    profileId?: string,
  ): Promise<SecureSecretProjectDefaultSummary[]> | SecureSecretProjectDefaultSummary[];
  setSecureSecretProjectDefault(
    secretId: string,
    input: { profileId: string; enabled: boolean },
  ): Promise<SecureSecretProjectDefaultSummary | null>;
  replaceSecureSecretAutomaticGrantPolicy(
    secretId: string,
    policy: SecureSecretAutomaticGrantPolicy,
  ): Promise<SecureSecretSummary>;
  createLocalSecureSecret(input: CreateLocalSecureSecretInput): Promise<SecureSecretSummary>;
  updateSecureSecret(
    secretId: string,
    input: UpdateSecureSecretInput,
  ): Promise<SecureSecretSummary>;
  deleteSecureSecret(secretId: string): Promise<void>;
}

export function createSecureSecretRoutes(options: {
  service: SecureSecretTransportService;
}): HttpRoute[] {
  const methods = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

  return [{
    methods,
    matches: (pathname) =>
      pathname === SECURE_SECRETS_PATH
      || pathname.startsWith(`${SECURE_SECRETS_PATH}/`),
    handle: async (request, response, requestUrl) => {
      applySecureHeaders(request, response, methods);

      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }

      try {
        if (request.method === "GET" && requestUrl.pathname === SECURE_SECRET_PROVIDERS_PATH) {
          sendSecureJson(response, 200, await options.service.listSecureSecretProviders());
          return;
        }

        if (
          request.method === "GET"
          && requestUrl.pathname === `${SECURE_SECRETS_PATH}/project-defaults`
        ) {
          sendSecureJson(
            response,
            200,
            await options.service.listSecureSecretProjectDefaults(),
          );
          return;
        }

        const projectDefaultsMatch = requestUrl.pathname.match(
          /^\/api\/secure-secrets\/project-defaults\/([^/]+)$/,
        );
        if (request.method === "GET" && projectDefaultsMatch) {
          const profileId = parsePathId(projectDefaultsMatch[1], "profileId");
          sendSecureJson(
            response,
            200,
            await options.service.listSecureSecretProjectDefaults(profileId),
          );
          return;
        }

        const projectDefaultMatch = requestUrl.pathname.match(
          /^\/api\/secure-secrets\/project-defaults\/([^/]+)\/([^/]+)$/,
        );
        if (request.method === "PUT" && projectDefaultMatch) {
          const profileId = parsePathId(projectDefaultMatch[1], "profileId");
          const secretId = parsePathId(projectDefaultMatch[2], "secretId");
          const input = parseSetProjectDefaultInput(
            await readSecureJsonBody(request, MAX_SECURE_REQUEST_BYTES),
          );
          sendSecureJson(
            response,
            200,
            await options.service.setSecureSecretProjectDefault(secretId, {
              profileId,
              enabled: input.enabled,
            }),
          );
          return;
        }

        const automaticGrantMatch = requestUrl.pathname.match(
          /^\/api\/secure-secrets\/([^/]+)\/automatic-grant$/,
        );
        if (request.method === "PUT" && automaticGrantMatch) {
          const secretId = parsePathId(automaticGrantMatch[1], "secretId");
          const input = requireObject(
            await readSecureJsonBody(request, MAX_SECURE_REQUEST_BYTES),
          );
          assertKnownKeys(input, ["policy"]);
          sendSecureJson(
            response,
            200,
            await options.service.replaceSecureSecretAutomaticGrantPolicy(
              secretId,
              parseSecureSecretAutomaticGrantPolicy(input.policy),
            ),
          );
          return;
        }

        if (request.method === "POST" && requestUrl.pathname === `${SECURE_SECRET_PROVIDERS_PATH}/bitwarden`) {
          const input = parseConnectBitwardenInput(
            await readSecureJsonBody(request, MAX_SECURE_REQUEST_BYTES),
          );
          sendSecureJson(
            response,
            200,
            await options.service.connectBitwardenSecureSecretProvider(input),
          );
          return;
        }

        const providerTestMatch = requestUrl.pathname.match(
          /^\/api\/secure-secrets\/providers\/([^/]+)\/test$/,
        );
        if (request.method === "POST" && providerTestMatch) {
          const providerId = parsePathId(providerTestMatch[1], "providerId");
          sendSecureJson(
            response,
            200,
            await options.service.testSecureSecretProvider(providerId),
          );
          return;
        }

        const providerCredentialMatch = requestUrl.pathname.match(
          /^\/api\/secure-secrets\/providers\/([^/]+)\/credential$/,
        );
        if (request.method === "PATCH" && providerCredentialMatch) {
          const providerId = parsePathId(providerCredentialMatch[1], "providerId");
          const input = parseUpdateBitwardenCredentialInput(
            await readSecureJsonBody(request, MAX_SECURE_REQUEST_BYTES),
          );
          sendSecureJson(
            response,
            200,
            await options.service.updateBitwardenSecureSecretProviderCredential(
              providerId,
              input,
            ),
          );
          return;
        }

        const providerMatch = requestUrl.pathname.match(
          /^\/api\/secure-secrets\/providers\/([^/]+)$/,
        );
        if (request.method === "DELETE" && providerMatch) {
          const providerId = parsePathId(providerMatch[1], "providerId");
          await options.service.deleteSecureSecretProvider(providerId);
          sendSecureEmpty(response, 204);
          return;
        }

        const providerSecretImportMatch = requestUrl.pathname.match(
          /^\/api\/secure-secrets\/providers\/([^/]+)\/secrets$/,
        );
        if (request.method === "POST" && providerSecretImportMatch) {
          const providerId = parsePathId(
            providerSecretImportMatch[1],
            "providerId",
          );
          const input = parseImportBitwardenSecretInput(
            await readSecureJsonBody(request, MAX_SECURE_REQUEST_BYTES),
          );
          sendSecureJson(
            response,
            201,
            await options.service.importBitwardenSecureSecret(providerId, input),
          );
          return;
        }

        if (request.method === "GET" && requestUrl.pathname === SECURE_SECRETS_PATH) {
          sendSecureJson(response, 200, await options.service.listSecureSecrets());
          return;
        }

        if (request.method === "POST" && requestUrl.pathname === `${SECURE_SECRETS_PATH}/local`) {
          const input = parseCreateLocalSecretInput(
            await readSecureJsonBody(request, MAX_SECURE_REQUEST_BYTES),
          );
          sendSecureJson(
            response,
            201,
            await options.service.createLocalSecureSecret(input),
          );
          return;
        }

        const secretMatch = requestUrl.pathname.match(
          /^\/api\/secure-secrets\/([^/]+)$/,
        );
        if (secretMatch) {
          const secretId = parsePathId(secretMatch[1], "secretId");
          if (request.method === "PATCH") {
            const input = parseUpdateSecretInput(
              await readSecureJsonBody(request, MAX_SECURE_REQUEST_BYTES),
            );
            sendSecureJson(
              response,
              200,
              await options.service.updateSecureSecret(secretId, input),
            );
            return;
          }
          if (request.method === "DELETE") {
            await options.service.deleteSecureSecret(secretId);
            sendSecureEmpty(response, 204);
            return;
          }
        }

        response.setHeader("Allow", methods);
        sendSecureError(response, "SECURE_REQUEST_INVALID", requestUrl.pathname.startsWith(SECURE_SECRETS_PATH) ? 405 : 404);
      } catch (error) {
        handleSecureRouteError(response, error);
      }
    },
  }];
}

export function applySecureHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  methods: string,
): void {
  applyCorsHeaders(request, response, methods, "content-type,x-forge-secure-control");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

export function sendSecureJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

export function sendSecureEmpty(response: ServerResponse, statusCode: number): void {
  response.statusCode = statusCode;
  response.end();
}

export function sendSecureError(
  response: ServerResponse,
  code: SecureRouteErrorCode,
  statusCode: number,
): void {
  sendJson(response, statusCode, { code, error: code });
}

export function handleSecureRouteError(
  response: ServerResponse,
  error: unknown,
): void {
  const { code, statusCode } = mapSecureRouteError(error);
  sendSecureError(response, code, statusCode);
}

export function parsePathId(rawValue: string | undefined, field: string): string {
  if (!rawValue) {
    throw new SecureSessionsContractError(`${field} is required`);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawValue);
  } catch {
    throw new SecureSessionsContractError(`${field} is invalid`);
  }
  const value = decoded.trim();
  if (
    value.length === 0
    || value.length > MAX_ID_LENGTH
    || /[\0-\x1f\x7f/\\]/.test(value)
    || value === "."
    || value === ".."
  ) {
    throw new SecureSessionsContractError(`${field} is invalid`);
  }
  return value;
}

export function requireObject(
  value: unknown,
  field = "request",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SecureSessionsContractError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function assertKnownKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
): void {
  const unexpected = Object.keys(input).find((key) => !keys.includes(key));
  if (unexpected) {
    throw new SecureSessionsContractError(`request has unexpected field ${unexpected}`);
  }
}

export function parseBaseRevision(
  value: unknown,
  options: { optional?: boolean } = {},
): number | undefined {
  if (value === undefined && options.optional) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SecureSessionsContractError(
      "request.baseRevision must be a non-negative safe integer",
    );
  }
  return value as number;
}

export async function readSecureJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  try {
    return await readJsonBody(request, maxBytes);
  } catch {
    throw new SecureSessionsContractError("request body must be bounded valid JSON");
  }
}

function parseCreateLocalSecretInput(value: unknown): CreateLocalSecureSecretInput {
  const input = requireObject(value);
  assertKnownKeys(input, [
    "displayAlias",
    "displayName",
    "note",
    "encryptedMaterial",
    "bindings",
    "scope",
    "retention",
  ]);
  return {
    displayAlias: parseLabel(input.displayAlias, "displayAlias"),
    ...(input.displayName === undefined
      ? {}
      : { displayName: parseLabel(input.displayName, "displayName") }),
    ...(input.note === undefined
      ? {}
      : { note: parseNote(input.note) }),
    encryptedMaterial: parseEncryptedPayload(input.encryptedMaterial, "encryptedMaterial"),
    ...(input.bindings === undefined
      ? {}
      : { bindings: parseBindings(input.bindings) }),
    ...(input.scope === undefined
      ? {}
      : { scope: parseSecureSecretScope(input.scope) }),
    ...(input.retention === undefined
      ? {}
      : { retention: parseRetention(input.retention) }),
  };
}

function parseSetProjectDefaultInput(value: unknown): { enabled: boolean } {
  const input = requireObject(value);
  assertKnownKeys(input, ["enabled"]);
  if (typeof input.enabled !== "boolean") {
    throw new SecureSessionsContractError("request.enabled must be a boolean");
  }
  return { enabled: input.enabled };
}

function parseUpdateSecretInput(value: unknown): UpdateSecureSecretInput {
  const input = requireObject(value);
  assertKnownKeys(input, [
    "displayAlias",
    "displayName",
    "note",
    "encryptedMaterial",
    "bindings",
    "scope",
    "retention",
  ]);
  if (Object.keys(input).length === 0) {
    throw new SecureSessionsContractError("request must include at least one update");
  }
  return {
    ...(input.displayAlias === undefined
      ? {}
      : { displayAlias: parseLabel(input.displayAlias, "displayAlias") }),
    ...(input.displayName === undefined
      ? {}
      : {
          displayName:
            input.displayName === null
              ? null
              : parseLabel(input.displayName, "displayName"),
        }),
    ...(input.note === undefined
      ? {}
      : { note: input.note === null ? null : parseNote(input.note) }),
    ...(input.encryptedMaterial === undefined
      ? {}
      : {
          encryptedMaterial: parseEncryptedPayload(
            input.encryptedMaterial,
            "encryptedMaterial",
          ),
        }),
    ...(input.bindings === undefined
      ? {}
      : { bindings: parseBindings(input.bindings) }),
    ...(input.scope === undefined
      ? {}
      : { scope: parseSecureSecretScope(input.scope) }),
    ...(input.retention === undefined
      ? {}
      : { retention: parseRetention(input.retention) }),
  };
}

function parseConnectBitwardenInput(
  value: unknown,
): ConnectBitwardenSecureSecretProviderInput {
  const input = requireObject(value);
  assertKnownKeys(input, [
    "displayName",
    "serverOrigin",
    "organizationId",
    "projectId",
    "encryptedAccessToken",
  ]);
  return {
    displayName: parseLabel(input.displayName, "displayName"),
    serverOrigin: parseServerOrigin(input.serverOrigin),
    ...(input.organizationId === undefined
      ? {}
      : { organizationId: parseLabel(input.organizationId, "organizationId") }),
    ...(input.projectId === undefined
      ? {}
      : { projectId: parseLabel(input.projectId, "projectId") }),
    encryptedAccessToken: parseEncryptedPayload(
      input.encryptedAccessToken,
      "encryptedAccessToken",
    ),
  };
}

function parseUpdateBitwardenCredentialInput(
  value: unknown,
): UpdateBitwardenSecureSecretProviderCredentialInput {
  const input = requireObject(value);
  assertKnownKeys(input, ["encryptedAccessToken"]);
  return {
    encryptedAccessToken: parseEncryptedPayload(
      input.encryptedAccessToken,
      "encryptedAccessToken",
    ),
  };
}

function parseImportBitwardenSecretInput(
  value: unknown,
): ImportBitwardenSecureSecretInput {
  const input = requireObject(value);
  assertKnownKeys(input, [
    "sourceLocator",
    "displayAlias",
    "displayName",
    "bindings",
    "scope",
    "retention",
  ]);
  return {
    sourceLocator: parseLabel(input.sourceLocator, "sourceLocator"),
    displayAlias: parseLabel(input.displayAlias, "displayAlias"),
    ...(input.displayName === undefined
      ? {}
      : { displayName: parseLabel(input.displayName, "displayName") }),
    ...(input.bindings === undefined
      ? {}
      : { bindings: parseBindings(input.bindings) }),
    ...(input.scope === undefined
      ? {}
      : { scope: parseSecureSecretScope(input.scope) }),
    ...(input.retention === undefined
      ? {}
      : { retention: parseRetention(input.retention) }),
  };
}

function parseLabel(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > MAX_LABEL_LENGTH
    || value.includes("\0")
  ) {
    throw new SecureSessionsContractError(`${field} is invalid`);
  }
  return value.trim();
}

function parseNote(value: unknown): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > MAX_NOTE_LENGTH
    || value.includes("\0")
  ) {
    throw new SecureSessionsContractError("note is invalid");
  }
  return value.trim();
}

function parseEncryptedPayload(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_ENCRYPTED_PAYLOAD_LENGTH
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new SecureSessionsContractError(`${field} must be a bounded base64 ciphertext`);
  }
  return value;
}

function parseBindings(value: unknown): SecureSecretBinding[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw new SecureSessionsContractError("bindings must be an array with at most 16 entries");
  }
  return value.map((binding) => parseSecureSecretBinding(binding));
}

function parseRetention(value: unknown): SecureSecretRetention {
  if (
    typeof value !== "string"
    || !(SECURE_SECRET_RETENTIONS as readonly string[]).includes(value)
  ) {
    throw new SecureSessionsContractError("retention is invalid");
  }
  return value as SecureSecretRetention;
}

function parseServerOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new SecureSessionsContractError("serverOrigin is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SecureSessionsContractError("serverOrigin is invalid");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new SecureSessionsContractError("serverOrigin must not include credentials, query, or fragment");
  }
  const isLoopbackHttp =
    parsed.protocol === "http:"
    && (parsed.hostname === "127.0.0.1"
      || parsed.hostname === "localhost"
      || parsed.hostname === "::1");
  if (parsed.protocol !== "https:" && !isLoopbackHttp) {
    throw new SecureSessionsContractError("serverOrigin must use HTTPS");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new SecureSessionsContractError("serverOrigin must not include a path");
  }
  return parsed.origin;
}

function mapSecureRouteError(error: unknown): {
  code: SecureRouteErrorCode;
  statusCode: number;
} {
  if (error instanceof SecureSessionsContractError) {
    return { code: "SECURE_REQUEST_INVALID", statusCode: 400 };
  }

  const rawCode = readErrorCode(error);
  switch (rawCode) {
    case "SECURE_BUILDER_ONLY":
      return { code: "SECURE_BUILDER_ONLY", statusCode: 404 };
    case "SECURE_PRIVATE_API_UNAVAILABLE":
      return { code: "SECURE_PRIVATE_API_UNAVAILABLE", statusCode: 503 };
    case "SECURE_REQUEST_INVALID":
    case "SECURE_SECRET_EMPTY":
    case "SECURE_SECRET_RELEASED":
    case "SECURE_SECRET_SERIALIZATION_BLOCKED":
    case "secure_session_id_conflict":
    case "INVALID_COMMAND":
    case "INVALID_DELIVERY":
    case "INVALID_TASK":
    case "SECURE_VAULT_INVALID_REQUEST":
    case "SECURE_VAULT_PAYLOAD_TOO_LARGE":
      return { code: "SECURE_REQUEST_INVALID", statusCode: 400 };
    case "SECURE_SOURCE_LOCKED":
      return { code: "SECURE_SOURCE_LOCKED", statusCode: 423 };
    case "SECURE_SOURCE_AUTH_REQUIRED":
    case "SECURE_PROVIDER_AUTH_REQUIRED":
      return { code: "SECURE_PROVIDER_AUTH_REQUIRED", statusCode: 401 };
    case "SECURE_SOURCE_NOT_FOUND":
    case "SECURE_SECRET_NOT_FOUND":
    case "secure_session_not_found":
      return { code: "SECURE_SECRET_NOT_FOUND", statusCode: 404 };
    case "secure_session_revision_conflict":
    case "SECURE_STALE_REVISION":
      return { code: "SECURE_STALE_REVISION", statusCode: 409 };
    case "SECURE_SECRET_ALIAS_CONFLICT":
      return { code: "SECURE_SECRET_ALIAS_CONFLICT", statusCode: 409 };
    case "SECURE_PROJECT_DEFAULT_LIMIT_REACHED":
      return { code: "SECURE_PROJECT_DEFAULT_LIMIT_REACHED", statusCode: 409 };
    case "SECURE_SOURCE_UNAVAILABLE":
    case "SECURE_SOURCE_TIMEOUT":
    case "SECURE_SOURCE_RESPONSE_INVALID":
    case "BACKEND_UNAVAILABLE":
    case "IMAGE_UNAVAILABLE":
    case "UNSUPPORTED_PLATFORM":
    case "SECURE_VAULT_STORAGE_UNAVAILABLE":
    case "SECURE_VAULT_INSECURE_STORAGE":
    case "SECURE_VAULT_ENCRYPT_FAILED":
    case "SECURE_VAULT_DECRYPT_FAILED":
      return { code: "SECURE_SOURCE_UNAVAILABLE", statusCode: 503 };
    case "SECURE_OPERATION_FAILED":
      return { code: "SECURE_OPERATION_FAILED", statusCode: 500 };
    default:
      return { code: "SECURE_OPERATION_FAILED", statusCode: 500 };
  }
}

function readErrorCode(error: unknown): string | undefined {
  if (
    typeof error !== "object"
    || error === null
    || !("code" in error)
    || typeof (error as { code?: unknown }).code !== "string"
  ) {
    return undefined;
  }
  return (error as { code: string }).code;
}
