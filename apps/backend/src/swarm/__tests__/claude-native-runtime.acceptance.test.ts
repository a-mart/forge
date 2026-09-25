import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { ClaudeAgentRuntime, NATIVE_CLAUDE_STATE } from "../runtime/claude/claude-agent-runtime.js";
import { resolveClaudeExecutable, claudeRuntimeEnvironment } from "../runtime/claude/claude-runtime-environment.js";
import { BROWSER_AUTOMATION_OPERATIONS } from "@forge/protocol";
import { buildBrowserAutomationTools } from "../browser-automation/browser-automation-tools.js";
import type { SwarmToolHost } from "../swarm-tool-host.js";
import { createNativeSecureBashTool } from "../secure-sessions/runtime/native-secure-bash-tool.js";
import type { SecureRuntimeBinding } from "../secure-sessions/runtime/secure-runtime-binding.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";
import type { RuntimeSessionEvent } from "../runtime-contracts.js";
import { extractCleanManagerAssistantFinalMessage } from "../runtime/manager-assistant-final-message.js";
import { NATIVE_USAGE_ENTRY_TYPE, type NativeUsageRecord } from "../../utils/native-usage-records.js";

// Real SDK + bundled Claude process and tools; only the remote model is replaced
// by a deterministic local HTTP fixture. No account credentials or live data.
describe("Claude native process acceptance", () => {
  it("runs native and Forge tools, filters outputs, handles queued input, compacts, resumes, forks, and stops", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-claude-acceptance-"));
    const cwd = join(root, "workspace"); const config = join(root, "claude");
    await mkdir(cwd); await mkdir(config);
    await writeFile(join(cwd, "input.txt"), "fixture file contents");
    const canary = `SYNTHETIC_${randomUUID()}`;
    const requests: Array<{ body: any; raw: string }> = [];
    const events: RuntimeSessionEvent[] = [];
    const exits: boolean[] = [];
    const errors: unknown[] = [];
    let runtime: ClaudeAgentRuntime | undefined;
    let redactionSawCanary = false;
    let forgeCalls = 0;
    let secureCalls = 0;
    const unionCalls: unknown[] = [];
    const requestUserChoice = vi.fn(async () => [{ questionId: "0", selectedOptionIds: ["1"] }]);
    const server = createServer(async (request, response) => {
      let raw = ""; for await (const chunk of request) raw += chunk;
      if (request.url?.includes("count_tokens")) { response.setHeader("Content-Type", "application/json"); response.end('{"input_tokens":100}'); return; }
      if (!request.url?.startsWith("/v1/messages")) { response.end("{}"); return; }
      const body = JSON.parse(raw); requests.push({ body, raw });
      const texts = body.messages.flatMap((m: any) => m.role === "user" ? typeof m.content === "string" ? [m.content] : m.content.filter((b: any) => b.type === "text").map((b: any) => b.text) : []);
      const marker = texts.flatMap((t: string) => t.match(/CASE_[A-Z]+/g) ?? []).at(-1) ?? "CASE_INIT";
      const id = `toolu_${marker}`;
      const hasResult = body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result" && b.tool_use_id === id));
      const calls: Record<string, { name: string; input: unknown }> = {
        CASE_READ: { name: "Read", input: { file_path: join(cwd, "input.txt") } },
        CASE_FORGE: { name: "mcp__forge__fixture_tool", input: { value: "tool value" } },
        CASE_CLICK: { name: "mcp__forge__browser_click", input: { selector: "#save" } },
        CASE_UNION: { name: "mcp__forge__fixture_union_tool", input: { mode: "b", count: 2 } },
        CASE_SECURE: { name: "mcp__forge__secure_bash", input: { command: "opaque credential command", secretAliases: ["fixture-password"] } },
        CASE_HOOK: { name: "Bash", input: { command: "printf \"$FIXTURE_CANARY\"" } },
        CASE_QUESTION: { name: "AskUserQuestion", input: { questions: [{ question: "Pick the fixture option", header: "Fixture", options: [{ label: "First", description: "First option" }, { label: "Second", description: "Second option" }], multiSelect: false }] } },
        CASE_QUEUE: { name: "Bash", input: { command: "printf started > queue-started; sleep 0.7" } },
        CASE_STOP: { name: "Bash", input: { command: "echo $$ > stop-pid; printf started > stop-started; sleep 30; printf survived > stop-survived" } },
      };
      const blocks = !hasResult && calls[marker] ? [{ type: "text", text: `Working on ${marker}.` }, { type: "tool_use", id, ...calls[marker] }]
        : [{ type: "text", text: `DONE_${marker}. Earlier context: CASE_READ completed.` }];
      respond(response, blocks, requests.length);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const guard = <T>(value: T): T => {
      const raw = JSON.stringify(value); if (!raw) return value;
      redactionSawCanary ||= raw.includes(canary);
      return JSON.parse(raw.replaceAll(canary, "[REDACTED]"));
    };
    const invokeBrowserAutomation = vi.fn(async (_agentId: string, operation: string) => ({ ok: true, operation, result: {} }));
    const binding: SecureRuntimeBinding = { guardValue: guard, createOutputGuard: vi.fn(), executeBash: async request => {
      expect(request.secretAliases).toEqual(["fixture-password"]); secureCalls++;
      request.onData(Buffer.from("credentialed result [REDACTED]")); return { exitCode: 0 };
    } };
    const descriptor = (id: string): AgentDescriptor => ({ agentId: id, role: "manager", managerId: id, profileId: "fixture", cwd,
      status: "idle", sessionFile: join(root, `${id}.jsonl`), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      model: { provider: "claude-native", modelId: "claude-sonnet-5", thinkingLevel: "high" } });
    const create = async (id = "owner") => ClaudeAgentRuntime.create({ descriptor: descriptor(id), systemPrompt: "FORGE_APPEND_FIXTURE. Use Forge coordination tools.",
      env: { ...await claudeRuntimeEnvironment({} as SwarmConfig), PATH: process.env.PATH, HOME: root, USERPROFILE: root, TMPDIR: tmpdir(), CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: "sk-ant-fake-fixture",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", FIXTURE_CANARY: canary },
      executable: await resolveClaudeExecutable({}), projectTrusted: false, host: { requestUserChoice }, creationOptions: { secureRuntimeBinding: binding },
      callbacks: { onStatusChange: vi.fn(), onAgentEnd: vi.fn(), onRuntimeError: (_id, error) => { errors.push(error); }, onSessionEvent: (_id, event) => { events.push(event); } },
      tools: [...buildBrowserAutomationTools({ invokeBrowserAutomation } as unknown as SwarmToolHost, descriptor(id)),
        createNativeSecureBashTool(descriptor(id), () => binding), { name: "fixture_tool", label: "Fixture", description: "Fixture Forge tool",
        parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }), execute: async (id, args: any, signal) => {
          expect(id).toBe("toolu_CASE_FORGE"); expect(signal?.aborted).toBe(false); forgeCalls++;
          return { content: [{ type: "text", text: `${args.value} ${canary}` }], details: {} };
        } }, { name: "fixture_union_tool", label: "Fixture union", description: "Fixture Forge tool with a root union schema",
        parameters: Type.Union([Type.Object({ mode: Type.Literal("a"), text: Type.String() }, { additionalProperties: false }),
          Type.Object({ mode: Type.Literal("b"), count: Type.Integer() }, { additionalProperties: false })]),
        execute: async (_id, args: any) => { unionCalls.push(args); return { content: [{ type: "text", text: "union ok" }], details: {} }; } }],
      createQuery: args => query({ ...args, options: { ...args.options, spawnClaudeCodeProcess: options => {
        const child = args.options!.spawnClaudeCodeProcess!(options); const index = exits.push(false) - 1;
        child.once("exit", () => { exits[index] = true; }); return child;
      } } }),
    });
    const send = async (text: string) => {
      const before = events.filter(e => e.type === "turn_end").length;
      await runtime!.sendMessage(text);
      await waitFor(() => events.filter(e => e.type === "turn_end").length > before && runtime!.getStatus() === "idle", text);
      expect(errors).toEqual([]);
    };
    const latestUsage = () => runtime!.getCustomEntries(NATIVE_USAGE_ENTRY_TYPE).at(-1) as NativeUsageRecord;
    try {
      runtime = await create();
      await send("CASE_READ Read input.txt.");
      expect(latestUsage().usage).toMatchObject({ input: 200, output: 60, total: 260 });
      expect(requests.some(r => r.raw.includes("fixture file contents"))).toBe(true);
      const tools = requests[0]!.body.tools.map((t: any) => t.name);
      expect(tools).toContain("Read"); expect(tools).toContain("mcp__forge__fixture_tool");
      expect(tools).not.toContain("Agent"); expect(tools).not.toContain("CronCreate");
      expect(JSON.stringify(requests[0]!.body.system)).toContain("FORGE_APPEND_FIXTURE");
      expect(JSON.stringify(requests[0]!.body.system).length).toBeGreaterThan(2000);
      // Claude silently drops MCP tools whose root schema is not a plain object.
      const browserTools = requests[0]!.body.tools.filter((t: any) => t.name.startsWith("mcp__forge__browser_"));
      expect(browserTools).toHaveLength(BROWSER_AUTOMATION_OPERATIONS.length);
      for (const tool of browserTools) expect(tool.input_schema, tool.name).toMatchObject({ type: "object", properties: expect.any(Object) });
      await send("CASE_CLICK Click the save button.");
      expect(invokeBrowserAutomation).toHaveBeenCalledWith("owner", "click", expect.objectContaining({ selector: "#save" }));
      const union = requests[0]!.body.tools.find((t: any) => t.name === "mcp__forge__fixture_union_tool");
      expect(union?.input_schema).toMatchObject({ type: "object", properties: { mode: { anyOf: [{ const: "a" }, { const: "b" }] }, text: {}, count: {} }, required: ["mode"] });
      await send("CASE_UNION Use the union tool.");
      expect(unionCalls).toEqual([{ mode: "b", count: 2 }]);
      await send("CASE_FORGE Use the fixture tool.");
      await send("CASE_SECURE Use Secure Bash.");
      await send("CASE_HOOK Exercise native output redaction.");
      expect(forgeCalls).toBe(1); expect(secureCalls).toBe(1); expect(redactionSawCanary).toBe(true);
      expect(requests.some(r => r.raw.includes(canary))).toBe(false);
      expect(JSON.stringify(events)).not.toContain(canary);
      await send("CASE_QUESTION Ask the fixture question.");
      expect(requestUserChoice).toHaveBeenCalledOnce();
      expect(requests.some(r => r.raw.includes("Second"))).toBe(true);

      await runtime.sendMessage("CASE_QUEUE Start queued input test.");
      await waitFor(() => existsSync(join(cwd, "queue-started")), "queue tool starts");
      await Promise.all([runtime.sendMessage("CASE_ONE worker result one"), runtime.sendMessage("CASE_TWO worker result two"), runtime.sendMessage("CASE_THREE user follow-up", "followUp")]);
      await waitFor(() => runtime!.getStatus() === "idle" && runtime!.getPendingCount() === 0, "all queued input consumed");
      for (const marker of ["CASE_ONE", "CASE_TWO", "CASE_THREE"]) expect(events.filter(e => e.type === "message_start" && e.message.role === "user" && String(e.message.content).includes(marker))).toHaveLength(1);
      expect(requests.at(-1)!.raw).toContain("worker result one"); expect(requests.at(-1)!.raw).toContain("worker result two");

      await runtime.compact("Preserve CASE_READ and the fixture facts.");
      expect(events.some(e => e.type === "auto_compaction_end")).toBe(true);
      const beforeResume = latestUsage();
      expect(beforeResume.usage.total).toBeGreaterThan(260);
      const state = runtime.getCustomEntries(NATIVE_CLAUDE_STATE).at(-1);
      await runtime.stopInFlight({ shutdownTimeoutMs: 10_000 });
      expect(exits.every(Boolean)).toBe(true);
      runtime = await create();
      expect(runtime.getCustomEntries(NATIVE_CLAUDE_STATE).at(-1)).toMatchObject(state as object);
      await send("CASE_RESUME Continue earlier work.");
      expect(latestUsage().nativeSessionId).toBe(beforeResume.nativeSessionId);
      expect(latestUsage().usage.total).toBe(beforeResume.usage.total + 130);
      expect(requests.at(-1)!.raw).toContain("CASE_READ");
      // Forked Forge files carry parent state. They must never resume the parent's writer.
      await runtime.stopInFlight({ shutdownTimeoutMs: 10_000 });
      await cp(descriptor("owner").sessionFile, descriptor("fork").sessionFile);
      runtime = await create("fork");
      expect(runtime.getCustomEntries(NATIVE_CLAUDE_STATE).at(-1)).not.toMatchObject(state as object);
      await send("CASE_FORK New fork work.");
      expect(latestUsage().nativeSessionId).not.toBe(beforeResume.nativeSessionId);
      expect(latestUsage().usage.total).toBe(130);
      await runtime.sendMessage("CASE_STOP Start a long shell command.");
      await waitFor(() => existsSync(join(cwd, "stop-started")), "stop tool starts");
      await runtime.sendMessage("CASE_CANCELLED queued work must not run", "followUp");
      await runtime.stopInFlight({ shutdownTimeoutMs: 10_000 });
      expect(exits.every(Boolean)).toBe(true);
      expect(requests.at(-1)!.raw).not.toContain("CASE_CANCELLED");
      expect(existsSync(join(cwd, "stop-survived"))).toBe(false);
      if (process.platform !== "win32") {
        const shellPid = Number(await readFile(join(cwd, "stop-pid"), "utf8"));
        expect(() => process.kill(shellPid, 0)).toThrow();
      }
      expect(events.map(extractCleanManagerAssistantFinalMessage).filter(Boolean).some(m => m!.text.startsWith("DONE_CASE_READ"))).toBe(true);
      for (const file of await jsonlFiles(root)) expect(await readFile(file, "utf8")).not.toContain(canary);
    } finally {
      await runtime?.stopInFlight({ shutdownTimeoutMs: 10_000 });
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

async function waitFor(predicate: () => boolean, label: string) {
  const end = Date.now() + 15_000;
  while (!predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function jsonlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? jsonlFiles(join(directory, entry.name)) : Promise.resolve(entry.name.endsWith(".jsonl") ? [join(directory, entry.name)] : [])))).flat();
}
function respond(response: ServerResponse, blocks: any[], index: number) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit("message_start", { message: { id: `msg_${index}`, type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  blocks.forEach((block, index) => {
    emit("content_block_start", { index, content_block: block.type === "text" ? { type: "text", text: "" } : { type: "tool_use", id: block.id, name: block.name, input: {} } });
    emit("content_block_delta", { index, delta: block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    emit("content_block_stop", { index });
  });
  emit("message_delta", { delta: { stop_reason: blocks.some(b => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 30 } });
  emit("message_stop", {}); response.end();
}
