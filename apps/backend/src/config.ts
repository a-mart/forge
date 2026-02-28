import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { normalizeAllowlistRoots } from "./swarm/cwd-policy.js";
import { getMemoryDirPath } from "./swarm/memory-paths.js";
import type { SwarmConfig } from "./swarm/types.js";

export function createConfig(): SwarmConfig {
  const rootDir = detectRootDir();
  const dataDir = process.env.MIDDLEMAN_DATA_DIR ?? resolve(homedir(), ".middleman");
  const managerId = undefined;
  const swarmDir = resolve(dataDir, "swarm");
  const sessionsDir = resolve(dataDir, "sessions");
  const uploadsDir = resolve(dataDir, "uploads");
  const authDir = resolve(dataDir, "auth");
  const authFile = resolve(authDir, "auth.json");
  migrateLegacyPiAuthFileIfNeeded(authFile);
  const agentDir = resolve(dataDir, "agent");
  const managerAgentDir = resolve(agentDir, "manager");
  const repoArchetypesDir = resolve(rootDir, ".swarm", "archetypes");
  const memoryDir = getMemoryDirPath(dataDir);
  const memoryFile = undefined;
  const repoMemorySkillFile = resolve(rootDir, ".swarm", "skills", "memory", "SKILL.md");
  const secretsFile = resolve(dataDir, "secrets.json");
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
      sessionsDir,
      uploadsDir,
      authDir,
      authFile,
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      memoryDir,
      memoryFile,
      repoMemorySkillFile,
      agentsStoreFile: resolve(swarmDir, "agents.json"),
      secretsFile,
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
