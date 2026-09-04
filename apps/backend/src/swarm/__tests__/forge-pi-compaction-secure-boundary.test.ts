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

const temporaryRoots: string[] = [];

afterEach(async () => {
  runForgePiCompactionMock.mockReset();
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map(
    async (root) => await rm(root, { recursive: true, force: true }),
  ));
});

describe("Forge Pi compaction independence from Secure Session binding", () => {
  it("passes preparation, instructions, and provider result through unchanged even if an obsolete binding-shaped option would throw if touched", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-compaction-decouple-"));
    temporaryRoots.push(root);
    const canary = "compaction-canary-A9_x7";
    const customInstructions = `Preserve ${canary} through compaction.`;
    const preparation = {
      previousSummary: canary,
      messagesToSummarize: [],
      turnPrefixMessages: [],
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    };
    const providerResult = {
      summary: `summary containing ${canary}`,
      firstKeptEntryId: "entry-1",
      tokensBefore: 42,
    };
    runForgePiCompactionMock.mockResolvedValue(providerResult);

    const notify = vi.fn();
    const resolveCompactionAuth = vi.fn(async () => ({
      model: { provider: "openai", id: "test" },
      apiKey: "test-key",
      headers: { Authorization: "Bearer test-key" },
      authSource: "active_runtime_registry",
    }));
    const obsoleteBinding = new Proxy({}, {
      get() {
        throw new Error("obsolete compaction binding must not be touched");
      },
    });
    let handler:
      | ((event: any, context: any) => Promise<unknown>)
      | undefined;
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
      resolveCompactionAuth,
      secureRuntimeBinding: obsoleteBinding,
    } as Parameters<typeof createForgePiCompactionExtensionFactory>[0] & {
      secureRuntimeBinding: typeof obsoleteBinding;
    });
    factory({
      on: (_event: string, registered: typeof handler) => {
        handler = registered;
      },
    } as never);

    const event = {
      preparation,
      customInstructions,
    };
    const result = await handler?.(event, {
      model: { provider: "openai", id: "session-model" },
      ui: { notify },
    });

    expect(runForgePiCompactionMock).toHaveBeenCalledTimes(1);
    const compactionCall = runForgePiCompactionMock.mock.calls[0]?.[0] as {
      event: typeof event;
      combinedInstructions: string | undefined;
    };
    expect(compactionCall.event).toBe(event);
    expect(compactionCall.event.preparation).toBe(preparation);
    expect(compactionCall.combinedInstructions).toBe(customInstructions);
    expect(result).toEqual({ compaction: providerResult });
    expect((result as { compaction: unknown }).compaction).toBe(providerResult);
    expect(JSON.stringify(compactionCall.event.preparation)).toContain(canary);
    expect(compactionCall.combinedInstructions).toContain(canary);
    expect(JSON.stringify(result)).toContain(canary);
    expect(notify).not.toHaveBeenCalled();
    expect(resolveCompactionAuth).toHaveBeenCalledTimes(1);
  });
});
