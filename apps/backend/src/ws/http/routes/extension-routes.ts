import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { DiscoveredExtensionMetadata, SettingsExtensionsResponse } from "@forge/protocol";
import { getProfilePiExtensionsDir, getProfilesDir } from "../../../swarm/data-paths.js";
import { buildProjectExecutableTrustPlan } from "../../../swarm/project-executable-trust.js";
import { ProjectResourceSettingsStore } from "../../../swarm/project-resource-settings.js";
import { ProjectWorkspaceResolver } from "../../../swarm/project-workspace-resolver.js";
import type { SwarmManager } from "../../../swarm/swarm-manager.js";
import { applyCorsHeaders, sendJson } from "../../http-utils.js";
import type { HttpRoute } from "../shared/http-route.js";

const SETTINGS_EXTENSIONS_ENDPOINT_PATH = "/api/settings/extensions";
const SETTINGS_EXTENSIONS_METHODS = "GET, OPTIONS";

const PI_DISCOVERY_SOURCE_SORT_ORDER: Record<DiscoveredExtensionMetadata["source"], number> = {
  "global-worker": 0,
  "global-manager": 1,
  profile: 2,
  "project-local": 3
};

export function createExtensionRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: SETTINGS_EXTENSIONS_METHODS,
      matches: (pathname) => pathname === SETTINGS_EXTENSIONS_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, SETTINGS_EXTENSIONS_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "GET") {
          applyCorsHeaders(request, response, SETTINGS_EXTENSIONS_METHODS);
          response.setHeader("Allow", SETTINGS_EXTENSIONS_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        const config = swarmManager.getConfig();
        const snapshots = swarmManager.listRuntimeExtensionSnapshots();
        const discovered = await discoverPiExtensionsOnDisk({
          swarmManager,
          dataDir: config.paths.dataDir,
          globalWorkerDir: join(config.paths.agentDir, "extensions"),
          globalManagerDir: join(config.paths.managerAgentDir, "extensions")
        });
        const cwdValues = swarmManager
          .listAgents()
          .map((descriptor) => descriptor.cwd.trim())
          .filter((cwd) => cwd.length > 0);

        const payload: SettingsExtensionsResponse = {
          generatedAt: new Date().toISOString(),
          discovered,
          snapshots,
          directories: {
            globalWorker: join(config.paths.agentDir, "extensions"),
            globalManager: join(config.paths.managerAgentDir, "extensions"),
            profileTemplate: join(getProfilesDir(config.paths.dataDir), "<profileId>", "pi", "extensions"),
            projectLocalRelative: ".pi/extensions"
          },
          forge: await swarmManager.buildForgeExtensionSettingsSnapshot({ cwdValues })
        };

        applyCorsHeaders(request, response, SETTINGS_EXTENSIONS_METHODS);
        sendJson(response, 200, payload as unknown as Record<string, unknown>);
      }
    }
  ];
}

async function discoverPiExtensionsOnDisk(options: {
  swarmManager: SwarmManager;
  dataDir: string;
  globalWorkerDir: string;
  globalManagerDir: string;
}): Promise<DiscoveredExtensionMetadata[]> {
  const discovered: DiscoveredExtensionMetadata[] = [];

  await collectPiExtensionsFromDirectory(options.globalWorkerDir, "global-worker", discovered);
  await collectPiExtensionsFromDirectory(options.globalManagerDir, "global-manager", discovered);

  const profileIds = await listProfileIds(options.dataDir);
  for (const profileId of profileIds) {
    await collectPiExtensionsFromDirectory(getProfilePiExtensionsDir(options.dataDir, profileId), "profile", discovered, {
      profileId
    });
  }

  const resolver = new ProjectWorkspaceResolver({
    dataDir: options.dataDir,
    settingsStore: new ProjectResourceSettingsStore(options.dataDir)
  });
  for (const descriptor of options.swarmManager
    .listAgents()
    .filter((entry) => entry.role === "manager" && !entry.collab)
    .sort((left, right) => left.agentId.localeCompare(right.agentId))) {
    const resolution = await resolver.resolve({
      profileId: descriptor.profileId ?? descriptor.agentId,
      sessionAgentId: descriptor.agentId,
      cwd: descriptor.cwd
    });
    const trustPlan = buildProjectExecutableTrustPlan({ resolution, cwd: descriptor.cwd });
    for (const extensionsDir of trustPlan.trustedPiExtensionDirs) {
      await collectPiExtensionsFromDirectory(extensionsDir, "project-local", discovered, { cwd: descriptor.cwd });
    }
    for (const settingsPath of trustPlan.trustedPiSettingsPaths) {
      await collectPiPackageExtensionsFromSettings(settingsPath, "project-local", discovered, { cwd: descriptor.cwd });
    }
  }

  return dedupeAndSortDiscoveredPiExtensions(discovered);
}

async function collectPiExtensionsFromDirectory(
  extensionsDir: string,
  source: DiscoveredExtensionMetadata["source"],
  target: DiscoveredExtensionMetadata[],
  metadata?: {
    profileId?: string;
    cwd?: string;
  }
): Promise<void> {
  const entries = await readDirEntries(extensionsDir);
  if (!entries) {
    return;
  }

  for (const entry of entries) {
    const entryPath = join(extensionsDir, entry.name);

    if (entry.isFile() && isSupportedExtensionFile(entry.name)) {
      target.push({
        displayName: normalizeExtensionDisplayName(entryPath),
        path: entryPath,
        source,
        profileId: metadata?.profileId,
        cwd: metadata?.cwd
      });
      continue;
    }

    if (!entry.isDirectory()) {
      continue;
    }

    const indexTsPath = join(entryPath, "index.ts");
    const indexJsPath = join(entryPath, "index.js");

    if (await isFile(indexTsPath)) {
      target.push({
        displayName: normalizeExtensionDisplayName(indexTsPath),
        path: indexTsPath,
        source,
        profileId: metadata?.profileId,
        cwd: metadata?.cwd
      });
      continue;
    }

    if (await isFile(indexJsPath)) {
      target.push({
        displayName: normalizeExtensionDisplayName(indexJsPath),
        path: indexJsPath,
        source,
        profileId: metadata?.profileId,
        cwd: metadata?.cwd
      });
    }
  }
}

async function collectPiPackageExtensionsFromSettings(
  settingsPath: string,
  source: DiscoveredExtensionMetadata["source"],
  target: DiscoveredExtensionMetadata[],
  metadata?: { profileId?: string; cwd?: string }
): Promise<void> {
  const settings = await readJsonObject(settingsPath);
  const settingsDir = dirname(settingsPath);
  const packages = Array.isArray(settings?.packages) ? settings.packages : [];
  for (const entry of packages) {
    const packageSource = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.source === "string" ? entry.source : undefined;
    if (!packageSource || !isLocalPackageSource(packageSource)) continue;
    const configuredExtensions = isRecord(entry) && Array.isArray(entry.extensions)
      ? entry.extensions.filter((value): value is string => typeof value === "string")
      : undefined;
    if (configuredExtensions?.length === 0) continue;
    const packageRoot = resolvePackageSourcePath(packageSource, settingsDir);
    const packageEntry = await statOrUndefined(packageRoot);
    if (packageEntry?.isFile()) {
      await collectPiExtensionPath(packageRoot, source, target, metadata);
      continue;
    }
    if (packageEntry && !packageEntry.isDirectory()) continue;
    if (configuredExtensions) {
      for (const extensionPath of configuredExtensions) {
        await collectPiExtensionPath(resolve(packageRoot, extensionPath), source, target, metadata);
      }
      continue;
    }
    const manifest = await readJsonObject(join(packageRoot, "package.json"));
    const piManifest = isRecord(manifest?.pi) ? manifest.pi : undefined;
    const manifestExtensions = Array.isArray(piManifest?.extensions)
      ? piManifest.extensions.filter((value): value is string => typeof value === "string")
      : [];
    if (manifestExtensions.length > 0) {
      for (const extensionPath of manifestExtensions) {
        await collectPiExtensionPath(resolve(packageRoot, extensionPath), source, target, metadata);
      }
    } else {
      await collectPiExtensionsFromDirectory(join(packageRoot, "extensions"), source, target, metadata);
    }
  }
}

async function collectPiExtensionPath(
  pathValue: string,
  source: DiscoveredExtensionMetadata["source"],
  target: DiscoveredExtensionMetadata[],
  metadata?: { profileId?: string; cwd?: string }
): Promise<void> {
  if (await isFile(pathValue)) {
    if (!isSupportedExtensionFile(pathValue)) return;
    target.push({
      displayName: normalizeExtensionDisplayName(pathValue),
      path: pathValue,
      source,
      profileId: metadata?.profileId,
      cwd: metadata?.cwd
    });
    return;
  }
  await collectPiExtensionsFromDirectory(pathValue, source, target, metadata);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

async function listProfileIds(dataDir: string): Promise<string[]> {
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

function dedupeAndSortDiscoveredPiExtensions(
  extensions: DiscoveredExtensionMetadata[]
): DiscoveredExtensionMetadata[] {
  const unique = new Map<string, DiscoveredExtensionMetadata>();

  for (const extension of extensions) {
    const key = [extension.source, toComparablePath(extension.path), extension.profileId ?? "", extension.cwd ?? ""].join(
      "::"
    );

    if (!unique.has(key)) {
      unique.set(key, extension);
    }
  }

  return Array.from(unique.values()).sort((left, right) => {
    const bySource = PI_DISCOVERY_SOURCE_SORT_ORDER[left.source] - PI_DISCOVERY_SOURCE_SORT_ORDER[right.source];
    if (bySource !== 0) {
      return bySource;
    }

    const byProfile = (left.profileId ?? "").localeCompare(right.profileId ?? "");
    if (byProfile !== 0) {
      return byProfile;
    }

    const byCwd = (left.cwd ?? "").localeCompare(right.cwd ?? "");
    if (byCwd !== 0) {
      return byCwd;
    }

    const byDisplay = left.displayName.localeCompare(right.displayName);
    if (byDisplay !== 0) {
      return byDisplay;
    }

    return left.path.localeCompare(right.path);
  });
}

function normalizeExtensionDisplayName(pathValue: string): string {
  const baseName = basename(pathValue);
  if (baseName.toLowerCase() === "index.ts" || baseName.toLowerCase() === "index.js") {
    return basename(dirname(pathValue));
  }
  return baseName;
}

function isSupportedExtensionFile(fileName: string): boolean {
  const normalized = fileName.toLowerCase();
  return normalized.endsWith(".ts") || normalized.endsWith(".js");
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

function isEnoentError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR")
  );
}

function toComparablePath(pathValue: string): string {
  const resolved = resolve(pathValue);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
