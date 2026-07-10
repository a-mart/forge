import type { KnowledgeV2Settings } from "@forge/protocol";
import type {
  KnowledgeEntryScope,
  KnowledgeEntryType,
  KnowledgeIndexResult,
} from "./knowledge-service.js";

export const KNOWLEDGE_V2_MIGRATION_MANIFEST_VERSION = 2;
export const KNOWLEDGE_V2_MIGRATION_CLASSIFIER = "offline-heuristic-v1";

export interface KnowledgeV2MigrationFileSummary {
  relativePath: string;
  scope: KnowledgeEntryScope;
  candidates: number;
  entries: number;
  discards: number;
  pointers: number;
}

interface KnowledgeV2MigrationManifestCommon {
  migrationId: string;
  startedAt: string;
  completedAt: string;
  classifier: typeof KNOWLEDGE_V2_MIGRATION_CLASSIFIER;
  force: boolean;
  preMigrationVersioningSha: string | null;
  settingsBefore: KnowledgeV2Settings;
  files: KnowledgeV2MigrationFileSummary[];
  legacyBackups: Array<{ relativePath: string; backupPath: string; sha256: string }>;
  entries: Array<{ id: string; scope: KnowledgeEntryScope; type: KnowledgeEntryType; sourcePath: string }>;
  discards: Array<{ sourcePath: string; text: string; reason: string }>;
  indexResults: KnowledgeIndexResult[];
}

/** New truthful writer schema. */
export interface KnowledgeV2MigrationManifest extends KnowledgeV2MigrationManifestCommon {
  version: 2;
  activation: { targetEnabled: true; state: "authorized_pending" };
}

/** Exact schema written by the already-shipped v1 migration implementation. */
export interface LegacyKnowledgeV2MigrationManifest extends KnowledgeV2MigrationManifestCommon {
  version: 1;
  settingsAfter: KnowledgeV2Settings;
}

/** Canonical normalized representation consumed by activation and rollback. */
export interface ParsedKnowledgeV2MigrationManifest extends KnowledgeV2MigrationManifestCommon {
  sourceVersion: 1 | 2;
  activation: { targetEnabled: true; state: "authorized_pending" };
}

export function parseKnowledgeV2MigrationManifest(value: unknown): ParsedKnowledgeV2MigrationManifest | null {
  if (!isRecord(value) || !hasValidCommonManifestFields(value)) return null;
  if (value.version === 1) {
    if (!isSettings(value.settingsAfter) || value.settingsAfter.enabled !== true) return null;
  } else if (value.version === 2) {
    if (!isRecord(value.activation) ||
      value.activation.targetEnabled !== true || value.activation.state !== "authorized_pending") return null;
  } else {
    return null;
  }

  return {
    sourceVersion: value.version,
    migrationId: value.migrationId as string,
    startedAt: value.startedAt as string,
    completedAt: value.completedAt as string,
    classifier: KNOWLEDGE_V2_MIGRATION_CLASSIFIER,
    force: value.force as boolean,
    preMigrationVersioningSha: value.preMigrationVersioningSha as string | null,
    settingsBefore: value.settingsBefore as KnowledgeV2Settings,
    activation: { targetEnabled: true, state: "authorized_pending" },
    files: value.files as KnowledgeV2MigrationFileSummary[],
    legacyBackups: value.legacyBackups as ParsedKnowledgeV2MigrationManifest["legacyBackups"],
    entries: value.entries as ParsedKnowledgeV2MigrationManifest["entries"],
    discards: value.discards as ParsedKnowledgeV2MigrationManifest["discards"],
    indexResults: value.indexResults as KnowledgeIndexResult[],
  };
}

function hasValidCommonManifestFields(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value.migrationId) &&
    value.classifier === KNOWLEDGE_V2_MIGRATION_CLASSIFIER &&
    typeof value.force === "boolean" &&
    (value.preMigrationVersioningSha === null || isNonEmptyString(value.preMigrationVersioningSha)) &&
    isStrictIsoTimestamp(value.startedAt) &&
    isStrictIsoTimestamp(value.completedAt) &&
    Date.parse(value.completedAt) >= Date.parse(value.startedAt) &&
    isSettings(value.settingsBefore) &&
    isArrayOf(value.files, isFileSummary) &&
    isArrayOf(value.legacyBackups, isLegacyBackup) &&
    isArrayOf(value.entries, isEntrySummary) &&
    isArrayOf(value.discards, isDiscard) &&
    isArrayOf(value.indexResults, isIndexResult);
}

function isSettings(value: unknown): value is KnowledgeV2Settings {
  return isRecord(value) &&
    typeof value.enabled === "boolean" &&
    typeof value.legacyCleanupConfirmed === "boolean" &&
    isRecord(value.indexCaps) &&
    isPositiveInteger(value.indexCaps.global) &&
    isPositiveInteger(value.indexCaps.profile) &&
    (value.updatedAt === null || isStrictIsoTimestamp(value.updatedAt));
}

function isFileSummary(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.relativePath) && isScope(value.scope) &&
    isNonNegativeInteger(value.candidates) && isNonNegativeInteger(value.entries) &&
    isNonNegativeInteger(value.discards) && isNonNegativeInteger(value.pointers);
}

function isLegacyBackup(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.relativePath) && isNonEmptyString(value.backupPath) &&
    typeof value.sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.sha256);
}

function isEntrySummary(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.id) && isScope(value.scope) &&
    isEntryType(value.type) && isNonEmptyString(value.sourcePath);
}

function isDiscard(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.sourcePath) && typeof value.text === "string" &&
    isNonEmptyString(value.reason);
}

function isIndexResult(value: unknown): boolean {
  return isRecord(value) && isScope(value.scope) && isNonEmptyString(value.path) &&
    isPositiveInteger(value.tokenCap) && isNonNegativeInteger(value.tokenEstimate) &&
    isArrayOf(value.indexedEntryIds, isNonEmptyString) && isArrayOf(value.demotedEntryIds, isNonEmptyString);
}

function isScope(value: unknown): value is KnowledgeEntryScope {
  return value === "global" || (typeof value === "string" && /^profile:.+/u.test(value));
}

function isEntryType(value: unknown): value is KnowledgeEntryType {
  return value === "preference" || value === "convention" || value === "gotcha" || value === "pointer";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isStrictIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function isArrayOf<T>(value: unknown, predicate: (item: unknown) => item is T): value is T[];
function isArrayOf(value: unknown, predicate: (item: unknown) => boolean): boolean;
function isArrayOf(value: unknown, predicate: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(predicate);
}
