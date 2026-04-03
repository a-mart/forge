import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SHARED_INTEGRATION_MANAGER_ID } from "../integrations/shared-config.js";
import { getSharedTelegramConfigPath, loadTelegramConfig } from "../integrations/telegram/telegram-config.js";

describe("telegram-config shared migration fallback", () => {
  it("reads shared integration config from the legacy flat-root storage when canonical config is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "telegram-config-upgrade-"));
    const dataDir = join(root, "data");
    const legacySharedTelegramPath = join(dataDir, "integrations", "shared", "telegram.json");
    const canonicalTelegramPath = getSharedTelegramConfigPath(dataDir);

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

    await expect(access(canonicalTelegramPath)).rejects.toMatchObject({ code: "ENOENT" });

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
