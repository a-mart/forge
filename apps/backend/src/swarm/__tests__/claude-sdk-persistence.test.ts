import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  probeClaudeSdkPersistence,
  resolveClaudeConfigRoot,
  toClaudeProjectSubdir
} from "../claude-sdk-persistence.js";

describe("probeClaudeSdkPersistence", () => {
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

  afterEach(() => {
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
      return;
    }

    process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  });

  it("returns verified when the Claude session jsonl file exists", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "forge-claude-config-"));
    process.env.CLAUDE_CONFIG_DIR = configDir;

    const cwd = join(configDir, "worktree", "project");
    const claudeSessionId = "session-123";
    const projectSubdir = toClaudeProjectSubdir(cwd);
    const sessionFilePath = join(configDir, "projects", projectSubdir, `${claudeSessionId}.jsonl`);
    await mkdir(join(configDir, "projects", projectSubdir), { recursive: true });
    await writeFile(sessionFilePath, "{}\n", "utf8");

    const result = await probeClaudeSdkPersistence({ cwd, claudeSessionId });

    expect(result).toMatchObject({
      status: "verified",
      configDir: resolveClaudeConfigRoot(),
      projectSubdir,
      sessionFilePath
    });
  });

  it("returns missing when the projects directory exists but the Claude session jsonl file does not", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "forge-claude-config-"));
    process.env.CLAUDE_CONFIG_DIR = configDir;

    const cwd = join(configDir, "worktree", "project");
    const claudeSessionId = "missing-session";
    await mkdir(join(configDir, "projects", toClaudeProjectSubdir(cwd)), { recursive: true });

    const result = await probeClaudeSdkPersistence({ cwd, claudeSessionId });

    expect(result.status).toBe("missing");
    expect(result.sessionFilePath).toBe(
      join(configDir, "projects", toClaudeProjectSubdir(cwd), `${claudeSessionId}.jsonl`)
    );
  });

  it("returns unknown when the Claude projects directory does not exist", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "forge-claude-config-"));
    process.env.CLAUDE_CONFIG_DIR = configDir;

    const result = await probeClaudeSdkPersistence({
      cwd: join(configDir, "worktree", "project"),
      claudeSessionId: "session-unknown"
    });

    expect(result.status).toBe("unknown");
    expect(result.error).toContain("does not exist");
  });

  it("returns unknown when the probe cannot stat the expected session path", async () => {
    const configRootFile = join(await mkdtemp(join(tmpdir(), "forge-claude-config-file-")), "config-file");
    await writeFile(configRootFile, "not a directory", "utf8");
    process.env.CLAUDE_CONFIG_DIR = configRootFile;

    const result = await probeClaudeSdkPersistence({
      cwd: join(tmpdir(), "project"),
      claudeSessionId: "session-unknown"
    });

    expect(result.status).toBe("unknown");
    expect(result.error).toBeTruthy();
  });

  it("returns unknown when the project subdir derivation is not confident", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "forge-claude-config-"));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    await mkdir(join(configDir, "projects"), { recursive: true });

    const result = await probeClaudeSdkPersistence({
      cwd: "relative/project",
      claudeSessionId: "session-relative"
    });

    expect(result.status).toBe("unknown");
    expect(result.error).toContain("not confident");
  });
});
