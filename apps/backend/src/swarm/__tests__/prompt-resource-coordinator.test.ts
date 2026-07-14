import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptRegistry } from "../prompt-registry.js";
import { PromptResourceCoordinator } from "../prompt-resource-coordinator.js";
import type { SkillMetadataService } from "../skill-metadata-service.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";
import type { RuntimeErrorEvent } from "../runtime-contracts.js";

function descriptor(role: "manager" | "worker" = "worker"): AgentDescriptor {
  return {
    agentId: `${role}-1`,
    role,
    ...(role === "worker" ? { managerId: "manager-1" } : {}),
    status: "idle",
    label: role,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    model: { provider: "OpenAI", modelId: "GPT-5" },
  } as AgentDescriptor;
}

function setup() {
  const resolveEntry = vi.fn();
  const applySpecialistAvailability = vi.fn(async (roster) => roster);
  const coordinator = new PromptResourceCoordinator({
    config: {
      paths: { dataDir: "/tmp/forge-test", rootDir: "/tmp/forge-test" },
    } as SwarmConfig,
    promptRegistry: { resolveEntry } as unknown as PromptRegistry,
    skillMetadataService: {} as SkillMetadataService,
    getDescriptor: () => undefined,
    applySpecialistAvailability,
    now: () => "2026-07-13T00:00:00.000Z",
    logDebug: vi.fn(),
  });
  return { coordinator, resolveEntry, applySpecialistAvailability };
}

describe("PromptResourceCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("owns normalized temporary capacity blocks for worker dispatch failures", () => {
    const { coordinator } = setup();

    coordinator.maybeRecordModelCapacityBlock("worker-1", descriptor(), {
      phase: "prompt_start",
      message: "429 rate limit exceeded; retry after 30 seconds",
    } as RuntimeErrorEvent);

    const block = coordinator.modelCapacityBlocks.get("openai/gpt-5");
    expect(block).toMatchObject({
      provider: "openai",
      modelId: "gpt-5",
      sourcePhase: "prompt_start",
    });
    expect(block?.blockedUntilMs).toBeGreaterThan(Date.now());
  });

  it("validates explicit archetypes and preserves merger inference", async () => {
    const { coordinator, resolveEntry } = setup();
    resolveEntry.mockResolvedValueOnce({ id: "reviewer" });

    await expect(coordinator.resolveSpawnWorkerArchetypeId(
      { archetypeId: " Reviewer " },
      "worker-1",
      "profile-1",
    )).resolves.toBe("reviewer");
    await expect(coordinator.resolveSpawnWorkerArchetypeId({}, "merger-2", "profile-1"))
      .resolves.toBe("merger");
  });

  it("applies contextual specialist availability after resolving a builder roster", async () => {
    const { coordinator, applySpecialistAvailability } = setup();
    const roster = [{ specialistId: "architect" }];
    vi.spyOn(coordinator, "resolveProjectWorkspaceForManager").mockResolvedValue(undefined);
    vi.spyOn(coordinator, "resolveSpecialistRosterForProfile").mockResolvedValue(
      roster as Awaited<ReturnType<PromptResourceCoordinator["resolveSpecialistRosterForProfile"]>>,
    );
    const manager = descriptor("manager");

    await coordinator.resolveSpecialistRosterForManager(manager, "builder");

    expect(applySpecialistAvailability).toHaveBeenCalledWith(roster, "builder", manager.agentId);
  });
});
