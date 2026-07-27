import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { SecureSessionSnapshot } from "@forge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpRoute } from "../../shared/http-route.js";
import {
  createSecureSessionRoutes,
  type SecureSessionsTransportService,
} from "../secure-session-routes.js";

const activeServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

const snapshot: SecureSessionSnapshot = {
  sessionAgentId: "manager-1",
  profileId: "profile-1",
  revision: 4,
  executionMode: "secure",
  environmentStatus: "ready",
  leases: [],
  pendingRequests: [],
  updatedAt: "2026-07-23T00:00:00.000Z",
};

function fakeService(): SecureSessionsTransportService {
  return {
    getSecureSessionReadiness: vi.fn(() => ({
      available: true,
      code: "available",
    })),
    getSecureSessionSnapshot: vi.fn(() => snapshot),
    startSecureSession: vi.fn(async () => snapshot),
    stopSecureSession: vi.fn(async () => snapshot),
    applySecureSessionProjectDefaults: vi.fn(async () => snapshot),
    grantSecureSessionLease: vi.fn(async () => snapshot),
    grantSecureSessionLeases: vi.fn(async () => snapshot),
    revokeSecureSessionLease: vi.fn(async () => snapshot),
    resolveSecureAccessRequest: vi.fn(async () => snapshot),
    fulfillSecureAccessRequest: vi.fn(async () => snapshot),
  };
}

describe("secure session routes", () => {
  it("serves only fixed readiness metadata before the session-id route", async () => {
    const service = fakeService();
    const server = await createRouteServer(createSecureSessionRoutes({ service }));

    const response = await fetch(`${server.baseUrl}/api/secure-sessions/readiness`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: true,
      code: "available",
    });
    expect(service.getSecureSessionReadiness).toHaveBeenCalledOnce();
    expect(service.getSecureSessionSnapshot).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("gets, starts, and explicitly stops a secure session", async () => {
    const service = fakeService();
    const server = await createRouteServer(createSecureSessionRoutes({ service }));

    const current = await fetch(`${server.baseUrl}/api/secure-sessions/manager-1`);
    const started = await postJson(
      `${server.baseUrl}/api/secure-sessions/manager-1/start`,
      { baseRevision: 3 },
    );
    const stopped = await postJson(
      `${server.baseUrl}/api/secure-sessions/manager-1/stop`,
      { baseRevision: 4, stopProcesses: true },
    );

    expect(current.status).toBe(200);
    expect(started.status).toBe(200);
    expect(stopped.status).toBe(200);
    expect(await current.json()).toEqual(snapshot);
    expect(service.getSecureSessionSnapshot).toHaveBeenCalledWith("manager-1");
    expect(service.startSecureSession).toHaveBeenCalledWith("manager-1", {
      baseRevision: 3,
    });
    expect(service.stopSecureSession).toHaveBeenCalledWith("manager-1", {
      baseRevision: 4,
      stopProcesses: true,
    });
    for (const response of [current, started, stopped]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("forwards strict lease, revoke, and access-resolution contracts", async () => {
    const service = fakeService();
    const server = await createRouteServer(createSecureSessionRoutes({ service }));
    const exposure = { deliveryKind: "environment", targetName: "TOKEN" } as const;

    const granted = await postJson(
      `${server.baseUrl}/api/secure-sessions/manager-1/leases`,
      {
        baseRevision: 4,
        secretId: "secret-1",
        exposures: [exposure],
        leaseKind: "timed",
        durationSeconds: 600,
      },
    );
    const revoked = await fetch(
      `${server.baseUrl}/api/secure-sessions/manager-1/leases/lease-1`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 5 }),
      },
    );
    const resolved = await postJson(
      `${server.baseUrl}/api/secure-sessions/manager-1/access-requests/request-1/resolve`,
      {
        baseRevision: 6,
        decision: "approve",
        selectedSecretId: "secret-1",
      },
    );

    expect(granted.status).toBe(200);
    expect(revoked.status).toBe(200);
    expect(resolved.status).toBe(200);
    expect(service.grantSecureSessionLease).toHaveBeenCalledWith("manager-1", {
      baseRevision: 4,
      secretId: "secret-1",
      exposures: [exposure],
      leaseKind: "timed",
      durationSeconds: 600,
    });
    expect(service.revokeSecureSessionLease).toHaveBeenCalledWith("manager-1", {
      baseRevision: 5,
      leaseId: "lease-1",
    });
    expect(service.resolveSecureAccessRequest).toHaveBeenCalledWith(
      "manager-1",
      "request-1",
      {
        baseRevision: 6,
        requestId: "request-1",
        decision: "approve",
        selectedSecretId: "secret-1",
      },
    );
  });

  it("dismisses an access request through a denial-only DELETE contract", async () => {
    const service = fakeService();
    const server = await createRouteServer(createSecureSessionRoutes({ service }));
    const endpoint =
      `${server.baseUrl}/api/secure-sessions/manager-1/access-requests/request-1`;

    const dismissed = await fetch(endpoint, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 6 }),
    });

    expect(dismissed.status).toBe(200);
    expect(service.resolveSecureAccessRequest).toHaveBeenCalledWith(
      "manager-1",
      "request-1",
      {
        baseRevision: 6,
        requestId: "request-1",
        decision: "deny",
      },
    );

    const unsafe = await fetch(endpoint, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: 6,
        decision: "approve",
      }),
    });
    expect(unsafe.status).toBe(400);
    expect(service.resolveSecureAccessRequest).toHaveBeenCalledTimes(1);
  });

  it("forwards one strict atomic batch grant request", async () => {
    const service = fakeService();
    const server = await createRouteServer(createSecureSessionRoutes({ service }));
    const grants = [
      {
        secretId: "secret-1",
        exposures: [{ deliveryKind: "environment", targetName: "TOKEN" }],
        leaseKind: "task",
      },
      {
        secretId: "secret-2",
        exposures: [{ deliveryKind: "ssh_agent" }],
        leaseKind: "timed",
        durationSeconds: 600,
      },
    ] as const;

    const granted = await postJson(
      `${server.baseUrl}/api/secure-sessions/manager-1/leases/batch`,
      { baseRevision: 4, grants },
    );

    expect(granted.status).toBe(200);
    expect(service.grantSecureSessionLeases).toHaveBeenCalledTimes(1);
    expect(service.grantSecureSessionLeases).toHaveBeenCalledWith("manager-1", {
      baseRevision: 4,
      grants,
    });

    for (const invalid of [
      { baseRevision: 4, grants: [] },
      {
        baseRevision: 4,
        grants: [
          {
            secretId: "duplicate",
            exposures: [{ deliveryKind: "stdin" }],
            leaseKind: "task",
          },
          {
            secretId: "duplicate",
            exposures: [{ deliveryKind: "ssh_agent" }],
            leaseKind: "one_use",
          },
        ],
      },
      {
        baseRevision: 4,
        grants: [{
          secretId: "secret-1",
          exposures: [{ deliveryKind: "stdin" }],
          leaseKind: "task",
          plaintext: "forbidden",
        }],
      },
    ]) {
      const response = await postJson(
        `${server.baseUrl}/api/secure-sessions/manager-1/leases/batch`,
        invalid,
      );
      expect(response.status).toBe(400);
    }
    expect(service.grantSecureSessionLeases).toHaveBeenCalledTimes(1);
  });

  it("strictly applies configured project defaults without accepting secret selection", async () => {
    const service = fakeService();
    const server = await createRouteServer(createSecureSessionRoutes({ service }));
    const endpoint =
      `${server.baseUrl}/api/secure-sessions/manager-1/project-defaults/apply`;

    const applied = await postJson(endpoint, { baseRevision: 4 });

    expect(applied.status).toBe(200);
    expect(service.applySecureSessionProjectDefaults).toHaveBeenCalledWith(
      "manager-1",
      { baseRevision: 4 },
    );
    expect(await applied.json()).toEqual(snapshot);

    for (const invalid of [
      {},
      { baseRevision: -1 },
      { baseRevision: 4, secretId: "forbidden" },
      { baseRevision: 4, grants: [] },
    ]) {
      const response = await postJson(endpoint, invalid);
      expect(response.status).toBe(400);
    }
    expect(service.applySecureSessionProjectDefaults).toHaveBeenCalledTimes(1);
  });

  it("fulfills an access request with ciphertext and never serializes it back", async () => {
    const service = fakeService();
    const server = await createRouteServer(createSecureSessionRoutes({ service }));
    const encryptedMaterial = Buffer.from("ciphertext-material").toString("base64");
    const response = await postJson(
      `${server.baseUrl}/api/secure-sessions/manager-1/access-requests/request-1/fulfill`,
      {
        baseRevision: 6,
        displayAlias: "ONE_OFF_PASSWORD",
        encryptedMaterial,
        leaseKind: "one_use",
        exposures: [{ deliveryKind: "stdin" }],
        retention: "session",
      },
    );

    expect(response.status).toBe(200);
    expect(service.fulfillSecureAccessRequest).toHaveBeenCalledWith(
      "manager-1",
      "request-1",
      {
        baseRevision: 6,
        displayAlias: "ONE_OFF_PASSWORD",
        encryptedMaterial,
        leaseKind: "one_use",
        exposures: [{ deliveryKind: "stdin" }],
        retention: "session",
      },
    );
    expect(JSON.stringify(await response.json())).not.toContain(encryptedMaterial);
  });

  it("strictly forwards saved project-scoped access-request fulfillment", async () => {
    const service = fakeService();
    const server = await createRouteServer(createSecureSessionRoutes({ service }));
    const encryptedMaterial = Buffer.from("ciphertext-material").toString("base64");
    const response = await postJson(
      `${server.baseUrl}/api/secure-sessions/manager-1/access-requests/request-1/fulfill`,
      {
        baseRevision: 6,
        displayAlias: "DEPLOY_PASSWORD",
        encryptedMaterial,
        leaseKind: "task",
        exposures: [{ deliveryKind: "askpass", targetName: "SSH_ASKPASS" }],
        retention: "saved",
        scope: { kind: "profile", profileId: "profile-1" },
        makeProjectDefault: true,
      },
    );

    expect(response.status).toBe(200);
    expect(service.fulfillSecureAccessRequest).toHaveBeenCalledWith(
      "manager-1",
      "request-1",
      {
        baseRevision: 6,
        displayAlias: "DEPLOY_PASSWORD",
        encryptedMaterial,
        leaseKind: "task",
        exposures: [{ deliveryKind: "askpass", targetName: "SSH_ASKPASS" }],
        retention: "saved",
        scope: { kind: "profile", profileId: "profile-1" },
        makeProjectDefault: true,
      },
    );
    expect(JSON.stringify(await response.json())).not.toContain(encryptedMaterial);
  });

  it("rejects unsafe or stale mutations with fixed codes and no raw failures", async () => {
    const service = fakeService();
    const server = await createRouteServer(createSecureSessionRoutes({ service }));
    const canary = "PLAINTEXT-OR-PROVIDER-CANARY";

    const unsafe = await postJson(
      `${server.baseUrl}/api/secure-sessions/manager-1/access-requests/request-1/fulfill`,
      {
        baseRevision: 6,
        displayAlias: "PASSWORD",
        material: canary,
        leaseKind: "one_use",
        exposures: [{ deliveryKind: "stdin" }],
        retention: "session",
      },
    );
    const unsafeStop = await postJson(
      `${server.baseUrl}/api/secure-sessions/manager-1/stop`,
      { baseRevision: 6, stopProcesses: false },
    );

    vi.mocked(service.grantSecureSessionLease).mockRejectedValue(
      Object.assign(new Error(canary), {
        code: "secure_session_revision_conflict",
      }),
    );
    const stale = await postJson(
      `${server.baseUrl}/api/secure-sessions/manager-1/leases`,
      {
        baseRevision: 1,
        secretId: "secret-1",
        exposures: [{ deliveryKind: "stdin" }],
        leaseKind: "task",
      },
    );

    expect(unsafe.status).toBe(400);
    expect(unsafeStop.status).toBe(400);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      code: "SECURE_STALE_REVISION",
      error: "SECURE_STALE_REVISION",
    });
    expect(await unsafe.text()).not.toContain(canary);
    expect(stale.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects invalid saved and session fulfillment policy before the service", async () => {
    const service = fakeService();
    const server = await createRouteServer(createSecureSessionRoutes({ service }));
    const encryptedMaterial = Buffer.from("ciphertext-material").toString("base64");
    const endpoint =
      `${server.baseUrl}/api/secure-sessions/manager-1/access-requests/request-1/fulfill`;
    const common = {
      baseRevision: 6,
      displayAlias: "PASSWORD",
      encryptedMaterial,
      leaseKind: "task",
      exposures: [{ deliveryKind: "stdin" }],
    };

    for (const invalid of [
      { ...common, retention: "saved" },
      {
        ...common,
        retention: "session",
        scope: { kind: "instance" },
      },
      {
        ...common,
        retention: "session",
        makeProjectDefault: true,
      },
      {
        ...common,
        retention: "saved",
        scope: { kind: "profile", profileId: "profile-1" },
        makeProjectDefault: "yes",
      },
    ]) {
      const response = await postJson(endpoint, invalid);
      expect(response.status).toBe(400);
    }

    const deniedWithSelection = await postJson(
      `${server.baseUrl}/api/secure-sessions/manager-1/access-requests/request-1/resolve`,
      {
        baseRevision: 6,
        decision: "deny",
        selectedSecretId: "secret-1",
      },
    );
    expect(deniedWithSelection.status).toBe(400);
    expect(service.fulfillSecureAccessRequest).not.toHaveBeenCalled();
    expect(service.resolveSecureAccessRequest).not.toHaveBeenCalled();
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
