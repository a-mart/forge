import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RemoteBuildSettingsEnvOverrideError,
  RemoteBuildSettingsService,
  RemoteBuildSettingsValidationError,
} from "../collaboration/remote-build-settings-service.js";
import { getRemoteBuildSettingsPath } from "../swarm/data-paths.js";

const tempDirs: string[] = [];

afterEach(async () => {
  // Best-effort; tests do not need durable cleanup beyond process exit.
  tempDirs.length = 0;
});

async function createService(options?: {
  envOverrides?: ConstructorParameters<typeof RemoteBuildSettingsService>[0]["envOverrides"];
  now?: () => Date;
}): Promise<{ service: RemoteBuildSettingsService; dataDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-remote-build-settings-"));
  tempDirs.push(dataDir);
  const service = new RemoteBuildSettingsService({
    dataDir,
    envOverrides: options?.envOverrides,
    now: options?.now,
  });
  await service.load();
  return { service, dataDir };
}

describe("RemoteBuildSettingsService env overlays", () => {
  it("uses defaults when no file and no env overrides exist", async () => {
    const { service } = await createService();
    expect(service.getSettings()).toEqual({
      enabled: false,
      terminalsEnabled: true,
      instanceName: null,
      updatedAt: null,
    });
    expect(service.getPersistedSettings()).toEqual(service.getSettings());
    expect(service.getSources()).toEqual({
      enabled: "settings",
      terminalsEnabled: "settings",
      instanceName: "settings",
    });
  });

  it("applies mixed env overrides over persisted values and reports sources", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-remote-build-mixed-"));
    tempDirs.push(dataDir);

    const seed = new RemoteBuildSettingsService({
      dataDir,
      now: () => new Date("2026-07-14T12:00:00.000Z"),
    });
    await seed.load();
    await seed.update({
      enabled: false,
      terminalsEnabled: false,
      instanceName: "Persisted Name",
    });

    const service = new RemoteBuildSettingsService({
      dataDir,
      envOverrides: { enabled: true, instanceName: "Env Instance" },
    });
    await service.load();

    // Env enabled/instanceName win; terminals stays from the persisted write.
    expect(service.getSettings()).toEqual({
      enabled: true,
      terminalsEnabled: false,
      instanceName: "Env Instance",
      updatedAt: "2026-07-14T12:00:00.000Z",
    });
    expect(service.getPersistedSettings()).toEqual({
      enabled: false,
      terminalsEnabled: false,
      instanceName: "Persisted Name",
      updatedAt: "2026-07-14T12:00:00.000Z",
    });
    expect(service.getSources()).toEqual({
      enabled: "environment",
      terminalsEnabled: "settings",
      instanceName: "environment",
    });

    const onDisk = JSON.parse(await readFile(getRemoteBuildSettingsPath(dataDir), "utf8")) as Record<
      string,
      unknown
    >;
    expect(onDisk.enabled).toBe(false);
    expect(onDisk.instanceName).toBe("Persisted Name");
    expect(JSON.stringify(onDisk)).not.toContain("Env Instance");
  });

  it("rejects controlled and mixed PUTs without writing", async () => {
    const { service, dataDir } = await createService({
      envOverrides: { enabled: true },
      now: () => new Date("2026-07-14T12:00:00.000Z"),
    });

    await expect(service.update({ enabled: false })).rejects.toBeInstanceOf(
      RemoteBuildSettingsEnvOverrideError,
    );

    try {
      await service.update({ enabled: false, terminalsEnabled: false });
      expect.unreachable("expected mixed PUT to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteBuildSettingsEnvOverrideError);
      expect((error as RemoteBuildSettingsEnvOverrideError).code).toBe(
        "REMOTE_BUILD_SETTINGS_ENV_OVERRIDE",
      );
      expect((error as RemoteBuildSettingsEnvOverrideError).controlledFields).toEqual(["enabled"]);
    }

    expect(service.getPersistedSettings().updatedAt).toBeNull();
    await expect(readFile(getRemoteBuildSettingsPath(dataDir), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("persists uncontrolled field updates and returns effective/persisted/source state", async () => {
    const { service } = await createService({
      envOverrides: { enabled: true, instanceName: "From Env" },
      now: () => new Date("2026-07-14T13:00:00.000Z"),
    });

    const result = await service.update({ terminalsEnabled: false });
    expect(result.settings).toEqual({
      enabled: true,
      terminalsEnabled: false,
      instanceName: "From Env",
      updatedAt: "2026-07-14T13:00:00.000Z",
    });
    expect(result.persistedSettings).toEqual({
      enabled: false,
      terminalsEnabled: false,
      instanceName: null,
      updatedAt: "2026-07-14T13:00:00.000Z",
    });
    expect(result.sources).toEqual({
      enabled: "environment",
      terminalsEnabled: "settings",
      instanceName: "environment",
    });
  });

  it("reveals latent persisted values when env overrides are removed", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-remote-build-reveal-"));
    tempDirs.push(dataDir);

    const withEnv = new RemoteBuildSettingsService({
      dataDir,
      envOverrides: { enabled: true },
      now: () => new Date("2026-07-14T14:00:00.000Z"),
    });
    await withEnv.load();
    await withEnv.update({ terminalsEnabled: false, instanceName: "Latent" });
    expect(withEnv.getSettings().enabled).toBe(true);
    expect(withEnv.getPersistedSettings().enabled).toBe(false);

    const withoutEnv = new RemoteBuildSettingsService({ dataDir });
    await withoutEnv.load();
    expect(withoutEnv.getSettings()).toEqual({
      enabled: false,
      terminalsEnabled: false,
      instanceName: "Latent",
      updatedAt: "2026-07-14T14:00:00.000Z",
    });
    expect(withoutEnv.getSources().enabled).toBe("settings");
  });

  it("falls back to host name when effective instanceName is null", async () => {
    const { service } = await createService();
    const display = service.getInstanceDisplayName();
    expect(typeof display).toBe("string");
    expect(display.length).toBeGreaterThan(0);
  });

  it("uses env instance name for display fallback chain", async () => {
    const { service } = await createService({
      envOverrides: { instanceName: "Env Display" },
    });
    expect(service.getInstanceDisplayName()).toBe("Env Display");
  });

  it("validates request shape before env conflict checks", async () => {
    const { service } = await createService({
      envOverrides: { enabled: true },
    });

    await expect(service.update("not-an-object")).rejects.toBeInstanceOf(
      RemoteBuildSettingsValidationError,
    );
    await expect(service.update({ enabled: "yes" })).rejects.toBeInstanceOf(
      RemoteBuildSettingsValidationError,
    );
  });
});
