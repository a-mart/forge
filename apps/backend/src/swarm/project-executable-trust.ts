import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { LoadExtensionsResult } from "@mariozechner/pi-coding-agent";

type SettingsStorage = {
  withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void;
};
import { ProjectResourceSettingsStore } from "./project-resource-settings.js";
import { ProjectWorkspaceResolver, type ProjectWorkspaceResolution } from "./project-workspace-resolver.js";
import type { AgentDescriptor, SwarmConfig } from "./types.js";

export interface ProjectExecutableTrustPlan {
  resolution?: ProjectWorkspaceResolution;
  trusted: boolean;
  effectiveForgeDirRealpath?: string;
  trustedForgeExtensionDirs: string[];
  trustedPiExtensionDirs: string[];
  trustedPiSettingsPaths: string[];
}

export async function resolveProjectExecutableTrustPlan(options: {
  config: SwarmConfig;
  descriptor: AgentDescriptor;
  sessionDescriptor?: AgentDescriptor;
}): Promise<ProjectExecutableTrustPlan> {
  const session = options.descriptor.role === "manager" ? options.descriptor : options.sessionDescriptor;
  const profileId = session?.profileId ?? session?.agentId ?? options.descriptor.profileId ?? options.descriptor.managerId;
  const sessionAgentId = session?.agentId ?? options.descriptor.managerId;
  const cwd = session?.cwd ?? options.descriptor.cwd;
  if (!profileId || !sessionAgentId || !cwd) {
    return { trusted: false, trustedForgeExtensionDirs: [], trustedPiExtensionDirs: [], trustedPiSettingsPaths: [] };
  }

  const resolution = await new ProjectWorkspaceResolver({
    dataDir: options.config.paths.dataDir,
    settingsStore: new ProjectResourceSettingsStore(options.config.paths.dataDir)
  }).resolve({ profileId, sessionAgentId, cwd });
  return buildProjectExecutableTrustPlan({ resolution, cwd });
}

export function buildProjectExecutableTrustPlan(options: {
  resolution: ProjectWorkspaceResolution;
  cwd: string;
}): ProjectExecutableTrustPlan {
  const trusted = options.resolution.trust.state === "trusted";
  const trustRoot = options.resolution.effectiveForgeDirRealpath;
  return {
    resolution: options.resolution,
    trusted,
    effectiveForgeDirRealpath: trustRoot,
    trustedForgeExtensionDirs: trusted
      ? uniqueRealPaths(filterInsideTrustRoot([options.resolution.repoRootResources.forgeExtensionsDir, join(options.cwd, ".forge", "extensions")], trustRoot))
      : [],
    trustedPiExtensionDirs: trusted
      ? uniqueRealPaths(filterInsideTrustRoot([options.resolution.repoRootResources.piExtensionsDir, join(options.cwd, ".pi", "extensions")], trustRoot))
      : [],
    trustedPiSettingsPaths: trusted
      ? uniqueRealPaths(filterInsideTrustRoot([options.resolution.repoRootResources.piSettingsPath, join(options.cwd, ".pi", "settings.json")], trustRoot))
      : []
  };
}

export function filterUntrustedProjectPiExtensions(options: {
  result: LoadExtensionsResult;
  descriptor: AgentDescriptor;
  config: SwarmConfig;
  trustPlan: ProjectExecutableTrustPlan;
}): LoadExtensionsResult {
  const blockedRoots = options.trustPlan.trusted
    ? []
    : [
        join(options.descriptor.cwd, ".pi"),
        options.trustPlan.resolution?.repoRootResources.piExtensionsDir,
        options.trustPlan.resolution?.repoRootResources.forgeExtensionsDir,
        options.trustPlan.resolution?.repoRootResources.piSettingsPath
          ? dirname(options.trustPlan.resolution.repoRootResources.piSettingsPath)
          : undefined,
      ].filter(isString);

  return {
    ...options.result,
    extensions: options.result.extensions.filter((extension) => {
      const candidates = [extension.resolvedPath, extension.path].filter(isString);
      return candidates.every((candidate) => isInlinePath(candidate) || !blockedRoots.some((root) => isPathInside(candidate, root)));
    }),
    errors: options.result.errors.filter((entry) => {
      if (!entry.path || isInlinePath(entry.path)) return true;
      return !blockedRoots.some((root) => isPathInside(entry.path!, root));
    })
  };
}

export function buildProjectSafePiProjectSettingsStorage(options: {
  agentDir: string;
  projectSettingsPaths?: string[];
  projectExecutablesTrusted: boolean;
}): SettingsStorage {
  const globalSettingsPath = join(options.agentDir, "settings.json");
  const projectSettingsPaths = options.projectExecutablesTrusted ? (options.projectSettingsPaths ?? []) : [];
  return {
    withLock(scope, fn) {
      const current = scope === "global"
        ? readOptionalFileSync(globalSettingsPath)
        : projectSettingsPaths.length > 0
          ? mergeProjectSettings(projectSettingsPaths)
          : JSON.stringify({ packages: [], extensions: ["!*"], skills: [], prompts: [], themes: [] });
      const next = fn(current);
      if (scope === "global") {
        writeOptionalFileSync(globalSettingsPath, next);
      } else if (projectSettingsPaths[0]) {
        writeOptionalFileSync(projectSettingsPaths[0], next);
      }
    }
  };
}

export function pathExistsSync(pathValue: string | undefined): pathValue is string {
  if (!pathValue) return false;
  try {
    const entry = statSync(pathValue);
    return entry.isDirectory() || entry.isFile();
  } catch {
    return false;
  }
}

function mergeProjectSettings(paths: string[]): string {
  const merged: Record<string, unknown> = { extensions: ["!*"] };
  for (const settingsPath of paths) {
    const raw = readOptionalFileSync(settingsPath);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (Array.isArray(value)) {
          const current = Array.isArray(merged[key]) ? (merged[key] as unknown[]) : [];
          const entries = absolutizeLocalEntries(value, dirname(settingsPath));
          merged[key] = key === "extensions"
            ? [...current, ...entries, ...forceIncludeExtensionEntries(entries)]
            : [...current, ...entries];
        } else if (merged[key] === undefined) {
          merged[key] = value;
        }
      }
    } catch {
      // Let Pi ignore malformed project settings as an empty project surface.
    }
  }
  return JSON.stringify(merged);
}

function forceIncludeExtensionEntries(entries: unknown[]): string[] {
  return entries
    .filter((entry): entry is string => typeof entry === "string" && !isOverridePattern(entry))
    .map((entry) => `+${entry}`);
}

function absolutizeLocalEntries(entries: unknown[], baseDir: string): unknown[] {
  return entries.map((entry) => {
    if (typeof entry === "string") {
      return isLocalSource(entry) ? resolve(baseDir, entry) : entry;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      return typeof record.source === "string" && isLocalSource(record.source)
        ? { ...record, source: resolve(baseDir, record.source) }
        : entry;
    }
    return entry;
  });
}

function isOverridePattern(entry: string): boolean {
  return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");
}

function isLocalSource(source: string): boolean {
  const trimmed = source.trim();
  return trimmed.startsWith(".") || trimmed.startsWith("/") || trimmed.startsWith("~");
}

function filterInsideTrustRoot(paths: Array<string | undefined>, trustRoot: string | undefined): string[] {
  if (!trustRoot) return [];
  return paths.filter((pathValue): pathValue is string => typeof pathValue === "string" && isPathInside(pathValue, trustRoot));
}

function uniqueRealPaths(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const pathValue of paths) {
    if (!pathValue) continue;
    const normalized = normalizeExistingPath(pathValue);
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeExistingPath(pathValue: string): string {
  try {
    return realpathSync(pathValue);
  } catch {
    return resolve(pathValue);
  }
}

function readOptionalFileSync(pathValue: string): string | undefined {
  try {
    return readFileSync(pathValue, "utf-8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function writeOptionalFileSync(pathValue: string, content: string | undefined): void {
  if (content === undefined) return;
  mkdirSync(dirname(pathValue), { recursive: true });
  writeFileSync(pathValue, content, "utf-8");
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function isInlinePath(pathValue: string): boolean {
  return pathValue.trim().startsWith("<inline");
}

function isPathInside(pathValue: string, rootPath: string): boolean {
  const normalizedPath = resolve(pathValue);
  const normalizedRoot = resolve(rootPath);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}
