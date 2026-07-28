import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecureBrowserAccessService } from "../secure-browser-access-service.js";
import { getSecureBrowserAccessFilePath } from "../storage/data-paths.js";

describe("SecureBrowserAccessService", () => {
  it("delivers a scoped browser token once, persists only its hash, and revokes it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-secure-browser-"));
    let id = 0;
    const service = new SecureBrowserAccessService({
      dataDir,
      now: () => "2026-07-28T16:00:00.000Z",
      generateId: () => `id-${++id}`,
      generateSecret: (bytes) => `${"x".repeat(bytes)}-${id}`,
      generateVerificationCode: () => "482913",
    });

    const pairing = await service.createPairingRequest({
      deviceId: "browser-installation-1",
      deviceName: "Forge browser on macOS",
    });
    expect(pairing.verificationCode).toBe("482913");
    const duplicate = await service.createPairingRequest({
      deviceId: "browser-installation-1",
      deviceName: "Forge browser on macOS",
    });
    expect(duplicate).toEqual(pairing);
    await expect(service.getSettingsSnapshot()).resolves.toMatchObject({
      pendingRequests: [{ requestId: pairing.requestId }],
    });
    expect(
      await service.claimPairing(pairing.requestId, pairing.claimSecret),
    ).toEqual({ response: { status: "pending" } });

    await expect(service.approvePairing(pairing.requestId)).resolves.toMatchObject({
      deviceName: "Forge browser on macOS",
    });
    await expect(service.getSettingsSnapshot()).resolves.toEqual({
      pendingRequests: [],
      devices: [],
    });
    const claimed = await service.claimPairing(
      pairing.requestId,
      pairing.claimSecret,
    );
    expect(claimed?.response).toMatchObject({
      status: "approved",
      scopes: [
        "secure-sessions:control",
        "secure-secrets:write",
        "private-entry:write",
      ],
    });
    if (
      !claimed
      || claimed.response.status !== "approved"
      || !claimed.accessToken
    ) {
      throw new Error("Expected approved browser pairing");
    }
    expect(
      await service.claimPairing(pairing.requestId, pairing.claimSecret),
    ).toBeNull();
    await expect(service.authenticateToken(claimed.accessToken)).resolves.toMatchObject({
      ok: true,
      device: { deviceId: "browser-installation-1" },
    });

    const persisted = await readFile(
      getSecureBrowserAccessFilePath(dataDir),
      "utf8",
    );
    expect(persisted).not.toContain(claimed.accessToken);
    expect(persisted).not.toContain(pairing.claimSecret);

    await service.revokeDevice(claimed.response.device.id);
    await expect(service.authenticateToken(claimed.accessToken)).resolves.toEqual({
      ok: false,
    });
  });

  it("expires and denies pending pairings without issuing credentials", async () => {
    let now = "2026-07-28T16:00:00.000Z";
    const dataDir = await mkdtemp(join(tmpdir(), "forge-secure-browser-negative-"));
    let id = 0;
    const service = new SecureBrowserAccessService({
      dataDir,
      now: () => now,
      generateId: () => `id-${++id}`,
      generateSecret: () => `claim-${id}`,
      generateVerificationCode: () => "123456",
    });

    const expired = await service.createPairingRequest({
      deviceId: "expired",
      deviceName: "Expired",
    });
    now = "2026-07-28T16:11:00.000Z";
    expect(
      await service.claimPairing(expired.requestId, expired.claimSecret),
    ).toBeNull();

    now = "2026-07-28T16:00:00.000Z";
    const denied = await service.createPairingRequest({
      deviceId: "denied",
      deviceName: "Denied",
    });
    expect(service.denyPairing(denied.requestId)).toBe(true);
    expect(
      await service.claimPairing(denied.requestId, denied.claimSecret),
    ).toEqual({ response: { status: "denied" } });
    expect(
      await service.claimPairing(denied.requestId, denied.claimSecret),
    ).toBeNull();
    await expect(service.authenticateToken(undefined)).resolves.toEqual({
      ok: false,
    });
    await expect(service.authenticateToken("not-a-token")).resolves.toEqual({
      ok: false,
    });
  });

  it("replaces an existing browser installation token and survives restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-secure-browser-restart-"));
    let id = 0;
    const options = {
      dataDir,
      now: () => "2026-07-28T16:00:00.000Z",
      generateId: () => `id-${++id}`,
      generateSecret: (bytes: number) => `${"y".repeat(bytes)}-${id}`,
      generateVerificationCode: () => "482913",
    };
    const service = new SecureBrowserAccessService(options);

    const first = await service.createPairingRequest({
      deviceId: "browser-1",
      deviceName: "Browser",
    });
    await service.approvePairing(first.requestId);
    const firstClaim = await service.claimPairing(first.requestId, first.claimSecret);
    const second = await service.createPairingRequest({
      deviceId: "browser-1",
      deviceName: "Browser renamed",
    });
    await service.approvePairing(second.requestId);
    const secondClaim = await service.claimPairing(second.requestId, second.claimSecret);
    if (!firstClaim?.accessToken || !secondClaim?.accessToken) {
      throw new Error("Expected both browser tokens");
    }

    await expect(service.authenticateToken(firstClaim.accessToken)).resolves.toEqual({
      ok: false,
    });
    const restarted = new SecureBrowserAccessService(options);
    await expect(
      restarted.authenticateToken(secondClaim.accessToken),
    ).resolves.toMatchObject({
      ok: true,
      device: { deviceName: "Browser renamed" },
    });
  });
});
