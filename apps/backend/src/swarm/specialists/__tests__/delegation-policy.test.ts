import { describe, expect, it } from "vitest";
import {
  resolveManagerDelegation,
  translateManagerDelegationError,
} from "../delegation-policy.js";

describe("resolveManagerDelegation", () => {
  it("defaults general work to the active roster's automatic route", () => {
    expect(resolveManagerDelegation({
      agentId: "implementer",
      initialMessage: "Implement the scoped change.",
    })).toEqual({
      requestedMode: "general",
      requestedRoute: "auto",
      spawnInput: {
        agentId: "implementer",
        initialMessage: "Implement the scoped change.",
        route: "auto",
        behaviorMode: "general",
        lens: undefined,
        planStep: undefined,
        cwd: undefined,
      },
    });
  });

  it.each([
    ["plan", "planner"],
    ["correctness-review", "code-reviewer"],
    ["design-review", "code-reviewer-2"],
    ["research", "researcher"],
  ] as const)("keeps %s behavior separate from route choice", (mode, lens) => {
    expect(resolveManagerDelegation({
      agentId: "specialist",
      initialMessage: "Do the assigned work.",
      mode,
    })).toMatchObject({
      requestedMode: mode,
      requestedRoute: "auto",
      spawnInput: { behaviorMode: mode, route: "auto", lens },
    });
  });

  it("allows a named route from the active roster", () => {
    expect(resolveManagerDelegation({
      agentId: "planner",
      initialMessage: "Plan the work.",
      mode: "plan",
      route: "deep-reasoner",
    })).toMatchObject({
      requestedMode: "plan",
      requestedRoute: "deep-reasoner",
      spawnInput: {
        behaviorMode: "plan",
        route: "deep-reasoner",
        lens: "planner",
      },
    });
  });

  it("keeps one compatibility branch for managers with the prior policy schema", () => {
    expect(resolveManagerDelegation({
      agentId: "legacy",
      initialMessage: "Review the work.",
      mode: "correctness-review",
      executionPolicy: "deep",
    })).toMatchObject({
      requestedExecutionPolicy: "deep",
      spawnInput: {
        tier: "deep",
        lens: "code-reviewer",
        policyControlledModel: true,
      },
    });
  });

  it("routes custom specialists without applying a mode or route", () => {
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
      route: "deep-reasoner",
    })).toThrow("customSpecialist cannot be combined");
  });

  it("rejects builtin and legacy handles through the custom-specialist path", () => {
    expect(() => resolveManagerDelegation({
      agentId: "planner",
      initialMessage: "Plan the work.",
      customSpecialist: "planner",
    })).toThrow('customSpecialist "planner" is reserved for Forge compatibility');
  });

  it("requires concrete task and route text", () => {
    expect(() => resolveManagerDelegation({
      agentId: "worker",
      initialMessage: "   ",
    })).toThrow("spawn_agent requires a non-empty initialMessage");
    expect(() => resolveManagerDelegation({
      agentId: "worker",
      initialMessage: "Do work.",
      route: " ",
    })).toThrow("spawn_agent.route must be auto or a non-empty route id");
  });

  it("translates internal lens and route failures into manager-facing language", () => {
    const resolved = resolveManagerDelegation({
      agentId: "reviewer",
      initialMessage: "Review the change.",
      mode: "correctness-review",
      route: "critic",
    });

    expect(translateManagerDelegationError(
      new Error('Lens "code-reviewer" is disabled for this profile. Enable it before spawning.'),
      resolved,
    ).message).toBe('Behavior mode "correctness-review" is disabled in this session.');
    expect(translateManagerDelegationError(
      new Error('Delegation route "critic" is not available.'),
      resolved,
    ).message).toContain('Execution route "critic" is not available');
  });
});
