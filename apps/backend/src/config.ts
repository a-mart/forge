import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { normalizeAllowlistRoots } from "./swarm/cwd-policy.js";
import {
  getAgentsStoreFilePath,
  getCollaborationAuthDbPath,
  getCollaborationAuthSecretPath,
  getLegacyAuthDirPath,
  getLegacyAuthFilePath,
  getLegacyMemoryDirPath,
  getLegacySecretsFilePath,
  getLegacySessionsDirPath,
  getProfilesDir,
  getSharedAuthDir,
  getSharedAuthFilePath,
  getSharedCacheDir,
  getSharedCollaborationConfigDir,
  getSharedConfigDir,
  getSharedDir,
  getSharedIntegrationsDir,
  getSharedSecretsFilePath,
  getSharedStateDir,
  getSwarmDir,
  getUploadsDir
} from "./swarm/data-paths.js";
import type { SwarmConfig } from "./swarm/types.js";
import { isCollaborationServerRuntimeTarget, resolveRuntimeTargetFromEnv } from "./runtime-target.js";

export function readPlaywrightDashboardEnvOverride(): boolean | undefined {
  return parseOptionalBooleanEnv(
    process.env.FORGE_PLAYWRIGHT_DASHBOARD_ENABLED ??
      process.env.MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED,
    "FORGE_PLAYWRIGHT_DASHBOARD_ENABLED"
  );
}

export function readTelemetryEnvOverride(): boolean | undefined {
  return parseOptionalBooleanEnv(
    process.env.FORGE_TELEMETRY ?? process.env.MIDDLEMAN_TELEMETRY,
    "FORGE_TELEMETRY"
  );
}

export function createConfig(): SwarmConfig {
  const rootDir = detectRootDir();
  const resourcesDir = resolveResourcesDir(rootDir);
  const dataDir = process.env.FORGE_DATA_DIR ?? process.env.MIDDLEMAN_DATA_DIR ?? resolveDefaultDataDir();
  const managerId = undefined;

  const swarmDir = getSwarmDir(dataDir);
  const uploadsDir = getUploadsDir(dataDir);
  const profilesDir = getProfilesDir(dataDir);
  const sharedDir = getSharedDir(dataDir);
  const sharedConfigDir = getSharedConfigDir(dataDir);
  const sharedCacheDir = getSharedCacheDir(dataDir);
  const sharedStateDir = getSharedStateDir(dataDir);
  const sharedAuthDir = getSharedAuthDir(dataDir);
  const sharedAuthFile = getSharedAuthFilePath(dataDir);
  const sharedSecretsFile = getSharedSecretsFilePath(dataDir);
  const sharedIntegrationsDir = getSharedIntegrationsDir(dataDir);
  const collaborationConfigDir = getSharedCollaborationConfigDir(dataDir);
  const collaborationAuthDbPath = getCollaborationAuthDbPath(dataDir);
  const collaborationAuthSecretPath = getCollaborationAuthSecretPath(dataDir);
  // Legacy flat-layout paths retained for backward compatibility.
  const sessionsDir = getLegacySessionsDirPath(dataDir);
  const authDir = getLegacyAuthDirPath(dataDir);
  const authFile = getLegacyAuthFilePath(dataDir);
  const memoryDir = getLegacyMemoryDirPath(dataDir);
  const secretsFile = getLegacySecretsFilePath(dataDir);

  migrateLegacyPiAuthFileIfNeeded(authFile);

  const agentDir = resolve(dataDir, "agent");
  const managerAgentDir = resolve(agentDir, "manager");
  const repoArchetypesDir = resolve(resourcesDir, ".swarm", "archetypes");
  const memoryFile = undefined;
  const repoMemorySkillFile = resolve(resourcesDir, ".swarm", "skills", "memory", "SKILL.md");
  const defaultCwd = rootDir;

  const cwdAllowlistRoots = normalizeAllowlistRoots([
    rootDir,
    resolve(homedir(), "worktrees")
  ]);

  const isDesktop = parseBooleanEnv(process.env.FORGE_DESKTOP);
  const runtimeTarget = resolveRuntimeTargetFromEnv();
  const adminEmail = parseOptionalStringEnv(
    process.env.FORGE_ADMIN_EMAIL ?? process.env.MIDDLEMAN_ADMIN_EMAIL,
  );
  const adminPassword = parseOptionalStringEnv(
    process.env.FORGE_ADMIN_PASSWORD ?? process.env.MIDDLEMAN_ADMIN_PASSWORD,
  );
  const collaborationAuthSecret = parseOptionalStringEnv(
    process.env.FORGE_COLLABORATION_AUTH_SECRET ?? process.env.MIDDLEMAN_COLLABORATION_AUTH_SECRET,
  );
  const collaborationBaseUrl = parseOptionalStringEnv(
    process.env.FORGE_COLLABORATION_BASE_URL ?? process.env.MIDDLEMAN_COLLABORATION_BASE_URL,
  );
  const collaborationTrustedOrigins = parseOptionalStringListEnv(
    process.env.FORGE_COLLABORATION_TRUSTED_ORIGINS ??
      process.env.MIDDLEMAN_COLLABORATION_TRUSTED_ORIGINS,
  );
  const collaborationModules = isCollaborationServerRuntimeTarget(runtimeTarget)
    ? {
        loadAuthModule: () => import("better-auth"),
        loadDatabaseModule: async () => (await import("better-sqlite3")).default,
      }
    : undefined;

  return {
    host: process.env.FORGE_HOST ?? process.env.MIDDLEMAN_HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.FORGE_PORT ?? process.env.MIDDLEMAN_PORT ?? "47187", 10),
    debug: (process.env.FORGE_DEBUG ?? process.env.MIDDLEMAN_DEBUG ?? "false") === "true",
    isDesktop,
    runtimeTarget,
    cortexEnabled:
      parseOptionalBooleanEnv(
        process.env.FORGE_CORTEX_ENABLED ?? process.env.MIDDLEMAN_CORTEX_ENABLED,
        "FORGE_CORTEX_ENABLED"
      ) !== false,
    adminEmail,
    adminPassword,
    collaborationAuthSecret,
    collaborationBaseUrl,
    collaborationTrustedOrigins,
    collaborationModules,
    allowNonManagerSubscriptions: true,
    managerId,
    managerDisplayName: "Manager",
    defaultModel: {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "xhigh"
    },
    defaultCwd,
    cwdAllowlistRoots,
    paths: {
      rootDir,
      resourcesDir,
      dataDir,
      swarmDir,
      uploadsDir,
      agentsStoreFile: getAgentsStoreFilePath(dataDir),
      profilesDir,
      sharedDir,
      sharedConfigDir,
      sharedCacheDir,
      sharedStateDir,
      sharedAuthDir,
      sharedAuthFile,
      sharedSecretsFile,
      sharedIntegrationsDir,
      collaborationConfigDir,
      collaborationAuthDbPath,
      collaborationAuthSecretPath,
      sessionsDir,
      memoryDir,
      authDir,
      authFile,
      secretsFile,
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      memoryFile,
      repoMemorySkillFile,
      schedulesFile: undefined
    }
  };
}

function resolveResourcesDir(rootDir: string): string {
  const configuredResourcesDir =
    process.env.FORGE_RESOURCES_DIR ?? process.env.MIDDLEMAN_RESOURCES_DIR;

  if (!configuredResourcesDir?.trim()) {
    return rootDir;
  }

  return resolve(configuredResourcesDir.trim());
}

function resolveDefaultDataDir(): string {
  const forgePath = resolve(homedir(), ".forge");
  const legacyPath = resolve(homedir(), ".middleman");

  if (process.platform !== "win32") {
    if (existsSync(forgePath)) {
      return forgePath;
    }

    if (existsSync(legacyPath)) {
      console.warn(
        `[config] Using legacy data dir ${legacyPath}. ` +
          `Set FORGE_DATA_DIR or migrate to ${forgePath}.`
      );
      return legacyPath;
    }

    return forgePath;
  }

  const localAppDataBase = process.env.LOCALAPPDATA?.trim()
    ? resolve(process.env.LOCALAPPDATA)
    : resolve(homedir(), "AppData", "Local");
  const windowsDefault = resolve(localAppDataBase, "forge");
  const windowsLegacy = resolve(localAppDataBase, "middleman");

  if (existsSync(windowsDefault)) {
    return windowsDefault;
  }

  if (existsSync(windowsLegacy)) {
    console.warn(
      `[config] Using legacy Windows data dir ${windowsLegacy}. ` +
        `Set FORGE_DATA_DIR or migrate to ${windowsDefault}.`
    );
    return windowsLegacy;
  }

  if (existsSync(legacyPath)) {
    console.warn(
      `[config] Using legacy data dir ${legacyPath} on Windows. ` +
        `Set FORGE_DATA_DIR or migrate to ${windowsDefault}.`
    );
    return legacyPath;
  }

  return windowsDefault;
}

function detectRootDir(): string {
  let current = resolve(process.cwd());

  while (true) {
    if (isSwarmRepoRoot(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  return resolve(process.cwd(), "../..");
}

function isSwarmRepoRoot(path: string): boolean {
  return existsSync(resolve(path, "pnpm-workspace.yaml")) && existsSync(resolve(path, "apps"));
}

function parseBooleanEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseOptionalStringEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalStringListEnv(value: string | undefined): string[] | undefined {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries?.length ? entries : undefined;
}

function parseOptionalBooleanEnv(
  value: string | undefined,
  envVarName?: string,
): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  if (envVarName) {
    console.warn(`[config] Ignoring invalid ${envVarName} value: ${value}`);
  }
  return undefined;
}

function migrateLegacyPiAuthFileIfNeeded(targetAuthFile: string): void {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return;
  }

  const legacyPiAuthFile = resolve(homedir(), ".pi", "agent", "auth.json");
  if (existsSync(targetAuthFile) || !existsSync(legacyPiAuthFile)) {
    return;
  }

  try {
    mkdirSync(dirname(targetAuthFile), { recursive: true });
    copyFileSync(legacyPiAuthFile, targetAuthFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[swarm] Failed to migrate legacy Pi auth file: ${message}`);
  }
}
