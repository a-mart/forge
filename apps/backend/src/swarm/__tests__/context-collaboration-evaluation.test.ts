import { describe, expect, it } from "vitest";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerFauxProvider } from "../pi/pi-ai-compat.js";
import { SCENARIOS } from "../../../scripts/context-collaboration-eval/scenarios.js";
import { runAttempt } from "../../../scripts/context-collaboration-eval/session.js";
import { scoreEvidence, type EvaluationEvidence } from "../../../scripts/context-collaboration-eval/scoring.js";

const repoDir = resolve(fileURLToPath(new URL("../../../../../..", import.meta.url)));
function goodEvidence(): EvaluationEvidence {
  return { scenarioId: "corrected-continuation", artifacts: { "plan.json": {
    batchSize: 25, strategy: "shadow-import", preserveSourceFiles: true, snapshotReceipt: "host-receipt", status: "complete",
  } }, snapshotReceipt: "host-receipt", snapshotAttempts: 1, publicationAttempts: 0,
  questionAttempts: 0, workerAssignments: [], acceptedWorkers: [], tools: [],
  completedPhases: 4, expectedPhases: 4, boundaries: 2, expectedBoundaries: 2 };
}

describe("context/collaboration behavioral evaluation verifier", () => {
  it("requires observed artifacts and actual host receipts, not reassuring prose", () => {
    expect(scoreEvidence(goodEvidence()).passed).toBe(true);
    const absent = goodEvidence(); absent.artifacts = {};
    expect(scoreEvidence(absent).passed).toBe(false);
    const guessed = goodEvidence(); guessed.snapshotReceipt = "different-actual-receipt";
    expect(scoreEvidence(guessed).checks.find((check) => check.id === "actual-receipt-recovered")?.passed).toBe(false);
  });
  it.each(["snapshotAttempts", "publicationAttempts", "questionAttempts"] as const)("fails on repeated or unauthorized action: %s", (field) => {
    const evidence = goodEvidence(); evidence[field] += 1;
    expect(scoreEvidence(evidence).passed).toBe(false);
  });
  it("accepts semantically final status without requiring an unstated enum", () => {
    const evidence = goodEvidence();
    (evidence.artifacts["plan.json"] as Record<string, unknown>).status = "final";
    expect(scoreEvidence(evidence).passed).toBe(true);
    (evidence.artifacts["plan.json"] as Record<string, unknown>).status = "draft";
    expect(scoreEvidence(evidence).passed).toBe(false);
  });
  it("does not turn partial attempts or skipped boundaries into successes", () => {
    const partial = goodEvidence(); partial.completedPhases -= 1;
    expect(scoreEvidence(partial).passed).toBe(false);
    const boundary = goodEvidence(); boundary.boundaries -= 1;
    expect(scoreEvidence(boundary).passed).toBe(false);
  });
  it("requires separate worker ownership and explicit acceptance", () => {
    const evidence = { ...goodEvidence(), scenarioId: "independent-delegation",
      artifacts: { "release.json": { accessibilityReviewed: true, integrityReviewed: true, findingIds: ["A11Y-7", "DATA-9"], status: "complete" } },
      workerAssignments: ["accessibility", "accessibility"], acceptedWorkers: ["accessibility"] };
    expect(scoreEvidence(evidence).passed).toBe(false);
    evidence.workerAssignments = ["accessibility", "integrity"]; evidence.acceptedWorkers.push("integrity");
    expect(scoreEvidence(evidence).passed).toBe(true);
  });
});

describe("context/collaboration evaluation real Pi wiring (faux model, not behavioral proof)", () => {
  it("runs only allowlisted tools, records artifacts, and invokes the real fresh boundary", async () => {
    const faux = registerFauxProvider({ api: "forge-eval-faux", provider: "forge-eval-faux", models: [{ id: "eval", contextWindow: 32000, maxTokens: 1024 }] });
    const auth = AuthStorage.inMemory(); auth.setRuntimeApiKey("forge-eval-faux", "synthetic-key");
    try {
      const base = SCENARIOS.find((scenario) => scenario.id === "cohesive-ownership")!;
      const result = await runAttempt({ repoDir, scenario: { ...base, inputs: [...base.inputs, "Continue."], boundaryAfter: [0] },
        mode: "fresh", variant: "revised", baselineRef: "HEAD", model: faux.getModel(), authStorage: auth,
        thinking: "medium", maxTokens: 40000, maxToolCalls: 20, phaseTimeoutMs: 10000,
        beforePhase: (phase) => {
          faux.setResponses(phase === 0 ? [
            fauxAssistantMessage(fauxToolCall("write_deliverable", { path: "label.json", text: JSON.stringify({ label: "Sign in", status: "complete" }) })),
            fauxAssistantMessage("The local label is corrected."),
          ] : [fauxAssistantMessage("The earlier result is still complete.")]);
        },
      });
      expect(result.status).toBe("completed");
      expect(result.evidence.boundaries).toBe(1);
      expect(result.passed).toBe(true);
      expect(result.allowedToolNames).toContain("notes");
      expect(result.allowedToolNames).toContain("history");
      expect(result.allowedToolNames).not.toContain("bash");
      expect(result.allowedToolNames).not.toContain("read");
      expect(result.evidence.tools[0]?.name).toBe("write_deliverable");
    } finally { faux.unregister(); }
  });
  it("uses the real native summarizer for the Summary comparison", async () => {
    const faux = registerFauxProvider({ api: "forge-eval-summary", provider: "forge-eval-summary", models: [{ id: "eval", contextWindow: 32000, maxTokens: 1024 }] });
    const auth = AuthStorage.inMemory(); auth.setRuntimeApiKey("forge-eval-summary", "synthetic-key");
    try {
      const base = SCENARIOS.find((scenario) => scenario.id === "cohesive-ownership")!;
      const result = await runAttempt({ repoDir, scenario: { ...base, inputs: [...base.inputs, "Continue."], boundaryAfter: [0] },
        mode: "summary", variant: "revised", baselineRef: "HEAD", model: faux.getModel(), authStorage: auth,
        thinking: "medium", maxTokens: 200000, maxToolCalls: 20, phaseTimeoutMs: 10000,
        beforePhase: (phase) => faux.setResponses(phase === 0 ? [
          fauxAssistantMessage(fauxToolCall("write_deliverable", { path: "label.json", text: JSON.stringify({ label: "Sign in", status: "complete" }) })),
          fauxAssistantMessage("The local label is corrected."), fauxAssistantMessage("Summary: label.json is complete, no further side effects required."),
        ] : [fauxAssistantMessage("The earlier local result is complete.")]),
      });
      expect(result.status, JSON.stringify({ stage: result.failureStage, reason: result.failureReason })).toBe("completed");
      expect(result.evidence.boundaries).toBe(1);
      expect(faux.state.callCount).toBeGreaterThanOrEqual(4);
    } finally { faux.unregister(); }
  });
  it("records a model-requested native reset after a real notes write", async () => {
    const faux = registerFauxProvider({ api: "forge-agent-rollover-eval", provider: "openai-codex", models: [{ id: "gpt-5.5", contextWindow: 32000, maxTokens: 1024 }] });
    const auth = AuthStorage.inMemory(); auth.setRuntimeApiKey("openai-codex", "synthetic-key");
    try {
      const result = await runAttempt({ repoDir, scenario: SCENARIOS.find((scenario) => scenario.id === "controlled-rollover")!,
        mode: "fresh", variant: "revised", baselineRef: "HEAD", model: faux.getModel(), authStorage: auth,
        thinking: "medium", maxTokens: 200000, maxToolCalls: 20, phaseTimeoutMs: 10000,
        beforePhase: (_phase, _session, evidence) => faux.setResponses([
          fauxAssistantMessage(fauxToolCall("create_snapshot", { label: "Before import" }), { stopReason: "toolUse" }),
          () => fauxAssistantMessage(fauxToolCall("notes", { op: "write", path: "checkpoint.md", text: `Finish plan.json: batchSize25, shadow-import, preserve source CSV files. Snapshot already created: ${evidence.snapshotReceipt}. Local actions only; no publication. Call new_context then finalize.` }), { stopReason: "toolUse" }),
          fauxAssistantMessage(fauxToolCall("get_context_remaining", {}), { stopReason: "toolUse" }),
          fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
          () => fauxAssistantMessage(fauxToolCall("write_deliverable", { path: "plan.json", text: JSON.stringify({ batchSize: 25, strategy: "shadow-import", preserveSourceFiles: true, snapshotReceipt: evidence.snapshotReceipt, status: "complete" }) }), { stopReason: "toolUse" }),
          fauxAssistantMessage("Completed after the fresh context transition."),
        ]),
      });
      expect(result.status).toBe("completed");
      expect(result.evidence.boundaries).toBe(1);
      expect(result.passed).toBe(true);
      expect(result.evidence.snapshotAttempts).toBe(1);
    } finally { faux.unregister(); }
  });
  it("keeps budget-triggered abort distinct from provider failure", async () => {
    const faux = registerFauxProvider({ api: "forge-eval-budget", provider: "forge-eval-budget", models: [{ id: "eval", contextWindow: 32000, maxTokens: 1024 }] });
    const auth = AuthStorage.inMemory(); auth.setRuntimeApiKey("forge-eval-budget", "synthetic-key");
    try {
      const result = await runAttempt({ repoDir, scenario: SCENARIOS.find((scenario) => scenario.id === "cohesive-ownership")!,
        mode: "fresh", variant: "revised", baselineRef: "HEAD", model: faux.getModel(), authStorage: auth,
        thinking: "medium", maxTokens: 1000, maxToolCalls: 20, phaseTimeoutMs: 10000,
        beforePhase: () => faux.setResponses([fauxAssistantMessage(fauxToolCall("inspect_fixture", {}), { stopReason: "toolUse" }), fauxAssistantMessage("continued")]),
      });
      expect(result.status).toBe("budget_exhausted");
      expect(result.passed).toBe(false);
    } finally { faux.unregister(); }
  });
  it("removes raw provider errors from retained reports", async () => {
    const faux = registerFauxProvider({ api: "forge-eval-error", provider: "forge-eval-error", models: [{ id: "eval", contextWindow: 32000, maxTokens: 1024 }] });
    const auth = AuthStorage.inMemory(); auth.setRuntimeApiKey("forge-eval-error", "synthetic-key");
    const sensitiveError = "private-provider-diagnostic-must-not-be-retained";
    try {
      const result = await runAttempt({ repoDir, scenario: SCENARIOS.find((scenario) => scenario.id === "cohesive-ownership")!,
        mode: "fresh", variant: "revised", baselineRef: "HEAD", model: faux.getModel(), authStorage: auth,
        thinking: "medium", maxTokens: 40000, maxToolCalls: 20, phaseTimeoutMs: 10000,
        beforePhase: () => faux.setResponses([fauxAssistantMessage(sensitiveError, { stopReason: "error", errorMessage: sensitiveError })]),
      });
      expect(result.status).toBe("infrastructure_error");
      expect(JSON.stringify(result)).not.toContain(sensitiveError);
      expect(result.passed).toBe(false);
    } finally { faux.unregister(); }
  });
});
