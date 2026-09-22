import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { createCodexAppServerClient } from "../../codex-app-server/codex-app-server-client.js";
import type { CodexAppServerClientFactory, CodexAppServerClientPort } from "../../codex-app-server/types.js";
import { openSessionManagerWithSizeGuard } from "../../session-file-guard.js";
import type { AgentContextUsage, AgentDescriptor, AgentStatus, RequestedDeliveryMode, SendMessageReceipt } from "../../types.js";
import type { RuntimeCreationOptions, RuntimeSessionEvent, RuntimeShutdownOptions, RuntimeUserMessage, RuntimeUserMessageInput, SwarmAgentRuntime, SwarmRuntimeCallbacks } from "../../runtime-contracts.js";
import { normalizeRuntimeError, normalizeRuntimeUserMessage } from "../runtime-utils.js";
import { CodexRuntimeEvents } from "./codex-runtime-events.js";
import { CodexRuntimeTools } from "./codex-runtime-tools.js";
import { nativeCodexEnvironment, type CodexRuntimeAuth } from "./codex-runtime-auth.js";
import { buildModelChangeRecoveryContext } from "../model-change-recovery-context.js";
import { isConversationEntryEvent } from "../../conversation-validators.js";
import { getCatalogContextWindow } from "@forge/protocol";
import { assertNativeCodexVersion, resolveNativeCodexBinary } from "./codex-native-binary.js";
import { readNativeToolContract } from "./codex-tool-contract.js";

export const NATIVE_CODEX_STATE = "swarm_native_codex_state";
interface ThreadState { version: 1; threadId: string; ownerAgentId: string; cwd: string; promptDigest?: string; hasStartedTurn?: boolean }
interface ActiveTurn {
  id?: string;
  startedAt: number;
  failed?: boolean;
  finishing?: boolean;
  pendingSteers: Map<string, RuntimeUserMessage>;
  abort: AbortController;
  mapper: CodexRuntimeEvents;
  settled: Promise<void>;
  settle(): void;
}
interface Options {
  descriptor: AgentDescriptor;
  callbacks: SwarmRuntimeCallbacks;
  systemPrompt: string;
  codexHome: string;
  projectTrusted: boolean;
  auth: Pick<CodexRuntimeAuth, "login" | "refresh" | "release">;
  tools: ConstructorParameters<typeof CodexRuntimeTools>[0]["tools"];
  host: ConstructorParameters<typeof CodexRuntimeTools>[0]["host"];
  creationOptions?: RuntimeCreationOptions;
  createClient?: CodexAppServerClientFactory;
}

/** One app-server process and native thread per Forge runtime. No silent resume fallback. */
export class CodexAgentRuntime implements SwarmAgentRuntime {
  readonly runtimeType = "codex" as const;
  readonly descriptor: AgentDescriptor;
  private readonly client: CodexAppServerClientPort;
  private readonly session: SessionManager;
  private readonly bridge: CodexRuntimeTools;
  private readonly queued: RuntimeUserMessage[] = [];
  private threadId = "";
  private hasStartedTurn = false;
  private active?: ActiveTurn;
  private status: AgentStatus = "idle";
  private usage?: AgentContextUsage;
  private stopping = false;
  private closed = false;
  private dispatching = false;
  private operations: Promise<unknown> = Promise.resolve();
  private events: Promise<void> = Promise.resolve();
  private pinned?: string;
  private recoveryConsumed = false;

  private constructor(private readonly options: Options) {
    this.descriptor = options.descriptor;
    ensureSessionHeader(this.descriptor);
    const session = openSessionManagerWithSizeGuard(this.descriptor.sessionFile, { context: "codex-native" });
    if (!session) throw new Error("Could not open the Forge session for native Codex; history was left unchanged.");
    this.session = session;
    this.bridge = new CodexRuntimeTools({ tools: options.tools, agentId: this.descriptor.agentId,
      host: options.host, emit: event => this.emit(event) });
    this.client = (options.createClient ?? (handlers => createCodexAppServerClient(handlers, {
      command: resolveNativeCodexBinary(),
      args: ["app-server", "--listen", "stdio://", "-c", 'cli_auth_credentials_store="ephemeral"'],
      spawnOptions: { cwd: this.descriptor.cwd, env: nativeCodexEnvironment(options.codexHome) },
    })))({
      onNotification: (method, params) => {
        this.events = this.events.then(() => this.onNotification(method, record(params))).catch(error => this.fail(error, this.active?.finishing === true));
        return this.events;
      },
      onRequest: (method, params) => this.onRequest(method, record(params)),
      onExit: error => { if (!this.closed) void this.fail(error, true); },
    });
  }

  static async create(options: Options): Promise<CodexAgentRuntime> {
    if (!options.createClient) await assertNativeCodexVersion(resolveNativeCodexBinary(), nativeCodexEnvironment(options.codexHome));
    const runtime = new CodexAgentRuntime(options);
    try {
      await runtime.client.connect();
      await options.auth.login(runtime.client);
      const stored = runtime.getCustomEntries(NATIVE_CODEX_STATE).at(-1) as ThreadState | undefined;
      const config: Record<string, unknown> = {
        "shell_environment_policy.inherit": "core",
        "cli_auth_credentials_store": "ephemeral",
        "features.multi_agent": false,
      };
      if (options.projectTrusted) config[`projects.${JSON.stringify(options.descriptor.cwd)}.trust_level`] = "trusted";
      const common = { model: options.descriptor.model.modelId, cwd: options.descriptor.cwd,
        developerInstructions: options.systemPrompt, approvalPolicy: "never", sandbox: "danger-full-access", config,
        allowProviderModelFallback: false };
      // Model switches use Forge's explicit historical recovery block. Ordinary restarts resume.
      // Codex does not persist an unused thread. Recreate that empty allocation
      // after settings recycle; never discard a thread that has accepted a turn.
      // Forge can fork at an individual message, while native fork boundaries are
      // whole turns. Reconstruct forks from the already bounded canonical copy.
      const reuse = stored?.version === 1 && stored.ownerAgentId === options.descriptor.agentId && !options.creationOptions?.startupRecoveryContext && stored.hasStartedTurn !== false;
      const method = reuse ? "thread/resume" : "thread/start";
      const response = await runtime.client.request<any>(method, {
        ...common,
        ...(reuse ? { threadId: stored.threadId } : { dynamicTools: runtime.bridge.definitions(), ephemeral: false }),
      });
      if (typeof response?.thread?.id !== "string") throw new Error("Codex did not return a native thread identity");
      runtime.threadId = response.thread.id;
      if (response.model && response.model !== options.descriptor.model.modelId) {
        throw new Error(`Codex selected ${response.model} instead of the requested ${options.descriptor.model.modelId}.`);
      }
      if (reuse) runtime.bridge.restoreContract(await readNativeToolContract(response.thread.path, options.codexHome, runtime.threadId));
      runtime.hasStartedTurn = Boolean(reuse);
      if (!reuse) {
        const recovery = options.creationOptions?.startupRecoveryContext?.blockText
          ?? buildModelChangeRecoveryContext({ descriptor: options.descriptor,
            entries: runtime.getCustomEntries("swarm_conversation_entry").filter(isConversationEntryEvent),
            modelContextWindow: getCatalogContextWindow(options.descriptor.model.modelId, options.descriptor.model.provider),
            existingPrompt: options.systemPrompt,
          }).blockText;
        if (recovery) await runtime.client.request("thread/inject_items", { threadId: runtime.threadId, items: [{
          type: "message", role: "user", content: [{ type: "input_text", text: recovery }],
        }] });
      }
      const promptDigest = createHash("sha256").update(options.systemPrompt).digest("hex");
      // A resumed rollout retains earlier developer messages. Make a changed Forge
      // contract explicit in native history; never silently retain an old posture.
      if (reuse && stored.promptDigest !== promptDigest) {
        await runtime.client.request("thread/inject_items", { threadId: runtime.threadId, items: [{
          type: "message", role: "developer", content: [{ type: "input_text",
            text: `The following is the current Forge integration contract. It replaces earlier Forge integration instructions, including work routing. Native Codex instructions remain in effect.\n\n${options.systemPrompt}` }],
        }] });
      }
      runtime.appendCustomEntry(NATIVE_CODEX_STATE, { version: 1, threadId: runtime.threadId,
        ownerAgentId: options.descriptor.agentId, cwd: options.descriptor.cwd, promptDigest, hasStartedTurn: runtime.hasStartedTurn } satisfies ThreadState);
      return runtime;
    } catch (error) {
      runtime.closed = true;
      try { await runtime.client.shutdown?.(); }
      catch { throw new AggregateError([error], "Native Codex startup failed and subprocess cleanup is not confirmed."); }
      finally { runtime.client.dispose(); await options.auth.release(); }
      throw error;
    }
  }

  getStatus(): AgentStatus { return this.status; }
  getPendingCount(): number { return this.queued.length; }
  getContextUsage(): AgentContextUsage | undefined { return this.usage; }
  getSystemPrompt(): string { return this.options.systemPrompt; }
  hasPendingInputDispatch(): boolean { return this.dispatching; }
  setPinnedContent(content: string | undefined): void { this.pinned = content; }
  getCustomEntries(customType: string): unknown[] {
    return this.session.getEntries().filter(entry => entry.type === "custom" && entry.customType === customType)
      .map(entry => (entry as { data: unknown }).data);
  }
  appendCustomEntry(customType: string, data?: unknown): string { return this.session.appendCustomEntry(customType, data); }

  async sendMessage(input: RuntimeUserMessageInput, requestedMode: RequestedDeliveryMode = "auto"): Promise<SendMessageReceipt> {
    this.assertOpen();
    const message = normalizeRuntimeUserMessage(input);
    const deliveryId = randomUUID();
    return this.serialize(async () => {
      this.assertOpen();
      if (this.active?.finishing) await this.active.settled;
      if (this.active && requestedMode === "followUp") {
        this.queued.push(message);
        await this.publishStatus();
        return { targetAgentId: this.descriptor.agentId, deliveryId, acceptedMode: "followUp" };
      }
      if (this.active) {
        // No replay on an ambiguous transport error: a side effect may already have been accepted.
        const active = this.active;
        active.pendingSteers.set(deliveryId, message);
        try {
          await this.client.request("turn/steer", { threadId: this.threadId, expectedTurnId: active.id,
            input: nativeInput(message), clientUserMessageId: deliveryId });
        } catch (error) {
          if (typeof (error as { code?: unknown })?.code === "number") active.pendingSteers.delete(deliveryId);
          throw error;
        }
        this.recordUser(message);
        return { targetAgentId: this.descriptor.agentId, deliveryId, acceptedMode: "steer" };
      }
      await this.startTurn(message, deliveryId);
      return { targetAgentId: this.descriptor.agentId, deliveryId, acceptedMode: "prompt" };
    });
  }

  async compact(customInstructions?: string): Promise<unknown> {
    this.assertOpen();
    if (customInstructions?.trim()) throw new Error("Native Codex manages its own compaction prompt; custom compaction instructions are unavailable.");
    const active = await this.serialize(async () => {
      this.assertOpen();
      if (this.active) throw new Error("Wait for the native Codex turn to finish before compacting.");
      const turn = this.beginTurn();
      await this.publishStatus();
      await this.emit({ type: "agent_start" });
      try {
        await this.client.request("thread/compact/start", { threadId: this.threadId });
      } catch (error) {
        await this.fail(error, typeof (error as { code?: unknown })?.code === "number");
        throw error;
      }
      return turn;
    });
    await active.settled;
    if (active.failed || this.status === "error" || active.abort.signal.aborted) throw new Error("Native Codex compaction did not complete.");
    return {};
  }
  async smartCompact(customInstructions?: string): Promise<{ compacted: true }> { await this.compact(customInstructions); return { compacted: true }; }

  async stopInFlight(options?: RuntimeShutdownOptions): Promise<void> {
    if (this.closed) return;
    this.stopping = true;
    this.queued.length = 0;
    const timeout = options?.shutdownTimeoutMs ?? 3_000;
    const expires = Date.now() + timeout;
    const remaining = () => Math.max(1, expires - Date.now());
    {
      await deadline(this.operations, remaining());
      const active = this.active;
      active?.abort.abort();
      if (active && !active.id && !this.client.isDisposed()) {
        throw new Error("Native Codex turn acceptance is uncertain; replacement remains blocked until its identity is confirmed.");
      }
      if (active?.id) {
        await this.client.request("turn/interrupt", { threadId: this.threadId, turnId: active.id }, remaining());
        await deadline(active.settled, remaining());
      }
      if (!this.client.isDisposed()) await this.client.request("thread/backgroundTerminals/clean", { threadId: this.threadId }, remaining());
      await deadline(this.bridge.drain(), remaining());
      await deadline(this.events, remaining());
      // Forge detaches stopped runtimes. Release the native thread writer before
      // reporting cleanup complete so the next runtime can resume its history.
      if (!this.client.shutdown) throw new Error("Native Codex client cannot confirm process exit");
      await this.client.shutdown(remaining());
      await this.options.auth.release();
      this.closed = true;
      this.status = "idle";
      await this.publishStatus();
      this.stopping = false;
    }
  }

  async terminate(options?: RuntimeShutdownOptions): Promise<void> {
    await this.shutdownForReplacement(options);
    this.status = "terminated";
    await this.publishStatus();
  }
  async shutdownForReplacement(options?: RuntimeShutdownOptions): Promise<void> {
    await this.stopInFlight(options);
  }
  async recycle(): Promise<void> { await this.shutdownForReplacement(); }

  private async startTurn(message: RuntimeUserMessage, deliveryId: string): Promise<void> {
    this.dispatching = true;
    const active = this.beginTurn();
    let submitted = false;
    try {
      await this.publishStatus();
      await this.emit({ type: "agent_start" });
      await this.emit({ type: "turn_start" });
      await this.options.auth.login(this.client);
      // Activate Forge's queued input/output target before native output can
      // arrive. turn_start alone does not consume an inbound user message.
      await this.emit({ type: "message_start", message: { role: "user", content: message.text } });
      const text = [this.pinned ? `<forge_pinned_context>\n${this.pinned}\n</forge_pinned_context>` : undefined, message.text].filter(Boolean).join("\n\n");
      submitted = true;
      const response = await this.client.request<any>("turn/start", { threadId: this.threadId,
        input: nativeInput({ ...message, text }), model: this.descriptor.model.modelId,
        effort: this.descriptor.model.thinkingLevel, clientUserMessageId: deliveryId });
      if (typeof response?.turn?.id !== "string") throw new Error("Codex did not acknowledge a turn identity");
      active.id = response.turn.id;
      this.markThreadStarted();
      this.recordUser(message);
      if (!this.recoveryConsumed) {
        await this.options.creationOptions?.onStartupRecoveryConsumed?.();
        this.recoveryConsumed = true;
      }
    } catch (error) {
      // A protocol rejection is acknowledged failure; a lost response is uncertain ownership.
      await this.fail(error, !submitted || typeof (error as { code?: unknown })?.code === "number");
      throw error;
    }
    finally { this.dispatching = false; }
  }

  private markThreadStarted(): void {
    if (this.hasStartedTurn) return;
    this.hasStartedTurn = true;
    const state = this.getCustomEntries(NATIVE_CODEX_STATE).at(-1) as ThreadState;
    this.appendCustomEntry(NATIVE_CODEX_STATE, { ...state, hasStartedTurn: true } satisfies ThreadState);
  }

  private beginTurn(): ActiveTurn {
    let settle!: () => void;
    const active: ActiveTurn = { startedAt: Date.now(), pendingSteers: new Map(), abort: new AbortController(), mapper: new CodexRuntimeEvents(),
      settled: new Promise<void>(resolve => { settle = resolve; }), settle: () => settle() };
    this.active = active;
    this.status = "streaming";
    return active;
  }

  private async onRequest(method: string, params: Record<string, any>): Promise<unknown> {
    if (method === "account/chatgptAuthTokens/refresh") return this.options.auth.refresh();
    await this.events;
    const active = this.active;
    if (!active || params.threadId !== this.threadId || (active.id && params.turnId !== active.id)) {
      throw new Error("Codex request is not owned by the active Forge turn");
    }
    return this.bridge.request(method, method === "item/fileChange/requestApproval"
      ? { ...params, forgeFileChanges: active.mapper.fileChangeApproval(params.itemId) } : params, active.abort.signal);
  }

  private async onNotification(method: string, params: Record<string, any>): Promise<void> {
    if (params.threadId !== this.threadId) return;
    const active = this.active;
    if (!active) return;
    const turnId = params.turnId ?? params.turn?.id;
    if (active.id && turnId && turnId !== active.id) return;
    if (method === "turn/started") { active.id = params.turn?.id; this.markThreadStarted(); return; }
    if (method === "error" && params.willRetry === true) {
      await this.options.callbacks.onRuntimeError?.(this.descriptor.agentId, {
        phase: "prompt_start", message: `Codex is retrying: ${String(params.error?.message ?? "Provider request failed")}`,
        details: { preserveActiveTurn: true, nativeRetry: true },
      });
      return;
    }
    if (params.item?.type === "userMessage" && params.item.clientId) {
      const consumed = active.pendingSteers.get(params.item.clientId);
      if (consumed) {
        active.pendingSteers.delete(params.item.clientId);
        // An accepted steer is not consumed until Codex emits its user item.
        // Activate it once, preserving suppression of output from older input.
        await this.emit({ type: "message_start", message: { role: "user", content: consumed.text } });
      }
    }
    if (method === "thread/tokenUsage/updated") {
      const tokens = params.tokenUsage?.last?.totalTokens;
      const window = params.tokenUsage?.modelContextWindow;
      if (typeof tokens === "number" && typeof window === "number") {
        this.usage = { tokens, contextWindow: window, percent: window ? tokens / window * 100 : 0 };
        await this.publishStatus();
      }
      return;
    }
    for (const event of active.mapper.map(method, params)) await this.emit(event);
    if (method === "turn/completed") {
      active.finishing = true;
      active.failed = params.turn?.status === "failed";
      if (params.turn?.status === "interrupted" || active.failed) active.abort.abort();
      // Codex can acknowledge a steer before consuming it. Preserve cancelled
      // pending input as history, without starting another execution turn.
      if (active.pendingSteers.size) {
        await this.client.request("thread/inject_items", { threadId: this.threadId,
          items: [...active.pendingSteers.values()].map(message => ({ type: "message", role: "user", content: [
            { type: "input_text", text: `Historical user input sent during the previous turn, which has now ended. Preserve this context; do not restart cancelled work automatically.\n\n${message.text}` },
            ...(message.images ?? []).map(image => ({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}`, detail: "auto" })),
          ] })),
        });
        active.pendingSteers.clear();
      }
      for (const event of active.mapper.finish()) await this.emit(event);
      await this.emit({ type: "turn_end", toolResults: [], meta: { provider: this.descriptor.model.provider,
        modelId: this.descriptor.model.modelId, api: "codex-app-server", providerSessionId: this.threadId,
        durationMs: Date.now() - active.startedAt, outcome: params.turn?.status, requestPayloadFidelity: "unavailable" } });
      if (params.turn?.status === "failed") await this.options.callbacks.onRuntimeError?.(this.descriptor.agentId,
        { ...normalizeRuntimeError(params.turn?.error?.message ?? "Native Codex turn failed"), phase: "prompt_start" });
      this.active = undefined;
      active.settle();
      // The native thread remains usable after an acknowledged turn failure.
      this.status = "idle";
      await this.emit({ type: "agent_end" });
      await this.publishStatus();
      await this.options.callbacks.onAgentEnd?.(this.descriptor.agentId);
      this.dispatchQueued();
    }
  }

  private dispatchQueued(): void {
    if (this.stopping || this.closed || this.active || this.queued.length === 0) return;
    const next = this.queued.shift()!;
    void this.sendMessage(next).catch(error => this.fail(error));
  }
  private recordUser(message: RuntimeUserMessage): void {
    this.session.appendMessage({ role: "user", content: message.text, timestamp: Date.now() });
  }
  private async emit(event: RuntimeSessionEvent): Promise<void> {
    if (event.type === "message_end") this.session.appendMessage({ ...event.message,
      api: "codex-app-server", provider: this.descriptor.model.provider, model: this.descriptor.model.modelId,
      // Pi also reads this durable envelope after a runtime switch. Native usage
      // is unavailable per assistant item; these are compatibility placeholders,
      // not provider billing or generation measurements.
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: Date.now() } as never);
    await this.options.callbacks.onSessionEvent?.(this.descriptor.agentId, event);
  }
  private async publishStatus(): Promise<void> {
    await this.options.callbacks.onStatusChange(this.descriptor.agentId, this.status, this.getPendingCount(), this.usage);
  }
  private async fail(error: unknown, terminal = false): Promise<void> {
    const active = this.active;
    active?.abort.abort();
    if (terminal) {
      this.active = undefined;
      if (active) {
        for (const event of active.mapper.finish()) await this.emit(event);
        await this.emit({ type: "agent_end" });
        active.settle();
      }
    }
    if (active) active.failed = true;
    this.status = terminal && !this.client.isDisposed() ? "idle" : "error";
    await this.options.callbacks.onRuntimeError?.(this.descriptor.agentId, { ...normalizeRuntimeError(error), phase: "prompt_start" });
    await this.publishStatus();
    if (terminal && active) await this.options.callbacks.onAgentEnd?.(this.descriptor.agentId);
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.operations.then(work);
    this.operations = next.catch(() => undefined);
    return next;
  }
  private assertOpen(): void {
    if (this.closed || this.stopping || this.client.isDisposed() || (this.status === "error" && this.active)) {
      throw new Error("Native Codex runtime is stopped or unavailable; settle the previous turn before continuing");
    }
  }
}

function nativeInput(message: RuntimeUserMessage) {
  return [{ type: "text", text: message.text, text_elements: [] },
    ...(message.images ?? []).map(image => ({ type: "image", url: `data:${image.mimeType};base64,${image.data}` }))];
}
function record(value: unknown): Record<string, any> { return value && typeof value === "object" ? value as Record<string, any> : {}; }
async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Native Codex cleanup has not settled; runtime replacement remains blocked")), ms);
  })]); } finally { if (timer) clearTimeout(timer); }
}

function ensureSessionHeader(descriptor: AgentDescriptor): void {
  mkdirSync(dirname(descriptor.sessionFile), { recursive: true });
  let exists = true;
  try { if (statSync(descriptor.sessionFile).size > 0) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; exists = false; }
  writeFileSync(descriptor.sessionFile, `${JSON.stringify({ type: "session", version: 3,
    id: randomUUID(), timestamp: new Date().toISOString(), cwd: descriptor.cwd })}\n`, { flag: exists ? "w" : "wx", mode: 0o600 });
}
