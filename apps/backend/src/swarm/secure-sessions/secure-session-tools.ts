import { Type, type TSchema } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  SECURE_SECRET_MAX_TIMED_LEASE_SECONDS,
  parseSecureSecretBinding,
  parseSecureSecretLeaseSpec,
  type SecureSecretBinding,
  type SecureSecretLeaseKind,
  type SecureSecretLeaseStatus,
  type SecureSessionEnvironmentStatus,
  type SecureSessionExecutionMode,
} from "@forge/protocol";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import type { AgentDescriptor } from "../types.js";

const MAX_ALIAS_LENGTH = 256;
const MAX_PURPOSE_LENGTH = 2_000;
const MAX_TARGET_LENGTH = 4_096;
const MAX_EXPOSURES = 16;
const MAX_VIEW_ENTRIES = 256;
const MAX_TIMESTAMP_LENGTH = 128;

export type RequestSecureSecretAccessToolInput = {
  displayAlias: string;
  purposeSummary: string;
  exposures: SecureSecretBinding[];
} & (
  | { leaseKind: "task" }
  | { leaseKind: "timed"; durationSeconds: number }
  | { leaseKind: "one_use" }
);

export interface SecureSessionAgentLeaseView {
  displayAlias: string;
  leaseKind: SecureSecretLeaseKind;
  exposures: SecureSecretBinding[];
  status: SecureSecretLeaseStatus;
  expiresAt: string | null;
  lastUsedAt: string | null;
  remainingUses: number | null;
}

export interface SecureSessionAgentPendingRequestView {
  displayAlias: string;
  requestedLeaseKind: SecureSecretLeaseKind;
  requestedDurationSeconds?: number;
  requestedExposures: SecureSecretBinding[];
  purposeSummary: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface SecureSessionAvailableSecretView {
  displayAlias: string;
  bindings: SecureSecretBinding[];
}

/**
 * Agent-visible Secure Sessions metadata. This deliberately has no provider,
 * secret id, source locator, encrypted material, or secret material fields.
 */
export interface SecureSessionAgentView {
  revision: number;
  executionMode: SecureSessionExecutionMode;
  environmentStatus: SecureSessionEnvironmentStatus;
  leases: SecureSessionAgentLeaseView[];
  pendingRequests: SecureSessionAgentPendingRequestView[];
  availableSecrets: SecureSessionAvailableSecretView[];
  updatedAt: string;
}

const targetNameSchema = Type.String({
  minLength: 1,
  maxLength: MAX_TARGET_LENGTH,
});

const bindingSchema = Type.Union([
  Type.Object(
    {
      deliveryKind: Type.Literal("environment"),
      targetName: targetNameSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      deliveryKind: Type.Literal("stdin"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      deliveryKind: Type.Literal("file"),
      targetPath: Type.String({ minLength: 1, maxLength: MAX_TARGET_LENGTH }),
      fileMode: Type.Optional(Type.Integer({ minimum: 0, maximum: 0o777 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      deliveryKind: Type.Literal("askpass"),
      targetName: targetNameSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      deliveryKind: Type.Literal("ssh_agent"),
    },
    { additionalProperties: false },
  ),
]);

const requestBaseSchema = {
  displayAlias: Type.String({ minLength: 1, maxLength: MAX_ALIAS_LENGTH }),
  purposeSummary: Type.String({ minLength: 1, maxLength: MAX_PURPOSE_LENGTH }),
  exposures: Type.Array(bindingSchema, {
    minItems: 1,
    maxItems: MAX_EXPOSURES,
  }),
};

const requestSecretAccessSchema = Type.Union([
  Type.Object(
    {
      ...requestBaseSchema,
      leaseKind: Type.Literal("task"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...requestBaseSchema,
      leaseKind: Type.Literal("timed"),
      durationSeconds: Type.Integer({
        minimum: 1,
        maximum: SECURE_SECRET_MAX_TIMED_LEASE_SECONDS,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...requestBaseSchema,
      leaseKind: Type.Literal("one_use"),
    },
    { additionalProperties: false },
  ),
]);

class SafeToolInputError extends Error {
  constructor() {
    super("invalid_input");
    this.name = "SafeToolInputError";
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function boundedString(input: unknown, maximum: number): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input.length > maximum ||
    input.includes("\0")
  ) {
    throw new SafeToolInputError();
  }
  return input;
}

function optionalTimestamp(input: unknown): string | null {
  if (input === null) {
    return null;
  }
  return boundedString(input, MAX_TIMESTAMP_LENGTH);
}

function nonNegativeInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new SafeToolInputError();
  }
  return input as number;
}

function knownKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new SafeToolInputError();
  }
}

function parseRequestInput(input: unknown): RequestSecureSecretAccessToolInput {
  if (!isRecord(input)) {
    throw new SafeToolInputError();
  }

  const lease = parseSecureSecretLeaseSpec({
    leaseKind: input.leaseKind,
    ...(input.durationSeconds === undefined
      ? {}
      : { durationSeconds: input.durationSeconds }),
  });
  knownKeys(
    input,
    lease.leaseKind === "timed"
      ? [
          "displayAlias",
          "purposeSummary",
          "exposures",
          "leaseKind",
          "durationSeconds",
        ]
      : ["displayAlias", "purposeSummary", "exposures", "leaseKind"],
  );

  if (
    !Array.isArray(input.exposures) ||
    input.exposures.length === 0 ||
    input.exposures.length > MAX_EXPOSURES
  ) {
    throw new SafeToolInputError();
  }

  return {
    displayAlias: boundedString(input.displayAlias, MAX_ALIAS_LENGTH),
    purposeSummary: boundedString(input.purposeSummary, MAX_PURPOSE_LENGTH),
    exposures: input.exposures.map((exposure) =>
      projectBinding(parseSecureSecretBinding(exposure))
    ),
    ...lease,
  };
}

function projectBinding(input: SecureSecretBinding): SecureSecretBinding {
  switch (input.deliveryKind) {
    case "environment":
    case "askpass":
      return {
        deliveryKind: input.deliveryKind,
        targetName: boundedString(input.targetName, MAX_TARGET_LENGTH),
      };
    case "stdin":
    case "ssh_agent":
      return { deliveryKind: input.deliveryKind };
    case "file":
      return {
        deliveryKind: "file",
        targetPath: boundedString(input.targetPath, MAX_TARGET_LENGTH),
        ...(input.fileMode === undefined
          ? {}
          : { fileMode: nonNegativeInteger(input.fileMode) }),
      };
  }
}

function projectBindings(input: unknown): SecureSecretBinding[] {
  if (!Array.isArray(input) || input.length > MAX_EXPOSURES) {
    throw new SafeToolInputError();
  }
  return input.map((binding) =>
    projectBinding(parseSecureSecretBinding(binding))
  );
}

function secureLeaseKind(input: unknown): SecureSecretLeaseKind {
  if (input !== "task" && input !== "timed" && input !== "one_use") {
    throw new SafeToolInputError();
  }
  return input;
}

function secureLeaseStatus(input: unknown): SecureSecretLeaseStatus {
  if (
    input !== "active" &&
    input !== "consumed" &&
    input !== "revoked" &&
    input !== "expired"
  ) {
    throw new SafeToolInputError();
  }
  return input;
}

function projectAgentView(input: SecureSessionAgentView): SecureSessionAgentView {
  if (!isRecord(input)) {
    throw new SafeToolInputError();
  }
  if (input.executionMode !== "standard" && input.executionMode !== "secure") {
    throw new SafeToolInputError();
  }
  if (
    input.environmentStatus !== "stopped" &&
    input.environmentStatus !== "starting" &&
    input.environmentStatus !== "ready" &&
    input.environmentStatus !== "degraded" &&
    input.environmentStatus !== "failed"
  ) {
    throw new SafeToolInputError();
  }
  if (
    !Array.isArray(input.leases) ||
    !Array.isArray(input.pendingRequests) ||
    !Array.isArray(input.availableSecrets) ||
    input.leases.length > MAX_VIEW_ENTRIES ||
    input.pendingRequests.length > MAX_VIEW_ENTRIES ||
    input.availableSecrets.length > MAX_VIEW_ENTRIES
  ) {
    throw new SafeToolInputError();
  }

  return {
    revision: nonNegativeInteger(input.revision),
    executionMode: input.executionMode,
    environmentStatus: input.environmentStatus,
    leases: input.leases.map((lease) => {
      if (!isRecord(lease)) {
        throw new SafeToolInputError();
      }
      const remainingUses =
        lease.remainingUses === null
          ? null
          : nonNegativeInteger(lease.remainingUses);
      return {
        displayAlias: boundedString(lease.displayAlias, MAX_ALIAS_LENGTH),
        leaseKind: secureLeaseKind(lease.leaseKind),
        exposures: projectBindings(lease.exposures),
        status: secureLeaseStatus(lease.status),
        expiresAt: optionalTimestamp(lease.expiresAt),
        lastUsedAt: optionalTimestamp(lease.lastUsedAt),
        remainingUses,
      };
    }),
    pendingRequests: input.pendingRequests.map((request) => {
      if (!isRecord(request)) {
        throw new SafeToolInputError();
      }
      const requestedLeaseKind = secureLeaseKind(request.requestedLeaseKind);
      const requestedDurationSeconds =
        request.requestedDurationSeconds === undefined
          ? undefined
          : nonNegativeInteger(request.requestedDurationSeconds);
      if (
        (requestedLeaseKind === "timed") !==
        (requestedDurationSeconds !== undefined)
      ) {
        throw new SafeToolInputError();
      }
      return {
        displayAlias: boundedString(request.displayAlias, MAX_ALIAS_LENGTH),
        requestedLeaseKind,
        ...(requestedDurationSeconds === undefined
          ? {}
          : { requestedDurationSeconds }),
        requestedExposures: projectBindings(request.requestedExposures),
        purposeSummary: boundedString(
          request.purposeSummary,
          MAX_PURPOSE_LENGTH,
        ),
        createdAt: boundedString(request.createdAt, MAX_TIMESTAMP_LENGTH),
        expiresAt: optionalTimestamp(request.expiresAt),
      };
    }),
    availableSecrets: input.availableSecrets.map((secret) => {
      if (!isRecord(secret)) {
        throw new SafeToolInputError();
      }
      return {
        displayAlias: boundedString(secret.displayAlias, MAX_ALIAS_LENGTH),
        bindings: projectBindings(secret.bindings),
      };
    }),
    updatedAt: boundedString(input.updatedAt, MAX_TIMESTAMP_LENGTH),
  };
}

function fixedFailure(code: "invalid_input" | "status_unavailable" | "request_failed") {
  const payload = {
    ok: false,
    error: { code },
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
    isError: true,
  };
}

function fixedSuccess(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
  };
}

function isBuilderSurface(
  host: SwarmToolHost,
  descriptor: AgentDescriptor,
): boolean {
  if (descriptor.role === "manager") {
    return descriptor.sessionSurface !== "collab";
  }
  const owner = host
    .listAgents()
    .find(
      (agent) =>
        agent.role === "manager" && agent.agentId === descriptor.managerId,
    );
  return owner?.sessionSurface !== "collab";
}

function statusTool(host: SwarmToolHost, descriptor: AgentDescriptor): ToolDefinition {
  return {
    name: "secure_session_status",
    label: "Secure Session Status",
    description:
      "Inspect this Builder session's safe Secure Sessions metadata, including active lease state and the available display aliases and guest bindings. Secret values and provider locators are never returned.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      if (!isRecord(params) || Object.keys(params).length > 0) {
        return fixedFailure("invalid_input");
      }
      if (!host.getSecureSessionAgentView) {
        return fixedFailure("status_unavailable");
      }
      try {
        const view = projectAgentView(
          await host.getSecureSessionAgentView(descriptor.agentId),
        );
        return fixedSuccess({
          ok: true,
          status: "available",
          session: view,
        });
      } catch {
        return fixedFailure("status_unavailable");
      }
    },
  };
}

function requestAccessTool(
  host: SwarmToolHost,
  descriptor: AgentDescriptor,
): ToolDefinition {
  return {
    name: "request_secret_access",
    label: "Request Secret Access",
    description:
      "Request user approval to use an available secret display alias in this Builder session. Supply only the alias, a bounded purpose, lease policy, and guest exposure bindings; never supply secret material.",
    parameters: requestSecretAccessSchema,
    async execute(toolCallId, params) {
      let input: RequestSecureSecretAccessToolInput;
      try {
        input = parseRequestInput(params);
      } catch {
        return fixedFailure("invalid_input");
      }
      if (!host.requestSecureSecretAccess) {
        return fixedFailure("request_failed");
      }
      try {
        await host.requestSecureSecretAccess(
          descriptor.agentId,
          toolCallId,
          input,
        );
        return fixedSuccess({
          ok: true,
          status: "requested",
        });
      } catch {
        return fixedFailure("request_failed");
      }
    },
  };
}

export function buildSecureSessionTools(
  host: SwarmToolHost,
  descriptor: AgentDescriptor,
): ToolDefinition[] {
  if (!isBuilderSurface(host, descriptor)) {
    return [];
  }

  const tools: ToolDefinition[] = [];
  if (host.getSecureSessionAgentView) {
    tools.push(statusTool(host, descriptor));
  }
  if (host.requestSecureSecretAccess) {
    tools.push(requestAccessTool(host, descriptor));
  }
  return tools;
}

export const secureSessionToolSchemas: Readonly<{
  secure_session_status: TSchema;
  request_secret_access: TSchema;
}> = Object.freeze({
  secure_session_status: Type.Object({}, { additionalProperties: false }),
  request_secret_access: requestSecretAccessSchema,
});
