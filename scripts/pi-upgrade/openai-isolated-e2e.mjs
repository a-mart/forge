#!/usr/bin/env node
/**
 * Isolated OpenAI Codex E2E smoke against a running worktree backend.
 * Never prints tokens — only redacted status fields (+ short marker preview).
 *
 * Run from repo root after start-isolated-instance.sh (or equivalent):
 *   set -a && source .env && set +a
 *   unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
 *   node --import ./apps/backend/node_modules/tsx/dist/loader.mjs \
 *     ./scripts/pi-upgrade/openai-isolated-e2e.mjs
 *
 * Prefer:
 *   cd apps/backend && node ../../scripts/pi-upgrade/openai-isolated-e2e.mjs
 * with NODE_PATH including backend node_modules, or run via:
 *   pnpm --filter @forge/backend exec node ../../scripts/pi-upgrade/openai-isolated-e2e.mjs
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertIsolationEnv } from "./assert-isolation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const requireFromBackend = createRequire(join(repoRoot, "apps/backend/package.json"));
const WebSocket = requireFromBackend("ws");

const isolation = assertIsolationEnv(process.env);
const port = isolation.backendPort;
const agentId = process.env.FORGE_E2E_AGENT_ID || "pi-upgrade-openai-e2e";
const timeoutMs = 120_000;
const marker = `PI_UPGRADE_E2E_${Date.now()}`;
const events = [];

const client = new WebSocket(`ws://127.0.0.1:${port}`);
await new Promise((resolve, reject) => {
  client.once("open", resolve);
  client.once("error", reject);
});
client.on("message", (raw) => {
  try {
    events.push(JSON.parse(String(raw)));
  } catch {
    // ignore
  }
});

function waitFrom(start, pred, label, ms = timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      for (let i = start; i < events.length; i++) {
        try {
          if (pred(events[i])) {
            clearInterval(timer);
            resolve(events[i]);
            return;
          }
        } catch (err) {
          clearInterval(timer);
          reject(err);
          return;
        }
      }
      if (Date.now() - t0 > ms) {
        clearInterval(timer);
        reject(new Error(`timeout ${label}`));
      }
    }, 100);
  });
}

client.send(JSON.stringify({ type: "subscribe", agentId }));
await waitFrom(0, (e) => e.type === "conversation_history" || e.type === "ready", "subscribe");

const before = events.length;
client.send(
  JSON.stringify({
    type: "user_message",
    agentId,
    text: `Say only: ${marker}`,
  }),
);

const result = await waitFrom(before, (e) => {
  if (e.type !== "conversation_message" || e.agentId !== agentId) return false;
  if (e.role === "user") return false;
  const text = String(e.text || "");
  if (/reply failed|fetch failed/i.test(text)) {
    throw new Error(`provider_failure:${text.slice(0, 160)}`);
  }
  if (
    e.role === "assistant" ||
    e.source === "assistant" ||
    e.source === "assistant_output" ||
    e.source === "model" ||
    e.source === "agent"
  ) {
    return text.length > 0;
  }
  return text.includes("PI_UPGRADE_E2E_");
}, "assistant");

const text = String(result.text || "");
const ok = text.includes(marker);
console.log(
  JSON.stringify(
    {
      ok,
      phase: "openai_prompt",
      agentId,
      dataDir: isolation.dataDir,
      port,
      role: result.role,
      source: result.source,
      assistantChars: text.length,
      matchedMarker: ok,
      preview: text.replace(/\s+/g, " ").slice(0, 100),
    },
    null,
    2,
  ),
);
client.close();
process.exit(ok ? 0 : 2);
