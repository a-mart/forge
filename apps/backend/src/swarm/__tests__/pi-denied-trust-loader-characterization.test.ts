/**
 * Denied-trust regression matrix through real DefaultResourceLoader + createAgentSession.
 * These are incomplete security regression boundary tests, not a demonstrated active exploit.
 */
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerFauxProvider } from "../pi/pi-ai-compat.js";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
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

async function readMarker(path: string): Promise<string[]> {
  if (!await pathExists(path)) return [];
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
}

async function writeMarkerExtension(path: string, marker: string, label: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `import { appendFileSync } from 'node:fs';\n` +
      `appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${label}:top\n`)}, 'utf8');\n` +
      `export default function setup() { appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${label}:factory\n`)}, 'utf8'); }\n`,
    "utf8",
  );
}

async function createRealSession(options: {
  root: string;
  agentDir: string;
  loader: DefaultResourceLoader;
  settingsManager: SettingsManager;
}): Promise<AgentSession> {
  const faux = registerFauxProvider({
    api: "forge-denied-api",
    provider: "forge-denied",
    models: [{ id: "denied-model" }],
  });
  fauxRegistrations.push(faux);
  faux.setResponses(["ok"]);

  const sessionFile = join(options.root, `session-${Date.now()}-${Math.random()}.jsonl`);
  await writeFile(sessionFile, "", "utf8");
  const authStorage = AuthStorage.inMemory({});
  authStorage.setRuntimeApiKey("forge-denied", "faux-test-key");
  const { session } = await createAgentSession({
    cwd: options.root,
    agentDir: options.agentDir,
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    model: faux.getModel(),
    sessionManager: SessionManager.open(sessionFile, undefined, options.root),
    resourceLoader: options.loader,
    settingsManager: options.settingsManager,
    noTools: "all",
  });
  return session;
}

async function createDeniedLoader(root: string, agentDir: string, projectSettingsPaths: string[]): Promise<{
  loader: DefaultResourceLoader;
  settingsManager: SettingsManager;
}> {
  const storage = buildProjectSafePiProjectSettingsStorage({
    agentDir,
    projectSettingsPaths,
    projectExecutablesTrusted: false,
  });
  const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: false });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload({ resolveProjectTrust: async () => false });
  return { loader, settingsManager };
}

describe("pi denied-trust loader characterization", () => {
  it("does not evaluate project .pi/.forge/pi direct, settings, package, symlink, or case-variant extensions when project trust is denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-pi-denied-trust-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent");
    const marker = join(root, "marker-denied.txt");
    const escapedRoot = await mkdtemp(join(tmpdir(), "forge-pi-denied-escape-"));
    tempDirs.push(escapedRoot);

    await writeMarkerExtension(join(root, ".pi", "extensions", "legacy.js"), marker, "legacy-direct");
    await writeMarkerExtension(join(root, ".forge", "pi", "extensions", "direct.js"), marker, "forge-direct");
    await writeMarkerExtension(join(root, ".forge", "pi", "extensions", "settings.js"), marker, "settings-declared");
    await writeMarkerExtension(join(root, ".forge", "pi", "pkg", "pkg-extension.js"), marker, "package-declared");
    await writeFile(
      join(root, ".forge", "pi", "pkg", "package.json"),
      JSON.stringify({ pi: { extensions: ["./pkg-extension.js"] } }),
      "utf8",
    );
    await writeMarkerExtension(join(escapedRoot, "escape.js"), marker, "symlink-escape");
    await symlink(join(escapedRoot, "escape.js"), join(root, ".forge", "pi", "extensions", "escape-link.js"));

    const projectSettingsPath = join(root, ".forge", "pi", "settings.json");
    const settingsExtensions = ["./extensions/settings.js", "./extensions/escape-link.js"];
    const caseProbePath = join(root, "case-probe");
    await writeFile(caseProbePath, "case", "utf8");
    const supportsCaseInsensitiveLookup = await pathExists(join(root, "CASE-PROBE"));
    if (supportsCaseInsensitiveLookup) {
      await writeMarkerExtension(join(root, ".forge", "pi", "extensions", "case.js"), marker, "case-variant");
      settingsExtensions.push("./EXTENSIONS/CASE.js");
    }
    await writeFile(
      projectSettingsPath,
      JSON.stringify({ extensions: settingsExtensions, packages: ["./pkg"] }),
      "utf8",
    );
    await writeFile(
      join(root, ".pi", "settings.json"),
      JSON.stringify({ extensions: ["./extensions/legacy.js"] }),
      "utf8",
    );

    expect(await readMarker(marker)).toEqual([]);
    const { loader, settingsManager } = await createDeniedLoader(root, agentDir, [projectSettingsPath, join(root, ".pi", "settings.json")]);
    expect(await readMarker(marker)).toEqual([]);
    expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual([]);

    const session = await createRealSession({ root, agentDir, loader, settingsManager });
    expect(await readMarker(marker)).toEqual([]);
    await session.bindExtensions({});
    await new Promise((resolve) => setImmediate(resolve));
    expect(await readMarker(marker)).toEqual([]);
    session.dispose();
  });

  it("elevates project trust only through resolveProjectTrust after constructing projectTrusted:false", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-pi-trust-elevate-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent");
    const marker = join(root, "marker-elevate.txt");
    const settingsPath = join(root, ".forge", "pi", "settings.json");
    await writeMarkerExtension(join(root, ".forge", "pi", "extensions", "trusted.js"), marker, "elevated");
    await writeFile(settingsPath, JSON.stringify({ extensions: ["./extensions/trusted.js"] }), "utf8");

    const storage = buildProjectSafePiProjectSettingsStorage({
      agentDir,
      projectSettingsPaths: [settingsPath],
      projectExecutablesTrusted: true,
    });
    // Creator-path contract: SettingsManager starts untrusted.
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

    expect(await readMarker(marker)).toEqual([]);
    await loader.reload({ resolveProjectTrust: async () => false });
    expect(settingsManager.isProjectTrusted()).toBe(false);
    expect(await readMarker(marker)).toEqual([]);

    await loader.reload({ resolveProjectTrust: async () => true });
    expect(settingsManager.isProjectTrusted()).toBe(true);
    expect(await readMarker(marker)).toEqual(["elevated:top", "elevated:factory"]);

    const session = await createRealSession({ root, agentDir, loader, settingsManager });
    await session.bindExtensions({});
    await new Promise((resolve) => setImmediate(resolve));
    expect(await readMarker(marker)).toEqual(["elevated:top", "elevated:factory"]);
    session.dispose();
  });

  it("loads trusted project extensions exactly once and blocks them after trust is revoked and runtime is recreated", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-pi-trust-revoked-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent");
    const marker = join(root, "marker-trusted.txt");
    const settingsPath = join(root, ".forge", "pi", "settings.json");
    await writeMarkerExtension(join(root, ".forge", "pi", "extensions", "trusted.js"), marker, "trusted");
    await writeFile(settingsPath, JSON.stringify({ extensions: ["./extensions/trusted.js"] }), "utf8");

    const trustedStorage = buildProjectSafePiProjectSettingsStorage({
      agentDir,
      projectSettingsPaths: [settingsPath],
      projectExecutablesTrusted: true,
    });
    // Mirror runtime creator: construct false, elevate only via resolveProjectTrust.
    const trustedSettingsManager = SettingsManager.fromStorage(trustedStorage, { projectTrusted: false });
    expect(trustedSettingsManager.isProjectTrusted()).toBe(false);
    const trustedLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager: trustedSettingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    expect(await readMarker(marker)).toEqual([]);
    await trustedLoader.reload({ resolveProjectTrust: async () => true });
    expect(trustedSettingsManager.isProjectTrusted()).toBe(true);
    expect(await readMarker(marker)).toEqual(["trusted:top", "trusted:factory"]);
    const trustedSession = await createRealSession({ root, agentDir, loader: trustedLoader, settingsManager: trustedSettingsManager });
    expect(await readMarker(marker)).toEqual(["trusted:top", "trusted:factory"]);
    await trustedSession.bindExtensions({});
    await new Promise((resolve) => setImmediate(resolve));
    expect(await readMarker(marker)).toEqual(["trusted:top", "trusted:factory"]);
    trustedSession.dispose();

    const { loader: revokedLoader, settingsManager: revokedSettingsManager } = await createDeniedLoader(root, agentDir, [settingsPath]);
    expect(await readMarker(marker)).toEqual(["trusted:top", "trusted:factory"]);
    const revokedSession = await createRealSession({ root, agentDir, loader: revokedLoader, settingsManager: revokedSettingsManager });
    await revokedSession.bindExtensions({});
    await new Promise((resolve) => setImmediate(resolve));
    expect(await readMarker(marker)).toEqual(["trusted:top", "trusted:factory"]);
    revokedSession.dispose();
  });

  it.skipIf(process.platform !== "win32")("blocks Windows junction project-resource escapes when project trust is denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-pi-denied-junction-"));
    tempDirs.push(root);
    const escapedRoot = await mkdtemp(join(tmpdir(), "forge-pi-denied-junction-escape-"));
    tempDirs.push(escapedRoot);
    const agentDir = join(root, "agent");
    const marker = join(root, "marker-junction.txt");
    const extensionsDir = join(root, ".forge", "pi", "extensions");
    await mkdir(extensionsDir, { recursive: true });
    await writeMarkerExtension(join(escapedRoot, "escape.js"), marker, "junction-escape");

    const junctionPath = join(extensionsDir, "escape-pkg");
    await symlink(escapedRoot, junctionPath, "junction");

    const projectSettingsPath = join(root, ".forge", "pi", "settings.json");
    await writeFile(
      projectSettingsPath,
      JSON.stringify({ extensions: ["./extensions/escape-pkg/escape.js"] }),
      "utf8",
    );

    expect(await readMarker(marker)).toEqual([]);
    const { loader, settingsManager } = await createDeniedLoader(root, agentDir, [projectSettingsPath]);
    expect(await readMarker(marker)).toEqual([]);
    expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual([]);

    const session = await createRealSession({ root, agentDir, loader, settingsManager });
    await session.bindExtensions({});
    await new Promise((resolve) => setImmediate(resolve));
    expect(await readMarker(marker)).toEqual([]);
    session.dispose();
  });

  it.skipIf(process.platform !== "win32")("blocks Windows case/path variants when project trust is denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-pi-denied-case-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent");
    const marker = join(root, "marker-case.txt");
    await writeMarkerExtension(join(root, ".forge", "pi", "extensions", "CaseVariant.js"), marker, "case-variant");

    const projectSettingsPath = join(root, ".forge", "pi", "settings.json");
    await writeFile(
      projectSettingsPath,
      JSON.stringify({
        extensions: [
          "./extensions/casevariant.js",
          "./EXTENSIONS/CaseVariant.js",
          "./extensions/./CaseVariant.js",
        ],
      }),
      "utf8",
    );

    expect(await readMarker(marker)).toEqual([]);
    const { loader, settingsManager } = await createDeniedLoader(root, agentDir, [
      projectSettingsPath,
      join(root, ".FORGE", "pi", "settings.json"),
    ]);
    expect(await readMarker(marker)).toEqual([]);
    expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual([]);

    const session = await createRealSession({ root, agentDir, loader, settingsManager });
    await session.bindExtensions({});
    await new Promise((resolve) => setImmediate(resolve));
    expect(await readMarker(marker)).toEqual([]);
    session.dispose();
  });

  it("fails closed when Windows trust gates are required outside win32", () => {
    if (process.env.FORGE_REQUIRE_WIN32_TRUST_GATES !== "1") {
      return;
    }
    expect(
      process.platform,
      "FORGE_REQUIRE_WIN32_TRUST_GATES=1 requires win32 CI runners for junction/case trust gates",
    ).toBe("win32");
  });
});
