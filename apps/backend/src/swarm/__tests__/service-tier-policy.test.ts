import { describe, expect, it } from "vitest";
import {
  FAST_MODE_OAUTH_REQUIRED_MESSAGE,
  normalizeReturnedOpenAICodexServiceTier,
  resolveAgentServiceTierFromSessionPolicy,
  toOpenAICodexPayloadServiceTier,
  validateSessionFastModePolicySelection,
} from "../catalog/service-tier-policy.js";

const oauth = { configured: true, authTypes: ["oauth"], sources: ["auth_file"], chatgptAuthAvailable: true } as const;
const apiKey = { configured: true, authTypes: ["api_key"], sources: ["env"] } as const;
const codex54 = { provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "xhigh" };

describe("service-tier policy", () => {
  it("accepts session Fast mode with OpenAI Codex OAuth", () => {
    expect(validateSessionFastModePolicySelection({ enabled: true, credentialSummary: oauth, validationMode: "user_command" }).ok).toBe(true);
  });

  it("rejects user enablement with API-key-only OpenAI Codex auth", () => {
    const result = validateSessionFastModePolicySelection({ enabled: true, credentialSummary: apiKey, validationMode: "user_command" });
    expect(result.ok).toBe(false);
    expect(result.message).toBe(FAST_MODE_OAUTH_REQUIRED_MESSAGE);
  });

  it("applies priority for inherited compatible workers and strips unsupported models", () => {
    expect(resolveAgentServiceTierFromSessionPolicy({ model: codex54, sessionPolicy: { enabled: true }, credentialSummary: oauth, source: "worker_spawn" }).model.serviceTier).toBe("priority");
    expect(resolveAgentServiceTierFromSessionPolicy({ model: { provider: "anthropic", modelId: "claude-opus-4-6", thinkingLevel: "high", serviceTier: "priority" }, sessionPolicy: { enabled: true }, credentialSummary: oauth, source: "worker_spawn" }).model.serviceTier).toBeUndefined();
  });

  it("lets explicit standard opt out and explicit Fast fail hard when unsupported", () => {
    expect(resolveAgentServiceTierFromSessionPolicy({ model: { ...codex54, serviceTier: "priority" }, sessionPolicy: { enabled: true }, spawnOverride: false, credentialSummary: oauth, source: "worker_spawn" }).model.serviceTier).toBeUndefined();
    expect(() => resolveAgentServiceTierFromSessionPolicy({ model: { provider: "anthropic", modelId: "claude-opus-4-6", thinkingLevel: "high" }, spawnOverride: true, credentialSummary: oauth, source: "worker_spawn" })).toThrow("Fast mode is not supported");
    expect(() => resolveAgentServiceTierFromSessionPolicy({ model: codex54, spawnOverride: true, credentialSummary: apiKey, source: "worker_spawn" })).toThrow(FAST_MODE_OAUTH_REQUIRED_MESSAGE);
  });

  it("normalizes request and returned service-tier vocabulary", () => {
    expect(toOpenAICodexPayloadServiceTier("priority")).toBe("priority");
    expect(toOpenAICodexPayloadServiceTier("priority", "fast")).toBe("fast");
    expect(toOpenAICodexPayloadServiceTier("default")).toBeUndefined();
    expect(normalizeReturnedOpenAICodexServiceTier("fast")).toBe("priority");
    expect(normalizeReturnedOpenAICodexServiceTier("priority")).toBe("priority");
    expect(normalizeReturnedOpenAICodexServiceTier(undefined)).toBe("unverified");
  });
});
