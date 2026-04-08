import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeExtensionHost } from "../forge-extension-host.js";
import type { AgentDescriptor } from "../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ForgeExtensionHost", () => {
  it("builds runtime binding snapshots with metadata and registered hooks", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-host-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const extensionsDir = join(dataDir, "extensions");
    await mkdir(extensionsDir, { recursive: true });

    await writeFile(
      join(extensionsDir, "hooks.ts"),
      `
      export const extension = {
        name: "hooks",
        description: "Registers multiple Forge hooks"
      }
      export default (forge) => {
        forge.on("tool:before", () => undefined)
        forge.on("tool:after", () => undefined)
      }
      `,
      "utf8"
    );

    const host = new ForgeExtensionHost({ dataDir, now: () => "2026-04-08T00:00:00.000Z" });
    const bindings = await host.prepareRuntimeBindings({
      descriptor: createDescriptor(rootDir),
      runtimeType: "pi",
      runtimeToken: 1
    });

    expect(bindings).not.toBeNull();
    expect(bindings?.snapshot).toEqual({
      agentId: "worker-1",
      role: "worker",
      managerId: "manager-1",
      profileId: "profile-1",
      runtimeType: "pi",
      loadedAt: "2026-04-08T00:00:00.000Z",
      extensions: [
        {
          displayName: "hooks.ts",
          path: join(extensionsDir, "hooks.ts"),
          scope: "global",
          name: "hooks",
          description: "Registers multiple Forge hooks",
          hooks: ["tool:before", "tool:after"]
        }
      ]
    });
  });

  it("chains tool:before input mutations across handlers in discovery order", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-host-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const extensionsDir = join(dataDir, "extensions");
    await mkdir(extensionsDir, { recursive: true });

    await writeFile(
      join(extensionsDir, "01-first.ts"),
      `
      export default (forge) => {
        forge.on("tool:before", (event) => ({
          input: {
            ...event.input,
            command: String(event.input.command || "") + " first"
          }
        }))
      }
      `,
      "utf8"
    );
    await writeFile(
      join(extensionsDir, "02-second.ts"),
      `
      export default (forge) => {
        forge.on("tool:before", (event) => ({
          input: {
            ...event.input,
            command: String(event.input.command || "") + " second"
          }
        }))
      }
      `,
      "utf8"
    );

    const host = new ForgeExtensionHost({ dataDir, now: () => "2026-04-08T00:00:00.000Z" });
    const bindings = await host.prepareRuntimeBindings({
      descriptor: createDescriptor(rootDir),
      runtimeType: "codex",
      runtimeToken: 1
    });

    expect(bindings).not.toBeNull();
    host.activateRuntimeBindings(bindings!);

    const result = await host.dispatchToolBefore(bindings!.bindingToken, {
      toolName: "bash",
      toolCallId: "tool-1",
      input: { command: "echo" }
    });

    expect(result).toEqual({
      input: {
        command: "echo first second"
      }
    });
  });

  it("keeps tool:before event inputs isolated across handlers", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-host-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const extensionsDir = join(dataDir, "extensions");
    await mkdir(extensionsDir, { recursive: true });

    await writeFile(
      join(extensionsDir, "01-mutate.ts"),
      `
      export default (forge) => {
        forge.on("tool:before", (event) => {
          event.input.nested.flag = false
          return undefined
        })
      }
      `,
      "utf8"
    );
    await writeFile(
      join(extensionsDir, "02-observe.ts"),
      `
      export default (forge) => {
        forge.on("tool:before", (event) => ({
          input: {
            seenFlag: event.input.nested.flag
          }
        }))
      }
      `,
      "utf8"
    );

    const host = new ForgeExtensionHost({ dataDir, now: () => "2026-04-08T00:00:00.000Z" });
    const bindings = await host.prepareRuntimeBindings({
      descriptor: createDescriptor(rootDir),
      runtimeType: "pi",
      runtimeToken: 1
    });
    host.activateRuntimeBindings(bindings!);

    const originalInput = { nested: { flag: true } };
    const result = await host.dispatchToolBefore(bindings!.bindingToken, {
      toolName: "write",
      toolCallId: "tool-clone",
      input: originalInput as unknown as Record<string, unknown>
    });

    expect(result).toEqual({
      input: {
        seenFlag: true
      }
    });
    expect(originalInput).toEqual({ nested: { flag: true } });
  });

  it("short-circuits remaining tool:before handlers after the first block", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-host-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const extensionsDir = join(dataDir, "extensions");
    const markerPath = join(rootDir, "marker.txt");
    await mkdir(extensionsDir, { recursive: true });

    await writeFile(
      join(extensionsDir, "01-block.ts"),
      `
      export default (forge) => {
        forge.on("tool:before", () => ({ block: true, reason: "blocked by policy" }))
      }
      `,
      "utf8"
    );
    await writeFile(
      join(extensionsDir, "02-side-effect.ts"),
      `
      import { writeFileSync } from "node:fs";
      export default (forge) => {
        forge.on("tool:before", () => {
          writeFileSync(${JSON.stringify(markerPath)}, "should-not-run", "utf8")
          return undefined
        })
      }
      `,
      "utf8"
    );

    const host = new ForgeExtensionHost({ dataDir, now: () => "2026-04-08T00:00:00.000Z" });
    const bindings = await host.prepareRuntimeBindings({
      descriptor: createDescriptor(rootDir),
      runtimeType: "pi",
      runtimeToken: 1
    });

    host.activateRuntimeBindings(bindings!);

    const result = await host.dispatchToolBefore(bindings!.bindingToken, {
      toolName: "write",
      toolCallId: "tool-2",
      input: { path: "x.txt" }
    });

    expect(result).toEqual({ block: true, reason: "blocked by policy" });
    await expect(rm(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reloads extension code on the next runtime binding boundary", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-host-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const extensionsDir = join(dataDir, "extensions");
    const extensionPath = join(extensionsDir, "rewrite.ts");
    await mkdir(extensionsDir, { recursive: true });

    const host = new ForgeExtensionHost({ dataDir, now: () => "2026-04-08T00:00:00.000Z" });

    await writeFile(
      extensionPath,
      `
      export default (forge) => {
        forge.on("tool:before", () => ({ input: { command: "first" } }))
      }
      `,
      "utf8"
    );

    const firstBindings = await host.prepareRuntimeBindings({
      descriptor: createDescriptor(rootDir),
      runtimeType: "pi",
      runtimeToken: 1
    });
    host.activateRuntimeBindings(firstBindings!);

    await expect(
      host.dispatchToolBefore(firstBindings!.bindingToken, {
        toolName: "bash",
        toolCallId: "tool-reload-1",
        input: { command: "original" }
      })
    ).resolves.toEqual({ input: { command: "first" } });

    host.deactivateRuntimeBindings(firstBindings!.bindingToken);

    await writeFile(
      extensionPath,
      `
      export default (forge) => {
        forge.on("tool:before", () => ({ input: { command: "second" } }))
      }
      `,
      "utf8"
    );

    const secondBindings = await host.prepareRuntimeBindings({
      descriptor: createDescriptor(rootDir),
      runtimeType: "pi",
      runtimeToken: 2
    });
    host.activateRuntimeBindings(secondBindings!);

    await expect(
      host.dispatchToolBefore(secondBindings!.bindingToken, {
        toolName: "bash",
        toolCallId: "tool-reload-2",
        input: { command: "original" }
      })
    ).resolves.toEqual({ input: { command: "second" } });
  });

  it("dispatches session:lifecycle using exact cwd project-local resolution", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-host-"));
    tempDirs.push(rootDir);
    const sessionCwd = join(rootDir, "nested");
    const dataDir = join(rootDir, "data");
    const globalExtensionsDir = join(dataDir, "extensions");
    const profileExtensionsDir = join(dataDir, "profiles", "profile-1", "extensions");
    const rootProjectExtensionsDir = join(rootDir, ".forge", "extensions");
    const logPath = join(rootDir, "lifecycle.jsonl");
    await mkdir(globalExtensionsDir, { recursive: true });
    await mkdir(profileExtensionsDir, { recursive: true });
    await mkdir(rootProjectExtensionsDir, { recursive: true });
    await mkdir(sessionCwd, { recursive: true });

    await writeLifecycleExtension(join(globalExtensionsDir, "global.ts"), logPath, "global");
    await writeLifecycleExtension(join(profileExtensionsDir, "profile.ts"), logPath, "profile");
    await writeLifecycleExtension(join(rootProjectExtensionsDir, "project.ts"), logPath, "project-local");

    const host = new ForgeExtensionHost({ dataDir, now: () => "2026-04-08T00:00:00.000Z" });
    await host.dispatchSessionLifecycle({
      action: "created",
      sessionDescriptor: createManagerDescriptor(sessionCwd)
    });

    const events = await readJsonl(logPath);
    expect(events.map((entry) => entry.scope)).toEqual(["global", "profile"]);
  });

  it("dispatches tool:after with the stable result envelope and keeps observing after handler failures", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-host-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const extensionsDir = join(dataDir, "extensions");
    const logPath = join(rootDir, "tool-after.jsonl");
    await mkdir(extensionsDir, { recursive: true });

    await writeFile(
      join(extensionsDir, "01-throw.ts"),
      `
      export default (forge) => {
        forge.on("tool:after", () => {
          throw new Error("after boom")
        })
      }
      `,
      "utf8"
    );
    await writeFile(
      join(extensionsDir, "02-log.ts"),
      `
      import { appendFileSync } from "node:fs"
      export default (forge) => {
        forge.on("tool:after", (event) => {
          appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(event) + "\\n", "utf8")
        })
      }
      `,
      "utf8"
    );

    const host = new ForgeExtensionHost({ dataDir, now: () => "2026-04-08T00:00:00.000Z" });
    const bindings = await host.prepareRuntimeBindings({
      descriptor: createDescriptor(rootDir),
      runtimeType: "claude",
      runtimeToken: 1
    });
    host.activateRuntimeBindings(bindings!);

    await host.dispatchToolAfter(bindings!.bindingToken, {
      toolName: "write",
      toolCallId: "tool-after-1",
      input: { path: "notes.md" },
      result: {
        ok: false,
        error: "write failed",
        raw: { code: "EACCES" }
      }
    });

    const events = await readJsonl(logPath);
    expect(events).toEqual([
      {
        toolName: "write",
        toolCallId: "tool-after-1",
        input: { path: "notes.md" },
        result: {
          ok: false,
          error: "write failed",
          raw: { code: "EACCES" }
        },
        isError: true
      }
    ]);

    const snapshot = await host.buildSettingsSnapshot({ cwdValues: [rootDir] });
    expect(snapshot.recentErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "handler",
          hook: "tool:after",
          message: "after boom",
          agentId: "worker-1",
          runtimeType: "claude"
        })
      ])
    );
  });

  it("dispatches runtime:error through the active runtime binding token", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-host-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const extensionsDir = join(dataDir, "extensions");
    const logPath = join(rootDir, "runtime-error.jsonl");
    await mkdir(extensionsDir, { recursive: true });

    await writeFile(
      join(extensionsDir, "runtime-error.ts"),
      `
      import { appendFileSync } from "node:fs"
      export default (forge) => {
        forge.on("runtime:error", (event) => {
          appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(event) + "\\n", "utf8")
        })
      }
      `,
      "utf8"
    );

    const host = new ForgeExtensionHost({ dataDir, now: () => "2026-04-08T00:00:00.000Z" });
    const bindings = await host.prepareRuntimeBindings({
      descriptor: createDescriptor(rootDir),
      runtimeType: "claude",
      runtimeToken: 1
    });
    host.activateRuntimeBindings(bindings!);

    await host.dispatchRuntimeError(bindings!.bindingToken, {
      phase: "prompt_start",
      message: "boom",
      details: { attempt: 1 }
    });

    const events = await readJsonl(logPath);
    expect(events).toEqual([
      expect.objectContaining({ phase: "prompt_start", message: "boom", details: { attempt: 1 } })
    ]);
  });

  it("records runtime:error handler failures without recursively redispatching runtime:error", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-host-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const extensionsDir = join(dataDir, "extensions");
    const logPath = join(rootDir, "runtime-error-recursion.jsonl");
    await mkdir(extensionsDir, { recursive: true });

    await writeFile(
      join(extensionsDir, "01-throw.ts"),
      `
      export default (forge) => {
        forge.on("runtime:error", () => {
          throw new Error("runtime handler failed")
        })
      }
      `,
      "utf8"
    );
    await writeFile(
      join(extensionsDir, "02-log.ts"),
      `
      import { appendFileSync } from "node:fs"
      export default (forge) => {
        forge.on("runtime:error", (event) => {
          appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(event) + "\\n", "utf8")
        })
      }
      `,
      "utf8"
    );

    const host = new ForgeExtensionHost({ dataDir, now: () => "2026-04-08T00:00:00.000Z" });
    const bindings = await host.prepareRuntimeBindings({
      descriptor: createDescriptor(rootDir),
      runtimeType: "pi",
      runtimeToken: 1
    });
    host.activateRuntimeBindings(bindings!);

    await host.dispatchRuntimeError(bindings!.bindingToken, {
      phase: "tool_result",
      message: "boom"
    });

    expect(await readJsonl(logPath)).toEqual([
      expect.objectContaining({ phase: "tool_result", message: "boom" })
    ]);

    const snapshot = await host.buildSettingsSnapshot({ cwdValues: [rootDir] });
    expect(
      snapshot.recentErrors.filter(
        (entry) => entry.phase === "handler" && entry.hook === "runtime:error" && entry.message === "runtime handler failed"
      )
    ).toHaveLength(1);
  });

  it("dispatches versioning:commit to global and affected profile scopes only", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-host-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const globalExtensionsDir = join(dataDir, "extensions");
    const alphaExtensionsDir = join(dataDir, "profiles", "alpha", "extensions");
    const betaExtensionsDir = join(dataDir, "profiles", "beta", "extensions");
    const projectExtensionsDir = join(rootDir, ".forge", "extensions");
    const logPath = join(rootDir, "versioning.jsonl");
    await mkdir(globalExtensionsDir, { recursive: true });
    await mkdir(alphaExtensionsDir, { recursive: true });
    await mkdir(betaExtensionsDir, { recursive: true });
    await mkdir(projectExtensionsDir, { recursive: true });

    await writeVersioningExtension(join(globalExtensionsDir, "global.ts"), logPath, "global");
    await writeVersioningExtension(join(alphaExtensionsDir, "alpha.ts"), logPath, "alpha");
    await writeVersioningExtension(join(betaExtensionsDir, "beta.ts"), logPath, "beta");
    await writeVersioningExtension(join(projectExtensionsDir, "project.ts"), logPath, "project-local");

    const host = new ForgeExtensionHost({ dataDir, now: () => "2026-04-08T00:00:00.000Z" });
    await host.dispatchVersioningCommit({
      sha: "a".repeat(40),
      subject: "subject",
      body: "body",
      paths: ["profiles/alpha/memory.md"],
      mutations: [{ path: "profiles/alpha/memory.md", action: "write", source: "profile-memory-merge", profileId: "alpha" }],
      reason: "manual",
      profileIds: ["alpha"]
    });

    const events = await readJsonl(logPath);
    expect(events.map((entry) => entry.scope)).toEqual(["global", "alpha"]);
  });

  it("keeps overlapping runtime bindings isolated by binding token", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-host-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const extensionsDir = join(dataDir, "extensions");
    const extensionPath = join(extensionsDir, "rewrite.ts");
    await mkdir(extensionsDir, { recursive: true });

    const host = new ForgeExtensionHost({ dataDir, now: () => "2026-04-08T00:00:00.000Z" });

    await writeFile(
      extensionPath,
      `
      export default (forge) => {
        forge.on("tool:before", () => ({ input: { command: "first" } }))
      }
      `,
      "utf8"
    );

    const firstBindings = await host.prepareRuntimeBindings({
      descriptor: createDescriptor(rootDir),
      runtimeType: "pi",
      runtimeToken: 1
    });
    host.activateRuntimeBindings(firstBindings!);

    await writeFile(
      extensionPath,
      `
      export default (forge) => {
        forge.on("tool:before", () => ({ input: { command: "second" } }))
      }
      `,
      "utf8"
    );

    const secondBindings = await host.prepareRuntimeBindings({
      descriptor: createDescriptor(rootDir),
      runtimeType: "pi",
      runtimeToken: 2
    });
    host.activateRuntimeBindings(secondBindings!);

    await expect(
      host.dispatchToolBefore(firstBindings!.bindingToken, {
        toolName: "bash",
        toolCallId: "tool-overlap-1",
        input: { command: "original" }
      })
    ).resolves.toEqual({ input: { command: "first" } });

    await expect(
      host.dispatchToolBefore(secondBindings!.bindingToken, {
        toolName: "bash",
        toolCallId: "tool-overlap-2",
        input: { command: "original" }
      })
    ).resolves.toEqual({ input: { command: "second" } });
  });

  it("uses the worker id for ctx.agent and the owning manager session id for ctx.session", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-host-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const extensionsDir = join(dataDir, "extensions");
    await mkdir(extensionsDir, { recursive: true });

    await writeFile(
      join(extensionsDir, "context.ts"),
      `
      export default (forge) => {
        forge.on("tool:before", (_event, ctx) => ({
          input: {
            seenAgentId: ctx.agent.agentId,
            seenSessionAgentId: ctx.session.sessionAgentId
          }
        }))
      }
      `,
      "utf8"
    );

    const host = new ForgeExtensionHost({ dataDir, now: () => "2026-04-08T00:00:00.000Z" });
    const bindings = await host.prepareRuntimeBindings({
      descriptor: createDescriptor(rootDir),
      runtimeType: "codex",
      runtimeToken: 1
    });
    host.activateRuntimeBindings(bindings!);

    const result = await host.dispatchToolBefore(bindings!.bindingToken, {
      toolName: "list_agents",
      toolCallId: "tool-context",
      input: {}
    });

    expect(result).toEqual({
      input: {
        seenAgentId: "worker-1",
        seenSessionAgentId: "manager-1"
      }
    });
  });

  it("records only the most recent Forge diagnostic errors", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-host-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const host = new ForgeExtensionHost({ dataDir, now: () => "2026-04-08T00:00:00.000Z" });

    for (let index = 0; index < 55; index += 1) {
      host.recordDiagnosticError({
        phase: "handler",
        message: `error-${index}`
      });
    }

    const snapshot = await host.buildSettingsSnapshot({ cwdValues: [] });
    expect(snapshot.recentErrors).toHaveLength(50);
    expect(snapshot.recentErrors[0]).toEqual(expect.objectContaining({ message: "error-54" }));
    expect(snapshot.recentErrors.at(-1)).toEqual(expect.objectContaining({ message: "error-5" }));
  });

  it("records handler errors and continues fail-open", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-extension-host-"));
    tempDirs.push(rootDir);
    const dataDir = join(rootDir, "data");
    const extensionsDir = join(dataDir, "extensions");
    await mkdir(extensionsDir, { recursive: true });

    await writeFile(
      join(extensionsDir, "01-throw.ts"),
      `
      export default (forge) => {
        forge.on("tool:before", () => {
          throw new Error("boom")
        })
      }
      `,
      "utf8"
    );
    await writeFile(
      join(extensionsDir, "02-mutate.ts"),
      `
      export default (forge) => {
        forge.on("tool:before", (event) => ({
          input: {
            ...event.input,
            path: "patched.txt"
          }
        }))
      }
      `,
      "utf8"
    );

    const host = new ForgeExtensionHost({ dataDir, now: () => "2026-04-08T00:00:00.000Z" });
    const bindings = await host.prepareRuntimeBindings({
      descriptor: createDescriptor(rootDir),
      runtimeType: "claude",
      runtimeToken: 1
    });

    host.activateRuntimeBindings(bindings!);

    const result = await host.dispatchToolBefore(bindings!.bindingToken, {
      toolName: "write",
      toolCallId: "tool-3",
      input: { path: "original.txt" }
    });

    expect(result).toEqual({
      input: {
        path: "patched.txt"
      }
    });

    const snapshot = await host.buildSettingsSnapshot({ cwdValues: [rootDir] });
    expect(snapshot.recentErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "handler",
          hook: "tool:before",
          message: "boom",
          agentId: "worker-1",
          runtimeType: "claude"
        })
      ])
    );
  });
});

function createDescriptor(rootDir: string): AgentDescriptor {
  return {
    agentId: "worker-1",
    displayName: "Worker 1",
    role: "worker",
    managerId: "manager-1",
    profileId: "profile-1",
    status: "idle",
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:00.000Z",
    cwd: rootDir,
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.4-mini",
      thinkingLevel: "high"
    },
    sessionFile: join(rootDir, "session.jsonl")
  };
}

function createManagerDescriptor(rootDir: string): AgentDescriptor {
  return {
    ...createDescriptor(rootDir),
    agentId: "session-1",
    displayName: "Session 1",
    role: "manager",
    managerId: "session-1",
    profileId: "profile-1",
    sessionLabel: "Session 1",
    sessionFile: join(rootDir, "manager-session.jsonl")
  };
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(path, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function writeLifecycleExtension(path: string, logPath: string, scope: string): Promise<void> {
  await writeFile(
    path,
    `
    import { appendFileSync } from "node:fs"
    export default (forge) => {
      forge.on("session:lifecycle", (event) => {
        appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ scope: ${JSON.stringify(scope)}, event }) + "\\n", "utf8")
      })
    }
    `,
    "utf8"
  );
}

async function writeVersioningExtension(path: string, logPath: string, scope: string): Promise<void> {
  await writeFile(
    path,
    `
    import { appendFileSync } from "node:fs"
    export default (forge) => {
      forge.on("versioning:commit", (event) => {
        appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ scope: ${JSON.stringify(scope)}, event }) + "\\n", "utf8")
      })
    }
    `,
    "utf8"
  );
}
