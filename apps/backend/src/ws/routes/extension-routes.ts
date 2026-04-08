import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { DiscoveredExtensionMetadata, SettingsExtensionsResponse } from "@forge/protocol";
import { getProfilePiExtensionsDir, getProfilesDir } from "../../swarm/data-paths.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { applyCorsHeaders, sendJson } from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

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

  const cwdValues = new Set(
    options.swarmManager
      .listAgents()
      .map((descriptor) => descriptor.cwd.trim())
      .filter((cwd) => cwd.length > 0)
  );

  for (const cwd of Array.from(cwdValues).sort((left, right) => left.localeCompare(right))) {
    await collectPiExtensionsFromDirectory(join(cwd, ".pi", "extensions"), "project-local", discovered, { cwd });
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

function toComparablePath(pathValue: string): string {
  const resolved = resolve(pathValue);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
