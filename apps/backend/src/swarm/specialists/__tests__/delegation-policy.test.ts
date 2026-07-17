import { describe, expect, it } from "vitest";
import {
  resolveManagerDelegation,
  translateManagerDelegationError,
} from "../delegation-policy.js";

describe("resolveManagerDelegation", () => {
  it("defaults general work to the routine execution policy", () => {
    expect(resolveManagerDelegation({
      agentId: "implementer",
      initialMessage: "Implement the scoped change.",
    })).toEqual({
      requestedMode: "general",
      requestedExecutionPolicy: "routine",
      spawnInput: {
        agentId: "implementer",
        initialMessage: "Implement the scoped change.",
        tier: "standard",
        lens: undefined,
        policyControlledModel: true,
        planStep: undefined,
        cwd: undefined,
      },
    });
  });

  it.each([
    ["plan", "planner"],
    ["correctness-review", "code-reviewer"],
    ["design-review", "code-reviewer-2"],
  ] as const)("defaults %s work to deep", (mode, lens) => {
    expect(resolveManagerDelegation({
      agentId: "specialist",
      initialMessage: "Do the assigned work.",
      mode,
    })).toMatchObject({
      requestedMode: mode,
      requestedExecutionPolicy: "deep",
      spawnInput: { tier: "deep", lens },
    });
  });

  it("defaults research work to support", () => {
    expect(resolveManagerDelegation({
      agentId: "researcher",
      initialMessage: "Verify the current docs.",
      mode: "research",
    })).toMatchObject({
      requestedMode: "research",
      requestedExecutionPolicy: "support",
      spawnInput: { tier: "fast", lens: "researcher" },
    });
  });

  it("allows the manager to choose support for bounded planning and review work", () => {
    expect(resolveManagerDelegation({
      agentId: "planner",
      initialMessage: "Plan the work.",
      mode: "plan",
      executionPolicy: "support",
    })).toMatchObject({
      requestedMode: "plan",
      requestedExecutionPolicy: "support",
      spawnInput: { tier: "fast", lens: "planner" },
    });
  });

  it("routes custom specialists without applying a mode or policy", () => {
    expect(resolveManagerDelegation({
      agentId: "domain-expert",
      initialMessage: "Inspect the domain behavior.",
      customSpecialist: "payments-expert",
      planStep: "Inspect payments",
    })).toEqual({
      spawnInput: {
        agentId: "domain-expert",
        initialMessage: "Inspect the domain behavior.",
        specialist: "payments-expert",
        planStep: "Inspect payments",
        cwd: undefined,
      },
    });
  });

  it("rejects ambiguous custom-specialist combinations", () => {
    expect(() => resolveManagerDelegation({
      agentId: "domain-expert",
      initialMessage: "Inspect the domain behavior.",
      customSpecialist: "payments-expert",
      executionPolicy: "deep",
    })).toThrow("customSpecialist cannot be combined");
  });

  it("rejects builtin and legacy handles through the custom-specialist path", () => {
    expect(() => resolveManagerDelegation({
      agentId: "planner",
      initialMessage: "Plan the work.",
      customSpecialist: "planner",
    })).toThrow('customSpecialist "planner" is reserved for Forge compatibility');
  });

  it("requires concrete task text", () => {
    expect(() => resolveManagerDelegation({
      agentId: "worker",
      initialMessage: "   ",
    })).toThrow("spawn_agent requires a non-empty initialMessage");
  });

  it("translates internal lens failures back to manager-facing mode language", () => {
    const resolved = resolveManagerDelegation({
      agentId: "reviewer",
      initialMessage: "Review the change.",
      mode: "correctness-review",
    });

    expect(translateManagerDelegationError(
      new Error('Lens "code-reviewer" is disabled for this profile. Enable it before spawning.'),
      resolved,
    ).message).toBe('Behavior mode "correctness-review" is disabled in this session.');
  });
});
