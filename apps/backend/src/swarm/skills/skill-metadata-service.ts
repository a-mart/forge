import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getProfilePiSkillsDir } from "../data-paths.js";
import { parseSkillFrontmatter, type ParsedSkillEnvDeclaration } from "./skill-frontmatter.js";
import type { SwarmConfig } from "../types.js";

const REPO_SKILLS_RELATIVE_DIR = ".swarm/skills";
const LOCAL_DATA_DIR_SKILLS_RELATIVE_DIR = "skills";
const REPO_BUILT_IN_SKILLS_RELATIVE_DIR = "apps/backend/src/swarm/skills/builtins";
const SKILL_FILE_NAME = "SKILL.md";
const REQUIRED_SKILL_NAMES = [
  "memory",
  "brave-search",
  "cron-scheduling",
  "agent-browser",
  "image-generation",
  "slash-commands",
  "chrome-cdp"
] as const;

const SKILL_METADATA_SERVICE_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_PACKAGE_DIR = resolve(SKILL_METADATA_SERVICE_DIR, "..", "..", "..");
const BUILT_IN_SKILLS_FALLBACK_DIR = resolve(BACKEND_PACKAGE_DIR, "src", "swarm", "skills", "builtins");

export type SkillSourceKind = "builtin" | "repo" | "machine-local" | "profile";

export interface SkillMetadata {
  skillId: string;
  skillName: string;
  directoryName: string;
  description?: string;
  path: string;
  rootPath: string;
  env: ParsedSkillEnvDeclaration[];
  sourceKind: SkillSourceKind;
  profileId?: string;
  isInherited: boolean;
  isEffective: boolean;
}

interface SkillMetadataServiceDependencies {
  config: SwarmConfig;
}

interface SkillPathCandidate {
  directoryName: string;
  path: string;
  rootPath: string;
  sourceKind: SkillSourceKind;
  profileId?: string;
}

interface DecodedSkillId {
  sourceKind: SkillSourceKind;
  profileId?: string;
  skillRootPath: string;
}

export class SkillMetadataService {
  private skillMetadata: SkillMetadata[] = [];

  constructor(private readonly deps: SkillMetadataServiceDependencies) {}

  getSkillMetadata(): SkillMetadata[] {
    return this.skillMetadata.map((metadata) => cloneSkillMetadata(metadata));
  }

  getAdditionalSkillPaths(): string[] {
    return this.skillMetadata.map((metadata) => metadata.path);
  }

  async getProfileSkillMetadata(profileId: string): Promise<SkillMetadata[]> {
    await this.ensureSkillMetadataLoaded();

    const profileCandidates = await this.scanProfileSkillPathCandidates(profileId);
    const profileMetadata = await this.loadEffectiveMetadata(profileCandidates, profileId);
    return profileMetadata.map((metadata) => cloneSkillMetadata(metadata));
  }

  async resolveSkillById(skillId: string): Promise<SkillMetadata | null> {
    const decoded = decodeSkillId(skillId);
    if (!decoded) {
      return null;
    }

    if (decoded.sourceKind === "profile") {
      if (typeof decoded.profileId !== "string" || decoded.profileId.trim().length === 0) {
        return null;
      }

      const profileMetadata = await this.getProfileSkillMetadata(decoded.profileId);
      return profileMetadata.find((metadata) => metadata.skillId === skillId) ?? null;
    }

    await this.ensureSkillMetadataLoaded();
    return this.skillMetadata.find((metadata) => metadata.skillId === skillId) ?? null;
  }

  async ensureSkillMetadataLoaded(): Promise<void> {
    if (this.skillMetadata.length > 0) {
      return;
    }

    await this.reloadSkillMetadata();
  }

  async reloadSkillMetadata(): Promise<void> {
    const scannedCandidates = await this.scanGlobalSkillPathCandidates();
    const candidates = this.injectExplicitRequiredSkillOverrides(scannedCandidates);
    this.validateRequiredSkillsPresent(candidates);
    this.skillMetadata = await this.loadEffectiveMetadata(candidates, undefined);
  }

  private async scanGlobalSkillPathCandidates(): Promise<SkillPathCandidate[]> {
    const resourcesDir = this.deps.config.paths.resourcesDir ?? this.deps.config.paths.rootDir;
    const localSkillsDir = resolve(this.deps.config.paths.dataDir, LOCAL_DATA_DIR_SKILLS_RELATIVE_DIR);
    const repositorySkillsDir = resolve(resourcesDir, REPO_SKILLS_RELATIVE_DIR);
    const repositoryBuiltInSkillsDir = resolve(resourcesDir, REPO_BUILT_IN_SKILLS_RELATIVE_DIR);

    return [
      ...(await this.scanSkillFilesInDirectory(localSkillsDir, "machine-local")),
      ...(await this.scanSkillFilesInDirectory(repositorySkillsDir, "repo")),
      ...(await this.scanSkillFilesInDirectory(repositoryBuiltInSkillsDir, "builtin")),
      ...(await this.scanSkillFilesInDirectory(BUILT_IN_SKILLS_FALLBACK_DIR, "builtin"))
    ];
  }

  private async scanProfileSkillPathCandidates(profileId: string): Promise<SkillPathCandidate[]> {
    const profileSkillsDir = getProfilePiSkillsDir(this.deps.config.paths.dataDir, profileId);
    return this.scanSkillFilesInDirectory(profileSkillsDir, "profile", profileId);
  }

  private async scanSkillFilesInDirectory(
    directory: string,
    sourceKind: SkillSourceKind,
    profileId?: string
  ): Promise<SkillPathCandidate[]> {
    let entries: Array<{ isDirectory: () => boolean; name: string }>;

    try {
      const dirEntries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
      entries = dirEntries.map((entry) => ({
        isDirectory: () => entry.isDirectory(),
        name: String(entry.name)
      }));
    } catch {
      return [];
    }

    const skillDirectories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    const candidates: SkillPathCandidate[] = [];
    for (const directoryName of skillDirectories) {
      const rootPath = join(directory, directoryName);
      const skillPath = join(rootPath, SKILL_FILE_NAME);
      if (!existsSync(skillPath)) {
        continue;
      }

      candidates.push({
        directoryName,
        path: skillPath,
        rootPath,
        sourceKind,
        ...(profileId ? { profileId } : {})
      });
    }

    return candidates;
  }

  private injectExplicitRequiredSkillOverrides(candidates: SkillPathCandidate[]): SkillPathCandidate[] {
    const overriddenCandidates = [...candidates];
    const explicitMemoryPath = this.deps.config.paths.repoMemorySkillFile;
    if (!existsSync(explicitMemoryPath)) {
      return overriddenCandidates;
    }

    const explicitRootPath = resolve(explicitMemoryPath, "..");
    const explicitCandidate: SkillPathCandidate = {
      directoryName: basename(explicitRootPath),
      path: explicitMemoryPath,
      rootPath: explicitRootPath,
      sourceKind: "repo"
    };

    const existingIndex = overriddenCandidates.findIndex((candidate) => candidate.path === explicitMemoryPath);
    if (existingIndex >= 0) {
      const [existing] = overriddenCandidates.splice(existingIndex, 1);
      overriddenCandidates.unshift(existing);
      return overriddenCandidates;
    }

    overriddenCandidates.unshift(explicitCandidate);
    return overriddenCandidates;
  }

  private validateRequiredSkillsPresent(candidates: SkillPathCandidate[]): void {
    const index = this.buildSkillPathIndex(candidates);

    for (const requiredSkillName of REQUIRED_SKILL_NAMES) {
      const normalizedSkillName = normalizeSkillName(requiredSkillName);
      if ((index.get(normalizedSkillName) ?? []).length === 0) {
        throw new Error(`Missing built-in ${requiredSkillName} skill file`);
      }
    }
  }

  private async loadEffectiveMetadata(
    prioritizedCandidates: SkillPathCandidate[],
    profileId: string | undefined
  ): Promise<SkillMetadata[]> {
    const seenDirectoryNames = new Set<string>();
    const effectiveCandidates: SkillPathCandidate[] = [];

    for (const candidate of prioritizedCandidates) {
      const normalizedDirectoryName = normalizeSkillName(candidate.directoryName);
      if (seenDirectoryNames.has(normalizedDirectoryName)) {
        continue;
      }

      seenDirectoryNames.add(normalizedDirectoryName);
      effectiveCandidates.push(candidate);
    }

    const metadata = await Promise.all(
      effectiveCandidates.map(async (candidate) => this.loadSkillMetadataFromCandidate(candidate, profileId))
    );

    return metadata;
  }

  private async loadSkillMetadataFromCandidate(
    candidate: SkillPathCandidate,
    profileId: string | undefined
  ): Promise<SkillMetadata> {
    const markdown = await readFile(candidate.path, "utf8");
    const parsed = parseSkillFrontmatter(markdown);
    const fallbackSkillName = candidate.directoryName;
    const skillName = (parsed.name ?? fallbackSkillName).trim();

    return {
      skillId: buildSkillId({
        sourceKind: candidate.sourceKind,
        ...(candidate.profileId ? { profileId: candidate.profileId } : {}),
        skillRootPath: candidate.rootPath
      }),
      skillName,
      directoryName: candidate.directoryName,
      description: parsed.description,
      path: candidate.path,
      rootPath: candidate.rootPath,
      env: parsed.env.map((declaration) => ({ ...declaration })),
      sourceKind: candidate.sourceKind,
      ...(candidate.profileId ? { profileId: candidate.profileId } : {}),
      isInherited: typeof profileId === "string" && candidate.sourceKind !== "profile",
      isEffective: true
    };
  }

  private buildSkillPathIndex(candidates: SkillPathCandidate[]): Map<string, string[]> {
    const index = new Map<string, string[]>();

    for (const candidate of candidates) {
      const normalizedSkillName = normalizeSkillName(candidate.directoryName);
      const existing = index.get(normalizedSkillName) ?? [];
      if (!existing.includes(candidate.path)) {
        existing.push(candidate.path);
      }
      index.set(normalizedSkillName, existing);
    }

    return index;
  }
}

function normalizeSkillName(skillName: string): string {
  return skillName.trim().toLowerCase();
}

function cloneSkillMetadata(metadata: SkillMetadata): SkillMetadata {
  return {
    skillId: metadata.skillId,
    skillName: metadata.skillName,
    directoryName: metadata.directoryName,
    description: metadata.description,
    path: metadata.path,
    rootPath: metadata.rootPath,
    env: metadata.env.map((declaration) => ({ ...declaration })),
    sourceKind: metadata.sourceKind,
    ...(metadata.profileId ? { profileId: metadata.profileId } : {}),
    isInherited: metadata.isInherited,
    isEffective: metadata.isEffective
  };
}

function buildSkillId(options: {
  sourceKind: SkillSourceKind;
  profileId?: string;
  skillRootPath: string;
}): string {
  const payload = {
    sourceKind: options.sourceKind,
    ...(options.profileId ? { profileId: options.profileId } : {}),
    skillRootPath: resolve(options.skillRootPath)
  };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeSkillId(skillId: string): DecodedSkillId | null {
  try {
    const parsed = JSON.parse(Buffer.from(skillId, "base64url").toString("utf8")) as Partial<DecodedSkillId>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    if (
      parsed.sourceKind !== "builtin" &&
      parsed.sourceKind !== "repo" &&
      parsed.sourceKind !== "machine-local" &&
      parsed.sourceKind !== "profile"
    ) {
      return null;
    }

    if (typeof parsed.skillRootPath !== "string" || parsed.skillRootPath.trim().length === 0) {
      return null;
    }

    if (parsed.profileId !== undefined && typeof parsed.profileId !== "string") {
      return null;
    }

    return {
      sourceKind: parsed.sourceKind,
      ...(parsed.profileId ? { profileId: parsed.profileId } : {}),
      skillRootPath: resolve(parsed.skillRootPath)
    };
  } catch {
    return null;
  }
}
