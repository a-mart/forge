import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        plan: "deep-reasoner",
        "correctness-review": "independent-critic",
        "design-review": "independent-critic",
        research: "research-analyst",
      },
    });
    expect(settings.rosters[0]?.routes.map((route) => route.routeId)).toEqual([
      "quick-scout",
      "fast-builder",
      "research-analyst",
      "independent-critic",
      "deep-reasoner",
    ]);
    await expect(readFile(getDelegationRostersPath(dataDir), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
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
    expect(context).toContain('"useWhen"');
    expect(context).toContain('"executor"');
    expect(context).not.toContain("availabilityFallback");
    expect(context).not.toContain("promptBody");
  });
});
