import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WsApiProxy } from "../ws/ws-api-proxy.js";
import { getSessionFilePath } from "../swarm/storage/data-paths.js";
import { CONVERSATION_ENTRY_TYPE } from "../swarm/session/conversation-timeline.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("WS chat artifact API proxy", () => {
  it("binds transcript ownership to the subscription and rejects extra ownership fields", async () => {
    const tempRoot = process.platform === "darwin" ? `/private${tmpdir()}` : tmpdir(); const dataDir = await mkdtemp(join(tempRoot, "artifact-ws-")); roots.push(dataDir);
    const profileId = "profile"; const agentId = "manager"; const sessionFile = getSessionFilePath(dataDir, profileId, agentId); await mkdir(join(dataDir, "profiles", profileId, "sessions", agentId), { recursive: true }); const file = join(dataDir, "outside.txt"); await writeFile(file, "ok");
    await writeFile(sessionFile, JSON.stringify({ type: "custom", customType: CONVERSATION_ENTRY_TYPE, id: "m", data: { type: "conversation_message", id: "m", agentId, role: "assistant", source: "speak_to_user", text: `[x](swarm-file://${file})`, timestamp: new Date().toISOString() } }) + "\n");
    const descriptor: any = { agentId, managerId: agentId, role: "manager", profileId, sessionFile };
    const swarmManager: any = { getAgent: (id: string) => id === agentId ? descriptor : undefined, listProfiles: () => [{ profileId }], getConfig: () => ({ paths: { dataDir } }) };
    const proxy = new WsApiProxy({ swarmManager, mobilePushService: {}, feedbackService: {}, terminalService: null, unreadTracker: null } as any);
    const response = await proxy.routeApiProxyCommand({ type: "api_proxy", requestId: "r", method: "POST", path: "/api/chat-artifacts/read", body: JSON.stringify({ messageId: "m", path: file }) } as any, agentId);
    expect(response.status).toBe(200); expect(JSON.parse(response.body)).toMatchObject({ content: "ok" });
    const injected = await proxy.routeApiProxyCommand({ type: "api_proxy", requestId: "r2", method: "POST", path: "/api/chat-artifacts/read", body: JSON.stringify({ messageId: "m", path: file, transcriptAgentId: "other" }) } as any, agentId);
    expect(injected.status).toBe(400); expect(JSON.parse(injected.body)).toMatchObject({ code: "invalid_request" });
    const method = await proxy.routeApiProxyCommand({ type: "api_proxy", requestId: "r3", method: "GET", path: "/api/chat-artifacts/read", body: undefined } as any, agentId);
    expect(method.status).toBe(405);
    const mismatch = await proxy.routeApiProxyCommand({ type: "api_proxy", requestId: "r4", method: "POST", path: "/api/chat-artifacts/read", body: JSON.stringify({ messageId: "m", path: `${file}x` }) } as any, agentId);
    expect(mismatch.status).toBe(403); expect(JSON.parse(mismatch.body)).toMatchObject({ code: "path_not_presented" });
  });
});
