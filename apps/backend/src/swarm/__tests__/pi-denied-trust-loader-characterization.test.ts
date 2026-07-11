/**
 * Denied-trust marker tests through real DefaultResourceLoader (+ createAgentSession).
 * Asserts project extension side effects do not run when Forge-safe settings use extensions: ["!*"].
 */
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

describe("pi denied-trust loader characterization", () => {
  it("does not evaluate project .pi or .forge/pi extensions when projectExecutablesTrusted is false", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-pi-denied-trust-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent");
    const markerPi = join(root, "marker-pi-extension.txt");
    const markerForgePi = join(root, "marker-forge-pi-extension.txt");

    await mkdir(join(root, ".pi", "extensions"), { recursive: true });
    await mkdir(join(root, ".forge", "pi", "extensions"), { recursive: true });
    await writeFile(
      join(root, ".pi", "extensions", "denied.js"),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPi)}, 'evaluated', 'utf8'); export default function setup() { writeFileSync(${JSON.stringify(markerPi)}, 'setup', 'utf8'); }\n`,
      "utf8",
    );
    await writeFile(
      join(root, ".forge", "pi", "extensions", "denied.js"),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerForgePi)}, 'evaluated', 'utf8'); export default function setup() { writeFileSync(${JSON.stringify(markerForgePi)}, 'setup', 'utf8'); }\n`,
      "utf8",
    );

    const storage = buildProjectSafePiProjectSettingsStorage({
      agentDir,
      projectExecutablesTrusted: false,
    });
    const settingsManager = SettingsManager.fromStorage(storage);

    // Checkpoint before loader
    expect(await pathExists(markerPi)).toBe(false);
    expect(await pathExists(markerForgePi)).toBe(false);

    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    expect(await pathExists(markerPi)).toBe(false);
    expect(await pathExists(markerForgePi)).toBe(false);
    expect(loader.getExtensions().extensions.map((e) => e.path)).not.toContain(
      join(root, ".pi", "extensions", "denied.js"),
    );
    expect(loader.getExtensions().extensions.map((e) => e.path)).not.toContain(
      join(root, ".forge", "pi", "extensions", "denied.js"),
    );

    const faux = registerFauxProvider({
      api: "forge-denied-api",
      provider: "forge-denied",
      models: [{ id: "denied-model" }],
    });
    fauxRegistrations.push(faux);
    faux.setResponses(["ok"]);

    const sessionFile = join(root, "session.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const authStorage = AuthStorage.inMemory({});
    authStorage.setRuntimeApiKey("forge-denied", "faux-test-key");
    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      model: faux.getModel(),
      sessionManager: SessionManager.open(sessionFile, undefined, root),
      resourceLoader: loader,
      settingsManager,
      noTools: "all",
    });

    await session.bindExtensions({});
    await new Promise((resolve) => setImmediate(resolve));

    expect(await pathExists(markerPi)).toBe(false);
    expect(await pathExists(markerForgePi)).toBe(false);

    session.dispose();
  });
});
