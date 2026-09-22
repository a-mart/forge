import type { Usage } from "@anthropic-ai/sdk/resources/messages";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { query, type Options as QueryOptions, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getCatalogContextWindow } from "@forge/protocol";
import { openSessionManagerWithSizeGuard } from "../../session-file-guard.js";
import { isConversationEntryEvent } from "../../conversation-validators.js";
import type { AgentContextUsage, AgentDescriptor, AgentStatus, RequestedDeliveryMode, SendMessageReceipt } from "../../types.js";
import type { RuntimeCreationOptions, RuntimeSessionEvent, RuntimeShutdownOptions, RuntimeUserMessage, RuntimeUserMessageInput, SwarmAgentRuntime, SwarmRuntimeCallbacks } from "../../runtime-contracts.js";
import type { SwarmToolHost } from "../../swarm-tool-host.js";
import { normalizeRuntimeUserMessage } from "../runtime-utils.js";
import { buildModelChangeRecoveryContext } from "../model-change-recovery-context.js";
import { ClaudeRuntimeTools } from "./claude-runtime-tools.js";
import { ClaudeRuntimeEvents } from "./claude-runtime-events.js";
import { guardSecureRuntimeValue, SECURE_RUNTIME_GUARD_FAILURE_MESSAGE } from "../../secure-sessions/runtime/secure-runtime-binding.js";

export const NATIVE_CLAUDE_STATE = "swarm_native_claude_state";
interface NativeState { version: 1; sessionId: string; ownerAgentId: string; cwd: string; hasStartedTurn: boolean }
interface Input { id: ReturnType<typeof randomUUID>; message: RuntimeUserMessage; activated: boolean; compact?: { resolve(value: unknown): void; reject(error: Error): void } }
export interface ClaudeRuntimeOptions {
  descriptor: AgentDescriptor;
  systemPrompt: string;
  callbacks: SwarmRuntimeCallbacks;
  tools: ToolDefinition<any, any, any>[];
  host: Pick<SwarmToolHost, "requestUserChoice">;
  env: NodeJS.ProcessEnv;
  executable: string;
  projectTrusted: boolean;
  creationOptions?: RuntimeCreationOptions;
  createQuery?: typeof query;
}

/** A persistent native query owns the loop. Forge owns delivery, history, and cleanup. */
export class ClaudeAgentRuntime implements SwarmAgentRuntime {
  readonly runtimeType = "claude" as const;
  readonly descriptor: AgentDescriptor;
  private readonly session: SessionManager;
  private readonly abort = new AbortController();
  private readonly bridge: ClaudeRuntimeTools;
  private readonly input = new ClaudeInputQueue();
  private readonly sent = new Map<string, Input>();
  private readonly followUps: Input[] = [];
  private readonly mapper = new ClaudeRuntimeEvents();
  private native!: Query;
  private reader: Promise<void> = Promise.resolve();
  private childExit: Promise<void> = Promise.resolve();
  private operations: Promise<unknown> = Promise.resolve();
  private state!: NativeState;
  private status: AgentStatus = "idle";
  private usage?: AgentContextUsage;
  private contextWindow?: number;
  private turnOpen = false;
  private turnError?: string;
  private stopping = false;
  private closed = false;
  private recovery?: string;
  private recoveryConsumed = false;
  private pinned?: string;
  private previousCost = 0;
  private turnCompaction?: Input["compact"];

  private constructor(private readonly options: ClaudeRuntimeOptions) {
    this.descriptor = structuredClone(options.descriptor);
    ensureSessionHeader(this.descriptor);
    const session = openSessionManagerWithSizeGuard(this.descriptor.sessionFile, { context: "claude-native" });
    if (!session) throw new Error("Could not open the Forge session for native Claude; history was left unchanged.");
    this.session = session;
    this.bridge = new ClaudeRuntimeTools({ ...options, agentId: this.descriptor.agentId,
      signal: this.abort.signal, guard: value => this.guard(value) });
  }

  static async create(options: ClaudeRuntimeOptions): Promise<ClaudeAgentRuntime> {
    const runtime = new ClaudeAgentRuntime(options);
    const stored = runtime.getCustomEntries(NATIVE_CLAUDE_STATE).at(-1) as NativeState | undefined;
    // Forge supports message-bounded forks. Reconstruct those from the bounded
    // canonical copy; resuming the parent's full native thread would leak later turns.
    const resume = stored?.version === 1 && stored.ownerAgentId === options.descriptor.agentId
      && stored.cwd === options.descriptor.cwd && stored.hasStartedTurn && !options.creationOptions?.startupRecoveryContext;
    runtime.state = resume ? stored : { version: 1, sessionId: randomUUID(), ownerAgentId: options.descriptor.agentId, cwd: options.descriptor.cwd, hasStartedTurn: false };
    if (!resume) runtime.recovery = options.creationOptions?.startupRecoveryContext?.blockText
      ?? buildModelChangeRecoveryContext({ descriptor: options.descriptor,
        entries: runtime.getCustomEntries("swarm_conversation_entry").filter(isConversationEntryEvent),
        modelContextWindow: getCatalogContextWindow(options.descriptor.model.modelId, options.descriptor.model.provider), existingPrompt: options.systemPrompt }).blockText;
    const level = options.descriptor.model.thinkingLevel;
    const sdkOptions: QueryOptions = {
      cwd: options.descriptor.cwd, env: options.env, pathToClaudeCodeExecutable: options.executable,
      ...(resume ? { resume: runtime.state.sessionId } : { sessionId: runtime.state.sessionId }),
      model: options.descriptor.model.modelId,
      effort: level as QueryOptions["effort"],
      systemPrompt: { type: "preset", preset: "claude_code", append: options.systemPrompt },
      settingSources: options.projectTrusted ? ["project", "local"] : [],
      settings: { autoMemoryEnabled: false },
      permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
      persistSession: true, includePartialMessages: true,
      disallowedTools: ["Agent", "Task", "Workflow", "SendMessage", "ListAgents", "TeamCreate", "TeamDelete", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TodoWrite", "CronCreate", "CronDelete", "CronList", "EnterWorktree", "ExitWorktree", "EnterPlanMode", "ExitPlanMode"],
      mcpServers: { forge: runtime.bridge.server }, strictMcpConfig: true,
      canUseTool: runtime.bridge.canUseTool,
      hooks: { PostToolUse: [{ hooks: [async event => event.hook_event_name === "PostToolUse"
        ? { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: runtime.guard(event.tool_response) } } : {}] }] },
      spawnClaudeCodeProcess(spawnOptions) {
        const child = spawn(spawnOptions.command, spawnOptions.args, { cwd: spawnOptions.cwd, env: spawnOptions.env,
          signal: spawnOptions.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        runtime.childExit = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => { if (!child.pid) resolve(); }); });
        return child;
      },
    };
    try {
      runtime.native = (options.createQuery ?? query)({ prompt: runtime.input, options: sdkOptions });
      runtime.reader = runtime.read();
      await runtime.native.initializationResult();
      const models = await runtime.native.supportedModels();
      const model = models.find(m => m.value === options.descriptor.model.modelId || m.resolvedModel === options.descriptor.model.modelId);
      if (model?.supportedEffortLevels && !model.supportedEffortLevels.includes(level as never)) {
        throw new Error(`Claude native does not support reasoning ${level} for this model. Choose ${model.supportedEffortLevels.join(", ")}.`);
      }
      if (runtime.status === "error") throw new Error("Claude native exited during startup. Check its authentication and runtime configuration.");
      runtime.appendCustomEntry(NATIVE_CLAUDE_STATE, runtime.state);
      return runtime;
    } catch (error) {
      await runtime.stopInFlight({ shutdownTimeoutMs: 10_000 });
      throw error;
    }
  }

  getStatus(): AgentStatus { return this.status; }
  getPendingCount(): number { return this.sent.size + this.followUps.length; }
  hasPendingInputDispatch(): boolean { return this.getPendingCount() > 0; }
  getContextUsage(): AgentContextUsage | undefined { return this.usage; }
  getSystemPrompt(): string { return this.options.systemPrompt; }
  setPinnedContent(content: string | undefined): void { this.pinned = content; }
  getCustomEntries(type: string): unknown[] { return this.session.getEntries().filter(e => e.type === "custom" && e.customType === type).map(e => (e as { data: unknown }).data); }
  appendCustomEntry(type: string, data?: unknown): string { return this.session.appendCustomEntry(type, data); }

  async sendMessage(input: RuntimeUserMessageInput, mode: RequestedDeliveryMode = "auto"): Promise<SendMessageReceipt> {
    return this.serialize(async () => {
      this.assertOpen();
      const value: Input = { id: randomUUID(), message: normalizeRuntimeUserMessage(input), activated: false };
      const busy = this.turnOpen || this.sent.size > 0;
      if (busy && mode === "followUp") { this.followUps.push(value); await this.publishStatus(); }
      else await this.submit(value);
      return { targetAgentId: this.descriptor.agentId, deliveryId: value.id,
        acceptedMode: busy ? mode === "followUp" ? "followUp" : "steer" : "prompt" };
    });
  }

  async compact(instructions?: string): Promise<unknown> {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    await this.serialize(async () => {
      this.assertOpen();
      if (this.turnOpen || this.sent.size || this.followUps.length) throw new Error("Wait for the Claude turn to finish before compacting.");
      await this.submit({ id: randomUUID(), message: { text: `/compact${instructions?.trim() ? ` ${instructions.trim()}` : ""}` }, activated: false, compact: { resolve, reject } });
    });
    return result;
  }
  async smartCompact(instructions?: string): Promise<{ compacted: true }> { await this.compact(instructions); return { compacted: true }; }

  async stopInFlight(options?: RuntimeShutdownOptions): Promise<void> {
    if (this.closed) return;
    this.stopping = true;
    this.abort.abort();
    this.input.end();
    // Close, rather than just interrupt: native queued sends and background tasks
    // can survive an interrupt. Replacement waits for the real child exit.
    this.native?.close();
    await deadline(Promise.all([this.childExit, this.reader.catch(() => undefined), this.bridge.drain()]), options?.shutdownTimeoutMs ?? 3_000);
    await this.operations;
    for (const input of [...this.sent.values(), ...this.followUps]) input.compact?.reject(new Error("Claude compaction stopped"));
    this.turnCompaction?.reject(new Error("Claude compaction stopped"));
    this.turnCompaction = undefined;
    this.sent.clear(); this.followUps.length = 0;
    const hadTurn = this.turnOpen;
    this.turnOpen = false;
    this.closed = true;
    this.status = "idle";
    if (hadTurn) {
      for (const event of this.mapper.finish(false)) await this.emit(event);
      await this.emit({ type: "agent_end" });
    }
    await this.publishStatus();
  }
  async terminate(options?: RuntimeShutdownOptions): Promise<void> { await this.stopInFlight(options); this.status = "terminated"; await this.publishStatus(); }
  async shutdownForReplacement(options?: RuntimeShutdownOptions): Promise<void> { await this.stopInFlight(options); }
  async recycle(): Promise<void> { await this.stopInFlight(); }

  private async submit(input: Input): Promise<void> {
    const first = !this.turnOpen && this.sent.size === 0;
    this.sent.set(input.id, input);
    this.status = "streaming";
    if (first) { await this.begin(); await this.activate(input); }
    const text = [this.recovery, this.pinned ? `<forge_pinned_context>\n${this.pinned}\n</forge_pinned_context>` : undefined, input.message.text].filter(Boolean).join("\n\n");
    if (!input.compact) this.session.appendMessage({ role: "user", content: input.message.text, timestamp: Date.now() });
    this.state.hasStartedTurn = true;
    this.appendCustomEntry(NATIVE_CLAUDE_STATE, this.state);
    this.input.push({ type: "user", uuid: input.id, session_id: this.state.sessionId, parent_tool_use_id: null,
      message: { role: "user", content: input.compact ? input.message.text : [{ type: "text", text }, ...(input.message.images ?? []).map(image => ({
        type: "image" as const, source: { type: "base64" as const, media_type: image.mimeType as "image/png", data: image.data },
      }))] } });
    this.recovery = undefined;
    await this.publishStatus();
  }

  private async begin(): Promise<void> {
    if (this.turnOpen) return;
    this.turnOpen = true; this.status = "streaming";
    await this.emit({ type: "agent_start" }); await this.emit({ type: "turn_start" });
  }
  private async activate(input: Input): Promise<void> {
    if (input.activated) return;
    input.activated = true;
    if (input.compact) this.turnCompaction = input.compact;
    else await this.emit({ type: "message_start", message: { role: "user", content: input.message.text } });
  }

  private async read(): Promise<void> {
    try {
      for await (const frame of this.native) await this.serialize(async () => {
        if (!this.stopping) await this.handle(this.guard(frame));
      });
      if (!this.stopping) await this.fail(new Error("Claude native process ended unexpectedly. Retry after stopping the session."));
    } catch (error) { if (!this.stopping) await this.fail(error); }
  }

  private async handle(frame: SDKMessage): Promise<void> {
    if (this.stopping || ("parent_tool_use_id" in frame && frame.parent_tool_use_id)) return;
    if (frame.type === "system" && frame.subtype === "init" && frame.session_id !== this.state.sessionId) {
      throw new Error("Claude returned a different native session identity; refusing to replace the stored conversation.");
    }
    // A queue write is acceptance only. Native echoes identify actual consumption,
    // including every member of coalesced batches; never replay ambiguous input.
    const ids = "user_message_uuids" in frame && frame.user_message_uuids
      ? frame.user_message_uuids : "user_message_uuid" in frame && frame.user_message_uuid ? [frame.user_message_uuid] : [];
    for (const id of ids) {
      const input = this.sent.get(id);
      if (!input) continue;
      await this.begin(); await this.activate(input); this.sent.delete(id);
      if (!this.recoveryConsumed) { await this.options.creationOptions?.onStartupRecoveryConsumed?.(); this.recoveryConsumed = true; }
    }
    // API failures arrive as synthetic assistant messages and can use a
    // "success" result envelope with is_error=true. Keep the explanation for
    // the runtime error path rather than dropping it as unfinished progress.
    if (frame.type === "assistant" && frame.error) {
      this.turnError = frame.message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    } else {
      for (const event of this.mapper.map(frame)) await this.emit(event);
    }
    if (frame.type === "stream_event" && frame.event.type === "message_start") {
      const usage = frame.event.message.usage;
      const tokens = contextInputTokens(usage);
      const contextWindow = this.contextWindow ?? getCatalogContextWindow(this.descriptor.model.modelId, this.descriptor.model.provider) ?? 200_000;
      this.usage = { tokens, contextWindow, percent: tokens / contextWindow * 100 }; await this.publishStatus();
    }
    if (frame.type !== "result") return;
    // Native account/model limits can differ from the catalog (for example,
    // extended context eligibility). Prefer the limit reported by this session.
    const nativeUsage = frame.modelUsage[this.descriptor.model.modelId]
      ?? (Object.keys(frame.modelUsage).length === 1 ? Object.values(frame.modelUsage)[0] : undefined);
    if (nativeUsage && Number.isFinite(nativeUsage.contextWindow) && nativeUsage.contextWindow > 0) {
      this.contextWindow = nativeUsage.contextWindow;
      if (this.usage) this.usage = { ...this.usage, contextWindow: this.contextWindow,
        percent: this.usage.tokens / this.contextWindow * 100 };
    }
    const success = !frame.is_error;
    for (const event of this.mapper.finish(success, success && frame.subtype === "success" ? frame.result : undefined)) await this.emit(event);
    const cost = Math.max(0, frame.total_cost_usd - this.previousCost); this.previousCost = frame.total_cost_usd;
    await this.emit({ type: "turn_end", toolResults: [], meta: { provider: this.descriptor.model.provider, modelId: this.descriptor.model.modelId,
      api: "claude-agent-sdk", providerSessionId: this.state.sessionId, durationMs: frame.duration_ms, durationApiMs: frame.duration_api_ms,
      outcome: frame.subtype, requestPayloadFidelity: "unavailable", costUsd: { total: cost }, usage: {
        input: frame.usage.input_tokens, output: frame.usage.output_tokens,
        cacheRead: frame.usage.cache_read_input_tokens, cacheWrite: frame.usage.cache_creation_input_tokens,
      } } });
    const compaction = this.turnCompaction; this.turnCompaction = undefined;
    if (!success) {
      const error = new Error(("errors" in frame ? frame.errors.join("\n") : "")
        || this.turnError || (frame.subtype === "success" ? frame.result : "") || "Claude turn failed");
      compaction?.reject(error);
      await this.options.callbacks.onRuntimeError?.(this.descriptor.agentId, { phase: "prompt_start", message: error.message });
    } else compaction?.resolve({});
    this.turnError = undefined;
    this.turnOpen = false;
    this.status = this.sent.size ? "streaming" : "idle";
    await this.emit({ type: "agent_end" }); await this.publishStatus();
    await this.options.callbacks.onAgentEnd?.(this.descriptor.agentId);
    if (!this.stopping && !this.sent.size && this.followUps.length) await this.submit(this.followUps.shift()!);
  }

  private guard<T>(value: T): T {
    const binding = this.options.creationOptions?.secureRuntimeBinding;
    return binding ? guardSecureRuntimeValue(binding, value) : value;
  }
  private async emit(event: RuntimeSessionEvent): Promise<void> {
    event = this.guard(event);
    if (event.type === "message_end") this.session.appendMessage({ ...event.message,
      api: "claude-agent-sdk", provider: this.descriptor.model.provider, model: this.descriptor.model.modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() } as never);
    await this.options.callbacks.onSessionEvent?.(this.descriptor.agentId, event);
  }
  private async publishStatus(): Promise<void> { await this.options.callbacks.onStatusChange(this.descriptor.agentId, this.status, this.getPendingCount(), this.usage); }
  private async fail(error: unknown): Promise<void> {
    this.status = "error";
    let message = SECURE_RUNTIME_GUARD_FAILURE_MESSAGE;
    try { message = this.guard(error instanceof Error ? error.message : String(error)); } catch { /* Never echo rejected guard input. */ }
    this.turnCompaction?.reject(new Error(message));
    for (const input of this.sent.values()) input.compact?.reject(new Error(message));
    await this.options.callbacks.onRuntimeError?.(this.descriptor.agentId, { phase: "runtime_exit", message });
    await this.publishStatus();
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> { const result = this.operations.then(work); this.operations = result.catch(() => undefined); return result; }
  private assertOpen(): void { if (this.closed || this.stopping || this.status === "error") throw new Error("Claude native is stopped or unavailable. Settle the previous runtime before continuing."); }
}

class ClaudeInputQueue implements AsyncIterableIterator<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private waiting?: (value: IteratorResult<SDKUserMessage>) => void;
  private ended = false;
  push(value: SDKUserMessage): void { if (this.ended) throw new Error("Claude input is closed"); if (this.waiting) { this.waiting({ done: false, value }); this.waiting = undefined; } else this.values.push(value); }
  end(): void { this.ended = true; this.values.length = 0; this.waiting?.({ done: true, value: undefined }); this.waiting = undefined; }
  [Symbol.asyncIterator](): AsyncIterableIterator<SDKUserMessage> { return this; }
  next(): Promise<IteratorResult<SDKUserMessage>> { if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift()! }); if (this.ended) return Promise.resolve({ done: true, value: undefined }); return new Promise(resolve => { this.waiting = resolve; }); }
}

async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Claude cleanup has not settled; runtime replacement remains blocked.")), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function ensureSessionHeader(descriptor: AgentDescriptor): void {
  mkdirSync(dirname(descriptor.sessionFile), { recursive: true });
  let exists = true;
  try { if (statSync(descriptor.sessionFile).size > 0) return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; exists = false; }
  writeFileSync(descriptor.sessionFile, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: descriptor.cwd })}\n`, { flag: exists ? "w" : "wx", mode: 0o600 });
}

function contextInputTokens(usage: Pick<Usage, "input_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens">): number {
  return usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}
