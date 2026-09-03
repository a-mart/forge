import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatDelegationRosterModelContext,
  getDelegationRostersPath,
  normalizeDelegationRosterSettings,
  resolveDelegationRosterSettings,
  resolveDelegationRoute,
  saveDelegationRosterSettings,
} from "../delegation-roster-store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

async function makeDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "delegation-rosters-"));
  tempDirs.push(dataDir);
  return dataDir;
}

describe("delegation roster settings", () => {
  it("migrates the existing tier bindings into one balanced roster without writing eagerly", async () => {
    const dataDir = await makeDataDir();

    const settings = await resolveDelegationRosterSettings(dataDir);

    expect(settings.defaultRosterId).toBe("balanced");
    expect(settings.rosters).toHaveLength(1);
    expect(settings.rosters[0]).toMatchObject({
      rosterId: "balanced",
      defaultRouteId: "fast-builder",
      modeRoutes: {
        general: "fast-builder",
        plan: "planner",
        "correctness-review": "independent-critic",
        "design-review": "independent-critic",
        research: "research-analyst",
      },
    });
    expect(settings.rosters[0]?.routes.find((route) => route.routeId === "deep-reasoner"))
      .toMatchObject({
        label: "Deep Specialist",
        behaviorMode: "general",
        useWhen: expect.stringContaining("architecturally ambiguous"),
        avoidWhen: expect.stringContaining("routine implementation"),
      });
    expect(settings.rosters[0]?.routes.map((route) => route.routeId)).toEqual([
      "quick-scout",
      "fast-builder",
      "planner",
      "research-analyst",
      "independent-critic",
      "deep-reasoner",
    ]);
    expect(settings.rosters[0]?.routes.map((route) => [
      route.routeId,
      route.modelId,
      route.reasoningLevel,
    ])).toEqual([
      ["quick-scout", "gpt-5.6-luna", "high"],
      ["fast-builder", "gpt-5.6-terra", "xhigh"],
      ["planner", "gpt-5.6-sol", "xhigh"],
      ["research-analyst", "gpt-5.5", "medium"],
      ["independent-critic", "gpt-5.5", "high"],
      ["deep-reasoner", "gpt-5.6-sol", "xhigh"],
    ]);
    expect(settings.rosters[0]?.description).toBe(
      "A balanced development team with a normal builder, focused alternatives, and evidence-based escalation.",
    );
    await expect(readFile(getDelegationRostersPath(dataDir), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("updates the generated legacy roster description without changing custom copy", async () => {
    const dataDir = await makeDataDir();
    const settings = await resolveDelegationRosterSettings(dataDir);
    const roster = settings.rosters[0]!;

    const legacy = normalizeDelegationRosterSettings({
      ...settings,
      rosters: [{
        ...roster,
        description: "General-purpose routes migrated from the existing Forge worker model bindings.",
      }],
    });
    const custom = normalizeDelegationRosterSettings({
      ...settings,
      rosters: [{ ...roster, description: "My own route terminology." }],
    });

    expect(legacy.rosters[0]?.description).toBe(
      "A balanced development team with a normal builder, focused alternatives, and evidence-based escalation.",
    );
    expect(custom.rosters[0]?.description).toBe("My own route terminology.");
  });

  it("migrates persisted GPT-5.4 and retired xAI route and fallback models on load without rewriting the file", async () => {
    const dataDir = await makeDataDir();
    const settings = await resolveDelegationRosterSettings(dataDir);
    const roster = settings.rosters[0]!;
    const persisted = {
      ...settings,
      rosters: [{
        ...roster,
        routes: roster.routes.map((route) => {
          if (route.routeId === "fast-builder") {
            return {
              ...route,
              label: "My Custom Builder",
              provider: "openai-codex",
              modelId: "gpt-5.4",
              reasoningLevel: "high" as const,
              availabilityFallback: {
                provider: "openai-codex",
                modelId: "gpt-5.4-mini",
                reasoningLevel: "low" as const,
              },
            };
          }
          if (route.routeId === "research-analyst") {
            return {
              ...route,
              label: "My Custom Researcher",
              provider: "xai",
              modelId: "grok-4",
              reasoningLevel: "high" as const,
              availabilityFallback: {
                provider: "xai",
                modelId: "grok-4-fast",
                reasoningLevel: "medium" as const,
              },
            };
          }
          return route;
        }),
      }],
    };
    const rosterPath = getDelegationRostersPath(dataDir);
    await mkdir(dirname(rosterPath), { recursive: true });
    const persistedJson = `${JSON.stringify(persisted, null, 2)}\n`;
    await writeFile(rosterPath, persistedJson, "utf8");

    const loaded = await resolveDelegationRosterSettings(dataDir);
    const loadedRoster = loaded.rosters[0]!;

    expect(loadedRoster.routes.find((route) => route.routeId === "fast-builder")).toMatchObject({
      label: "My Custom Builder",
      provider: "openai-codex",
      modelId: "gpt-5.5",
      reasoningLevel: "high",
      availabilityFallback: {
        provider: "openai-codex",
        modelId: "gpt-5.5",
        reasoningLevel: "low",
      },
    });
    expect(loadedRoster.routes.find((route) => route.routeId === "research-analyst")).toMatchObject({
      label: "My Custom Researcher",
      provider: "xai",
      modelId: "grok-4.6",
      reasoningLevel: "high",
      availabilityFallback: {
        provider: "xai",
        modelId: "grok-4.6",
        reasoningLevel: "medium",
      },
    });
    expect(await readFile(rosterPath, "utf8")).toBe(persistedJson);
  });

  it("updates canonical built-in specialist copy without changing custom copy", async () => {
    const dataDir = await makeDataDir();
    const settings = await resolveDelegationRosterSettings(dataDir);
    const roster = settings.rosters[0]!;

    const migrated = normalizeDelegationRosterSettings({
      ...settings,
      rosters: [{
        ...roster,
        routes: roster.routes.map((route) => (
          route.routeId === "quick-scout"
            ? {
                ...route,
                label: "Economy",
                useWhen: "Use for cheap lookups, file discovery, and bounded source gathering when low cost matters more than depth.",
                avoidWhen: "Avoid when ambiguity, risk, or synthesis quality matters more than minimizing cost.",
                capabilityEscalationRouteId: "research-analyst",
                modelId: "gpt-5.6-terra",
                reasoningLevel: "low" as const,
              }
            : route.routeId === "fast-builder"
            ? {
                ...route,
                label: "Fast Execution",
                useWhen: "Well-specified implementation and focused fixes with clear acceptance.",
                avoidWhen: undefined,
                modelId: "gpt-5.6-luna",
                reasoningLevel: "high" as const,
              }
            : route.routeId === "planner"
              ? {
                  ...route,
                  provider: "xai",
                  modelId: "grok-4.5",
                  reasoningLevel: "high" as const,
                }
            : route.routeId === "research-analyst"
              ? { ...route, label: "My Planning Model" }
              : route.routeId === "deep-reasoner"
                ? { ...route, reasoningLevel: "max" as const }
              : route
        )),
      }],
    });

    expect(migrated.rosters[0]?.routes.find((route) => route.routeId === "fast-builder")?.label)
      .toBe("Builder");
    expect(migrated.rosters[0]?.routes.find((route) => route.routeId === "fast-builder"))
      .toMatchObject({
        useWhen: expect.stringContaining("normal feature"),
        avoidWhen: expect.stringContaining("quick builder"),
      });
    expect(migrated.rosters[0]?.routes.find((route) => route.routeId === "quick-scout"))
      .toMatchObject({
        label: "Quick Builder",
        useWhen: expect.stringContaining("small, well-specified implementation"),
        capabilityEscalationRouteId: "fast-builder",
        modelId: "gpt-5.6-luna",
        reasoningLevel: "high",
      });
    expect(migrated.rosters[0]?.routes.find((route) => route.routeId === "fast-builder"))
      .toMatchObject({ modelId: "gpt-5.6-terra", reasoningLevel: "xhigh" });
    expect(migrated.rosters[0]?.routes.find((route) => route.routeId === "planner"))
      .toMatchObject({
        useWhen: expect.stringContaining("decomposition"),
        avoidWhen: expect.stringContaining("implementation or source research"),
        modelId: "gpt-5.6-sol",
        reasoningLevel: "xhigh",
      });
    expect(migrated.rosters[0]?.routes.find((route) => route.routeId === "research-analyst"))
      .toMatchObject({ useWhen: expect.stringContaining("source-backed investigation") });
    expect(migrated.rosters[0]?.routes.find((route) => route.routeId === "research-analyst")?.label)
      .toBe("My Planning Model");
    expect(migrated.rosters[0]?.routes.find((route) => route.routeId === "deep-reasoner"))
      .toMatchObject({ modelId: "gpt-5.6-sol", reasoningLevel: "xhigh" });
  });

  it("consolidates the generated design reviewer into the independent reviewer without touching custom alternatives", async () => {
    const dataDir = await makeDataDir();
    const settings = await resolveDelegationRosterSettings(dataDir);
    const roster = settings.rosters[0]!;
    const reviewer = roster.routes.find((route) => route.routeId === "independent-critic")!;
    const generatedDesignReviewer = {
      ...reviewer,
      routeId: "design-reviewer",
      label: "Design Reviewer",
      behaviorMode: "design-review" as const,
    };

    const consolidated = normalizeDelegationRosterSettings({
      ...settings,
      rosters: [{
        ...roster,
        modeRoutes: { ...roster.modeRoutes, "design-review": "design-reviewer" },
        routes: [...roster.routes, generatedDesignReviewer],
      }],
    });

    expect(consolidated.rosters[0]?.modeRoutes?.["design-review"])
      .toBe("independent-critic");
    expect(consolidated.rosters[0]?.routes.some((route) => route.routeId === "design-reviewer"))
      .toBe(false);

    const customized = normalizeDelegationRosterSettings({
      ...settings,
      rosters: [{
        ...roster,
        modeRoutes: { ...roster.modeRoutes, "design-review": "design-reviewer" },
        routes: [
          ...roster.routes,
          { ...generatedDesignReviewer, useWhen: "Custom design-review guidance." },
        ],
      }],
    });

    expect(customized.rosters[0]?.modeRoutes?.["design-review"])
      .toBe("design-reviewer");
    expect(customized.rosters[0]?.routes.some((route) => route.routeId === "design-reviewer"))
      .toBe(true);
  });

  it("resolves automatic and named routes from the manager's active roster", async () => {
    const dataDir = await makeDataDir();
    const manager = {
      delegationRosterId: "balanced",
      delegationRosterOrigin: "global_default" as const,
    };

    const automatic = await resolveDelegationRoute(dataDir, manager, "auto", "research");
    const named = await resolveDelegationRoute(
      dataDir,
      manager,
      "deep-reasoner",
      "general",
    );

    expect(automatic.route.routeId).toBe("research-analyst");
    expect(automatic.requestedRoute).toBe("auto");
    expect(named.route.routeId).toBe("deep-reasoner");

    const designReview = await resolveDelegationRoute(dataDir, manager, "auto", "design-review");
    expect(designReview.route.routeId).toBe("independent-critic");
  });

  it("increments only changed roster revisions and persists a clone-safe file", async () => {
    const dataDir = await makeDataDir();
    const initial = await resolveDelegationRosterSettings(dataDir);
    const first = await saveDelegationRosterSettings(dataDir, initial);
    const unchanged = await saveDelegationRosterSettings(dataDir, first);
    const changedInput = {
      ...unchanged,
      rosters: unchanged.rosters.map((roster) => ({
        ...roster,
        description: "Changed description.",
      })),
    };
    const changed = await saveDelegationRosterSettings(dataDir, changedInput);

    expect(first.rosters[0]?.revision).toBe(1);
    expect(unchanged.rosters[0]?.revision).toBe(1);
    expect(changed.rosters[0]?.revision).toBe(2);
    expect(JSON.parse(await readFile(getDelegationRostersPath(dataDir), "utf8")))
      .toEqual(changed);
  });

  it("rejects ambiguous route identity and invalid escalation", async () => {
    const dataDir = await makeDataDir();
    const settings = await resolveDelegationRosterSettings(dataDir);
    const roster = settings.rosters[0]!;

    expect(() => normalizeDelegationRosterSettings({
      ...settings,
      rosters: [{
        ...roster,
        routes: [
          roster.routes[0],
          { ...roster.routes[1], routeId: roster.routes[0]!.routeId },
        ],
      }],
    })).toThrow("route ids must be unique");

    expect(() => normalizeDelegationRosterSettings({
      ...settings,
      rosters: [{
        ...roster,
        routes: roster.routes.map((route) => route.routeId === "fast-builder"
          ? { ...route, capabilityEscalationRouteId: "fast-builder" }
          : route),
      }],
    })).toThrow("cannot escalate to itself");

    expect(() => normalizeDelegationRosterSettings({
      ...settings,
      rosters: [{
        ...roster,
        routes: roster.routes.map((route) => {
          if (route.routeId === "fast-builder") {
            return { ...route, capabilityEscalationRouteId: "deep-reasoner" };
          }
          if (route.routeId === "deep-reasoner") {
            return { ...route, capabilityEscalationRouteId: "fast-builder" };
          }
          return route;
        }),
      }],
    })).toThrow("must not form a cycle");
  });

  it("formats bounded runtime guidance with route purpose and executor resolution", async () => {
    const dataDir = await makeDataDir();
    const roster = (await resolveDelegationRosterSettings(dataDir)).rosters[0]!;

    const context = formatDelegationRosterModelContext(roster);

    expect(context).toMatch(/^\[delegationRoster\] /);
    expect(context).toContain('"id":"balanced"');
    expect(context).toContain('"defaults":"general=');
    expect(context).toContain('"specialists":');
    expect(context).toContain('"task":"research"');
    expect(context).not.toContain('"auto":');
    expect(context).toContain('"useWhen"');
    expect(context).toContain('"executor"');
    expect(context).not.toContain("availabilityFallback");
    expect(context).not.toContain("promptBody");
  });
});
