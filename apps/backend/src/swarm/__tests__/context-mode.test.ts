import { describe, expect, it } from "vitest";
import {
  CONTEXT_MODE_WORKER_WRITE_ERROR,
  FRESH_CONTEXT_UNSUPPORTED_COLLAB,
  FRESH_CONTEXT_UNSUPPORTED_CORTEX,
  FRESH_CONTEXT_UNSUPPORTED_CURSOR_SDK,
  FRESH_CONTEXT_UNSUPPORTED_EXTERNAL_THREAD,
  FRESH_CONTEXT_UNSUPPORTED_PROVIDER,
  FRESH_CONTEXT_UNSUPPORTED_SPECIAL_PURPOSE,
  FRESH_CONTEXT_UNSUPPORTED_SYSTEM_PROFILE,
  buildSessionContextModeSnapshot,
  evaluateFreshContextSupport,
  parseSessionContextModeWrite,
  requireContextMode,
  resolveEffectiveContextMode,
  resolveOwningManagerId,
} from "../context-mode.js";
import type { AgentDescriptor, ManagerProfile } from "../types.js";

const PROFILE: Pick<ManagerProfile, "profileId" | "defaultContextMode"> = {
  profileId: "forge",
};

const MANAGER: Pick<
  AgentDescriptor,
  | "agentId"
  | "role"
  | "profileId"
  | "sessionSurface"
  | "sessionPurpose"
  | "internalWorkerKind"
  | "externalThread"
  | "archetypeId"
  | "model"
  | "contextModeOverride"
  | "collab"
> = {
  agentId: "manager",
  role: "manager",
  profileId: "forge",
  model: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "medium" },
};

describe("context mode resolution", () => {
  it("defaults to summary and supports both override directions", () => {
    expect(resolveEffectiveContextMode(undefined, undefined)).toBe("summary");
    expect(resolveEffectiveContextMode("fresh", undefined)).toBe("fresh");
    expect(resolveEffectiveContextMode("fresh", "summary")).toBe("summary");
    expect(resolveEffectiveContextMode("summary", "fresh")).toBe("fresh");
  });

  it("rejects invalid writes and treats null as inherit", () => {
    expect(requireContextMode("fresh", "mode")).toBe("fresh");
    expect(parseSessionContextModeWrite(null)).toBeNull();
    expect(() => requireContextMode("auto", "mode")).toThrow('mode must be "summary" or "fresh"');
    expect(() => parseSessionContextModeWrite("window")).toThrow('mode must be "summary" or "fresh"');
  });

  it("resolves workers through the owning manager", () => {
    expect(resolveOwningManagerId({
      agentId: "manager",
      role: "manager",
      managerId: "manager",
    } as AgentDescriptor)).toBe("manager");
    expect(resolveOwningManagerId({
      agentId: "worker-1",
      role: "worker",
      managerId: "manager",
    } as AgentDescriptor)).toBe("manager");
    expect(CONTEXT_MODE_WORKER_WRITE_ERROR).toMatch(/manager sessions/);
  });

  it("supports only existing Pi-backed compaction providers", () => {
    expect(evaluateFreshContextSupport({ manager: MANAGER }).freshSupported).toBe(true);
    expect(evaluateFreshContextSupport({
      manager: { ...MANAGER, model: { ...MANAGER.model, provider: "anthropic" } },
      runtime: { runtimeType: "pi" },
    }).freshSupported).toBe(true);
    expect(evaluateFreshContextSupport({
      manager: { ...MANAGER, model: { ...MANAGER.model, provider: "xai" } },
    })).toEqual({
      freshSupported: false,
      unsupportedReason: FRESH_CONTEXT_UNSUPPORTED_PROVIDER,
    });
    expect(evaluateFreshContextSupport({
      manager: { ...MANAGER, model: { ...MANAGER.model, provider: "openrouter" } },
    }).freshSupported).toBe(false);
    expect(evaluateFreshContextSupport({
      manager: { ...MANAGER, model: { ...MANAGER.model, provider: "unknown" } },
    }).freshSupported).toBe(false);
  });

  it("reports unsupported runtimes honestly without changing the saved preference", () => {
    expect(evaluateFreshContextSupport({
      manager: { ...MANAGER, sessionSurface: "collab" },
    })).toEqual({
      freshSupported: false,
      unsupportedReason: FRESH_CONTEXT_UNSUPPORTED_COLLAB,
    });
    expect(evaluateFreshContextSupport({
      manager: { ...MANAGER, sessionPurpose: "cortex_review" },
    }).unsupportedReason).toBe(FRESH_CONTEXT_UNSUPPORTED_SPECIAL_PURPOSE);
    expect(evaluateFreshContextSupport({
      manager: {
        ...MANAGER,
        externalThread: { type: "codex_app_server", persisted: true, createdByMention: true },
      },
    }).unsupportedReason).toBe(FRESH_CONTEXT_UNSUPPORTED_EXTERNAL_THREAD);
    expect(evaluateFreshContextSupport({
      manager: { ...MANAGER, archetypeId: "cortex" },
    }).unsupportedReason).toBe(FRESH_CONTEXT_UNSUPPORTED_CORTEX);
    expect(evaluateFreshContextSupport({
      manager: MANAGER,
      profile: { profileId: "cortex", profileType: "system" },
    }).unsupportedReason).toBe(FRESH_CONTEXT_UNSUPPORTED_SYSTEM_PROFILE);
    expect(evaluateFreshContextSupport({
      manager: { ...MANAGER, model: { ...MANAGER.model, provider: "cursor-sdk" } },
    }).unsupportedReason).toBe(FRESH_CONTEXT_UNSUPPORTED_CURSOR_SDK);

    const snapshot = buildSessionContextModeSnapshot({
      sessionAgentId: "openrouter-session",
      profile: { ...PROFILE, defaultContextMode: "fresh" },
      manager: {
        ...MANAGER,
        model: { ...MANAGER.model, provider: "openrouter" },
      },
    });
    expect(snapshot).toMatchObject({
      profileId: "forge",
      projectDefault: "fresh",
      effectiveMode: "fresh",
      freshSupported: false,
      unsupportedReason: FRESH_CONTEXT_UNSUPPORTED_PROVIDER,
    });
    expect(snapshot.sessionOverride).toBeUndefined();
  });
});
