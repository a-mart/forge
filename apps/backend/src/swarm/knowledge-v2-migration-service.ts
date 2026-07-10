import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeJsonFileAtomic } from "../utils/atomic-files.js";
import { isEnoentError } from "../utils/fs-errors.js";
import type { KnowledgeV2SettingsService } from "./knowledge-v2-settings-service.js";
import {
  estimateTokens,
  KnowledgeService,
  type KnowledgeEntryScope,
  type KnowledgeEntryType,
  type KnowledgeIndexResult,
  type KnowledgeUpsertInput,
} from "./knowledge-service.js";
import {
  KNOWLEDGE_V2_MIGRATION_CLASSIFIER,
  KNOWLEDGE_V2_MIGRATION_MANIFEST_VERSION,
  parseKnowledgeV2MigrationManifest,
  type KnowledgeV2MigrationFileSummary,
  type KnowledgeV2MigrationManifest,
} from "./knowledge-v2-migration-manifest.js";
import {
  getCommonKnowledgePath,
  getKnowledgeEntriesDir,
  getKnowledgeIndexPath,
  getKnowledgeLegacyArchiveDir,
  getKnowledgeMigrationManifestPath,
  getKnowledgeReferenceDir,
  getProfileKnowledgeEntriesDir,
  getProfileKnowledgeIndexPath,
  getProfileMemoryPath,
  getProfileReferenceDir,
  getProfilesDir,
} from "./data-paths.js";
import {
  acquireKnowledgeMigrationLock,
  assertKnowledgeMigrationNotBusy,
} from "./knowledge-v2-migration-lock.js";

const execFileAsync = promisify(execFile);
export interface KnowledgeV2MigrationOptions {
  dataDir: string;
  knowledgeService: KnowledgeService;
  settingsService: KnowledgeV2SettingsService;
  force?: boolean;
  now?: () => Date;
  /** Test seam for verifying the durable manifest commit boundary. */
  writeManifest?: typeof writeJsonFileAtomic;
}

export type { KnowledgeV2MigrationFileSummary, KnowledgeV2MigrationManifest } from "./knowledge-v2-migration-manifest.js";

interface LegacyKnowledgeFile {
  path: string;
  relativePath: string;
  scope: KnowledgeEntryScope;
  content: string;
}

interface LegacyCandidate {
  sourceFile: LegacyKnowledgeFile;
  section: string;
  text: string;
  index: number;
}

type CandidateClassification =
  | { action: "discard"; reason: string }
  | { action: "entry"; type: KnowledgeEntryType; title: string; body: string; importance?: "normal" | "high" }
  | { action: "pointer"; type: KnowledgeEntryType; title: string; body: string; referenceBody: string };

export async function runKnowledgeV2Migration(
  options: KnowledgeV2MigrationOptions,
): Promise<KnowledgeV2MigrationManifest> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const migrationId = `knowledge-v2-${startedAt.replace(/[^0-9A-Za-z]/g, "").slice(0, 14)}`;
  const releaseLock = await acquireKnowledgeMigrationLock(options.dataDir, migrationId);
  let completedManifest: KnowledgeV2MigrationManifest | undefined;

  try {
    await assertCleanMigrationState(options);
    const settingsBefore = options.settingsService.getSettings();
    const preMigrationVersioningSha = await resolveVersioningHead(options.dataDir);
    const legacyFiles = await readLegacyKnowledgeFiles(options.dataDir);
    const legacyBackups = await backupLegacyFiles(options.dataDir, migrationId, legacyFiles);
    const entries: KnowledgeV2MigrationManifest["entries"] = [];
    const discards: KnowledgeV2MigrationManifest["discards"] = [];
    const fileSummaries = new Map<string, KnowledgeV2MigrationFileSummary>();
    const touchedScopes = new Set<KnowledgeEntryScope>();

    for (const file of legacyFiles) {
      fileSummaries.set(file.relativePath, {
        relativePath: file.relativePath,
        scope: file.scope,
        candidates: 0,
        entries: 0,
        discards: 0,
        pointers: 0,
      });
      const candidates = splitLegacyKnowledgeFile(file);
      const firstSeen = await resolveEarliestKnownDate(options.dataDir, file.relativePath);
      const summary = fileSummaries.get(file.relativePath)!;
      summary.candidates = candidates.length;

      for (const candidate of candidates) {
        const classification = classifyLegacyCandidate(candidate);
        if (classification.action === "discard") {
          summary.discards += 1;
          discards.push({ sourcePath: file.relativePath, text: candidate.text, reason: classification.reason });
          continue;
        }

        let upsert: KnowledgeUpsertInput;
        if (classification.action === "pointer") {
          summary.pointers += 1;
          const referencePath = await writePointerReference(options.dataDir, candidate, classification);
          upsert = {
            id: stableMigrationEntryId("pointer", classification.title),
            type: "pointer",
            scope: file.scope,
            title: classification.title,
            body: `${classification.body} See ${relative(options.dataDir, referencePath).replace(/\\/g, "/")}.`,
            evidenceTier: "trusted_artifact",
            sources: [legacySource(file.relativePath, firstSeen)],
            firstSeen,
            lastConfirmed: firstSeen,
            supportCount: 1,
            legacy: true,
          };
        } else {
          upsert = {
            id: stableMigrationEntryId(classification.type, classification.title),
            type: classification.type,
            scope: file.scope,
            title: classification.title,
            body: classification.body,
            evidenceTier: "trusted_artifact",
            importance: classification.importance,
            sources: [legacySource(file.relativePath, firstSeen)],
            firstSeen,
            lastConfirmed: firstSeen,
            supportCount: 1,
            legacy: true,
          };
        }

        const entry = await options.knowledgeService.upsertEntry(upsert);
        touchedScopes.add(entry.frontmatter.scope);
        summary.entries += 1;
        entries.push({
          id: entry.frontmatter.id,
          scope: entry.frontmatter.scope,
          type: entry.frontmatter.type,
          sourcePath: file.relativePath,
        });
      }
    }

    const indexResults: KnowledgeIndexResult[] = [];
    for (const scope of touchedScopes) {
      const result = await options.knowledgeService.regenerateIndex(scope);
      if (result.tokenEstimate > result.tokenCap) {
        throw new Error(`Generated ${scope} index exceeds token cap (${result.tokenEstimate} > ${result.tokenCap}).`);
      }
      indexResults.push(result);
    }

    const completedAt = now().toISOString();
    const manifest: KnowledgeV2MigrationManifest = {
      version: KNOWLEDGE_V2_MIGRATION_MANIFEST_VERSION,
      migrationId,
      startedAt,
      completedAt,
      classifier: KNOWLEDGE_V2_MIGRATION_CLASSIFIER,
      force: options.force === true,
      preMigrationVersioningSha,
      settingsBefore,
      activation: { targetEnabled: true, state: "authorized_pending" },
      files: Array.from(fileSummaries.values()),
      legacyBackups,
      entries,
      discards,
      indexResults,
    };
    await (options.writeManifest ?? writeJsonFileAtomic)(getKnowledgeMigrationManifestPath(options.dataDir), manifest);
    completedManifest = manifest;
  } finally {
    await releaseLock();
  }

  // The completed manifest is the durable commit boundary. Activation happens
  // only after it is atomically present and the migration lock is released.
  if (!completedManifest) throw new Error("Knowledge v2 migration did not complete.");
  await options.settingsService.update({ enabled: true });
  return completedManifest;
}

function stableMigrationEntryId(type: KnowledgeEntryType, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");
  return `${type}-${slug || "legacy"}`;
}

export async function rollbackKnowledgeV2Migration(
  options: KnowledgeV2MigrationOptions & { manifestPath?: string },
): Promise<{ restoredFiles: string[]; settingsAfter: unknown; restartRequired: true }> {
  const releaseLock = await acquireKnowledgeMigrationLock(options.dataDir, `knowledge-v2-rollback-${Date.now()}`);
  try {
    const manifestValue = JSON.parse(
      await readFile(options.manifestPath ?? getKnowledgeMigrationManifestPath(options.dataDir), "utf8"),
    ) as unknown;
    const manifest = parseKnowledgeV2MigrationManifest(manifestValue);
    if (!manifest) {
      throw new Error("Knowledge v2 migration manifest is invalid; rollback aborted.");
    }
    const restoredFiles: string[] = [];
    for (const backup of manifest.legacyBackups) {
      const targetPath = resolveConfinedRollbackPath(options.dataDir, backup.relativePath);
      const backupPath = resolveConfinedBackupPath(options.dataDir, backup.backupPath);
      await mkdir(dirname(targetPath), { recursive: true });
      const restored = await readLegacyFileFromVersioning(options.dataDir, manifest.preMigrationVersioningSha, backup.relativePath)
        .catch(async () => readFile(backupPath, "utf8"));
      await writeFile(targetPath, restored, "utf8");
      restoredFiles.push(backup.relativePath);
    }
    const settingsAfter = await options.settingsService.update({ enabled: false });
    return { restoredFiles, settingsAfter, restartRequired: true };
  } finally {
    await releaseLock();
  }
}

export async function cleanupLegacyKnowledgeFiles(options: {
  dataDir: string;
  settingsService: KnowledgeV2SettingsService;
  confirm: boolean;
  now?: () => Date;
}): Promise<{ archivedPaths: string[]; settingsAfter: unknown }> {
  if (!options.confirm) {
    throw new Error("Legacy knowledge cleanup requires explicit confirmation.");
  }
  await assertKnowledgeMigrationNotBusy(options.dataDir);
  const now = options.now ?? (() => new Date());
  const archiveRoot = join(
    getKnowledgeLegacyArchiveDir(options.dataDir),
    "legacy-cleanup",
    now().toISOString().replace(/[^0-9A-Za-z]/g, "").slice(0, 14),
  );
  const files = await readLegacyKnowledgeFiles(options.dataDir);
  const archivedPaths: string[] = [];
  for (const file of files) {
    const archivePath = join(archiveRoot, file.relativePath);
    await mkdir(dirname(archivePath), { recursive: true });
    await copyFile(file.path, archivePath);
    await rm(file.path, { force: true });
    archivedPaths.push(file.relativePath);
  }
  await moveCortexArtifacts(options.dataDir, archiveRoot, archivedPaths);
  const settingsAfter = await options.settingsService.update({ legacyCleanupConfirmed: true });
  return { archivedPaths, settingsAfter };
}

async function assertCleanMigrationState(options: KnowledgeV2MigrationOptions): Promise<void> {
  if (options.force === true) return;
  if (options.settingsService.getSettings().enabled) {
    throw new Error("Knowledge v2 is already enabled; pass --force to re-run migration fixtures.");
  }
  if (await fileExists(getKnowledgeMigrationManifestPath(options.dataDir))) {
    throw new Error("Knowledge v2 migration manifest already exists; pass --force to overwrite fixture state.");
  }
  const existing = await Promise.all([
    hasMarkdownFiles(getKnowledgeEntriesDir(options.dataDir)),
    fileExists(getKnowledgeIndexPath(options.dataDir)),
    hasAnyProfileKnowledgeEntries(options.dataDir),
  ]);
  if (existing.some(Boolean)) {
    throw new Error("Knowledge v2 entries or indexes already exist; pass --force to continue.");
  }
}

async function readLegacyKnowledgeFiles(dataDir: string): Promise<LegacyKnowledgeFile[]> {
  const files: LegacyKnowledgeFile[] = [];
  await pushFileIfExists(files, dataDir, getCommonKnowledgePath(dataDir), "global");
  let profileIds: string[] = [];
  try {
    profileIds = await readdir(getProfilesDir(dataDir));
  } catch (error) {
    if (!isEnoentError(error)) throw error;
  }
  for (const profileId of profileIds.sort()) {
    await pushFileIfExists(files, dataDir, getProfileMemoryPath(dataDir, profileId), `profile:${profileId}`);
  }
  return files;
}

async function pushFileIfExists(
  files: LegacyKnowledgeFile[],
  dataDir: string,
  path: string,
  scope: KnowledgeEntryScope,
): Promise<void> {
  try {
    const content = await readFile(path, "utf8");
    files.push({ path, relativePath: relative(dataDir, path).replace(/\\/g, "/"), scope, content });
  } catch (error) {
    if (!isEnoentError(error)) throw error;
  }
}

function splitLegacyKnowledgeFile(sourceFile: LegacyKnowledgeFile): LegacyCandidate[] {
  const candidates: LegacyCandidate[] = [];
  let section = "";
  let index = 0;
  for (const rawLine of sourceFile.content.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^(#{1,6})\s+(.+)$/u.exec(rawLine);
    if (heading) {
      section = heading[2].trim();
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/u.exec(rawLine);
    if (!bullet) continue;
    const text = bullet[1].trim();
    if (!text || /^onboarding status:/iu.test(text)) continue;
    candidates.push({ sourceFile, section, text, index: index++ });
  }
  return candidates;
}

function classifyLegacyCandidate(candidate: LegacyCandidate): CandidateClassification {
  const text = candidate.text.replace(/\s+/g, " ").trim();
  const haystack = `${candidate.section} ${text}`.toLowerCase();
  if (/\b(this task|current task|today|tomorrow|yesterday|one[- ]off|temporary|scratch|wp-[a-z0-9-]+|pr\b|pull request|branch|commit|review bounce|round [0-9]+|fixture|smoke test|gate passed)\b/u.test(haystack)) {
    return { action: "discard", reason: "task-local" };
  }
  if (/\b(done|completed|merged|accepted|verified|green|red|passed|failed)\b/u.test(haystack) && /\b(wp-|wave|suite|test run|gate|branch|commit)\b/u.test(haystack)) {
    return { action: "discard", reason: "process-log" };
  }
  if (text.length < 24 || /^(yes|no|ok|todo|done|n\/a|none)\.?$/iu.test(text)) {
    return { action: "discard", reason: "too-thin" };
  }
  const title = buildEntryTitle(text);
  if (estimateTokens(text) > 90 || /\b(reference|architecture|large topic|full details|long-form)\b/u.test(haystack)) {
    return {
      action: "pointer",
      type: "pointer",
      title,
      body: "Legacy knowledge was too large for inline recall.",
      referenceBody: text,
    };
  }
  if (/\b(gotcha|bug|error|fail|failure|avoid|do not|don't|never|risk|watch out)\b/u.test(haystack)) {
    return { action: "entry", type: "gotcha", title, body: text, importance: /\bnever|must|do not\b/u.test(haystack) ? "high" : "normal" };
  }
  if (/\b(prefer|preference|likes|verbosity|tone|style|preferred name)\b/u.test(haystack)) {
    return { action: "entry", type: "preference", title, body: text };
  }
  return { action: "entry", type: "convention", title, body: text, importance: /\balways|must|required\b/u.test(haystack) ? "high" : "normal" };
}

function buildEntryTitle(text: string): string {
  return text
    .replace(/[`*_#]/g, "")
    .split(/\s+/u)
    .slice(0, 12)
    .join(" ")
    .replace(/[.:;,\s]+$/u, "");
}

async function writePointerReference(
  dataDir: string,
  candidate: LegacyCandidate,
  classification: Extract<CandidateClassification, { action: "pointer" }>,
): Promise<string> {
  const slug = createHash("sha1").update(`${candidate.sourceFile.relativePath}:${candidate.index}:${candidate.text}`).digest("hex").slice(0, 10);
  const referenceRoot = candidate.sourceFile.scope === "global"
    ? getKnowledgeReferenceDir(dataDir)
    : getProfileReferenceDir(dataDir, candidate.sourceFile.scope.slice("profile:".length));
  const referencePath = join(referenceRoot, `legacy-${slug}.md`);
  await mkdir(dirname(referencePath), { recursive: true });
  await writeFile(
    referencePath,
    [`# ${classification.title}`, "", classification.referenceBody, ""].join("\n"),
    "utf8",
  );
  return referencePath;
}

function legacySource(relativePath: string, firstSeen: string) {
  return {
    kind: "legacy" as const,
    session: `legacy:${relativePath}`,
    at: firstSeen,
  };
}

async function backupLegacyFiles(
  dataDir: string,
  migrationId: string,
  files: LegacyKnowledgeFile[],
): Promise<KnowledgeV2MigrationManifest["legacyBackups"]> {
  const backups: KnowledgeV2MigrationManifest["legacyBackups"] = [];
  const backupRoot = join(getKnowledgeLegacyArchiveDir(dataDir), "migration", migrationId, "legacy");
  for (const file of files) {
    const backupPath = join(backupRoot, file.relativePath);
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, file.content, "utf8");
    backups.push({
      relativePath: file.relativePath,
      backupPath,
      sha256: createHash("sha256").update(file.content).digest("hex"),
    });
  }
  return backups;
}

async function moveCortexArtifacts(dataDir: string, archiveRoot: string, archivedPaths: string[]): Promise<void> {
  const knowledgeDir = dirname(getKnowledgeIndexPath(dataDir));
  const names = [
    ".cortex-notes.md",
    ".cortex-review-log.jsonl",
    ".cortex-promotion-manifests",
    ".cortex-worker-artifacts",
    ".cortex-delta-slices",
    ".cortex-worker-slices",
    ".cortex-scan-latest.json",
  ];
  for (const name of names) {
    const source = join(knowledgeDir, name);
    if (!(await fileExists(source))) continue;
    const target = join(archiveRoot, "artifacts", name);
    await mkdir(dirname(target), { recursive: true });
    await copyFileOrDirectory(source, target);
    await rm(source, { recursive: true, force: true });
    archivedPaths.push(relative(dataDir, source).replace(/\\/g, "/"));
  }
}

async function copyFileOrDirectory(source: string, target: string): Promise<void> {
  const sourceStat = await stat(source);
  if (!sourceStat.isDirectory()) {
    await copyFile(source, target);
    return;
  }
  await mkdir(target, { recursive: true });
  for (const child of await readdir(source)) {
    await copyFileOrDirectory(join(source, child), join(target, child));
  }
}

async function resolveVersioningHead(dataDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dataDir, "rev-parse", "--verify", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function resolveEarliestKnownDate(dataDir: string, relativePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      dataDir,
      "log",
      "--follow",
      "--diff-filter=A",
      "--format=%ad",
      "--date=short",
      "--",
      relativePath,
    ]);
    const date = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
    if (date) return date;
  } catch {
    // Fixture data dirs usually are not versioning repos.
  }
  try {
    return (await stat(join(dataDir, relativePath))).mtime.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function readLegacyFileFromVersioning(
  dataDir: string,
  sha: string | null,
  relativePath: string,
): Promise<string> {
  if (!sha) throw new Error("No pre-migration versioning SHA is available.");
  const { stdout } = await execFileAsync("git", ["-C", dataDir, "show", `${sha}:${relativePath}`], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function hasAnyProfileKnowledgeEntries(dataDir: string): Promise<boolean> {
  let profileIds: string[] = [];
  try {
    profileIds = await readdir(getProfilesDir(dataDir));
  } catch (error) {
    if (isEnoentError(error)) return false;
    throw error;
  }
  for (const profileId of profileIds) {
    if (await hasMarkdownFiles(getProfileKnowledgeEntriesDir(dataDir, profileId))) return true;
    if (await fileExists(getProfileKnowledgeIndexPath(dataDir, profileId))) return true;
  }
  return false;
}

async function hasMarkdownFiles(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).some((name) => name.endsWith(".md"));
  } catch (error) {
    if (isEnoentError(error)) return false;
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isEnoentError(error)) return false;
    throw error;
  }
}

function resolveConfinedRollbackPath(dataDir: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error(`Invalid rollback relative path: ${relativePath}`);
  }
  const root = resolve(dataDir);
  const target = resolve(root, relativePath);
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Rollback path escapes the data directory: ${relativePath}`);
  }
  return target;
}

function resolveConfinedBackupPath(dataDir: string, backupPath: string): string {
  if (!backupPath || backupPath.includes("\0")) throw new Error("Invalid rollback backup path.");
  const root = resolve(dataDir);
  const target = resolve(root, backupPath);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error("Rollback backup path escapes the data directory.");
  }
  return target;
}
