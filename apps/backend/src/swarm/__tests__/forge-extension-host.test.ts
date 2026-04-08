import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      runtimeType: "codex"
    });

    expect(bindings).not.toBeNull();
    host.activateRuntimeBindings(bindings!);

    const result = await host.dispatchToolBefore("worker-1", {
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
      runtimeType: "pi"
    });

    host.activateRuntimeBindings(bindings!);

    const result = await host.dispatchToolBefore("worker-1", {
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
      runtimeType: "pi"
    });
    host.activateRuntimeBindings(firstBindings!);

    await expect(
      host.dispatchToolBefore("worker-1", {
        toolName: "bash",
        toolCallId: "tool-reload-1",
        input: { command: "original" }
      })
    ).resolves.toEqual({ input: { command: "first" } });

    host.deactivateRuntimeBindings("worker-1");

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
      runtimeType: "pi"
    });
    host.activateRuntimeBindings(secondBindings!);

    await expect(
      host.dispatchToolBefore("worker-1", {
        toolName: "bash",
        toolCallId: "tool-reload-2",
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
      runtimeType: "codex"
    });
    host.activateRuntimeBindings(bindings!);

    const result = await host.dispatchToolBefore("worker-1", {
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
      runtimeType: "claude"
    });

    host.activateRuntimeBindings(bindings!);

    const result = await host.dispatchToolBefore("worker-1", {
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
