import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecureBrowserAccessService } from "../../../../swarm/secure-browser-access-service.js";
import type { HttpRoute } from "../../shared/http-route.js";
import {
  createSecureBrowserControlRoutes,
  type SecureBrowserVaultService,
} from "../secure-browser-control-routes.js";

const activeServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

function fakeVault(): SecureBrowserVaultService {
  return {
    isSecurePrivateEntryAvailable: vi.fn(async () => true),
    createRemotePrivateEntryChallenge: vi.fn(async () => ({
      challengeId: "d3e39ee9-3dd2-46c6-b820-ae041d4bb088",
      keyId: "remote-entry-key-id",
      publicKey: Buffer.alloc(65, 7).toString("base64"),
      expiresAt: "2026-07-28T16:02:00.000Z",
    })),
    encryptRemotePrivateEntry: vi.fn(async () =>
      Buffer.from("desktop-ciphertext").toString("base64")
    ),
  };
}

describe("secure browser control routes", () => {
  it("pairs a loopback browser, sets a protected cookie, and exposes no token in JSON", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-browser-routes-"));
    const service = new SecureBrowserAccessService({
      dataDir,
      generateVerificationCode: () => "482913",
    });
    const vault = fakeVault();
    const server = await createRouteServer(createSecureBrowserControlRoutes({
      accessService: service,
      vaultService: vault,
      secureControlAvailable: true,
    }));

    const created = await postJson(
      `${server.baseUrl}/api/secure-browser-control/pairing/requests`,
      {
        deviceId: "browser-installation-1",
        deviceName: "Forge browser",
      },
      { origin: server.baseUrl },
    );
    expect(created.status).toBe(201);
    const pairing = await created.json() as {
      requestId: string;
      claimSecret: string;
      verificationCode: string;
    };
    expect(pairing.verificationCode).toBe("482913");

    await service.approvePairing(pairing.requestId);
    const claimed = await postJson(
      `${server.baseUrl}/api/secure-browser-control/pairing/requests/${encodeURIComponent(pairing.requestId)}/claim`,
      { claimSecret: pairing.claimSecret },
      { origin: server.baseUrl },
    );
    expect(claimed.status).toBe(200);
    const claimBody = await claimed.text();
    expect(claimBody).toContain('"status":"approved"');
    expect(claimBody).not.toContain("forge_secure_browser_");
    const cookie = claimed.headers.get("set-cookie");
    expect(cookie).toContain("forge_secure_browser=forge_secure_browser_");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure");

    const status = await fetch(
      `${server.baseUrl}/api/secure-browser-control/status`,
      {
        headers: {
          cookie: cookie?.split(";")[0] ?? "",
          origin: server.baseUrl,
        },
      },
    );
    expect(await status.json()).toMatchObject({
      available: true,
      authorized: true,
      privateEntryAvailable: true,
      secureContextRequired: false,
      device: { deviceName: "Forge browser" },
    });
  });

  it("requires a paired browser for private entry and relays only sealed material", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-browser-private-entry-"));
    const service = new SecureBrowserAccessService({ dataDir });
    const vault = fakeVault();
    const server = await createRouteServer(createSecureBrowserControlRoutes({
      accessService: service,
      vaultService: vault,
      secureControlAvailable: true,
    }));
    const unauthorized = await postJson(
      `${server.baseUrl}/api/secure-browser-control/private-entry/challenge`,
      {},
      { origin: server.baseUrl },
    );
    expect(unauthorized.status).toBe(403);

    const pairing = await service.createPairingRequest({
      deviceId: "browser-1",
      deviceName: "Paired browser",
    });
    await service.approvePairing(pairing.requestId);
    const claimed = await service.claimPairing(
      pairing.requestId,
      pairing.claimSecret,
    );
    if (!claimed?.accessToken || claimed.response.status !== "approved") {
      throw new Error("Expected approved browser");
    }
    const cookie = `forge_secure_browser=${claimed.accessToken}`;
    const challenge = await postJson(
      `${server.baseUrl}/api/secure-browser-control/private-entry/challenge`,
      {},
      { origin: server.baseUrl, cookie },
    );
    expect(challenge.status).toBe(200);
    expect(vault.createRemotePrivateEntryChallenge).toHaveBeenCalledWith(
      claimed.response.device.id,
    );

    const sealed = {
      challengeId: "d3e39ee9-3dd2-46c6-b820-ae041d4bb088",
      keyId: "remote-entry-key-id",
      ephemeralPublicKey: Buffer.alloc(65, 8).toString("base64"),
      iv: Buffer.alloc(12, 9).toString("base64"),
      ciphertext: Buffer.from("ciphertext-and-tag").toString("base64"),
    };
    const encrypted = await postJson(
      `${server.baseUrl}/api/secure-browser-control/private-entry/encrypt`,
      sealed,
      { origin: server.baseUrl, cookie },
    );
    expect(encrypted.status).toBe(200);
    expect(await encrypted.json()).toEqual({
      encryptedMaterial: Buffer.from("desktop-ciphertext").toString("base64"),
    });
    expect(vault.encryptRemotePrivateEntry).toHaveBeenCalledWith(
      claimed.response.device.id,
      sealed,
    );
  });

  it("fails closed when Desktop control or a secure browser context is unavailable", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-browser-unavailable-"));
    const service = new SecureBrowserAccessService({ dataDir });
    const server = await createRouteServer(createSecureBrowserControlRoutes({
      accessService: service,
      vaultService: fakeVault(),
      secureControlAvailable: false,
    }));
    const unavailable = await postJson(
      `${server.baseUrl}/api/secure-browser-control/pairing/requests`,
      { deviceId: "browser-1", deviceName: "Browser" },
      { origin: server.baseUrl },
    );
    expect(unavailable.status).toBe(503);

    const status = await fetch(
      `${server.baseUrl}/api/secure-browser-control/status`,
      { headers: { origin: "http://remote.example" } },
    );
    expect(await status.json()).toMatchObject({
      available: false,
      authorized: false,
      privateEntryAvailable: false,
      secureContextRequired: true,
    });
  });
});

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function createRouteServer(
  routes: HttpRoute[],
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const httpServer = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const route = routes.find((candidate) =>
        candidate.matches(requestUrl.pathname)
      );
      if (!route) {
        response.statusCode = 404;
        response.end();
        return;
      }
      void route.handle(request, response, requestUrl);
    },
  );
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve)
  );
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing test server address");
  }
  const result = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((error) => error ? reject(error) : resolve())
      ),
  };
  activeServers.push(result);
  return result;
}
