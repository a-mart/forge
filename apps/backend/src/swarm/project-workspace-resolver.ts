import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  getProjectForgeExtensionsDir,
  getProjectForgePiExtensionsDir,
  getProjectForgePiSettingsPath,
  getProjectForgeProjectAgentsDir,
  getProjectForgeReferenceDir,
  getProjectForgeSkillsDir,
  getProjectForgeSpecialistsDir
} from "./data-paths.js";
import { resolveLocalPiPackageExtensionPathsFromSettings } from "./project-pi-package-extensions.js";
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

export interface ProjectPassiveWorkspaceResolution {
  profileId: string;
  sessionAgentId: string;
  cwdRealpath: string;
  detectedGitRoot?: string;
  workspaceKey: string;
  warning?: string;
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
    projectAgentsDir?: string;
    forgeExtensionsDir?: string;
    piExtensionsDir?: string;
    piRoleExtensionDirs?: string[];
    piSettingsPath?: string;
  };
}

export interface ProjectWorkspaceResolution extends ProjectPassiveWorkspaceResolution {
  profileId: string;
  sessionAgentId: string;
  cwdRealpath: string;
  detectedGitRoot?: string;
  workspaceKey: string;
  warning?: string;
  defaultForgeDir?: string;
  effectiveForgeDir?: string;
  effectiveForgeDirRealpath?: string;
  source: ProjectWorkspaceSource;
  override?: { path: string; valid: boolean; error?: string };
  trust: ProjectExecutableTrustSnapshot;
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

  async resolvePassive(options: ResolveProjectWorkspaceOptions): Promise<ProjectPassiveWorkspaceResolution> {
    const cwdRealpathResult = await tryResolveExistingRealpath(options.cwd);
    if (!cwdRealpathResult.ok) {
      return buildMissingCwdResolution(options, cwdRealpathResult.path, cwdRealpathResult.error);
    }

    const cwdRealpath = cwdRealpathResult.path;
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
          projectAgentsDir: getProjectForgeProjectAgentsDir(effectiveForgeDirRealpath),
          forgeExtensionsDir: getProjectForgeExtensionsDir(effectiveForgeDirRealpath),
          piExtensionsDir: getProjectForgePiExtensionsDir(effectiveForgeDirRealpath),
          piRoleExtensionDirs: [],
          piSettingsPath: getProjectForgePiSettingsPath(effectiveForgeDirRealpath)
        }
      : {};

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
    };
  }

  async resolve(options: ResolveProjectWorkspaceOptions): Promise<ProjectWorkspaceResolution> {
    const passive = await this.resolvePassive(options);
    const cwdRealpath = passive.cwdRealpath;
    if (passive.warning && passive.source === "none") {
      const signature = createHash("sha256")
        .update(JSON.stringify({ cwdRealpath: normalizeComparablePath(cwdRealpath), missing: true, warning: passive.warning }))
        .digest("hex");
      return { ...passive, legacyExecutableSurfaces: [], signature };
    }

    const detectedGitRootRealpath = passive.detectedGitRoot;
    const effectiveForgeDirRealpath = passive.effectiveForgeDirRealpath;
    const repoRootResources = passive.repoRootResources;
    const legacyExecutableSurfaces = buildLegacyExecutableSurfaces(cwdRealpath, effectiveForgeDirRealpath, passive.trust.state === "trusted");
    const signature = await buildResolutionSignature({
      cwdRealpath,
      detectedGitRoot: detectedGitRootRealpath,
      effectiveForgeDirRealpath,
      repoRootResources,
      legacyExecutableSurfaces
    });

    return {
      ...passive,
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
    const entry = await stat(overridePath);
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

function buildLegacyExecutableSurfaces(
  cwdRealpath: string,
  effectiveForgeDirRealpath: string | undefined,
  trusted: boolean
): LegacyExecutableSurface[] {
  const legacyPaths = [
    { kind: "exact-cwd-forge-extension" as const, path: join(cwdRealpath, ".forge", "extensions") },
    { kind: "exact-cwd-pi-extension" as const, path: join(cwdRealpath, ".pi", "extensions") },
    { kind: "exact-cwd-pi-settings" as const, path: join(cwdRealpath, ".pi", "settings.json") }
  ];
  return legacyPaths.map((surface) => ({
    ...surface,
    activeToday: trusted && !!effectiveForgeDirRealpath && isPathInside(surface.path, effectiveForgeDirRealpath),
    compatibilityPolicy: "preserve-with-warning" as const
  }));
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

  const activeLegacySurfaces = options.legacyExecutableSurfaces.filter((surface) => surface.activeToday);
  const executableRoots = [
    options.repoRootResources.forgeExtensionsDir,
    options.repoRootResources.piExtensionsDir,
    ...activeLegacySurfaces
      .filter((surface) => surface.kind !== "exact-cwd-pi-settings")
      .map((surface) => surface.path)
  ].filter((pathValue): pathValue is string => typeof pathValue === "string");

  const executableSettingsPaths = [
    options.repoRootResources.piSettingsPath,
    ...activeLegacySurfaces
      .filter((surface) => surface.kind === "exact-cwd-pi-settings")
      .map((surface) => surface.path)
  ].filter((pathValue): pathValue is string => typeof pathValue === "string");

  const entries: string[] = [];
  for (const pathValue of executableRoots) {
    entries.push(...(await fingerprintExecutableRoot(pathValue)));
  }
  for (const settingsPath of executableSettingsPaths) {
    entries.push(...(await fingerprintPiSettingsExecutableSurface(settingsPath)));
  }

  for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
    hash.update(entry);
  }

  return hash.digest("hex");
}

async function fingerprintExecutableRoot(rootPath: string): Promise<string[]> {
  const entries: string[] = [];
  await fingerprintPath(rootPath, entries);
  return entries;
}

async function fingerprintPath(pathValue: string, target: string[]): Promise<void> {
  const comparablePath = normalizeComparablePath(pathValue);
  try {
    const entry = await stat(pathValue);
    if (entry.isDirectory()) {
      target.push(`${comparablePath}:dir:${entry.mtimeMs}:${entry.size}`);
      const children = await readdir(pathValue);
      for (const child of children.sort((left, right) => left.localeCompare(right))) {
        await fingerprintPath(join(pathValue, child), target);
      }
      return;
    }

    if (entry.isFile()) {
      const content = await readFile(pathValue);
      const digest = createHash("sha256").update(content).digest("hex");
      target.push(`${comparablePath}:file:${entry.mtimeMs}:${entry.size}:${digest}`);
      return;
    }

    target.push(`${comparablePath}:other:${entry.mtimeMs}:${entry.size}`);
  } catch (error) {
    if (isEnoentError(error)) {
      target.push(`${comparablePath}:missing`);
      return;
    }
    throw error;
  }
}

async function fingerprintPiSettingsExecutableSurface(settingsPath: string): Promise<string[]> {
  const entries: string[] = [];
  await fingerprintPath(settingsPath, entries);
  for (const extensionPath of await resolveLocalPiPackageExtensionPathsFromSettings(settingsPath)) {
    await fingerprintPath(extensionPath, entries);
  }
  return entries;
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

async function buildMissingCwdResolution(
  options: ResolveProjectWorkspaceOptions,
  cwdPath: string,
  error: string
): Promise<ProjectWorkspaceResolution> {
  const workspaceKey = createWorkspaceKey(options.profileId, cwdPath);
  const signature = createHash("sha256")
    .update(JSON.stringify({ cwdRealpath: normalizeComparablePath(cwdPath), missing: true, error }))
    .digest("hex");

  return {
    profileId: options.profileId,
    sessionAgentId: options.sessionAgentId,
    cwdRealpath: cwdPath,
    workspaceKey,
    warning: `Session working directory is unavailable: ${error}`,
    source: "none",
    trust: { state: "not_applicable" },
    repoRootResources: {},
    legacyExecutableSurfaces: [],
    signature
  };
}

async function resolveExistingRealpath(pathValue: string): Promise<string> {
  return realpath(resolve(pathValue));
}

async function tryResolveExistingRealpath(pathValue: string): Promise<{ ok: true; path: string } | { ok: false; path: string; error: string }> {
  try {
    return { ok: true, path: await resolveExistingRealpath(pathValue) };
  } catch (error) {
    if (isEnoentError(error)) {
      return { ok: false, path: resolve(pathValue), error: "path does not exist" };
    }
    return { ok: false, path: resolve(pathValue), error: error instanceof Error ? error.message : "unknown error" };
  }
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

function normalizeComparablePath(pathValue: string): string {
  const normalized = normalize(resolve(pathValue));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathInside(pathValue: string, rootPath: string): boolean {
  const normalizedPath = resolve(pathValue);
  const normalizedRoot = resolve(rootPath);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function isEnoentError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

