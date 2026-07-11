/**
 * WP-0: real Pi boundary — AuthStorage + SettingsManager + DefaultResourceLoader + createAgentSession
 * with registerFauxProvider (no network). Does not mock createAgentSession.
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

describe("pi runtime boundary characterization (real createAgentSession)", () => {
  it("builds a no-network session through Forge-safe settings storage + real Pi SDK", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-pi-boundary-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent");
    const sessionFile = join(root, "session.jsonl");

    const faux = registerFauxProvider({
      api: "forge-boundary-api",
      provider: "forge-boundary",
      models: [{ id: "boundary-model", name: "Boundary", contextWindow: 32_000, maxTokens: 1024 }],
    });
    fauxRegistrations.push(faux);
    faux.setResponses(["boundary-ok"]);

    const storage = buildProjectSafePiProjectSettingsStorage({
      agentDir,
      projectExecutablesTrusted: false,
    });
    const settingsManager = SettingsManager.fromStorage(storage);
    const authStorage = AuthStorage.inMemory({});
    authStorage.setRuntimeApiKey("forge-boundary", "faux-test-key");
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

    const { session, extensionsResult } = await createAgentSession({
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

    expect(session).toBeTruthy();
    expect(extensionsResult.errors ?? []).toEqual([]);
    expect(session.model?.id).toBe("boundary-model");

    await session.prompt("ping from boundary characterization");
    // Faux provider should complete without network.
    const branch = session.sessionManager.getBranch();
    expect(branch.some((entry) => entry.type === "message")).toBe(true);

    session.dispose();
  });
});
