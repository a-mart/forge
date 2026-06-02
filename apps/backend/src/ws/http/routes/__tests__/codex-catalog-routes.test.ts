import { describe, expect, it, vi } from "vitest";
import { createCodexCatalogRoutes } from "../codex-catalog-routes.js";
import type { SwarmManager } from "../../../../swarm/swarm-manager.js";

describe("codex-catalog-routes", () => {
  it("serves catalog snapshots via browseCodexMcpCatalog", async () => {
    const browseCodexMcpCatalog = vi.fn(async () => ({
      apps: [{ id: "fireflies", name: "Fireflies" }],
      tools: [
        {
          selector: "fireflies/list_recent",
          serverName: "fireflies",
          toolName: "list_recent",
        },
      ],
      fetchedAt: "2026-01-01T00:00:00.000Z",
    }));

    const routes = createCodexCatalogRoutes({
      swarmManager: { browseCodexMcpCatalog } as unknown as SwarmManager,
    });
    const route = routes[0];
    expect(route).toBeTruthy();

    const responseChunks: Buffer[] = [];
    const response = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn((chunk?: string) => {
        if (chunk) {
          responseChunks.push(Buffer.from(chunk));
        }
      }),
    };

    const request = { method: "GET", headers: {} } as import("node:http").IncomingMessage;
    await route.handle(
      request,
      response as unknown as import("node:http").ServerResponse,
      new URL("http://127.0.0.1/api/codex-app-server/catalog?managerAgentId=manager-1"),
    );

    expect(browseCodexMcpCatalog).toHaveBeenCalledWith("manager-1");
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(Buffer.concat(responseChunks).toString("utf8"));
    expect(body.tools[0]?.selector).toBe("fireflies/list_recent");
  });
});
