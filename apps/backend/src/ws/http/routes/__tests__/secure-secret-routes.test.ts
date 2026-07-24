import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  SecureSecretProviderSummary,
  SecureSecretSummary,
} from "@forge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpRoute } from "../../shared/http-route.js";
import {
  createSecureSecretRoutes,
  type SecureSecretTransportService,
} from "../secure-secret-routes.js";

const activeServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

const provider: SecureSecretProviderSummary = {
  providerId: "provider-1",
  kind: "bitwarden_secrets_manager",
  displayName: "Bitwarden",
  enabled: true,
  status: "available",
  lastVerifiedAt: "2026-07-23T00:00:00.000Z",
  lastStatusCode: "ok",
};

const secret: SecureSecretSummary = {
  secretId: "secret-1",
  providerId: "provider-1",
  displayAlias: "DEPLOY_TOKEN",
  displayName: "Deploy token",
  scope: { kind: "instance" },
  retention: "saved",
  bindings: [{ deliveryKind: "environment", targetName: "DEPLOY_TOKEN" }],
  available: true,
  updatedAt: "2026-07-23T00:00:00.000Z",
};

function fakeService(): SecureSecretTransportService {
  return {
    listSecureSecretProviders: vi.fn(() => [provider]),
    connectBitwardenSecureSecretProvider: vi.fn(async () => provider),
    testSecureSecretProvider: vi.fn(async () => provider),
    deleteSecureSecretProvider: vi.fn(async () => undefined),
    importBitwardenSecureSecret: vi.fn(async () => secret),
    listSecureSecrets: vi.fn(() => [secret]),
    createLocalSecureSecret: vi.fn(async () => secret),
    updateSecureSecret: vi.fn(async () => secret),
    deleteSecureSecret: vi.fn(async () => undefined),
  };
}

describe("secure secret routes", () => {
  it("serves metadata and forwards only encrypted local and Bitwarden inputs", async () => {
    const service = fakeService();
    const server = await createRouteServer(createSecureSecretRoutes({ service }));

    const providers = await fetch(`${server.baseUrl}/api/secure-secrets/providers`);
    expect(providers.status).toBe(200);
    expect(await providers.json()).toEqual([provider]);

    const tokenCiphertext = Buffer.from("ciphertext-token").toString("base64");
    const connected = await postJson(
      `${server.baseUrl}/api/secure-secrets/providers/bitwarden`,
      {
        displayName: "Bitwarden",
        serverOrigin: "https://vault.example.test",
        encryptedAccessToken: tokenCiphertext,
      },
    );
    expect(connected.status).toBe(200);
    expect(service.connectBitwardenSecureSecretProvider).toHaveBeenCalledWith({
      displayName: "Bitwarden",
      serverOrigin: "https://vault.example.test",
      encryptedAccessToken: tokenCiphertext,
    });

    const materialCiphertext = Buffer.from("ciphertext-material").toString("base64");
    const created = await postJson(`${server.baseUrl}/api/secure-secrets/local`, {
      displayAlias: "DEPLOY_TOKEN",
      encryptedMaterial: materialCiphertext,
      bindings: [{ deliveryKind: "environment", targetName: "DEPLOY_TOKEN" }],
    });
    expect(created.status).toBe(201);
    expect(service.createLocalSecureSecret).toHaveBeenCalledWith({
      displayAlias: "DEPLOY_TOKEN",
      encryptedMaterial: materialCiphertext,
      bindings: [{ deliveryKind: "environment", targetName: "DEPLOY_TOKEN" }],
    });

    for (const response of [providers, connected, created]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("imports a Bitwarden secret reference without returning the provider locator", async () => {
    const service = fakeService();
    const server = await createRouteServer(createSecureSecretRoutes({ service }));

    const response = await postJson(
      `${server.baseUrl}/api/secure-secrets/providers/provider-1/secrets`,
      {
        sourceLocator: "bws-secret-uuid",
        displayAlias: "DATABASE_PASSWORD",
        displayName: "Production database",
        bindings: [{ deliveryKind: "stdin" }],
      },
    );

    expect(response.status).toBe(201);
    expect(service.importBitwardenSecureSecret).toHaveBeenCalledWith(
      "provider-1",
      {
        sourceLocator: "bws-secret-uuid",
        displayAlias: "DATABASE_PASSWORD",
        displayName: "Production database",
        bindings: [{ deliveryKind: "stdin" }],
      },
    );
    expect(JSON.stringify(await response.json())).not.toContain("bws-secret-uuid");
  });

  it("supports provider tests and catalog mutations with no-store responses", async () => {
    const service = fakeService();
    const server = await createRouteServer(createSecureSecretRoutes({ service }));

    const tested = await postJson(
      `${server.baseUrl}/api/secure-secrets/providers/provider-1/test`,
      {},
    );
    const updated = await fetch(`${server.baseUrl}/api/secure-secrets/secret-1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayAlias: "NEW_ALIAS" }),
    });
    const deleted = await fetch(`${server.baseUrl}/api/secure-secrets/secret-1`, {
      method: "DELETE",
    });

    expect(tested.status).toBe(200);
    expect(updated.status).toBe(200);
    expect(deleted.status).toBe(204);
    expect(service.testSecureSecretProvider).toHaveBeenCalledWith("provider-1");
    expect(service.updateSecureSecret).toHaveBeenCalledWith("secret-1", {
      displayAlias: "NEW_ALIAS",
    });
    expect(service.deleteSecureSecret).toHaveBeenCalledWith("secret-1");
    expect(deleted.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects plaintext and malformed bodies before invoking the service", async () => {
    const service = fakeService();
    const server = await createRouteServer(createSecureSecretRoutes({ service }));
    const canary = "PLAINTEXT-CANARY-DO-NOT-RETURN";

    const plaintext = await postJson(`${server.baseUrl}/api/secure-secrets/local`, {
      displayAlias: "TOKEN",
      material: canary,
    });
    const rawToken = await postJson(
      `${server.baseUrl}/api/secure-secrets/providers/bitwarden`,
      {
        displayName: "Bitwarden",
        serverOrigin: "https://vault.example.test",
        accessToken: canary,
      },
    );
    const malformed = await fetch(`${server.baseUrl}/api/secure-secrets/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    for (const response of [plaintext, rawToken, malformed]) {
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("SECURE_REQUEST_INVALID");
      expect(body).not.toContain(canary);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(service.createLocalSecureSecret).not.toHaveBeenCalled();
    expect(service.connectBitwardenSecureSecretProvider).not.toHaveBeenCalled();
  });

  it("maps internal and provider failures to fixed public codes without raw messages", async () => {
    const service = fakeService();
    const canary = "RAW-PROVIDER-FAILURE-CANARY";
    vi.mocked(service.listSecureSecrets).mockImplementation(() => {
      throw new Error(canary);
    });
    vi.mocked(service.testSecureSecretProvider).mockRejectedValue(
      Object.assign(new Error(canary), { code: "SECURE_SOURCE_AUTH_REQUIRED" }),
    );
    const server = await createRouteServer(createSecureSecretRoutes({ service }));

    const generic = await fetch(`${server.baseUrl}/api/secure-secrets`);
    const auth = await postJson(
      `${server.baseUrl}/api/secure-secrets/providers/provider-1/test`,
      {},
    );

    expect(generic.status).toBe(500);
    expect(await generic.json()).toEqual({
      code: "SECURE_OPERATION_FAILED",
      error: "SECURE_OPERATION_FAILED",
    });
    expect(auth.status).toBe(401);
    expect(await auth.json()).toEqual({
      code: "SECURE_PROVIDER_AUTH_REQUIRED",
      error: "SECURE_PROVIDER_AUTH_REQUIRED",
    });
    expect(JSON.stringify([generic, auth])).not.toContain(canary);
  });
});

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
