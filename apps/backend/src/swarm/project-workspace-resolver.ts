import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, resolve } from "node:path";
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
          forgeExtensionsDir: getProjectForgeExtensionsDir(effectiveForgeDirRealpath),
          piExtensionsDir: getProjectForgePiExtensionsDir(effectiveForgeDirRealpath),
          piRoleExtensionDirs: [],
          piSettingsPath: getProjectForgePiSettingsPath(effectiveForgeDirRealpath)
        }
      : {};
    const legacyExecutableSurfaces = buildLegacyExecutableSurfaces(cwdRealpath);
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

function buildLegacyExecutableSurfaces(cwdRealpath: string): LegacyExecutableSurface[] {
  return [
    {
      kind: "exact-cwd-forge-extension",
      path: join(cwdRealpath, ".forge", "extensions"),
      activeToday: true,
      compatibilityPolicy: "preserve-with-warning"
    },
    {
      kind: "exact-cwd-pi-extension",
      path: join(cwdRealpath, ".pi", "extensions"),
      activeToday: true,
      compatibilityPolicy: "preserve-with-warning"
    },
    {
      kind: "exact-cwd-pi-settings",
      path: join(cwdRealpath, ".pi", "settings.json"),
      activeToday: true,
      compatibilityPolicy: "preserve-with-warning"
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

  const executableRoots = [
    options.repoRootResources.forgeExtensionsDir,
    options.repoRootResources.piExtensionsDir,
    ...options.legacyExecutableSurfaces
      .filter((surface) => surface.kind !== "exact-cwd-pi-settings")
      .map((surface) => surface.path)
  ].filter((pathValue): pathValue is string => typeof pathValue === "string");

  const executableSettingsPaths = [
    options.repoRootResources.piSettingsPath,
    ...options.legacyExecutableSurfaces
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
  const settings = await readJsonObject(settingsPath);
  if (!settings) {
    return entries;
  }

  const settingsDir = dirname(settingsPath);
  for (const packageRoot of collectLocalPackageRoots(settings.packages, settingsDir)) {
    entries.push(...(await fingerprintPiPackageExtensions(packageRoot)));
  }
  return entries;
}

async function fingerprintPiPackageExtensions(packageRoot: string): Promise<string[]> {
  const entries: string[] = [];
  const manifest = await readJsonObject(join(packageRoot, "package.json"));
  const piManifest = isRecord(manifest?.pi) ? manifest.pi : undefined;
  const manifestExtensions = getStringArray(piManifest?.extensions);

  if (manifestExtensions.length > 0) {
    for (const extensionPath of manifestExtensions) {
      await fingerprintPath(resolve(packageRoot, extensionPath), entries);
    }
    return entries;
  }

  await fingerprintPath(join(packageRoot, "extensions"), entries);
  return entries;
}

function collectLocalPackageRoots(packages: unknown, settingsDir: string): string[] {
  if (!Array.isArray(packages)) {
    return [];
  }

  const roots: string[] = [];
  for (const entry of packages) {
    const source = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.source === "string" ? entry.source : undefined;
    if (!source || !isLocalPackageSource(source)) {
      continue;
    }
    roots.push(resolvePackageSourcePath(source, settingsDir));
  }
  return roots;
}

function resolvePackageSourcePath(source: string, settingsDir: string): string {
  const trimmed = source.trim();
  if (trimmed === "~") {
    return resolve(getHomeDirectory());
  }
  if (trimmed.startsWith("~/")) {
    return resolve(getHomeDirectory(), trimmed.slice(2));
  }
  if (trimmed.startsWith("~")) {
    return resolve(getHomeDirectory(), trimmed.slice(1));
  }
  return resolve(settingsDir, trimmed);
}

function getHomeDirectory(): string {
  return homedir() || process.env.HOME || process.env.USERPROFILE || "";
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

function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

async function readJsonObject(pathValue: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(pathValue, "utf-8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if (isEnoentError(error) || error instanceof SyntaxError) {
      return undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isEnoentError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
