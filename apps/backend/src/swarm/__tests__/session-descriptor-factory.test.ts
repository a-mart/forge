import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSessionDir, getSessionFilePath } from "../data-paths.js";
import {
  SessionDescriptorFactory,
  type SessionCreationBaseDescriptor,
} from "../session-descriptor-factory.js";
import type { AgentDescriptor, ManagerProfile } from "../types.js";

const NOW = "2026-07-13T20:00:00.000Z";
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SessionDescriptorFactory", () => {
  it("constructs the default Builder session descriptor from profile policy", async () => {
    const harness = await createHarness();
    harness.profile.defaultModel = {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "xhigh",
      serviceTier: "priority",
    } as ManagerProfile["defaultModel"] & { serviceTier: string };
    harness.rootDescriptor.archetypeId = "planner";
    harness.rootDescriptor.sessionSystemPrompt = "Inherited prompt";

    const prepared = harness.factory.prepareSessionCreation("forge");

    expect(prepared.profile).toBe(harness.profile);
    expect(prepared.sessionNumber).toBe(2);
    expect(prepared.sessionDescriptor).toEqual({
      agentId: "forge--s2",
      displayName: "forge--s2",
      role: "manager",
      managerId: "forge--s2",
      profileId: "forge",
      sessionLabel: "Session 2",
      sessionPurpose: undefined,
      cli: undefined,
      status: "idle",
      createdAt: NOW,
      updatedAt: NOW,
      cwd: "/workspace/forge",
      model: {
        provider: "openai-codex",
        modelId: "gpt-5.5",
        thinkingLevel: "xhigh",
      },
      modelOrigin: "profile_default",
      managerPosture: "delegation_first",
      managerPostureOrigin: "product_default",
      sessionFile: getSessionFilePath(harness.dataDir, "forge", "forge--s2"),
      archetypeId: "planner",
      sessionSystemPrompt: "Inherited prompt",
    });
  });

  it("allocates after the highest Builder number and skips reserved directories", async () => {
    const harness = await createHarness();
    harness.descriptors.set("forge--s4", makeManagerDescriptor("forge--s4", "forge"));
    harness.descriptors.set(
      "forge--s99",
      makeManagerDescriptor("forge--s99", "forge", { sessionSurface: "collab" }),
    );
    harness.descriptors.set("worker--s100", makeWorkerDescriptor("worker--s100", "forge"));
    await mkdir(getSessionDir(harness.dataDir, "forge", "forge--s5"), { recursive: true });

    const prepared = harness.factory.prepareSessionCreation("forge");

    expect(prepared.sessionNumber).toBe(6);
    expect(prepared.sessionDescriptor.agentId).toBe("forge--s6");
    expect(prepared.sessionDescriptor.sessionLabel).toBe("Session 6");
  });

  it("starts at session two even when a profile root descriptor is absent", async () => {
    const harness = await createHarness();
    harness.descriptors.delete("forge");

    const prepared = harness.factory.prepareSessionCreationFromBase(
      "forge",
      makeBaseDescriptor(),
    );

    expect(prepared.sessionNumber).toBe(2);
    expect(prepared.sessionDescriptor.agentId).toBe("forge--s2");
  });

  it("slugifies names and suffixes both descriptor and directory collisions", async () => {
    const harness = await createHarness();
    harness.descriptors.set("my-cool-session", makeManagerDescriptor("my-cool-session", "other"));
    await mkdir(getSessionDir(harness.dataDir, "forge", "my-cool-session-2"), {
      recursive: true,
    });

    const prepared = harness.factory.prepareSessionCreation("forge", {
      name: "  My Cool Session!!!  ",
    });

    expect(prepared.sessionDescriptor.agentId).toBe("my-cool-session-3");
    expect(prepared.sessionDescriptor.sessionLabel).toBe("My Cool Session!!!");
    expect(prepared.sessionDescriptor.displayName).toBe("My Cool Session!!!");
  });

  it("preserves explicit-id, name, and label precedence", async () => {
    const harness = await createHarness();

    const explicitOnly = harness.factory.prepareSessionCreation("forge", {
      sessionAgentId: "  exact-id  ",
    });
    const namedExplicit = harness.factory.prepareSessionCreation("forge", {
      name: "  Friendly Name  ",
      sessionAgentId: "  second-exact-id  ",
    });
    const allInputs = harness.factory.prepareSessionCreation("forge", {
      label: "Ignored Label",
      name: "  Name Wins  ",
      sessionAgentId: "  third-exact-id  ",
    });

    expect(explicitOnly.sessionDescriptor).toMatchObject({
      agentId: "exact-id",
      sessionLabel: "Session 2",
      displayName: "exact-id",
    });
    expect(namedExplicit.sessionDescriptor).toMatchObject({
      agentId: "second-exact-id",
      sessionLabel: "Friendly Name",
      displayName: "Friendly Name",
    });
    expect(allInputs.sessionDescriptor).toMatchObject({
      agentId: "third-exact-id",
      sessionLabel: "Name Wins",
      displayName: "Name Wins",
    });
  });

  it("rejects explicit ids reserved globally or by the profile session directory", async () => {
    const harness = await createHarness();
    harness.descriptors.set("taken", makeManagerDescriptor("taken", "other"));
    await mkdir(getSessionDir(harness.dataDir, "forge", "on-disk"), { recursive: true });

    expect(() =>
      harness.factory.prepareSessionCreation("forge", { sessionAgentId: "taken" }),
    ).toThrow("Session agent id already exists: taken");
    expect(() =>
      harness.factory.prepareSessionCreation("forge", { sessionAgentId: "on-disk" }),
    ).toThrow("Session agent id already exists: on-disk");
  });

  it("rejects non-empty names that cannot produce a slug but treats whitespace as absent", async () => {
    const harness = await createHarness();

    expect(() => harness.factory.prepareSessionCreation("forge", { name: "!!!" })).toThrow(
      "Session name must include at least one letter, number, or dash",
    );

    const fallback = harness.factory.prepareSessionCreation("forge", { name: "   " });
    expect(fallback.sessionDescriptor.agentId).toBe("forge--s2");
  });

  it("sanitizes CLI metadata while constructing the descriptor", async () => {
    const harness = await createHarness();

    const prepared = harness.factory.prepareSessionCreation("forge", {
      cli: {
        createdBy: "forge-cli",
        runId: "  run-42  ",
        command: "launch",
        startedAt: "  2026-07-13T19:00:00.000Z  ",
        invocationCwd: "   ",
        label: "  Nightly  ",
        secret: "drop",
      } as AgentDescriptor["cli"] & { secret: string },
    });

    expect(prepared.sessionDescriptor.cli).toEqual({
      createdBy: "forge-cli",
      runId: "run-42",
      command: "launch",
      startedAt: "2026-07-13T19:00:00.000Z",
      label: "Nightly",
    });
  });

  it("applies base descriptor policy without mutating the supplied model", async () => {
    const harness = await createHarness();
    const base = makeBaseDescriptor({
      modelOrigin: "session_override",
      archetypeId: "researcher",
      sessionSystemPrompt: "Base prompt",
    });

    const prepared = harness.factory.prepareSessionCreationFromBase("forge", base, {
      label: "Research",
      sessionPurpose: "capture_check",
    });

    expect(prepared.sessionDescriptor).toMatchObject({
      displayName: "Research",
      sessionLabel: "Research",
      sessionPurpose: "capture_check",
      cwd: "/workspace/base",
      model: base.model,
      modelOrigin: "session_override",
      archetypeId: "researcher",
      sessionSystemPrompt: "Base prompt",
    });
    expect(prepared.sessionDescriptor.model).not.toBe(base.model);
  });

  it("forces agent-creator identity policy and suppresses an inherited prompt", async () => {
    const harness = await createHarness();
    const base = makeBaseDescriptor({
      archetypeId: "planner",
      sessionSystemPrompt: "Must not be inherited",
    });

    const automatic = harness.factory.prepareSessionCreationFromBase("forge", base, {
      sessionPurpose: "agent_creator",
    });
    const labeled = harness.factory.prepareSessionCreationFromBase("forge", base, {
      label: "Custom Creator",
      sessionPurpose: "agent_creator",
    });

    expect(automatic.sessionDescriptor).toMatchObject({
      archetypeId: "agent-architect",
      sessionLabel: "Agent Creator",
      displayName: "Agent Creator",
    });
    expect(automatic.sessionDescriptor).not.toHaveProperty("sessionSystemPrompt");
    expect(labeled.sessionDescriptor).toMatchObject({
      archetypeId: "agent-architect",
      sessionLabel: "Custom Creator",
      displayName: "Custom Creator",
    });
  });

  it("rejects agent-creator sessions in Cortex", async () => {
    const harness = await createHarness("cortex");

    expect(() =>
      harness.factory.prepareSessionCreation("cortex", {
        sessionPurpose: "agent_creator",
      }),
    ).toThrow("Agent creator sessions cannot be created in the Cortex profile");
  });

  it("reports missing profiles and invalid default-session templates exactly", async () => {
    const harness = await createHarness();

    expect(() => harness.factory.prepareSessionCreation("missing")).toThrow(
      "Unknown profile: missing",
    );

    harness.descriptors.delete("forge");
    expect(() => harness.factory.prepareSessionCreation("forge")).toThrow(
      "Profile default session is missing: forge",
    );

    harness.descriptors.set("forge", makeWorkerDescriptor("forge", "forge"));
    expect(() => harness.factory.prepareSessionCreation("forge")).toThrow(
      "Profile default session is missing: forge",
    );

    harness.descriptors.set(
      "forge",
      makeManagerDescriptor("forge", "forge", { sessionSurface: "collab" }),
    );
    expect(() => harness.factory.prepareSessionCreation("forge")).toThrow(
      "Profile default session must remain Builder-only: forge",
    );
  });
});

interface Harness {
  dataDir: string;
  profile: ManagerProfile;
  rootDescriptor: AgentDescriptor;
  descriptors: Map<string, AgentDescriptor>;
  factory: SessionDescriptorFactory;
}

async function createHarness(profileId = "forge"): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), "session-descriptor-factory-"));
  tempRoots.push(dataDir);
  const profile = makeProfile(profileId);
  const rootDescriptor = makeManagerDescriptor(profileId, profileId);
  const profiles = new Map([[profileId, profile]]);
  const descriptors = new Map([[rootDescriptor.agentId, rootDescriptor]]);

  return {
    dataDir,
    profile,
    rootDescriptor,
    descriptors,
    factory: new SessionDescriptorFactory(dataDir, profiles, descriptors, () => NOW),
  };
}

function makeProfile(profileId: string): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: profileId,
    defaultModel: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeManagerDescriptor(
  agentId: string,
  profileId: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: "manager",
    managerId: agentId,
    profileId,
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    cwd: `/workspace/${profileId}`,
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
    },
    sessionFile: `/sessions/${agentId}.jsonl`,
    ...overrides,
  };
}

function makeWorkerDescriptor(agentId: string, managerId: string): AgentDescriptor {
  return {
    ...makeManagerDescriptor(agentId, managerId),
    role: "worker",
    managerId,
    profileId: undefined,
  };
}

function makeBaseDescriptor(
  overrides: Partial<SessionCreationBaseDescriptor> = {},
): SessionCreationBaseDescriptor {
  return {
    model: {
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      thinkingLevel: "high",
    },
    cwd: "/workspace/base",
    ...overrides,
  };
}
