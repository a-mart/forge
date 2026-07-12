/**
 * Replay a manager turn against the real OpenAI Codex Responses API using the
 * exact same pi-ai provider code path as production, reconstructing the
 * model-visible context from the session file (compaction-aware).
 *
 * Purpose: reproduce the "empty turn" failure offline and bisect its trigger.
 * See docs/MANAGER_SILENCE_INVESTIGATION.md.
 *
 * Usage (from apps/backend):
 *   npx tsx scripts/replay-empty-turn.ts --variant=baseline
 *   Variants: baseline | strip-empty | plain-prefix | no-tools | half-tail | minimal
 *   Env: SESSION_DIR (default mammo-sch), LEAF_ID (default 5b67c09d)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
// Raw provider export is `stream`; keep the legacy local alias for this script.
import { stream as streamOpenAICodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { buildSwarmTools } from "../src/swarm/swarm-tools.js";
import type { AgentDescriptor } from "../src/swarm/types.js";

const SESSION_DIR =
  process.env.SESSION_DIR ??
  join(homedir(), ".forge/profiles/rapa-teams-gateway/sessions/mammo-sch");
const LEAF_ID = process.env.LEAF_ID ?? "5b67c09d";
const variant = process.argv.find((a) => a.startsWith("--variant="))?.split("=")[1] ?? "baseline";

// --- context reconstruction ---------------------------------------------------
const entries = readFileSync(join(SESSION_DIR, "session.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  })
  .filter((entry): entry is Record<string, any> => !!entry);

const ctx = buildSessionContext(entries as any, LEAF_ID);
let messages: any[] = [...ctx.messages];

const meta = JSON.parse(readFileSync(join(SESSION_DIR, "meta.json"), "utf8"));
const systemPrompt: string = meta.resolvedSystemPrompt;

// --- tools ----------------------------------------------------------------------
const stubHost: any = new Proxy(
  {},
  { get: () => async () => ({ content: [{ type: "text", text: "" }] }) }
);
const descriptor = {
  agentId: "mammo-sch",
  displayName: "Mammo Sch",
  role: "manager",
  managerId: "mammo-sch",
  status: "idle",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  cwd: meta.cwd ?? process.cwd(),
  model: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "high" },
  sessionFile: join(SESSION_DIR, "session.jsonl"),
} as AgentDescriptor;

let tools: any[] = buildSwarmTools(stubHost, descriptor).map((tool: any) => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
}));

// --- auth + model -----------------------------------------------------------------
const auth = JSON.parse(
  readFileSync(join(homedir(), ".forge/shared/config/auth/auth.json"), "utf8")
);
const apiKey: string = auth["openai-codex"]?.access;
if (!apiKey) throw new Error("no openai-codex access token in auth.json");
if (auth["openai-codex"].expires && auth["openai-codex"].expires < Date.now()) {
  throw new Error("openai-codex token expired — open Forge settings to refresh");
}

const model: any = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272000,
  maxTokens: 128000,
};

// --- variants -----------------------------------------------------------------------
const isWhitespaceText = (b: any) => b?.type === "text" && (!b.text || b.text.trim().length === 0);

if (variant === "strip-empty") {
  messages = messages
    .map((m) => {
      if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
      return { ...m, content: m.content.filter((b: any) => !isWhitespaceText(b)) };
    })
    .filter((m) => !(m.role === "assistant" && Array.isArray(m.content) && m.content.length === 0));
} else if (variant === "plain-prefix") {
  const rewrite = (t: string) => t.replace(/^(SYSTEM|WORKER REPORT):\s*/, "");
  messages = messages.map((m) => {
    if (m.role !== "user") return m;
    if (typeof m.content === "string") return { ...m, content: rewrite(m.content) };
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map((b: any) => (b?.type === "text" ? { ...b, text: rewrite(b.text ?? "") } : b)),
      };
    }
    return m;
  });
} else if (variant === "no-tools") {
  tools = [];
} else if (variant === "half-tail") {
  let start = Math.floor(messages.length / 2);
  while (start < messages.length && messages[start].role !== "user") start += 1;
  messages = messages.slice(start);
} else if (variant === "minimal") {
  messages = [messages[messages.length - 1]];
}

// --- stats + run -----------------------------------------------------------------------
const emptyAssistant = messages.filter(
  (m) =>
    m.role === "assistant" &&
    Array.isArray(m.content) &&
    m.content.every((b: any) => b.type === "thinking" || isWhitespaceText(b)) &&
    !m.content.some((b: any) => b.type === "toolCall")
).length;
console.log(
  `[replay] variant=${variant} messages=${messages.length} emptyAssistantMsgs=${emptyAssistant} tools=${tools.length} systemPromptChars=${systemPrompt.length}`
);
const lastMsg = messages[messages.length - 1];
const lastText = Array.isArray(lastMsg?.content)
  ? (lastMsg.content.find((b: any) => b.type === "text")?.text ?? "")
  : String(lastMsg?.content ?? "");
console.log(`[replay] last input (${lastMsg?.role}): ${lastText.slice(0, 110).replace(/\n/g, " ")}…`);

const stream = streamOpenAICodexResponses(
  model,
  { systemPrompt, messages, tools },
  { apiKey, reasoning: "high", transport: "sse" } as any
);

let final: any;
for await (const event of stream as any) {
  if (event.type === "done" || event.type === "error") final = event.message ?? event.error;
}
if (!final) throw new Error("stream ended without done/error event");

console.log(`\n[result] stopReason=${final.stopReason} outputTokens=${final.usage?.output}`);
for (const block of final.content ?? []) {
  if (block.type === "text") {
    let phase: string | undefined;
    try {
      phase = block.textSignature ? JSON.parse(block.textSignature)?.phase : undefined;
    } catch {
      phase = undefined;
    }
    console.log(
      `  text(phase=${phase ?? "?"}) len=${(block.text ?? "").trim().length}: ${(block.text ?? "").slice(0, 200).replace(/\n/g, " ")}`
    );
  } else if (block.type === "toolCall") {
    console.log(`  toolCall: ${block.name} args=${JSON.stringify(block.arguments).slice(0, 200)}`);
  } else if (block.type === "thinking") {
    console.log(`  thinking len=${(block.thinking ?? "").length}`);
  } else {
    console.log(`  [${block.type}]`);
  }
}
const silent =
  !(final.content ?? []).some((b: any) => b.type === "toolCall") &&
  (final.content ?? []).every((b: any) => b.type !== "text" || !(b.text ?? "").trim());
console.log(`\n[verdict] ${silent ? "EMPTY TURN REPRODUCED" : "model responded"}`);
