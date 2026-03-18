import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  OnboardingAutonomyDefault,
  OnboardingCaptured,
  OnboardingExplanationDepth,
  OnboardingFact,
  OnboardingFactStatus,
  OnboardingResponseVerbosity,
  OnboardingRiskEscalationPreference,
  OnboardingState,
  OnboardingStatus,
  OnboardingTechnicalComfort,
  OnboardingUpdateCadence
} from "@forge/protocol";
import {
  ONBOARDING_AUTONOMY_DEFAULT_VALUES,
  ONBOARDING_EXPLANATION_DEPTH_VALUES,
  ONBOARDING_FACT_STATUSES,
  ONBOARDING_RESPONSE_VERBOSITY_VALUES,
  ONBOARDING_RISK_ESCALATION_PREFERENCE_VALUES,
  ONBOARDING_STATUSES,
  ONBOARDING_TECHNICAL_COMFORT_VALUES,
  ONBOARDING_UPDATE_CADENCE_VALUES
} from "@forge/protocol";
import { getCommonKnowledgePath, getProfileMemoryPath, getProfilesDir, getSessionFilePath, getSharedKnowledgeDir } from "./data-paths.js";
import { renameWithRetry } from "./retry-rename.js";

const ONBOARDING_SCHEMA_VERSION = 2;
const ONBOARDING_OWNER_ID = "primary";
const ONBOARDING_SOURCE_SESSION_ID = "cortex";
export const ONBOARDING_STATE_FILE_NAME = "onboarding-state.json";
export const ONBOARDING_COMMON_BLOCK_START = "<!-- BEGIN MANAGED:ONBOARDING -->";
export const ONBOARDING_COMMON_BLOCK_END = "<!-- END MANAGED:ONBOARDING -->";

type OnboardingFactPatch<T> = Pick<OnboardingFact<T>, "value" | "status"> & {
  updatedAt?: string | null;
};

export interface OnboardingFactsPatch {
  preferredName?: OnboardingFactPatch<string>;
  technicalComfort?: OnboardingFactPatch<OnboardingTechnicalComfort>;
  responseVerbosity?: OnboardingFactPatch<OnboardingResponseVerbosity>;
  explanationDepth?: OnboardingFactPatch<OnboardingExplanationDepth>;
  updateCadence?: OnboardingFactPatch<OnboardingUpdateCadence>;
  autonomyDefault?: OnboardingFactPatch<OnboardingAutonomyDefault>;
  riskEscalationPreference?: OnboardingFactPatch<OnboardingRiskEscalationPreference>;
  primaryUseCases?: OnboardingFactPatch<string[]>;
}

export type OnboardingMutationResult =
  | {
      ok: true;
      snapshot: OnboardingState;
    }
  | {
      ok: false;
      reason: "stale_revision" | "stale_cycle";
      snapshot: OnboardingState;
    };

export interface OnboardingMigrationDetectionResult {
  migrated: boolean;
  reason: string | null;
}

export async function loadOnboardingState(dataDir: string): Promise<OnboardingState> {
  const onboardingStatePath = getOnboardingStatePath(dataDir);
  const now = nowIso();

  let raw: string | null = null;
  try {
    raw = await readFile(onboardingStatePath, "utf8");
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
  }

  if (raw === null) {
    const migration = await detectOnboardingMigration(dataDir);
    const initialState = createDefaultOnboardingState(now, {
      status: migration.migrated ? "migrated" : "not_started",
      migratedAt: migration.migrated ? now : null,
      migrationReason: migration.reason,
      lastUpdatedAt: migration.migrated ? now : null
    });
    await writeJsonAtomic(onboardingStatePath, initialState);
    return initialState;
  }

  const state = coerceOnboardingState(raw);
  const migration = await detectOnboardingMigration(dataDir);
  if (!migration.migrated || state.status !== "not_started") {
    return state;
  }

  const migratedState: OnboardingState = {
    ...state,
    status: "migrated",
    revision: state.revision + 1,
    migratedAt: state.migratedAt ?? now,
    migrationReason: migration.reason,
    lastUpdatedAt: now
  };
  await writeJsonAtomic(onboardingStatePath, migratedState);
  return migratedState;
}

export async function getOnboardingSnapshot(dataDir: string): Promise<OnboardingState> {
  return loadOnboardingState(dataDir);
}

export async function activateOnboardingForEligibleTurn(dataDir: string): Promise<OnboardingState> {
  const current = await loadOnboardingState(dataDir);

  if (current.status !== "not_started" && current.status !== "active") {
    return current;
  }

  if (current.status === "active") {
    return current;
  }

  const now = nowIso();
  const next: OnboardingState = {
    ...cloneOnboardingState(current),
    status: "active",
    startedAt: current.startedAt ?? now,
    lastUpdatedAt: now,
    revision: current.revision + 1
  };

  await writeJsonAtomic(getOnboardingStatePath(dataDir), next);
  return next;
}

export async function markOnboardingFirstPromptSent(dataDir: string): Promise<OnboardingState> {
  for (;;) {
    const current = await loadOnboardingState(dataDir);

    if (current.status !== "not_started" && current.status !== "active") {
      return current;
    }

    if (current.firstPromptSentAt) {
      return current;
    }

    const result = await mutateOnboardingState(dataDir, current.cycleId, current.revision, (state, now) => ({
      ...state,
      status: "active",
      firstPromptSentAt: state.firstPromptSentAt ?? now,
      startedAt: state.startedAt ?? now
    }));

    if (result.ok) {
      return result.snapshot;
    }
  }
}

export async function saveOnboardingFacts(
  dataDir: string,
  patch: OnboardingFactsPatch,
  cycleId: string,
  baseRevision: number
): Promise<OnboardingMutationResult> {
  return mutateOnboardingState(dataDir, cycleId, baseRevision, (current, now) => {
    const captured: OnboardingCaptured = {
      ...current.captured,
      preferredName: cloneFact(current.captured.preferredName),
      technicalComfort: cloneFact(current.captured.technicalComfort),
      responseVerbosity: cloneFact(current.captured.responseVerbosity),
      explanationDepth: cloneFact(current.captured.explanationDepth),
      updateCadence: cloneFact(current.captured.updateCadence),
      autonomyDefault: cloneFact(current.captured.autonomyDefault),
      riskEscalationPreference: cloneFact(current.captured.riskEscalationPreference),
      primaryUseCases: cloneFact(current.captured.primaryUseCases)
    };

    if (patch.preferredName) {
      captured.preferredName = {
        value: cloneFactValue(patch.preferredName.value),
        status: patch.preferredName.status,
        updatedAt: patch.preferredName.updatedAt ?? now
      };
    }

    if (patch.technicalComfort) {
      captured.technicalComfort = {
        value: cloneFactValue(patch.technicalComfort.value),
        status: patch.technicalComfort.status,
        updatedAt: patch.technicalComfort.updatedAt ?? now
      };
    }

    if (patch.responseVerbosity) {
      captured.responseVerbosity = {
        value: cloneFactValue(patch.responseVerbosity.value),
        status: patch.responseVerbosity.status,
        updatedAt: patch.responseVerbosity.updatedAt ?? now
      };
    }

    if (patch.explanationDepth) {
      captured.explanationDepth = {
        value: cloneFactValue(patch.explanationDepth.value),
        status: patch.explanationDepth.status,
        updatedAt: patch.explanationDepth.updatedAt ?? now
      };
    }

    if (patch.updateCadence) {
      captured.updateCadence = {
        value: cloneFactValue(patch.updateCadence.value),
        status: patch.updateCadence.status,
        updatedAt: patch.updateCadence.updatedAt ?? now
      };
    }

    if (patch.autonomyDefault) {
      captured.autonomyDefault = {
        value: cloneFactValue(patch.autonomyDefault.value),
        status: patch.autonomyDefault.status,
        updatedAt: patch.autonomyDefault.updatedAt ?? now
      };
    }

    if (patch.riskEscalationPreference) {
      captured.riskEscalationPreference = {
        value: cloneFactValue(patch.riskEscalationPreference.value),
        status: patch.riskEscalationPreference.status,
        updatedAt: patch.riskEscalationPreference.updatedAt ?? now
      };
    }

    if (patch.primaryUseCases) {
      captured.primaryUseCases = {
        value: cloneFactValue(patch.primaryUseCases.value),
        status: patch.primaryUseCases.status,
        updatedAt: patch.primaryUseCases.updatedAt ?? now
      };
    }

    const nextStatus = current.status === "not_started" ? "active" : current.status;

    return {
      ...current,
      captured,
      status: nextStatus,
      startedAt: nextStatus === "active" ? current.startedAt ?? now : current.startedAt
    };
  });
}

export async function setOnboardingStatus(
  dataDir: string,
  status: OnboardingStatus,
  reason: string | null,
  cycleId: string,
  baseRevision: number
): Promise<OnboardingMutationResult> {
  return mutateOnboardingState(dataDir, cycleId, baseRevision, (current, now) => {
    const normalizedReason = normalizeOptionalString(reason) ?? null;

    return {
      ...current,
      status,
      startedAt: status === "active" ? current.startedAt ?? now : current.startedAt,
      completedAt: status === "completed" ? now : current.completedAt,
      deferredAt: status === "deferred" ? now : current.deferredAt,
      migratedAt: status === "migrated" ? now : current.migratedAt,
      migrationReason: status === "migrated" ? normalizedReason : current.migrationReason
    };
  });
}

export async function renderOnboardingCommonKnowledge(
  dataDir: string,
  snapshot: OnboardingState
): Promise<{ path: string; content: string }> {
  const commonKnowledgePath = getCommonKnowledgePath(dataDir);
  const managedBlock = buildManagedOnboardingBlock(snapshot);

  let existing = "";
  try {
    existing = await readFile(commonKnowledgePath, "utf8");
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
  }

  const nextContent = upsertManagedOnboardingBlock(existing, managedBlock);
  await writeTextAtomic(commonKnowledgePath, ensureTrailingNewline(nextContent));

  return {
    path: commonKnowledgePath,
    content: ensureTrailingNewline(nextContent)
  };
}

export async function detectOnboardingMigration(dataDir: string): Promise<OnboardingMigrationDetectionResult> {
  const reasons: string[] = [];

  if (await hasNonCortexProfiles(dataDir)) {
    reasons.push("existing non-Cortex profiles detected");
  }

  if (await hasMeaningfulSessionHistory(dataDir)) {
    reasons.push("existing session history detected");
  }

  if (await hasMeaningfulCommonKnowledge(dataDir)) {
    reasons.push("existing common knowledge content detected");
  }

  return {
    migrated: reasons.length > 0,
    reason: reasons.length > 0 ? reasons.join("; ") : null
  };
}

function getOnboardingStatePath(dataDir: string): string {
  return join(getSharedKnowledgeDir(dataDir), ONBOARDING_STATE_FILE_NAME);
}

async function mutateOnboardingState(
  dataDir: string,
  cycleId: string,
  baseRevision: number,
  mutator: (state: OnboardingState, now: string) => OnboardingState
): Promise<OnboardingMutationResult> {
  const current = await loadOnboardingState(dataDir);

  if (current.cycleId !== cycleId) {
    return {
      ok: false,
      reason: "stale_cycle",
      snapshot: current
    };
  }

  if (current.revision !== baseRevision) {
    return {
      ok: false,
      reason: "stale_revision",
      snapshot: current
    };
  }

  const now = nowIso();
  const next = mutator(cloneOnboardingState(current), now);
  next.revision = current.revision + 1;
  next.lastUpdatedAt = now;

  await writeJsonAtomic(getOnboardingStatePath(dataDir), next);

  return {
    ok: true,
    snapshot: next
  };
}

function createDefaultOnboardingState(
  now: string,
  overrides?: Partial<Pick<OnboardingState, "status" | "migratedAt" | "migrationReason" | "lastUpdatedAt">>
): OnboardingState {
  return {
    schemaVersion: ONBOARDING_SCHEMA_VERSION,
    owner: {
      ownerId: ONBOARDING_OWNER_ID,
      authUserId: null,
      displayName: null
    },
    status: overrides?.status ?? "not_started",
    cycleId: createCycleId(),
    revision: 0,
    firstPromptSentAt: null,
    startedAt: null,
    completedAt: null,
    deferredAt: null,
    migratedAt: overrides?.migratedAt ?? null,
    lastUpdatedAt: overrides?.lastUpdatedAt ?? null,
    sourceSessionId: ONBOARDING_SOURCE_SESSION_ID,
    firstManagerCreatedAt: null,
    migrationReason: overrides?.migrationReason ?? null,
    captured: createEmptyCaptured(),
    renderState: {
      lastRenderedAt: null,
      lastRenderedRevision: 0
    }
  };
}

function createEmptyCaptured(): OnboardingCaptured {
  return {
    preferredName: createEmptyFact<string>(null),
    technicalComfort: createEmptyFact<OnboardingTechnicalComfort>(null),
    responseVerbosity: createEmptyFact<OnboardingResponseVerbosity>(null),
    explanationDepth: createEmptyFact<OnboardingExplanationDepth>(null),
    updateCadence: createEmptyFact<OnboardingUpdateCadence>(null),
    autonomyDefault: createEmptyFact<OnboardingAutonomyDefault>(null),
    riskEscalationPreference: createEmptyFact<OnboardingRiskEscalationPreference>(null),
    primaryUseCases: createEmptyFact<string[]>([])
  };
}

function createEmptyFact<T>(value: T | null): OnboardingFact<T> {
  return {
    value,
    status: "unknown",
    updatedAt: null
  };
}

function buildManagedOnboardingBlock(snapshot: OnboardingState): string {
  const lines = ["## User Snapshot", ONBOARDING_COMMON_BLOCK_START, ...buildManagedOnboardingLines(snapshot), ONBOARDING_COMMON_BLOCK_END];
  return `${lines.join("\n")}\n`;
}

function buildManagedOnboardingLines(snapshot: OnboardingState): string[] {
  const lines = [`- Onboarding status: ${humanizeValue(snapshot.status)}`];

  if (snapshot.status === "migrated" && snapshot.migrationReason) {
    lines.push(`- Migration reason: ${snapshot.migrationReason}`);
  }

  appendFactLine(lines, "Preferred name", snapshot.captured.preferredName.value, snapshot.captured.preferredName.status);
  appendFactLine(lines, "Technical comfort", snapshot.captured.technicalComfort.value, snapshot.captured.technicalComfort.status);
  appendFactLine(lines, "Response verbosity", snapshot.captured.responseVerbosity.value, snapshot.captured.responseVerbosity.status);
  appendFactLine(lines, "Explanation depth", snapshot.captured.explanationDepth.value, snapshot.captured.explanationDepth.status);
  appendFactLine(lines, "Update cadence", snapshot.captured.updateCadence.value, snapshot.captured.updateCadence.status);
  appendFactLine(lines, "Autonomy default", snapshot.captured.autonomyDefault.value, snapshot.captured.autonomyDefault.status);
  appendFactLine(
    lines,
    "Risk escalation preference",
    snapshot.captured.riskEscalationPreference.value,
    snapshot.captured.riskEscalationPreference.status
  );

  const primaryUseCases = snapshot.captured.primaryUseCases.value ?? [];
  if (primaryUseCases.length > 0) {
    lines.push(
      `- Primary use cases (${humanizeValue(snapshot.captured.primaryUseCases.status)}): ${primaryUseCases.join(", ")}`
    );
  }

  return lines;
}

function appendFactLine(lines: string[], label: string, value: unknown, status: OnboardingFactStatus): void {
  if (value === null || value === undefined) {
    return;
  }

  if (typeof value === "string" && value.trim().length === 0) {
    return;
  }

  lines.push(`- ${label} (${humanizeValue(status)}): ${humanizeFactValue(value)}`);
}

function humanizeFactValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join(", ");
  }

  return humanizeValue(String(value));
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

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function cloneOnboardingState(state: OnboardingState): OnboardingState {
  return {
    ...state,
    owner: { ...state.owner },
    captured: {
      preferredName: cloneFact(state.captured.preferredName),
      technicalComfort: cloneFact(state.captured.technicalComfort),
      responseVerbosity: cloneFact(state.captured.responseVerbosity),
      explanationDepth: cloneFact(state.captured.explanationDepth),
      updateCadence: cloneFact(state.captured.updateCadence),
      autonomyDefault: cloneFact(state.captured.autonomyDefault),
      riskEscalationPreference: cloneFact(state.captured.riskEscalationPreference),
      primaryUseCases: cloneFact(state.captured.primaryUseCases)
    },
    renderState: { ...state.renderState }
  };
}

function cloneFact<T>(fact: OnboardingFact<T>): OnboardingFact<T> {
  return {
    value: cloneFactValue(fact.value),
    status: fact.status,
    updatedAt: fact.updatedAt
  };
}

function cloneFactValue<T>(value: T | null): T | null {
  if (Array.isArray(value)) {
    return [...value] as T;
  }

  return value;
}

function coerceOnboardingState(raw: string): OnboardingState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createDefaultOnboardingState(nowIso());
  }

  if (!isRecord(parsed)) {
    return createDefaultOnboardingState(nowIso());
  }

  const fallback = createDefaultOnboardingState(nowIso());

  return {
    schemaVersion: normalizePositiveInteger(parsed.schemaVersion) ?? ONBOARDING_SCHEMA_VERSION,
    owner: isRecord(parsed.owner)
      ? {
          ownerId: normalizeOptionalString(parsed.owner.ownerId) ?? fallback.owner.ownerId,
          authUserId: normalizeOptionalString(parsed.owner.authUserId) ?? null,
          displayName: normalizeOptionalString(parsed.owner.displayName) ?? null
        }
      : fallback.owner,
    status: coerceEnumValue(parsed.status, ONBOARDING_STATUSES) ?? fallback.status,
    cycleId: normalizeOptionalString(parsed.cycleId) ?? fallback.cycleId,
    revision: normalizePositiveInteger(parsed.revision) ?? 0,
    firstPromptSentAt: normalizeOptionalString(parsed.firstPromptSentAt) ?? null,
    startedAt: normalizeOptionalString(parsed.startedAt) ?? null,
    completedAt: normalizeOptionalString(parsed.completedAt) ?? null,
    deferredAt: normalizeOptionalString(parsed.deferredAt) ?? null,
    migratedAt: normalizeOptionalString(parsed.migratedAt) ?? null,
    lastUpdatedAt: normalizeOptionalString(parsed.lastUpdatedAt) ?? null,
    sourceSessionId: normalizeOptionalString(parsed.sourceSessionId) ?? ONBOARDING_SOURCE_SESSION_ID,
    firstManagerCreatedAt: normalizeOptionalString(parsed.firstManagerCreatedAt) ?? null,
    migrationReason: normalizeOptionalString(parsed.migrationReason) ?? null,
    captured: coerceCaptured(parsed.captured, fallback.captured),
    renderState: isRecord(parsed.renderState)
      ? {
          lastRenderedAt: normalizeOptionalString(parsed.renderState.lastRenderedAt) ?? null,
          lastRenderedRevision: normalizePositiveInteger(parsed.renderState.lastRenderedRevision) ?? 0
        }
      : fallback.renderState
  };
}

function coerceCaptured(value: unknown, fallback: OnboardingCaptured): OnboardingCaptured {
  if (!isRecord(value)) {
    return fallback;
  }

  return {
    preferredName: coerceFact(value.preferredName, fallback.preferredName),
    technicalComfort: coerceFact(
      value.technicalComfort,
      fallback.technicalComfort,
      (candidate) => coerceEnumValue(candidate, ONBOARDING_TECHNICAL_COMFORT_VALUES) ?? null
    ),
    responseVerbosity: coerceFact(
      value.responseVerbosity,
      fallback.responseVerbosity,
      (candidate) => coerceEnumValue(candidate, ONBOARDING_RESPONSE_VERBOSITY_VALUES) ?? null
    ),
    explanationDepth: coerceFact(
      value.explanationDepth,
      fallback.explanationDepth,
      (candidate) => coerceEnumValue(candidate, ONBOARDING_EXPLANATION_DEPTH_VALUES) ?? null
    ),
    updateCadence: coerceFact(
      value.updateCadence,
      fallback.updateCadence,
      (candidate) => coerceEnumValue(candidate, ONBOARDING_UPDATE_CADENCE_VALUES) ?? null
    ),
    autonomyDefault: coerceFact(
      value.autonomyDefault,
      fallback.autonomyDefault,
      (candidate) => coerceEnumValue(candidate, ONBOARDING_AUTONOMY_DEFAULT_VALUES) ?? null
    ),
    riskEscalationPreference: coerceFact(
      value.riskEscalationPreference,
      fallback.riskEscalationPreference,
      (candidate) => coerceEnumValue(candidate, ONBOARDING_RISK_ESCALATION_PREFERENCE_VALUES) ?? null
    ),
    primaryUseCases: coerceFact(value.primaryUseCases, fallback.primaryUseCases, coerceStringArray)
  };
}

function coerceFact<T>(
  value: unknown,
  fallback: OnboardingFact<T>,
  coerceValue: (candidate: unknown) => T | null = (candidate) => normalizeOptionalString(candidate) as T | null
): OnboardingFact<T> {
  if (!isRecord(value)) {
    return cloneFact(fallback);
  }

  const factValue = coerceValue(value.value);
  return {
    value: factValue === null && Array.isArray(fallback.value) ? cloneFactValue(fallback.value) : factValue,
    status: coerceEnumValue(value.status, ONBOARDING_FACT_STATUSES) ?? fallback.status,
    updatedAt: normalizeOptionalString(value.updatedAt) ?? null
  };
}

async function hasNonCortexProfiles(dataDir: string): Promise<boolean> {
  const profilesDir = getProfilesDir(dataDir);

  let entries;
  try {
    entries = await readdir(profilesDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoentError(error)) {
      return false;
    }

    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ONBOARDING_SOURCE_SESSION_ID) {
      continue;
    }

    if (await hasMeaningfulProfileContent(dataDir, entry.name)) {
      return true;
    }
  }

  return false;
}

async function hasMeaningfulProfileContent(dataDir: string, profileId: string): Promise<boolean> {
  if (await hasMeaningfulFileContent(getProfileMemoryPath(dataDir, profileId))) {
    return true;
  }

  const sessionsDir = join(getProfilesDir(dataDir), profileId, "sessions");
  let sessionEntries;
  try {
    sessionEntries = await readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoentError(error)) {
      return false;
    }

    throw error;
  }

  for (const sessionEntry of sessionEntries) {
    if (!sessionEntry.isDirectory()) {
      continue;
    }

    const sessionFilePath = getSessionFilePath(dataDir, profileId, sessionEntry.name);
    if (await hasMeaningfulFileContent(sessionFilePath)) {
      return true;
    }
  }

  return false;
}

async function hasMeaningfulSessionHistory(dataDir: string): Promise<boolean> {
  const profilesDir = getProfilesDir(dataDir);

  let profileEntries;
  try {
    profileEntries = await readdir(profilesDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoentError(error)) {
      return false;
    }

    throw error;
  }

  for (const profileEntry of profileEntries) {
    if (!profileEntry.isDirectory()) {
      continue;
    }

    const sessionsDir = join(profilesDir, profileEntry.name, "sessions");
    let sessionEntries;
    try {
      sessionEntries = await readdir(sessionsDir, { withFileTypes: true });
    } catch (error) {
      if (isEnoentError(error)) {
        continue;
      }

      throw error;
    }

    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) {
        continue;
      }

      if (
        profileEntry.name === ONBOARDING_SOURCE_SESSION_ID &&
        sessionEntry.name === ONBOARDING_SOURCE_SESSION_ID
      ) {
        continue;
      }

      const sessionFilePath = getSessionFilePath(dataDir, profileEntry.name, sessionEntry.name);
      if (!(await hasMeaningfulFileContent(sessionFilePath))) {
        continue;
      }

      return true;
    }
  }

  return false;
}

async function hasMeaningfulCommonKnowledge(dataDir: string): Promise<boolean> {
  const commonKnowledgePath = getCommonKnowledgePath(dataDir);
  let raw: string;

  try {
    raw = await readFile(commonKnowledgePath, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return false;
    }

    throw error;
  }

  const strippedManaged = raw.replace(
    new RegExp(`${escapeRegExp(ONBOARDING_COMMON_BLOCK_START)}[\\s\\S]*?${escapeRegExp(ONBOARDING_COMMON_BLOCK_END)}\\n?`, "g"),
    ""
  );
  const meaningful = strippedManaged
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => line !== "# Common Knowledge")
    .filter((line) => !line.startsWith("<!-- Maintained by Cortex."))
    .filter((line) => line !== "## User Snapshot")
    .filter((line) => line !== "## Interaction Defaults")
    .filter((line) => line !== "## Workflow Defaults")
    .filter((line) => line !== "## Cross-Project Technical Standards")
    .filter((line) => line !== "## Cross-Project Gotchas");

  return meaningful.length > 0;
}

async function hasMeaningfulFileContent(path: string): Promise<boolean> {
  try {
    const fileStats = await stat(path);
    if (fileStats.size === 0) {
      return false;
    }

    const raw = await readFile(path, "utf8");
    return raw.trim().length > 0;
  } catch (error) {
    if (isEnoentError(error)) {
      return false;
    }

    throw error;
  }
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

function coerceStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => typeof entry === "string");
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : undefined;
}

function coerceEnumValue<T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  return typeof value === "string" && allowed.includes(value) ? (value as T[number]) : undefined;
}

function createCycleId(): string {
  return `onb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
