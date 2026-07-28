import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it("denies malformed authorization and expires or denies pending claims", async () => {
    let now = "2026-07-25T16:00:00.000Z";
    const dataDir = await mkdtemp(join(tmpdir(), "forge-stream-deck-negative-"));
    const service = new StreamDeckAccessService({ dataDir, now: () => now, generateId: () => "id", generateSecret: () => "secret", generateVerificationCode: () => "123456" });
    const expired = await service.createPairingRequest({ deviceId: "expired", deviceName: "Expired", pluginVersion: "1" });
    now = "2026-07-25T16:11:00.000Z";
    expect(service.claimPairing(expired.requestId, expired.claimSecret)).toBeNull();

    now = "2026-07-25T16:00:00.000Z";
    const denied = await service.createPairingRequest({ deviceId: "denied", deviceName: "Denied", pluginVersion: "1" });
    expect(service.denyPairing(denied.requestId)).toBe(true);
    expect(service.claimPairing(denied.requestId, denied.claimSecret)).toEqual({ status: "denied" });
    expect(service.claimPairing(denied.requestId, denied.claimSecret)).toBeNull();

    await expect(service.authenticateAuthorizationHeader(undefined)).resolves.toMatchObject({ statusCode: 401, code: "missing_authorization" });
    await expect(service.authenticateAuthorizationHeader(["Bearer one", "Bearer two"])).resolves.toMatchObject({ statusCode: 401, code: "malformed_authorization" });
    await expect(service.authenticateAuthorizationHeader("Basic abc")).resolves.toMatchObject({ statusCode: 401, code: "malformed_authorization" });
    await expect(service.authenticateAuthorizationHeader("Bearer")).resolves.toMatchObject({ statusCode: 401, code: "malformed_authorization" });
    await expect(service.authenticateAuthorizationHeader("Bearer unknown")).resolves.toMatchObject({ statusCode: 401, code: "invalid_token" });
  });

  it("replaces a duplicate device token, survives restart, and ignores malformed persisted rows", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-stream-deck-restart-"));
    let id = 0;
    const options = { dataDir, now: () => "2026-07-25T16:00:00.000Z", generateId: () => `id-${++id}`, generateSecret: (bytes: number) => `secret-${bytes}-${id}`, generateVerificationCode: () => "482913" };
    const first = new StreamDeckAccessService(options);
    const pairOne = await first.createPairingRequest({ deviceId: "deck-1", deviceName: "Deck", pluginVersion: "1" });
    const claimOne = (await first.approvePairing(pairOne.requestId))!;
    const tokenOne = first.claimPairing(pairOne.requestId, pairOne.claimSecret)!;
    const pairTwo = await first.createPairingRequest({ deviceId: "deck-1", deviceName: "Deck", pluginVersion: "2" });
    await first.approvePairing(pairTwo.requestId);
    const tokenTwo = first.claimPairing(pairTwo.requestId, pairTwo.claimSecret)!;
    expect(tokenOne.status).toBe("approved");
    expect(tokenTwo.status).toBe("approved");
    if (tokenOne.status !== "approved" || tokenTwo.status !== "approved") throw new Error("expected approved claims");
    await expect(first.authenticateAuthorizationHeader(`Bearer ${tokenOne.accessToken}`)).resolves.toMatchObject({ ok: false, code: "revoked_token" });

    const restarted = new StreamDeckAccessService(options);
    await expect(restarted.authenticateAuthorizationHeader(`Bearer ${tokenTwo.accessToken}`)).resolves.toMatchObject({ ok: true, deviceId: tokenTwo.device.id });
    await Promise.all([
      restarted.authenticateAuthorizationHeader(`Bearer ${tokenTwo.accessToken}`),
      restarted.revokeDevice(tokenTwo.device.id),
      restarted.getSettingsSnapshot(),
    ]);
    await expect(restarted.authenticateAuthorizationHeader(`Bearer ${tokenTwo.accessToken}`)).resolves.toMatchObject({ ok: false, code: "revoked_token" });

    await writeFile(getStreamDeckAccessFilePath(dataDir), JSON.stringify({ version: 1, devices: [{ nope: true }, { ...claimOne.device, tokenHash: "bad" }] }), "utf8");
    await expect(restarted.authenticateAuthorizationHeader(`Bearer ${tokenTwo.accessToken}`)).resolves.toMatchObject({ ok: false, code: "invalid_token" });
    await expect(restarted.getSettingsSnapshot()).resolves.toMatchObject({ devices: [] });
  });
});
