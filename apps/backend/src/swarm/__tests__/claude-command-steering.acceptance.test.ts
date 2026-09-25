import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { ClaudeAgentRuntime } from "../runtime/claude/claude-agent-runtime.js";
import { resolveClaudeExecutable } from "../runtime/claude/claude-runtime-environment.js";
import type { AgentDescriptor } from "../types.js";
import type { RuntimeSessionEvent } from "../runtime-contracts.js";

// Real persistent SDK/CLI, shell, and process cleanup. Only the remote model is a
// deterministic local HTTP fixture. No account credentials or user workloads.
describe("Claude command steering acceptance", () => {
  it.each(["silent", "output"])("answers steering while a %s command continues and receives its completion", async kind => {
    const root = await mkdtemp(join(tmpdir(), "forge-steering-"));
    const cwd = join(root, "workspace");
    const config = join(root, "claude");
    await mkdir(cwd); await mkdir(config);
    await writeFile(join(cwd, "fixture.cjs"), `const fs = require('node:fs'); fs.appendFileSync('executions', 'started\\n'); fs.writeFileSync('shell-pid', String(process.pid)); const timer = setInterval(() => { ${kind === "output" ? "console.log('working');" : ""} if (fs.existsSync('release')) { clearInterval(timer); fs.writeFileSync('completed', 'done'); console.log('command-completed'); } }, 100);`);
    const frames: SDKMessage[] = [];
    const events: RuntimeSessionEvent[] = [];
    const errors: unknown[] = [];
    const requests: any[] = [];
    let native!: Query;
    let runtime: ClaudeAgentRuntime | undefined;
    const server = createServer(async (request, response) => {
      let raw = ""; for await (const chunk of request) raw += chunk;
      if (request.url?.includes("count_tokens")) { response.end('{"input_tokens":100}'); return; }
      if (!request.url?.startsWith("/v1/messages")) { response.end("{}"); return; }
      const body = JSON.parse(raw); requests.push(body);
      const history = JSON.stringify(body.messages);
      const started = history.includes("toolu_long_command");
      const steered = history.includes("STEER_NOW");
      respond(response, !started ? [{ type: "tool_use", id: "toolu_long_command", name: "Bash", input: {
        command: "node fixture.cjs",
        timeout: 3600000, description: "Wait for an isolated fixture to release the command",
      } }] : [{ type: "text", text: steered ? "STEERING_RECEIVED" : "WAITING_FOR_COMPLETION" }], requests.length);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const descriptor: AgentDescriptor = { agentId: "steering", role: "manager", managerId: "steering", profileId: "fixture", cwd,
      status: "idle", sessionFile: join(root, "session.jsonl"), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      model: { provider: "claude-native", modelId: "claude-sonnet-5", thinkingLevel: "high" } };
    try {
      runtime = await ClaudeAgentRuntime.create({ descriptor, systemPrompt: "Use the native Bash tool. Follow user steering.",
        env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, TMPDIR: tmpdir(), CLAUDE_CONFIG_DIR: config,
          ANTHROPIC_API_KEY: "sk-ant-fake-fixture", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        executable: await resolveClaudeExecutable({}), projectTrusted: false, tools: [], host: { requestUserChoice: vi.fn() },
        callbacks: { onStatusChange: vi.fn(), onAgentEnd: vi.fn(), onRuntimeError: (_id, error) => { errors.push(error); },
          onSessionEvent: (_id, event) => { events.push(event); } },
        createQuery: args => {
          native = query(args);
          const iterate = native[Symbol.asyncIterator].bind(native);
          native[Symbol.asyncIterator] = async function* () { for await (const frame of { [Symbol.asyncIterator]: iterate }) { frames.push(frame); yield frame; } };
          return native;
        },
      });
      await runtime.sendMessage("START_LONG_COMMAND");
      await waitFor(() => existsSync(join(cwd, "executions")), "shell started");
      if (kind === "output") await waitFor(() => frames.some(f => f.type === "system" && f.subtype === "task_started"), "foreground registration");
      const startedSteering = Date.now();
      const receipt = await runtime.sendMessage("STEER_NOW Tell me the status while leaving the command running.");
      expect(receipt.acceptedMode).toBe("steer");
      await waitFor(() => events.some(e => e.type === "message_end" && JSON.stringify(e.message).includes("STEERING_RECEIVED")), "steering response");
      expect(existsSync(join(cwd, "completed"))).toBe(false);
      expect((await readFile(join(cwd, "executions"), "utf8")).trim()).toBe("started");
      expect(runtime.getPendingCount()).toBe(0);
      expect(events.some(e => e.type === "tool_execution_update" && JSON.stringify(e.partialResult).includes("running_in_background"))).toBe(true);
      expect(events.some(e => e.type === "tool_execution_end" && e.toolCallId === "toolu_long_command")).toBe(false);
      await writeFile(join(cwd, "release"), "release");
      await waitFor(() => existsSync(join(cwd, "completed")), "original command completion");
      await waitFor(() => frames.some(f => f.type === "system" && f.subtype === "task_notification" && f.status === "completed"), "background completion notification");
      expect(existsSync(join(cwd, "completed"))).toBe(true);
      await waitFor(() => events.some(e => e.type === "tool_execution_end" && e.toolCallId === "toolu_long_command"), "Forge background settlement");
      expect(errors).toEqual([]);
      // Emit only structural evidence, never model requests or environment data.
      console.log(JSON.stringify({ steeringBeforeCompletion: true, executions: 1, kind, steeringMs: Date.now() - startedSteering,
        taskFrames: frames.filter(f => f.type === "system" && f.subtype.startsWith("task")).map(f => {
          const task = f as any; return { subtype: task.subtype, taskId: task.task_id, toolUseId: task.tool_use_id, status: task.status, isBackgrounded: task.is_backgrounded, patch: task.patch };
        }) }));
    } finally {
      await runtime?.stopInFlight({ shutdownTimeoutMs: 10_000 });
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function waitFor(predicate: () => boolean, label: string) {
  const end = Date.now() + 15_000;
  while (!predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 20)); }
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
