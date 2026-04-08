import { readdir, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  getGlobalForgeExtensionsDir,
  getProfileForgeExtensionsDir,
  getProfilesDir,
  getProjectLocalForgeExtensionsDir
} from "./data-paths.js";
import type { DiscoveredForgeExtension, ForgeScope } from "./forge-extension-types.js";

interface DiscoverForgeExtensionsOptions {
  dataDir: string;
  scopes: ForgeScope[];
  profileId?: string;
  cwd?: string;
}

const SCOPE_SORT_ORDER: Record<ForgeScope, number> = {
  global: 0,
  profile: 1,
  "project-local": 2
};

export async function discoverForgeExtensions(
  options: DiscoverForgeExtensionsOptions
): Promise<DiscoveredForgeExtension[]> {
  const discovered: DiscoveredForgeExtension[] = [];

  for (const scope of options.scopes) {
    if (scope === "global") {
      await collectForgeExtensionsFromDirectory({
        extensionsDir: getGlobalForgeExtensionsDir(options.dataDir),
        scope,
        target: discovered
      });
      continue;
    }

    if (scope === "profile") {
      if (!options.profileId) {
        continue;
      }

      await collectForgeExtensionsFromDirectory({
        extensionsDir: getProfileForgeExtensionsDir(options.dataDir, options.profileId),
        scope,
        profileId: options.profileId,
        target: discovered
      });
      continue;
    }

    if (!options.cwd) {
      continue;
    }

    await collectForgeExtensionsFromDirectory({
      extensionsDir: getProjectLocalForgeExtensionsDir(options.cwd),
      scope,
      cwd: options.cwd,
      target: discovered
    });
  }

  return dedupeAndSortDiscoveredForgeExtensions(discovered);
}

export async function listForgeProfileIdsOnDisk(dataDir: string): Promise<string[]> {
  const profilesDir = getProfilesDir(dataDir);
  const entries = await readDirEntries(profilesDir);
  if (!entries) {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function collectForgeExtensionsFromDirectory(options: {
  extensionsDir: string;
  scope: ForgeScope;
  target: DiscoveredForgeExtension[];
  profileId?: string;
  cwd?: string;
}): Promise<void> {
  const entries = await readDirEntries(options.extensionsDir);
  if (!entries) {
    return;
  }

  for (const entry of entries) {
    const entryPath = resolve(options.extensionsDir, entry.name);

    if (entry.isFile() && isSupportedForgeExtensionFile(entry.name)) {
      options.target.push({
        displayName: normalizeExtensionDisplayName(entryPath),
        path: entryPath,
        scope: options.scope,
        profileId: options.profileId,
        cwd: options.cwd
      });
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    const indexTsPath = resolve(entryPath, "index.ts");
    if (await isFile(indexTsPath)) {
      options.target.push({
        displayName: normalizeExtensionDisplayName(indexTsPath),
        path: indexTsPath,
        scope: options.scope,
        profileId: options.profileId,
        cwd: options.cwd
      });
      continue;
    }

    const indexJsPath = resolve(entryPath, "index.js");
    if (await isFile(indexJsPath)) {
      options.target.push({
        displayName: normalizeExtensionDisplayName(indexJsPath),
        path: indexJsPath,
        scope: options.scope,
        profileId: options.profileId,
        cwd: options.cwd
      });
    }
  }
}

async function readDirEntries(dirPath: string) {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }

    throw error;
  }
}

async function isFile(pathValue: string): Promise<boolean> {
  try {
    const entry = await stat(pathValue);
    return entry.isFile();
  } catch (error) {
    if (isEnoentError(error)) {
      return false;
    }

    throw error;
  }
}

function dedupeAndSortDiscoveredForgeExtensions(
  extensions: DiscoveredForgeExtension[]
): DiscoveredForgeExtension[] {
  const unique = new Map<string, DiscoveredForgeExtension>();

  for (const extension of extensions) {
    const key = [
      extension.scope,
      toComparablePath(extension.path),
      extension.profileId ?? "",
      extension.cwd ?? ""
    ].join("::");

    if (!unique.has(key)) {
      unique.set(key, extension);
    }
  }

  return Array.from(unique.values()).sort((left, right) => {
    const byScope = SCOPE_SORT_ORDER[left.scope] - SCOPE_SORT_ORDER[right.scope];
    if (byScope !== 0) {
      return byScope;
    }

    return toComparablePath(left.path).localeCompare(toComparablePath(right.path));
  });
}

function normalizeExtensionDisplayName(pathValue: string): string {
  const baseName = basename(pathValue);
  const normalizedBaseName = baseName.toLowerCase();
  if (normalizedBaseName === "index.ts" || normalizedBaseName === "index.js") {
    return basename(dirname(pathValue));
  }

  return baseName;
}

function isSupportedForgeExtensionFile(fileName: string): boolean {
  const normalized = fileName.toLowerCase();
  return normalized.endsWith(".ts") || normalized.endsWith(".js");
}

function isEnoentError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function toComparablePath(pathValue: string): string {
  const resolved = resolve(pathValue);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
