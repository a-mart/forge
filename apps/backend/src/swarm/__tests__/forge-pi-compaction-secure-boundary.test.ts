import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runForgePiCompactionMock = vi.hoisted(() => vi.fn());

vi.mock("../compaction/forge-pi-compaction.js", () => ({
  ForgePiCompactionError: class ForgePiCompactionError extends Error {
    readonly details: Record<string, unknown>;

    constructor(message: string, details: Record<string, unknown>) {
      super(message);
      this.details = details;
    }
  },
  runForgePiCompaction: runForgePiCompactionMock,
}));

import { createForgePiCompactionExtensionFactory } from "../compaction/forge-pi-compaction-extension.js";
import { SECURE_OUTPUT_QUARANTINE } from "../secure-sessions/redaction/secure-value-guard.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  runForgePiCompactionMock.mockReset();
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map(
    async (root) => await rm(root, { recursive: true, force: true }),
  ));
});

describe("Forge Pi secure compaction boundary", () => {
  it("cancels before the provider compaction call when preparation contains protected material", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-secure-compaction-"));
    temporaryRoots.push(root);
    const canary = "compaction-canary-A9_x7";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let handler:
      | ((event: any, context: any) => Promise<unknown>)
      | undefined;
    const notify = vi.fn();
    const factory = createForgePiCompactionExtensionFactory({
      descriptor: {
        agentId: "manager",
        managerId: "manager",
        role: "manager",
        profileId: "profile",
        cwd: root,
      } as never,
      config: {
        paths: { dataDir: join(root, "data") },
      } as never,
      logDebug: vi.fn(),
      getCompactionRuntimeSettingsProvider: () => ({
        getCompactionRuntimeSettings: () => ({
          model: { provider: "openai", modelId: "test" },
          reasoningLevel: "none",
          timeoutMs: 1_000,
        }),
      } as never),
      secureRuntimeBinding: {
        executeBash: vi.fn(),
        createOutputGuard: vi.fn(() => ({
          write: (data: Uint8Array) => Buffer.from(data),
          close: async () => Buffer.alloc(0),
          dispose: vi.fn(),
        })),
        guardValue: <T>(value: T): T => {
          if (JSON.stringify(value).includes(canary)) {
            return SECURE_OUTPUT_QUARANTINE as T;
          }
          return value;
        },
      },
    });
    factory({
      on: (_event: string, registered: typeof handler) => {
        handler = registered;
      },
    } as never);

    const result = await handler?.(
      {
        preparation: {
          previousSummary: canary,
          messagesToSummarize: [],
          turnPrefixMessages: [],
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        },
      },
      {
        model: undefined,
        ui: { notify },
      },
    );

    expect(result).toEqual({ cancel: true });
    expect(runForgePiCompactionMock).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("compaction failed"),
      "error",
    );
    expect(JSON.stringify(notify.mock.calls)).not.toContain(canary);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
  });
});
