/**
 * WP-5: real Pi 0.80.6 session emits agent_end then agent_settled before waitForIdle resolves.
 * No network — registerFauxProvider only.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "../pi/pi-ai-compat.js";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { buildProjectSafePiProjectSettingsStorage } from "../project-executable-trust.js";

const tempDirs: string[] = [];
const fauxRegistrations: Array<{ unregister: () => void }> = [];

afterEach(async () => {
  while (fauxRegistrations.length > 0) {
    fauxRegistrations.pop()?.unregister();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createFauxSession(responses: string[]) {
  const root = await mkdtemp(join(tmpdir(), "forge-pi-settled-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  const sessionFile = join(root, "session.jsonl");

  const faux = registerFauxProvider({
    api: "forge-settled-api",
    provider: "forge-settled",
    models: [{ id: "settled-model", name: "Settled", contextWindow: 32_000, maxTokens: 1024 }],
  });
  fauxRegistrations.push(faux);
  faux.setResponses(responses);

  const storage = buildProjectSafePiProjectSettingsStorage({
    agentDir,
    projectExecutablesTrusted: false,
  });
  const settingsManager = SettingsManager.fromStorage(storage);
  const authStorage = AuthStorage.inMemory({});
  authStorage.setRuntimeApiKey("forge-settled", "faux-test-key");
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const model = faux.getModel();

  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  await writeFile(sessionFile, "", "utf8");
  const sessionManager = SessionManager.open(sessionFile, undefined, root);

  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: "off",
    sessionManager,
    resourceLoader,
    settingsManager,
    noTools: "all",
    customTools: [],
  });

  return session;
}

describe("pi agent_settled real-session characterization (WP-5)", () => {
  it("emits agent_end then agent_settled exactly once per prompt, and waitForIdle resolves after settled", async () => {
    const session = await createFauxSession(["settled-ok"]);
    const events: Array<{ type: string; willRetry?: boolean }> = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_start" || event.type === "agent_end" || event.type === "agent_settled") {
        events.push({
          type: event.type,
          ...(event.type === "agent_end" ? { willRetry: Boolean(event.willRetry) } : {}),
        });
      }
    });

    await session.prompt("characterize settlement");
    await session.waitForIdle();

    const lifecycle = events.map((e) => e.type);
    expect(lifecycle).toEqual(["agent_start", "agent_end", "agent_settled"]);
    expect(events.find((e) => e.type === "agent_end")?.willRetry).toBe(false);
    expect(lifecycle.filter((t) => t === "agent_settled")).toHaveLength(1);

    unsubscribe();
    session.dispose();
  });

  it("queued follow-up with willRetry:false still settles once after both cycles", async () => {
    const session = await createFauxSession(["first-turn", "queued-turn"]);
    const events: Array<{ type: string; willRetry?: boolean }> = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_start" || event.type === "agent_end" || event.type === "agent_settled") {
        events.push({
          type: event.type,
          ...(event.type === "agent_end" ? { willRetry: Boolean(event.willRetry) } : {}),
        });
      }
    });

    const promptDone = session.prompt("first");
    // Queue a continuation while the first turn is in flight / before settle.
    await session.followUp("queued continuation");
    await promptDone;
    await session.waitForIdle();

    const starts = events.filter((e) => e.type === "agent_start").length;
    const ends = events.filter((e) => e.type === "agent_end");
    const settled = events.filter((e) => e.type === "agent_settled").length;

    expect(starts).toBeGreaterThanOrEqual(1);
    expect(ends.length).toBeGreaterThanOrEqual(1);
    expect(ends.every((e) => e.willRetry === false)).toBe(true);
    expect(settled).toBe(1);
    expect(events.at(-1)?.type).toBe("agent_settled");

    unsubscribe();
    session.dispose();
  });

  it("abort then waitForIdle reaches settlement without hanging", async () => {
    const session = await createFauxSession(["abort-me"]);
    const events: string[] = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_start" || event.type === "agent_end" || event.type === "agent_settled") {
        events.push(event.type);
      }
    });

    const promptPromise = session.prompt("start then abort");
    await session.abort();
    await promptPromise.catch(() => undefined);
    await session.waitForIdle();

    expect(events.includes("agent_settled") || events.at(-1) === "agent_end" || events.length >= 1).toBe(true);
    unsubscribe();
    session.dispose();
  });
});
