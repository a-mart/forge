import { join, resolve } from "node:path";
import type {
  ForgeDiscoveredExtensionMetadata,
  ForgeRuntimeExtensionSnapshot,
  ForgeSettingsExtensionsPayload
} from "@forge/protocol";
import { getGlobalForgeExtensionsDir, getProfilesDir } from "./data-paths.js";
import { discoverForgeExtensions, listForgeProfileIdsOnDisk } from "./forge-extension-discovery.js";
import { loadForgeExtensionModules } from "./forge-extension-loader.js";
import type {
  ForgeDiagnosticErrorRecord,
  ForgePreparedRuntimeBindings,
  ForgeRuntimeType
} from "./forge-extension-types.js";

const MAX_RECENT_ERRORS = 50;

interface ForgeExtensionHostOptions {
  dataDir: string;
  now?: () => string;
  version?: string;
}

export class ForgeExtensionHost {
  private readonly dataDir: string;
  private readonly now: () => string;
  private readonly version: string;
  private readonly runtimeSnapshotsByAgentId = new Map<string, ForgeRuntimeExtensionSnapshot>();
  private readonly recentErrors: ForgeDiagnosticErrorRecord[] = [];

  constructor(options: ForgeExtensionHostOptions) {
    this.dataDir = options.dataDir;
    this.now = options.now ?? (() => new Date().toISOString());
    this.version = options.version ?? process.env.FORGE_APP_VERSION ?? "dev";
  }

  async buildSettingsSnapshot(options: { cwdValues: string[] }): Promise<ForgeSettingsExtensionsPayload> {
    const discovered = await this.discoverForSettings(options.cwdValues);
    const loadResults = await loadForgeExtensionModules(discovered);
    const loadedByKey = new Map(loadResults.loaded.map((entry) => [getDiscoveredKey(entry.discovered), entry]));
    const loadErrorByKey = new Map(loadResults.errors.map((entry) => [getDiscoveredKey(entry.discovered), entry.error]));

    const discoveredWithDiagnostics: ForgeDiscoveredExtensionMetadata[] = discovered.map((entry) => {
      const loaded = loadedByKey.get(getDiscoveredKey(entry));
      return {
        displayName: entry.displayName,
        path: entry.path,
        scope: entry.scope,
        profileId: entry.profileId,
        cwd: entry.cwd,
        name: loaded?.metadata.name,
        description: loaded?.metadata.description,
        loadError: loadErrorByKey.get(getDiscoveredKey(entry))
      };
    });

    return {
      discovered: discoveredWithDiagnostics,
      snapshots: Array.from(this.runtimeSnapshotsByAgentId.values()).map(cloneForgeRuntimeSnapshot),
      recentErrors: this.recentErrors.map((error) => ({ ...error })),
      directories: {
        global: getGlobalForgeExtensionsDir(this.dataDir),
        profileTemplate: join(getProfilesDir(this.dataDir), "<profileId>", "extensions"),
        projectLocalRelative: ".forge/extensions"
      }
    };
  }

  recordDiagnosticError(error: Omit<ForgeDiagnosticErrorRecord, "timestamp"> & { timestamp?: string }): void {
    this.recentErrors.unshift({
      ...error,
      timestamp: error.timestamp ?? this.now()
    });

    if (this.recentErrors.length > MAX_RECENT_ERRORS) {
      this.recentErrors.length = MAX_RECENT_ERRORS;
    }
  }

  async prepareRuntimeBindings(_options: {
    agentId: string;
    runtimeType: ForgeRuntimeType;
    profileId?: string;
    cwd?: string;
  }): Promise<ForgePreparedRuntimeBindings | null> {
    return null;
  }

  activateRuntimeBindings(agentId: string, snapshot: ForgeRuntimeExtensionSnapshot): void {
    this.runtimeSnapshotsByAgentId.set(agentId, cloneForgeRuntimeSnapshot(snapshot));
  }

  deactivateRuntimeBindings(agentId: string): void {
    this.runtimeSnapshotsByAgentId.delete(agentId);
  }

  async dispatchSessionLifecycle(): Promise<void> {
    return undefined;
  }

  async dispatchRuntimeError(): Promise<void> {
    return undefined;
  }

  async dispatchVersioningCommit(): Promise<void> {
    return undefined;
  }

  private async discoverForSettings(cwdValues: string[]): Promise<Awaited<ReturnType<typeof discoverForgeExtensions>>> {
    const discovered = await discoverForgeExtensions({
      dataDir: this.dataDir,
      scopes: ["global"]
    });

    const profileIds = await listForgeProfileIdsOnDisk(this.dataDir);
    for (const profileId of profileIds) {
      discovered.push(
        ...(await discoverForgeExtensions({
          dataDir: this.dataDir,
          scopes: ["profile"],
          profileId
        }))
      );
    }

    for (const cwd of normalizeCwdValues(cwdValues)) {
      discovered.push(
        ...(await discoverForgeExtensions({
          dataDir: this.dataDir,
          scopes: ["project-local"],
          cwd
        }))
      );
    }

    return discovered.sort((left, right) => {
      const byScope = FORGE_SCOPE_SORT_ORDER[left.scope] - FORGE_SCOPE_SORT_ORDER[right.scope];
      if (byScope !== 0) {
        return byScope;
      }

      return toComparablePath(left.path).localeCompare(toComparablePath(right.path));
    });
  }

  getVersion(): string {
    return this.version;
  }
}

const FORGE_SCOPE_SORT_ORDER = {
  global: 0,
  profile: 1,
  "project-local": 2
} as const;

function getDiscoveredKey(entry: {
  path: string;
  scope: string;
  profileId?: string;
  cwd?: string;
}): string {
  return [entry.scope, entry.path, entry.profileId ?? "", entry.cwd ?? ""].join("::");
}

function normalizeCwdValues(cwdValues: string[]): string[] {
  return Array.from(
    new Set(
      cwdValues
        .map((cwd) => cwd.trim())
        .filter((cwd) => cwd.length > 0)
    )
  ).sort((left, right) => left.localeCompare(right));
}

function toComparablePath(pathValue: string): string {
  const resolvedPath = resolve(pathValue.trim());
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function cloneForgeRuntimeSnapshot(snapshot: ForgeRuntimeExtensionSnapshot): ForgeRuntimeExtensionSnapshot {
  return {
    ...snapshot,
    extensions: snapshot.extensions.map((extension) => ({
      ...extension,
      hooks: [...extension.hooks]
    }))
  };
}
