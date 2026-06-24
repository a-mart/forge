import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { compact as runPiCompaction } from "@mariozechner/pi-coding-agent";
import {
  buildForgeCompactionStartInstrumentation,
  detectCompactionProviderOptionsPresence,
  ForgePiCompactionError,
  mapCompactionReasoningToPiThinkingLevel,
  resolveForgeCompactionModel,
  runForgePiCompaction,
} from "../compaction/forge-pi-compaction.js";
import { createDefaultCompactionSettings } from "../compaction-settings-service.js";
import { createStaticCompactionRuntimeSettingsProvider } from "../compaction-runtime-settings-provider.js";
import { makeCompactionGuardDescriptor } from "../../test-support/compaction-guard-harness.js";

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-coding-agent")>(
    "@mariozechner/pi-coding-agent",
  );
  return {
    ...actual,
    compact: vi.fn(async () => ({
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 100,
      details: { readFiles: [], modifiedFiles: [] },
    })),
  };
});

const runPiCompactionMock = vi.mocked(runPiCompaction);

describe("forge pi compaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses configured compaction model and reasoning instead of the active session model", async () => {
    const compactionModel = {
      provider: "openai-codex",
      id: "gpt-5.5",
      reasoning: true,
    };
    const sessionModel = {
      provider: "openai-codex",
      id: "gpt-5.4",
      reasoning: true,
    };
    const modelRegistry = {
      find: vi.fn((provider: string, modelId: string) => {
        if (provider === "openai-codex" && modelId === "gpt-5.5") {
          return compactionModel;
        }
        return undefined;
      }),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true as const,
        apiKey: "compaction-key",
        headers: { Authorization: "Bearer compaction-key", "x-session-id": "sess-1" },
      })),
    } as unknown as ModelRegistry;

    const compactionSettings = createStaticCompactionRuntimeSettingsProvider({
      timeoutMs: 300_000,
      model: { provider: "openai-codex", modelId: "gpt-5.5" },
      reasoningLevel: "low",
    }).getCompactionRuntimeSettings();

    const signal = new AbortController().signal;
    await runForgePiCompaction({
      event: {
        preparation: {
          firstKeptEntryId: "entry-1",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 100,
          fileOps: { read: new Set(), edited: new Set() },
          settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
        },
        customInstructions: "Focus on deployment details.",
        signal,
      },
      ctx: { model: sessionModel as never, modelRegistry },
      descriptor: makeCompactionGuardDescriptor(),
      compactionSettings,
      combinedInstructions: "Focus on deployment details.",
      pinnedInstructionsMerged: false,
      logDebug: vi.fn(),
    });

    expect(modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(compactionModel);
    expect(runPiCompactionMock).toHaveBeenCalledWith(
      expect.any(Object),
      compactionModel,
      "compaction-key",
      expect.objectContaining({ Authorization: "Bearer compaction-key" }),
      "Focus on deployment details.",
      signal,
      "low",
    );
    expect(runPiCompactionMock.mock.calls[0]?.[1]).not.toEqual(sessionModel);
  });

  it("merges pinned instructions into the compaction request", async () => {
    const compactionModel = { provider: "openai-codex", id: "gpt-5.5", reasoning: true };
    const modelRegistry = {
      find: vi.fn(() => compactionModel),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true as const,
        apiKey: "compaction-key",
        headers: {},
      })),
    } as unknown as ModelRegistry;

    const combinedInstructions =
      "Focus on deployment details.\n\nThe user has pinned the following messages to be preserved through compaction.";

    await runForgePiCompaction({
      event: {
        preparation: {
          firstKeptEntryId: "entry-1",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 100,
          fileOps: { read: new Set(), edited: new Set() },
          settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
        },
        signal: undefined,
      },
      ctx: { model: { provider: "openai-codex", id: "gpt-5.4" } as never, modelRegistry },
      descriptor: makeCompactionGuardDescriptor(),
      compactionSettings: createStaticCompactionRuntimeSettingsProvider({ timeoutMs: 300_000 }).getCompactionRuntimeSettings(),
      combinedInstructions,
      pinnedInstructionsMerged: true,
      logDebug: vi.fn(),
    });

    expect(runPiCompactionMock).toHaveBeenCalledWith(
      expect.any(Object),
      compactionModel,
      "compaction-key",
      {},
      combinedInstructions,
      undefined,
      "low",
    );
  });

  it("throws when configured compaction model auth is unavailable instead of falling back to session model", async () => {
    const modelRegistry = {
      find: vi.fn(() => ({ provider: "openai-codex", id: "gpt-5.5", reasoning: true })),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: false as const,
        error: "provider unavailable",
      })),
    } as unknown as ModelRegistry;

    await expect(
      runForgePiCompaction({
        event: {
          preparation: {
            firstKeptEntryId: "entry-1",
            messagesToSummarize: [],
            turnPrefixMessages: [],
            isSplitTurn: false,
            tokensBefore: 100,
            fileOps: { read: new Set(), edited: new Set() },
            settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
          },
        },
        ctx: {
          model: { provider: "openai-codex", id: "gpt-5.4" } as never,
          modelRegistry,
        },
        descriptor: makeCompactionGuardDescriptor(),
        compactionSettings: createStaticCompactionRuntimeSettingsProvider({ timeoutMs: 300_000 }).getCompactionRuntimeSettings(),
        combinedInstructions: undefined,
        pinnedInstructionsMerged: false,
        logDebug: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(ForgePiCompactionError);

    expect(runPiCompactionMock).not.toHaveBeenCalled();
  });

  it("rejects cross-provider compaction when the active runtime registry cannot authenticate that provider", async () => {
    const anthropicModel = { provider: "anthropic", id: "claude-opus-4-5", reasoning: true };
    const activeModel = { provider: "openai-codex", id: "gpt-5.5", reasoning: true };
    const modelRegistry = {
      find: vi.fn((provider: string, modelId: string) => {
        if (provider === "anthropic" && modelId === "claude-opus-4-5") {
          return anthropicModel;
        }
        if (provider === "openai-codex" && modelId === "gpt-5.5") {
          return activeModel;
        }
        return undefined;
      }),
      getApiKeyAndHeaders: vi.fn(async (model: { provider: string }) => {
        if (model.provider === "anthropic") {
          return { ok: false as const, error: "provider missing from active runtime registry" };
        }
        return { ok: true as const, apiKey: "active-broker-lease", headers: { Authorization: "Bearer active" } };
      }),
    } as unknown as ModelRegistry;

    await expect(
      runForgePiCompaction({
        event: {
          preparation: {
            firstKeptEntryId: "entry-1",
            messagesToSummarize: [],
            turnPrefixMessages: [],
            isSplitTurn: false,
            tokensBefore: 100,
            fileOps: { read: new Set(), edited: new Set() },
            settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
          },
        },
        ctx: { model: activeModel as never, modelRegistry },
        descriptor: makeCompactionGuardDescriptor(),
        compactionSettings: createStaticCompactionRuntimeSettingsProvider({
          timeoutMs: 300_000,
          model: { provider: "anthropic", modelId: "claude-opus-4-5" },
          reasoningLevel: "low",
        }).getCompactionRuntimeSettings(),
        combinedInstructions: "Keep pinned instructions.",
        pinnedInstructionsMerged: true,
        logDebug: vi.fn(),
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        recoveryStage: "forge_compaction_auth_unavailable",
        authPolicy: "active_runtime_registry_only",
        fallbackPolicy: "reject_without_default_compaction_fallback",
        configuredProvider: "anthropic",
        runtimeSessionProvider: "openai-codex",
      }),
    });

    expect(modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(anthropicModel);
    expect(runPiCompactionMock).not.toHaveBeenCalled();
  });

  it("throws when configured compaction model cannot be resolved", async () => {
    const modelRegistry = {
      find: vi.fn(() => undefined),
      getAll: vi.fn(() => []),
      getApiKeyAndHeaders: vi.fn(),
    } as unknown as ModelRegistry;

    await expect(
      runForgePiCompaction({
        event: {
          preparation: {
            firstKeptEntryId: "entry-1",
            messagesToSummarize: [],
            turnPrefixMessages: [],
            isSplitTurn: false,
            tokensBefore: 100,
            fileOps: { read: new Set(), edited: new Set() },
            settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
          },
        },
        ctx: {
          model: { provider: "openai-codex", id: "gpt-5.4" } as never,
          modelRegistry,
        },
        descriptor: makeCompactionGuardDescriptor(),
        compactionSettings: createStaticCompactionRuntimeSettingsProvider({
          timeoutMs: 300_000,
          model: { provider: "nonexistent-provider", modelId: "nonexistent-model" },
          reasoningLevel: "low",
        }).getCompactionRuntimeSettings(),
        combinedInstructions: undefined,
        pinnedInstructionsMerged: false,
        logDebug: vi.fn(),
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ recoveryStage: "forge_compaction_model_unavailable" }),
    });
  });

  it("records redacted provider option presence flags for instrumentation", () => {
    expect(
      detectCompactionProviderOptionsPresence({
        Authorization: "Bearer secret",
        "x-session-id": "sess-1",
        "x-cache-key": "cache-1",
      }),
    ).toEqual({
      hasSessionId: true,
      hasCacheKey: true,
      hasServiceTier: false,
      hasTransportMetadata: false,
      headerKeyCount: 3,
    });

    const instrumentation = buildForgeCompactionStartInstrumentation({
      compactionSettings: createStaticCompactionRuntimeSettingsProvider({ timeoutMs: 300_000 }).getCompactionRuntimeSettings(),
      sessionModel: { provider: "openai-codex", id: "gpt-5.4" } as never,
      customInstructions: "Focus",
      pinnedInstructionsMerged: true,
      providerOptions: detectCompactionProviderOptionsPresence({ "x-session-id": "sess-1" }),
    });

    expect(instrumentation).toMatchObject({
      sourcePath: "forge_session_before_compact",
      configuredProvider: "openai-codex",
      configuredModelId: "gpt-5.5",
      configuredReasoningLevel: "low",
      runtimeSessionProvider: "openai-codex",
      runtimeSessionModelId: "gpt-5.4",
      customInstructionsPresent: true,
      pinnedInstructionsMerged: true,
      providerOptions: expect.objectContaining({ hasSessionId: true }),
    });
    expect(JSON.stringify(instrumentation)).not.toContain("secret");
    expect(instrumentation.deferredProviderParity.length).toBeGreaterThan(0);
  });

  it("defaults configured model/reasoning to openai-codex gpt-5.5 low", () => {
    const defaults = createDefaultCompactionSettings();
    expect(defaults.model).toEqual({ provider: "openai-codex", modelId: "gpt-5.5" });
    expect(defaults.reasoningLevel).toBe("low");
    expect(mapCompactionReasoningToPiThinkingLevel(defaults.model.provider, defaults.reasoningLevel)).toBe("low");
    expect(
      resolveForgeCompactionModel(
        {
          find: vi.fn((provider: string, modelId: string) =>
            provider === "openai-codex" && modelId === "gpt-5.5"
              ? { provider, id: modelId, reasoning: true }
              : undefined,
          ),
        } as unknown as ModelRegistry,
        defaults.model,
      )?.id,
    ).toBe("gpt-5.5");
  });
});
