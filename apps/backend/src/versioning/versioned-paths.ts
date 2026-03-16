import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { PromptCategory } from "../swarm/prompt-registry.js";
import { getProfilesDir, getSharedKnowledgeDir } from "../swarm/data-paths.js";

export interface VersionedPathsOptions {
  trackSessionMemory?: boolean;
}

export interface VersionedPathMetadata {
  relativePath: string;
  profileId?: string;
  sessionId?: string;
  promptCategory?: PromptCategory;
  promptId?: string;
  surface: "knowledge" | "memory" | "reference" | "prompt";
}

export function isTrackedVersionedPath(
  dataDir: string,
  filePath: string,
  options?: VersionedPathsOptions
): boolean {
  return resolveVersionedPathMetadata(dataDir, filePath, options) !== undefined;
}

export function resolveVersionedPathMetadata(
  dataDir: string,
  filePath: string,
  options?: VersionedPathsOptions
): VersionedPathMetadata | undefined {
  const relativePath = toDataDirRelativePath(dataDir, filePath);
  if (!relativePath || relativePath.startsWith(".git/") || relativePath.includes(".bak")) {
    return undefined;
  }

  if (relativePath === "shared/knowledge/common.md") {
    return { relativePath, surface: "knowledge", profileId: "cortex" };
  }

  if (relativePath === "shared/knowledge/.cortex-notes.md") {
    return { relativePath, surface: "knowledge", profileId: "cortex" };
  }

  if (relativePath === "shared/knowledge/.cortex-worker-prompts.md") {
    return { relativePath, surface: "knowledge", profileId: "cortex" };
  }

  const legacyKnowledgeMatch = /^shared\/knowledge\/profiles\/([^/]+)\.md$/.exec(relativePath);
  if (legacyKnowledgeMatch) {
    return {
      relativePath,
      profileId: legacyKnowledgeMatch[1],
      surface: "knowledge"
    };
  }

  const profileMemoryMatch = /^profiles\/([^/]+)\/memory\.md$/.exec(relativePath);
  if (profileMemoryMatch) {
    return {
      relativePath,
      profileId: profileMemoryMatch[1],
      surface: "memory"
    };
  }

  if (options?.trackSessionMemory) {
    const sessionMemoryMatch = /^profiles\/([^/]+)\/sessions\/([^/]+)\/memory\.md$/.exec(relativePath);
    if (sessionMemoryMatch) {
      return {
        relativePath,
        profileId: sessionMemoryMatch[1],
        sessionId: sessionMemoryMatch[2],
        surface: "memory"
      };
    }
  }

  const referenceMatch = /^profiles\/([^/]+)\/reference\/([^/]+\.md)$/.exec(relativePath);
  if (referenceMatch) {
    return {
      relativePath,
      profileId: referenceMatch[1],
      surface: "reference"
    };
  }

  const promptMatch = /^profiles\/([^/]+)\/prompts\/(archetypes|operational)\/([^/]+)\.md$/.exec(relativePath);
  if (promptMatch) {
    return {
      relativePath,
      profileId: promptMatch[1],
      promptCategory: promptMatch[2] === "archetypes" ? "archetype" : "operational",
      promptId: promptMatch[3],
      surface: "prompt"
    };
  }

  return undefined;
}

export async function enumerateExistingTrackedPaths(
  dataDir: string,
  options?: VersionedPathsOptions
): Promise<string[]> {
  const tracked = new Set<string>();
  const knowledgeDir = getSharedKnowledgeDir(dataDir);

  for (const candidate of [
    join(knowledgeDir, "common.md"),
    join(knowledgeDir, ".cortex-notes.md"),
    join(knowledgeDir, ".cortex-worker-prompts.md")
  ]) {
    await addTrackedPathIfPresent(dataDir, candidate, tracked, options);
  }

  await addTrackedMarkdownChildren(dataDir, join(knowledgeDir, "profiles"), tracked, options);

  const profilesDir = getProfilesDir(dataDir);
  let profileEntries: Dirent[] = [];
  try {
    profileEntries = await readdir(profilesDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoentError(error)) {
      return [];
    }
    throw error;
  }

  for (const entry of profileEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const profileDir = join(profilesDir, entry.name);
    await addTrackedPathIfPresent(dataDir, join(profileDir, "memory.md"), tracked, options);
    await addTrackedMarkdownChildren(dataDir, join(profileDir, "reference"), tracked, options);
    await addTrackedMarkdownChildren(dataDir, join(profileDir, "prompts", "archetypes"), tracked, options);
    await addTrackedMarkdownChildren(dataDir, join(profileDir, "prompts", "operational"), tracked, options);

    if (!options?.trackSessionMemory) {
      continue;
    }

    const sessionsDir = join(profileDir, "sessions");
    let sessionEntries: Dirent[] = [];
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
      await addTrackedPathIfPresent(dataDir, join(sessionsDir, sessionEntry.name, "memory.md"), tracked, options);
    }
  }

  return Array.from(tracked).sort((left, right) => left.localeCompare(right));
}

export function toDataDirRelativePath(dataDir: string, filePath: string): string | undefined {
  const resolvedDataDir = resolve(dataDir);
  const resolvedPath = resolve(filePath);
  const relativePath = relative(resolvedDataDir, resolvedPath);

  if (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\")
  ) {
    return undefined;
  }

  return relativePath.replace(/\\/g, "/");
}

async function addTrackedMarkdownChildren(
  dataDir: string,
  directoryPath: string,
  tracked: Set<string>,
  options?: VersionedPathsOptions
): Promise<void> {
  let entries: Dirent[] = [];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (isEnoentError(error)) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }

    await addTrackedPathIfPresent(dataDir, join(directoryPath, entry.name), tracked, options);
  }
}

async function addTrackedPathIfPresent(
  dataDir: string,
  absolutePath: string,
  tracked: Set<string>,
  options?: VersionedPathsOptions
): Promise<void> {
  try {
    const fileStats = await stat(absolutePath);
    if (!fileStats.isFile()) {
      return;
    }
  } catch (error) {
    if (isEnoentError(error)) {
      return;
    }
    throw error;
  }

  const metadata = resolveVersionedPathMetadata(dataDir, absolutePath, options);
  if (metadata) {
    tracked.add(metadata.relativePath);
  }
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
