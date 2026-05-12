import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createTempConfig } from "../../../../test-support/index.js";
import { CliAccessService } from "../../../../swarm/cli-access-service.js";
import { sendJson } from "../../../http-utils.js";
import { createCliAccessSettingsRoutes } from "../cli-access-settings-routes.js";

interface TestServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

/* ------------------------------------------------------------------ */
/*  Core key management                                                */
/* ------------------------------------------------------------------ */

describe("CLI access settings routes", () => {
  it("returns empty list when no keys exist", async () => {
    const { server } = await setup();
    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ keys: [] });
  });

  it("generates a key and returns plaintext once", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My key" }),
    });
    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.key).toMatchObject({ name: "My key" });
    expect(json.plaintextKey).toBeTruthy();
    expect(json.plaintextKey).toMatch(/^forge_cli_/);

    // List should now show one active key without plaintext
    const list = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`);
    const listJson = await list.json();
    expect(listJson.keys).toHaveLength(1);
    expect(listJson.keys[0].name).toBe("My key");
    expect(listJson.keys[0]).not.toHaveProperty("plaintextKey");
  });

  it("generates a key without a name", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.key.name).toBeUndefined();
    expect(json.plaintextKey).toBeTruthy();
  });

  it("revokes a key", async () => {
    const { server } = await setup();

    const gen = await (await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Revoke me" }),
    })).json();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys/${gen.key.id}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.key.revokedAt).toBeTruthy();

    // List should show the revoked key
    const list = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`);
    const listJson = await list.json();
    expect(listJson.keys).toHaveLength(1);
    expect(listJson.keys[0].revokedAt).toBeTruthy();
  });

  it("returns 404 when revoking a non-existent key", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys/nonexistent`, {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
  });

  it("rotates a key — revokes old, creates new", async () => {
    const { server } = await setup();

    const gen = await (await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Rotate me" }),
    })).json();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys/${gen.key.id}/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.key.id).not.toBe(gen.key.id);
    expect(json.key.name).toBe("Rotate me");
    expect(json.plaintextKey).toBeTruthy();
    expect(json.plaintextKey).not.toBe(gen.plaintextKey);

    // Old key should be revoked, new key active
    const list = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`);
    const listJson = await list.json();
    expect(listJson.keys).toHaveLength(2);
    const active = listJson.keys.filter((k: { revokedAt?: string }) => !k.revokedAt);
    const revoked = listJson.keys.filter((k: { revokedAt?: string }) => k.revokedAt);
    expect(active).toHaveLength(1);
    expect(revoked).toHaveLength(1);
    expect(active[0].id).toBe(json.key.id);
    expect(revoked[0].id).toBe(gen.key.id);
  });

  it("returns 404 when rotating a non-existent key", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys/nonexistent/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(404);
  });

  it("returns 405 for unsupported methods", async () => {
    const { server } = await setup();

    const putResponse = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "PUT",
    });
    expect(putResponse.status).toBe(405);
  });

  it("handles CORS OPTIONS preflight from same origin", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "OPTIONS",
      headers: { Origin: server.baseUrl },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(server.baseUrl);
  });

  it("handles CORS OPTIONS preflight with no Origin header", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "OPTIONS",
    });
    expect(response.status).toBe(204);
    // No CORS headers set when no Origin header present
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns no routes for collaboration runtime", () => {
    const routes = createCliAccessSettingsRoutes({
      cliAccessService: {} as CliAccessService,
      runtimeTarget: "collaboration-server",
    });
    expect(routes).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  Cross-origin rejection (security)                                  */
/* ------------------------------------------------------------------ */

describe("CLI access settings routes — cross-origin protection", () => {
  // -- Hostile origin rejection --

  it("rejects POST with hostile cross-origin header", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example.com",
      },
      body: JSON.stringify({ name: "Stolen key" }),
    });
    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json.error.code).toBe("forbidden_origin");
    // Ensure no CORS header that would allow the hostile origin to read the response
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects DELETE with hostile cross-origin header", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys/some-id`, {
      method: "DELETE",
      headers: { Origin: "https://evil.example.com" },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "forbidden_origin" } });
  });

  it("rejects OPTIONS preflight with hostile cross-origin header", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "OPTIONS",
      headers: { Origin: "https://attacker.example.com" },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects POST rotate with hostile cross-origin header", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys/some-id/rotate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example.com",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });

  it("rejects GET list with hostile cross-origin header", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "GET",
      headers: { Origin: "https://evil.example.com" },
    });
    expect(response.status).toBe(403);
  });

  it("rejects Origin that matches hostname but not port", async () => {
    const { server } = await setup();

    // Same host, different port — cross-origin
    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "GET",
      headers: { Origin: "http://127.0.0.1:9999" },
    });
    expect(response.status).toBe(403);
  });

  // -- Same-origin acceptance --

  it("allows same-origin GET from the actual server origin", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "GET",
      headers: { Origin: server.baseUrl },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(server.baseUrl);
  });

  it("allows same-origin POST from the actual server origin", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: server.baseUrl,
      },
      body: "{}",
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe(server.baseUrl);
  });

  it("allows requests with no Origin header (non-browser callers)", async () => {
    const { server } = await setup();

    // No Origin header — same-origin browser or curl/CLI callers
    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(201);
  });

  // -- Non-loopback same-origin (LAN / Tailscale / custom hostname) --

  it("allows same-origin from LAN IP when Host header matches", async () => {
    const { server } = await setup();

    // Use raw http.request so we can set a custom Host header that differs
    // from the actual TCP destination — simulates a LAN browser session
    // where the user accesses Forge at http://192.168.1.100:<port>.
    const port = new URL(server.baseUrl).port;
    const lanOrigin = `http://192.168.1.100:${port}`;
    const result = await rawHttpRequest({
      url: `${server.baseUrl}/api/settings/cli-access/keys`,
      method: "GET",
      headers: {
        Host: `192.168.1.100:${port}`,
        Origin: lanOrigin,
      },
    });
    expect(result.status).toBe(200);
    expect(result.headers["access-control-allow-origin"]).toBe(lanOrigin);
  });

  it("allows same-origin from Tailscale hostname when Host header matches", async () => {
    const { server } = await setup();

    const port = new URL(server.baseUrl).port;
    const tailscaleOrigin = `http://myhost.tail12345.ts.net:${port}`;
    const result = await rawHttpRequest({
      url: `${server.baseUrl}/api/settings/cli-access/keys`,
      method: "POST",
      headers: {
        Host: `myhost.tail12345.ts.net:${port}`,
        "Content-Type": "application/json",
        Origin: tailscaleOrigin,
      },
      body: "{}",
    });
    expect(result.status).toBe(201);
    expect(result.headers["access-control-allow-origin"]).toBe(tailscaleOrigin);
  });

  it("rejects mismatched Origin against LAN Host header", async () => {
    const { server } = await setup();

    const port = new URL(server.baseUrl).port;
    const result = await rawHttpRequest({
      url: `${server.baseUrl}/api/settings/cli-access/keys`,
      method: "POST",
      headers: {
        Host: `192.168.1.100:${port}`,
        "Content-Type": "application/json",
        Origin: "https://evil.example.com",
      },
      body: "{}",
    });
    expect(result.status).toBe(403);
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  TLS terminator / reverse proxy (X-Forwarded-Proto / Forwarded)     */
/* ------------------------------------------------------------------ */

describe("CLI access settings routes — HTTPS behind proxy", () => {
  it("accepts same-origin HTTPS via X-Forwarded-Proto", async () => {
    const { server } = await setup();
    const port = new URL(server.baseUrl).port;
    const httpsOrigin = `https://forge.example.test:${port}`;

    const result = await rawHttpRequest({
      url: `${server.baseUrl}/api/settings/cli-access/keys`,
      method: "GET",
      headers: {
        Host: `forge.example.test:${port}`,
        Origin: httpsOrigin,
        "X-Forwarded-Proto": "https",
      },
    });
    expect(result.status).toBe(200);
    expect(result.headers["access-control-allow-origin"]).toBe(httpsOrigin);
  });

  it("accepts same-origin HTTPS via Forwarded: proto=https", async () => {
    const { server } = await setup();
    const port = new URL(server.baseUrl).port;
    const httpsOrigin = `https://forge.example.test:${port}`;

    const result = await rawHttpRequest({
      url: `${server.baseUrl}/api/settings/cli-access/keys`,
      method: "POST",
      headers: {
        Host: `forge.example.test:${port}`,
        Origin: httpsOrigin,
        Forwarded: `proto=https;host=forge.example.test:${port}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(result.status).toBe(201);
    expect(result.headers["access-control-allow-origin"]).toBe(httpsOrigin);
  });

  it("rejects hostile origin even when X-Forwarded-Proto is https", async () => {
    const { server } = await setup();
    const port = new URL(server.baseUrl).port;

    const result = await rawHttpRequest({
      url: `${server.baseUrl}/api/settings/cli-access/keys`,
      method: "POST",
      headers: {
        Host: `forge.example.test:${port}`,
        Origin: "https://evil.example.com",
        "X-Forwarded-Proto": "https",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(result.status).toBe(403);
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects http Origin when proxy reports https", async () => {
    const { server } = await setup();
    const port = new URL(server.baseUrl).port;

    // Origin says http but the proxy terminated TLS — scheme mismatch
    const result = await rawHttpRequest({
      url: `${server.baseUrl}/api/settings/cli-access/keys`,
      method: "GET",
      headers: {
        Host: `forge.example.test:${port}`,
        Origin: `http://forge.example.test:${port}`,
        "X-Forwarded-Proto": "https",
      },
    });
    expect(result.status).toBe(403);
  });

  it("falls back to http when no proxy header is present", async () => {
    const { server } = await setup();
    const port = new URL(server.baseUrl).port;

    // HTTPS origin without any proxy header → scheme mismatch (server is http)
    const result = await rawHttpRequest({
      url: `${server.baseUrl}/api/settings/cli-access/keys`,
      method: "GET",
      headers: {
        Host: `forge.example.test:${port}`,
        Origin: `https://forge.example.test:${port}`,
      },
    });
    expect(result.status).toBe(403);
  });

  it("handles comma-separated X-Forwarded-Proto (first value wins)", async () => {
    const { server } = await setup();
    const port = new URL(server.baseUrl).port;
    const httpsOrigin = `https://forge.example.test:${port}`;

    const result = await rawHttpRequest({
      url: `${server.baseUrl}/api/settings/cli-access/keys`,
      method: "GET",
      headers: {
        Host: `forge.example.test:${port}`,
        Origin: httpsOrigin,
        "X-Forwarded-Proto": "https, http",
      },
    });
    expect(result.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/*  Malformed percent-encoded key IDs (correctness)                    */
/* ------------------------------------------------------------------ */

describe("CLI access settings routes — malformed key IDs", () => {
  it("returns 400 for malformed percent-encoded key ID in DELETE", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys/%E0%A4%A`, {
      method: "DELETE",
    });
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.code).toBe("bad_request");
    expect(json.error.message).toMatch(/[Mm]alformed/);
  });

  it("returns 400 for malformed percent-encoded key ID in rotate POST", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys/%E0%A4%A/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error.code).toBe("bad_request");
  });

  it("returns 400 for truncated percent encoding in DELETE", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys/%C3`, {
      method: "DELETE",
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 for truncated percent encoding in rotate", async () => {
    const { server } = await setup();

    const response = await fetch(`${server.baseUrl}/api/settings/cli-access/keys/%C3/rotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/*  Setup helpers                                                      */
/* ------------------------------------------------------------------ */

async function setup(): Promise<{ service: CliAccessService; server: TestServer }> {
  const configHandle = await createTempConfig({ prefix: "cli-settings-" });
  activeServers.push({ baseUrl: "cleanup-only", close: configHandle.cleanup });

  let counter = 0;
  const service = new CliAccessService({
    dataDir: configHandle.config.paths.dataDir,
    now: () => "2026-05-11T00:00:00.000Z",
    generateId: () => {
      counter += 1;
      return `cli_key_${counter}`;
    },
    generateKeyBytes: () => Buffer.alloc(32, counter + 1),
  });

  const routes = createCliAccessSettingsRoutes({
    cliAccessService: service,
    runtimeTarget: "builder",
  });

  const httpServer = createServer((request, response) => {
    void handleRoute(routes, request, response);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve test server address");
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
  activeServers.push(testServer);
  return { service, server: testServer };
}

async function handleRoute(
  routes: ReturnType<typeof createCliAccessSettingsRoutes>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = routes.find((candidate) => candidate.matches(requestUrl.pathname));
  if (!route) {
    response.statusCode = 404;
    response.end();
    return;
  }

  try {
    await route.handle(request, response, requestUrl);
  } catch (error) {
    if (response.writableEnded || response.headersSent) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, { error: message });
  }
}

/**
 * Low-level HTTP request helper that allows overriding the Host header
 * (unlike Node's fetch/undici which always sets Host from the URL).
 * Needed for testing LAN IP / Tailscale same-origin scenarios.
 */
async function rawHttpRequest(options: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const parsed = new URL(options.url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}
