import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OnboardingPreferences, OnboardingState, OnboardingStatus, OnboardingTechnicalLevel } from "@forge/protocol";
import { ONBOARDING_STATUSES, ONBOARDING_TECHNICAL_LEVEL_VALUES } from "@forge/protocol";
import { getCommonKnowledgePath, getSharedKnowledgeDir } from "./data-paths.js";
import { renameWithRetry } from "./retry-rename.js";

export const ONBOARDING_STATE_FILE_NAME = "onboarding-state.json";
export const ONBOARDING_COMMON_BLOCK_START = "<!-- BEGIN MANAGED:ONBOARDING -->";
export const ONBOARDING_COMMON_BLOCK_END = "<!-- END MANAGED:ONBOARDING -->";

export interface SaveOnboardingPreferencesInput {
  preferredName: string;
  technicalLevel: OnboardingTechnicalLevel;
  additionalPreferences?: string | null;
}

export async function loadOnboardingState(dataDir: string): Promise<OnboardingState> {
  const onboardingStatePath = getOnboardingStatePath(dataDir);

  let raw: string | null = null;
  try {
    raw = await readFile(onboardingStatePath, "utf8");
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
  }

  const normalized = normalizeStoredOnboardingState(raw);
  if (raw === null || normalized.shouldPersist) {
    await writeJsonAtomic(onboardingStatePath, normalized.state);
  }

  return normalized.state;
}

export async function getOnboardingSnapshot(dataDir: string): Promise<OnboardingState> {
  return loadOnboardingState(dataDir);
}

export async function saveOnboardingPreferences(
  dataDir: string,
  input: SaveOnboardingPreferencesInput
): Promise<OnboardingState> {
  const preferredName = normalizeOptionalString(input.preferredName);
  if (!preferredName) {
    throw new Error("preferredName is required.");
  }

  if (!ONBOARDING_TECHNICAL_LEVEL_VALUES.includes(input.technicalLevel)) {
    throw new Error("technicalLevel is invalid.");
  }

  const state: OnboardingState = {
    status: "completed",
    completedAt: nowIso(),
    skippedAt: null,
    preferences: {
      preferredName,
      technicalLevel: input.technicalLevel,
      additionalPreferences: normalizeOptionalString(input.additionalPreferences) ?? null
    }
  };

  await writeJsonAtomic(getOnboardingStatePath(dataDir), state);
  return state;
}

export async function skipOnboarding(dataDir: string): Promise<OnboardingState> {
  const currentState = await loadOnboardingState(dataDir);
  const state: OnboardingState = {
    status: "skipped",
    completedAt: currentState.preferences ? currentState.completedAt : null,
    skippedAt: nowIso(),
    preferences: currentState.preferences
  };

  await writeJsonAtomic(getOnboardingStatePath(dataDir), state);
  return state;
}

export async function renderOnboardingCommonKnowledge(
  dataDir: string,
  snapshot: OnboardingState
): Promise<{ path: string; content: string }> {
  const commonKnowledgePath = getCommonKnowledgePath(dataDir);
  const managedBlock = buildManagedOnboardingBlock(snapshot);
  const renderedAt = nowIso();

  let existing = "";
  try {
    existing = await readFile(commonKnowledgePath, "utf8");
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
  }

  const nextContent = ensureTrailingNewline(
    upsertCommonKnowledgeHeader(upsertManagedOnboardingBlock(existing, managedBlock), renderedAt)
  );
  await writeTextAtomic(commonKnowledgePath, nextContent);

  return {
    path: commonKnowledgePath,
    content: nextContent
  };
}

function getOnboardingStatePath(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), ONBOARDING_STATE_FILE_NAME);
}

function normalizeStoredOnboardingState(raw: string | null): { state: OnboardingState; shouldPersist: boolean } {
  if (raw === null) {
    return {
      state: createDefaultOnboardingState(),
      shouldPersist: true
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      state: createDefaultOnboardingState(),
      shouldPersist: true
    };
  }

  if (!isRecord(parsed)) {
    return {
      state: createDefaultOnboardingState(),
      shouldPersist: true
    };
  }

  if (isLegacyOnboardingShape(parsed)) {
    return {
      state: coerceLegacyOnboardingState(parsed),
      shouldPersist: true
    };
  }

  const coerced = coerceSimpleOnboardingState(parsed);
  return {
    state: coerced.state,
    shouldPersist: coerced.wasRepaired
  };
}

function createDefaultOnboardingState(): OnboardingState {
  return {
    status: "pending",
    completedAt: null,
    skippedAt: null,
    preferences: null
  };
}

function coerceSimpleOnboardingState(value: Record<string, unknown>): { state: OnboardingState; wasRepaired: boolean } {
  const status = coerceEnumValue(value.status, ONBOARDING_STATUSES) ?? "pending";
  const preferences = isRecord(value.preferences) ? coercePreferences(value.preferences) : null;
  const completedAt = normalizeOptionalString(value.completedAt) ?? null;
  const skippedAt = normalizeOptionalString(value.skippedAt) ?? null;

  const state: OnboardingState = {
    status,
    completedAt,
    skippedAt,
    preferences
  };

  const wasRepaired =
    value.status !== status ||
    !sameOptionalString(value.completedAt, completedAt) ||
    !sameOptionalString(value.skippedAt, skippedAt) ||
    !samePreferences(value.preferences, preferences);

  return { state, wasRepaired };
}

function coercePreferences(value: Record<string, unknown>): OnboardingPreferences | null {
  const preferredName = normalizeOptionalString(value.preferredName) ?? null;
  const technicalLevel = coerceEnumValue(value.technicalLevel, ONBOARDING_TECHNICAL_LEVEL_VALUES) ?? null;
  const additionalPreferences = normalizeOptionalString(value.additionalPreferences) ?? null;

  if (!preferredName && !technicalLevel && !additionalPreferences) {
    return null;
  }

  return {
    preferredName,
    technicalLevel,
    additionalPreferences
  };
}

function isLegacyOnboardingShape(value: Record<string, unknown>): boolean {
  return "captured" in value || "cycleId" in value || "schemaVersion" in value || "migratedAt" in value;
}

function coerceLegacyOnboardingState(value: Record<string, unknown>): OnboardingState {
  const statusRaw = normalizeOptionalString(value.status) ?? "pending";
  const captured = isRecord(value.captured) ? value.captured : null;
  const preferences = captured ? buildLegacyPreferences(captured) : null;

  let status: OnboardingStatus = "pending";
  if (statusRaw === "completed" || statusRaw === "migrated") {
    status = "completed";
  } else if (statusRaw === "deferred" || statusRaw === "skipped") {
    status = "skipped";
  }

  return {
    status,
    completedAt: normalizeOptionalString(value.completedAt) ?? normalizeOptionalString(value.migratedAt) ?? null,
    skippedAt: normalizeOptionalString(value.deferredAt) ?? null,
    preferences
  };
}

function buildLegacyPreferences(captured: Record<string, unknown>): OnboardingPreferences | null {
  const preferredName = getLegacyFactString(captured.preferredName);
  const technicalLevel = mapLegacyTechnicalLevel(getLegacyFactString(captured.technicalComfort));
  const additionalPreferences = buildLegacyAdditionalPreferences(captured);

  if (!preferredName && !technicalLevel && !additionalPreferences) {
    return null;
  }

  return {
    preferredName: preferredName ?? null,
    technicalLevel,
    additionalPreferences
  };
}

function buildLegacyAdditionalPreferences(captured: Record<string, unknown>): string | null {
  const parts: string[] = [];

  const responseVerbosity = getLegacyFactString(captured.responseVerbosity);
  if (responseVerbosity) {
    parts.push(`Response verbosity: ${humanizeValue(responseVerbosity)}`);
  }

  const explanationDepth = getLegacyFactString(captured.explanationDepth);
  if (explanationDepth) {
    parts.push(`Explanation depth: ${humanizeValue(explanationDepth)}`);
  }

  const updateCadence = getLegacyFactString(captured.updateCadence);
  if (updateCadence) {
    parts.push(`Update cadence: ${humanizeValue(updateCadence)}`);
  }

  const autonomyDefault = getLegacyFactString(captured.autonomyDefault);
  if (autonomyDefault) {
    parts.push(`Autonomy: ${humanizeValue(autonomyDefault)}`);
  }

  const riskEscalationPreference = getLegacyFactString(captured.riskEscalationPreference);
  if (riskEscalationPreference) {
    parts.push(`Risk escalation: ${humanizeValue(riskEscalationPreference)}`);
  }

  const primaryUseCases = getLegacyFactStringArray(captured.primaryUseCases);
  if (primaryUseCases.length > 0) {
    parts.push(`Primary use cases: ${primaryUseCases.join(", ")}`);
  }

  return parts.length > 0 ? parts.join("; ") : null;
}

function getLegacyFactString(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  return normalizeOptionalString(value.value) ?? null;
}

function getLegacyFactStringArray(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.value)) {
    return [];
  }

  return value.value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => typeof entry === "string");
}

function mapLegacyTechnicalLevel(value: string | null): OnboardingTechnicalLevel | null {
  switch (value) {
    case "advanced":
      return "developer";
    case "technical":
      return "technical_non_developer";
    case "mixed":
      return "semi_technical";
    case "non_technical":
      return "non_technical";
    default:
      return null;
  }
}

function buildManagedOnboardingBlock(snapshot: OnboardingState): string {
  const lines = ["## User Snapshot", ONBOARDING_COMMON_BLOCK_START, ...buildManagedOnboardingLines(snapshot), ONBOARDING_COMMON_BLOCK_END];
  return `${lines.join("\n")}\n`;
}

function buildManagedOnboardingLines(snapshot: OnboardingState): string[] {
  const lines = [`- Onboarding status: ${humanizeValue(snapshot.status)}`];
  const preferences = snapshot.preferences;

  if (preferences?.preferredName) {
    lines.push(`- Preferred name: ${preferences.preferredName}`);
  }

  if (preferences?.technicalLevel) {
    lines.push(`- Technical level: ${humanizeTechnicalLevel(preferences.technicalLevel)}`);
  }

  if (preferences?.additionalPreferences) {
    lines.push(`- Additional preferences: ${preferences.additionalPreferences}`);
  }

  return lines;
}

function humanizeTechnicalLevel(value: OnboardingTechnicalLevel): string {
  switch (value) {
    case "developer":
      return "Developer";
    case "technical_non_developer":
      return "Technical (non-developer)";
    case "semi_technical":
      return "Semi-technical";
    case "non_technical":
      return "Non-technical";
  }
}

function humanizeValue(value: string): string {
  return value.replace(/_/g, " ");
}

function upsertManagedOnboardingBlock(existing: string, block: string): string {
  const normalizedExisting = existing.replace(/\r\n/g, "\n");
  const startIndex = normalizedExisting.indexOf(ONBOARDING_COMMON_BLOCK_START);
  const endIndex = normalizedExisting.indexOf(ONBOARDING_COMMON_BLOCK_END);

  if (startIndex >= 0 && endIndex >= 0 && endIndex > startIndex) {
    const blockStart = normalizedExisting.lastIndexOf("## User Snapshot", startIndex);
    const replaceStart = blockStart >= 0 ? blockStart : startIndex;
    const replaceEnd = endIndex + ONBOARDING_COMMON_BLOCK_END.length;
    return `${normalizedExisting.slice(0, replaceStart).replace(/\n*$/, "\n\n")}${block}${normalizedExisting.slice(replaceEnd).replace(/^\n*/, "\n")}`.trimEnd();
  }

  if (!normalizedExisting.trim()) {
    return `# Common Knowledge\n\n${block}`.trimEnd();
  }

  const interactionDefaultsIndex = normalizedExisting.indexOf("\n## Interaction Defaults");
  if (interactionDefaultsIndex >= 0) {
    return `${normalizedExisting.slice(0, interactionDefaultsIndex).replace(/\n*$/, "\n\n")}${block}${normalizedExisting.slice(interactionDefaultsIndex).replace(/^\n*/, "\n")}`.trimEnd();
  }

  return `${normalizedExisting.trimEnd()}\n\n${block}`.trimEnd();
}

function upsertCommonKnowledgeHeader(content: string, renderedAt: string): string {
  const normalizedContent = content.replace(/\r\n/g, "\n").trimEnd();
  const headerLine = `<!-- Maintained by Cortex. Last updated: ${renderedAt} -->`;
  const headerPattern = /^# Common Knowledge(?:\n<!-- Maintained by Cortex\.(?: Last updated: .*?)? -->)?/;

  if (!normalizedContent) {
    return `# Common Knowledge\n${headerLine}`;
  }

  if (headerPattern.test(normalizedContent)) {
    return normalizedContent.replace(headerPattern, `# Common Knowledge\n${headerLine}`);
  }

  return `# Common Knowledge\n${headerLine}\n\n${normalizedContent}`;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

async function writeJsonAtomic(path: string, payload: unknown): Promise<void> {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await renameWithRetry(tmpPath, path, { retries: 8, baseDelayMs: 15 });
}

async function writeTextAtomic(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmpPath, content, "utf8");
  await renameWithRetry(tmpPath, path, { retries: 8, baseDelayMs: 15 });
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sameOptionalString(raw: unknown, normalized: string | null): boolean {
  return (normalizeOptionalString(raw) ?? null) === normalized;
}

function samePreferences(raw: unknown, normalized: OnboardingPreferences | null): boolean {
  if (!isRecord(raw)) {
    return normalized === null;
  }

  const rawPreferredName = normalizeOptionalString(raw.preferredName) ?? null;
  const rawTechnicalLevel = coerceEnumValue(raw.technicalLevel, ONBOARDING_TECHNICAL_LEVEL_VALUES) ?? null;
  const rawAdditionalPreferences = normalizeOptionalString(raw.additionalPreferences) ?? null;

  if (normalized === null) {
    return !rawPreferredName && !rawTechnicalLevel && !rawAdditionalPreferences;
  }

  return (
    rawPreferredName === normalized.preferredName &&
    rawTechnicalLevel === normalized.technicalLevel &&
    rawAdditionalPreferences === normalized.additionalPreferences
  );
}

function coerceEnumValue<T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  return typeof value === "string" && allowed.includes(value) ? (value as T[number]) : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoentError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
