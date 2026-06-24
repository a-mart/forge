import type { AgentDescriptor } from "../swarm/types.js";
import { AgentRuntime, buildHandoffFilePath, buildHandoffPrompt, buildResumePrompt } from "../swarm/agent-runtime.js";
import {
  createStaticCompactionRuntimeSettingsProvider,
  type CompactionRuntimeSettingsProvider,
} from "../swarm/compaction-runtime-settings-provider.js";

export class CompactionGuardFakeSession {
  isStreaming = true;
  promptCalls: string[] = [];
  abortCalls = 0;
  abortCompactionCalls = 0;
  compactCalls = 0;
  promptImpl: ((message: string) => Promise<void>) | undefined;
  abortImpl: (() => Promise<void>) | undefined;
  compactImpl: (() => Promise<unknown>) | undefined;
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  listener: ((event: unknown) => void) | undefined;
  entries: Array<Record<string, unknown>> = [];

  readonly sessionManager = {
    getEntries: () => this.entries,
    buildSessionContext: () => ({ messages: [] as unknown[] }),
    resetLeaf: () => {},
    appendModelChange: () => {},
    appendThinkingLevelChange: () => {},
    appendMessage: () => {},
    appendCustomEntry: () => "custom-id",
  };

  readonly model = { provider: "openai-codex", id: "gpt-5.5" };
  readonly thinkingLevel = "medium";
  readonly state = { messages: [] as Array<{ role?: string; stopReason?: string }> };
  readonly agent = {
    state: this.state,
    continue: async () => {},
  };
  readonly modelRegistry = {
    authStorage: {
      get: () => undefined,
      set: () => {},
      has: () => false,
    },
  };

  async prompt(message: string): Promise<void> {
    this.promptCalls.push(message);
    if (this.promptImpl) {
      await this.promptImpl(message);
    }
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    if (this.abortImpl) {
      await this.abortImpl();
    }
  }

  abortCompaction(): void {
    this.abortCompactionCalls += 1;
  }

  async compact(): Promise<unknown> {
    this.compactCalls += 1;
    if (this.compactImpl) {
      return this.compactImpl();
    }
    this.entries.push({ type: "compaction", id: `compact-${this.compactCalls}` });
    return { ok: true };
  }

  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined {
    return this.contextUsage;
  }

  dispose(): void {}

  subscribe(listener: (event: unknown) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
}

export function makeCompactionGuardDescriptor(): AgentDescriptor {
  return {
    agentId: "guard-worker",
    displayName: "Guard Worker",
    role: "worker",
    managerId: "manager",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
    },
    sessionFile: "/tmp/project/session.jsonl",
  };
}

export const COMPACTION_GUARD_TEST_TIMEOUT_MS = 180_000;

export function createCompactionGuardTestSettingsProvider(
  timeoutMs = COMPACTION_GUARD_TEST_TIMEOUT_MS,
): CompactionRuntimeSettingsProvider {
  return createStaticCompactionRuntimeSettingsProvider({ timeoutMs });
}

export function createCompactionGuardRuntime(options?: {
  session?: CompactionGuardFakeSession;
  compactionRuntimeSettingsProvider?: CompactionRuntimeSettingsProvider;
}): {
  runtime: AgentRuntime;
  session: CompactionGuardFakeSession;
  runtimeErrors: Array<{ phase: string; message: string; details?: Record<string, unknown> }>;
} {
  const session = options?.session ?? new CompactionGuardFakeSession();
  const runtimeErrors: Array<{ phase: string; message: string; details?: Record<string, unknown> }> = [];

  const runtime = new AgentRuntime({
    descriptor: makeCompactionGuardDescriptor(),
    session: session as never,
    compactionRuntimeSettingsProvider:
      options?.compactionRuntimeSettingsProvider ?? createCompactionGuardTestSettingsProvider(),
    callbacks: {
      onStatusChange: () => {},
      onSessionEvent: () => {},
      onRuntimeError: (_agentId, error) => {
        runtimeErrors.push({
          phase: error.phase,
          message: error.message,
          details: error.details,
        });
      },
    },
  });

  return { runtime, session, runtimeErrors };
}

export function hasCompactionRecord(entries: Array<Record<string, unknown>>): boolean {
  return entries.some((entry) => entry.type === "compaction");
}

export { buildHandoffFilePath, buildHandoffPrompt, buildResumePrompt };
