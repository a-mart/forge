import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SECURE_SECRET_ABSOLUTE_MAX_PROJECT_DEFAULTS,
  SECURE_SECRET_MAX_PROJECT_DEFAULTS,
  SECURE_SECRET_MIN_PROJECT_DEFAULTS,
} from "@forge/protocol";
import { getSecureSecretSettingsPath } from "../data-paths.js";
import {
  SecureSecretSettingsConflictError,
  SecureSecretSettingsService,
  SecureSecretSettingsValidationError,
  createDefaultSecureSecretSettings,
} from "../secure-sessions/secure-secret-settings-service.js";

describe("SecureSecretSettingsService", () => {
  it("loads the default of 50 when the settings file is missing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "secure-secret-settings-defaults-"));
    const service = new SecureSecretSettingsService({ dataDir });

    await service.load();

    expect(service.getSettings()).toEqual(createDefaultSecureSecretSettings());
    expect(service.getMaxProjectDefaults()).toBe(SECURE_SECRET_MAX_PROJECT_DEFAULTS);
    expect(service.getSettingsView().constraints.maxProjectDefaults).toEqual({
      min: SECURE_SECRET_MIN_PROJECT_DEFAULTS,
      max: SECURE_SECRET_ABSOLUTE_MAX_PROJECT_DEFAULTS,
      default: SECURE_SECRET_MAX_PROJECT_DEFAULTS,
    });
    await expect(access(getSecureSecretSettingsPath(dataDir))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("persists a custom override and reloads it after restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "secure-secret-settings-persist-"));
    const now = new Date("2026-08-31T12:00:00.000Z");
    const service = new SecureSecretSettingsService({ dataDir, now: () => now });

    await service.load();
    const updated = await service.update({ maxProjectDefaults: 12 });

    expect(updated).toEqual({
      maxProjectDefaults: 12,
      updatedAt: "2026-08-31T12:00:00.000Z",
    });
    const stored = JSON.parse(
      await readFile(getSecureSecretSettingsPath(dataDir), "utf8"),
    ) as Record<string, unknown>;
    expect(stored).toEqual({
      version: 1,
      maxProjectDefaults: 12,
      updatedAt: "2026-08-31T12:00:00.000Z",
    });

    const reloaded = new SecureSecretSettingsService({ dataDir });
    await reloaded.load();
    expect(reloaded.getMaxProjectDefaults()).toBe(12);
  });

  it("clamps malformed persisted files on load only", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "secure-secret-settings-clamp-"));
    const settingsPath = getSecureSecretSettingsPath(dataDir);
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      `${JSON.stringify({
        version: 1,
        maxProjectDefaults: 0,
        updatedAt: "2026-08-31T12:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const service = new SecureSecretSettingsService({ dataDir });
    await service.load();
    expect(service.getMaxProjectDefaults()).toBe(SECURE_SECRET_MIN_PROJECT_DEFAULTS);
  });

  it("rejects empty, decimal, and out-of-range updates without clamping", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "secure-secret-settings-invalid-"));
    const service = new SecureSecretSettingsService({ dataDir });
    await service.load();

    await expect(service.update({ maxProjectDefaults: "12" as never }))
      .rejects.toBeInstanceOf(SecureSecretSettingsValidationError);
    await expect(service.update({ maxProjectDefaults: 12.5 }))
      .rejects.toBeInstanceOf(SecureSecretSettingsValidationError);
    await expect(service.update({ maxProjectDefaults: 0 }))
      .rejects.toBeInstanceOf(SecureSecretSettingsValidationError);
    await expect(service.update({ maxProjectDefaults: 257 }))
      .rejects.toBeInstanceOf(SecureSecretSettingsValidationError);
    await expect(service.update(null)).rejects.toBeInstanceOf(SecureSecretSettingsValidationError);
    expect(service.getMaxProjectDefaults()).toBe(SECURE_SECRET_MAX_PROJECT_DEFAULTS);
  });

  it("rejects lowering below the occupied automatic-grant count", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "secure-secret-settings-occupied-"));
    const service = new SecureSecretSettingsService({
      dataDir,
      getOccupiedProjectDefaultCount: () => 8,
    });
    await service.load();

    await expect(service.update({ maxProjectDefaults: 7 }))
      .rejects.toBeInstanceOf(SecureSecretSettingsConflictError);
    expect(service.getMaxProjectDefaults()).toBe(SECURE_SECRET_MAX_PROJECT_DEFAULTS);

    await expect(service.update({ maxProjectDefaults: 8 })).resolves.toEqual(
      expect.objectContaining({ maxProjectDefaults: 8 }),
    );
  });
});
