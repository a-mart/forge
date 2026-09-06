import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildManagerPostureBlock } from "../prompts/manager-posture.js";
import { composeBuiltinModeSystemPrompt, WORKER_MODE_SYSTEM_PROMPT_CORE } from "../worker-mode-prompt.js";
import { generateRosterBlock } from "../agents/specialists/specialist-registry.js";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("built-in prompt routing policy", () => {
  it("preserves the delegation-first default and its read-only boundary", () => {
    expect(buildManagerPostureBlock(undefined)).toBe(buildManagerPostureBlock("delegation_first"));
    expect(buildManagerPostureBlock(undefined)).toContain("Your own project work remains read-only");
    expect(buildManagerPostureBlock("hands_on")).not.toContain("remains read-only");
    expect(buildManagerPostureBlock("adaptive")).not.toContain("remains read-only");
  });

  it("keeps roster selection conditional on the work-mode decision", () => {
    const roster = generateRosterBlock([]);
    expect(roster).toContain("Roster availability is not a reason to delegate");
    expect(roster).toContain("requiresSecureRuntime=true");
    expect(roster).toContain("Escalate only after evidence");
    expect(roster).not.toContain("try the cheapest");
  });

  it("does not let skill authoring impose delegation on Hands-on", async () => {
    const skill = await source("../skills/builtins/create-skill/SKILL.md");
    expect(skill).toContain("Follow the selected work mode for execution ownership");
    expect(skill).not.toContain("Managers should delegate substantive implementation");
  });

  it.each(["planner", "code-reviewer", "code-reviewer-2", "researcher", "architect"])(
    "layers the shipped %s role onto one bounded worker contract",
    async (id) => {
      const markdown = await source(`../specialists/builtins/${id}.md`);
      const role = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
      const prompt = composeBuiltinModeSystemPrompt(id, role);
      expect(prompt.split(WORKER_MODE_SYSTEM_PROMPT_CORE)).toHaveLength(2);
      expect(prompt).toContain("Broaden or repeat verification only for new changes, failures, or unresolved concerns");
      if (id === "planner") {
        expect(prompt).toContain("a plan does not require a work graph or multiple workers");
        expect(prompt).toContain("do not implement or modify project files");
      } else if (id.startsWith("code-reviewer")) {
        expect(prompt).toContain("Review only; do not modify project files");
      }
    },
  );

  it("does not wrap standalone custom specialists in the built-in contract", () => {
    expect(composeBuiltinModeSystemPrompt("custom-review", "Custom role")).toBe("Custom role");
  });
});
