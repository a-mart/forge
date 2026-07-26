import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StreamDeckAccessService } from "../stream-deck-access-service.js";
import { getStreamDeckAccessFilePath } from "../storage/data-paths.js";

describe("StreamDeckAccessService", () => {
  it("delivers a scoped device token exactly once, persists only its hash, and supports revocation", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-stream-deck-access-"));
    let id = 0;
    const service = new StreamDeckAccessService({
      dataDir,
      now: () => "2026-07-25T16:00:00.000Z",
      generateId: () => `id-${++id}`,
      generateSecret: (bytes) => `secret-${bytes}-${id}`,
      generateVerificationCode: () => "482913",
    });

    const request = await service.createPairingRequest({
      deviceId: "deck-hardware-1",
      deviceName: "Studio XL",
      pluginVersion: "0.2.0.0",
    });
    expect(request.verificationCode).toBe("482913");
    expect(service.claimPairing(request.requestId, request.claimSecret)).toEqual({ status: "pending" });

    await expect(service.approvePairing(request.requestId)).resolves.toMatchObject({
      deviceName: "Studio XL",
    });
    const approved = service.claimPairing(request.requestId, request.claimSecret);
    expect(approved).toMatchObject({
      status: "approved",
      scopes: ["snapshot:read", "actions:write"],
    });
    if (approved?.status !== "approved") throw new Error("Expected approved pairing");
    expect(service.claimPairing(request.requestId, request.claimSecret)).toBeNull();
    await expect(service.authenticateAuthorizationHeader(`Bearer ${approved.accessToken}`)).resolves.toMatchObject({ ok: true });

    const persisted = await readFile(getStreamDeckAccessFilePath(dataDir), "utf8");
    expect(persisted).not.toContain(approved.accessToken);
    expect(persisted).not.toContain(request.claimSecret);

    await service.revokeDevice(approved.device.id);
    await expect(service.authenticateAuthorizationHeader(`Bearer ${approved.accessToken}`)).resolves.toMatchObject({
      ok: false,
      statusCode: 403,
      code: "revoked_token",
    });
  });
});
