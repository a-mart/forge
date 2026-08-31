import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const testFile = fileURLToPath(import.meta.url);
const backendSrcDir = resolve(dirname(testFile), "..", "..");
const skillDir = join(backendSrcDir, "swarm", "skills", "builtins", "delegation-presets");
const helperScript = join(skillDir, "manage-delegation-presets.mjs");

type Preset = Record<string, unknown> & { rosterId: string; revision: number };
type Settings = { version: 1; defaultRosterId: string; rosters: Preset[] };
type CliResult = {
  status: number | null;
  stderr: string;
  json: Record<string, unknown>;
};

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  })));
});

function samplePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    rosterId: "balanced",
    revision: 3,
    name: "Balanced",
    defaultRouteId: "builder",
    modeRoutes: { general: "builder" },
    routes: [{
      routeId: "builder",
      label: "Builder",
      behaviorMode: "general",
      useWhen: "Use for ordinary implementation.",
      provider: "openai-codex",
      modelId: "gpt-5.6-terra",
      reasoningLevel: "high",
    }],
    ...overrides,
  };
}

async function startApi(initialSettings: Settings) {
  let settings = structuredClone(initialSettings);
  let putCount = 0;
  const models = [{
    presetId: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    provider: "openai-codex",
    modelId: "gpt-5.6-terra",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  }];

  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/api/settings/delegation-rosters") {
      response.end(JSON.stringify(settings));
      return;
    }
    if (request.method === "GET" && request.url === "/api/settings/models") {
      response.end(JSON.stringify({ models }));
      return;
    }
    if (request.method === "PUT" && request.url === "/api/settings/delegation-rosters") {
      putCount += 1;
      const body = await readRequestJson(request);
      const existingById = new Map(settings.rosters.map((preset) => [preset.rosterId, preset]));
      settings = {
        ...(body as Settings),
        rosters: (body as Settings).rosters.map((preset) => {
          const existing = existingById.get(preset.rosterId);
          return {
            ...preset,
            revision: existing ? existing.revision + 1 : 1,
          };
        }),
      };
      response.end(JSON.stringify(settings));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "Not found" }));
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  openServers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");

  return {
    url: `http://127.0.0.1:${address.port}`,
    settings: () => structuredClone(settings),
    putCount: () => putCount,
  };
}

async function readRequestJson(request: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function writePresetFile(preset: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "delegation-preset-skill-"));
  const filePath = join(directory, "preset.json");
  await writeFile(filePath, `${JSON.stringify(preset, null, 2)}\n`, "utf8");
  return filePath;
}

async function runHelper(args: string[]): Promise<CliResult> {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [helperScript, ...args], {
      cwd: skillDir,
      env: { ...process.env, SWARM_DATA_DIR: "/tmp/forge-skill-test-data" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => {
      try {
        resolveRun({ status, stderr, json: JSON.parse(stdout.trim()) as Record<string, unknown> });
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe("delegation-presets skill helper", () => {
  it("refuses to target a non-local Forge instance", async () => {
    const result = await runHelper(["list", "--url", "https://forge.example.com"]);

    expect(result.status).toBe(1);
    expect(result.json).toEqual({
      ok: false,
      error: "Forge base URL must target the local Forge instance",
    });
  });

  it("inspects the current presets and live model choices", async () => {
    const api = await startApi({ version: 1, defaultRosterId: "balanced", rosters: [samplePreset()] });

    const list = await runHelper(["list", "--url", api.url]);
    const models = await runHelper(["models", "--url", api.url]);

    expect(list.status).toBe(0);
    expect(list.stderr).toBe("");
    expect(list.json).toMatchObject({
      ok: true,
      defaultRosterId: "balanced",
      storagePath: "/tmp/forge-skill-test-data/shared/config/delegation-rosters.json",
      presets: [{ rosterId: "balanced", revision: 3 }],
    });
    expect(models.json).toMatchObject({
      ok: true,
      models: [{
        provider: "openai-codex",
        modelId: "gpt-5.6-terra",
        supportedReasoningLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
      }],
    });
  });

  it("previews creation without writing and applies through the Settings API on request", async () => {
    const api = await startApi({ version: 1, defaultRosterId: "balanced", rosters: [samplePreset()] });
    const proposalPath = await writePresetFile({
      ...samplePreset({ rosterId: "focused", name: "Focused" }),
      revision: undefined,
    });

    const preview = await runHelper(["create", "--file", proposalPath, "--url", api.url]);
    expect(preview.status).toBe(0);
    expect(preview.json).toMatchObject({
      ok: true,
      action: "preview_create",
      proposal: { rosterId: "focused", name: "Focused", revision: 1 },
    });
    expect(api.putCount()).toBe(0);

    const applied = await runHelper(["create", "--file", proposalPath, "--apply", "--url", api.url]);
    expect(applied.status).toBe(0);
    expect(applied.json).toMatchObject({
      ok: true,
      action: "created",
      preset: { rosterId: "focused", revision: 1 },
    });
    expect(api.putCount()).toBe(1);
    expect(api.settings().rosters.map((preset) => preset.rosterId)).toEqual(["balanced", "focused"]);
  });

  it("requires the current revision before updating and preserves the selected preset identity", async () => {
    const api = await startApi({ version: 1, defaultRosterId: "balanced", rosters: [samplePreset()] });
    const proposalPath = await writePresetFile({
      ...samplePreset({ revision: 99, name: "Balanced development" }),
    });

    const stale = await runHelper([
      "update", "--id", "balanced", "--expected-revision", "2",
      "--file", proposalPath, "--apply", "--url", api.url,
    ]);
    expect(stale.status).toBe(1);
    expect(stale.json).toEqual({
      ok: false,
      error: "Delegation preset balanced changed: expected revision 2, current revision is 3",
    });
    expect(api.putCount()).toBe(0);

    const applied = await runHelper([
      "update", "--id", "balanced", "--expected-revision", "3",
      "--file", proposalPath, "--apply", "--url", api.url,
    ]);
    expect(applied.status).toBe(0);
    expect(applied.json).toMatchObject({
      ok: true,
      action: "updated",
      preset: { rosterId: "balanced", revision: 4, name: "Balanced development" },
    });
    expect(api.settings().rosters[0]).toMatchObject({
      rosterId: "balanced",
      revision: 4,
      name: "Balanced development",
    });
  });
});
