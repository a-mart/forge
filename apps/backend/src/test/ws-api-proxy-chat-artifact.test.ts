import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { apiProxyResponseEventByteLength, WsApiProxy } from "../ws/ws-api-proxy.js";
import { MAX_WS_EVENT_BYTES, sendWsEvent } from "../ws/ws-send.js";
import { MAX_API_PROXY_REQUEST_ID_LENGTH } from "../ws/commands/parse-utility-command.js";
import { getSessionFilePath } from "../swarm/storage/data-paths.js";
import { CONVERSATION_ENTRY_TYPE } from "../swarm/session/conversation-timeline.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function createSendableSocket() {
  const send = vi.fn((_data: string, callback?: (error?: Error) => void) => callback?.());
  return {
    socket: {
      _socket: { write: () => true },
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send,
    } as unknown as WebSocket,
    send,
  };
}

describe("WS chat artifact API proxy", () => {
  it("binds transcript ownership to the subscription and rejects extra ownership fields", async () => {
    const tempRoot = process.platform === "darwin" ? `/private${tmpdir()}` : tmpdir(); const dataDir = await mkdtemp(join(tempRoot, "artifact-ws-")); roots.push(dataDir);
    const profileId = "profile"; const agentId = "manager"; const sessionFile = getSessionFilePath(dataDir, profileId, agentId); await mkdir(join(dataDir, "profiles", profileId, "sessions", agentId), { recursive: true });
    const outsideRoot = await mkdtemp(join(tempRoot, "artifact-ws-outside-")); roots.push(outsideRoot); const file = join(outsideRoot, "outside.txt"); await writeFile(file, "ok");
    await writeFile(sessionFile, JSON.stringify({ type: "custom", customType: CONVERSATION_ENTRY_TYPE, id: "m", data: { type: "conversation_message", id: "m", agentId, role: "assistant", source: "speak_to_user", text: `[x](swarm-file://${file})`, timestamp: new Date().toISOString() } }) + "\n");
    const descriptor: any = { agentId, managerId: agentId, role: "manager", profileId, sessionFile, cwd: dataDir };
    const swarmManager: any = { getAgent: (id: string) => id === agentId ? descriptor : undefined, listProfiles: () => [{ profileId }], getConfig: () => ({ paths: { dataDir } }) };
    const proxy = new WsApiProxy({ swarmManager, mobilePushService: {}, feedbackService: {}, terminalService: null, unreadTracker: null } as any);
    const response = await proxy.routeApiProxyCommand({ type: "api_proxy", requestId: "r", method: "POST", path: "/api/chat-artifacts/read", body: JSON.stringify({ messageId: "m", path: file }) } as any, agentId);
    expect(response.status).toBe(200); expect(JSON.parse(response.body)).toMatchObject({ path: file, content: "ok" });
    for (const extra of [{ transcriptAgentId: "other" }, { worktreeId: "caller-selected" }, { sourceOwnerAgentId: "other" }]) {
      const injected = await proxy.routeApiProxyCommand({ type: "api_proxy", requestId: "r2", method: "POST", path: "/api/chat-artifacts/read", body: JSON.stringify({ messageId: "m", path: file, ...extra }) } as any, agentId);
      expect(injected.status).toBe(400); expect(JSON.parse(injected.body)).toMatchObject({ code: "invalid_request" });
    }
    const method = await proxy.routeApiProxyCommand({ type: "api_proxy", requestId: "r3", method: "GET", path: "/api/chat-artifacts/read", body: undefined } as any, agentId);
    expect(method.status).toBe(405);
    const mismatch = await proxy.routeApiProxyCommand({ type: "api_proxy", requestId: "r4", method: "POST", path: "/api/chat-artifacts/read", body: JSON.stringify({ messageId: "m", path: `${file}x` }) } as any, agentId);
    expect(mismatch.status).toBe(403); expect(JSON.parse(mismatch.body)).toMatchObject({ code: "path_not_presented" });
  });

  it("checks the exact serialized event and returns a sendable 413 for transport overflow", async () => {
    const tempRoot = process.platform === "darwin" ? `/private${tmpdir()}` : tmpdir(); const dataDir = await mkdtemp(join(tempRoot, "artifact-ws-boundary-")); roots.push(dataDir);
    const profileId = "profile"; const agentId = "manager"; const sessionFile = getSessionFilePath(dataDir, profileId, agentId); await mkdir(join(dataDir, "profiles", profileId, "sessions", agentId), { recursive: true });
    const image = join(dataDir, "near-limit.png"); const escapableText = join(dataDir, "escapable.txt"); const boundedText = join(dataDir, "bounded.txt");
    await writeFile(image, Buffer.alloc(760 * 1024, 0x89));
    await writeFile(escapableText, `"\\`.repeat(160_000));
    await writeFile(boundedText, Buffer.alloc(5 * 1024 * 1024, 0x61));
    await writeFile(sessionFile, JSON.stringify({ type: "custom", customType: CONVERSATION_ENTRY_TYPE, id: "m", data: { type: "conversation_message", id: "m", agentId, role: "assistant", source: "speak_to_user", text: `[image](swarm-file://${image}) [text](swarm-file://${escapableText}) [bounded](swarm-file://${boundedText})`, timestamp: new Date().toISOString() } }) + "\n");
    const descriptor: any = { agentId, managerId: agentId, role: "manager", profileId, sessionFile, cwd: dataDir };
    const swarmManager: any = { getAgent: (id: string) => id === agentId ? descriptor : undefined, listProfiles: () => [{ profileId }], getConfig: () => ({ paths: { dataDir } }) };
    const proxy = new WsApiProxy({ swarmManager, mobilePushService: {}, feedbackService: {}, terminalService: null, unreadTracker: null } as any);
    const requestId = "r".repeat(MAX_API_PROXY_REQUEST_ID_LENGTH);

    const nearLimitImage = await proxy.routeApiProxyCommand({ type: "api_proxy", requestId, method: "POST", path: "/api/chat-artifacts/read", body: JSON.stringify({ messageId: "m", path: image }) } as any, agentId);
    expect(nearLimitImage.status).toBe(200);
    expect(apiProxyResponseEventByteLength(nearLimitImage)).toBeGreaterThan(MAX_WS_EVENT_BYTES * 0.95);
    expect(apiProxyResponseEventByteLength(nearLimitImage)).toBeLessThanOrEqual(MAX_WS_EVENT_BYTES);
    expect(JSON.parse(nearLimitImage.body)).toMatchObject({ binary: true, encoding: "base64", contentType: "image/png" });

    const escapableOverflow = await proxy.routeApiProxyCommand({ type: "api_proxy", requestId, method: "POST", path: "/api/chat-artifacts/read", body: JSON.stringify({ messageId: "m", path: escapableText }) } as any, agentId);
    expect(escapableOverflow.status).toBe(413);
    expect(JSON.parse(escapableOverflow.body)).toEqual({ error: "artifact_response_too_large", code: "artifact_response_too_large" });
    expect(apiProxyResponseEventByteLength(escapableOverflow)).toBeLessThanOrEqual(MAX_WS_EVENT_BYTES);

    const bounded = await proxy.routeApiProxyCommand({ type: "api_proxy", requestId, method: "POST", path: "/api/chat-artifacts/read", body: JSON.stringify({ messageId: "m", path: boundedText, previewBytes: 512 * 1024 }) } as any, agentId);
    expect(bounded.status).toBe(200);
    expect(apiProxyResponseEventByteLength(bounded)).toBeLessThanOrEqual(MAX_WS_EVENT_BYTES);
    expect(JSON.parse(bounded.body)).toMatchObject({ truncated: true, totalBytes: 5 * 1024 * 1024 });

    await writeFile(image, Buffer.alloc(800 * 1024, 0x89));
    const imageOverflow = await proxy.routeApiProxyCommand({ type: "api_proxy", requestId, method: "POST", path: "/api/chat-artifacts/read", body: JSON.stringify({ messageId: "m", path: image }) } as any, agentId);
    expect(imageOverflow.status).toBe(413);
    expect(JSON.parse(imageOverflow.body)).toEqual({ error: "artifact_response_too_large", code: "artifact_response_too_large" });
    expect(apiProxyResponseEventByteLength(imageOverflow)).toBeLessThanOrEqual(MAX_WS_EVENT_BYTES);

    await writeFile(image, Buffer.alloc(4 * 1024 * 1024, 0x89));
    const imageTicket = await proxy.routeApiProxyCommand({ type: "api_proxy", requestId, method: "POST", path: "/api/chat-artifacts/read", body: JSON.stringify({ messageId: "m", path: image, imageTransport: "http_ticket" }) } as any, agentId);
    expect(imageTicket.status).toBe(200);
    expect(apiProxyResponseEventByteLength(imageTicket)).toBeLessThanOrEqual(MAX_WS_EVENT_BYTES);
    expect(JSON.parse(imageTicket.body)).toMatchObject({ transport: "http_ticket", totalBytes: 4 * 1024 * 1024 });
    expect(JSON.parse(imageTicket.body)).not.toHaveProperty("content");

    const fake = createSendableSocket();
    expect(sendWsEvent({ socket: fake.socket, event: imageOverflow, onDropSocket: vi.fn() })).not.toBeNull();
    expect(fake.send).toHaveBeenCalledTimes(1);
  });
});
