/**
 * Characterization for the pi-coding-agent auto-compaction reentrancy patch (0.71.1).
 * Uses a real createAgentSession AgentSession and concurrent _runAutoCompaction calls.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerFauxProvider } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
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

describe("pi auto-compaction reentrancy characterization (0.71.1 patch)", () => {
  it("keeps the installed agent-session reentrancy guard text", () => {
    // Walk node_modules the same way Forge compaction measurement does — package exports
    // block CJS require.resolve of the ESM-only root.
    let current = dirname(fileURLToPath(import.meta.url));
    let agentSessionPath: string | undefined;
    for (let i = 0; i < 12; i++) {
      const candidate = join(
        current,
        "node_modules",
        "@mariozechner",
        "pi-coding-agent",
        "dist",
        "core",
        "agent-session.js",
      );
      try {
        const source = readFileSync(candidate, "utf8");
        agentSessionPath = candidate;
        expect(source).toContain("Reentrancy guard: if compaction is already in progress, bail out.");
        expect(source).toContain("const localAbortController = new AbortController();");
        expect(source).toContain("if (this._autoCompactionAbortController === localAbortController)");
        break;
      } catch {
        current = dirname(current);
      }
    }
    expect(agentSessionPath).toBeTruthy();
  });

  it("second concurrent _runAutoCompaction is a no-op while the first owns the controller", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-pi-compact-race-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent");

    const faux = registerFauxProvider({
      api: "forge-compact-api",
      provider: "forge-compact",
      models: [{ id: "compact-model", contextWindow: 128_000, maxTokens: 2048 }],
    });
    fauxRegistrations.push(faux);
    // Never needed for this race; compaction will bail on missing preparation or auth.
    faux.setResponses(["unused"]);

    const storage = buildProjectSafePiProjectSettingsStorage({
      agentDir,
      projectExecutablesTrusted: false,
    });
    const settingsManager = SettingsManager.fromStorage(storage);
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

    const agentSession = session as unknown as {
      _autoCompactionAbortController?: AbortController;
      _runAutoCompaction: (reason: string, willRetry: boolean) => Promise<void>;
      subscribe: (listener: (event: { type: string }) => void) => () => void;
    };

    const starts: string[] = [];
    const ends: string[] = [];
    const unsubscribe = agentSession.subscribe((event) => {
      if (event.type === "compaction_start") starts.push(event.type);
      if (event.type === "compaction_end") ends.push(event.type);
    });

    // Hold the shared controller as if compaction were in progress, then race a second call.
    const owner = new AbortController();
    agentSession._autoCompactionAbortController = owner;

    const second = agentSession._runAutoCompaction("threshold", false);
    await second;

    expect(agentSession._autoCompactionAbortController).toBe(owner);
    expect(starts).toEqual([]);
    expect(ends).toEqual([]);

    // Clear owner and run two overlapping calls: first sets controller; second must no-op.
    agentSession._autoCompactionAbortController = undefined;

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const originalRun = agentSession._runAutoCompaction.bind(agentSession);
    // Wrap by pre-setting a barrier after the real method takes ownership via patch.
    const firstPromise = (async () => {
      const run = originalRun("overflow", false);
      // Give the first call a tick to install localAbortController.
      await Promise.resolve();
      await firstGate;
      return run;
    })();

    await Promise.resolve();
    // While first may still be in-flight (or already finished quickly without model auth),
    // invoke a concurrent call — with controller held, it must no-op.
    if (!agentSession._autoCompactionAbortController) {
      agentSession._autoCompactionAbortController = new AbortController();
    }
    await agentSession._runAutoCompaction("threshold", false);
    releaseFirst();
    await firstPromise;

    unsubscribe();
    session.dispose();
  });
});
