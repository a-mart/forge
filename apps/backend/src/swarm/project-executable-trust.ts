import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  repoForgeExtensionsDir?: string;
  repoPiExtensionsDir?: string;
  repoPiSettingsPath?: string;
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
    return { trusted: false };
  }

  const resolution = await new ProjectWorkspaceResolver({
    dataDir: options.config.paths.dataDir,
    settingsStore: new ProjectResourceSettingsStore(options.config.paths.dataDir)
  }).resolve({ profileId, sessionAgentId, cwd });
  const trusted = resolution.trust.state === "trusted";
  return {
    resolution,
    trusted,
    effectiveForgeDirRealpath: resolution.effectiveForgeDirRealpath,
    repoForgeExtensionsDir: trusted ? resolution.repoRootResources.forgeExtensionsDir : undefined,
    repoPiExtensionsDir: trusted ? resolution.repoRootResources.piExtensionsDir : undefined,
    repoPiSettingsPath: trusted ? resolution.repoRootResources.piSettingsPath : undefined
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
        join(options.descriptor.cwd, ".pi", "extensions"),
        join(options.descriptor.cwd, ".pi", "local-package"),
        options.trustPlan.resolution?.repoRootResources.piExtensionsDir,
        options.trustPlan.resolution?.repoRootResources.forgeExtensionsDir,
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
  projectSettingsPath?: string;
  projectExecutablesTrusted: boolean;
}): SettingsStorage {
  const globalSettingsPath = join(options.agentDir, "settings.json");
  const projectSettingsPath = options.projectExecutablesTrusted && options.projectSettingsPath
    ? options.projectSettingsPath
    : undefined;
  return {
    withLock(scope, fn) {
      const current = scope === "global"
        ? readOptionalFileSync(globalSettingsPath)
        : projectSettingsPath
          ? readOptionalFileSync(projectSettingsPath)
          : JSON.stringify({ packages: [], extensions: ["!*"], skills: [], prompts: [], themes: [] });
      const next = fn(current);
      if (scope === "global") {
        writeOptionalFileSync(globalSettingsPath, next);
      } else if (projectSettingsPath) {
        writeOptionalFileSync(projectSettingsPath, next);
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
