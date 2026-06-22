import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planClaudeRuntimePrompt, planCursorSdkRuntimePrompt, planPiRuntimePrompt } from "../runtime/runtime-prompt-plan.js";
import type { AgentDescriptor } from "../types.js";

function descriptor(role: AgentDescriptor["role"]): Pick<AgentDescriptor, "role"> {
  return { role };
}

describe("runtime prompt planning", () => {
  describe("planPiRuntimePrompt", () => {
    it("uses the loader system prompt for managers without appending an override", () => {
      const plan = planPiRuntimePrompt({
        descriptor: descriptor("manager"),
        systemPrompt: "Base manager prompt",
        cwd: "/repo",
      });

      expect(plan.systemPrompt).toBe("Base manager prompt");
      expect(plan.appendSystemPromptOverride(["existing"])).toEqual([]);
      expect(plan.startupRecoveryContextFile).toBeUndefined();
    });

    it("appends the base prompt to the Pi prompt stack for workers", () => {
      const plan = planPiRuntimePrompt({
        descriptor: descriptor("worker"),
        systemPrompt: "Base worker prompt",
        cwd: "/repo",
      });

      expect(plan.systemPrompt).toBeUndefined();
      expect(plan.appendSystemPromptOverride(["existing"])).toEqual(["existing", "Base worker prompt"]);
      expect(plan.startupRecoveryContextFile).toBeUndefined();
    });

    it("adds a startup recovery agents file when the recovery block is non-empty", () => {
      const cwd = join("/tmp", "forge-project");
      const blockText = "# Recovered Forge Conversation Context\nRecovered history";

      const plan = planPiRuntimePrompt({
        descriptor: descriptor("manager"),
        systemPrompt: "Base manager prompt",
        cwd,
        startupRecoveryContext: {
          reason: "model_change",
          blockText,
        },
      });

      expect(plan.startupRecoveryContextFile).toEqual({
        path: join(cwd, ".forge", "ephemeral-model-change-recovery.md"),
        content: blockText,
      });
    });

    it("does not add a startup recovery agents file for an empty recovery block", () => {
      const plan = planPiRuntimePrompt({
        descriptor: descriptor("manager"),
        systemPrompt: "Base manager prompt",
        cwd: "/repo",
        startupRecoveryContext: {
          reason: "model_change",
          blockText: "",
        },
      });

      expect(plan.startupRecoveryContextFile).toBeUndefined();
    });
  });

  describe("planClaudeRuntimePrompt", () => {
    it("keeps the base prompt unchanged and returns no startup override without recovery context", () => {
      const plan = planClaudeRuntimePrompt({ systemPrompt: "Base Claude prompt" });

      expect(plan.systemPrompt).toBe("Base Claude prompt");
      expect(plan.startupSystemPromptOverride).toBeUndefined();
      expect(plan.skipInitialSessionResume).toBeUndefined();
    });

    it("returns a startup-only override containing the base prompt and recovery block", () => {
      const plan = planClaudeRuntimePrompt({
        systemPrompt: "Base Claude prompt",
        startupRecoveryContext: {
          reason: "model_change",
          blockText: "# Recovered Forge Conversation Context\nRecovered history",
        },
      });

      expect(plan.systemPrompt).toBe("Base Claude prompt");
      expect(plan.startupSystemPromptOverride).toBe(
        "Base Claude prompt\n\n# Recovered Forge Conversation Context\nRecovered history"
      );
      expect(plan.skipInitialSessionResume).toBe(true);
    });

    it("preserves skipInitialSessionResume for an empty recovery context without adding an override", () => {
      const plan = planClaudeRuntimePrompt({
        systemPrompt: "Base Claude prompt",
        startupRecoveryContext: {
          reason: "model_change",
          blockText: "",
        },
      });

      expect(plan.systemPrompt).toBe("Base Claude prompt");
      expect(plan.startupSystemPromptOverride).toBeUndefined();
      expect(plan.skipInitialSessionResume).toBe(true);
    });
  });

  describe("planCursorSdkRuntimePrompt", () => {
    it("mirrors Claude startup recovery override and skip-resume semantics", () => {
      const plan = planCursorSdkRuntimePrompt({
        systemPrompt: "Base Cursor prompt",
        startupRecoveryContext: {
          reason: "model_change",
          blockText: "# Recovered Forge Conversation Context\nRecovered history",
          requestId: "req-1",
        },
      });

      expect(plan.systemPrompt).toBe("Base Cursor prompt");
      expect(plan.startupSystemPromptOverride).toContain("# Recovered Forge Conversation Context");
      expect(plan.skipInitialSessionResume).toBe(true);
    });
  });
});
