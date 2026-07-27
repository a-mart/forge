import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DELEGATION_BEHAVIOR_MODES,
  type DelegationBehaviorMode,
  type DelegationRoster,
  type DelegationRosterSettings,
  type DelegationRoute,
  type ManagerReasoningLevel,
  type TierConfig,
} from "@forge/protocol";
import { writeJsonFileAtomic } from "../../utils/atomic-files.js";
import { isEnoentError } from "../../utils/fs-errors.js";
import { getSharedConfigDir } from "../data-paths.js";
import type { AgentDescriptor } from "../types.js";
import { resolveTierConfigs } from "./specialist-registry.js";

const DELEGATION_ROSTERS_FILENAME = "delegation-rosters.json";
const ROUTE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROSTER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const MAX_ROSTERS = 24;
const MAX_ROUTES = 24;
const DEFAULT_ROSTER_ID = "balanced";
const LEGACY_BALANCED_DESCRIPTION =
  "General-purpose routes migrated from the existing Forge worker model bindings.";
const BALANCED_DESCRIPTION =
  "General-purpose worker profiles derived from the existing Forge model bindings.";

type ManagerRouteDescriptor = Pick<
  AgentDescriptor,
  "delegationRosterId" | "delegationRosterOrigin"
>;

export interface ResolvedDelegationRoute {
  roster: DelegationRoster;
  route: DelegationRoute;
  requestedRoute: string;
}

export function getDelegationRostersPath(dataDir: string): string {
  return join(getSharedConfigDir(dataDir), DELEGATION_ROSTERS_FILENAME);
}

export async function resolveDelegationRosterSettings(
  dataDir: string,
): Promise<DelegationRosterSettings> {
  try {
    const parsed = JSON.parse(await readFile(getDelegationRostersPath(dataDir), "utf8")) as unknown;
    return normalizeDelegationRosterSettings(parsed);
  } catch (error) {
    if (!isEnoentError(error)) throw error;
    return buildMigratedDelegationRosterSettings(await resolveTierConfigs(dataDir));
  }
}

export async function saveDelegationRosterSettings(
  dataDir: string,
  input: unknown,
): Promise<DelegationRosterSettings> {
  const requested = normalizeDelegationRosterSettings(input);
  const existing = await resolveDelegationRosterSettings(dataDir);
  const existingById = new Map(existing.rosters.map((roster) => [roster.rosterId, roster]));
  const next: DelegationRosterSettings = {
    version: 1,
    defaultRosterId: requested.defaultRosterId,
    rosters: requested.rosters.map((roster) => {
      const previous = existingById.get(roster.rosterId);
      const revision = previous && sameRosterDefinition(previous, roster)
        ? previous.revision
        : (previous?.revision ?? 0) + 1;
      return { ...cloneRoster(roster), revision };
    }),
  };
  await mkdir(getSharedConfigDir(dataDir), { recursive: true });
  await writeJsonFileAtomic(getDelegationRostersPath(dataDir), next);
  return cloneSettings(next);
}

export async function resolveDelegationRosterForManager(
  dataDir: string,
  manager: ManagerRouteDescriptor,
): Promise<DelegationRoster> {
  const settings = await resolveDelegationRosterSettings(dataDir);
  const rosterId = manager.delegationRosterId?.trim() || settings.defaultRosterId;
  const roster = settings.rosters.find((entry) => entry.rosterId === rosterId);
  if (roster) return cloneRoster(roster);

  if (manager.delegationRosterOrigin === "session_override") {
    throw new Error(`Session delegation roster "${rosterId}" no longer exists.`);
  }
  if (manager.delegationRosterOrigin === "project_default") {
    throw new Error(`Project delegation roster "${rosterId}" no longer exists.`);
  }

  const fallback = settings.rosters.find((entry) => entry.rosterId === settings.defaultRosterId);
  if (!fallback) {
    throw new Error(`Global delegation roster "${settings.defaultRosterId}" does not exist.`);
  }
  return cloneRoster(fallback);
}

export async function resolveDelegationRoute(
  dataDir: string,
  manager: ManagerRouteDescriptor,
  requestedRoute: string,
  behaviorMode: DelegationBehaviorMode,
): Promise<ResolvedDelegationRoute> {
  const roster = await resolveDelegationRosterForManager(dataDir, manager);
  const normalizedRequest = requestedRoute.trim() || "auto";
  const routeId = normalizedRequest === "auto"
    ? roster.modeRoutes?.[behaviorMode] ?? roster.defaultRouteId
    : normalizedRequest;
  const route = roster.routes.find((candidate) => candidate.routeId === routeId);
  if (!route) {
    const requestLabel = normalizedRequest === "auto"
      ? `automatic route for behavior mode "${behaviorMode}"`
      : `route "${normalizedRequest}"`;
    throw new Error(
      `Delegation ${requestLabel} is not available in roster "${roster.name}" (${roster.rosterId}).`,
    );
  }
  return {
    roster,
    route: cloneRoute(route),
    requestedRoute: normalizedRequest,
  };
}

export function formatDelegationRosterModelContext(roster: DelegationRoster): string {
  const modeRoutes = DELEGATION_BEHAVIOR_MODES
    .map((mode) => `${mode}=${roster.modeRoutes?.[mode] ?? roster.defaultRouteId}`)
    .join(", ");
  const routes = roster.routes.map((route) => ({
    id: route.routeId,
    label: route.label,
    useWhen: route.useWhen,
    ...(route.avoidWhen ? { avoidWhen: route.avoidWhen } : {}),
    executor: `${route.provider}/${route.modelId} ${route.reasoningLevel}`,
    ...(route.capabilityEscalationRouteId
      ? { capabilityEscalation: route.capabilityEscalationRouteId }
      : {}),
  }));
  return `[delegationRoster] ${JSON.stringify({
    id: roster.rosterId,
    revision: roster.revision,
    name: roster.name,
    baselines: modeRoutes,
    routes,
  })}`;
}

export function normalizeDelegationRosterSettings(input: unknown): DelegationRosterSettings {
  if (!isRecord(input)) throw new Error("Delegation roster settings must be an object.");
  if (input.version !== 1) throw new Error("Delegation roster settings version must be 1.");
  const defaultRosterId = normalizeId(input.defaultRosterId, "defaultRosterId", ROSTER_ID_PATTERN);
  if (!Array.isArray(input.rosters) || input.rosters.length === 0) {
    throw new Error("Delegation roster settings must contain at least one roster.");
  }
  if (input.rosters.length > MAX_ROSTERS) {
    throw new Error(`Delegation roster settings may contain at most ${MAX_ROSTERS} rosters.`);
  }
  const rosters = input.rosters.map((value, index) => normalizeRoster(value, index));
  assertUnique(rosters.map((roster) => roster.rosterId), "roster id");
  if (!rosters.some((roster) => roster.rosterId === defaultRosterId)) {
    throw new Error(`Default delegation roster "${defaultRosterId}" does not exist.`);
  }
  return { version: 1, defaultRosterId, rosters };
}

function normalizeRoster(input: unknown, index: number): DelegationRoster {
  if (!isRecord(input)) throw new Error(`rosters[${index}] must be an object.`);
  const prefix = `rosters[${index}]`;
  const rosterId = normalizeId(input.rosterId, `${prefix}.rosterId`, ROSTER_ID_PATTERN);
  const revision = normalizePositiveInteger(input.revision ?? 1, `${prefix}.revision`);
  const name = normalizeText(input.name, `${prefix}.name`, 80);
  const storedDescription = normalizeOptionalText(input.description, `${prefix}.description`, 240);
  const description = storedDescription === LEGACY_BALANCED_DESCRIPTION
    ? BALANCED_DESCRIPTION
    : storedDescription;
  const defaultRouteId = normalizeId(input.defaultRouteId, `${prefix}.defaultRouteId`, ROUTE_ID_PATTERN);
  if (!Array.isArray(input.routes) || input.routes.length === 0) {
    throw new Error(`${prefix}.routes must contain at least one route.`);
  }
  if (input.routes.length > MAX_ROUTES) {
    throw new Error(`${prefix}.routes may contain at most ${MAX_ROUTES} routes.`);
  }
  const routes = input.routes.map((route, routeIndex) => normalizeRoute(route, `${prefix}.routes[${routeIndex}]`));
  const routeIds = routes.map((route) => route.routeId);
  assertUnique(routeIds, `${prefix} route id`);
  const routeIdSet = new Set(routeIds);
  if (!routeIdSet.has(defaultRouteId)) {
    throw new Error(`${prefix}.defaultRouteId references unknown route "${defaultRouteId}".`);
  }
  const modeRoutes = normalizeModeRoutes(input.modeRoutes, prefix, routeIdSet);
  for (const route of routes) {
    if (
      route.capabilityEscalationRouteId
      && !routeIdSet.has(route.capabilityEscalationRouteId)
    ) {
      throw new Error(
        `${prefix} route "${route.routeId}" escalates to unknown route `
        + `"${route.capabilityEscalationRouteId}".`,
      );
    }
    if (route.capabilityEscalationRouteId === route.routeId) {
      throw new Error(`${prefix} route "${route.routeId}" cannot escalate to itself.`);
    }
  }
  assertNoEscalationCycles(routes, prefix);
  return {
    rosterId,
    revision,
    name,
    ...(description ? { description } : {}),
    defaultRouteId,
    ...(Object.keys(modeRoutes).length > 0 ? { modeRoutes } : {}),
    routes,
  };
}

function normalizeRoute(input: unknown, prefix: string): DelegationRoute {
  if (!isRecord(input)) throw new Error(`${prefix} must be an object.`);
  const color = normalizeOptionalText(input.color, `${prefix}.color`, 7);
  const avoidWhen = normalizeOptionalText(input.avoidWhen, `${prefix}.avoidWhen`, 240);
  if (color && !HEX_COLOR_PATTERN.test(color)) {
    throw new Error(`${prefix}.color must be a six-digit hex color.`);
  }
  const availabilityFallback = input.availabilityFallback === undefined
    ? undefined
    : normalizeFallback(input.availabilityFallback, `${prefix}.availabilityFallback`);
  return {
    routeId: normalizeId(input.routeId, `${prefix}.routeId`, ROUTE_ID_PATTERN),
    label: normalizeText(input.label, `${prefix}.label`, 80),
    useWhen: normalizeText(input.useWhen, `${prefix}.useWhen`, 240),
    ...(avoidWhen ? { avoidWhen } : {}),
    ...(color ? { color } : {}),
    provider: normalizeText(input.provider, `${prefix}.provider`, 100),
    modelId: normalizeText(input.modelId, `${prefix}.modelId`, 180),
    reasoningLevel: normalizeReasoning(input.reasoningLevel, `${prefix}.reasoningLevel`),
    ...(availabilityFallback ? { availabilityFallback } : {}),
    ...(input.capabilityEscalationRouteId === undefined
      ? {}
      : {
          capabilityEscalationRouteId: normalizeId(
            input.capabilityEscalationRouteId,
            `${prefix}.capabilityEscalationRouteId`,
            ROUTE_ID_PATTERN,
          ),
        }),
  };
}

function normalizeFallback(input: unknown, prefix: string): DelegationRoute["availabilityFallback"] {
  if (!isRecord(input)) throw new Error(`${prefix} must be an object.`);
  return {
    provider: normalizeText(input.provider, `${prefix}.provider`, 100),
    modelId: normalizeText(input.modelId, `${prefix}.modelId`, 180),
    reasoningLevel: normalizeReasoning(input.reasoningLevel, `${prefix}.reasoningLevel`),
  };
}

function normalizeModeRoutes(
  input: unknown,
  prefix: string,
  routeIds: Set<string>,
): Partial<Record<DelegationBehaviorMode, string>> {
  if (input === undefined) return {};
  if (!isRecord(input)) throw new Error(`${prefix}.modeRoutes must be an object.`);
  const result: Partial<Record<DelegationBehaviorMode, string>> = {};
  for (const mode of DELEGATION_BEHAVIOR_MODES) {
    if (input[mode] === undefined) continue;
    const routeId = normalizeId(input[mode], `${prefix}.modeRoutes.${mode}`, ROUTE_ID_PATTERN);
    if (!routeIds.has(routeId)) {
      throw new Error(`${prefix}.modeRoutes.${mode} references unknown route "${routeId}".`);
    }
    result[mode] = routeId;
  }
  return result;
}

function buildMigratedDelegationRosterSettings(
  tiers: readonly TierConfig[],
): DelegationRosterSettings {
  const byTier = new Map(tiers.map((tier) => [tier.tier, tier]));
  const routes = [
    routeFromTier(byTier.get("light"), "quick-scout", "Quick Scout", "Cheap lookups, file discovery, and bounded source gathering."),
    routeFromTier(byTier.get("fast"), "fast-builder", "Fast Builder", "Well-specified implementation and focused fixes with clear acceptance."),
    routeFromTier(byTier.get("standard"), "research-analyst", "Research Analyst", "Ordinary planning, source gathering, analysis, and balanced synthesis."),
    routeFromTier(byTier.get("deep"), "independent-critic", "Independent Critic", "Correctness, regression, security, and design review where independent judgment matters."),
    routeFromTier(byTier.get("max"), "deep-reasoner", "Deep Executor", "Difficult architecture, cross-cutting implementation, ambiguous remediation, and high-risk synthesis."),
  ];
  routes[0]!.capabilityEscalationRouteId = "research-analyst";
  routes[1]!.capabilityEscalationRouteId = "deep-reasoner";
  routes[2]!.capabilityEscalationRouteId = "deep-reasoner";
  routes[3]!.capabilityEscalationRouteId = "deep-reasoner";
  return {
    version: 1,
    defaultRosterId: DEFAULT_ROSTER_ID,
    rosters: [{
      rosterId: DEFAULT_ROSTER_ID,
      revision: 1,
      name: "Balanced",
      description: BALANCED_DESCRIPTION,
      defaultRouteId: "fast-builder",
      modeRoutes: {
        general: "fast-builder",
        plan: "research-analyst",
        "correctness-review": "independent-critic",
        "design-review": "independent-critic",
        research: "research-analyst",
      },
      routes,
    }],
  };
}

function routeFromTier(
  tier: TierConfig | undefined,
  routeId: string,
  label: string,
  useWhen: string,
): DelegationRoute {
  if (!tier) throw new Error(`Cannot migrate delegation route "${routeId}" without its tier binding.`);
  return {
    routeId,
    label,
    useWhen,
    color: tier.color,
    provider: tier.provider,
    modelId: tier.modelId,
    reasoningLevel: (tier.reasoningLevel ?? "medium") as ManagerReasoningLevel,
    ...(tier.fallbackModelId
      ? {
          availabilityFallback: {
            provider: tier.fallbackProvider ?? tier.provider,
            modelId: tier.fallbackModelId,
            reasoningLevel: (
              tier.fallbackReasoningLevel
              ?? tier.reasoningLevel
              ?? "medium"
            ) as ManagerReasoningLevel,
          },
        }
      : {}),
  };
}

function sameRosterDefinition(left: DelegationRoster, right: DelegationRoster): boolean {
  const normalizeRevision = (roster: DelegationRoster): DelegationRoster => ({ ...roster, revision: 0 });
  return JSON.stringify(normalizeRevision(left)) === JSON.stringify(normalizeRevision(right));
}

function cloneSettings(settings: DelegationRosterSettings): DelegationRosterSettings {
  return {
    version: 1,
    defaultRosterId: settings.defaultRosterId,
    rosters: settings.rosters.map(cloneRoster),
  };
}

function cloneRoster(roster: DelegationRoster): DelegationRoster {
  return {
    ...roster,
    modeRoutes: roster.modeRoutes ? { ...roster.modeRoutes } : undefined,
    routes: roster.routes.map(cloneRoute),
  };
}

function cloneRoute(route: DelegationRoute): DelegationRoute {
  return {
    ...route,
    availabilityFallback: route.availabilityFallback
      ? { ...route.availabilityFallback }
      : undefined,
  };
}

function normalizeReasoning(value: unknown, field: string): ManagerReasoningLevel {
  const supported: readonly string[] = ["none", "low", "medium", "high", "xhigh", "max", "ultra"];
  if (typeof value !== "string" || !supported.includes(value)) {
    throw new Error(`${field} must be one of ${supported.join(", ")}.`);
  }
  return value as ManagerReasoningLevel;
}

function normalizeId(value: unknown, field: string, pattern: RegExp): string {
  const normalized = normalizeText(value, field, 64).toLowerCase();
  if (!pattern.test(normalized)) {
    throw new Error(`${field} must use lowercase letters, digits, and hyphens.`);
  }
  return normalized;
}

function normalizeText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error(`${field} must be at most ${maximum} characters.`);
  return normalized;
}

function normalizeOptionalText(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return normalizeText(value, field, maximum);
}

function normalizePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value as number;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Delegation ${label}s must be unique.`);
}

function assertNoEscalationCycles(routes: readonly DelegationRoute[], prefix: string): void {
  const escalationByRoute = new Map(
    routes.map((route) => [route.routeId, route.capabilityEscalationRouteId]),
  );
  for (const route of routes) {
    const visited = new Set<string>();
    let current: string | undefined = route.routeId;
    while (current) {
      if (visited.has(current)) {
        throw new Error(`${prefix} capability escalation routes must not form a cycle.`);
      }
      visited.add(current);
      current = escalationByRoute.get(current);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
