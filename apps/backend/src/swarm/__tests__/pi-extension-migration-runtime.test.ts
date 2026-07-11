/**
 * Real DefaultResourceLoader + createAgentSession gates for Pi extension migration.
 * Forge does not ship @mariozechner/pi-* shims; supported legacy imports either load via
 * upstream loader aliases or surface Forge migration diagnostics. Unsupported subpaths fail.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  diagnosePiExtensionModuleNotFound,
  formatPiExtensionLoadError,
} from "../pi-extension-migration-diagnostics.js";

const tempDirs: string[] = [];
const fauxRegistrations: Array<{ unregister: () => void }> = [];
const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../scripts/__tests__/fixtures/pi-extension-migration",
);

afterEach(async () => {
  while (fauxRegistrations.length > 0) {
    fauxRegistrations.pop()?.unregister();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeExtensionFromFixture(targetPath: string, fixtureName: string, markerPath?: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  if (fixtureName === "legacy-supported") {
    await writeFile(
      targetPath,
      `import { getModel } from '@mariozechner/pi-ai';\n` +
        `import { appendFileSync } from 'node:fs';\n` +
        (markerPath
          ? `appendFileSync(${JSON.stringify(markerPath)}, typeof getModel === 'function' ? 'supported-top\\n' : 'missing-top\\n', 'utf8');\n`
          : "") +
        `export default function setup() {\n` +
        (markerPath
          ? `  appendFileSync(${JSON.stringify(markerPath)}, typeof getModel === 'function' ? 'supported-factory\\n' : 'missing-factory\\n', 'utf8');\n`
          : "") +
        `}\n`,
      "utf8",
    );
    return;
  }
  await writeFile(
    targetPath,
    `import '@mariozechner/pi-ai/private-subpath';\nexport default function setup() {}\n`,
    "utf8",
  );
}

async function loadProjectExtension(root: string, relativeExtension: string): Promise<{
  errors: string[];
  marker: string;
  loadedPaths: string[];
}> {
  const agentDir = join(root, "agent");
  const marker = join(root, "marker.txt");
  const extensionPath = join(root, ".forge", "pi", "extensions", relativeExtension);
  const settingsPath = join(root, ".forge", "pi", "settings.json");
  await writeFile(settingsPath, JSON.stringify({ extensions: [`./extensions/${relativeExtension}`] }), "utf8");

  const storage = buildProjectSafePiProjectSettingsStorage({
    agentDir,
    projectSettingsPaths: [settingsPath],
    projectExecutablesTrusted: true,
  });
  const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: false });
  expect(settingsManager.isProjectTrusted()).toBe(false);

  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload({ resolveProjectTrust: async () => true });
  expect(settingsManager.isProjectTrusted()).toBe(true);

  const faux = registerFauxProvider({
    api: "forge-migration-api",
    provider: "forge-migration",
    models: [{ id: "migration-model" }],
  });
  fauxRegistrations.push(faux);
  faux.setResponses(["ok"]);

  const sessionFile = join(root, `session-${Date.now()}.jsonl`);
  await writeFile(sessionFile, "", "utf8");
  const authStorage = AuthStorage.inMemory({});
  authStorage.setRuntimeApiKey("forge-migration", "faux-test-key");
  const { session, extensionsResult } = await createAgentSession({
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
  session.dispose();

  const loaderErrors = loader.getExtensions().errors.map((entry) => String(entry.error ?? ""));
  const createErrors = (extensionsResult?.errors ?? []).map((entry) => String(entry.error ?? ""));
  const diagnosed = [...loaderErrors, ...createErrors].map(
    (message) => formatPiExtensionLoadError(Object.assign(new Error(message), { code: "ERR_MODULE_NOT_FOUND" }), message),
  );
  return {
    errors: [...loaderErrors, ...createErrors, ...diagnosed],
    marker,
    loadedPaths: loader.getExtensions().extensions.map((extension) => extension.path),
  };
}

describe("pi extension migration through real DefaultResourceLoader + createAgentSession", () => {
  it("loads supported legacy @mariozechner/pi-ai via upstream alias or Forge diagnostic (no shims)", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-pi-ext-supported-"));
    tempDirs.push(root);
    const marker = join(root, "marker.txt");
    await writeExtensionFromFixture(join(root, ".forge", "pi", "extensions", "legacy-supported.js"), "legacy-supported", marker);

    const result = await loadProjectExtension(root, "legacy-supported.js");
    const { readFile } = await import("node:fs/promises");
    let markerLines: string[] = [];
    try {
      markerLines = (await readFile(result.marker, "utf8")).trim().split("\n").filter(Boolean);
    } catch {
      markerLines = [];
    }

    const loadedViaAlias = markerLines.includes("supported-top") || markerLines.includes("supported-factory");
    const diagnosticHit = result.errors.some(
      (message) =>
        message.includes("@earendil-works/pi-ai/compat") ||
        message.includes("does not ship @mariozechner/pi-* shims") ||
        Boolean(diagnosePiExtensionModuleNotFound(Object.assign(new Error(message), { code: "ERR_MODULE_NOT_FOUND" }))),
    );
    expect(
      loadedViaAlias || diagnosticHit,
      `expected upstream alias load or Forge diagnostic; marker=${JSON.stringify(markerLines)} errors=${JSON.stringify(result.errors)}`,
    ).toBe(true);
  });

  it("fails unsupported legacy subpaths with migration-oriented module diagnostics (no shims)", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-pi-ext-unsupported-"));
    tempDirs.push(root);
    await writeExtensionFromFixture(
      join(root, ".forge", "pi", "extensions", "legacy-unsupported.js"),
      "legacy-unsupported",
    );

    const result = await loadProjectExtension(root, "legacy-unsupported.js");
    const combined = result.errors.join("\n");
    expect(combined).toMatch(/private-subpath|Cannot find|ERR_MODULE_NOT_FOUND|Unsupported legacy/i);

    const diagnosed = diagnosePiExtensionModuleNotFound(
      Object.assign(new Error("Cannot find package '@mariozechner/pi-ai/private-subpath' imported from extension"), {
        code: "ERR_MODULE_NOT_FOUND",
      }),
    );
    expect(diagnosed).toContain("Unsupported legacy Pi extension import @mariozechner/pi-ai/private-subpath");
    expect(diagnosed).not.toContain("must be rewritten to");
  });

  it("keeps committed scanner fixtures aligned with runtime cases", async () => {
    const { readFile } = await import("node:fs/promises");
    const supported = await readFile(join(fixturesDir, "legacy-supported.ts"), "utf8");
    const unsupported = await readFile(join(fixturesDir, "legacy-unsupported.ts"), "utf8");
    expect(supported).toContain("@mariozechner/pi-ai");
    expect(supported).toContain("@mariozechner/pi-ai/oauth");
    expect(unsupported).toContain("@mariozechner/pi-ai/private-subpath");
  });
});
