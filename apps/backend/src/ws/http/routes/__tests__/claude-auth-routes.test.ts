import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createClaudeAuthRoutes } from "../claude-auth-routes.js";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closes.splice(0).map(close => close())); });
async function fixture() {
  const state = { connected: false, mode: "subscription" as const, phase: "waiting" as const, flowId: "fixture" };
  const service = { status: vi.fn(async () => state), start: vi.fn(async () => state), cancel: vi.fn(async () => {}), submitCode: vi.fn() };
  const [route] = createClaudeAuthRoutes(service);
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (!route!.matches(url.pathname)) { response.writeHead(404).end(); return; }
    void route!.handle(request, response, url);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  closes.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address() as { port: number };
  return { service, url: `http://127.0.0.1:${address.port}/api/settings/claude-native` };
}

it("serves transient status and forwards codes only to the private login owner", async () => {
  const { service, url } = await fixture();
  const response = await fetch(url);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).connected).toBe(false);
  await fetch(url, { method: "POST", body: JSON.stringify({ action: "start" }) });
  expect(service.start).toHaveBeenCalledOnce();
  const code = await fetch(url, { method: "POST", body: JSON.stringify({ action: "code", flowId: "fixture", code: "PRIVATE#CODE" }) });
  expect(service.submitCode).toHaveBeenCalledWith("fixture", "PRIVATE#CODE");
  expect(await code.text()).not.toContain("PRIVATE");
  await fetch(url, { method: "DELETE", body: JSON.stringify({ flowId: "fixture" }) });
  expect(service.cancel).toHaveBeenCalledWith("fixture");
});

it("rejects malformed requests without reflecting authorization input", async () => {
  const { service, url } = await fixture();
  for (const body of ["null", "[]", "{PRIVATE_CODE", '{"action":"code","code":"PRIVATE"}', '{"action":"other"}']) {
    const response = await fetch(url, { method: "POST", body });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("PRIVATE");
  }
  expect((await fetch(url, { method: "PUT" })).status).toBe(405);
  expect(service.submitCode).not.toHaveBeenCalled();
});
