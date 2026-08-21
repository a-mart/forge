import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { AgentDescriptor } from "../types.js";
import { RuntimeFactory } from "../runtime/runtime-factory.js";
import {
  SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE,
  SECURE_RUNTIME_GUARD_FAILURE_MESSAGE,
  SECURE_RUNTIME_PROVIDER_UNSUPPORTED_MESSAGE,
  type SecureRuntimeBinding,
} from "../secure-sessions/runtime/secure-runtime-binding.js";
import { CLAUDE_SDK_RETIRED_PROVIDER_MESSAGE } from "../catalog/legacy-claude-sdk-model.js";
import {
  applySecurePiResourcePolicy,
  createSecurePiCodingTools,
  guardSecureRuntimeTools,
} from "../secure-sessions/runtime/pi-secure-tools.js";
import { SecureExecutionError } from "../secure-sessions/execution/secure-execution-error.js";
import { installPiProviderContextImageResize } from "../runtime/pi/pi-runtime-creator.js";

const SECRET = "secure-canary-value";

function createDescriptor(provider: string): AgentDescriptor {
  return {
    agentId: "worker-1",
    displayName: "Worker 1",
    role: "worker",
    managerId: "manager-1",
    profileId: "profile-1",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/forge-secure-runtime-test",
    model: {
      provider,
      modelId: "test-model",
      thinkingLevel: "medium",
    },
    sessionFile: "/tmp/forge-secure-runtime-test/session.jsonl",
  };
}

function guardUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replaceAll(SECRET, "[guarded]");
  }
  if (Array.isArray(value)) {
    return value.map(guardUnknown);
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value.toString("utf8").replaceAll(SECRET, "[guarded]"));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, guardUnknown(entry)]),
    );
  }
  return value;
}

function createBinding(
  overrides: Partial<SecureRuntimeBinding> = {},
): SecureRuntimeBinding {
  return {
    executeBash: vi.fn(async () => ({ exitCode: 0 })),
    createOutputGuard: vi.fn(() => ({
      write: (data: Uint8Array) => Buffer.from(data),
      close: async () => Buffer.alloc(0),
      dispose: vi.fn(),
    })),
    guardValue: <T>(value: T) => guardUnknown(value) as T,
    ...overrides,
  };
}

describe("Secure runtime provider boundary", () => {
  it("rejects retired Claude SDK descriptors before runtime construction", async () => {
    const factory = new RuntimeFactory({
      getSecureRuntimeBinding: () => createBinding(),
    } as never);

    await expect(
      factory.createRuntimeForDescriptor(createDescriptor("claude-sdk"), "system"),
    ).rejects.toThrow(CLAUDE_SDK_RETIRED_PROVIDER_MESSAGE);
  });

  it("rejects cursor-sdk before provider runtime construction", async () => {
    const factory = new RuntimeFactory({
      getSecureRuntimeBinding: () => createBinding(),
    } as never);

    await expect(
      factory.createRuntimeForDescriptor(createDescriptor("cursor-sdk"), "system"),
    ).rejects.toThrow(SECURE_RUNTIME_PROVIDER_UNSUPPORTED_MESSAGE);
  });

  it("replaces binding-resolution failures with a fixed non-secret error", async () => {
    const factory = new RuntimeFactory({
      getSecureRuntimeBinding: () => {
        throw new Error(SECRET);
      },
    } as never);

    await expect(
      factory.createRuntimeForDescriptor(createDescriptor("cursor-sdk"), "system"),
    ).rejects.toThrow(SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE);
  });
});

describe("Secure Pi runtime interception", () => {
  it("keeps host Bash available and adds an explicit secure Linux Bash", async () => {
    const executeHostBash = vi.fn(async (_command, _cwd, execution) => {
      execution.onData(Buffer.from("host output\n"));
      return { exitCode: 0 };
    });
    const executeBash = vi.fn(async (request) => {
      request.onData(Buffer.from("secure output\n"));
      return { exitCode: 0 };
    });
    const binding = createBinding({ executeBash });
    const tools = createSecurePiCodingTools({
      cwd: "/tmp/forge-secure-runtime-test",
      binding,
      hostBashOperations: { exec: executeHostBash },
      hostCommandPrefix: "source ~/.forge-shell",
      platform: "win32",
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "bash",
      "secure_bash",
      "read",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ]);

    const hostBash = tools.find((tool) => tool.name === "bash")!;
    const secureBash = tools.find((tool) => tool.name === "secure_bash")!;
    expect(hostBash.label).toBe("Host Bash · Windows");
    expect(hostBash.description).toContain("Git Bash");
    expect(hostBash.description).toContain("GitHub CLI");
    expect(secureBash.label).toBe("Secure Bash · Linux container");
    expect(secureBash.description).toContain("approved Secure Sessions value");
    expect(secureBash.description).toContain("SSH_AUTH_SOCK automatically");

    const hostUpdates: unknown[] = [];
    const hostResult = await hostBash.execute(
      "host-call",
      { command: "gh pr create", timeout: 2 },
      undefined,
      (update) => hostUpdates.push(update),
      {} as never,
    );
    expect(executeHostBash).toHaveBeenCalledWith(
      "source ~/.forge-shell\ngh pr create",
      "/tmp/forge-secure-runtime-test",
      expect.objectContaining({
        timeout: 2,
        onData: expect.any(Function),
      }),
    );
    expect(executeBash).not.toHaveBeenCalled();
    expect(JSON.stringify({ result: hostResult, updates: hostUpdates })).toContain(
      "host output",
    );

    const secureUpdates: unknown[] = [];
    const secureResult = await secureBash.execute(
      "secure-call",
      { command: "ssh target true", timeout: 2 },
      undefined,
      (update) => secureUpdates.push(update),
      {} as never,
    );
    expect(executeBash).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "ssh target true",
        cwd: "/tmp/forge-secure-runtime-test",
        timeoutMs: 2_000,
        onData: expect.any(Function),
      }),
    );
    expect(JSON.stringify({ result: secureResult, updates: secureUpdates })).toContain(
      "secure output",
    );
  });

  it("guards host Bash output across chunk boundaries before Pi accumulates it", async () => {
    const pending: Buffer[] = [];
    const binding = createBinding({
      createOutputGuard: vi.fn(() => ({
        write(data: Uint8Array) {
          pending.push(Buffer.from(data));
          return Buffer.alloc(0);
        },
        async close() {
          return Buffer.from(
            Buffer.concat(pending).toString("utf8").replaceAll(SECRET, "[guarded]"),
          );
        },
        dispose: vi.fn(),
      })),
    });
    const tools = createSecurePiCodingTools({
      cwd: "/tmp/forge-secure-runtime-test",
      binding,
      hostBashOperations: {
        exec: vi.fn(async (_command, _cwd, execution) => {
          execution.onData(Buffer.from("before:secure-can"));
          execution.onData(Buffer.from("ary-value:after"));
          return { exitCode: 0 };
        }),
      },
    });
    const updates: unknown[] = [];

    const result = await tools.find((tool) => tool.name === "bash")!.execute(
      "host-guard-call",
      { command: "ordinary-command" },
      undefined,
      (update) => updates.push(update),
      {} as never,
    );

    const serialized = JSON.stringify({ result, updates });
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("before:[guarded]:after");
  });

  it("aborts host Bash and fails closed when its stream guard fails", async () => {
    const dispose = vi.fn();
    const binding = createBinding({
      createOutputGuard: vi.fn(() => ({
        write() {
          throw new Error("unsafe guard detail");
        },
        close: async () => Buffer.alloc(0),
        dispose,
      })),
    });
    const observedAbort = vi.fn();
    const tools = createSecurePiCodingTools({
      cwd: "/tmp/forge-secure-runtime-test",
      binding,
      hostBashOperations: {
        exec: vi.fn(async (_command, _cwd, execution) => {
          execution.onData(Buffer.from("unsafe output"));
          observedAbort(execution.signal?.aborted);
          return { exitCode: null };
        }),
      },
    });

    await expect(tools.find((tool) => tool.name === "bash")!.execute(
      "host-guard-failure",
      { command: "ordinary-command" },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow(SECURE_RUNTIME_GUARD_FAILURE_MESSAGE);
    expect(observedAbort).toHaveBeenCalledWith(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("guards tool updates, final results, and thrown errors", async () => {
    const binding = createBinding();
    const guardedTool = guardSecureRuntimeTools(
      [
        {
          name: "test",
          label: "test",
          description: "test",
          parameters: {} as never,
          async execute(_id, _params, _signal, onUpdate) {
            onUpdate?.({
              content: [{ type: "text", text: `update:${SECRET}` }],
              details: undefined,
            });
            return {
              content: [{ type: "text", text: `result:${SECRET}` }],
              details: undefined,
            };
          },
        },
      ],
      binding,
    )[0]!;
    const updates: unknown[] = [];

    const result = await guardedTool.execute(
      "call-1",
      {},
      undefined,
      (update) => updates.push(update),
      {} as never,
    );

    expect(JSON.stringify({ result, updates })).not.toContain(SECRET);
    expect(JSON.stringify({ result, updates })).toContain("[guarded]");

    const failingTool = guardSecureRuntimeTools(
      [
        {
          ...guardedTool,
          async execute() {
            throw new Error(`failure:${SECRET}`);
          },
        },
      ],
      binding,
    )[0]!;

    await expect(
      failingTool.execute("call-2", {}, undefined, undefined, {} as never),
    ).rejects.toThrow("failure:[guarded]");
  });

  it("preserves fixed execution causes after fail-closed binding invalidation", async () => {
    const binding = createBinding({
      executeBash: vi.fn(async () => {
        throw new SecureExecutionError("EXECUTION_TIMEOUT");
      }),
      guardValue: () => {
        throw new Error("binding revoked");
      },
    });
    const bash = createSecurePiCodingTools({
      cwd: "/tmp/forge-secure-runtime-test",
      binding,
    }).find((tool) => tool.name === "secure_bash")!;

    await expect(
      bash.execute(
        "call-timeout",
        { command: "sleep 60", timeout: 1 },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_TIMEOUT",
      message:
        "Secure execution timed out. Only this command was stopped; the Secure Session remains available.",
      name: "SecureExecutionError",
    });
  });

  it("does not preserve arbitrary errors after binding invalidation", async () => {
    const binding = createBinding({
      guardValue: () => {
        throw new Error("binding revoked");
      },
    });
    const failingTool = guardSecureRuntimeTools(
      [{
        name: "test",
        label: "test",
        description: "test",
        parameters: {} as never,
        async execute() {
          throw new Error(`unsafe:${SECRET}`);
        },
      }],
      binding,
    )[0]!;

    await expect(
      failingTool.execute("call-unsafe", {}, undefined, undefined, {} as never),
    ).rejects.toThrow(SECURE_RUNTIME_GUARD_FAILURE_MESSAGE);
  });

  it("suppresses file-backed extensions while retaining Forge inline factories", () => {
    const policy = applySecurePiResourcePolicy({
      additionalExtensionPaths: ["/tmp/profile-extension"],
      extensionsOverride: (result) => result,
      extensionFactories: [],
    });
    const runtime = {};
    const filtered = policy.extensionsOverride!({
      extensions: [
        { path: "<inline:forge>", resolvedPath: "<inline:forge>" },
        { path: "/tmp/profile-extension/index.ts", resolvedPath: "/tmp/profile-extension/index.ts" },
        { path: "/tmp/project/.pi/extensions/example.ts", resolvedPath: "/tmp/project/.pi/extensions/example.ts" },
      ],
      errors: [
        { path: "<inline:forge>", error: "inline error" },
        { path: "/tmp/profile-extension/index.ts", error: "user error" },
      ],
      runtime,
    } as never);

    expect(policy.noExtensions).toBe(true);
    expect(policy.additionalExtensionPaths).toEqual([]);
    expect(filtered.extensions.map((extension) => extension.path)).toEqual([
      "<inline:forge>",
    ]);
    expect(filtered.errors.map((error) => error.path)).toEqual([
      "<inline:forge>",
    ]);
  });

  it("runs the final provider-context guard after the existing transform", async () => {
    const guardValue = vi.fn(<T>(value: T) => guardUnknown(value) as T);
    const binding = createBinding({ guardValue });
    const session = {
      agent: {
        transformContext: vi.fn(async () => [
          {
            role: "assistant",
            content: [{ type: "text", text: `transformed:${SECRET}` }],
          },
        ]),
      },
    };

    installPiProviderContextImageResize(session as never, binding);
    const result = await session.agent.transformContext([], undefined);

    expect(guardValue).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).toContain("[guarded]");
  });

  it("fails closed when the final provider-context guard fails or changes shape", async () => {
    for (const guardValue of [
      () => {
        throw new Error(SECRET);
      },
      () => "[guarded]",
    ]) {
      const session = {
        agent: {
          transformContext: vi.fn(async (messages: unknown) => messages),
        },
      };
      installPiProviderContextImageResize(
        session as never,
        createBinding({ guardValue: guardValue as never }),
      );

      await expect(
        session.agent.transformContext([], undefined),
      ).rejects.toThrow(SECURE_RUNTIME_GUARD_FAILURE_MESSAGE);
    }
  });
});
