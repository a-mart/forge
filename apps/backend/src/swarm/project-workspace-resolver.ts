import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  getProjectForgeExtensionsDir,
  getProjectForgePiExtensionsDir,
  getProjectForgePiSettingsPath,
  getProjectForgeReferenceDir,
  getProjectForgeSkillsDir,
  getProjectForgeSpecialistsDir
} from "./data-paths.js";
import { ProjectResourceSettingsStore } from "./project-resource-settings.js";

const execFileAsync = promisify(execFile);

export type ProjectWorkspaceSource = "git-root" | "override" | "none";
export type ProjectExecutableTrustSnapshot = {
  state: "trusted" | "blocked" | "untrusted" | "not_applicable";
  key?: string;
};

export type LegacyExecutableSurface = {
  kind: "exact-cwd-forge-extension" | "exact-cwd-pi-extension" | "exact-cwd-pi-settings";
  path: string;
  activeToday: boolean;
  compatibilityPolicy: "preserve-with-warning" | "do-not-create";
  coveredByTrustKey?: string;
};

export interface ProjectWorkspaceResolution {
  profileId: string;
  sessionAgentId: string;
  cwdRealpath: string;
  detectedGitRoot?: string;
  workspaceKey: string;
  defaultForgeDir?: string;
  effectiveForgeDir?: string;
  effectiveForgeDirRealpath?: string;
  source: ProjectWorkspaceSource;
  override?: { path: string; valid: boolean; error?: string };
  trust: ProjectExecutableTrustSnapshot;
  repoRootResources: {
    skillsDir?: string;
    specialistsDir?: string;
    referenceDir?: string;
    forgeExtensionsDir?: string;
    piExtensionsDir?: string;
    piRoleExtensionDirs?: string[];
    piSettingsPath?: string;
  };
  legacyExecutableSurfaces: LegacyExecutableSurface[];
  signature: string;
}

export interface ProjectWorkspaceResolverOptions {
  dataDir: string;
  settingsStore?: ProjectResourceSettingsStore;
}

export interface ResolveProjectWorkspaceOptions {
  profileId: string;
  sessionAgentId: string;
  cwd: string;
}

export class ProjectWorkspaceResolver {
  private readonly settingsStore: ProjectResourceSettingsStore;

  constructor(options: ProjectWorkspaceResolverOptions) {
    this.settingsStore = options.settingsStore ?? new ProjectResourceSettingsStore(options.dataDir);
  }

  async resolve(options: ResolveProjectWorkspaceOptions): Promise<ProjectWorkspaceResolution> {
    const cwdRealpath = await resolveExistingRealpath(options.cwd);
    const detectedGitRoot = await findGitRoot(cwdRealpath);
    const detectedGitRootRealpath = detectedGitRoot ? await resolveExistingRealpath(detectedGitRoot) : undefined;
    const workspaceBasis = detectedGitRootRealpath ?? cwdRealpath;
    const workspaceKey = createWorkspaceKey(options.profileId, workspaceBasis);
    const defaultForgeDir = detectedGitRootRealpath ? join(detectedGitRootRealpath, ".forge") : undefined;

    const storedOverride = await this.settingsStore.getOverride(workspaceKey);
    const override = storedOverride ? await validateOverride(storedOverride.forgeDir) : undefined;
    const effectiveForgeDir = override?.valid ? override.path : defaultForgeDir;
    const source: ProjectWorkspaceSource = override?.valid ? "override" : defaultForgeDir ? "git-root" : "none";
    const effectiveForgeDirRealpath = effectiveForgeDir ? await tryRealpath(effectiveForgeDir) : undefined;
    const trust = await this.resolveTrust(effectiveForgeDirRealpath);
    const repoRootResources = effectiveForgeDirRealpath
      ? {
          skillsDir: getProjectForgeSkillsDir(effectiveForgeDirRealpath),
          specialistsDir: getProjectForgeSpecialistsDir(effectiveForgeDirRealpath),
          referenceDir: getProjectForgeReferenceDir(effectiveForgeDirRealpath),
          forgeExtensionsDir: getProjectForgeExtensionsDir(effectiveForgeDirRealpath),
          piExtensionsDir: getProjectForgePiExtensionsDir(effectiveForgeDirRealpath),
          piRoleExtensionDirs: [],
          piSettingsPath: getProjectForgePiSettingsPath(effectiveForgeDirRealpath)
        }
      : {};
    const legacyExecutableSurfaces = buildLegacyExecutableSurfaces({
      cwdRealpath,
      workspaceBasis,
      trustKey: trust.key
    });
    const signature = await buildResolutionSignature({
      cwdRealpath,
      detectedGitRoot: detectedGitRootRealpath,
      effectiveForgeDirRealpath,
      repoRootResources,
      legacyExecutableSurfaces
    });

    return {
      profileId: options.profileId,
      sessionAgentId: options.sessionAgentId,
      cwdRealpath,
      ...(detectedGitRootRealpath ? { detectedGitRoot: detectedGitRootRealpath } : {}),
      workspaceKey,
      ...(defaultForgeDir ? { defaultForgeDir } : {}),
      ...(effectiveForgeDir ? { effectiveForgeDir } : {}),
      ...(effectiveForgeDirRealpath ? { effectiveForgeDirRealpath } : {}),
      source,
      ...(override ? { override } : {}),
      trust,
      repoRootResources,
      legacyExecutableSurfaces,
      signature
    };
  }

  private async resolveTrust(effectiveForgeDirRealpath?: string): Promise<ProjectExecutableTrustSnapshot> {
    if (!effectiveForgeDirRealpath) {
      return { state: "not_applicable" };
    }

    const trust = await this.settingsStore.getTrust(effectiveForgeDirRealpath);
    if (!trust) {
      return { state: "untrusted", key: effectiveForgeDirRealpath };
    }
    return { state: trust.state, key: effectiveForgeDirRealpath };
  }
}

export function createWorkspaceKey(profileId: string, workspaceBasisRealpath: string): string {
  return `${profileId}::${normalizeComparablePath(workspaceBasisRealpath)}`;
}

async function validateOverride(pathValue: string): Promise<{ path: string; valid: boolean; error?: string }> {
  const overridePath = resolve(pathValue);
  if (basename(overridePath) !== ".forge") {
    return { path: overridePath, valid: false, error: "Override directory must be named .forge" };
  }

  try {
    const entry = await lstat(overridePath);
    if (!entry.isDirectory()) {
      return { path: overridePath, valid: false, error: "Override path is not a directory" };
    }
    return { path: await realpath(overridePath), valid: true };
  } catch (error) {
    if (isEnoentError(error)) {
      return { path: overridePath, valid: false, error: "Override directory does not exist" };
    }
    throw error;
  }
}

function buildLegacyExecutableSurfaces(options: {
  cwdRealpath: string;
  workspaceBasis: string;
  trustKey?: string;
}): LegacyExecutableSurface[] {
  const coveredByTrustKey = isPathAtOrUnder(options.cwdRealpath, options.workspaceBasis) ? options.trustKey : undefined;
  return [
    {
      kind: "exact-cwd-forge-extension",
      path: join(options.cwdRealpath, ".forge", "extensions"),
      activeToday: true,
      compatibilityPolicy: "preserve-with-warning",
      ...(coveredByTrustKey ? { coveredByTrustKey } : {})
    },
    {
      kind: "exact-cwd-pi-extension",
      path: join(options.cwdRealpath, ".pi", "extensions"),
      activeToday: true,
      compatibilityPolicy: "preserve-with-warning",
      ...(coveredByTrustKey ? { coveredByTrustKey } : {})
    },
    {
      kind: "exact-cwd-pi-settings",
      path: join(options.cwdRealpath, ".pi", "settings.json"),
      activeToday: true,
      compatibilityPolicy: "preserve-with-warning",
      ...(coveredByTrustKey ? { coveredByTrustKey } : {})
    }
  ];
}

async function buildResolutionSignature(options: {
  cwdRealpath: string;
  detectedGitRoot?: string;
  effectiveForgeDirRealpath?: string;
  repoRootResources: ProjectWorkspaceResolution["repoRootResources"];
  legacyExecutableSurfaces: LegacyExecutableSurface[];
}): Promise<string> {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    cwdRealpath: normalizeComparablePath(options.cwdRealpath),
    detectedGitRoot: options.detectedGitRoot ? normalizeComparablePath(options.detectedGitRoot) : null,
    effectiveForgeDirRealpath: options.effectiveForgeDirRealpath
      ? normalizeComparablePath(options.effectiveForgeDirRealpath)
      : null
  }));

  const candidates = [
    options.repoRootResources.forgeExtensionsDir,
    options.repoRootResources.piExtensionsDir,
    options.repoRootResources.piSettingsPath,
    ...options.legacyExecutableSurfaces.map((surface) => surface.path)
  ].filter((pathValue): pathValue is string => typeof pathValue === "string");

  for (const pathValue of candidates.sort((left, right) => left.localeCompare(right))) {
    hash.update(await pathSignature(pathValue));
  }

  return hash.digest("hex");
}

async function pathSignature(pathValue: string): Promise<string> {
  try {
    const entry = await stat(pathValue);
    return `${normalizeComparablePath(pathValue)}:${entry.isDirectory() ? "dir" : "file"}:${entry.mtimeMs}:${entry.size}`;
  } catch (error) {
    if (isEnoentError(error)) {
      return `${normalizeComparablePath(pathValue)}:missing`;
    }
    throw error;
  }
}

async function findGitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeout: 5000,
      windowsHide: true
    });
    const root = stdout.trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
}

async function resolveExistingRealpath(pathValue: string): Promise<string> {
  return realpath(resolve(pathValue));
}

async function tryRealpath(pathValue: string): Promise<string | undefined> {
  try {
    return await realpath(resolve(pathValue));
  } catch (error) {
    if (isEnoentError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isPathAtOrUnder(pathValue: string, parent: string): boolean {
  const normalizedPath = withTrailingSeparator(normalizeComparablePath(pathValue));
  const normalizedParent = withTrailingSeparator(normalizeComparablePath(parent));
  return normalizedPath === normalizedParent || normalizedPath.startsWith(normalizedParent);
}

function withTrailingSeparator(pathValue: string): string {
  return pathValue.endsWith(sep) ? pathValue : `${pathValue}${sep}`;
}

function normalizeComparablePath(pathValue: string): string {
  const normalized = normalize(resolve(pathValue));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isEnoentError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
