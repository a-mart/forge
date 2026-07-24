import { TypeCompiler } from "@sinclair/typebox/compiler";
import type { TSchema } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type {
  SecureSessionAgentView,
} from "../secure-sessions/secure-session-tools.js";
import { buildSwarmTools } from "../swarm-tools.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import type { AgentDescriptor } from "../types.js";

const LEAK_MARKER = "must-not-reach-agent-output";

function manager(
  patch: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId: "manager-1",
    managerId: "manager-1",
    role: "manager",
    displayName: "Manager",
    status: "idle",
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    cwd: "/repo",
    model: {
      provider: "openai",
      modelId: "gpt-5",
      thinkingLevel: "medium",
    },
    sessionFile: "/data/manager.jsonl",
    sessionSurface: "builder",
    ...patch,
  };
}

function worker(
  patch: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId: "worker-1",
    managerId: "manager-1",
    role: "worker",
    displayName: "Worker",
    status: "idle",
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    cwd: "/repo",
    model: {
      provider: "openai",
      modelId: "gpt-5",
      thinkingLevel: "medium",
    },
    sessionFile: "/data/worker.jsonl",
    ...patch,
  };
}

function safeView(): SecureSessionAgentView {
  return {
    revision: 4,
    executionMode: "secure",
    environmentStatus: "ready",
    leases: [
      {
        displayAlias: "github-work",
        leaseKind: "task",
        exposures: [
          {
            deliveryKind: "environment",
            targetName: "GITHUB_TOKEN",
          },
        ],
        status: "active",
        expiresAt: null,
        lastUsedAt: null,
        remainingUses: null,
      },
    ],
    pendingRequests: [
      {
        displayAlias: "deploy-key",
        requestedLeaseKind: "timed",
        requestedDurationSeconds: 300,
        requestedExposures: [
          {
            deliveryKind: "file",
            targetPath: ".secure/deploy-key",
            fileMode: 0o400,
          },
        ],
        purposeSummary: "Authenticate the approved deployment command.",
        createdAt: "2026-07-23T00:00:00.000Z",
        expiresAt: "2026-07-23T00:05:00.000Z",
      },
    ],
    availableSecrets: [
      {
        displayAlias: "github-work",
        bindings: [
          {
            deliveryKind: "environment",
            targetName: "GITHUB_TOKEN",
          },
        ],
      },
    ],
    updatedAt: "2026-07-23T00:00:00.000Z",
  };
}

function host(
  overrides: Partial<SwarmToolHost> = {},
): SwarmToolHost {
  return {
    listAgents: () => [manager()],
    getWorkerActivity: () => undefined,
    getSecureSessionAgentView: () => safeView(),
    requestSecureSecretAccess: async () => {},
    ...overrides,
  } as SwarmToolHost;
}

function toolByName(
  tools: ToolDefinition[],
  name: string,
): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Missing ${name}`);
  }
  return tool;
}

function resultJson(result: unknown): string {
  return JSON.stringify(result);
}

function propertyNames(schema: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const entry of schema) {
      propertyNames(entry, names);
    }
    return names;
  }
  if (typeof schema !== "object" || schema === null) {
    return names;
  }
  const record = schema as Record<string, unknown>;
  if (typeof record.properties === "object" && record.properties !== null) {
    for (const key of Object.keys(record.properties)) {
      names.add(key);
    }
  }
  for (const nested of Object.values(record)) {
    propertyNames(nested, names);
  }
  return names;
}

describe("secure session agent tools", () => {
  it("exposes both capabilities to Builder managers and their workers", () => {
    const toolHost = host();
    const managerTools = buildSwarmTools(toolHost, manager()).map(
      (tool) => tool.name,
    );
    const workerTools = buildSwarmTools(toolHost, worker()).map(
      (tool) => tool.name,
    );

    expect(managerTools).toEqual(
      expect.arrayContaining([
        "secure_session_status",
        "request_secret_access",
      ]),
    );
    expect(workerTools).toEqual(
      expect.arrayContaining([
        "secure_session_status",
        "request_secret_access",
      ]),
    );
  });

  it("excludes Collaboration while treating legacy unspecified surfaces as Builder", () => {
    const collabManager = manager({ sessionSurface: "collab" });
    const collabHost = host({ listAgents: () => [collabManager] });
    const collabNames = buildSwarmTools(collabHost, collabManager).map(
      (tool) => tool.name,
    );
    const collabWorkerNames = buildSwarmTools(collabHost, worker()).map(
      (tool) => tool.name,
    );
    const unspecifiedManagerNames = buildSwarmTools(
      host(),
      manager({ sessionSurface: undefined }),
    ).map((tool) => tool.name);

    expect(collabNames).not.toContain("secure_session_status");
    expect(collabNames).not.toContain("request_secret_access");
    expect(collabWorkerNames).not.toContain("secure_session_status");
    expect(collabWorkerNames).not.toContain("request_secret_access");
    expect(unspecifiedManagerNames).toContain("secure_session_status");
    expect(unspecifiedManagerNames).toContain("request_secret_access");
  });

  it("gates each tool on its corresponding optional host capability", () => {
    const statusOnly = host({ requestSecureSecretAccess: undefined });
    const requestOnly = host({ getSecureSessionAgentView: undefined });
    const neither = host({
      getSecureSessionAgentView: undefined,
      requestSecureSecretAccess: undefined,
    });

    expect(buildSwarmTools(statusOnly, manager()).map((tool) => tool.name)).toContain(
      "secure_session_status",
    );
    expect(
      buildSwarmTools(statusOnly, manager()).map((tool) => tool.name),
    ).not.toContain("request_secret_access");
    expect(
      buildSwarmTools(requestOnly, manager()).map((tool) => tool.name),
    ).not.toContain("secure_session_status");
    expect(
      buildSwarmTools(requestOnly, manager()).map((tool) => tool.name),
    ).toContain("request_secret_access");
    expect(
      buildSwarmTools(neither, manager()).map((tool) => tool.name),
    ).not.toEqual(
      expect.arrayContaining([
        "secure_session_status",
        "request_secret_access",
      ]),
    );
  });

  it("returns a reprojected metadata-only status snapshot", async () => {
    const unsafeView = safeView() as SecureSessionAgentView &
      Record<string, unknown>;
    unsafeView.ciphertext = LEAK_MARKER;
    unsafeView.sourceLocator = LEAK_MARKER;
    unsafeView.value = LEAK_MARKER;
    Object.assign(unsafeView.availableSecrets[0]!, {
      ciphertext: LEAK_MARKER,
      sourceLocator: LEAK_MARKER,
      value: LEAK_MARKER,
    });
    Object.assign(unsafeView.leases[0]!, {
      encryptedMaterial: LEAK_MARKER,
      value: LEAK_MARKER,
    });

    const status = toolByName(
      buildSwarmTools(
        host({ getSecureSessionAgentView: () => unsafeView }),
        manager(),
      ),
      "secure_session_status",
    );
    const result = await status.execute("status-1", {});
    const serialized = resultJson(result);

    expect(result.details).toMatchObject({
      ok: true,
      status: "available",
      session: {
        revision: 4,
        availableSecrets: [
          {
            displayAlias: "github-work",
            bindings: [
              {
                deliveryKind: "environment",
                targetName: "GITHUB_TOKEN",
              },
            ],
          },
        ],
      },
    });
    expect(serialized).not.toContain(LEAK_MARKER);
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("sourceLocator");
    expect(serialized).not.toContain("encryptedMaterial");
    expect(serialized).not.toContain('"value"');
  });

  it("defines closed schemas with no raw-material field", () => {
    const tools = buildSwarmTools(host(), manager());
    const status = toolByName(tools, "secure_session_status");
    const request = toolByName(tools, "request_secret_access");
    const statusCheck = TypeCompiler.Compile(status.parameters as TSchema);
    const requestCheck = TypeCompiler.Compile(request.parameters as TSchema);
    const valid = {
      displayAlias: "github-work",
      purposeSummary: "Read repository issue metadata.",
      leaseKind: "timed",
      durationSeconds: 300,
      exposures: [
        {
          deliveryKind: "environment",
          targetName: "GITHUB_TOKEN",
        },
      ],
    };

    expect(statusCheck.Check({})).toBe(true);
    expect(statusCheck.Check({ value: LEAK_MARKER })).toBe(false);
    expect(requestCheck.Check(valid)).toBe(true);
    expect(requestCheck.Check({ ...valid, value: LEAK_MARKER })).toBe(false);
    expect(
      requestCheck.Check({
        ...valid,
        exposures: [
          {
            deliveryKind: "environment",
            targetName: "GITHUB_TOKEN",
            ciphertext: LEAK_MARKER,
          },
        ],
      }),
    ).toBe(false);
    expect(
      requestCheck.Check({
        ...valid,
        leaseKind: "task",
        durationSeconds: 300,
      }),
    ).toBe(false);

    const names = propertyNames(request.parameters);
    expect(names).not.toContain("value");
    expect(names).not.toContain("rawValue");
    expect(names).not.toContain("ciphertext");
    expect(names).not.toContain("sourceLocator");
    expect(names).not.toContain("secretId");
  });

  it("rejects direct status fields without consulting the host", async () => {
    const getView = vi.fn(() => safeView());
    const status = toolByName(
      buildSwarmTools(
        host({ getSecureSessionAgentView: getView }),
        manager(),
      ),
      "secure_session_status",
    );

    const result = await status.execute("status-unknown", {
      ciphertext: LEAK_MARKER,
    });

    expect(result).toMatchObject({
      isError: true,
      details: { ok: false, error: { code: "invalid_input" } },
    });
    expect(resultJson(result)).not.toContain(LEAK_MARKER);
    expect(getView).not.toHaveBeenCalled();
  });

  it("rejects direct unknown and nested material fields without calling the host", async () => {
    const requestAccess = vi.fn(async () => {});
    const request = toolByName(
      buildSwarmTools(
        host({ requestSecureSecretAccess: requestAccess }),
        manager(),
      ),
      "request_secret_access",
    );
    const base = {
      displayAlias: "github-work",
      purposeSummary: "Read repository issue metadata.",
      leaseKind: "task",
      exposures: [
        {
          deliveryKind: "environment",
          targetName: "GITHUB_TOKEN",
        },
      ],
    };

    const topLevel = await request.execute("request-1", {
      ...base,
      value: LEAK_MARKER,
    });
    const nested = await request.execute("request-2", {
      ...base,
      exposures: [
        {
          ...base.exposures[0],
          sourceLocator: LEAK_MARKER,
        },
      ],
    });

    expect(topLevel).toMatchObject({
      isError: true,
      details: { ok: false, error: { code: "invalid_input" } },
    });
    expect(nested).toMatchObject({
      isError: true,
      details: { ok: false, error: { code: "invalid_input" } },
    });
    expect(resultJson([topLevel, nested])).not.toContain(LEAK_MARKER);
    expect(requestAccess).not.toHaveBeenCalled();
  });

  it("passes only validated metadata and returns a fixed request receipt", async () => {
    const requestAccess = vi.fn(async () => {});
    const request = toolByName(
      buildSwarmTools(
        host({ requestSecureSecretAccess: requestAccess }),
        worker(),
      ),
      "request_secret_access",
    );
    const input = {
      displayAlias: "deploy-key",
      purposeSummary: "Authenticate one approved deployment command.",
      leaseKind: "one_use",
      exposures: [
        {
          deliveryKind: "file",
          targetPath: ".secure/deploy-key",
          fileMode: 0o400,
        },
      ],
    };

    const result = await request.execute("request-3", input);

    expect(requestAccess).toHaveBeenCalledWith(
      "worker-1",
      "request-3",
      input,
    );
    expect(result.details).toEqual({
      ok: true,
      status: "requested",
    });
    expect(resultJson(result)).not.toContain("deploy-key");
  });

  it("converts host exceptions into fixed value-free failures", async () => {
    const status = toolByName(
      buildSwarmTools(
        host({
          getSecureSessionAgentView: () => {
            throw new Error(LEAK_MARKER);
          },
        }),
        manager(),
      ),
      "secure_session_status",
    );
    const request = toolByName(
      buildSwarmTools(
        host({
          requestSecureSecretAccess: async () => {
            throw new Error(LEAK_MARKER);
          },
        }),
        manager(),
      ),
      "request_secret_access",
    );
    const statusResult = await status.execute("status-2", {});
    const requestResult = await request.execute("request-4", {
      displayAlias: "github-work",
      purposeSummary: "Read repository issue metadata.",
      leaseKind: "task",
      exposures: [{ deliveryKind: "stdin" }],
    });

    expect(statusResult).toMatchObject({
      isError: true,
      details: { error: { code: "status_unavailable" } },
    });
    expect(requestResult).toMatchObject({
      isError: true,
      details: { error: { code: "request_failed" } },
    });
    expect(resultJson([statusResult, requestResult])).not.toContain(LEAK_MARKER);
  });
});
