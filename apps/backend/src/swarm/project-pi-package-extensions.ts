import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export async function resolveLocalPiPackageExtensionPathsFromSettings(settingsPath: string): Promise<string[]> {
  const settings = await readJsonObject(settingsPath);
  const settingsDir = dirname(settingsPath);
  const packages = Array.isArray(settings?.packages) ? settings.packages : [];
  const paths: string[] = [];

  for (const entry of packages) {
    const packageSource = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.source === "string" ? entry.source : undefined;
    if (!packageSource || !isLocalPackageSource(packageSource)) continue;

    const filters = isRecord(entry) && Array.isArray(entry.extensions)
      ? entry.extensions.filter((value): value is string => typeof value === "string")
      : undefined;
    if (filters?.length === 0) continue;

    const packageRoot = resolvePackageSourcePath(packageSource, settingsDir);
    const packageEntry = await statOrUndefined(packageRoot);
    if (packageEntry?.isFile()) {
      if (isSupportedExtensionFile(packageRoot) && matchesExtensionFilters(packageRoot, packageRoot, filters)) {
        paths.push(packageRoot);
      }
      continue;
    }
    if (packageEntry && !packageEntry.isDirectory()) continue;

    const candidates = await collectPackageExtensionCandidates(packageRoot);
    paths.push(...candidates.filter((candidate) => matchesExtensionFilters(candidate, packageRoot, filters)));
  }

  return uniqueSortedPaths(paths);
}

async function collectPackageExtensionCandidates(packageRoot: string): Promise<string[]> {
  const manifest = await readJsonObject(join(packageRoot, "package.json"));
  const piManifest = isRecord(manifest?.pi) ? manifest.pi : undefined;
  const manifestExtensions = Array.isArray(piManifest?.extensions)
    ? piManifest.extensions.filter((value): value is string => typeof value === "string")
    : [];

  if (manifestExtensions.length > 0) {
    return uniqueSortedPaths(
      manifestExtensions
        .map((extensionPath) => resolve(packageRoot, extensionPath))
        .filter(isSupportedExtensionFile)
    );
  }

  return collectExtensionFiles(join(packageRoot, "extensions"));
}

async function collectExtensionFiles(pathValue: string): Promise<string[]> {
  const entry = await statOrUndefined(pathValue);
  if (!entry) return [];
  if (entry.isFile()) return isSupportedExtensionFile(pathValue) ? [pathValue] : [];
  if (!entry.isDirectory()) return [];

  const entries = await readDirEntries(pathValue);
  const paths: string[] = [];
  for (const child of entries) {
    const childPath = join(pathValue, child.name);
    if (child.isDirectory()) {
      const indexTs = join(childPath, "index.ts");
      const indexJs = join(childPath, "index.js");
      if (await isFile(indexTs)) paths.push(indexTs);
      else if (await isFile(indexJs)) paths.push(indexJs);
      continue;
    }
    if (child.isFile() && isSupportedExtensionFile(child.name)) {
      paths.push(childPath);
    }
  }
  return uniqueSortedPaths(paths);
}

function matchesExtensionFilters(candidate: string, packageRoot: string, filters: string[] | undefined): boolean {
  if (!filters) return true;
  const includePatterns = filters.filter((pattern) => !pattern.startsWith("!"));
  const excludePatterns = filters
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  const included = includePatterns.length === 0 || includePatterns.some((pattern) => matchesPattern(candidate, packageRoot, pattern));
  if (!included) return false;
  return !excludePatterns.some((pattern) => matchesPattern(candidate, packageRoot, pattern));
}

function matchesPattern(candidate: string, packageRoot: string, pattern: string): boolean {
  const normalizedPattern = toPosix(pattern.trim());
  if (!normalizedPattern) return false;
  const rel = toPosix(relative(packageRoot, candidate));
  const abs = toPosix(resolve(packageRoot, pattern));
  const normalizedCandidate = toPosix(resolve(candidate));
  return globToRegExp(normalizedPattern).test(rel) || globToRegExp(abs).test(normalizedCandidate);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    source += escapeRegExp(char);
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function toPosix(pathValue: string): string {
  return pathValue.split(sep).join("/");
}

function resolvePackageSourcePath(source: string, settingsDir: string): string {
  const trimmed = source.trim();
  if (trimmed === "~") return resolve(getHomeDirectory());
  if (trimmed.startsWith("~/")) return resolve(getHomeDirectory(), trimmed.slice(2));
  if (trimmed.startsWith("~")) return resolve(getHomeDirectory(), trimmed.slice(1));
  return resolve(settingsDir, trimmed);
}

function getHomeDirectory(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

function isLocalPackageSource(source: string): boolean {
  const trimmed = source.trim();
  return (
    trimmed.startsWith(".") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    (!trimmed.startsWith("npm:") && !trimmed.startsWith("git+") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed))
  );
}

function isSupportedExtensionFile(fileName: string): boolean {
  const normalized = fileName.toLowerCase();
  return normalized.endsWith(".ts") || normalized.endsWith(".js");
}

async function readJsonObject(pathValue: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(pathValue, "utf-8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if (isMissingPathError(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function readDirEntries(dirPath: string) {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

async function statOrUndefined(pathValue: string) {
  try {
    return await stat(pathValue);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

async function isFile(pathValue: string): Promise<boolean> {
  const entry = await statOrUndefined(pathValue);
  return entry?.isFile() === true;
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function uniqueSortedPaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((pathValue) => resolve(pathValue)))).sort((left, right) => left.localeCompare(right));
}
