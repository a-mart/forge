import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTempConfig } from "../../test-support/temp-config.js";
import { FakeRuntime, TestSwarmManager as TestSwarmManagerBase } from "../../test-support/index.js";
import type { AgentDescriptor } from "../types.js";
import type { RuntimeCreationOptions, SwarmAgentRuntime } from "../runtime-contracts.js";

class TestSwarmManager extends TestSwarmManagerBase {
  protected override async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions,
  ): Promise<SwarmAgentRuntime> {
    const runtime = await super.createRuntimeForDescriptor(descriptor, systemPrompt, runtimeToken, options);
    (runtime as FakeRuntime).terminateMutatesDescriptorStatus = false;
    return runtime;
  }
}

/**
 * Docker-shaped collaboration-server layout: image checkout (/app stand-in) is
 * defaultCwd/rootDir, while remote selection is allowlisted to /workspaces.
 */
describe("collaboration-server CWD allowlist boot vs selection", () => {
  it("boots when defaultCwd/rootDir is outside /workspaces; selection APIs stay gated", async () => {
    const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "cwd-docker-shape-")));
    const appRoot = join(tempRoot, "app");
    const workspaces = join(tempRoot, "workspaces");
    await mkdir(appRoot);
    await mkdir(workspaces);

    const handle = await createTempConfig({
      prefix: "cwd-docker-boot-",
      tempRootDir: tempRoot,
      rootDir: appRoot,
      defaultCwd: appRoot,
      runtimeTarget: "collaboration-server",
      cwdAllowlistRoots: [workspaces],
      adminEmail: "cwd-boot-admin@example.com",
      adminPassword: "cwd-boot-admin-password-1",
    });

    const manager = new TestSwarmManager(handle.config);
    await expect(manager.boot()).resolves.toBeUndefined();
    expect(manager.getConfig().defaultCwd).toBe(appRoot);

    // Selection surfaces remain fail-closed outside the allowlist.
    const outsideValidation = await manager.validateDirectory(appRoot);
    expect(outsideValidation.valid).toBe(false);
    expect(outsideValidation.message).toMatch(/outside the configured workspace roots/i);

    await expect(manager.listDirectories(appRoot)).rejects.toMatchObject({
      code: "DIRECTORY_OUTSIDE_ROOT",
    });

    await expect(manager.createDirectory(appRoot, "project")).rejects.toMatchObject({
      code: "DIRECTORY_OUTSIDE_ROOT",
    });

    const caller =
      manager.listAgents().find((agent) => agent.role === "manager")?.agentId ?? "manager";
    await expect(
      manager.createManager(caller, { name: "Outside Project", cwd: appRoot }),
    ).rejects.toThrow(/outside the configured workspace roots/i);

    // Allowed root selection still works.
    const listed = await manager.listDirectories(undefined);
    expect(listed.roots).toEqual([workspaces]);
    const insideValidation = await manager.validateDirectory(workspaces);
    expect(insideValidation.valid).toBe(true);
    expect(insideValidation.resolvedPath).toBe(workspaces);

    const created = await manager.createDirectory(workspaces, "project");
    expect(created.path).toBe(join(workspaces, "project"));

    await handle.cleanup();
  });

  it("fails closed for selection when no usable roots are configured, but still boots", async () => {
    const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "cwd-docker-empty-")));
    const appRoot = join(tempRoot, "app");
    await mkdir(appRoot);

    const handle = await createTempConfig({
      prefix: "cwd-docker-empty-",
      tempRootDir: tempRoot,
      rootDir: appRoot,
      defaultCwd: appRoot,
      runtimeTarget: "collaboration-server",
      cwdAllowlistRoots: [],
      adminEmail: "cwd-empty-admin@example.com",
      adminPassword: "cwd-empty-admin-password-1",
    });

    const manager = new TestSwarmManager(handle.config);
    await expect(manager.boot()).resolves.toBeUndefined();

    await expect(manager.listDirectories(undefined)).rejects.toMatchObject({
      code: "DIRECTORY_NO_ROOTS",
    });
    const validation = await manager.validateDirectory(appRoot);
    expect(validation.valid).toBe(false);
    expect(validation.message).toMatch(/FORGE_CWD_ALLOWLIST_ROOTS/);

    await handle.cleanup();
  });
});
