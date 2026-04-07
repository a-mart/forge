import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isEnoentError, normalizeOptionalString } from "./claude-utils.js";

export type ClaudeSdkPersistenceProbeStatus = "verified" | "missing" | "unknown";

export interface ClaudeSdkPersistenceProbeResult {
  status: ClaudeSdkPersistenceProbeStatus;
  configDir: string;
  projectsDir: string;
  projectSubdir: string;
  sessionFilePath: string;
  error?: string;
}

export interface ProbeClaudeSdkPersistenceOptions {
  cwd: string;
  claudeSessionId: string;
}

export async function probeClaudeSdkPersistence(
  options: ProbeClaudeSdkPersistenceOptions
): Promise<ClaudeSdkPersistenceProbeResult> {
  const configDir = resolveClaudeConfigRoot();
  const projectsDir = join(configDir, "projects");
  const projectSubdir = toClaudeProjectSubdir(options.cwd);
  const sessionFilePath = join(projectsDir, projectSubdir, `${options.claudeSessionId}.jsonl`);

  try {
    const stats = await stat(sessionFilePath);
    return {
      status: stats.isFile() ? "verified" : "missing",
      configDir,
      projectsDir,
      projectSubdir,
      sessionFilePath
    };
  } catch (error) {
    if (isEnoentError(error)) {
      return {
        status: "missing",
        configDir,
        projectsDir,
        projectSubdir,
        sessionFilePath
      };
    }

    return {
      status: "unknown",
      configDir,
      projectsDir,
      projectSubdir,
      sessionFilePath,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function resolveClaudeConfigRoot(): string {
  const configuredRoot = normalizeOptionalString(process.env.CLAUDE_CONFIG_DIR);
  if (configuredRoot) {
    return resolve(configuredRoot);
  }

  return join(homedir(), ".claude");
}

export function toClaudeProjectSubdir(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const sanitized = resolvedCwd.replaceAll("\\", "/").replace(/[:/]+/g, "-");
  return sanitized.length > 0 ? sanitized : "-";
}
