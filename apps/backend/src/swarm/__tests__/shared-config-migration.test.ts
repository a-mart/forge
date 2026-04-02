import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getCortexAutoReviewSettingsPath,
  getGlobalSlashCommandsPath,
  getSharedAuthFilePath,
  getSharedDir,
  getSharedIntegrationsDir,
  getSharedMobileDevicesPath,
  getSharedModelOverridesPath,
  getSharedPlaywrightDashboardSettingsPath,
  getSharedSecretsFilePath,
  getSharedStateDir,
  getSharedMobileNotificationPreferencesPath,
  getTerminalSettingsPath,
} from "../data-paths.js";
import { migrateSharedConfigLayout } from "../shared-config-migration.js";

const MIGRATION_SENTINEL = ".shared-config-migration-done";
const BACKFILL_SENTINEL = ".compaction-count-backfill-v2-done";

describe("shared-config-migration", () => {
  it("copies shared-flat durable files into shared/{config,state} and preserves originals", async () => {
    const root = await mkdtemp(join(tmpdir(), "shared-config-migration-"));
    const dataDir = join(root, "data");
    const sharedDir = getSharedDir(dataDir);

    await writeText(join(sharedDir, "auth", "auth.json"), '{"provider":"openai-codex"}\n');
    await writeText(join(sharedDir, "secrets.json"), '{"OPENAI_API_KEY":"secret"}\n');
    await writeText(join(sharedDir, "model-overrides.json"), '{"version":1,"overrides":{}}\n');
    await writeText(join(sharedDir, "cortex-auto-review.json"), '{"enabled":true}\n');
    await writeText(join(sharedDir, "playwright-dashboard.json"), '{"enabled":false}\n');
    await writeText(join(sharedDir, "mobile-notification-prefs.json"), '{"version":1}\n');
    await writeText(join(sharedDir, "terminal-settings.json"), '{"defaultShell":"/bin/zsh"}\n');
    await writeText(join(sharedDir, "slash-commands.json"), '{"commands":[]}\n');
    await writeText(join(sharedDir, "mobile-devices.json"), '{"devices":[]}\n');
    await writeText(join(sharedDir, BACKFILL_SENTINEL), "done\n");
    await writeText(join(sharedDir, "integrations", "telegram.json"), '{"enabled":true}\n');

    await migrateSharedConfigLayout(dataDir);

    await expect(readFile(getSharedAuthFilePath(dataDir), "utf8")).resolves.toContain("openai-codex");
    await expect(readFile(getSharedSecretsFilePath(dataDir), "utf8")).resolves.toContain("OPENAI_API_KEY");
    await expect(readFile(getSharedModelOverridesPath(dataDir), "utf8")).resolves.toContain('"version":1');
    await expect(readFile(getCortexAutoReviewSettingsPath(dataDir), "utf8")).resolves.toContain("enabled");
    await expect(readFile(getSharedPlaywrightDashboardSettingsPath(dataDir), "utf8")).resolves.toContain("enabled");
    await expect(readFile(getSharedMobileNotificationPreferencesPath(dataDir), "utf8")).resolves.toContain("version");
    await expect(readFile(getTerminalSettingsPath(dataDir), "utf8")).resolves.toContain("/bin/zsh");
    await expect(readFile(getGlobalSlashCommandsPath(dataDir), "utf8")).resolves.toContain("commands");
    await expect(readFile(getSharedMobileDevicesPath(dataDir), "utf8")).resolves.toContain("devices");
    await expect(readFile(join(getSharedStateDir(dataDir), BACKFILL_SENTINEL), "utf8")).resolves.toContain("done");
    await expect(readFile(join(getSharedIntegrationsDir(dataDir), "telegram.json"), "utf8")).resolves.toContain(
      "enabled"
    );

    await expect(readFile(join(sharedDir, "auth", "auth.json"), "utf8")).resolves.toContain("openai-codex");
    await expect(readFile(join(sharedDir, "secrets.json"), "utf8")).resolves.toContain("OPENAI_API_KEY");
    await expect(readFile(join(sharedDir, "integrations", "telegram.json"), "utf8")).resolves.toContain("enabled");

    await expect(access(join(getSharedStateDir(dataDir), MIGRATION_SENTINEL))).resolves.toBeUndefined();
  });

  it("is idempotent and preserves newer destination files when sentinel is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "shared-config-migration-idempotent-"));
    const dataDir = join(root, "data");
    const sharedDir = getSharedDir(dataDir);

    await writeText(join(sharedDir, "secrets.json"), '{"OPENAI_API_KEY":"legacy"}\n');
    await writeText(getSharedSecretsFilePath(dataDir), '{"OPENAI_API_KEY":"canonical"}\n');
    await writeText(join(sharedDir, "integrations", "telegram.json"), '{"enabled":true,"source":"legacy"}\n');
    await writeText(join(getSharedIntegrationsDir(dataDir), "telegram.json"), '{"enabled":false,"source":"canonical"}\n');

    await migrateSharedConfigLayout(dataDir);

    await expect(readFile(getSharedSecretsFilePath(dataDir), "utf8")).resolves.toContain("canonical");
    await expect(readFile(join(getSharedIntegrationsDir(dataDir), "telegram.json"), "utf8")).resolves.toContain(
      "canonical"
    );
    await expect(access(join(getSharedStateDir(dataDir), MIGRATION_SENTINEL))).resolves.toBeUndefined();
  });

  it("writes the sentinel on a fresh install with nothing to migrate", async () => {
    const root = await mkdtemp(join(tmpdir(), "shared-config-migration-fresh-"));
    const dataDir = join(root, "data");

    await migrateSharedConfigLayout(dataDir);

    await expect(access(join(getSharedStateDir(dataDir), MIGRATION_SENTINEL))).resolves.toBeUndefined();
    await expect(access(getSharedSecretsFilePath(dataDir))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(getSharedAuthFilePath(dataDir))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
