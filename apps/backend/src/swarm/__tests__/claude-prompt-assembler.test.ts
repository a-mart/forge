import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assembleClaudePrompt,
  buildMemoryComposite,
  discoverAgentsMd
} from "../claude-prompt-assembler.js";

describe("claude-prompt-assembler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T12:34:56.000Z"));
  });

  it("discovers AGENTS/CLAUDE context files from root to cwd with AGENTS preferred per directory", async () => {
    const workingRoot = await mkdtemp(join(tmpdir(), "forge-claude-prompt-"));
    const repoDir = join(workingRoot, "repo");
    const nestedDir = join(repoDir, "packages", "backend");

    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(workingRoot, "CLAUDE.md"), "root claude\n", "utf8");
    await writeFile(join(repoDir, "AGENTS.md"), "repo agents\n", "utf8");
    await writeFile(join(repoDir, "CLAUDE.md"), "repo claude should be ignored\n", "utf8");
    await writeFile(join(nestedDir, "CLAUDE.md"), "nested claude\n", "utf8");

    await expect(discoverAgentsMd(nestedDir)).resolves.toEqual([
      join(workingRoot, "CLAUDE.md"),
      join(repoDir, "AGENTS.md"),
      join(nestedDir, "CLAUDE.md")
    ]);
  });

  it("builds the manager/session/common memory composite in Pi-compatible order", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "forge-claude-memory-"));
    const profileMemoryPath = join(tempRoot, "profile-memory.md");
    const sessionMemoryPath = join(tempRoot, "session-memory.md");
    const commonKnowledgePath = join(tempRoot, "common.md");

    await writeFile(profileMemoryPath, "# Profile Memory\n\nprofile fact\n", "utf8");
    await writeFile(sessionMemoryPath, "# Session Memory\n\nsession note\n", "utf8");
    await writeFile(commonKnowledgePath, "# Common Knowledge\n\ncommon fact\n", "utf8");

    await expect(
      buildMemoryComposite({
        profileMemoryPath,
        sessionMemoryPath,
        commonKnowledgePath
      })
    ).resolves.toBe([
      "# Manager Memory (shared across all sessions — read-only reference)",
      "",
      "# Profile Memory",
      "",
      "profile fact",
      "",
      "---",
      "",
      "# Session Memory (this session's working memory — your writes go here)",
      "",
      "# Session Memory",
      "",
      "session note",
      "",
      "---",
      "",
      "# Common Knowledge (maintained by Cortex — read-only reference)",
      "",
      "# Common Knowledge",
      "",
      "common fact"
    ].join("\n"));
  });

  it("assembles the full Claude prompt with context files, memory, onboarding, skills, date, and cwd", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "forge-claude-assemble-"));
    const repoDir = join(tempRoot, "repo");
    const nestedDir = join(repoDir, "apps", "backend");
    const sessionMemoryPath = join(tempRoot, "session-memory.md");
    const profileMemoryPath = join(tempRoot, "profile-memory.md");
    const commonKnowledgePath = join(tempRoot, "common.md");
    const rootAgentsPath = join(tempRoot, "AGENTS.md");
    const repoAgentsPath = join(repoDir, "AGENTS.md");
    const swarmMdPath = join(repoDir, "SWARM.md");

    await mkdir(nestedDir, { recursive: true });
    await writeFile(rootAgentsPath, "root policy\n", "utf8");
    await writeFile(repoAgentsPath, "repo policy\n", "utf8");
    await writeFile(swarmMdPath, "repo swarm\n", "utf8");
    await writeFile(profileMemoryPath, "profile fact\n", "utf8");
    await writeFile(sessionMemoryPath, "session fact\n", "utf8");
    await writeFile(commonKnowledgePath, "common fact\n", "utf8");

    const prompt = await assembleClaudePrompt({
      basePrompt: "You are the manager.",
      profileMemoryPath,
      sessionMemoryPath,
      commonKnowledgePath,
      agentsMdPaths: [rootAgentsPath, repoAgentsPath],
      swarmMdPath,
      projectAgentDirectory: "Project agents in this profile — none configured.",
      referenceDocs: "<agent_reference_docs>\n## doc.md\nUse the docs\n</agent_reference_docs>",
      availableSkills: [
        {
          name: "memory",
          description: "Use <memory> & keep & track",
          location: "/skills/memory/SKILL.md"
        }
      ],
      onboardingSnapshot: "# Onboarding Snapshot (authoritative backend state — read-only reference)\n\n- preferred name: Adam",
      role: "manager",
      agentId: "manager-1",
      cwd: nestedDir
    });

    expect(prompt).toContain("You are the manager.");
    expect(prompt).toContain("<agent_reference_docs>\n## doc.md\nUse the docs\n</agent_reference_docs>");
    expect(prompt).toContain("Project agents in this profile — none configured.");
    expect(prompt).toContain("# Project Context");
    expect(prompt).toContain(`## ${rootAgentsPath}\n\nroot policy`);
    expect(prompt).toContain(`## ${repoAgentsPath}\n\nrepo policy`);
    expect(prompt).toContain(`## ${swarmMdPath}\n\nrepo swarm`);
    expect(prompt).toContain(`## ${sessionMemoryPath}`);
    expect(prompt).toContain("# Manager Memory (shared across all sessions — read-only reference)");
    expect(prompt).toContain("# Session Memory (this session's working memory — your writes go here)");
    expect(prompt).toContain("# Common Knowledge (maintained by Cortex — read-only reference)");
    expect(prompt).toContain("# Onboarding Snapshot (authoritative backend state — read-only reference)");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>memory</name>");
    expect(prompt).toContain("<description>Use &lt;memory&gt; &amp; keep &amp; track</description>");
    expect(prompt).toContain("Current date: 2026-04-04");
    expect(prompt).toContain(`Current working directory: ${nestedDir}`);

    expect(prompt.indexOf("You are the manager.")).toBeLessThan(prompt.indexOf("# Project Context"));
    expect(prompt.indexOf("# Project Context")).toBeLessThan(prompt.indexOf("<available_skills>"));
    expect(prompt.indexOf("<available_skills>")).toBeLessThan(prompt.indexOf("Current date: 2026-04-04"));
  });

  it("does not inject the project-agent directory for workers", async () => {
    const prompt = await assembleClaudePrompt({
      basePrompt: "You are a worker.",
      role: "worker",
      agentId: "worker-1",
      projectAgentDirectory: "Project agents in this profile — should be ignored.",
      cwd: "/tmp/project"
    });

    expect(prompt).toContain("You are a worker.");
    expect(prompt).not.toContain("Project agents in this profile — should be ignored.");
  });
});
