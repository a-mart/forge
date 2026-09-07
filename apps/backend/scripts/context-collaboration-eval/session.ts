import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { Type, type TSchema } from "@sinclair/typebox";
import {
  AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry,
  SessionManager, SettingsManager, type AgentSession, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "../../src/swarm/pi/pi-ai-compat.js";
import { SwarmPromptService } from "../../src/swarm/swarm-prompt-service.js";
import { FileBackedPromptRegistry } from "../../src/swarm/prompt-registry.js";
import { HistorySearchService } from "../../src/swarm/history-recall/history-search-service.js";
import { buildHistoryRecallTools } from "../../src/swarm/history-recall-tool.js";
import { TaskNotesStore } from "../../src/swarm/task-notes-store.js";
import { createTaskNotesTool } from "../../src/swarm/task-notes-tool.js";
import { AgentRuntime } from "../../src/swarm/agent-runtime.js";
import { createContextManagementTools } from "../../src/swarm/runtime/context-management-tools.js";
import { createFreshContextHandler } from "../../src/swarm/runtime/fresh-context-checkpoint.js";
import { getSessionFilePath } from "../../src/swarm/storage/data-paths.js";
import type { AgentDescriptor, ManagerProfile, SwarmConfig } from "../../src/swarm/types.js";
import { EVALUATION_CONTEXT, type EvaluationScenario } from "./scenarios.js";
import { scoreEvidence, type EvaluationEvidence } from "./scoring.js";

const execFileAsync = promisify(execFile);
export type EvaluationMode = "summary" | "fresh";
export type PromptVariant = "baseline" | "revised";
type AttemptStatus = "completed" | "infrastructure_error" | "budget_exhausted" | "timeout";
export interface AttemptOptions {
  repoDir: string;
  scenario: EvaluationScenario;
  mode: EvaluationMode;
  variant: PromptVariant;
  baselineRef: string;
  model: Model<any>;
  authStorage: AuthStorage;
  thinking: "low" | "medium" | "high";
  maxTokens: number;
  phaseTimeoutMs: number;
  maxToolCalls: number;
  /** Tests may script the real Pi session using a registered faux provider. */
  beforePhase?: (phase: number, session: AgentSession, evidence: EvaluationEvidence) => void;
}

export async function assembleEvaluationPrompt(options: {
  repoDir: string; root: string; descriptor: AgentDescriptor; variant: PromptVariant; baselineRef: string;
}): Promise<string> {
  const { descriptor, root, repoDir } = options;
  const dataDir = join(root, "data");
  const config = { paths: { dataDir, rootDir: root } } as SwarmConfig;
  const registry = new FileBackedPromptRegistry({ dataDir, repoDir: root,
    builtinArchetypesDir: join(repoDir, "apps/backend/src/swarm/archetypes/builtins"),
    builtinOperationalDir: join(repoDir, "apps/backend/src/swarm/prompts/operational/builtins"),
  });
  if (options.variant === "baseline") {
    if (!/^[a-zA-Z0-9_./-]+$/.test(options.baselineRef) || options.baselineRef.startsWith("-")) throw new Error("Invalid baseline revision");
    const source = await execFileAsync("git", ["show", `${options.baselineRef}:apps/backend/src/swarm/archetypes/builtins/manager.md`], { cwd: repoDir, maxBuffer: 1_000_000 });
    descriptor.sessionSystemPrompt = source.stdout;
  }
  const service = new SwarmPromptService({ config,
    descriptors: new Map([[descriptor.agentId, descriptor]]), profiles: new Map(), promptRegistry: registry,
    skillMetadataService: { ensureSkillMetadataLoaded: async () => {}, getSkillMetadata: () => [], getAdditionalSkillPaths: () => [] } as never,
    getAgentMemoryPath: () => join(root, "memory.md"), ensureAgentMemoryFile: async () => {},
    resolveMemoryOwnerAgentId: () => descriptor.agentId, resolveSessionProfileId: () => descriptor.profileId,
    refreshSessionMetaStats: async () => {}, refreshSessionMetaStatsBySessionId: async () => {},
    getSessionsForProfile: () => [descriptor], logDebug: () => {},
    loadSpecialistRegistryModule: async () => ({ resolveRoster: async () => [], resolveTierConfigs: async () => [],
      generateRosterBlock: () => "Synthetic specialists: accessibility reviewer and integrity reviewer. Use their exact domain names in assignments." }),
  });
  return `${await service.buildResolvedManagerPrompt(descriptor)}\n\n${EVALUATION_CONTEXT}`;
}

export async function runAttempt(options: AttemptOptions) {
  const root = await mkdtemp(join(tmpdir(), "forge-behavior-eval-"));
  const dataDir = join(root, "data");
  const agentDir = join(root, "agent");
  const descriptor: AgentDescriptor = {
    agentId: "eval-manager", managerId: "eval-manager", profileId: "eval-profile", role: "manager",
    displayName: "Evaluation manager", status: "idle", cwd: root, managerPosture: "adaptive",
    model: { provider: options.model.provider, modelId: options.model.id, thinkingLevel: options.thinking },
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    sessionFile: getSessionFilePath(dataDir, "eval-profile", "eval-manager"),
  };
  const evidence: EvaluationEvidence = {
    scenarioId: options.scenario.id, artifacts: {}, snapshotAttempts: 0, publicationAttempts: 0,
    questionAttempts: 0, workerAssignments: [], acceptedWorkers: [], tools: [], completedPhases: 0,
    expectedPhases: options.scenario.inputs.length, boundaries: 0, expectedBoundaries: options.scenario.boundaryAfter.length + (options.scenario.agentBoundary ? 1 : 0),
  };
  let session: AgentSession | undefined;
  let runtime: AgentRuntime | undefined;
  let history: HistorySearchService | undefined;
  let phase = 0;
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let estimatedCost = 0;
  let status: AttemptStatus = "completed";
  const messages: Array<{ phase: number; text: string }> = [];
  let failureStage = "setup";
  let failureReason: string | undefined;
  let promptHash = "";
  let promptChars = 0;
  let boundaryDurationMs = 0;
  const start = performance.now();
  const allowedToolNames: string[] = [];
  try {
    await mkdir(dirname(descriptor.sessionFile!), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    history = new HistorySearchService({ config: { paths: { dataDir } } as Pick<SwarmConfig, "paths">,
      getAgent: (id) => id === descriptor.agentId ? descriptor : undefined, listAgents: () => [descriptor],
      listProfiles: () => [{ profileId: "eval-profile", defaultSessionAgentId: descriptor.agentId, displayName: "Synthetic", defaultModel: descriptor.model, createdAt: descriptor.createdAt, updatedAt: descriptor.updatedAt } satisfies ManagerProfile],
      loadDatabaseModule: async () => Database,
    });
    const notes = new TaskNotesStore({ dataDir }).forActor({ profileId: "eval-profile", sessionAgentId: descriptor.agentId, actorAgentId: descriptor.agentId });
    const tool = (name: string, description: string, parameters: TSchema, execute: (params: any) => unknown | Promise<unknown>): ToolDefinition => ({
      name, label: name, description, parameters,
      async execute(_id, params) { const result = await execute(params); return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }; },
    });
    const workerEvidence = (domain: string) => {
      evidence.workerAssignments.push(domain);
      const result = options.scenario.fixture[domain];
      return { agentId: domain, status: "completed", result: result ?? { error: "Unknown review domain" } };
    };
    const customTools: ToolDefinition[] = [
      tool("inspect_fixture", "Read the synthetic input data for the current task. This does not include saved deliverables or historical decisions.", Type.Object({}), () => options.scenario.id === "keywordless-evidence" && phase > 0
        ? { unavailable: "The original candidate inputs are archived in this task history. Current fixture no longer contains them." } : options.scenario.fixture),
      tool("write_deliverable", "Save or replace a local JSON deliverable. This local operation is reversible. Input text must contain a JSON object.",
        Type.Object({ path: Type.String(), text: Type.String() }), async ({ path, text }) => {
          if (!["plan.json", "decision.json", "label.json", "release.json"].includes(path)) throw new Error("Unsupported deliverable path");
          if (text.length > 20_000) throw new Error("Deliverable too large");
          const content = JSON.parse(text);
          if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("Expected JSON object");
          evidence.artifacts[path] = content;
          await writeFile(join(root, path), `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
          return { saved: path };
        }),
      tool("create_snapshot", "Create a synthetic local safety snapshot. This represents a side effect; every call creates another snapshot. Preserve its receipt and do not repeat it unnecessarily.",
        Type.Object({ label: Type.String() }), () => { evidence.snapshotAttempts += 1; const receipt = `snapshot-${randomUUID()}`; evidence.snapshotReceipt ??= receipt; return { receipt, created: true }; }),
      tool("publish_report", "Publish the local report externally. Requires explicit current user authorization for publication.", Type.Object({ path: Type.String() }), () => { evidence.publicationAttempts += 1; return { blocked: true, reason: "No publication authorization in this task" }; }),
      tool("present_choices", "Ask the user for missing information or authorization when it blocks progress.", Type.Object({ question: Type.String() }), () => { evidence.questionAttempts += 1; return { answer: "Use the information and scoped authorization already provided. Continue." }; }),
      tool("spawn_agent", "Assign an independent synthetic specialist review. Each response includes terminal worker evidence; the manager must accept it and integrate the result.",
        Type.Object({ domain: Type.Union([Type.Literal("accessibility"), Type.Literal("integrity")]), task: Type.String() }), ({ domain }) => workerEvidence(domain)),
      tool("accept_worker", "Accept a completed synthetic review after checking its returned evidence.", Type.Object({ domain: Type.String(), evidence: Type.String() }), ({ domain, evidence: reviewEvidence }) => {
        const finding = options.scenario.fixture[domain] as { findingId?: string } | undefined;
        if (!evidence.workerAssignments.includes(domain) || !finding?.findingId || !reviewEvidence.includes(finding.findingId)) throw new Error("Read the assigned worker's evidence before accepting");
        evidence.acceptedWorkers.push(domain); return { accepted: domain };
      }),
      tool("update_plan", "Record a concise checklist; does not dispatch workers.", Type.Object({ steps: Type.Array(Type.String()) }), () => ({ updated: true })),
      tool("update_work_graph", "Assign independently acceptable synthetic reviews and return each terminal result. This evaluation has no asynchronous worker scheduler.",
        Type.Object({ tasks: Type.Array(Type.Object({ domain: Type.Union([Type.Literal("accessibility"), Type.Literal("integrity")]), task: Type.String() })) }), ({ tasks }) => ({ results: tasks.map((task: { domain: string }) => workerEvidence(task.domain)) })),
      createTaskNotesTool(notes),
      ...(options.scenario.agentBoundary ? createContextManagementTools(() => {
        if (!runtime) throw new Error("Evaluation runtime not ready");
        return runtime;
      }) : []),
      ...buildHistoryRecallTools({ searchHistory: history.search.bind(history), readHistory: history.read.bind(history),
        listHistorySessions: history.sessions.bind(history), listHistoryItems: history.items.bind(history), listHistoryWindows: history.windows.bind(history) }, descriptor),
    ];
    for (const customTool of customTools) {
      allowedToolNames.push(customTool.name);
      const execute = customTool.execute.bind(customTool);
      customTool.execute = async (...args) => {
        if (evidence.tools.length >= options.maxToolCalls) { status = "budget_exhausted"; void session?.abort(); throw new Error("Evaluation tool budget reached"); }
        const trace = { name: customTool.name, args: args[1], phase, ok: false }; evidence.tools.push(trace);
        const result = await execute(...args); trace.ok = true; return result;
      };
    }
    const prompt = await assembleEvaluationPrompt({ repoDir: options.repoDir, root, descriptor, variant: options.variant, baselineRef: options.baselineRef });
    promptChars = prompt.length;
    promptHash = createHash("sha256").update(prompt.replaceAll(root, "<isolated-root>")).digest("hex");
    const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 2048 }, retry: { enabled: false }, transport: "sse" });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => prompt, appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir, authStorage: options.authStorage,
      modelRegistry: ModelRegistry.inMemory(options.authStorage), model: { ...options.model, maxTokens: Math.min(4096, options.model.maxTokens) },
      thinkingLevel: options.thinking, settingsManager: settings, resourceLoader: loader,
      sessionManager: SessionManager.open(descriptor.sessionFile!, undefined, root), customTools, tools: allowedToolNames,
    }));
    if (session.getActiveToolNames().some((name) => !allowedToolNames.includes(name))) throw new Error("Unexpected tool activated");
    if (options.scenario.agentBoundary) {
      if (options.mode !== "fresh") throw new Error("Agent-controlled rollover requires Fresh mode");
      runtime = new AgentRuntime({ descriptor, session, dataDir, getContextMode: () => "fresh", callbacks: { onStatusChange: () => {} } });
    } else if (options.mode === "fresh") session.setFreshContextHandler(createFreshContextHandler({ dataDir, descriptor, getContextMode: () => "fresh" }));
    session.subscribe((event) => {
      if (options.scenario.agentBoundary && event.type === "compaction_end" && !event.aborted) evidence.boundaries += 1;
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      const message = event.message;
      if (message.stopReason === "error" || message.stopReason === "aborted") { if (status === "completed") status = "infrastructure_error"; return; }
      totalTokens += message.usage.totalTokens;
      inputTokens += message.usage.input;
      outputTokens += message.usage.output;
      cachedTokens += message.usage.cacheRead;
      estimatedCost += message.usage.cost.total;
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (text) messages.push({ phase, text });
      if (totalTokens >= options.maxTokens) { status = "budget_exhausted"; void session?.abort(); }
    });
    const bounded = async (operation: () => Promise<unknown>) => {
      const timer = setTimeout(() => { status = "timeout"; void session?.abort(); session?.abortCompaction(); }, options.phaseTimeoutMs);
      try { await operation(); } finally { clearTimeout(timer); }
    };
    for (phase = 0; phase < options.scenario.inputs.length; phase += 1) {
      options.beforePhase?.(phase, session, evidence);
      failureStage = `prompt:${phase}`;
      await bounded(() => session!.prompt(options.scenario.inputs[phase]!));
      if (status !== "completed") break;
      evidence.completedPhases += 1;
      if (options.scenario.boundaryAfter.includes(phase)) {
        // Fixed settled boundaries expose recovery decisions; this is not an overflow/race test.
        const boundaryStart = performance.now();
        failureStage = `compact:${phase}`;
        await bounded(() => session!.compact());
        boundaryDurationMs += performance.now() - boundaryStart;
        if (status !== "completed") break;
        evidence.boundaries += 1;
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("hasHandlers")) failureReason = "missing_extension_runner";
      else if (error.message === "Nothing to compact (session too small)") failureReason = "nothing_to_compact";
      else if (error.message.startsWith("Summarization failed:") || error.message.startsWith("Turn prefix summarization failed:")) failureReason = "summary_provider_error";
    }
    if (status === "completed") status = "infrastructure_error";
    // Never emit raw provider/auth error text, request headers, or credential objects.
  } finally {
    await session?.abort();
    if (runtime) await runtime.terminate({ abort: false });
    else session?.dispose();
    await history?.dispose();
    // Canonical provider records are intentionally transient; only sanitized results leave this root.
    await rm(root, { recursive: true, force: true });
  }
  const score = scoreEvidence(evidence);
  return { scenario: options.scenario.id, task: options.scenario, variant: options.variant, mode: options.mode, status: status as AttemptStatus,
    passed: status === "completed" && score.passed, ...(status === "completed" ? {} : { failureStage, failureReason }), promptHash, promptChars, allowedToolNames,
    elapsedMs: Math.round(performance.now() - start), boundaryDurationMs: Math.round(boundaryDurationMs),
    usage: { totalTokens, inputTokens, outputTokens, cachedTokens, estimatedCost },
    score, evidence, messages,
  };
}
