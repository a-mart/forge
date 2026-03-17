import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDescriptor } from "@forge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { SwarmManager } from "../swarm-manager.js";
import { createFeedbackRoutes } from "../../ws/routes/feedback-routes.js";

interface TestServer {
  readonly baseUrl: string;
  readonly dataDir: string;
  readonly close: () => Promise<void>;
}

const activeServers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
});

describe("feedback-routes", () => {
  it("returns POST responses in the feedback envelope", async () => {
    const server = await createFeedbackTestServer([createManagerSession("alpha", "alpha--s1")]);

    const response = await fetch(`${server.baseUrl}/api/v1/profiles/alpha/sessions/alpha--s1/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "message",
        targetId: "msg-1",
        value: "up",
        reasonCodes: ["accuracy"],
        comment: "Great answer",
        channel: "web"
      })
    });

    expect(response.status).toBe(201);
    const payload = (await response.json()) as { feedback?: Record<string, unknown>; id?: string };

    expect(payload.id).toBeUndefined();
    expect(payload.feedback).toBeDefined();
    expect(payload.feedback?.profileId).toBe("alpha");
    expect(payload.feedback?.sessionId).toBe("alpha--s1");
    expect(payload.feedback?.targetId).toBe("msg-1");
    expect(payload.feedback?.value).toBe("up");
    expect(typeof payload.feedback?.id).toBe("string");
    expect(typeof payload.feedback?.createdAt).toBe("string");
  });

  it("returns GET state responses in the states envelope and omits target after clear", async () => {
    const server = await createFeedbackTestServer([createManagerSession("alpha", "alpha--s1")]);

    const submit = async (value: "up" | "down" | "clear") => {
      const response = await fetch(`${server.baseUrl}/api/v1/profiles/alpha/sessions/alpha--s1/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "message",
          targetId: "msg-1",
          value,
          reasonCodes: [],
          comment: "",
          channel: "web"
        })
      });

      expect(response.status).toBe(201);
    };

    await submit("up");
    await submit("clear");

    const response = await fetch(`${server.baseUrl}/api/v1/profiles/alpha/sessions/alpha--s1/feedback/state`);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      states?: Array<{ targetId: string; scope: string; value: "up" | "down" | null }>;
      feedback?: unknown;
    };

    expect(payload.feedback).toBeUndefined();
    expect(payload.states).toEqual([]);
  });

  it("returns 400 for invalid bodies (missing fields, bad enums, and oversized comments)", async () => {
    const server = await createFeedbackTestServer([createManagerSession("alpha", "alpha--s1")]);

    const baseUrl = `${server.baseUrl}/api/v1/profiles/alpha/sessions/alpha--s1/feedback`;

    const missingRequiredResponse = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(missingRequiredResponse.status).toBe(400);

    const invalidEnumResponse = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "message",
        targetId: "msg-1",
        value: "sideways",
        reasonCodes: [],
        comment: "",
        channel: "web"
      })
    });
    expect(invalidEnumResponse.status).toBe(400);

    const commentTooLongResponse = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "message",
        targetId: "msg-1",
        value: "down",
        reasonCodes: ["poor_outcome"],
        comment: "x".repeat(2001),
        channel: "web"
      })
    });
    expect(commentTooLongResponse.status).toBe(400);

    const errorPayload = (await commentTooLongResponse.json()) as { error?: string };
    expect(errorPayload.error).toContain("comment must not exceed 2000 characters");
  });

  it("returns 400 for invalid clearKind values", async () => {
    const server = await createFeedbackTestServer([createManagerSession("alpha", "alpha--s1")]);

    const response = await fetch(`${server.baseUrl}/api/v1/profiles/alpha/sessions/alpha--s1/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "message",
        targetId: "msg-1",
        value: "clear",
        reasonCodes: [],
        comment: "",
        channel: "web",
        clearKind: "banana"
      })
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toContain("clearKind must be one of: vote, comment.");
  });

  it("returns 400 for empty comments", async () => {
    const server = await createFeedbackTestServer([createManagerSession("alpha", "alpha--s1")]);

    const response = await fetch(`${server.baseUrl}/api/v1/profiles/alpha/sessions/alpha--s1/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "message",
        targetId: "msg-1",
        value: "comment",
        reasonCodes: [],
        comment: " \t\n",
        channel: "web"
      })
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toContain("comment must be a non-empty string.");
  });

  it("returns 404 for non-existent sessions", async () => {
    const server = await createFeedbackTestServer([createManagerSession("alpha", "alpha--s1")]);

    const response = await fetch(`${server.baseUrl}/api/v1/profiles/alpha/sessions/alpha--s999/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "message",
        targetId: "msg-1",
        value: "up",
        reasonCodes: [],
        comment: "",
        channel: "web"
      })
    });

    expect(response.status).toBe(404);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toContain("Unknown session");
  });

  it("returns 400 for invalid cross-session profileId query segments", async () => {
    const server = await createFeedbackTestServer([createManagerSession("alpha", "alpha--s1")]);

    const response = await fetch(`${server.baseUrl}/api/v1/feedback?profileId=../alpha`);
    expect(response.status).toBe(400);

    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toContain("Invalid path segment");
  });
});

async function createFeedbackTestServer(descriptors: AgentDescriptor[]): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), "feedback-routes-"));
  const dataDir = join(root, "data");
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.agentId, descriptor]));

  const swarmManager = {
    getConfig: () => ({ paths: { dataDir } }),
    getAgent: (agentId: string) => descriptorById.get(agentId)
  } as unknown as SwarmManager;

  const routes = createFeedbackRoutes({ swarmManager });

  const server = createServer((request, response) => {
    void handleRouteRequest(routes, request, response);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine test server address.");
  }

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });

      await rm(root, { recursive: true, force: true });
    }
  };

  activeServers.push(testServer);
  return testServer;
}

async function handleRouteRequest(
  routes: ReturnType<typeof createFeedbackRoutes>,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const route = routes.find((entry) => entry.matches(requestUrl.pathname));

  if (!route) {
    response.statusCode = 404;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: "Not Found" }));
    return;
  }

  try {
    await route.handle(request, response, requestUrl);
  } catch (error) {
    response.statusCode = 500;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unexpected route error." })
    );
  }
}

function createManagerSession(profileId: string, sessionId: string): AgentDescriptor {
  const timestamp = new Date().toISOString();

  return {
    agentId: sessionId,
    managerId: sessionId,
    displayName: sessionId,
    role: "manager",
    status: "idle",
    createdAt: timestamp,
    updatedAt: timestamp,
    cwd: "/tmp",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "medium"
    },
    sessionFile: `/tmp/${sessionId}.jsonl`,
    profileId,
    sessionLabel: "Session 1"
  };
}
