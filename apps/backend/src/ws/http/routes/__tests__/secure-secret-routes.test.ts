import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  SecureSecretProviderSummary,
  SecureSecretProjectDefaultSummary,
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

const projectDefault: SecureSecretProjectDefaultSummary = {
  profileId: "profile-1",
  secretId: "secret-1",
  createdAt: "2026-07-23T00:00:00.000Z",
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
    listSecureSecretProjectDefaults: vi.fn(() => [projectDefault]),
    setSecureSecretProjectDefault: vi.fn(async (_secretId, input) =>
      input.enabled ? projectDefault : null
    ),
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
      scope: { kind: "profile", profileId: "profile-1" },
      retention: "saved",
    });
    expect(created.status).toBe(201);
    expect(service.createLocalSecureSecret).toHaveBeenCalledWith({
      displayAlias: "DEPLOY_TOKEN",
      encryptedMaterial: materialCiphertext,
      bindings: [{ deliveryKind: "environment", targetName: "DEPLOY_TOKEN" }],
      scope: { kind: "profile", profileId: "profile-1" },
      retention: "saved",
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
        scope: { kind: "profile", profileId: "profile-1" },
        retention: "saved",
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
        scope: { kind: "profile", profileId: "profile-1" },
        retention: "saved",
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

  it("lists and strictly toggles project defaults", async () => {
    const service = fakeService();
    const server = await createRouteServer(createSecureSecretRoutes({ service }));

    const listedAll = await fetch(
      `${server.baseUrl}/api/secure-secrets/project-defaults`,
    );
    const listed = await fetch(
      `${server.baseUrl}/api/secure-secrets/project-defaults/profile-1`,
    );
    const enabled = await putJson(
      `${server.baseUrl}/api/secure-secrets/project-defaults/profile-1/secret-1`,
      { enabled: true },
    );
    const disabled = await putJson(
      `${server.baseUrl}/api/secure-secrets/project-defaults/profile-1/secret-1`,
      { enabled: false },
    );
    const unexpected = await putJson(
      `${server.baseUrl}/api/secure-secrets/project-defaults/profile-1/secret-1`,
      { enabled: true, plaintext: "forbidden" },
    );
    const invalid = await putJson(
      `${server.baseUrl}/api/secure-secrets/project-defaults/profile-1/secret-1`,
      { enabled: "true" },
    );

    expect(listedAll.status).toBe(200);
    expect(await listedAll.json()).toEqual([projectDefault]);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([projectDefault]);
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toEqual(projectDefault);
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toBeNull();
    expect(unexpected.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(service.listSecureSecretProjectDefaults).toHaveBeenNthCalledWith(1);
    expect(service.listSecureSecretProjectDefaults).toHaveBeenNthCalledWith(
      2,
      "profile-1",
    );
    expect(service.setSecureSecretProjectDefault).toHaveBeenNthCalledWith(
      1,
      "secret-1",
      { profileId: "profile-1", enabled: true },
    );
    expect(service.setSecureSecretProjectDefault).toHaveBeenNthCalledWith(
      2,
      "secret-1",
      { profileId: "profile-1", enabled: false },
    );
    expect(service.setSecureSecretProjectDefault).toHaveBeenCalledTimes(2);
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
    const invalidScope = await postJson(
      `${server.baseUrl}/api/secure-secrets/providers/provider-1/secrets`,
      {
        sourceLocator: "bws-secret-uuid",
        displayAlias: "TOKEN",
        scope: { kind: "profile", profileId: "" },
      },
    );

    for (const response of [plaintext, rawToken, malformed, invalidScope]) {
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
    vi.mocked(service.createLocalSecureSecret).mockRejectedValue(
      Object.assign(new Error(canary), { code: "SECURE_SECRET_ALIAS_CONFLICT" }),
    );
    vi.mocked(service.setSecureSecretProjectDefault).mockRejectedValue(
      Object.assign(new Error(canary), {
        code: "SECURE_PROJECT_DEFAULT_LIMIT_REACHED",
      }),
    );
    const server = await createRouteServer(createSecureSecretRoutes({ service }));

    const generic = await fetch(`${server.baseUrl}/api/secure-secrets`);
    const auth = await postJson(
      `${server.baseUrl}/api/secure-secrets/providers/provider-1/test`,
      {},
    );
    const aliasConflict = await postJson(
      `${server.baseUrl}/api/secure-secrets/local`,
      {
        displayAlias: "DUPLICATE",
        encryptedMaterial: Buffer.from("ciphertext").toString("base64"),
      },
    );
    const defaultLimit = await putJson(
      `${server.baseUrl}/api/secure-secrets/project-defaults/profile-1/secret-1`,
      { enabled: true },
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
    expect(aliasConflict.status).toBe(409);
    expect(await aliasConflict.json()).toEqual({
      code: "SECURE_SECRET_ALIAS_CONFLICT",
      error: "SECURE_SECRET_ALIAS_CONFLICT",
    });
    expect(defaultLimit.status).toBe(409);
    expect(await defaultLimit.json()).toEqual({
      code: "SECURE_PROJECT_DEFAULT_LIMIT_REACHED",
      error: "SECURE_PROJECT_DEFAULT_LIMIT_REACHED",
    });
    expect(
      JSON.stringify([generic, auth, aliasConflict, defaultLimit]),
    ).not.toContain(canary);
  });
});

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function putJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "PUT",
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
