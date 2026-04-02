import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SHARED_INTEGRATION_MANAGER_ID } from "../integrations/shared-config.js";
import { getSharedTelegramConfigPath, loadTelegramConfig } from "../integrations/telegram/telegram-config.js";
import { migrateDataDirectory } from "../swarm/data-migration.js";
import { migrateSharedConfigLayout } from "../swarm/shared-config-migration.js";

describe("telegram-config shared migration fallback", () => {
  it("reads shared integration config from old shared-flat storage after a direct legacy-flat upgrade path", async () => {
    const root = await mkdtemp(join(tmpdir(), "telegram-config-upgrade-"));
    const dataDir = join(root, "data");
    const agentsStoreFile = join(dataDir, "swarm", "agents.json");
    const legacySharedTelegramPath = join(dataDir, "integrations", "shared", "telegram.json");
    const oldSharedTelegramPath = join(dataDir, "shared", "integrations", "telegram.json");
    const canonicalTelegramPath = getSharedTelegramConfigPath(dataDir);

    await writeJson(agentsStoreFile, { agents: [], profiles: [] });
    await writeJson(legacySharedTelegramPath, {
      profileId: "telegram:__shared__",
      enabled: true,
      mode: "polling",
      botToken: "123456:legacy-shared-token",
      allowedUserIds: ["123"],
      polling: {
        timeoutSeconds: 25,
        limit: 100,
        dropPendingUpdatesOnStart: true,
      },
      delivery: {
        parseMode: "HTML",
        disableLinkPreview: true,
        replyToInboundMessageByDefault: false,
      },
      attachments: {
        maxFileBytes: 10 * 1024 * 1024,
        allowImages: true,
        allowText: true,
        allowBinary: false,
      },
    });

    await migrateSharedConfigLayout(dataDir);
    await migrateDataDirectory({ dataDir, agentsStoreFile }, [], []);

    await expect(access(canonicalTelegramPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(oldSharedTelegramPath, "utf8")).resolves.toContain("legacy-shared-token");

    const loaded = await loadTelegramConfig({
      dataDir,
      managerId: SHARED_INTEGRATION_MANAGER_ID,
    });

    expect(loaded.enabled).toBe(true);
    expect(loaded.botToken).toBe("123456:legacy-shared-token");
    expect(loaded.allowedUserIds).toEqual(["123"]);
  });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
