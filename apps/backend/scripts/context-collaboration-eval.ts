#!/usr/bin/env -S pnpm exec tsx
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { SCENARIOS } from "./context-collaboration-eval/scenarios.js";
import { runAttempt, type EvaluationMode, type PromptVariant } from "./context-collaboration-eval/session.js";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { values } = parseArgs({ options: {
  live: { type: "boolean", default: false }, "auth-file": { type: "string" },
  provider: { type: "string", default: "openai-codex" }, model: { type: "string", default: "gpt-5.5" },
  thinking: { type: "string", default: "medium" }, "baseline-ref": { type: "string", default: "6d950c905ae35e8ffeefe15aae4fa8fcd26c5820" },
  scenarios: { type: "string", default: "corrected-continuation" }, modes: { type: "string", default: "summary,fresh" },
  variants: { type: "string", default: "baseline,revised" }, repeats: { type: "string", default: "1" },
  "max-tokens": { type: "string", default: "120000" }, "max-total-tokens": { type: "string", default: "480000" },
  "phase-timeout-ms": { type: "string", default: "120000" }, "max-tool-calls": { type: "string", default: "40" },
  out: { type: "string" },
} });
const select = <T extends string>(input: string, allowed: readonly T[]): T[] => {
  const selected = input.split(",").map((item) => item.trim()) as T[];
  if (!selected.length || selected.some((item) => !allowed.includes(item)) || new Set(selected).size !== selected.length) throw new Error("Invalid evaluation selection");
  return selected;
};
const boundedInt = (input: string, min: number, max: number) => {
  const value = Number(input);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error("Invalid evaluation budget");
  return value;
};
const scenarioIds = select(values.scenarios, SCENARIOS.map((scenario) => scenario.id));
const modes = select<EvaluationMode>(values.modes, ["summary", "fresh"]);
if (scenarioIds.includes("controlled-rollover") && modes.includes("summary")) throw new Error("controlled-rollover requires --modes fresh");
const variants = select<PromptVariant>(values.variants, ["baseline", "revised"]);
const thinking = select(values.thinking, ["low", "medium", "high"] as const)[0]!;
const repeats = boundedInt(values.repeats, 1, 5);
const maxTokens = boundedInt(values["max-tokens"], 1000, 200000);
const maxTotalTokens = boundedInt(values["max-total-tokens"], 1000, 1000000);
const phaseTimeoutMs = boundedInt(values["phase-timeout-ms"], 1000, 300000);
const maxToolCalls = boundedInt(values["max-tool-calls"], 1, 100);
const matrix = scenarioIds.flatMap((scenarioId) => Array.from({ length: repeats }, (_, repeat) =>
  modes.flatMap((mode) => variants.map((variant) => ({ scenarioId, mode, variant, repeat: repeat + 1 }))))).flat();
if (matrix.length > 40) throw new Error("At most 40 attempts per explicit invocation");
const manifest = {
  kind: "forge-context-collaboration-evaluation", version: 1, live: values.live,
  provider: values.provider, model: values.model, thinking, baselineRef: values["baseline-ref"],
  boundaries: "Fixed settled Pi boundaries except controlled-rollover, where the model requests the real runtime boundary",
  compactionSettings: { keepRecentTokens: 1, reserveTokens: 2048, automaticCompaction: false },
  usageCoverage: "Main-agent responses only; native summary compaction requests are additional and excluded from usage totals",
  comparison: "Baseline/revised manager base with current shared prompt composition, fixed tools, Adaptive posture, and synthetic workspace",
  budgets: { maxTokensPerAttempt: maxTokens, maxTotalTokens, maxOutputTokensPerResponse: 4096, phaseTimeoutMs, maxToolCalls }, matrix,
};
if (!values.live) {
  console.log(JSON.stringify({ ...manifest, status: "dry_run", instructions: "Pass --live to invoke the selected provider. Dry run does not load credentials or call a model." }, null, 2));
} else {
  const out = resolve(values.out ?? resolve(repoDir, ".internal/context-and-collaboration/evaluation", `run-${Date.now()}.json`));
  await mkdir(dirname(out), { recursive: true });
  const results: Array<Awaited<ReturnType<typeof runAttempt>> & { repeat: number }> = [];
  let status = "completed";
  try {
    if (values["auth-file"] && !existsSync(resolve(values["auth-file"]))) throw new Error("auth_unavailable");
    const source = values["auth-file"] ? AuthStorage.create(resolve(values["auth-file"])) : AuthStorage.inMemory();
    const selectedCredential = source.get(values.provider);
    // Refresh remains in memory. Never write live auth or copy it into the workspace.
    const authStorage = AuthStorage.inMemory(selectedCredential ? { [values.provider]: selectedCredential } : {});
    if (!authStorage.hasAuth(values.provider)) throw new Error("auth_unavailable");
    const model = ModelRegistry.inMemory(authStorage).find(values.provider, values.model);
    if (!model) throw new Error("model_unavailable");
    for (const cell of matrix) {
      const usedTokens = results.reduce((sum, result) => sum + result.usage.totalTokens, 0);
      if (usedTokens >= maxTotalTokens) { status = "budget_exhausted"; break; }
      const result = await runAttempt({ repoDir, scenario: SCENARIOS.find((item) => item.id === cell.scenarioId)!,
        mode: cell.mode, variant: cell.variant, baselineRef: values["baseline-ref"], model, authStorage, thinking,
        maxTokens: Math.min(maxTokens, maxTotalTokens - usedTokens), phaseTimeoutMs, maxToolCalls });
      results.push({ ...result, repeat: cell.repeat });
      await writeFile(out, `${JSON.stringify({ ...manifest, status: "running", results }, null, 2)}\n`, { mode: 0o600 });
      console.log(JSON.stringify({ scenario: result.scenario, variant: result.variant, mode: result.mode, status: result.status, passed: result.passed, tokens: result.usage.totalTokens }));
      if (result.status === "infrastructure_error" || result.status === "timeout") { status = result.status; break; }
    }
  } catch (error) {
    status = error instanceof Error && ["auth_unavailable", "model_unavailable"].includes(error.message) ? error.message : "infrastructure_error";
  }
  await writeFile(out, `${JSON.stringify({ ...manifest, status, results }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status, attempts: results.length, passed: results.filter((result) => result.passed).length, report: out }));
  if (status !== "completed" || results.some((result) => !result.passed)) process.exitCode = 1;
}
