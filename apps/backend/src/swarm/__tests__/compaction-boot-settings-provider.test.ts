import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectCompactionEntryKeys,
  findNewCompactionEntries,
} from "../compaction-session-entries.js";
import { CompactionSettingsService } from "../compaction-settings-service.js";
import {
  createLiveCompactionRuntimeSettingsProvider,
  LiveCompactionRuntimeSettingsProvider,
} from "../compaction-runtime-settings-provider.js";
import { DEFAULT_COMPACTION_TIMEOUT_MS } from "../compaction-settings-service.js";
import { getCompactionSettingsPath } from "../data-paths.js";
import { SwarmManager } from "../swarm-manager.js";
import { makeTempConfig } from "../../test-support/temp-config.js";
import { createCompactionGuardRuntime } from "../../test-support/compaction-guard-harness.js";

describe("compaction boot settings provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runtime created before attach observes later persisted timeout without recycle", async () => {
    const liveProvider = createLiveCompactionRuntimeSettingsProvider();
    const { runtime } = createCompactionGuardRuntime({ compactionRuntimeSettingsProvider: liveProvider });

    expect(
      (runtime as never as { getCompactionTimeoutMs: () => number }).getCompactionTimeoutMs(),
    ).toBe(DEFAULT_COMPACTION_TIMEOUT_MS);

    const service = new CompactionSettingsService({
      dataDir: "/tmp/compaction-boot-runtime-test",
      getProviderAvailability: async () => new Map(),
    });
    await service.load();
    await service.update({ timeoutMs: 420_000 });
    liveProvider.attachSettingsService(service);

    expect(
      (runtime as never as { getCompactionTimeoutMs: () => number }).getCompactionTimeoutMs(),
    ).toBe(420_000);
  });

  it("loads compaction settings before restoring boot runtimes", async () => {
    const config = await makeTempConfig();
    const manager = new SwarmManager(config);
    const order: string[] = [];

    const knowledgeMemoryCoordinator = (
      manager as never as {
        knowledgeMemoryCoordinator: { loadCompactionSettingsForRuntime: () => Promise<void> };
      }
    ).knowledgeMemoryCoordinator;
    const bootCoordinator = (
      manager as never as { bootCoordinator: { restoreRuntimes: () => Promise<void> } }
    ).bootCoordinator;

    vi.spyOn(knowledgeMemoryCoordinator, "loadCompactionSettingsForRuntime").mockImplementation(async () => {
      order.push("compaction_settings");
    });
    vi.spyOn(bootCoordinator, "restoreRuntimes").mockImplementation(async () => {
      order.push("restore_runtimes");
    });

    await manager.boot();

    expect(order).toEqual(["compaction_settings", "restore_runtimes"]);
  });

  it("uses one stable live provider instance that reflects persisted settings after boot", async () => {
    const config = await makeTempConfig();
    const settingsPath = getCompactionSettingsPath(config.paths.dataDir);
    await mkdir(join(settingsPath, ".."), { recursive: true });
    await writeFile(
      settingsPath,
      `${JSON.stringify(
        {
          version: 1,
          model: { provider: "openai-codex", modelId: "gpt-5.5" },
          reasoningLevel: "low",
          timeoutMs: 420_000,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const manager = new SwarmManager(config);
    const providerBeforeBoot = manager.getCompactionRuntimeSettingsProvider();
    expect(providerBeforeBoot).toBeInstanceOf(LiveCompactionRuntimeSettingsProvider);
    expect(providerBeforeBoot.getCompactionRuntimeSettings().timeoutMs).toBe(DEFAULT_COMPACTION_TIMEOUT_MS);

    await manager.boot();

    const providerAfterBoot = manager.getCompactionRuntimeSettingsProvider();
    expect(providerAfterBoot).toBe(providerBeforeBoot);
    expect(providerAfterBoot.getCompactionRuntimeSettings().timeoutMs).toBe(420_000);
    expect(manager.getCompactionSettingsService()?.getSettings().timeoutMs).toBe(420_000);
  });
});

describe("compaction session entry helpers", () => {
  it("treats all compaction rows as new only when the before snapshot is empty and entries exist", () => {
    const entries = [{ type: "compaction", id: "historical-compaction" }];
    expect(findNewCompactionEntries(entries, new Set())).toHaveLength(1);
    expect(findNewCompactionEntries(entries, collectCompactionEntryKeys(entries))).toHaveLength(0);
  });
});

describe("auto compaction entry snapshot semantics", () => {
  it("does not treat historical compaction entries as new success without compaction_start snapshot", async () => {
    const { runtime, session, runtimeErrors } = createCompactionGuardRuntime();
    session.entries.push({ type: "compaction", id: "historical-compaction" });

    await (runtime as never as {
      handleAutoCompactionEndEvent: (event: unknown) => Promise<void>;
    }).handleAutoCompactionEndEvent({
      type: "compaction_end",
      reason: "overflow",
      result: undefined,
      aborted: false,
      willRetry: false,
    });

    expect(runtimeErrors.some((entry) => entry.details?.recoveryStage === "auto_compaction_succeeded")).toBe(false);
    expect(runtimeErrors.some((entry) => entry.details?.missingCompactionStartSnapshot === true)).toBe(true);
  });
});
