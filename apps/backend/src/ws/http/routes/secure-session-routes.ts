import {
  SecureSessionsContractError,
  parseGrantSecureSecretLeaseRequest,
  parseGrantSecureSecretLeasesRequest,
  parseResolveSecureSecretAccessRequest,
  parseRevokeSecureSecretLeaseRequest,
  parseSecureSecretBinding,
  type GrantSecureSecretLeaseRequest,
  type GrantSecureSecretLeasesRequest,
  type ResolveSecureSecretAccessRequest,
  type SecureSecretBinding,
  type SecureSecretLeaseKind,
  type SecureSessionSnapshot,
} from "@forge/protocol";
import type { HttpRoute } from "../shared/http-route.js";
import {
  applySecureHeaders,
  assertKnownKeys,
  handleSecureRouteError,
  parseBaseRevision,
  parsePathId,
  readSecureJsonBody,
  requireObject,
  sendSecureError,
  sendSecureJson,
} from "./secure-secret-routes.js";

const SECURE_SESSIONS_PATH = "/api/secure-sessions";
const MAX_SECURE_REQUEST_BYTES = 256 * 1024;
const MAX_LABEL_LENGTH = 256;
const MAX_ENCRYPTED_PAYLOAD_LENGTH = 2 * 1024 * 1024;

export interface StartSecureSessionInput {
  baseRevision?: number;
}

export interface StopSecureSessionInput {
  baseRevision: number;
  stopProcesses: true;
}

export type FulfillSecureAccessRequestInput = {
  baseRevision: number;
  displayAlias: string;
  encryptedMaterial: string;
  exposures: SecureSecretBinding[];
} & (
  | { leaseKind: Exclude<SecureSecretLeaseKind, "timed"> }
  | { leaseKind: "timed"; durationSeconds: number }
);

export interface SecureSessionsTransportService {
  getSecureSessionSnapshot(
    sessionAgentId: string,
  ): Promise<SecureSessionSnapshot> | SecureSessionSnapshot;
  startSecureSession(
    sessionAgentId: string,
    input: StartSecureSessionInput,
  ): Promise<SecureSessionSnapshot>;
  stopSecureSession(
    sessionAgentId: string,
    input: StopSecureSessionInput,
  ): Promise<SecureSessionSnapshot>;
  grantSecureSessionLease(
    sessionAgentId: string,
    input: GrantSecureSecretLeaseRequest,
  ): Promise<SecureSessionSnapshot>;
  grantSecureSessionLeases(
    sessionAgentId: string,
    input: GrantSecureSecretLeasesRequest,
  ): Promise<SecureSessionSnapshot>;
  revokeSecureSessionLease(
    sessionAgentId: string,
    input: ReturnType<typeof parseRevokeSecureSecretLeaseRequest>,
  ): Promise<SecureSessionSnapshot>;
  resolveSecureAccessRequest(
    sessionAgentId: string,
    requestId: string,
    input: ResolveSecureSecretAccessRequest,
  ): Promise<SecureSessionSnapshot>;
  fulfillSecureAccessRequest(
    sessionAgentId: string,
    requestId: string,
    input: FulfillSecureAccessRequestInput,
  ): Promise<SecureSessionSnapshot>;
}

export function createSecureSessionRoutes(options: {
  service: SecureSessionsTransportService;
}): HttpRoute[] {
  const methods = "GET, POST, DELETE, OPTIONS";

  return [{
    methods,
    matches: (pathname) =>
      pathname === SECURE_SESSIONS_PATH
      || pathname.startsWith(`${SECURE_SESSIONS_PATH}/`),
    handle: async (request, response, requestUrl) => {
      applySecureHeaders(request, response, methods);

      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }

      try {
        const sessionRootMatch = requestUrl.pathname.match(
          /^\/api\/secure-sessions\/([^/]+)$/,
        );
        if (request.method === "GET" && sessionRootMatch) {
          const sessionAgentId = parsePathId(sessionRootMatch[1], "sessionAgentId");
          sendSecureJson(
            response,
            200,
            await options.service.getSecureSessionSnapshot(sessionAgentId),
          );
          return;
        }

        const lifecycleMatch = requestUrl.pathname.match(
          /^\/api\/secure-sessions\/([^/]+)\/(start|stop)$/,
        );
        if (request.method === "POST" && lifecycleMatch) {
          const sessionAgentId = parsePathId(lifecycleMatch[1], "sessionAgentId");
          const action = lifecycleMatch[2];
          const body = await readSecureJsonBody(request, MAX_SECURE_REQUEST_BYTES);
          const snapshot = action === "start"
            ? await options.service.startSecureSession(
                sessionAgentId,
                parseStartInput(body),
              )
            : await options.service.stopSecureSession(
                sessionAgentId,
                parseStopInput(body),
              );
          sendSecureJson(response, 200, snapshot);
          return;
        }

        const leasesMatch = requestUrl.pathname.match(
          /^\/api\/secure-sessions\/([^/]+)\/leases$/,
        );
        if (request.method === "POST" && leasesMatch) {
          const sessionAgentId = parsePathId(leasesMatch[1], "sessionAgentId");
          const input = parseGrantSecureSecretLeaseRequest(
            await readSecureJsonBody(request, MAX_SECURE_REQUEST_BYTES),
          );
          sendSecureJson(
            response,
            200,
            await options.service.grantSecureSessionLease(sessionAgentId, input),
          );
          return;
        }

        const batchLeasesMatch = requestUrl.pathname.match(
          /^\/api\/secure-sessions\/([^/]+)\/leases\/batch$/,
        );
        if (request.method === "POST" && batchLeasesMatch) {
          const sessionAgentId = parsePathId(
            batchLeasesMatch[1],
            "sessionAgentId",
          );
          const input = parseGrantSecureSecretLeasesRequest(
            await readSecureJsonBody(request, MAX_SECURE_REQUEST_BYTES),
          );
          sendSecureJson(
            response,
            200,
            await options.service.grantSecureSessionLeases(
              sessionAgentId,
              input,
            ),
          );
          return;
        }

        const leaseMatch = requestUrl.pathname.match(
          /^\/api\/secure-sessions\/([^/]+)\/leases\/([^/]+)$/,
        );
        if (request.method === "DELETE" && leaseMatch) {
          const sessionAgentId = parsePathId(leaseMatch[1], "sessionAgentId");
          const leaseId = parsePathId(leaseMatch[2], "leaseId");
          const body = requireObject(
            await readSecureJsonBody(request, MAX_SECURE_REQUEST_BYTES),
          );
          assertKnownKeys(body, ["baseRevision"]);
          const input = parseRevokeSecureSecretLeaseRequest({
            baseRevision: body.baseRevision,
            leaseId,
          });
          sendSecureJson(
            response,
            200,
            await options.service.revokeSecureSessionLease(sessionAgentId, input),
          );
          return;
        }

        const accessMatch = requestUrl.pathname.match(
          /^\/api\/secure-sessions\/([^/]+)\/access-requests\/([^/]+)\/(resolve|fulfill)$/,
        );
        if (request.method === "POST" && accessMatch) {
          const sessionAgentId = parsePathId(accessMatch[1], "sessionAgentId");
          const requestId = parsePathId(accessMatch[2], "requestId");
          const action = accessMatch[3];
          const body = await readSecureJsonBody(request, MAX_SECURE_REQUEST_BYTES);
          const snapshot = action === "resolve"
            ? await options.service.resolveSecureAccessRequest(
                sessionAgentId,
                requestId,
                parseResolveInput(requestId, body),
              )
            : await options.service.fulfillSecureAccessRequest(
                sessionAgentId,
                requestId,
                parseFulfillInput(body),
              );
          sendSecureJson(response, 200, snapshot);
          return;
        }

        response.setHeader("Allow", methods);
        sendSecureError(
          response,
          "SECURE_REQUEST_INVALID",
          requestUrl.pathname.startsWith(SECURE_SESSIONS_PATH) ? 405 : 404,
        );
      } catch (error) {
        handleSecureRouteError(response, error);
      }
    },
  }];
}

function parseStartInput(value: unknown): StartSecureSessionInput {
  const input = requireObject(value);
  assertKnownKeys(input, ["baseRevision"]);
  const baseRevision = parseBaseRevision(input.baseRevision, { optional: true });
  return baseRevision === undefined ? {} : { baseRevision };
}

function parseStopInput(value: unknown): StopSecureSessionInput {
  const input = requireObject(value);
  assertKnownKeys(input, ["baseRevision", "stopProcesses"]);
  if (input.stopProcesses !== true) {
    throw new SecureSessionsContractError("request.stopProcesses must be true");
  }
  return {
    baseRevision: parseBaseRevision(input.baseRevision) as number,
    stopProcesses: true,
  };
}

function parseResolveInput(
  requestId: string,
  value: unknown,
): ResolveSecureSecretAccessRequest {
  const input = requireObject(value);
  assertKnownKeys(input, ["baseRevision", "decision", "reason"]);
  return parseResolveSecureSecretAccessRequest({
    ...input,
    requestId,
  });
}

function parseFulfillInput(value: unknown): FulfillSecureAccessRequestInput {
  const input = requireObject(value);
  assertKnownKeys(input, [
    "baseRevision",
    "displayAlias",
    "encryptedMaterial",
    "leaseKind",
    "durationSeconds",
    "exposures",
  ]);
  const grant = parseGrantSecureSecretLeaseRequest({
    baseRevision: input.baseRevision,
    secretId: "fulfill-private-secret",
    exposures: input.exposures,
    leaseKind: input.leaseKind,
    ...(input.durationSeconds === undefined
      ? {}
      : { durationSeconds: input.durationSeconds }),
  });
  const displayAlias = parseDisplayAlias(input.displayAlias);
  const encryptedMaterial = parseEncryptedMaterial(input.encryptedMaterial);
  return {
    baseRevision: grant.baseRevision,
    displayAlias,
    encryptedMaterial,
    exposures: grant.exposures.map((exposure) =>
      parseSecureSecretBinding(exposure)
    ),
    leaseKind: grant.leaseKind,
    ...(grant.leaseKind === "timed"
      ? { durationSeconds: grant.durationSeconds }
      : {}),
  } as FulfillSecureAccessRequestInput;
}

function parseDisplayAlias(value: unknown): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > MAX_LABEL_LENGTH
    || value.includes("\0")
  ) {
    throw new SecureSessionsContractError("request.displayAlias is invalid");
  }
  return value.trim();
}

function parseEncryptedMaterial(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_ENCRYPTED_PAYLOAD_LENGTH
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new SecureSessionsContractError(
      "request.encryptedMaterial must be a bounded base64 ciphertext",
    );
  }
  return value;
}
