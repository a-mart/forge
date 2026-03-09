import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { normalizeAllowlistRoots } from "./swarm/cwd-policy.js";
import {
  getAgentsStoreFilePath,
  getLegacyAuthDirPath,
  getLegacyAuthFilePath,
  getLegacyMemoryDirPath,
  getLegacySecretsFilePath,
  getLegacySessionsDirPath,
  getProfilesDir,
  getSharedAuthDir,
  getSharedAuthFilePath,
  getSharedDir,
  getSharedIntegrationsDir,
  getSharedSecretsFilePath,
  getSwarmDir,
  getUploadsDir
} from "./swarm/data-paths.js";
import type { SwarmConfig } from "./swarm/types.js";

export function readPlaywrightDashboardEnvOverride(): boolean | undefined {
  return parseOptionalBooleanEnv(process.env.MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED);
}

export function createConfig(): SwarmConfig {
  const rootDir = detectRootDir();
  const dataDir = process.env.MIDDLEMAN_DATA_DIR ?? resolve(homedir(), ".middleman");
  const managerId = undefined;

  const swarmDir = getSwarmDir(dataDir);
  const uploadsDir = getUploadsDir(dataDir);
  const profilesDir = getProfilesDir(dataDir);
  const sharedDir = getSharedDir(dataDir);
  const sharedAuthDir = getSharedAuthDir(dataDir);
  const sharedAuthFile = getSharedAuthFilePath(dataDir);
  const sharedSecretsFile = getSharedSecretsFilePath(dataDir);
  const sharedIntegrationsDir = getSharedIntegrationsDir(dataDir);

  // Legacy flat-layout paths retained for backward compatibility.
  const sessionsDir = getLegacySessionsDirPath(dataDir);
  const authDir = getLegacyAuthDirPath(dataDir);
  const authFile = getLegacyAuthFilePath(dataDir);
  const memoryDir = getLegacyMemoryDirPath(dataDir);
  const secretsFile = getLegacySecretsFilePath(dataDir);

  migrateLegacyPiAuthFileIfNeeded(authFile);

  const agentDir = resolve(dataDir, "agent");
  const managerAgentDir = resolve(agentDir, "manager");
  const repoArchetypesDir = resolve(rootDir, ".swarm", "archetypes");
  const memoryFile = undefined;
  const repoMemorySkillFile = resolve(rootDir, ".swarm", "skills", "memory", "SKILL.md");
  const defaultCwd = rootDir;

  const cwdAllowlistRoots = normalizeAllowlistRoots([
    rootDir,
    resolve(homedir(), "worktrees")
  ]);

  return {
    host: process.env.MIDDLEMAN_HOST ?? "127.0.0.1",
    port: Number.parseInt(process.env.MIDDLEMAN_PORT ?? "47187", 10),
    debug: true,
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
      dataDir,
      swarmDir,
      uploadsDir,
      agentsStoreFile: getAgentsStoreFilePath(dataDir),
      profilesDir,
      sharedDir,
      sharedAuthDir,
      sharedAuthFile,
      sharedSecretsFile,
      sharedIntegrationsDir,
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

function parseOptionalBooleanEnv(value: string | undefined): boolean | undefined {
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

  console.warn(
    `[config] Ignoring invalid MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED value: ${value}`,
  );
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
