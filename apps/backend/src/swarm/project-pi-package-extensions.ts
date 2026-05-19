import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

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
      if (isSupportedExtensionFile(packageRoot)) {
        paths.push(...applyExtensionPatterns([packageRoot], filters, packageRoot));
      }
      continue;
    }
    if (packageEntry && !packageEntry.isDirectory()) continue;

    const candidates = await collectPackageExtensionCandidates(packageRoot);
    paths.push(...applyExtensionPatterns(candidates, filters, packageRoot));
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
    const sourceEntries = manifestExtensions.filter((entry) => !isOverridePattern(entry));
    const overridePatterns = manifestExtensions.filter(isOverridePattern);
    const allFiles: string[] = [];
    for (const entry of sourceEntries) {
      allFiles.push(...(await collectFilesFromManifestEntry(packageRoot, entry)));
    }
    const uniqueFiles = uniqueSortedPaths(allFiles);
    return overridePatterns.length > 0 ? applyExtensionPatterns(uniqueFiles, overridePatterns, packageRoot) : uniqueFiles;
  }

  return collectExtensionFiles(join(packageRoot, "extensions"));
}

async function collectFilesFromManifestEntry(packageRoot: string, entry: string): Promise<string[]> {
  if (!hasGlobPattern(entry)) {
    return collectExtensionFiles(resolve(packageRoot, entry));
  }

  const paths = await collectPathEntries(packageRoot);
  const matches = paths.filter((pathValue) => matchesAnyPattern(pathValue, [entry], packageRoot));
  const collected: string[] = [];
  for (const match of matches) {
    collected.push(...(await collectExtensionFiles(match)));
  }
  return uniqueSortedPaths(collected);
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

async function collectPathEntries(root: string): Promise<string[]> {
  const rootEntry = await statOrUndefined(root);
  if (!rootEntry?.isDirectory()) return rootEntry ? [root] : [];
  const entries = await readDirEntries(root);
  const paths: string[] = [];
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    paths.push(entryPath);
    if (entry.isDirectory()) {
      paths.push(...(await collectPathEntries(entryPath)));
    }
  }
  return uniqueSortedPaths(paths);
}

function applyExtensionPatterns(paths: string[], patterns: string[] | undefined, baseDir: string): string[] {
  if (!patterns) return uniqueSortedPaths(paths);
  const includes: string[] = [];
  const excludes: string[] = [];
  const forceIncludes: string[] = [];
  const forceExcludes: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("+")) forceIncludes.push(pattern.slice(1));
    else if (pattern.startsWith("-")) forceExcludes.push(pattern.slice(1));
    else if (pattern.startsWith("!")) excludes.push(pattern.slice(1));
    else includes.push(pattern);
  }

  let result = includes.length === 0 ? [...paths] : paths.filter((pathValue) => matchesAnyPattern(pathValue, includes, baseDir));
  if (excludes.length > 0) result = result.filter((pathValue) => !matchesAnyPattern(pathValue, excludes, baseDir));
  for (const pathValue of paths) {
    if (!result.includes(pathValue) && matchesAnyExactPattern(pathValue, forceIncludes, baseDir)) result.push(pathValue);
  }
  if (forceExcludes.length > 0) result = result.filter((pathValue) => !matchesAnyExactPattern(pathValue, forceExcludes, baseDir));
  return uniqueSortedPaths(result);
}

function matchesAnyPattern(candidate: string, patterns: string[], baseDir: string): boolean {
  const rel = toPosix(relative(baseDir, candidate));
  const name = basename(candidate);
  const absolute = toPosix(resolve(candidate));
  return patterns.some((pattern) => {
    const normalizedPattern = normalizePattern(pattern);
    return (
      globToRegExp(normalizedPattern).test(rel) ||
      globToRegExp(normalizedPattern).test(name) ||
      globToRegExp(normalizedPattern).test(absolute)
    );
  });
}

function matchesAnyExactPattern(candidate: string, patterns: string[], baseDir: string): boolean {
  if (patterns.length === 0) return false;
  const rel = toPosix(relative(baseDir, candidate));
  const absolute = toPosix(resolve(candidate));
  return patterns.some((pattern) => {
    const normalized = normalizePattern(pattern);
    return normalized === rel || normalized === absolute;
  });
}

function normalizePattern(pattern: string): string {
  const trimmed = pattern.trim();
  const withoutLeadingDot = trimmed.startsWith("./") || trimmed.startsWith(".\\") ? trimmed.slice(2) : trimmed;
  return toPosix(withoutLeadingDot);
}

function isOverridePattern(pattern: string): boolean {
  return pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-");
}

function hasGlobPattern(pattern: string): boolean {
  return /[*?\[\]{}]/.test(pattern);
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
