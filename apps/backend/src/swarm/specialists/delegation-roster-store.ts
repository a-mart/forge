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
const LEGACY_BALANCED_DESCRIPTIONS = new Set([
  "General-purpose routes migrated from the existing Forge worker model bindings.",
  "General-purpose worker profiles derived from the existing Forge model bindings.",
  "General-purpose execution profiles derived from the existing Forge model bindings.",
  "General-purpose model policies derived from the existing Forge model bindings.",
  "A balanced team of task-focused specialists derived from the existing Forge model bindings.",
]);
const BALANCED_DESCRIPTION =
  "A balanced development team with a normal builder, focused alternatives, and evidence-based escalation.";
const BUILTIN_MODEL_POLICY_LABELS: Readonly<Record<string, {
  previous: readonly string[];
  current: string;
  behaviorMode: DelegationBehaviorMode;
  previousUseWhen: readonly string[];
  previousAvoidWhen: readonly string[];
  useWhen: string;
  avoidWhen: string;
}>> = {
  "quick-scout": {
    previous: ["Quick Scout", "Quick Lookup", "Economy", "Economy Scout"],
    current: "Quick Builder",
    behaviorMode: "general",
    previousUseWhen: [
      "Cheap lookups, file discovery, and bounded source gathering.",
      "Use for cheap lookups, file discovery, and bounded source gathering when low cost matters more than depth.",
    ],
    previousAvoidWhen: ["Avoid when ambiguity, risk, or synthesis quality matters more than minimizing cost."],
    useWhen: "Use for a small, well-specified implementation change with narrow scope and clear acceptance criteria when lower cost or latency matters.",
    avoidWhen: "Avoid when the change needs broad investigation, unfamiliar codebase context, or ambiguous requirements.",
  },
  "fast-builder": {
    previous: ["Fast Builder", "Fast Execution", "Fast"],
    current: "Builder",
    behaviorMode: "general",
    previousUseWhen: [
      "Well-specified implementation and focused fixes with clear acceptance.",
      "Use when the outcome is well specified, bounded, and has clear acceptance criteria. Prefer when low latency materially improves the workflow.",
    ],
    previousAvoidWhen: ["Avoid when the work is architecturally ambiguous, high risk, cross-cutting, or requires independent judgment."],
    useWhen: "Use for the normal feature, bug-fix, or refactor path when the work is understood and needs a capable implementation owner.",
    avoidWhen: "Avoid when a quick builder has a clearly sufficient bounded path or evidence justifies a deep escalation.",
  },
  "research-analyst": {
    previous: ["Research Analyst", "Analysis", "Balanced"],
    current: "Researcher",
    behaviorMode: "research",
    previousUseWhen: [
      "Ordinary planning, source gathering, analysis, and balanced synthesis.",
      "Use for ordinary planning, research, implementation, and synthesis that need balanced capability, cost, and speed.",
    ],
    previousAvoidWhen: ["Avoid when a cheap bounded attempt is clearly sufficient or the highest-capability model is justified by risk."],
    useWhen: "Use for source-backed investigation, documentation lookup, fact-checking, and focused technical analysis.",
    avoidWhen: "Avoid when the primary outcome is implementation, a work plan, or high-risk synthesis that warrants deeper reasoning.",
  },
  "independent-critic": {
    previous: ["Independent Critic", "Independent Review", "Independent", "Correctness Reviewer"],
    current: "Independent Reviewer",
    behaviorMode: "correctness-review",
    previousUseWhen: [
      "Correctness, regression, security, and design review where independent judgment matters.",
      "Use when independent judgment, provider diversity, correctness, regression, security, or design review materially improves confidence.",
    ],
    previousAvoidWhen: ["Avoid for routine implementation or when a second perspective would not change the acceptance decision."],
    useWhen: "Use for an independent review of a proposed or completed change when correctness, regressions, API/design quality, security, or maintainability could affect acceptance.",
    avoidWhen: "Avoid for routine implementation or when a second perspective would not change the acceptance decision.",
  },
  "deep-reasoner": {
    previous: ["Deep Executor", "Deep Reasoning", "Deep"],
    current: "Deep Specialist",
    behaviorMode: "general",
    previousUseWhen: [
      "Difficult architecture, cross-cutting implementation, ambiguous remediation, and high-risk synthesis.",
      "Use for architecturally ambiguous, high-risk, cross-cutting work or difficult synthesis where the stronger model is justified.",
    ],
    previousAvoidWhen: ["Avoid when a bounded fast or balanced attempt has a clear path and adequate acceptance criteria."],
    useWhen: "Use only when a normal specialist lacks a credible path: architecturally ambiguous, high-risk, cross-cutting work, or difficult synthesis with evidence that stronger reasoning is justified.",
    avoidWhen: "Avoid for routine implementation, ordinary planning, or review with a clear bounded path and adequate acceptance criteria.",
  },
};

const PLANNER_POLICY = {
  current: "Planner",
  behaviorMode: "plan" as const,
  useWhen: "Use for decomposition, implementation planning, sequencing, scope and risk analysis, and decision preparation before substantial work.",
  avoidWhen: "Avoid for implementation or source research when the user needs an answer or outcome rather than a plan.",
};

type RouteModelPolicy = Pick<DelegationRoute, "provider" | "modelId" | "reasoningLevel">;

const BALANCED_DEFAULT_MODEL_POLICIES: Readonly<Record<string, {
  previous: RouteModelPolicy;
  current: RouteModelPolicy;
}>> = {
  "quick-scout": {
    previous: { provider: "openai-codex", modelId: "gpt-5.6-terra", reasoningLevel: "low" },
    current: { provider: "openai-codex", modelId: "gpt-5.6-luna", reasoningLevel: "high" },
  },
  "fast-builder": {
    previous: { provider: "openai-codex", modelId: "gpt-5.6-luna", reasoningLevel: "high" },
    current: { provider: "openai-codex", modelId: "gpt-5.6-terra", reasoningLevel: "xhigh" },
  },
  planner: {
    previous: { provider: "xai", modelId: "grok-4.5", reasoningLevel: "high" },
    current: { provider: "openai-codex", modelId: "gpt-5.6-sol", reasoningLevel: "xhigh" },
  },
  "deep-reasoner": {
    previous: { provider: "openai-codex", modelId: "gpt-5.6-sol", reasoningLevel: "max" },
    current: { provider: "openai-codex", modelId: "gpt-5.6-sol", reasoningLevel: "xhigh" },
  },
};

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
    throw new Error(`Session delegation preset "${rosterId}" no longer exists.`);
  }
  if (manager.delegationRosterOrigin === "project_default") {
    throw new Error(`Project delegation preset "${rosterId}" no longer exists.`);
  }

  const fallback = settings.rosters.find((entry) => entry.rosterId === settings.defaultRosterId);
  if (!fallback) {
    throw new Error(`Global delegation preset "${settings.defaultRosterId}" does not exist.`);
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
      ? `automatic model policy for task type "${behaviorMode}"`
      : `route "${normalizedRequest}"`;
    throw new Error(
      `Delegation ${requestLabel} is not available in preset "${roster.name}" (${roster.rosterId}).`,
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
  const specialists = roster.routes.map((route) => ({
    id: route.routeId,
    label: route.label,
    task: route.behaviorMode ?? "general",
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
    defaults: modeRoutes,
    specialists,
  })}`;
}

export function normalizeDelegationRosterSettings(input: unknown): DelegationRosterSettings {
  if (!isRecord(input)) throw new Error("Delegation preset settings must be an object.");
  if (input.version !== 1) throw new Error("Delegation preset settings version must be 1.");
  const defaultRosterId = normalizeId(input.defaultRosterId, "defaultRosterId", ROSTER_ID_PATTERN);
  if (!Array.isArray(input.rosters) || input.rosters.length === 0) {
    throw new Error("Delegation preset settings must contain at least one preset.");
  }
  if (input.rosters.length > MAX_ROSTERS) {
    throw new Error(`Delegation preset settings may contain at most ${MAX_ROSTERS} presets.`);
  }
  const rosters = input.rosters.map((value, index) => normalizeRoster(value, index));
  assertUnique(rosters.map((roster) => roster.rosterId), "roster id");
  if (!rosters.some((roster) => roster.rosterId === defaultRosterId)) {
    throw new Error(`Default delegation preset "${defaultRosterId}" does not exist.`);
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
  const description = storedDescription && LEGACY_BALANCED_DESCRIPTIONS.has(storedDescription)
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
  const initialRouteIds = routes.map((route) => route.routeId);
  assertUnique(initialRouteIds, `${prefix} route id`);
  const initialRouteIdSet = new Set(initialRouteIds);
  if (!initialRouteIdSet.has(defaultRouteId)) {
    throw new Error(`${prefix}.defaultRouteId references unknown route "${defaultRouteId}".`);
  }
  const modeRoutes = normalizeModeRoutes(input.modeRoutes, prefix, initialRouteIdSet);
  const migrated = migrateBuiltinRosterSpecialists({
    rosterId,
    revision,
    name,
    ...(description ? { description } : {}),
    defaultRouteId,
    ...(Object.keys(modeRoutes).length > 0 ? { modeRoutes } : {}),
    routes,
  });
  const routeIds = migrated.routes.map((route) => route.routeId);
  assertUnique(routeIds, `${prefix} route id`);
  const routeIdSet = new Set(routeIds);
  for (const route of migrated.routes) {
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
  assertNoEscalationCycles(migrated.routes, prefix);
  return migrated;
}

function normalizeRoute(input: unknown, prefix: string): DelegationRoute {
  if (!isRecord(input)) throw new Error(`${prefix} must be an object.`);
  const routeId = normalizeId(input.routeId, `${prefix}.routeId`, ROUTE_ID_PATTERN);
  const storedLabel = normalizeText(input.label, `${prefix}.label`, 80);
  const builtinLabel = BUILTIN_MODEL_POLICY_LABELS[routeId];
  const label = builtinLabel?.previous.includes(storedLabel)
    ? builtinLabel.current
    : storedLabel;
  const storedUseWhen = normalizeText(input.useWhen, `${prefix}.useWhen`, 240);
  const useWhen = builtinLabel?.previousUseWhen.includes(storedUseWhen)
    ? builtinLabel.useWhen
    : storedUseWhen;
  const storedAvoidWhen = normalizeOptionalText(input.avoidWhen, `${prefix}.avoidWhen`, 240);
  const avoidWhen = builtinLabel && (
    storedAvoidWhen === undefined
    || builtinLabel.previousAvoidWhen.includes(storedAvoidWhen)
  )
    ? builtinLabel.avoidWhen
    : storedAvoidWhen;
  const color = normalizeOptionalText(input.color, `${prefix}.color`, 7);
  if (color && !HEX_COLOR_PATTERN.test(color)) {
    throw new Error(`${prefix}.color must be a six-digit hex color.`);
  }
  const availabilityFallback = input.availabilityFallback === undefined
    ? undefined
    : normalizeFallback(input.availabilityFallback, `${prefix}.availabilityFallback`);
  return {
    routeId,
    label,
    ...(input.behaviorMode === undefined
      ? {}
      : {
          behaviorMode: normalizeBehaviorMode(
            input.behaviorMode,
            `${prefix}.behaviorMode`,
          ),
        }),
    useWhen,
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

function migrateBuiltinRosterSpecialists(roster: DelegationRoster): DelegationRoster {
  const modeRoutes = { ...roster.modeRoutes };
  const routeById = new Map(roster.routes.map((route) => [route.routeId, route]));
  const hasBuiltinShape = roster.rosterId === DEFAULT_ROSTER_ID
    && ["quick-scout", "fast-builder", "research-analyst", "independent-critic", "deep-reasoner"]
      .every((routeId) => routeById.has(routeId));

  if (!hasBuiltinShape) {
    return {
      ...roster,
      routes: roster.routes.map((route) => ({
        ...route,
        behaviorMode: route.behaviorMode
          ?? modeForUniquelyAssignedRoute(roster, route.routeId),
      })),
    };
  }

  const routes = roster.routes.map((route) => {
    const builtin = BUILTIN_MODEL_POLICY_LABELS[route.routeId];
    return builtin && route.behaviorMode === undefined
      ? { ...route, behaviorMode: builtin.behaviorMode }
      : route;
  });

  const researchRoute = routes.find((route) => route.routeId === "research-analyst")!;
  if (
    !routeById.has("planner")
    && (modeRoutes.plan === undefined || modeRoutes.plan === researchRoute.routeId)
  ) {
    const researchIndex = routes.findIndex((route) => route.routeId === researchRoute.routeId);
    routes.splice(researchIndex, 0, {
      ...cloneRoute(researchRoute),
      routeId: "planner",
      label: PLANNER_POLICY.current,
      behaviorMode: PLANNER_POLICY.behaviorMode,
      useWhen: PLANNER_POLICY.useWhen,
      avoidWhen: PLANNER_POLICY.avoidWhen,
    });
    modeRoutes.plan = "planner";
  }

  const reviewRoute = routes.find((route) => route.routeId === "independent-critic")!;
  const legacyDesignReviewerIndex = routes.findIndex(
    (route) => route.routeId === "design-reviewer" && isGeneratedDesignReviewer(route, reviewRoute),
  );
  if (legacyDesignReviewerIndex >= 0) {
    routes.splice(legacyDesignReviewerIndex, 1);
  }

  modeRoutes.general ??= "fast-builder";
  modeRoutes.plan ??= "planner";
  modeRoutes["correctness-review"] ??= "independent-critic";
  if (
    modeRoutes["design-review"] === undefined
    || (
      modeRoutes["design-review"] === "design-reviewer"
      && !routes.some((route) => route.routeId === "design-reviewer")
    )
  ) {
    modeRoutes["design-review"] = reviewRoute.routeId;
  }
  modeRoutes.research ??= "research-analyst";

  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index]!;
    if (shouldAdoptBalancedDefaultModelPolicy(route)) {
      routes[index] = applyBalancedDefaultModelPolicy(route);
    }
  }

  const quickBuilder = routes.find((route) => route.routeId === "quick-scout");
  if (
    quickBuilder?.capabilityEscalationRouteId === "research-analyst"
    && isBuiltinRouteWithUnchangedGuidance(quickBuilder, BUILTIN_MODEL_POLICY_LABELS["quick-scout"]!)
  ) {
    quickBuilder.capabilityEscalationRouteId = "fast-builder";
  }

  if (routes.length > MAX_ROUTES) {
    throw new Error(`Delegation preset settings may contain at most ${MAX_ROUTES} specialists.`);
  }
  return { ...roster, modeRoutes, routes };
}

function isGeneratedDesignReviewer(
  candidate: DelegationRoute,
  reviewRoute: DelegationRoute,
): boolean {
  if (candidate.label !== "Design Reviewer" || candidate.behaviorMode !== "design-review") {
    return false;
  }
  const { routeId: _candidateId, label: _candidateLabel, behaviorMode: _candidateMode, ...candidateConfig } = candidate;
  const { routeId: _reviewId, label: _reviewLabel, behaviorMode: _reviewMode, ...reviewConfig } = reviewRoute;
  return JSON.stringify(candidateConfig) === JSON.stringify(reviewConfig);
}

function isBuiltinRouteWithUnchangedGuidance(
  route: DelegationRoute,
  builtin: (typeof BUILTIN_MODEL_POLICY_LABELS)[string],
): boolean {
  return (
    [...builtin.previous, builtin.current].includes(route.label)
    && [...builtin.previousUseWhen, builtin.useWhen].includes(route.useWhen)
    && (
      route.avoidWhen === undefined
      || [...builtin.previousAvoidWhen, builtin.avoidWhen].includes(route.avoidWhen)
    )
  );
}

function shouldAdoptBalancedDefaultModelPolicy(route: DelegationRoute): boolean {
  const policy = BALANCED_DEFAULT_MODEL_POLICIES[route.routeId];
  if (!policy || !routeUsesModelPolicy(route, policy.previous)) return false;
  if (route.routeId === "planner") {
    return route.label === PLANNER_POLICY.current && route.behaviorMode === "plan";
  }
  const builtin = BUILTIN_MODEL_POLICY_LABELS[route.routeId];
  return builtin !== undefined && isBuiltinRouteWithUnchangedGuidance(route, builtin);
}

function applyBalancedDefaultModelPolicy(route: DelegationRoute): DelegationRoute {
  const policy = BALANCED_DEFAULT_MODEL_POLICIES[route.routeId];
  return policy ? { ...route, ...policy.current } : route;
}

function routeUsesModelPolicy(route: DelegationRoute, policy: RouteModelPolicy): boolean {
  return route.provider === policy.provider
    && route.modelId === policy.modelId
    && route.reasoningLevel === policy.reasoningLevel;
}

function modeForUniquelyAssignedRoute(
  roster: DelegationRoster,
  routeId: string,
): DelegationBehaviorMode | undefined {
  const assigned = DELEGATION_BEHAVIOR_MODES.filter(
    (mode) => (roster.modeRoutes?.[mode] ?? roster.defaultRouteId) === routeId,
  );
  return assigned.length === 1 ? assigned[0] : undefined;
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
    routeFromTier(byTier.get("light"), "quick-scout"),
    routeFromTier(byTier.get("fast"), "fast-builder"),
    routeFromTier(byTier.get("standard"), "planner", "plan"),
    routeFromTier(byTier.get("standard"), "research-analyst"),
    routeFromTier(byTier.get("deep"), "independent-critic"),
    routeFromTier(byTier.get("max"), "deep-reasoner"),
  ];
  for (const route of routes) {
    if (route.routeId !== "deep-reasoner") {
      route.capabilityEscalationRouteId = route.routeId === "quick-scout"
        ? "fast-builder"
        : "deep-reasoner";
    }
  }
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
        plan: "planner",
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
  behaviorModeOverride?: DelegationBehaviorMode,
): DelegationRoute {
  if (!tier) throw new Error(`Cannot migrate delegation route "${routeId}" without its tier binding.`);
  const policy = BUILTIN_MODEL_POLICY_LABELS[routeId]
    ?? (routeId === "planner" ? PLANNER_POLICY : undefined);
  if (!policy) throw new Error(`Cannot migrate unknown built-in roster specialist "${routeId}".`);
  const route: DelegationRoute = {
    routeId,
    label: policy.current,
    behaviorMode: behaviorModeOverride ?? policy.behaviorMode,
    useWhen: policy.useWhen,
    avoidWhen: policy.avoidWhen,
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
  return applyBalancedDefaultModelPolicy(route);
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

function normalizeBehaviorMode(value: unknown, field: string): DelegationBehaviorMode {
  if (
    typeof value !== "string"
    || !DELEGATION_BEHAVIOR_MODES.includes(value as DelegationBehaviorMode)
  ) {
    throw new Error(`${field} must be one of ${DELEGATION_BEHAVIOR_MODES.join(", ")}.`);
  }
  return value as DelegationBehaviorMode;
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
