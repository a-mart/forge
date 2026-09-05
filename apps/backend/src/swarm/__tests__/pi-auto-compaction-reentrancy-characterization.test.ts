/**
 * WP-4 behavioral characterization for the pi-coding-agent auto-compaction
 * reentrancy patch on @earendil-works/pi-coding-agent@0.80.6.
 */
import { readFileSync } from "node:fs";
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
import {
  expectInstalledPiCodingAgentPatchIdentity,
  findInstalledPiCodingAgentFile,
} from "./pi-coding-agent-patch-identity.js";

const tempDirs: string[] = [];
const fauxRegistrations: Array<{ unregister: () => void }> = [];

afterEach(async () => {
  while (fauxRegistrations.length > 0) {
    fauxRegistrations.pop()?.unregister();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createCompactionSession() {
  const root = await mkdtemp(join(tmpdir(), "forge-pi-compact-race-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");

  const faux = registerFauxProvider({
    api: "forge-compact-api",
    provider: "forge-compact",
    models: [{ id: "compact-model", contextWindow: 128_000, maxTokens: 2048 }],
  });
  fauxRegistrations.push(faux);
  faux.setResponses(["unused"]);

  const storage = buildProjectSafePiProjectSettingsStorage({
    agentDir,
    projectExecutablesTrusted: false,
  });
  const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: false });
  settingsManager.applyOverrides({
    compaction: { enabled: true },
  } as never);

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

  const sessionFile = join(root, "session.jsonl");
  await writeFile(sessionFile, "", "utf8");
  const authStorage = AuthStorage.inMemory({});
  authStorage.setRuntimeApiKey("forge-compact", "faux-test-key");
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    model: faux.getModel(),
    sessionManager: SessionManager.open(sessionFile, undefined, root),
    resourceLoader,
    settingsManager,
    noTools: "all",
  });

  return session;
}

describe("pi auto-compaction reentrancy characterization (0.80.6 patch)", () => {
  it("keeps the installed agent-session reentrancy guard text and patch identity", () => {
    const agentSessionPath = findInstalledPiCodingAgentFile(import.meta.url, "dist/core/agent-session.js");
    const source = readFileSync(agentSessionPath, "utf8");
    expect(source).toContain("Reentrancy guard: if compaction is already in progress, bail out.");
    expect(source).toContain("localAbortController = new AbortController();");
    expect(source).toContain("if (this._autoCompactionAbortController === localAbortController)");
    expectInstalledPiCodingAgentPatchIdentity(import.meta.url, source);
  });

  it("second concurrent _runAutoCompaction is a no-op while the first owns the controller", async () => {
    const session = await createCompactionSession();
    const agentSession = session as unknown as {
      _autoCompactionAbortController?: AbortController;
      _runAutoCompaction: (reason: string, willRetry: boolean) => Promise<boolean>;
      subscribe: (listener: (event: { type: string }) => void) => () => void;
    };

    const starts: string[] = [];
    const ends: string[] = [];
    const unsubscribe = agentSession.subscribe((event) => {
      if (event.type === "compaction_start") starts.push(event.type);
      if (event.type === "compaction_end") ends.push(event.type);
    });

    // Hold ownership as if the first compaction is mid-flight (post compaction_start).
    const owner = new AbortController();
    agentSession._autoCompactionAbortController = owner;

    const second = await agentSession._runAutoCompaction("threshold", false);
    expect(second).toBe(false);
    expect(agentSession._autoCompactionAbortController).toBe(owner);
    expect(starts).toEqual([]);
    expect(ends).toEqual([]);

    // Overlapping call while first still owns: still a no-op.
    const third = await Promise.all([
      agentSession._runAutoCompaction("overflow", true),
      agentSession._runAutoCompaction("threshold", false),
    ]);
    expect(third).toEqual([false, false]);
    expect(agentSession._autoCompactionAbortController).toBe(owner);
    expect(starts).toEqual([]);

    // Owner-checked cleanup: only the owning controller identity clears the field.
    agentSession._autoCompactionAbortController = undefined;
    expect(agentSession._autoCompactionAbortController).toBeUndefined();

    unsubscribe();
    session.dispose();
  });

  it("public-flow overlap: agent_end compaction path no-ops while a pre-prompt compaction owns the controller", async () => {
    const session = await createCompactionSession();
    const agentSession = session as unknown as {
      _autoCompactionAbortController?: AbortController;
      _checkCompaction: (assistantMessage: unknown, skipAbortedCheck?: boolean) => Promise<boolean>;
      _runAutoCompaction: (reason: string, willRetry: boolean) => Promise<boolean>;
      subscribe: (listener: (event: { type: string }) => void) => () => void;
    };

    const starts: string[] = [];
    const unsubscribe = agentSession.subscribe((event) => {
      if (event.type === "compaction_start") starts.push(event.type);
    });

    // Pre-prompt path already owns the controller (public agent_end/pre-prompt overlap).
    const owner = new AbortController();
    agentSession._autoCompactionAbortController = owner;

    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "enough tokens to consider compaction" }],
      stopReason: "length",
      usage: { input: 100_000, output: 1, totalTokens: 100_001 },
    };

    expect(await agentSession._checkCompaction(assistant, false)).toBe(false);
    expect(await agentSession._runAutoCompaction("overflow", true)).toBe(false);
    expect(agentSession._autoCompactionAbortController).toBe(owner);
    expect(starts).toEqual([]);

    agentSession._autoCompactionAbortController = undefined;
    unsubscribe();
    session.dispose();
  });
});
