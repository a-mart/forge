import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
  const derivation = deriveClaudeProjectSubdir(options.cwd);
  const sessionFilePath = join(projectsDir, derivation.projectSubdir, `${options.claudeSessionId}.jsonl`);

  if (!derivation.confident) {
    return {
      status: "unknown",
      configDir,
      projectsDir,
      projectSubdir: derivation.projectSubdir,
      sessionFilePath,
      error: "Claude project directory derivation is not confident for this cwd"
    };
  }

  let projectsStats: Awaited<ReturnType<typeof stat>>;
  try {
    projectsStats = await stat(projectsDir);
  } catch (error) {
    if (isEnoentError(error)) {
      return {
        status: "unknown",
        configDir,
        projectsDir,
        projectSubdir: derivation.projectSubdir,
        sessionFilePath,
        error: "Claude projects directory does not exist"
      };
    }

    return {
      status: "unknown",
      configDir,
      projectsDir,
      projectSubdir: derivation.projectSubdir,
      sessionFilePath,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  if (!projectsStats.isDirectory()) {
    return {
      status: "unknown",
      configDir,
      projectsDir,
      projectSubdir: derivation.projectSubdir,
      sessionFilePath,
      error: "Claude projects path is not a directory"
    };
  }

  try {
    const sessionStats = await stat(sessionFilePath);
    return {
      status: sessionStats.isFile() ? "verified" : "unknown",
      configDir,
      projectsDir,
      projectSubdir: derivation.projectSubdir,
      sessionFilePath,
      ...(sessionStats.isFile() ? {} : { error: "Claude session path exists but is not a file" })
    };
  } catch (error) {
    if (isEnoentError(error)) {
      return {
        status: "missing",
        configDir,
        projectsDir,
        projectSubdir: derivation.projectSubdir,
        sessionFilePath
      };
    }

    return {
      status: "unknown",
      configDir,
      projectsDir,
      projectSubdir: derivation.projectSubdir,
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
  return deriveClaudeProjectSubdir(cwd).projectSubdir;
}

function deriveClaudeProjectSubdir(cwd: string): { projectSubdir: string; confident: boolean } {
  const normalizedCwd = normalizeOptionalString(cwd);
  const resolvedCwd = resolve(cwd);
  const sanitized = resolvedCwd.replaceAll("\\", "/").replace(/[:/]+/g, "-");

  return {
    projectSubdir: sanitized.length > 0 ? sanitized : "-",
    confident: Boolean(normalizedCwd) && isAbsolute(cwd)
  };
}
