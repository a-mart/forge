import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChatArtifactRoutes } from "../chat-artifact-routes.js";
import { getSessionFilePath } from "../../../../swarm/storage/data-paths.js";
import { CONVERSATION_ENTRY_TYPE } from "../../../../swarm/session/conversation-timeline.js";
import { MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES, MAX_PRESENTED_CHAT_ARTIFACT_PDF_BYTES } from "../../../../swarm/session/presented-chat-artifact.js";
import { MAX_READ_FILE_CONTENT_BYTES } from "../../../ws-file-access.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("chat artifact HTTP route", () => {
  it("reads presented files outside the workspace and returns no-store typed denials", async () => {
    const tempRoot = process.platform === "darwin" ? `/private${tmpdir()}` : tmpdir(); const root = await mkdtemp(join(tempRoot, "artifact-route-")); cleanup.push(root);
    const dataDir = join(root, "data"); const profileId = "profile"; const agentId = "manager"; const sessionFile = getSessionFilePath(dataDir, profileId, agentId); await mkdir(join(dataDir, "profiles", profileId, "sessions", agentId), { recursive: true });
    const image = join(root, "outside.png"); const imageBytes = Buffer.alloc(MAX_READ_FILE_CONTENT_BYTES + 1); Buffer.from([137, 80, 78, 71]).copy(imageBytes); await writeFile(image, imageBytes);
    const presentedImage = process.platform === "darwin" ? image.replace(/^\/private\/tmp\//, "/tmp/") : image;
    await writeFile(sessionFile, JSON.stringify({ type: "custom", customType: CONVERSATION_ENTRY_TYPE, id: "m", data: { type: "conversation_message", id: "m", agentId, role: "assistant", source: "speak_to_user", text: `[image](swarm-file://${presentedImage})`, timestamp: new Date().toISOString() } }) + "\n");
    const descriptor: any = { agentId, managerId: agentId, role: "manager", profileId, sessionFile, cwd: root };
    const manager: any = { getAgent: (id: string) => id === agentId ? descriptor : undefined, listProfiles: () => [{ profileId }], getConfig: () => ({ paths: { dataDir } }) };
    const routes = createChatArtifactRoutes({ swarmManager: manager, artifactSecurityPlatform: "win32" }); const server = createServer((req, res) => { const url = new URL(req.url ?? "/", "http://x"); const route = routes.find(r => r.matches(url.pathname)); if (route) void route.handle(req, res, url); else { res.statusCode = 404; res.end(); } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address() as any; const url = `http://127.0.0.1:${address.port}/api/chat-artifacts/read`;
    try {
      const ok = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "m", path: presentedImage }) });
      expect(ok.status).toBe(200); expect(ok.headers.get("cache-control")).toBe("no-store"); const payload: any = await ok.json(); expect(payload).toMatchObject({ path: presentedImage, binary: true, encoding: "base64", contentType: "image/png" }); expect(Buffer.from(payload.content, "base64")).toHaveLength(imageBytes.length);
      const ticketResponse = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "m", path: presentedImage, imageTransport: "http_ticket" }) });
      expect(ticketResponse.status).toBe(200); const ticket: any = await ticketResponse.json();
      expect(ticket).toMatchObject({ binary: true, transport: "http_ticket", totalBytes: imageBytes.length }); expect(ticket).not.toHaveProperty("content");
      expect(ticket.ticket.url).toMatch(/^\/api\/chat-artifacts\/tickets\/[A-Za-z0-9_-]+$/);
      const raw = await fetch(`http://127.0.0.1:${address.port}${ticket.ticket.url}`);
      expect(raw.status).toBe(200); expect(raw.headers.get("content-type")).toBe("image/png"); expect(raw.headers.get("cache-control")).toBe("no-store"); expect(Buffer.from(await raw.arrayBuffer())).toEqual(imageBytes);
      const reused = await fetch(`http://127.0.0.1:${address.port}${ticket.ticket.url}`); expect(reused.status).toBe(404); expect(await reused.json()).toMatchObject({ code: "ticket_not_found" });
      const injectedContext = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "m", path: presentedImage, worktreeId: "caller-selected", sourceOwnerAgentId: "other" }) });
      expect(injectedContext.status).toBe(400); expect(await injectedContext.json()).toMatchObject({ code: "invalid_request" });
      await writeFile(image, Buffer.alloc(MAX_PRESENTED_CHAT_ARTIFACT_IMAGE_BYTES + 1));
      const oversized = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "m", path: presentedImage }) });
      expect(oversized.status).toBe(413); expect(await oversized.json()).toMatchObject({ code: "file_too_large" });
      const denied = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "m", path: `${presentedImage}x` }) });
      expect(denied.status).toBe(403); expect(denied.headers.get("cache-control")).toBe("no-store"); expect(await denied.json()).toMatchObject({ code: "path_not_presented" });
      const outsideRoot = await mkdtemp(join(tempRoot, "artifact-route-outside-")); cleanup.push(outsideRoot); const outside = join(outsideRoot, "outside.txt"); await writeFile(outside, "outside");
      await writeFile(sessionFile, JSON.stringify({ type: "custom", customType: CONVERSATION_ENTRY_TYPE, id: "outside", data: { type: "conversation_message", id: "outside", agentId, role: "assistant", source: "speak_to_user", text: `[outside](swarm-file://${outside})`, timestamp: new Date().toISOString() } }) + "\n");
      const outsideRead = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "outside", path: outside }) });
      expect(outsideRead.status).toBe(200); expect(await outsideRead.json()).toMatchObject({ path: outside, content: "outside" });
      expect((await fetch(url, { method: "GET" })).status).toBe(405);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 15_000);

  it("issues a one-use PDF ticket and returns application/pdf bytes on redeem", async () => {
    const tempRoot = process.platform === "darwin" ? `/private${tmpdir()}` : tmpdir(); const root = await mkdtemp(join(tempRoot, "artifact-pdf-route-")); cleanup.push(root);
    const dataDir = join(root, "data"); const profileId = "profile"; const agentId = "manager"; const sessionFile = getSessionFilePath(dataDir, profileId, agentId); await mkdir(join(dataDir, "profiles", profileId, "sessions", agentId), { recursive: true });
    const pdf = join(root, "outside.pdf"); const pdfBytes = Buffer.from("%PDF-1.4\nspec\n%%EOF\n"); await writeFile(pdf, pdfBytes);
    const presentedPdf = process.platform === "darwin" ? pdf.replace(/^\/private\/tmp\//, "/tmp/") : pdf;
    await writeFile(sessionFile, JSON.stringify({ type: "custom", customType: CONVERSATION_ENTRY_TYPE, id: "pdf", data: { type: "conversation_message", id: "pdf", agentId, role: "assistant", source: "speak_to_user", text: `[pdf](swarm-file://${presentedPdf})`, timestamp: new Date().toISOString() } }) + "\n");
    const descriptor: any = { agentId, managerId: agentId, role: "manager", profileId, sessionFile, cwd: root };
    const manager: any = { getAgent: (id: string) => id === agentId ? descriptor : undefined, listProfiles: () => [{ profileId }], getConfig: () => ({ paths: { dataDir } }) };
    const routes = createChatArtifactRoutes({ swarmManager: manager, artifactSecurityPlatform: "win32" }); const server = createServer((req, res) => { const url = new URL(req.url ?? "/", "http://x"); const route = routes.find(r => r.matches(url.pathname)); if (route) void route.handle(req, res, url); else { res.statusCode = 404; res.end(); } });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address() as any; const url = `http://127.0.0.1:${address.port}/api/chat-artifacts/read`;
    try {
      const ticketResponse = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "pdf", path: presentedPdf, imageTransport: "http_ticket" }) });
      expect(ticketResponse.status).toBe(200); const ticket: any = await ticketResponse.json();
      expect(ticket).toMatchObject({ binary: true, transport: "http_ticket", contentType: "application/pdf", totalBytes: pdfBytes.length }); expect(ticket).not.toHaveProperty("content");
      const raw = await fetch(`http://127.0.0.1:${address.port}${ticket.ticket.url}`);
      expect(raw.status).toBe(200); expect(raw.headers.get("content-type")).toBe("application/pdf"); expect(Buffer.from(await raw.arrayBuffer())).toEqual(pdfBytes);
      const reused = await fetch(`http://127.0.0.1:${address.port}${ticket.ticket.url}`); expect(reused.status).toBe(404);
      await writeFile(pdf, Buffer.alloc(MAX_PRESENTED_CHAT_ARTIFACT_PDF_BYTES + 1, 0x25));
      const oversized = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcriptAgentId: agentId, messageId: "pdf", path: presentedPdf, imageTransport: "http_ticket" }) });
      expect(oversized.status).toBe(413); expect(await oversized.json()).toMatchObject({ code: "file_too_large" });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 15_000);
});
